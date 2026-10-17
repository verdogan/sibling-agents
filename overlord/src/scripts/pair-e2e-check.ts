/**
 * A watched pair end to end, with real processes and no model: $0, offline.
 *
 * Each scenario is a real campaign run by the real driver with the local-task
 * provisioner (LING_PROVISIONER=local-task's client), so every task is its own
 * ling child on loopback: B and A, then the reviewer and integration. Every
 * child answers its provider calls from a script (ling's LING_SCRIPTED_MODEL,
 * opted in with LING_ALLOW_SCRIPTED_MODEL=1 by this check's bootstrap and by
 * nothing in the provisioner), so the HTTP API, the queue, Pi's agent loop,
 * the tools, the hold gate, the feed, the outboxes and the settlement are all
 * the real ones, and only the models are not. Assertions read the persisted
 * manifest and the overlord's EventRecord, never log text.
 *
 * What this proves is that the parts work together over real transport and
 * real process lifecycles. It proves nothing about any model: a scripted B
 * cites what its script tells it to, and a scripted A asks when told to. The
 * scripts wait on what they are shown (`until`), not on the clock, so the
 * order of B's actions is fixed while their timing is whatever the processes
 * make it.
 *
 * Safety: a child gets a script or is not started. The bootstrap refuses a
 * provider with no script, the children's environment is stripped of provider
 * keys, and each child's /healthz must name its scripted provider before the
 * lease is handed back. A task on a ling that was not opted in cannot name the
 * scripted provider or model, and the first checks show that too.
 *
 * Not in `npm run check`: it starts eighteen ling processes and takes about
 * two minutes, and it has been run on Windows only. Run it with
 * `npm run pair-e2e-check`.
 *
 * A wedged member is killed, never left: (c) is an A that its own ling cannot
 * stop, given up on at its own wall clock plus a grace and killed when its
 * cancel goes unconfirmed, and (c') is the same rung on B, at settlement.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CampaignArtifactStore } from "../campaign/artifacts.js";
import { CampaignDriver } from "../campaign/driver.js";
import { assessEventSequence, readEventRecord } from "../campaign/event-record.js";
import { initializeCampaign } from "../campaign/initialize.js";
import { CampaignManifestStore } from "../campaign/manifest.js";
import type { OversightTimings } from "../campaign/oversight.js";
import type {
  CampaignManifest,
  CampaignPairRecord,
  CampaignTaskRecord,
} from "../campaign/schema.js";
import { bootstrapLing } from "../ling/bootstrap.js";
import { LingClientError } from "../ling/client.js";
import type { LingEvent } from "../ling/types.js";
import { LocalTaskProvisioner, type LocalLingRuntime } from "../ling/local-provisioner.js";
import { ProvisionedLingClient, resolvedWorkerProfileFromSpawnInput } from "../ling/provisioner.js";
import { DEFAULT_ALLOWED_TOOLS, type SpawnPolicy } from "../policy.js";

let failures = 0;
let passes = 0;

async function check(label: string, run: () => void | Promise<void>): Promise<void> {
  try {
    await run();
    passes += 1;
    console.log(`PASS  ${label}`);
  } catch (error) {
    failures += 1;
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(`FAIL  ${label} -- ${detail}`);
  }
}

function skip(label: string, reason: string): void {
  console.log(`SKIP  ${label} -- ${reason}`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}

// ---------------------------------------------------------------------------
// Where the children come from: the real ling source, through a scratch
// checkout with no .env and no credential store, so no key can reach them.

const sourceLingDir = path.resolve(
  process.env["LING_DIR"]?.trim() || fileURLToPath(new URL("../../../ling", import.meta.url)),
);
const tsxCli = path.join(sourceLingDir, "node_modules", "tsx", "dist", "cli.mjs");
const serverPath = path.join(sourceLingDir, "src", "server.ts");
const scratch = await mkdtemp(path.join(os.tmpdir(), "ling-pair-e2e-check-"));
const scratchLingDir = path.join(scratch, "ling");
await mkdir(scratchLingDir);
await symlink(
  path.join(sourceLingDir, "node_modules"),
  path.join(scratchLingDir, "node_modules"),
  process.platform === "win32" ? "junction" : "dir",
);

/**
 * The overlord environment children are built from: nothing secret, and none
 * of the developer's own ling settings, which would change what a child does.
 */
function childEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const secret = /(_API_KEY|_TOKEN|_SECRET|_PASSWORD)$|^(AWS_|AZURE_|GOOGLE_)/i;
  const setting = /^(AGENT_|MAX_|OVERSIGHT_|SANDBOX_|LING_SCRIPTED|LING_ALLOW_SCRIPTED)/i;
  for (const name of Object.keys(env)) {
    if (secret.test(name) || setting.test(name)) delete env[name];
  }
  return { ...env, SANDBOX_MODE: "none", OVERSIGHT_WATCH_IDLE_MS: "30000", ...extra };
}

const POLICY: SpawnPolicy = {
  allowedTools: DEFAULT_ALLOWED_TOOLS,
  maxCostUsdPerTask: 1,
  maxTurnsPerTask: 60,
  maxWallClockMsPerTask: 900_000,
  maxTasksPerRun: 8,
  maxConcurrentTasks: 2,
  maxTotalCostUsd: 2,
};

const SCRIPTED = {
  builder: "scripted-builder",
  watcher: "scripted-watcher",
  reviewer: "scripted-reviewer",
  integration: "scripted-integration",
  planner: "scripted-planner",
} as const;

function definition(id: string, builderWallClockMs = 180_000): unknown {
  const role = (provider: string, tools: string[], maxTurns: number, maxWallClockMs = 180_000) => ({
    tools,
    maxCostUsd: 0.1,
    maxTurns,
    maxWallClockMs,
    provider,
    model: "scripted-model",
  });
  return {
    id,
    goal: "Write output.txt with the word the overseer advises.",
    acceptance: [{ id: "output", kind: "file", requirement: "output.txt says good" }],
    budget: { maxTasks: 6, maxTotalCostUsd: 1 },
    maxRounds: 1,
    slices: [{ id: "01", spec: "Write output.txt." }],
    roles: {
      planner: role(SCRIPTED.planner, ["read", "write"], 4),
      builder: role(
        SCRIPTED.builder,
        ["read", "write", "bash", "declare_intent"],
        40,
        builderWallClockMs,
      ),
      reviewer: role(SCRIPTED.reviewer, ["read", "ls", "write_result"], 8),
      integration: role(SCRIPTED.integration, ["read", "ls", "write_result"], 8),
    },
    coordination: {
      enabled: true,
      watch: {
        condition: "channel",
        watcher: { provider: SCRIPTED.watcher, model: "scripted-model" },
        watcherMaxCostUsd: 0.1,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Scripts. A turn is text and tool calls; `until` repeats it until what the
// model was shown matches; `capture` takes a value for `{{name}}` later.

type Turn = Record<string, unknown>;
const call = (name: string, args: Record<string, unknown> = {}) => ({ name, args });
/** A turn of one tool call. */
const act = (name: string, args: Record<string, unknown> = {}): Turn => ({
  toolCalls: [call(name, args)],
});
const script = (...turns: Turn[]) => ({ version: 1, turns });

const DECLARE = {
  toolCalls: [
    call("declare_intent", { commands: ["sleep"], hosts: [], writes: ["output.txt", "result.json"] }),
  ],
};
const BUILT = [
  { toolCalls: [call("write", { path: "output.txt", content: "good" })] },
  {
    toolCalls: [
      call("write", {
        path: "result.json",
        content: JSON.stringify({
          status: "success",
          summary: "Wrote output.txt.",
          data: { kind: "build", artifacts: [{ path: "output.txt" }] },
          steps: ["wrote output.txt"],
        }),
      }),
    ],
  },
  { text: "Done." },
];
/** Work in one-second steps until a hold has come and gone, however it ended. */
const WORK_THROUGH_HOLD = {
  toolCalls: [call("bash", { command: "sleep 1" })],
  until: "hold-1[^\\n]*ended",
  maxRepeats: 120,
};
/** The latest tool fact the watcher was shown, as evidence for what it does next. */
const LATEST_TOOL_FACT = { tool: '"id":"(a:\\d+)","kind":"tool"' };
const WATCH_UNTIL_FINAL = {
  toolCalls: [call("watch_next")],
  until: "No further batches will arrive",
  maxRepeats: 200,
};
const watcherReport = (summary: string, refs: string[]) =>
  call("write_result", {
    status: "success",
    summary,
    data: {
      version: 1,
      summary,
      // A script cannot count; the overlord's own counts are the ones that
      // count, and a mismatch is recorded on the verdict, not corrected.
      observed: { batches: 0, lastBatch: null, heartbeats: 0, finalReceived: true },
      concerns: refs.map((ref) => ({
        code: "other",
        severity: "low",
        refs: [ref],
        note: "Raised by a script, to show a cited id is graded.",
      })),
      statements: [],
      unobserved: [
        "No sensor runs here, so what the worker's programs did beyond its tool calls is unseen.",
      ],
    },
    steps: ["watched to the final batch"],
  });
const reviewScript = (kind: "review" | "integration") =>
  script(
    {
      toolCalls: [
        call("write_result", {
          status: "success",
          summary: "output.txt says good.",
          data: {
            kind,
            verdict: "accept",
            checks: [{ criterion: "output", passed: true, evidence: "output.txt says good" }],
            evidence: ["read output.txt"],
            gaps: [],
            barFetch: null,
          },
          steps: ["checked output.txt"],
        }),
      ],
    },
    { text: "Checked." },
  );
const REVIEWERS = {
  [SCRIPTED.reviewer]: reviewScript("review"),
  [SCRIPTED.integration]: reviewScript("integration"),
};

// ---------------------------------------------------------------------------
// One campaign: a provisioner whose children each get their role's script.

interface StartedLing {
  provider: string;
  runtime: LocalLingRuntime;
}

interface CampaignRun {
  manifest: CampaignManifest;
  directory: string;
  lings: Map<string, StartedLing>;
}

const TIMINGS: Partial<OversightTimings> = {
  readyMs: 60_000,
  outliveMs: 30_000,
  cancelGraceMs: 4_000,
  pollMs: 100,
  minBatchIntervalMs: 1,
};

async function runCampaign(
  name: string,
  setup: {
    scripts: Record<string, unknown>;
    adviceWaitMs: number;
    timings?: Partial<OversightTimings>;
    /** A's wall clock; 180 000 ms unless a scenario needs it to run out. */
    builderWallClockMs?: number;
    /** The driver's allowance past a task's deadline; its default unless a scenario waits on it. */
    settleGraceMs?: number;
    onProgress?: (manifest: CampaignManifest, lings: ReadonlyMap<string, StartedLing>) => void;
  },
): Promise<CampaignRun> {
  const directory = path.join(scratch, name);
  await mkdir(path.join(directory, "scripts"), { recursive: true });
  const scriptFiles = new Map<string, string>();
  for (const [provider, body] of Object.entries(setup.scripts)) {
    const file = path.join(directory, "scripts", `${provider}.json`);
    await writeFile(file, JSON.stringify(body, null, 2));
    scriptFiles.set(provider, file);
  }
  const lings = new Map<string, StartedLing>();
  const provisioner = new LocalTaskProvisioner({
    sourceLingDir: scratchLingDir,
    runtimeRootDir: path.join(directory, "workers"),
    env: childEnvironment({ OVERSIGHT_ADVICE_WAIT_MS: String(setup.adviceWaitMs) }),
    args: [tsxCli, serverPath],
    startupTimeoutMs: 120_000,
    terminateGraceMs: 2_000,
    bootstrap: async (options) => {
      const provider = options.env?.["AGENT_PROVIDER"] ?? "";
      const file = scriptFiles.get(provider);
      if (file === undefined) {
        throw new Error(
          `No script for provider ${JSON.stringify(provider)}; a ling without one could reach ` +
            "a model, so none is started.",
        );
      }
      const runtime = await bootstrapLing({
        ...options,
        env: { ...options.env, LING_SCRIPTED_MODEL: file, LING_ALLOW_SCRIPTED_MODEL: "1" },
      });
      const health = await runtime.client.health();
      if (health.provider !== provider || health.models?.join() !== "scripted-model") {
        await runtime.kill().catch(() => undefined);
        throw new Error(`Ling for ${provider} came up as ${health.provider}/${health.models?.join()}.`);
      }
      lings.set(options.env?.["WORKER_ID"] ?? "", { provider, runtime });
      return runtime;
    },
  });
  const client = new ProvisionedLingClient({
    provisioner,
    resolveProfile: resolvedWorkerProfileFromSpawnInput,
    defaultLeaseTtlMs: 30 * 60_000,
  });
  const store = new CampaignManifestStore(path.join(directory, "manifest.json"));
  const artifacts = new CampaignArtifactStore(directory, path.join(directory, "workspaces"), client);
  await initializeCampaign(store, artifacts, definition(name, setup.builderWallClockMs));
  const driver = new CampaignDriver({
    client,
    store,
    artifacts,
    policy: POLICY,
    pollIntervalMs: 100,
    ...(setup.settleGraceMs === undefined ? {} : { settleGraceMs: setup.settleGraceMs }),
    oversight: { timings: { ...TIMINGS, ...setup.timings } },
    ...(setup.onProgress === undefined
      ? {}
      : { onProgress: (manifest: CampaignManifest) => setup.onProgress!(manifest, lings) }),
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    const manifest = await Promise.race([
      driver.run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} did not finish within 240 s.`)), 240_000);
      }),
    ]);
    return { manifest, directory, lings };
  } catch (error) {
    await driver.shutdown().catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
    // Whatever the driver left behind, so that no child outlives the scenario.
    await provisioner.forceShutdown();
  }
}

function pairOf(manifest: CampaignManifest): CampaignPairRecord {
  const pair = manifest.slices[0]?.attempts[0]?.watch;
  assert(pair !== undefined, "the slice's first attempt has no pair");
  return pair;
}

function taskOf(manifest: CampaignManifest, role: CampaignTaskRecord["role"]): CampaignTaskRecord {
  const record = manifest.tasks.find((task) => task.role === role);
  assert(record !== undefined, `no ${role} task was recorded`);
  return record;
}

async function recordOf(run: CampaignRun, taskId: string): Promise<LingEvent[]> {
  const events = await readEventRecord(run.directory, taskId);
  assert(events !== undefined, `the overlord kept no record of ${taskId}`);
  const assessment = assessEventSequence(events);
  assert(assessment.complete, `the record of ${taskId} ${assessment.reason ?? "is incomplete"}`);
  return events;
}

const ofType = (events: readonly LingEvent[], type: string) =>
  events
    .filter((event) => event.type === type)
    .map((event) => (event.data ?? {}) as Record<string, unknown>);

// ===========================================================================

try {
  // -------------------------------------------------------------------------
  // The opt-in itself, at process level.

  await check("a ling refuses to start on half of the scripted-model opt-in, or as a scripted real provider", async () => {
    const attempt = async (extra: Record<string, string>, name: string) => {
      const cwd = path.join(scratch, `refusal-${name}`);
      await mkdir(cwd, { recursive: true });
      const child = spawn(process.execPath, [tsxCli, serverPath], {
        cwd,
        env: { ...childEnvironment(), AGENT_TOKEN: "pair-e2e-check-refusal-token", PORT: "1", ...extra },
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      const code = await new Promise<number | null>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve(null);
        }, 60_000);
        child.once("exit", (exitCode) => {
          clearTimeout(timer);
          resolve(exitCode);
        });
      });
      return { code, stderr };
    };
    const scriptFile = path.join(scratch, "refusal-script.json");
    await writeFile(scriptFile, JSON.stringify(script({ text: "Never run." })));
    const [noAllow, noScript, realProvider] = await Promise.all([
      attempt({ LING_SCRIPTED_MODEL: scriptFile }, "no-allow"),
      attempt({ LING_ALLOW_SCRIPTED_MODEL: "1" }, "no-script"),
      attempt(
        { LING_SCRIPTED_MODEL: scriptFile, LING_ALLOW_SCRIPTED_MODEL: "1", AGENT_PROVIDER: "openai" },
        "real-provider",
      ),
    ]);
    // The exit alone could be a ling that got past its config and then failed
    // to bind port 1, so each must also have been refused for the right reason.
    const halfSet = /refusing to start with only one of them set/;
    for (const [label, outcome, refusal] of [
      ["a script without LING_ALLOW_SCRIPTED_MODEL=1", noAllow, halfSet],
      ["LING_ALLOW_SCRIPTED_MODEL=1 without a script", noScript, halfSet],
      ["a script under a real provider's name", realProvider, /AGENT_PROVIDER must be "scripted"/],
    ] as const) {
      assert(outcome.code !== null && outcome.code !== 0, `${label} started a ling (exit ${outcome.code})`);
      assert.match(outcome.stderr, refusal, `${label} was not refused by the opt-in`);
    }
  });

  await check("a task cannot name the scripted provider or model on a ling that was not opted in", async () => {
    const provisioner = new LocalTaskProvisioner({
      sourceLingDir: scratchLingDir,
      runtimeRootDir: path.join(scratch, "plain-workers"),
      env: childEnvironment(),
      args: [tsxCli, serverPath],
      startupTimeoutMs: 120_000,
    });
    try {
      const lease = await provisioner.summon({
        requestKey: "pair-e2e-check-plain",
        profile: { profileId: "pair-e2e-check-plain", tools: ["read"], provider: "openai" },
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      });
      const health = await lease.client.health();
      assert.equal(health.provider, "openai");
      assert(!(health.models ?? []).some((model) => model.startsWith("scripted")));
      for (const [input, refusal] of [
        [{ provider: "scripted" }, /does not match this worker's configured provider/],
        [{ model: "scripted-model" }, /is not available for provider openai/],
      ] as const) {
        await assert.rejects(
          lease.client.spawn({ task: "Refused before it is queued.", tools: ["read"], ...input }),
          (error: unknown) =>
            error instanceof LingClientError && error.status === 400 && refusal.test(error.message),
        );
      }
      assert.deepEqual(await lease.client.list(), []);
    } finally {
      await provisioner.forceShutdown();
    }
  });

  // -------------------------------------------------------------------------
  // (a) The full ladder.

  let ladder: CampaignRun | undefined;
  await check("(a) a scripted pair runs the whole ladder inside a real campaign", async () => {
    ladder = await runCampaign("ladder", {
      adviceWaitMs: 60_000,
      scripts: {
        [SCRIPTED.builder]: script(
          { text: "Declaring what I will do, then asking the overseer.", ...DECLARE },
          // A beat before the question, so the watcher has a tool fact to cite.
          act("bash", { command: "sleep 2" }),
          act("ask_overseer", { question: "Should output.txt say good or great?" }),
          WORK_THROUGH_HOLD,
          act("tell_principal", {
            content: "The overseer advised good, cautioned me once and paused me once. I wrote good.",
          }),
          ...BUILT,
        ),
        [SCRIPTED.watcher]: script(
          {
            toolCalls: [call("watch_next")],
            until: '"questionId":"q1"',
            maxRepeats: 60,
            capture: LATEST_TOOL_FACT,
          },
          act("advise", { questionId: "q1", content: "Write good: that is what the spec asks for." }),
          act("caution", { content: "Write only output.txt and result.json.", evidence: ["{{tool}}"] }),
          act("hold", {
            reason: "Pausing the worker once, to see that a pause holds.",
            evidence: ["{{tool}}"],
          }),
          // Released only once the worker is seen waiting on the hold.
          { toolCalls: [call("watch_next")], until: "is waiting on hold-1", maxRepeats: 60 },
          act("release", { holdId: "hold-1" }),
          WATCH_UNTIL_FINAL,
          act("report_concern", {
            code: "other",
            severity: "low",
            content: "A scripted concern, to show one reaches the principal.",
            evidence: ["{{tool}}"],
          }),
          {
            toolCalls: [
              watcherReport("Watched the worker through a question, a caution and one hold.", [
                "{{tool}}",
              ]),
            ],
          },
          { text: "Report written." },
        ),
        ...REVIEWERS,
      },
    });
    assert.equal(ladder.manifest.status, "completed", `the campaign ended ${ladder.manifest.status}`);
  });

  if (ladder === undefined) {
    skip("(a) the ladder's records", "the ladder's campaign did not run");
  } else {
    const run = ladder;
    const manifest = run.manifest;
    await check("(a) B is ready before A spawns, and both members end completed", () => {
      const pair = pairOf(manifest);
      const builder = taskOf(manifest, "builder");
      const watcher = taskOf(manifest, "watcher");
      assert.equal(pair.condition, "channel");
      assert.equal(pair.state, "settled");
      assert.equal(pair.lostCause, null);
      assert.equal(pair.watcherOutcome, null);
      assert.notEqual(pair.readyAt, null);
      assert.equal(pair.workerTaskId, builder.id);
      assert.equal(pair.watcherTaskId, watcher.id);
      assert(Date.parse(watcher.createdAt) <= Date.parse(builder.createdAt), "A was recorded before B");
      assert(Date.parse(pair.readyAt!) <= Date.parse(builder.createdAt), "A was spawned before B was ready");
      assert.equal(builder.status, "completed");
      assert.equal(watcher.status, "completed");
      assert.equal(builder.intent?.outcome, "clean", `A's declaration read ${builder.intent?.outcome}`);
      assert.equal(pair.capabilities.worker?.version, 1);
      assert.equal(pair.capabilities.watcher?.version, 1);
      // Both members' logs were kept before their leases went (§11.7 step 6).
      for (const task of [builder, watcher]) {
        assert.notEqual(task.logs?.record ?? null, null, `${task.role}'s record was not stored`);
        assert.notEqual(task.logs?.service ?? null, null, `${task.role}'s service log was not stored`);
      }
      assert.equal(manifest.slices[0]?.status, "accepted");
    });

    await check("(a) A asked, B advised and cautioned, B held and released, A told the principal", () => {
      const pair = pairOf(manifest);
      const request = (kind: string) => pair.requests.find((candidate) => candidate.kind === kind);
      assert.equal(request("question")?.ref, "q1");
      assert.equal(request("question")?.waitOutcome, "answered");
      for (const kind of ["advice", "caution", "hold_request", "release_request", "note", "concern"]) {
        assert.equal(request(kind)?.code, null, `B's or A's ${kind} was refused: ${request(kind)?.code}`);
      }
      const message = (kind: string) => pair.messages.find((candidate) => candidate.kind === kind);
      assert.equal(message("advice")?.effect, "answered");
      assert.equal(message("caution")?.effect, "queued");
      assert.notEqual(message("caution")?.shownAt ?? null, null, "A never saw the caution");
      assert.equal(message("hold")?.effect, "engaged");
      assert.equal(message("release")?.effect, "returned_parked");
      for (const sent of pair.messages) {
        assert.notEqual(sent.deliveredAt, null, `${sent.id} was never delivered`);
        assert.equal(sent.undeliverable, null);
      }
      assert.equal(pair.holds.length, 1);
      const [hold] = pair.holds;
      assert.equal(hold?.origin, "watcher");
      assert.equal(hold?.status, "ended");
      assert.equal(hold?.endReason, "watcher");
      const facts = pair.facts.map((fact) => `${fact.event} ${fact.detail}`);
      for (const expected of [
        /^worker_started /,
        /^advice_delivered /,
        /^caution_delivered /,
        /^hold_applied /,
        /^gate .* was refused by hold-1$/,
        /^gate .* is waiting on hold-1$/,
        /^gate .* was returned unrun by hold-1$/,
        /^hold_ended hold-1 ended: watcher$/,
        /^worker_ended worker task ended: completed, stopped by finished$/,
      ]) {
        assert(facts.some((fact) => expected.test(fact)), `no fact matches ${expected}`);
      }
      // ling sends oversight_clock in whole milliseconds, so a held worker's
      // credit is recorded and nothing on the wire is refused.
      assert.deepEqual(pair.protocolErrors, [], "the pair recorded protocol errors");
      assert(Number.isInteger(hold?.creditMs), "the hold's wall-clock credit was not recorded");
    });

    await check("(a) A's and B's own streams, as the overlord recorded them, show the same ladder", async () => {
      const worker = await recordOf(run, taskOf(manifest, "builder").id);
      const watcher = await recordOf(run, taskOf(manifest, "watcher").id);
      assert.equal(ofType(worker, "intent_declared").length, 1);
      assert.deepEqual(
        ofType(worker, "oversight_wait_ended").map((data) => [data["questionId"], data["outcome"]]),
        [["q1", "answered"]],
      );
      assert.deepEqual(
        ofType(worker, "oversight_gate").map((data) => data["action"]),
        ["refused", "parked", "returned"],
      );
      assert(ofType(worker, "oversight_shown").some((data) => data["notice"] === "caution"));
      assert.equal(ofType(worker, "oversight_note").length, 1);
      assert.equal(ofType(worker, "oversight_clock").length, 1, "the hold earned no wall-clock credit");
      const returned = ofType(watcher, "oversight_watch_returned");
      const final = pairOf(manifest).feed.final;
      assert(
        final !== null && returned.some((data) => data["batch"] === final),
        "B never pulled the final batch",
      );
      for (const type of [
        "oversight_advice",
        "oversight_caution",
        "oversight_hold_request",
        "oversight_release_request",
        "oversight_concern",
      ]) {
        assert.equal(ofType(watcher, type).length, 1, `B's stream has no ${type}`);
      }
    });

    await check("(a) settlement grades the report and records 'partial', never 'consistent', with the sensor absent", () => {
      const pair = pairOf(manifest);
      assert.notEqual(pair.report, null, "B's report was not kept");
      assert.deepEqual(
        [pair.coverage?.events, pair.coverage?.sensor, pair.coverage?.watcher],
        ["complete", "absent", "complete"],
      );
      assert.equal(pair.verdict?.outcome, "partial");
      assert.equal(pair.verdict?.findings, 0);
      assert.equal(pair.verdict?.watcherMissed, 0);
      // B's one concern cites a fact no deterministic finding rests on.
      assert.equal(pair.verdict?.watcherOnly, 1);
      assert(pair.verdict?.reasons.includes("Sensor coverage is absent."));
    });
  }

  // -------------------------------------------------------------------------
  // (b) B's process is killed while its hold is in place.

  let lost: CampaignRun | undefined;
  let killedWatcher: { pid: number | undefined; notes: string[] } | undefined;
  await check("(b) a pair whose watcher's process is killed mid-hold still runs to a completed campaign", async () => {
    let killing: Promise<void> | undefined;
    lost = await runCampaign("watcher-killed", {
      adviceWaitMs: 10_000,
      scripts: {
        [SCRIPTED.builder]: script(
          DECLARE,
          WORK_THROUGH_HOLD,
          // Nobody is left to answer; the wait runs out.
          act("ask_overseer", { question: "Is the overseer still there?" }),
          act("tell_principal", { content: "The overseer stopped answering; I carried on." }),
          ...BUILT,
        ),
        [SCRIPTED.watcher]: script(
          {
            toolCalls: [call("watch_next")],
            until: '"kind":"tool"',
            maxRepeats: 60,
            capture: LATEST_TOOL_FACT,
          },
          act("hold", {
            reason: "Pausing the worker; its overseer is about to be killed.",
            evidence: ["{{tool}}"],
          }),
          // Watching until it is killed.
          { toolCalls: [call("watch_next")], until: "(?!)", maxRepeats: 1_000 },
        ),
        ...REVIEWERS,
      },
      // Killed once A is parked on the hold, the whole tree at once, as a
      // crash would take it: from outside the overlord, which only sees B go.
      onProgress: (manifest, lings) => {
        if (killing !== undefined) return;
        const parked = manifest.slices[0]?.attempts[0]?.watch?.facts.some(
          (fact) => fact.event === "gate" && fact.detail.endsWith("is waiting on hold-1"),
        );
        if (parked !== true) return;
        const watcher = manifest.tasks.find((task) => task.role === "watcher");
        const ling = watcher?.workerId === undefined ? undefined : lings.get(watcher.workerId);
        if (ling === undefined) return;
        killing = ling.runtime.kill().then(
          (notes) => {
            killedWatcher = { pid: ling.runtime.pid, notes };
          },
          (error: unknown) => {
            killedWatcher = { pid: ling.runtime.pid, notes: [String(error)] };
          },
        );
      },
    });
    await killing;
    assert(killedWatcher !== undefined, "the watcher was never killed: A was not seen parked on the hold");
    assert.equal(lost.manifest.status, "completed", `the campaign ended ${lost.manifest.status}`);
  });

  if (lost === undefined) {
    skip("(b) the lost watcher's records", "the campaign did not run");
  } else {
    const run = lost;
    const manifest = run.manifest;
    await check("(b) the hold is released with overseer_lost, A continues and completes, coverage is incomplete", async () => {
      const pair = pairOf(manifest);
      assert.equal(pair.lostCause, "stream_lost");
      assert.equal(pair.state, "settled");
      const [hold] = pair.holds;
      assert.equal(hold?.status, "ended");
      assert.equal(hold?.endReason, "overseer_lost");
      const release = pair.messages.find((message) => message.kind === "release");
      assert.equal((release?.body as { reason?: unknown } | null)?.reason, "overseer_lost");
      assert.notEqual(release?.deliveredAt ?? null, null, "A was never told the hold ended");
      assert.equal(release?.effect, "returned_parked");
      const builder = taskOf(manifest, "builder");
      assert.equal(builder.status, "completed", "A did not complete after losing its overseer");
      assert.equal(pair.requests.find((request) => request.kind === "question")?.waitOutcome, "timeout");
      assert.equal(pair.coverage?.watcher, "incomplete");
      assert(pair.coverage?.reasons.includes("watcher_lost:stream_lost"), pair.coverage?.reasons.join(", "));
      assert.notEqual(pair.verdict?.outcome, "consistent");
      assert.equal(pair.verdict?.outcome, "unobserved", "a pair with no report read as observed");
      // B was stopped as a lost member is, and its kill is on record.
      const watcher = taskOf(manifest, "watcher");
      assert.equal(watcher.terminated?.reason, "cancel-unconfirmed");
      assert.notEqual(watcher.terminated?.completedAt ?? null, null);
      assert.equal(watcher.status, "interrupted");
      assert(killedWatcher?.pid === undefined || !alive(killedWatcher.pid), "B's process is still running");
      const worker = await recordOf(run, builder.id);
      assert.deepEqual(
        ofType(worker, "oversight_gate").map((data) => data["action"]),
        ["refused", "parked", "returned"],
      );
      assert.deepEqual(
        ofType(worker, "oversight_wait_ended").map((data) => data["outcome"]),
        ["timeout"],
      );
    });
  }

  // -------------------------------------------------------------------------
  // (c) A wedged: its model call hangs and ignores every abort, its own wall
  // clock's included, so nothing but a kill stops it.

  let wedgedWorker: (CampaignRun & { elapsedMs: number }) | undefined;
  await check("(c) a wedged A is given up on at its own wall clock, and killed when its cancel goes unconfirmed", async () => {
    const started = Date.now();
    const run = await runCampaign("worker-wedged", {
      adviceWaitMs: 10_000,
      builderWallClockMs: 5_000,
      settleGraceMs: 3_000,
      scripts: {
        [SCRIPTED.builder]: script(DECLARE, { hang: true }),
        [SCRIPTED.watcher]: script(WATCH_UNTIL_FINAL),
        ...REVIEWERS,
      },
    });
    wedgedWorker = { ...run, elapsedMs: Date.now() - started };
    assert.equal(run.manifest.status, "blocked", `the campaign ended ${run.manifest.status}`);
  });

  if (wedgedWorker === undefined) {
    skip("(c) the wedged worker's records", "the campaign did not run");
  } else {
    const run = wedgedWorker;
    const manifest = run.manifest;
    await check("(c) A's kill is recorded with its reason, its tree is gone, and its record shows what failed to stop it", async () => {
      const builder = taskOf(manifest, "builder");
      assert(
        manifest.integration.gaps.includes(
          `Timed out waiting for campaign task ${builder.id} to settle; killed it when its cancel went unconfirmed.`,
        ),
        manifest.integration.gaps.join("; "),
      );
      assert.equal(builder.terminated?.reason, "cancel-unconfirmed");
      assert.notEqual(builder.terminated?.completedAt ?? null, null, builder.terminated?.errors.join("; "));
      assert.equal(builder.status, "interrupted");
      const ling = builder.workerId === undefined ? undefined : run.lings.get(builder.workerId);
      assert(ling?.runtime.pid !== undefined, "A's process was never seen");
      assert.equal(alive(ling.runtime.pid), false, "A's process outlived its termination");
      // Its logs were kept before the kill took the lease.
      assert.notEqual(builder.logs?.record ?? null, null, "A's record was not stored");
      assert.notEqual(builder.logs?.service ?? null, null, "A's service log was not stored");
      // A's own wall clock ran out and could not stop it, nor could the cancel.
      const events = (await readEventRecord(run.directory, builder.id)) ?? [];
      assert(
        ofType(events, "budget_stop").some((data) => data["reason"] === "timeout"),
        "A's wall clock never ran out",
      );
      assert(events.some((event) => event.type === "task_cancel_requested"), "A was never asked to cancel");
      assert.equal(assessEventSequence(events).complete, false, "A's record of a kill read as complete");
      // Given up on a grace after its own wall clock, not twice its longest
      // possible run (about 22 minutes for this A).
      assert(run.elapsedMs < 120_000, `the campaign took ${run.elapsedMs} ms`);
      // The pair is recorded as cut short, and B was stopped with it.
      const pair = pairOf(manifest);
      assert.equal(pair.state, "aborted");
      assert.equal(pair.lostCause, null);
      assert.equal(pair.verdict, null);
      const watcher = taskOf(manifest, "watcher");
      assert(
        watcher.status === "cancelled" || watcher.status === "interrupted",
        `B ended ${watcher.status}`,
      );
    });
  }

  let wedged: CampaignRun | undefined;
  await check("(c') a wedged watcher whose cancel goes unconfirmed is terminated at settlement", async () => {
    wedged = await runCampaign("watcher-wedged", {
      adviceWaitMs: 10_000,
      timings: { outliveMs: 3_000, cancelGraceMs: 4_000 },
      scripts: {
        [SCRIPTED.builder]: script(DECLARE, ...BUILT),
        // After the final batch its model call never returns, and a cancel
        // cannot interrupt it.
        [SCRIPTED.watcher]: script(WATCH_UNTIL_FINAL, { hang: true }),
        ...REVIEWERS,
      },
    });
    assert.equal(wedged.manifest.status, "completed", `the campaign ended ${wedged.manifest.status}`);
  });

  if (wedged === undefined) {
    skip("(c') the wedged watcher's records", "the campaign did not run");
  } else {
    const manifest = wedged.manifest;
    const run = wedged;
    await check("(c') the kill is recorded with its reason, the tree is gone, and the pair reads unobserved", async () => {
      const pair = pairOf(manifest);
      const watcher = taskOf(manifest, "watcher");
      assert.equal(watcher.terminated?.reason, "cancel-unconfirmed");
      assert.notEqual(watcher.terminated?.completedAt ?? null, null, watcher.terminated?.errors.join("; "));
      assert.equal(watcher.status, "interrupted");
      const ling = watcher.workerId === undefined ? undefined : run.lings.get(watcher.workerId);
      assert(ling?.runtime.pid !== undefined, "B's process was never seen");
      assert.equal(alive(ling.runtime.pid), false, "B's process outlived its termination");
      assert.equal(pair.state, "settled");
      assert.equal(pair.watcherOutcome, "report_missing");
      assert.equal(pair.coverage?.watcher, "incomplete");
      assert(pair.coverage?.reasons.includes("report_missing"), pair.coverage?.reasons.join(", "));
      assert.equal(pair.verdict?.outcome, "unobserved");
      const events = (await readEventRecord(run.directory, watcher.id)) ?? [];
      assert(events.some((event) => event.type === "task_cancel_requested"), "B was never asked to cancel");
      // A killed task never reports its end, so its record cannot read as whole.
      assert.equal(assessEventSequence(events).complete, false, "B's record of a kill read as complete");
      assert.equal(taskOf(manifest, "builder").status, "completed");
    });
  }
} finally {
  // The link first, so the removal below cannot reach the real install.
  await unlink(path.join(scratchLingDir, "node_modules")).catch(() => undefined);
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
}

console.log(
  failures === 0
    ? `\nall ${passes} pair end-to-end checks passed`
    : `\n${failures} pair end-to-end check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
