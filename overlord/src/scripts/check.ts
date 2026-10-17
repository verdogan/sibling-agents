import assert from "node:assert/strict";
import type { SpawnOptions } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assessEventSequence,
  EventRecord,
  eventRecordPath,
  readEventRecord,
} from "../campaign/event-record.js";
import { parseWorkerResult, WorkerResultError } from "../campaign/results.js";
import { bootstrapLing, type ManagedLingProcess } from "../ling/bootstrap.js";
import { LingClient, LingClientError, type LingFetch } from "../ling/client.js";
import {
  eventFingerprint,
  LingProtocolError,
  parseJsonlLog,
  parseSseEvents,
} from "../ling/events.js";
import { FleetLingClient } from "../ling/fleet.js";
import type { LingEvent, LingTask } from "../ling/types.js";
import { FleetLedger } from "../ledger.js";
import {
  applySpawnPolicy,
  DEFAULT_ALLOWED_TOOLS,
  type SpawnPolicy,
  spawnPolicyFromEnv,
} from "../policy.js";
import { fenceUntrusted } from "../untrusted.js";

let failures = 0;

async function check(label: string, run: () => void | Promise<void>): Promise<void> {
  try {
    await run();
    console.log(`PASS  ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${label} -- ${error instanceof Error ? error.message : String(error)}`);
  }
}

function task(id: string, cost?: number, totalTokens?: number): LingTask {
  return {
    id,
    status: "completed",
    prompt: "fixture",
    options: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    workspaceDir: "",
    seededFiles: [],
    ...(cost === undefined && totalTokens === undefined
      ? {}
      : {
          stats: {
            turns: 1,
            cost: cost ?? 0,
            tokens: {
              input: totalTokens ?? 1,
              output: totalTokens === undefined ? 1 : 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: totalTokens ?? 2,
            },
          },
        }),
  };
}

const policy: SpawnPolicy = {
  allowedTools: ["read", "write"],
  maxCostUsdPerTask: 2,
  maxTurnsPerTask: 10,
  maxWallClockMsPerTask: 60_000,
  maxTasksPerRun: 2,
  maxConcurrentTasks: 1,
  maxTotalCostUsd: 1,
};

await check("default policy exposes every Ling tool", () => {
  const everyTool = [
    "read",
    "write",
    "edit",
    "ls",
    "grep",
    "find",
    "bash",
    "http_request",
    "write_result",
    "record_finding",
    "verify_finding",
    "declare_intent",
    "campaign_send",
    "agent_browser",
    "browser_open",
    "browser_snapshot",
    "browser_click",
    "browser_type",
    "browser_extract",
    "browser_wait_for",
    "browser_screenshot",
    "ask_overseer",
    "tell_principal",
    "watch_next",
    "advise",
    "caution",
    "hold",
    "release",
    "report_concern",
  ];
  assert.deepEqual(DEFAULT_ALLOWED_TOOLS, everyTool);
  assert.deepEqual(spawnPolicyFromEnv({ FLEET_ALLOWED_TOOLS: "" }).allowedTools, everyTool);
  // Removed from Ling, not merely un-defaulted. A profile that still names it loses it
  // here under the default policy rather than reaching Ling's unknown-tool refusal.
  const defaults: readonly string[] = DEFAULT_ALLOWED_TOOLS;
  assert.equal(defaults.includes("browser_script"), false);
  assert.deepEqual(
    applySpawnPolicy({ tools: ["browser_open", "browser_script"] }, spawnPolicyFromEnv({}))
      .tools,
    ["browser_open"],
  );
});

await check("policy intersects requested tools", () => {
  const narrowed = applySpawnPolicy(
    {
      tools: ["read", "bash"],
      max_cost_usd: 9,
      max_turns: 20,
      max_wall_clock_ms: 120_000,
    },
    policy,
  );
  assert.equal(narrowed.tools.length, 1);
  assert.equal(narrowed.tools[0], "read");
});

await check("policy lowers budgets above its ceilings", () => {
  const narrowed = applySpawnPolicy(
    {
      tools: ["read", "bash"],
      max_cost_usd: 9,
      max_turns: 20,
      max_wall_clock_ms: 120_000,
    },
    policy,
  );
  assert.equal(narrowed.maxCostUsd, 2);
  assert.equal(narrowed.maxTurns, 10);
  assert.equal(narrowed.maxWallClockMs, 60_000);
});

await check("policy never raises a requested budget", () => {
  const alreadyLower = applySpawnPolicy({ tools: ["write"], max_cost_usd: 0.25 }, policy);
  assert.equal(alreadyLower.maxCostUsd, 0.25);
});

function populatedLedger(): FleetLedger {
  const ledger = new FleetLedger(policy);
  ledger.record(task("one", 0.4));
  ledger.record(task("two", 0.6));
  return ledger;
}

await check("ledger sums task spend", () => {
  assert(Math.abs(populatedLedger().spentUsd() - 1) < 1e-12);
});

await check("ledger remaining never goes negative", () => {
  assert.equal(populatedLedger().remainingUsd(), 0);
});

await check("ledger refuses a spawn at the spend ceiling", () => {
  assert(!populatedLedger().canSpawn(0.01));
});

await check("ledger refuses the next spawn at the token ceiling", () => {
  const ledger = new FleetLedger({
    maxTasksPerRun: 8,
    maxConcurrentTasks: 1,
    maxTotalCostUsd: 10,
    maxTotalTokens: 4,
  });
  ledger.record(task("token-task", 0, 4));
  assert.equal(ledger.spentTokens(), 4);
  assert.equal(ledger.remainingTokens(), 0);
  assert.equal(ledger.spawnBlockReason(0), "tokens");
});

await check("ledger refuses a spawn at the task ceiling", () => {
  const ledger = new FleetLedger({
    maxTasksPerRun: 1,
    maxConcurrentTasks: 1,
    maxTotalCostUsd: 10,
  });
  ledger.record(task("only"));
  assert(!ledger.canSpawn(0));
});

function busyLedger(): FleetLedger {
  const ledger = new FleetLedger({
    maxTasksPerRun: 8,
    maxConcurrentTasks: 1,
    maxTotalCostUsd: 10,
  });
  ledger.record({ ...task("busy"), status: "running" });
  return ledger;
}

await check("ledger refuses a spawn at the concurrency ceiling", () => {
  assert(!busyLedger().canSpawn(0.01));
});

await check("ledger frees a concurrency slot when a task settles", () => {
  const ledger = busyLedger();
  ledger.record({ ...task("busy"), status: "completed" });
  assert(ledger.canSpawn(0.01));
});

await check("synthetic cancellation snapshots do not erase observed cost", () => {
  const ledger = new FleetLedger({
    maxTasksPerRun: 8,
    maxConcurrentTasks: 1,
    maxTotalCostUsd: 10,
  });
  ledger.record(task("cancelled-with-cost", 0.4));
  ledger.record({ ...task("cancelled-with-cost", 0), status: "cancelled" });
  assert.equal(ledger.spentUsd(), 0.4);
});

await check("synthetic cancellation snapshots do not erase observed tokens", () => {
  const ledger = new FleetLedger({
    maxTasksPerRun: 8,
    maxConcurrentTasks: 1,
    maxTotalCostUsd: 10,
    maxTotalTokens: 10,
  });
  ledger.record(task("cancelled-with-tokens", 0, 6));
  ledger.record({ ...task("cancelled-with-tokens", 0, 0), status: "cancelled" });
  assert.equal(ledger.spentTokens(), 6);
});

async function* chunks(...values: string[]): AsyncGenerator<string> {
  for (const value of values) yield value;
}

const firstFixture =
  ": keepalive\n\n" +
  'id: 1\nevent: task_started\ndata: {"seq":1,"at":"2026-01-01T00:00:00.000Z","type":"task_started"}\n\n' +
  'id: 2\nevent: assistant_message\ndata: {"seq":2,"at":"2026-01-01T00:00:01.000Z","type":"assistant_message","data":{"text":"ok"}}\n\n';
const reconnectFixture =
  'id: 2\nevent: assistant_message\ndata: {"seq":2,"at":"2026-01-01T00:00:01.000Z","type":"assistant_message","data":{"text":"ok"}}\n\n' +
  'id: 3\nevent: task_finished\ndata: {"seq":3,"at":"2026-01-01T00:00:02.000Z","type":"task_finished"}\n\n' +
  'id: 4\nevent: after_terminal\ndata: {"seq":4,"at":"2026-01-01T00:00:03.000Z","type":"after_terminal"}\n\n';

async function parseSseFixture() {
  const seenSeqs = new Set<number>();
  const parsed = [];
  for await (const event of parseSseEvents(
    chunks(firstFixture.slice(0, 37), firstFixture.slice(37)),
    { seenSeqs },
  )) {
    parsed.push(event);
  }
  for await (const event of parseSseEvents(chunks(reconnectFixture), { seenSeqs })) {
    parsed.push(event);
  }
  return parsed;
}

await check("SSE parses framing and ignores keepalives", async () => {
  const parsed = await parseSseFixture();
  assert.equal(parsed[0]?.seq, 1);
  assert.equal(parsed[0]?.type, "task_started");
});

await check("SSE dedupes replayed sequences across reconnects", async () => {
  const parsed = await parseSseFixture();
  assert.equal(
    parsed.map((event) => event.seq).join(","),
    "1,2,3",
  );
});

await check("SSE closes on a terminal event", async () => {
  const parsed = await parseSseFixture();
  assert.equal(parsed.at(-1)?.type, "task_finished");
  assert(!parsed.some((event) => event.seq === 4));
});

function parseJsonlFixture() {
  return parseJsonlLog(
    [
      '{"at":"2026-01-01T00:00:01.000Z","type":"tool_start","data":{"tool":"write"}}',
      '{"at":"2026-01-01T00:00:02.000Z","type":"tool_end","data":{"tool":"write","error":false}}',
      '{"at":"2026-01-01T00:00:03.000Z","type":"not-json"',
    ].join("\n"),
  );
}

// The seq-less parser no longer backs history(); it is pinned while it exists.
await check("the seq-less JSONL parser accepts lines without seq", () => {
  const diskEvents = parseJsonlFixture();
  assert.equal(diskEvents.length, 2);
  assert.equal(diskEvents[0]?.type, "tool_start");
  assert(!("seq" in (diskEvents[0] ?? {})));
});

await check("the seq-less JSONL parser skips a truncated trailing line", () => {
  assert.equal(parseJsonlFixture()[1]?.type, "tool_end");
});

const sseBody =
  'id: 1\nevent: task_started\ndata: {"seq":1,"at":"2026-01-01T00:00:00.000Z","type":"task_started"}\n\n' +
  'id: 2\nevent: task_finished\ndata: {"seq":2,"at":"2026-01-01T00:00:01.000Z","type":"task_finished"}\n\n';

/** What `GET /tasks/:id/log` serves: the same sequenced records, one per line. */
const logBody =
  '{"seq":1,"at":"2026-01-01T00:00:00.000Z","type":"task_started"}\n' +
  '{"seq":2,"at":"2026-01-01T00:00:00.500Z","type":"tool_start","data":{"tool":"bash","args":{"command":"curl http://x.test"}}}\n' +
  '{"seq":3,"at":"2026-01-01T00:00:01.000Z","type":"task_finished"}\n';

/** The attack the old history() fell for: the task rewrites its own workspace log. */
const tamperedWorkspaceLog =
  '{"at":"2026-01-01T00:00:00.000Z","type":"intent_declared","data":{"commands":["curl"],"hosts":[],"writes":[]}}\n';

function okTask(): Response {
  return new Response(JSON.stringify(task("wire")), { status: 200 });
}

function wireFetch(routes: { log?: () => Response; events?: () => Response }): LingFetch {
  return async (input) => {
    const url = String(input);
    if (url.endsWith("/log")) {
      return routes.log?.() ?? new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    }
    if (url.endsWith("/events")) {
      return routes.events?.() ?? new Response(JSON.stringify({ error: "down" }), { status: 503 });
    }
    return okTask();
  };
}

const mixedFetch = wireFetch({
  log: () => new Response(logBody, { status: 200 }),
  events: () => new Response(sseBody, { status: 200 }),
});

async function withTamperedWorkspace(
  run: (workspaceDir: string, workspacesDir: string) => Promise<void>,
): Promise<void> {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "overlord-check-"));
  try {
    const workspaceDir = path.join(tmpRoot, "wire");
    await mkdir(workspaceDir);
    await writeFile(path.join(workspaceDir, "events.jsonl"), tamperedWorkspaceLog, "utf8");
    await run(workspaceDir, tmpRoot);
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

const types = (events: readonly { type: string }[]) => events.map((event) => event.type).join(",");

await check("history reads the service's log route, never a workspace events.jsonl", async () => {
  await withTamperedWorkspace(async (workspaceDir, workspacesDir) => {
    // Both of the old disk sources are present and readable, and the SSE cache
    // is full, so a history() that consulted any of them would show it here.
    const client = new LingClient({ fetch: mixedFetch, retryDelayMs: 0, workspacesDir });
    for await (const _event of client.events("wire")) {
      // Fill the SSE cache.
    }
    const history = await client.history({ ...task("wire"), workspaceDir });
    assert.equal(types(history), "task_started,tool_start,task_finished");
    assert.deepEqual(
      history.map((event) => event.seq),
      [1, 2, 3],
    );
    assert.equal(
      eventFingerprint(history[1] ?? { type: "", data: null }),
      eventFingerprint({ type: "tool_start", data: { tool: "bash", args: { command: "curl http://x.test" } } }),
    );
  });
});

await check("history falls back to stream events already seen, not to the workspace", async () => {
  await withTamperedWorkspace(async (workspaceDir, workspacesDir) => {
    const client = new LingClient({
      fetch: wireFetch({ events: () => new Response(sseBody, { status: 200 }) }),
      retryDelayMs: 0,
      workspacesDir,
    });
    for await (const _event of client.events("wire")) {
      // A worker without the log route; the stream is what this client saw.
    }
    const history = await client.history({ ...task("wire"), workspaceDir });
    assert.equal(types(history), "task_started,task_finished");
  });
});

await check("history with no log and no stream reports nothing, not the workspace file", async () => {
  await withTamperedWorkspace(async (workspaceDir, workspacesDir) => {
    const client = new LingClient({
      fetch: wireFetch({}),
      retryDelayMs: 0,
      maxAttempts: 1,
      workspacesDir,
    });
    assert.deepEqual(await client.history({ ...task("wire"), workspaceDir }), []);
  });
});

await check("the log route is parsed strictly, except for a line still being written", async () => {
  const served = (body: string) =>
    new LingClient({
      fetch: wireFetch({ log: () => new Response(body, { status: 200 }) }),
      retryDelayMs: 0,
    }).fetchLog("wire");
  // A running task's log can be caught mid-append.
  assert.equal(types(await served(`${logBody}{"seq":4,"at":"2026-01-0`)), "task_started,tool_start,task_finished");
  // Anything else malformed is a broken log, not a line to skip.
  await assert.rejects(
    served(`${logBody.split("\n")[0]}\nnot json\n${logBody.split("\n")[2]}\n`),
    LingProtocolError,
  );
  await assert.rejects(served('{"at":"2026-01-01T00:00:00.000Z","type":"tool_start"}\n'), LingProtocolError);
  const oversized = new LingClient({
    fetch: wireFetch({
      log: () =>
        new Response(logBody, {
          status: 200,
          headers: { "content-length": String(64 * 1024 * 1024) },
        }),
    }),
    retryDelayMs: 0,
  });
  await assert.rejects(oversized.fetchLog("wire"), /exceeded/);
});

await check("an event sequence is complete only from 1 to its terminal event, gapless", () => {
  const event = (seq: unknown, type = "tool_start") => ({ seq, type });
  const finished = (seq: number) => event(seq, "task_finished");
  assert.equal(assessEventSequence([event(1), event(2), finished(3)]).complete, true);
  assert.equal(assessEventSequence([finished(3), event(1), event(2)]).complete, true, "order-insensitive");
  for (const [events, reason] of [
    [[], /no events/],
    [[event(2), finished(3)], /begins at sequence 2 rather than 1/],
    [[event(1), finished(3)], /missing sequence 2/],
    [[event(1), event(2)], /no terminal event/],
    [[event(1), finished(2), event(3)], /continues past its terminal event at sequence 2/],
    [[event(1), event(1), finished(2)], /sequence 1 more than once/],
    [[event(undefined), finished(1)], /no sequence number/],
  ] as const) {
    const assessment = assessEventSequence(events);
    assert.equal(assessment.complete, false, JSON.stringify(events));
    assert.match(assessment.reason ?? "", reason);
  }
});

await check("an event record survives a restart and resumes from its first gap", async () => {
  const campaignDir = await mkdtemp(path.join(os.tmpdir(), "overlord-event-record-"));
  const at = "2026-01-01T00:00:00.000Z";
  const event = (seq: number, type = "tool_start", data?: unknown): LingEvent => ({
    seq,
    at,
    type,
    ...(data === undefined ? {} : { data }),
  });
  try {
    const first = await EventRecord.open(campaignDir, "task-1");
    assert.equal(first.filename, path.join(campaignDir, "events", "task-1.jsonl"));
    assert.equal(await first.append(event(1, "task_started")), true);
    assert.equal(await first.append(event(2)), true);
    assert.equal(await first.append(event(4)), true);
    assert.equal(first.resumeSeq, 2);
    assert.match(first.assess().reason ?? "", /missing sequence 3/);
    await first.close();

    const reopened = await EventRecord.open(campaignDir, "task-1");
    assert.equal(reopened.resumeSeq, 2, "the gap is still there after reopening");
    // A reconnect from resumeSeq replays what is already held, and the gap.
    async function* replay(): AsyncGenerator<LingEvent> {
      for (const seq of [2, 3, 4]) yield event(seq);
      yield event(5, "task_finished");
    }
    const passed: number[] = [];
    for await (const tapped of reopened.tap(replay())) passed.push(tapped.seq);
    assert.deepEqual(passed, [2, 3, 4, 5], "tap hands every event on, duplicates included");
    assert.equal(reopened.assess().complete, true, reopened.assess().reason ?? "");
    assert.equal(await reopened.append(event(3)), false, "a duplicate is not recorded twice");
    await reopened.close();

    const read = await readEventRecord(campaignDir, "task-1");
    assert.deepEqual(read?.map((recorded) => recorded.seq), [1, 2, 3, 4, 5]);
    assert.equal(assessEventSequence(read ?? []).complete, true);
    assert.equal(await readEventRecord(campaignDir, "task-never-recorded"), undefined);
  } finally {
    await rm(campaignDir, { recursive: true, force: true });
  }
});

await check("an event record keeps a conflicting replay as evidence, and is then incomplete", async () => {
  const campaignDir = await mkdtemp(path.join(os.tmpdir(), "overlord-event-record-"));
  const at = "2026-01-01T00:00:00.000Z";
  try {
    const record = await EventRecord.open(campaignDir, "task-2");
    await record.append({ seq: 1, at, type: "tool_start", data: { tool: "bash" } });
    await record.append({ seq: 2, at, type: "task_finished" });
    assert.equal(record.assess().complete, true);
    // The same seq with different content: something rewrote history upstream.
    assert.equal(await record.append({ seq: 1, at, type: "tool_start", data: { tool: "read" } }), false);
    assert.match(record.assess().reason ?? "", /sequence 1 twice with different content/);
    assert.deepEqual(record.events()[0]?.data, { tool: "bash" }, "the first account is kept");
    await record.close();
    const read = await readEventRecord(campaignDir, "task-2");
    assert.match(assessEventSequence(read ?? []).reason ?? "", /sequence 1 more than once/);
  } finally {
    await rm(campaignDir, { recursive: true, force: true });
  }
});

await check("an event record does not let an interrupted line swallow the next event", async () => {
  const campaignDir = await mkdtemp(path.join(os.tmpdir(), "overlord-event-record-"));
  try {
    await mkdir(path.join(campaignDir, "events"));
    await writeFile(
      path.join(campaignDir, "events", "task-3.jsonl"),
      '{"seq":1,"at":"2026-01-01T00:00:00.000Z","type":"task_started"}\n{"seq":2,"at":"2026-01-0',
    );
    const record = await EventRecord.open(campaignDir, "task-3");
    assert.equal(record.resumeSeq, 1);
    await record.append({ seq: 2, at: "2026-01-01T00:00:01.000Z", type: "task_finished" });
    await record.close();
    const read = await readEventRecord(campaignDir, "task-3");
    assert.deepEqual(read?.map((recorded) => recorded.seq), [1, 2]);
    assert.equal(assessEventSequence(read ?? []).complete, true);
  } finally {
    await rm(campaignDir, { recursive: true, force: true });
  }
});

await check("an event record refuses a task id that is not a plain file name", () => {
  for (const id of ["../escape", "a/b", "a\\b", ".hidden", ""]) {
    assert.throws(() => eventRecordPath(os.tmpdir(), id), /cannot name an event record/, id);
  }
});

await check("task parsing rejects malformed routing metadata", async () => {
  await assert.rejects(
    new LingClient({
      fetch: async () =>
        new Response(JSON.stringify({ ...task("wire"), requestKey: 42 }), { status: 200 }),
    }).get("wire"),
    LingProtocolError,
  );
});

await check("HTTP 400 is terminal", async () => {
  let calls = 0;
  const fetch: LingFetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: "bad input" }), { status: 400 });
  };
  await assert.rejects(
    new LingClient({ fetch, retryDelayMs: 0 }).get("wire"),
    (error: unknown) =>
      error instanceof LingClientError && error.status === 400 && !error.retryable && calls === 1,
  );
});

await check("HTTP 409 is terminal", async () => {
  let calls = 0;
  const fetch: LingFetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: "already completed" }), { status: 409 });
  };
  await assert.rejects(
    new LingClient({ fetch, retryDelayMs: 0 }).cancel("wire"),
    (error: unknown) =>
      error instanceof LingClientError && error.status === 409 && !error.retryable && calls === 1,
  );
});

await check("HTTP 5xx is retried", async () => {
  let calls = 0;
  const fetch: LingFetch = async () => {
    calls += 1;
    return calls === 1
      ? new Response(JSON.stringify({ error: "temporary" }), { status: 503 })
      : okTask();
  };
  await new LingClient({ fetch, retryDelayMs: 0 }).get("wire");
  assert.equal(calls, 2);
});

await check("HTTP 429 honours retry-after and retries", async () => {
  let calls = 0;
  const fetch: LingFetch = async () => {
    calls += 1;
    return calls === 1
      ? new Response(JSON.stringify({ error: "slow down" }), {
          status: 429,
          headers: { "retry-after": "0" },
        })
      : okTask();
  };
  await new LingClient({ fetch, retryDelayMs: 0 }).get("wire");
  assert.equal(calls, 2);
});

await check("transport errors are retried", async () => {
  let calls = 0;
  const fetch: LingFetch = async () => {
    calls += 1;
    if (calls === 1) throw new TypeError("connection reset");
    return okTask();
  };
  await new LingClient({ fetch, retryDelayMs: 0 }).get("wire");
  assert.equal(calls, 2);
});

await check("a hung request times out", async () => {
  let calls = 0;
  const fetch: LingFetch = async (_input, init) =>
    new Promise((_resolve, reject) => {
      calls += 1;
      // A real in-flight request holds a socket open; AbortSignal.timeout runs on
      // an unref'd timer, so the fixture has to keep the loop alive itself.
      const inFlight = setTimeout(() => undefined, 60_000);
      init?.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(inFlight);
          reject(init.signal?.reason);
        },
        { once: true },
      );
    });
  await assert.rejects(
    new LingClient({
      fetch,
      retryDelayMs: 0,
      maxAttempts: 2,
      requestTimeoutMs: 20,
    }).get("wire"),
    (error: unknown) => error instanceof LingClientError && error.retryable && calls === 2,
  );
});

await check("the request deadline does not cut off a slow SSE stream", async () => {
  const fetch: LingFetch = async (input, init) => {
    if (!String(input).includes("/events")) return okTask();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        init?.signal?.addEventListener(
          "abort",
          () => controller.error(new Error("stream aborted")),
          { once: true },
        );
        controller.enqueue(encoder.encode(sseBody.slice(0, 100)));
        setTimeout(() => {
          controller.enqueue(encoder.encode(sseBody.slice(100)));
          controller.close();
        }, 60);
      },
    });
    return new Response(stream, { status: 200 });
  };
  const events: string[] = [];
  for await (const event of new LingClient({
    fetch,
    retryDelayMs: 0,
    requestTimeoutMs: 20,
  }).events("wire")) {
    events.push(event.type);
  }
  assert.equal(events.join(","), "task_started,task_finished");
});

await check("terminal status forces replay of events missed by a broken SSE stream", async () => {
  let eventRequests = 0;
  const replayBody =
    'id: 1\nevent: task_started\ndata: {"seq":1,"at":"2026-01-01T00:00:00.000Z","type":"task_started"}\n\n' +
    'id: 2\nevent: campaign_message\ndata: {"seq":2,"at":"2026-01-01T00:00:01.000Z","type":"campaign_message","data":{"thread":"worklog","content":"late","mentions":[],"priority":"fyi"}}\n\n' +
    'id: 3\nevent: task_finished\ndata: {"seq":3,"at":"2026-01-01T00:00:02.000Z","type":"task_finished"}\n\n';
  const fetch: LingFetch = async (input) => {
    if (!String(input).includes("/events")) return okTask();
    eventRequests += 1;
    if (eventRequests > 1) return new Response(replayBody, { status: 200 });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'id: 1\nevent: task_started\ndata: {"seq":1,"at":"2026-01-01T00:00:00.000Z","type":"task_started"}\n\n',
          ),
        );
        setTimeout(() => controller.error(new Error("connection lost before terminal")), 0);
      },
    });
    return new Response(stream, { status: 200 });
  };
  const events: string[] = [];
  for await (const event of new LingClient({
    fetch,
    retryDelayMs: 0,
    maxAttempts: 2,
  }).events("wire")) {
    events.push(event.type);
  }
  assert.equal(eventRequests, 2);
  assert.equal(events.join(","), "task_started,campaign_message,task_finished");
});

await check("non-idempotent task spawns are not retried", async () => {
  let calls = 0;
  const fetch: LingFetch = async () => {
    calls += 1;
    throw new TypeError("response lost after POST");
  };
  await assert.rejects(
    new LingClient({ fetch, retryDelayMs: 0 }).spawn({ task: "fixture" }),
    (error: unknown) => error instanceof LingClientError && error.retryable && calls === 1,
  );
});

await check("request-key task spawns retry safely", async () => {
  let calls = 0;
  const fetch: LingFetch = async () => {
    calls += 1;
    if (calls === 1) throw new TypeError("response lost after POST");
    return new Response(
      JSON.stringify({
        id: "deduplicated",
        requestKey: "campaign:key",
        status: "queued",
        options: {},
        seededFiles: [],
      }),
      { status: 202, headers: { "content-type": "application/json" } },
    );
  };
  const spawned = await new LingClient({
    fetch,
    retryDelayMs: 0,
  }).spawn({ task: "fixture", requestKey: "campaign:key" });
  assert.equal(calls, 2);
  assert.equal(spawned.id, "deduplicated");
});

await check("peer messages use the authenticated task inbox wire shape", async () => {
  let pathname = "";
  let body: unknown;
  const client = new LingClient({
    baseUrl: "http://ling.invalid",
    token: "secret",
    retryDelayMs: 0,
    fetch: async (input, init) => {
      pathname = new URL(String(input)).pathname;
      body = JSON.parse(String(init?.body));
      assert.equal(init?.headers instanceof Headers, true);
      return new Response(JSON.stringify({ accepted: true, duplicate: false }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const response = await client.sendPeerMessage("task/one", {
    id: "message-1",
    thread: "worklog",
    from: "builder:01",
    content: "Verified a shared invariant.",
    priority: "fyi",
    sentAt: "2026-08-22T16:00:00.000Z",
  });
  assert.equal(pathname, "/tasks/task%2Fone/messages");
  assert.deepEqual(body, {
    id: "message-1",
    thread: "worklog",
    from: "builder:01",
    content: "Verified a shared invariant.",
    priority: "fyi",
    sentAt: "2026-08-22T16:00:00.000Z",
  });
  assert.deepEqual(response, { accepted: true, duplicate: false });
  const duplicate = await new LingClient({
    baseUrl: "http://ling.invalid",
    token: "secret",
    retryDelayMs: 0,
    fetch: async () =>
      new Response(JSON.stringify({ accepted: true, duplicate: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  }).sendPeerMessage("task-one", {
    id: "message-1",
    thread: "worklog",
    from: "builder:01",
    content: "Verified a shared invariant.",
    priority: "fyi",
    sentAt: "2026-08-22T16:00:00.000Z",
  });
  assert.deepEqual(duplicate, { accepted: true, duplicate: true });
});

await check("fleet placement picks the least-loaded worker and preserves routing", async () => {
  const spawnedOn: string[] = [];
  const fleet = new FleetLingClient({
    workers: [
      { id: "busy", baseUrl: "http://busy.invalid", token: "busy-token" },
      { id: "idle", baseUrl: "http://idle.invalid", token: "idle-token" },
    ],
    clientFactory: (worker) =>
      new LingClient({
        baseUrl: worker.baseUrl,
        token: worker.token,
        retryDelayMs: 0,
        fetch: async (input, init) => {
          const url = new URL(String(input));
          if (url.pathname === "/healthz") {
          return new Response(
            JSON.stringify({
                ok: true,
                queued: worker.id === "busy" ? 2 : 0,
                running: worker.id === "busy" ? 1 : 0,
                maxConcurrency: 2,
            }),
              { status: 200 },
          );
          }
          if (url.pathname === "/tasks" && init?.method === "POST") {
            spawnedOn.push(worker.id);
            return new Response(
              JSON.stringify({
                id: `${worker.id}-task`,
                requestKey: "placement-key",
                status: "queued",
                options: {},
                seededFiles: [],
              }),
              { status: 202 },
            );
          }
          return new Response(
            JSON.stringify({
              id: `${worker.id}-task`,
              requestKey: "placement-key",
              status: "running",
              prompt: "fixture",
              options: {},
              createdAt: "2026-01-01T00:00:00.000Z",
              workspaceDir: `/workers/${worker.id}`,
              seededFiles: [],
            }),
            { status: 200 },
          );
        },
      }),
  });
  const placed = await fleet.spawn({ task: "place me", requestKey: "placement-key" });
  const routed = await fleet.get(placed.id, placed.workerId);
  assert.equal(spawnedOn.join(","), "idle");
  assert.equal(placed.workerId, "idle");
  assert.equal(routed.workerId, "idle");
});

await check("fleet placement filters provider, model, and skill capabilities", async () => {
  const spawnedOn: string[] = [];
  const fleet = new FleetLingClient({
    workers: [
      { id: "openai", baseUrl: "http://openai.invalid", token: "openai-token" },
      { id: "anthropic", baseUrl: "http://anthropic.invalid", token: "anthropic-token" },
    ],
    clientFactory: (worker) =>
      new LingClient({
        baseUrl: worker.baseUrl,
        token: worker.token,
        retryDelayMs: 0,
        fetch: async (input, init) => {
          const url = new URL(String(input));
          if (url.pathname === "/healthz") {
            const anthropic = worker.id === "anthropic";
            return new Response(
              JSON.stringify({
                ok: true,
                workerId: worker.id,
                queued: 0,
                running: 0,
                maxConcurrency: 1,
                provider: anthropic ? "anthropic" : "openai",
                models: [anthropic ? "claude-fixture" : "gpt-fixture"],
                skills: anthropic ? ["research-rules"] : ["coding-rules"],
                capabilities: {
                  inlineSkills: {
                    enabled: anthropic,
                    maxSkillsPerTask: 16,
                    maxInlineSkillsPerTask: 8,
                    maxInlineSkillBytes: 16384,
                    maxInlineSkillsTotalBytes: 65536,
                  },
                },
              }),
              { status: 200 },
            );
          }
          if (url.pathname === "/tasks" && init?.method === "POST") {
            spawnedOn.push(worker.id);
            return new Response(
              JSON.stringify({
                id: `${worker.id}-profiled-task`,
                requestKey: "profiled-placement",
                status: "queued",
                options: {},
                seededFiles: [],
              }),
              { status: 202 },
            );
          }
          throw new Error(`Unexpected fixture URL ${url}`);
        },
      }),
  });
  const spawned = await fleet.spawn({
    task: "profiled",
    requestKey: "profiled-placement",
    provider: "anthropic",
    model: "claude-fixture",
    tools: ["read"],
    skills: ["research-rules"],
    inlineSkills: [
      {
        name: "task-rules",
        content: "---\nname: task-rules\ndescription: Task rules\n---\nResearch carefully.",
      },
    ],
  });
  assert.equal(spawned.workerId, "anthropic");
  assert.deepEqual(spawnedOn, ["anthropic"]);
  await assert.rejects(
    fleet.spawn({
      task: "unsupported",
      requestKey: "unsupported-placement",
      provider: "missing-provider",
      tools: ["read"],
    }),
    /No Ling worker satisfies the requested profile/,
  );
});

await check("healthz accepts the oversight capability exactly and nothing near it", async () => {
  const healthOf = (capabilities?: unknown) =>
    new LingClient({
      baseUrl: "http://ling.invalid",
      retryDelayMs: 0,
      maxAttempts: 1,
      fetch: async () =>
        new Response(
          JSON.stringify({
            ok: true,
            queued: 0,
            ...(capabilities === undefined ? {} : { capabilities }),
          }),
          { status: 200 },
        ),
    }).health();
  const oversight = { version: 1, adviceWaitMs: 120000, watchIdleMs: 60000, maxHoldMs: 300000 };
  // A ling that predates oversight, or one whose tool results are too small to
  // carry it, advertises nothing, and must still be usable.
  assert.equal((await healthOf()).capabilities, undefined);
  assert.equal((await healthOf({})).capabilities?.oversight, undefined);
  assert.deepEqual((await healthOf({ oversight })).capabilities?.oversight, oversight);
  // A later version is well formed; refusing it is the pair's call.
  assert.equal(
    (await healthOf({ oversight: { ...oversight, version: 2 } })).capabilities?.oversight?.version,
    2,
  );
  const malformed: unknown[] = [
    { ...oversight, extra: 1 },
    { version: 1, adviceWaitMs: 120000, watchIdleMs: 60000 },
    { version: 1, adviceWaitMs: 120000, watchIdleMs: 60000, extra: 300000 },
    { ...oversight, version: 0 },
    { ...oversight, adviceWaitMs: 0 },
    { ...oversight, maxHoldMs: -1 },
    { ...oversight, watchIdleMs: 1.5 },
    { ...oversight, adviceWaitMs: "120000" },
    [],
    null,
    true,
  ];
  for (const value of malformed) {
    await assert.rejects(
      healthOf({ oversight: value }),
      (error: unknown) => error instanceof LingProtocolError,
      JSON.stringify(value),
    );
  }
  await assert.rejects(
    healthOf({ oversight, unknownCapability: {} }),
    (error: unknown) => error instanceof LingProtocolError,
  );
});

await check("fleet listing tolerates one unreachable worker", async () => {
  const fleet = new FleetLingClient({
    workers: [
      { id: "down", baseUrl: "http://down.invalid", token: "down-token" },
      { id: "up", baseUrl: "http://up.invalid", token: "up-token" },
    ],
    clientFactory: (worker) =>
      new LingClient({
        baseUrl: worker.baseUrl,
        token: worker.token,
        retryDelayMs: 0,
        maxAttempts: 1,
        fetch: async () => {
          if (worker.id === "down") throw new TypeError("offline");
          return new Response(JSON.stringify({ tasks: [task("wire")] }), { status: 200 });
        },
      }),
  });
  const tasks = await fleet.list();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.workerId, "up");
});

await check("fleet placement refuses workers at capacity", async () => {
  const fleet = new FleetLingClient({
    workers: [{ id: "full", baseUrl: "http://full.invalid", token: "full-token" }],
    clientFactory: (worker) =>
      new LingClient({
        baseUrl: worker.baseUrl,
        token: worker.token,
        fetch: async () =>
          new Response(
            JSON.stringify({ ok: true, queued: 1, running: 1, maxConcurrency: 2 }),
            { status: 200 },
          ),
      }),
  });
  await assert.rejects(
    fleet.spawn({ task: "must wait", requestKey: "full-worker" }),
    (error: unknown) => error instanceof LingClientError && error.status === 429,
  );
});

class FakeLingProcess implements ManagedLingProcess {
  readonly pid = 4242;
  exitCode: number | null = null;
  private errorListener: ((error: Error) => void) | undefined;
  private exitListener:
    | ((code: number | null, signal: NodeJS.Signals | null) => void)
    | undefined;

  kill(_signal?: NodeJS.Signals | number): boolean {
    this.exitCode = 0;
    this.exitListener?.(0, null);
    return true;
  }

  on(event: "error", listener: (error: Error) => void): this {
    if (event === "error") this.errorListener = listener;
    return this;
  }

  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this {
    if (event === "exit") this.exitListener = listener;
    return this;
  }
}

await check("bootstrap reuses an authenticated ling", async () => {
  let starts = 0;
  const client = {
    health: async () => ({ ok: true as const, queued: 0 }),
    list: async () => [],
  } as unknown as LingClient;
  const runtime = await bootstrapLing({
    client,
    token: "fixture-token",
    startProcess: () => {
      starts += 1;
      return new FakeLingProcess();
    },
  });
  assert(!runtime.startedByOverlord);
  assert.equal(starts, 0);
});

await check("bootstrap starts a missing local ling with the shared token", async () => {
  let healthCalls = 0;
  let childOptions: SpawnOptions | undefined;
  const client = {
    health: async () => {
      healthCalls += 1;
      if (healthCalls === 1) {
        throw new LingClientError("offline", undefined, true);
      }
      return { ok: true as const, queued: 0 };
    },
    list: async () => [],
  } as unknown as LingClient;
  const runtime = await bootstrapLing({
    client,
    token: "fixture-token",
    lingDir: process.cwd(),
    command: process.execPath,
    args: [],
    startupTimeoutMs: 1_000,
    startProcess: (_command, _args, options) => {
      childOptions = options;
      return new FakeLingProcess();
    },
  });
  assert(runtime.startedByOverlord);
  assert.equal(runtime.pid, 4242);
  assert.equal(
    (childOptions?.env as NodeJS.ProcessEnv | undefined)?.["AGENT_TOKEN"],
    "fixture-token",
  );
});

await check("bootstrap stops only its owned ling process", async () => {
  let healthCalls = 0;
  const client = {
    health: async () => {
      healthCalls += 1;
      if (healthCalls === 1) {
        throw new LingClientError("offline", undefined, true);
      }
      return { ok: true as const, queued: 0 };
    },
    list: async () => [],
  } as unknown as LingClient;
  const child = new FakeLingProcess();
  const runtime = await bootstrapLing({
    client,
    token: "fixture-token",
    lingDir: process.cwd(),
    command: process.execPath,
    args: [],
    startupTimeoutMs: 1_000,
    startProcess: () => child,
  });
  await runtime.stop();
  assert.equal(child.exitCode, 0);
});

await check("bootstrap does not replace a reachable unauthorized ling", async () => {
  let starts = 0;
  const client = {
    health: async () => ({ ok: true as const, queued: 0 }),
    list: async () => {
      throw new LingClientError("unauthorized", 401, false);
    },
  } as unknown as LingClient;
  await assert.rejects(
    bootstrapLing({
      client,
      token: "wrong-token",
      startProcess: () => {
        starts += 1;
        return new FakeLingProcess();
      },
    }),
    (error: unknown) => error instanceof LingClientError && error.status === 401 && starts === 0,
  );
});

await check("untrusted content cannot close its fence", () => {
  const probe = fenceUntrusted("worker", "safe");
  const closingMarker = probe.split("\n").at(-1);
  assert.notEqual(closingMarker, undefined);
  const fenced = fenceUntrusted("worker", `before\n${closingMarker}\nafter`);
  const exactClosings = fenced.split("\n").filter((line) => line === closingMarker).length;
  assert.equal(exactClosings, 1);
  assert(fenced.includes("before"));
  assert(fenced.includes("after"));
});

// ling's write_result refuses data that is not a JSON object, and this is the
// other half of that agreement: an envelope whose data is the JSON string of
// the object it should be, as deepseek-v4.1-flash once sent, is refused here
// too, not parsed into an object on the worker's behalf.
await check("the worker result parser refuses data that is not a JSON object, as ling's write_result does", () => {
  const data = { kind: "build", artifacts: [{ path: "output.txt" }] };
  const envelope = (value: unknown) => ({ status: "success", summary: "Built it.", data: value, steps: [] });
  assert.deepEqual(parseWorkerResult(envelope(data), "builder", [], null).data, data);
  for (const value of [JSON.stringify(data), [data], 1, true, null, undefined]) {
    assert.throws(() => parseWorkerResult(envelope(value), "builder", [], null), {
      name: WorkerResultError.name,
      message: "result.data: must be an object",
    });
  }
});

console.log(failures === 0 ? "\nall Phase 0 checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
