/**
 * The phases that run real scripted campaigns through `runPlannedRun` (W3-A
 * plan §4.2): `smoke`, fixture (q)'s plain A as L1, as R-control (scripted
 * B) and as L3 (B a scripted-model ling), with every record the scorer reads
 * checked; and `regressions`, a hanging A killed and recorded (B14) and one
 * A per run when the first builder's summon fails (§1.2 item 4). The smoke
 * phase also runs fixture (c) once to count the turns its wait for a hold's
 * release takes (§3.1 C4). And `canary` (§4.3, B7): fixture (p) as L0h,
 * alone, with its canary searched for in every place the run's data
 * persists, before and after release.
 *
 * Every child is scripted and nothing is spent. The scratch ling directory's
 * junction is the check's to unlink, before the scratch is removed.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readEventRecord } from "../../campaign/event-record.js";
import type { CampaignManifest } from "../../campaign/schema.js";
import { MAX_TASKS, OFFLINE_PROVIDERS } from "../../experiment/compose.js";
import type { CaptureHooks } from "../../experiment/capture.js";
import { CANARY, SCORER_FIXTURES, type ScorerFixture } from "../../experiment/fixtures/index.js";
import { script } from "../../experiment/fixtures/types.js";
import {
  MODEL_RESPONSE_EVENT,
  parseExperimentJson,
  parseFinalStateRecord,
  promptDigestKey,
  type ArmId,
  type ScenarioVariant,
} from "../../experiment/records.js";
import { scoreRun, type ScoreJson } from "../../experiment/score/index.js";
import { computeExclusion, loadRunRecords } from "../../experiment/score/index.js";
import { EVENT_COVERAGE_FILE, finalizeRun, type EventCoverage } from "../../experiment/run.js";
import {
  exists,
  offlineContext,
  offlineRun,
  readJsonFile,
  readTraces,
  runOffline,
  type LingScratch,
  type OfflineRun,
  type PhaseContext,
} from "./support.js";

/** Every field protocol §2.5 gives `experiment.json` (W1-D `records.ts`). */
export const EXPERIMENT_FIELDS = [
  "version", "batchId", "runId", "experiment", "cell", "arm", "scenario", "variant", "prompted",
  "rep", "rerunOf", "a", "b", "limits", "minBatchIntervalMs", "maxRounds", "maxTasks", "brain",
  "lingSettings", "instrument", "manifestSha256", "promptDigest", "child", "approval", "campaign",
  "tasks", "workspaceDir", "started", "ended", "cost", "served", "outcome",
] as const;

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

export function fixture(id: string): ScorerFixture {
  const found = SCORER_FIXTURES.find((entry) => entry.id === id);
  assert(found !== undefined, `no fixture ${id}`);
  return found;
}

/** A dotted path into a score, as experiment-score-check reads one. */
function at(value: unknown, dotted: string): unknown {
  let current = value;
  for (const segment of dotted.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A workspace under the default runtime root (F24), as `os.tmpdir()` or its
 * real path spells it; case-insensitively on Windows (§3.1 C21).
 */
export function workspacePattern(): RegExp[] {
  const roots = [...new Set([os.tmpdir(), realpathSync.native(os.tmpdir())])];
  const flags = process.platform === "win32" ? "i" : "";
  return roots.map(
    (root) =>
      new RegExp(
        `^${escape(root)}[\\\\/]ling-overlord-workers[\\\\/]local-[0-9a-f-]{36}-\\w{6}` +
          `[\\\\/]workspaces[\\\\/][^\\\\/]+$`,
        flags,
      ),
  );
}

export function assertWorkspace(dir: string, what: string): void {
  assert(workspacePattern().some((pattern) => pattern.test(dir)), `${what} ${dir} is not a neutral workspace`);
}

export function modelResponses(events: readonly { type: string }[] | undefined): number {
  return (events ?? []).filter((event) => event.type === MODEL_RESPONSE_EVENT).length;
}

/** The pinned task budget of the run's condition (§3.1 C8). */
export function pinnedMaxTasks(run: OfflineRun): number {
  return MAX_TASKS[run.composed.arm.condition === "no_watcher" ? "no_watcher" : "channel"];
}

export function builderIds(manifest: CampaignManifest): string[] {
  return manifest.tasks.filter((task) => task.role === "builder").map((task) => task.id);
}

/** Runs `tasks` at most `concurrency` at a time, in order. */
export async function pool<T>(concurrency: number, tasks: readonly (() => Promise<T>)[]): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length)) }, async () => {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await tasks[index]!();
    }
  });
  await Promise.all(lanes);
  return results;
}

/** The context a smoke run is scored in: its own digest registered (digest agreement is WP3's). */
function selfContext(run: OfflineRun) {
  const digest = run.experiment.promptDigest;
  assert.match(digest ?? "", /^[0-9a-f]{64}$/, "the run recorded no prompt digest");
  return offlineContext({ [promptDigestKey(run.experiment.arm, run.experiment.prompted)]: digest! });
}

/** What every completed smoke run must hold (§4.2's smoke asserts). */
async function assertRunRecords(run: OfflineRun, resultBytes: string, modelB: boolean): Promise<void> {
  const { runDir, manifest, experiment } = run;
  assert(await exists(path.join(runDir, "manifest.json")), "no manifest.json");
  const builders = builderIds(manifest);
  assert.equal(builders.length, 1, `${builders.length} builder tasks`);
  const aEvents = await readEventRecord(runDir, builders[0]!);
  assert(aEvents !== undefined && aEvents.length > 0, "A has no EventRecord");
  const finalState = parseFinalStateRecord(await readJsonFile(path.join(runDir, "final-state.json")));
  const raw = await readFile(path.join(runDir, "result.raw"), "utf8");
  assert.equal(raw, resultBytes, "result.raw is not the bytes A wrote");
  assert.equal(finalState.result.sha256, sha256(resultBytes), "the record's result sha256");
  assert(await exists(path.join(runDir, "builder-task.json")), "no builder-task.json");
  let bResponses = 0;
  if (modelB) {
    const watcher = (await readJsonFile(path.join(runDir, "watcher-task.json"))) as { prompt?: unknown };
    assert.equal(typeof watcher.prompt, "string", "watcher-task.json has no prompt");
    assert(experiment.tasks.watcherId !== null, "no watcher id");
    bResponses = modelResponses(await readEventRecord(runDir, experiment.tasks.watcherId));
    assert(bResponses > 0, "B's ling made no model call");
  }
  const coverage = (await readJsonFile(path.join(runDir, EVENT_COVERAGE_FILE))) as EventCoverage[];
  assert.deepEqual(
    coverage.map((entry) => [entry.side, entry.complete]),
    modelB ? [["a", true], ["b", true]] : [["a", true]],
    "served was not built from whole records",
  );
  const parsed = parseExperimentJson(await readJsonFile(path.join(runDir, "experiment.json")));
  for (const field of EXPERIMENT_FIELDS) {
    assert(Object.hasOwn(parsed, field), `experiment.json has no ${field}`);
  }
  for (const key of ["workspaceDir", "workspaceDirReal", "home", "tmp", "userProfile"] as const) {
    assert.notEqual(parsed.child[key], "", `child.${key} is empty`);
  }
  assert.equal(parsed.child.runtimeRemoved, true, "a lease runtime directory was left");
  assert.equal(parsed.served.length, modelResponses(aEvents) + bResponses, "served is not one per call");
  assert.equal(parsed.maxRounds, 1);
  assert.equal(parsed.maxTasks, pinnedMaxTasks(run));
  assert.equal(manifest.maxRounds, 1);
  assert.equal(manifest.budget.maxTasks, parsed.maxTasks);
  assert(manifest.tasks.length <= parsed.maxTasks, `${manifest.tasks.length} tasks ran`);
  assertWorkspace(parsed.child.workspaceDir, "workspaceDir");
  assertWorkspace(parsed.child.workspaceDirReal, "workspaceDirReal");
  for (const lease of run.leases) {
    assert.equal(await exists(lease.runtimeDir), false, `lease ${lease.workerId} left ${lease.runtimeDir}`);
  }
  assert.equal(parsed.outcome.status, "included", `excluded: ${String(parsed.outcome.reason)}`);
}

/** The score's dotted paths against a fixture's declared fields. */
function assertExpected(score: ScoreJson, expected: Record<string, unknown>): void {
  const wrong = Object.entries(expected)
    .filter(([dotted, value]) => !Object.is(at(score, dotted), value))
    .map(([dotted, value]) => `${dotted}: ${JSON.stringify(at(score, dotted))}, not ${JSON.stringify(value)}`);
  assert.deepEqual(wrong, []);
}

interface SmokeCase {
  label: string;
  arm: ArmId;
  variant: ScenarioVariant;
}

const SMOKE: readonly SmokeCase[] = [
  { label: "L1 D1", arm: "L1", variant: "D1" },
  { label: "R-control R (scripted B)", arm: "R-control", variant: "R" },
  { label: "L3 D1 (B a scripted-model ling)", arm: "L3", variant: "D1" },
];

/** A run that threw is a failed check, not an aborted phase. */
export async function attempt<T>(run: () => Promise<T>): Promise<T | Error> {
  try {
    return await run();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

export function took(run: { elapsedMs: number }): string {
  return `${(run.elapsedMs / 1000).toFixed(1)} s`;
}

export async function smokePhase(context: PhaseContext): Promise<void> {
  const { report } = context;
  const ling = await context.ling();
  const root = path.join(context.scratch, "smoke");
  const q = fixture("q");
  const c = fixture("c");
  const runs = await pool(context.concurrency, [
    ...SMOKE.map((entry) => () =>
      attempt(() =>
        runOffline({
          ling,
          root,
          batchId: "e2e-smoke",
          run: offlineRun(entry.arm, entry.variant),
          script: q.script,
          context: null,
        }),
      ),
    ),
    () =>
      attempt(() =>
        runOffline({
          ling,
          root,
          batchId: "e2e-smoke",
          run: offlineRun(c.arm, c.variant),
          script: c.script,
          context: null,
        }),
      ),
  ]);

  for (const [index, entry] of SMOKE.entries()) {
    const run = runs[index]!;
    await report.check(`smoke ${entry.label}: fixture (q) runs, and every record the scorer reads is there`, async () => {
      if (run instanceof Error) throw run;
      console.log(`      ${entry.label}: ${took(run)}, ${run.manifest.tasks.length} task(s), campaign ${run.manifest.status}`);
      const scored = await finalizeWithOwnDigest(run);
      await assertRunRecords(scored, q.resultBytes!, entry.arm === "L3");
      if (entry.arm === "L1") {
        assertExpected(await scoreRun(run.runDir, selfContext(run)), q.expected);
      }
    });
    await report.check(`smoke ${entry.label}: served counts each scripted call once as served-unknown (C7)`, async () => {
      if (run instanceof Error) throw run;
      const score = await scoreRun(run.runDir, selfContext(run));
      assert.equal(score.attrition.servedUnknown, run.experiment.served.length);
    });
  }

  const measured = runs[SMOKE.length]!;
  await report.check("smoke fixture (c) as R-intervened: the turns its wait for the hold's release takes (C4)", async () => {
    if (measured instanceof Error) throw measured;
    const builder = builderIds(measured.manifest)[0];
    assert(builder !== undefined, "no builder task");
    const events = (await readEventRecord(measured.runDir, builder)) ?? [];
    const traced = (await readTraces(measured.traceDir, OFFLINE_PROVIDERS.builder)).length;
    const score = await scoreRun(measured.runDir, selfContext(measured));
    console.log(
      `      fixture (c): ${modelResponses(events)} model call(s) of A's 30 (trace ${traced}), ` +
        `stopped by ${String(score.attrition.stoppedBy)}, ${took(measured)}`,
    );
    // C8: a crm run that reaches integration fits the pinned budget exactly.
    const roles = measured.manifest.tasks.map((task) => task.role);
    console.log(`      fixture (c): tasks ${roles.join(", ")}, campaign ${measured.manifest.status}`);
    assert(roles.length <= pinnedMaxTasks(measured), `${roles.length} tasks ran`);
    assert.notEqual(score.attrition.stoppedBy, "max_turns", "A ran out of turns before the hold ended");
    // The fields read from probes.json wait on WP4's probes.
    const fromProbes = Object.keys(c.expected).filter((field) => PROBE_FIELDS.has(field));
    if (fromProbes.length > 0) console.log(`      not compared until the probes run: ${fromProbes.join(", ")}`);
    assertExpected(
      score,
      Object.fromEntries(Object.entries(c.expected).filter(([field]) => !PROBE_FIELDS.has(field))),
    );
  });
}

/** Score fields read from probes.json, which WP4 writes. */
const PROBE_FIELDS = new Set(["crm.completed", "ledger.testsPass", "ledger.p2", "ledger.chargesZeroWeight"]);

/** The run's outcome from the exclusion rules, its own digest registered. */
async function finalizeWithOwnDigest(run: OfflineRun): Promise<OfflineRun> {
  const records = await loadRunRecords(run.runDir);
  const exclusion = computeExclusion(records, selfContext(run));
  const reasons = exclusion.reasons.map((entry) => `${entry.reason} (${entry.detail})`);
  assert.deepEqual(reasons, [], "the run is excluded");
  const final = await finalizeRun(run.runDir, run.experiment, selfContext(run));
  return { ...run, final };
}

/** B14's hanging A: its one model call never returns, so only a kill ends it. */
const HANGING_A = script({ hang: true });

/** Each run's exclusion reasons, under a context with no digest registered. */
async function reasonsOf(run: OfflineRun): Promise<string[]> {
  const exclusion = computeExclusion(await loadRunRecords(run.runDir), offlineContext({}));
  return exclusion.reasons.map((entry) => entry.reason);
}

export async function regressionsPhase(context: PhaseContext): Promise<void> {
  const { report } = context;
  const ling = await context.ling();
  const root = path.join(context.scratch, "regressions");
  const q = fixture("q");
  const one = (arm: ArmId, variant: ScenarioVariant) => () =>
    attempt(() =>
      runOffline({
        ling,
        root,
        batchId: "e2e-one-a",
        run: offlineRun(arm, variant),
        script: q.script,
        faults: { failFirstBuilderSummon: true },
        context: offlineContext({}),
      }),
    );
  const [hung, oneL1, oneR] = (await pool(context.concurrency, [
    () =>
      attempt(() =>
        runOffline({
          ling,
          root,
          batchId: "e2e-b14",
          run: offlineRun("R-control", "R"),
          script: HANGING_A,
          limitsOverride: { aMaxWallClockMs: 60_000, settleGraceMs: 3_000 },
          context: offlineContext({}),
        }),
      ),
    one("L1", "D1"),
    one("R-control", "R"),
  ])) as [OfflineRun | Error, OfflineRun | Error, OfflineRun | Error];

  await report.check("B14: a hanging A under the offline override is killed, and the run is recorded", async () => {
    if (hung instanceof Error) throw hung;
    console.log(`      B14: ${took(hung)}, campaign ${hung.manifest.status}`);
    const builder = hung.manifest.tasks.find((task) => task.role === "builder");
    assert(builder !== undefined, "no builder task");
    assert.equal(builder.terminated?.reason, "cancel-unconfirmed");
    // The provisioner confirmed the process tree gone before it set this.
    assert.notEqual(builder.terminated?.completedAt ?? null, null, builder.terminated?.errors.join("; "));
    assert.equal(hung.experiment.child.runtimeRemoved, true, "a lease runtime directory was left");
    for (const lease of hung.leases) assert.equal(await exists(lease.runtimeDir), false, lease.runtimeDir);
    const captured = hung.captures.find((entry) => entry.role === "builder");
    assert.equal(captured?.via, "terminated");
    assert.equal(await exists(path.join(hung.runDir, "final-state.json")), false);
    parseExperimentJson(await readJsonFile(path.join(hung.runDir, "experiment.json")));
    assert.equal(hung.final.outcome.status, "excluded");
    const reasons = await reasonsOf(hung);
    for (const reason of ["events_incomplete", "instrument_missing:final_state"]) {
      assert(reasons.includes(reason), `reasons ${reasons.join(", ")} lack ${reason}`);
    }
    // A wall clock of 60 s and a grace of 3 s, not twice A's longest run.
    assert(hung.elapsedMs < 180_000, `the run took ${took(hung)}`);
  });

  for (const [label, run] of [
    ["L1 (no watcher; the driver may retry in the round)", oneL1],
    ["R-control (B already spawned; the pair records the failure)", oneR],
  ] as const) {
    await report.check(`one A per run when the first builder summon fails: ${label}`, async () => {
      if (run instanceof Error) throw run;
      const builders = builderIds(run.manifest);
      const builderLeases = run.leases.filter((lease) => lease.role === "builder").length;
      console.log(
        `      ${run.experiment.arm}: ${builders.length} builder task(s), ${builderLeases} builder summon(s), ` +
          `campaign ${run.manifest.status}, ${took(run)}`,
      );
      assert(builders.length <= 1, `${builders.length} builder tasks ran`);
      assert.equal(run.manifest.maxRounds, 1);
      assert.equal(run.experiment.maxTasks, pinnedMaxTasks(run));
      const reasons = await reasonsOf(run);
      if (builders.length === 0) {
        assert(reasons.includes("builder_count"), `reasons ${reasons.join(", ")} lack builder_count`);
      }
      if (run.composed.arm.condition === "channel") {
        const pair = run.manifest.slices[0]?.attempts[0]?.watch;
        assert.equal(pair?.outcome ?? null, "worker_spawn_failed");
        assert(reasons.includes("worker_spawn_failed"), reasons.join(", "));
      }
      assert.equal(run.experiment.child.runtimeRemoved, true);
    });
  }
}

// ---------------------------------------------------------------------------
// canary: fixture (p) as L0h (B7, §1.2 item 6)

/** The canary as bytes, in UTF-8 and in UTF-16LE (how a Windows tool might write it). */
const CANARY_FORMS = [Buffer.from(CANARY, "utf8"), Buffer.from(CANARY, "utf16le")];

/**
 * Every regular file under `dir`. A link is never followed: junctions,
 * `node_modules` and `browsers` in a lease included, which lead to the real
 * install. `skip` takes a path relative to `dir`, with forward slashes.
 */
async function filesUnder(dir: string, skip: (relative: string) => boolean = () => false): Promise<string[]> {
  const found: string[] = [];
  const walk = async (current: string, relative: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const rel = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (skip(rel) || entry.isSymbolicLink()) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full, rel);
      else if (entry.isFile()) found.push(full);
    }
  };
  await walk(dir, "");
  return found;
}

/** The files whose bytes hold the canary. */
async function canaryHits(files: Iterable<string>): Promise<string[]> {
  const hits: string[] = [];
  for (const file of files) {
    const bytes = await readFile(file).catch(() => null);
    if (bytes !== null && CANARY_FORMS.some((form) => bytes.includes(form))) hits.push(file);
  }
  return hits;
}

/** Pi's bash output files in a temp directory. */
async function piBashLogs(dir: string): Promise<Set<string>> {
  const names = await readdir(dir).catch(() => [] as string[]);
  return new Set(names.filter((name) => /^pi-bash-.*\.log$/.test(name)).map((name) => path.join(dir, name)));
}

interface LeaseSearch {
  runtimeDir: string;
  searched: string[];
  hits: string[];
  /** Pi's bash output files in the lease's tmp/, and how many hold the canary: where it went. */
  tmpPiBash: number;
  tmpPiBashCanary: number;
}

/** A lease's top-level entries the search before release leaves out: A's scratch, and the junctions. */
const LEASE_UNSEARCHED = new Set(["tmp", "node_modules", "browsers"]);

export async function canaryPhase(context: PhaseContext): Promise<void> {
  const { report } = context;
  const ling = await context.ling();
  const root = path.join(context.scratch, "canary");
  const p = fixture("p");
  const hostTmp = os.tmpdir();
  const piBashBefore = await piBashLogs(hostTmp);
  const before: LeaseSearch[] = [];
  const beforeErrors: string[] = [];
  // Before release, what the overlord can read from the lease: tasks.db, the
  // event log and the workspace. Its tmp/ is A's scratch, and goes with it.
  const hooks: CaptureHooks = {
    async beforeRelease(captured) {
      if (captured.role !== "builder") return;
      const runtimeDir = captured.runtimePaths?.runtimeDir;
      if (runtimeDir === undefined) {
        beforeErrors.push(`no runtime directory for ${captured.taskId}`);
        return;
      }
      const searched = await filesUnder(runtimeDir, (rel) => LEASE_UNSEARCHED.has(rel));
      const tmpLogs = await piBashLogs(path.join(runtimeDir, "tmp"));
      before.push({
        runtimeDir,
        searched,
        hits: await canaryHits(searched),
        tmpPiBash: tmpLogs.size,
        tmpPiBashCanary: (await canaryHits(tmpLogs)).length,
      });
    },
  };
  const run = await attempt(() =>
    runOffline({
      ling,
      root,
      batchId: "e2e-canary",
      run: offlineRun(p.arm, p.variant),
      script: p.script,
      captureHooks: hooks,
      keepPiAgentDir: true,
      context: null,
    }),
  );
  try {
    await report.check("canary (p) before release: none in the lease (tasks.db, the event log, the workspace)", () => {
      if (run instanceof Error) throw run;
      console.log(`      canary run: ${took(run)}, campaign ${run.manifest.status}`);
      assert.deepEqual(beforeErrors, []);
      assert.equal(before.length, 1, `${before.length} builder lease(s) searched before release`);
      const lease = before[0]!;
      const names = lease.searched.map((file) => path.basename(file));
      const builder = builderIds(run.manifest)[0];
      assert(names.includes("tasks.db"), "the search did not reach tasks.db");
      assert(builder !== undefined && names.includes(`${builder}.jsonl`), "the search did not reach the event log");
      console.log(
        `      before release: ${lease.searched.length} file(s) in the lease searched; its tmp/ (not searched) ` +
          `held ${lease.tmpPiBash} pi-bash log(s), ${lease.tmpPiBashCanary} with the canary`,
      );
      // The positive control: A's bash call ran, and its output, over Pi's
      // inline limit, carried the canary into the lease's tmp/.
      assert(lease.tmpPiBashCanary >= 1, "no pi-bash log in the lease's tmp/ holds the canary: the call never ran");
      assert.deepEqual(lease.hits, [], "the canary is in the lease");
    });
    await report.check(
      "canary (p) after release: none in the run, the Pi agent directory, crashes.json or host temp; the lease is gone",
      async () => {
        if (run instanceof Error) throw run;
        // The fixture's own script carries the canary in its command; it alone is left out.
        const scriptFile = `scripts/${OFFLINE_PROVIDERS.builder}.json`;
        assert(await exists(path.join(run.runDir, scriptFile)), "the fixture script was not kept");
        const runFiles = await filesUnder(run.runDir, (rel) => rel === scriptFile);
        const agentFiles = await filesUnder(run.piAgentDir);
        const userCrashes = path.join(os.homedir(), ".pi", "agent", "crashes.json");
        const piBashAfter = await piBashLogs(hostTmp);
        const searched = [
          ...runFiles,
          ...agentFiles,
          ...((await exists(userCrashes)) ? [userCrashes] : []),
          ...piBashAfter,
        ];
        console.log(
          `      after release: ${runFiles.length} run file(s), ${agentFiles.length} Pi agent file(s), ` +
            `${piBashAfter.size} pi-bash log(s) in host temp searched`,
        );
        assert.deepEqual(await canaryHits(searched), [], "the canary persisted");
        const added = [...piBashAfter].filter((file) => !piBashBefore.has(file));
        assert.deepEqual(added, [], "a pi-bash log appeared in host temp");
        for (const lease of run.leases) {
          assert.equal(await exists(lease.runtimeDir), false, `lease ${lease.workerId} left ${lease.runtimeDir}`);
        }
        assert.equal(run.experiment.child.runtimeRemoved, true);
        const builderLease = before[0]?.runtimeDir;
        assert(builderLease !== undefined, "the builder's lease was never seen");
        assert.equal(await exists(path.join(builderLease, "tmp")), false, "the lease's tmp/ is left");
      },
    );
    await report.check("canary (p): coverage complete; notes, assistant text and the result kept; no tool event", async () => {
      if (run instanceof Error) throw run;
      const builder = builderIds(run.manifest)[0];
      assert(builder !== undefined, "no builder task");
      const events = (await readEventRecord(run.runDir, builder)) ?? [];
      const coverage = (await readJsonFile(path.join(run.runDir, EVENT_COVERAGE_FILE))) as EventCoverage[];
      assert.deepEqual(coverage.map((entry) => [entry.side, entry.complete]), [["a", true]]);
      const types = new Set(events.map((event) => event.type));
      console.log(`      A's record: ${events.length} event(s) of ${[...types].sort().join(", ")}`);
      assert(!types.has("tool_start") && !types.has("tool_end"), "A's record has a tool event");
      assert(types.has("oversight_note"), "A's note was not kept");
      assert(types.has("assistant_text"), "A's text was not kept");
      assert.equal(await readFile(path.join(run.runDir, "result.raw"), "utf8"), p.resultBytes, "the result");
      const digests = context.promptDigests ?? {
        [promptDigestKey(run.experiment.arm, run.experiment.prompted)]: run.experiment.promptDigest ?? "",
      };
      const score = await scoreRun(run.runDir, offlineContext(digests));
      assertExpected(
        score,
        Object.fromEntries(Object.entries(p.expected).filter(([field]) => !PROBE_FIELDS.has(field))),
      );
    });
  } finally {
    if (!(run instanceof Error)) {
      await rm(run.piAgentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
}
