/**
 * One planned run, end to end (pilot build plan B2's second half): composed
 * into one single-slice campaign, run by the real CampaignDriver on local-task
 * children, its tasks captured before their leases go, and its run directory
 * written: the campaign's manifest and EventRecords, `final-state.json`,
 * `result.raw`, the task snapshots and `experiment.json`. Both the $0
 * end-to-end check (offline, every child scripted) and W4-A's harness (paid
 * and rehearsal) start runs only through `runPlannedRun`, so the refusals
 * below repeat W4-A's preflight on purpose.
 *
 * The provisioner runs on its default, neutral runtime root (F24), never
 * under the run directory, whose path would name the run to A. Every run has
 * a fresh Pi agent directory. `beforePost` sees every child before a task is
 * posted to it: offline it asserts the child is the role's scripted provider,
 * paid it compares an openrouter child's resolved model with the batch's pin
 * and refuses a mismatch, so that nothing is spent on the wrong model.
 *
 * `finalizeRun` sets the outcome from W1-D's exclusion rules, and from
 * `event-coverage.json` for the EventRecords the scorer does not judge (a
 * model B's). It reads only the reasons, never the contamination verdict's
 * inner shape.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { access, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { CampaignArtifactStore } from "../campaign/artifacts.js";
import { CampaignDriver, type CampaignLingClient } from "../campaign/driver.js";
import { assessEventSequence, readEventRecord } from "../campaign/event-record.js";
import { initializeCampaign } from "../campaign/initialize.js";
import { CampaignManifestStore } from "../campaign/manifest.js";
import { workerMaxRunMs } from "../campaign/oversight.js";
import { withScriptedWatcher } from "../campaign/oversight-scripted.js";
import type { CampaignManifest } from "../campaign/schema.js";
import { bootstrapLing } from "../ling/bootstrap.js";
import {
  defaultRuntimeDirectoryFactory,
  LocalTaskProvisioner,
  readLingSettings,
  type LingBootstrapFactory,
  type LocalBeforePostHook,
} from "../ling/local-provisioner.js";
import { ProvisionedLingClient, resolvedWorkerProfileFromSpawnInput } from "../ling/provisioner.js";
import type { LingEvent, LingResolvedModel } from "../ling/types.js";
import {
  capturedBuilder,
  childPathsFrom,
  requestKeyRole,
  servedCalls,
  withCapture,
  writeCaptures,
  type CaptureHooks,
  type CapturedTask,
} from "./capture.js";
import {
  composeRun,
  type ComposeInput,
  type ComposedRole,
  type ComposedRun,
  type ModelPin,
  type RunMode,
} from "./compose.js";
import type { BatchModel, BatchRun, ExperimentApproval, ExperimentJson } from "./records.js";
import { EXCLUSION_REASONS, type ExclusionReason } from "./score/exclusion.js";
import { computeExclusion, loadRunRecords } from "./score/index.js";
import type { ScoreContext } from "./score/types.js";
import { scriptedWatcherOptions } from "./watcher-scripts.js";

export interface PlannedRunInput {
  run: BatchRun;
  batchId: string;
  runsDir: string;
  mode: RunMode;
  models: { a: ModelPin; b: ModelPin | null };
  /** Paid and rehearsal: the batch's pins, which every openrouter child must resolve to. */
  expectedModels?: { a: BatchModel; b: BatchModel | null };
  sourceLingDir: string;
  childArgs?: readonly string[];
  env: NodeJS.ProcessEnv;
  /** Provider to scripted-model v1 script. Offline: every child's; paid: only `scripted-*` ones. */
  scripts?: Record<string, unknown>;
  /** Offline only: each child's `LING_SCRIPTED_MODEL_TRACE` goes here. */
  traceDir?: string;
  limitsOverride?: ComposeInput["limitsOverride"];
  dryRun?: boolean;
  instrument: Omit<ExperimentJson["instrument"], "piAgentDir">;
  manifestSha256: string;
  approval: ExperimentApproval;
  captureHooks?: CaptureHooks;
  /** Offline only: make the first builder's summon fail, before anything is posted. */
  faults?: { failFirstBuilderSummon?: boolean };
  /** Keep the run's Pi agent directory, for a search of it; the caller removes it. */
  keepPiAgentDir?: boolean;
  /** Tests only. */
  campaignId?: string;
}

export interface PlannedRunLease {
  workerId: string;
  role: string | null;
  runtimeDir: string;
}

export interface PlannedRunResult {
  runDir: string;
  /** Its outcome is a placeholder until `finalizeRun`. */
  experiment: ExperimentJson;
  manifest: CampaignManifest;
  composed: ComposedRun;
  captures: readonly CapturedTask[];
  leases: readonly PlannedRunLease[];
  piAgentDir: string;
  elapsedMs: number;
  /** What the driver threw, if it did; the run is then recorded as `run_failed`. */
  runError: string | null;
}

export const RUN_REFUSALS = {
  brain: "OVERLORD_BRAIN_MODEL is set; an experiment run has no brain.",
  offlineProvider: "An offline run starts scripted children only.",
  offlineScript: "An offline run needs a script for every child it starts.",
  paidOffline:
    "A paid or rehearsal run takes no script for A or B, no trace, no limits override, no dry run and no fault.",
  paidExpected: "A paid or rehearsal run needs the batch's models to check its children against.",
  runDir: "The run directory exists and is not empty.",
} as const;
export type RunRefusal = keyof typeof RUN_REFUSALS;

export class RunRefusedError extends Error {
  constructor(readonly refusal: RunRefusal) {
    super(RUN_REFUSALS[refusal]);
    this.name = "RunRefusedError";
  }
}

const SCRIPTED_NAME = /^scripted(?:-[a-z0-9]+)*$/;
const SCRIPTED_MODEL = "scripted-model";
/** Past the driver's own longest wait (build plan §5.3 step 4), it is shut down. */
const WATCHDOG_EXTRA_MS = 360_000 + 60_000;
/** After the watchdog's shutdown, how long the driver has to stop before the fleet is killed. */
const WATCHDOG_KILL_GRACE_MS = 120_000;
/** Beside `experiment.json`: whether each EventRecord `served` was built from is whole. */
export const EVENT_COVERAGE_FILE = "event-coverage.json";

/** One EventRecord `served` was built from, and whether it is a whole account of its task. */
export interface EventCoverage {
  side: "a" | "b";
  taskId: string;
  complete: boolean;
  reason: string | null;
}

/**
 * Children that answer from scripts: each provider's script is written once
 * under `scriptDir`, and only that child gets `LING_SCRIPTED_MODEL`,
 * `LING_ALLOW_SCRIPTED_MODEL=1` and, with `traceDir`, its own trace file. A
 * provider with no script is refused, unless it is one of `passThrough`
 * (paid A and B), which is started plainly.
 */
export function scriptedBootstrap(
  scripts: Record<string, unknown>,
  scriptDir: string,
  traceDir?: string,
  passThrough: readonly string[] = [],
): LingBootstrapFactory {
  const written = new Map<string, Promise<string>>();
  const fileFor = (provider: string) => {
    let file = written.get(provider);
    if (file === undefined) {
      const target = path.join(scriptDir, `${provider}.json`);
      file = mkdir(scriptDir, { recursive: true })
        .then(() => writeFile(target, JSON.stringify(scripts[provider], null, 2)))
        .then(() => target);
      written.set(provider, file);
    }
    return file;
  };
  return async (options) => {
    const provider = options.env?.["AGENT_PROVIDER"] ?? "";
    if (!Object.hasOwn(scripts, provider)) {
      if (passThrough.includes(provider)) return bootstrapLing(options);
      throw new Error(
        `No script for provider ${JSON.stringify(provider)}; a ling without one could reach ` +
          "a model, so none is started.",
      );
    }
    const workerId = options.env?.["WORKER_ID"] ?? randomBytes(4).toString("hex");
    const trace =
      traceDir === undefined
        ? {}
        : { LING_SCRIPTED_MODEL_TRACE: path.join(traceDir, `${provider}-${workerId}.jsonl`) };
    if (traceDir !== undefined) await mkdir(traceDir, { recursive: true });
    return bootstrapLing({
      ...options,
      env: {
        ...options.env,
        LING_SCRIPTED_MODEL: await fileFor(provider),
        LING_ALLOW_SCRIPTED_MODEL: "1",
        ...trace,
      },
    });
  };
}

/** The first difference between a child's resolved model and its pin, or undefined. */
export function resolvedModelMismatch(
  expected: BatchModel,
  resolved: LingResolvedModel | null | undefined,
): string | undefined {
  if (resolved == null) return "the child reports no resolved model";
  if (resolved.provider !== expected.provider || resolved.id !== expected.model) {
    return `resolved ${resolved.provider}/${resolved.id}, not ${expected.provider}/${expected.model}`;
  }
  if (resolved.thinking !== expected.thinking) {
    return `thinking ${resolved.thinking}, not ${expected.thinking}`;
  }
  for (const [key, price] of Object.entries(expected.prices)) {
    const actual = resolved.cost?.[key];
    if (actual !== price) return `cost.${key} is ${String(actual)}, not ${price}`;
  }
  const compat = { ...(resolved.compat ?? {}) };
  const routing = compat["openRouterRouting"] ?? null;
  delete compat["openRouterRouting"];
  if (!isDeepStrictEqual(routing, expected.routing)) {
    return `compat.openRouterRouting is ${JSON.stringify(routing)}, not ${JSON.stringify(expected.routing)}`;
  }
  const expectedCompat = { ...(expected.compat ?? {}) };
  delete expectedCompat["openRouterRouting"];
  for (const key of new Set([...Object.keys(compat), ...Object.keys(expectedCompat)])) {
    if (!isDeepStrictEqual(compat[key], expectedCompat[key])) {
      return `compat.${key} is ${JSON.stringify(compat[key])}, not ${JSON.stringify(expectedCompat[key])}`;
    }
  }
  if (expected.maxTokens != null && resolved.maxTokens !== expected.maxTokens) {
    return `maxTokens is ${String(resolved.maxTokens)}, not ${expected.maxTokens}`;
  }
  const level = resolved.thinkingLevelMap?.[expected.thinking] ?? null;
  if (level !== expected.thinkingLevel) {
    return `thinkingLevelMap.${expected.thinking} is ${String(level)}, not ${String(expected.thinkingLevel)}`;
  }
  return undefined;
}

/**
 * The paid `beforePost` check: an openrouter child, the builder's or the
 * watcher's, must resolve to its pin; a mismatch throws, so nothing is posted
 * to it. A scripted child passes untouched. `record` keeps what each resolved.
 */
export function resolvedModelCheck(
  expected: { a: BatchModel; b: BatchModel | null },
  record: (role: string, model: LingResolvedModel | null) => void,
): LocalBeforePostHook {
  return (worker) => {
    if (worker.health.provider !== "openrouter") return;
    const role = requestKeyRole(worker.requestKey) ?? "";
    const pin = role === "builder" ? expected.a : role === "watcher" ? expected.b : null;
    if (pin === null) {
      throw new Error(`An openrouter child for role ${JSON.stringify(role)} has no pin to match.`);
    }
    const mismatch = resolvedModelMismatch(pin, worker.health.model);
    if (mismatch !== undefined) {
      throw new Error(`The ${role}'s child does not match its pin: ${mismatch}.`);
    }
    record(role, worker.health.model ?? null);
  };
}

/** Whether every directory is gone, polling up to `timeoutMs` while Windows lets go of handles. */
export async function waitRuntimeRemoved(
  dirs: readonly string[],
  timeoutMs = 10_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const left: string[] = [];
    for (const dir of dirs) {
      try {
        await access(dir);
        left.push(dir);
      } catch {
        // Gone.
      }
    }
    if (left.length === 0) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** Every file under `dir`, relative and with forward slashes, sorted. */
async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await listFiles(path.join(dir, entry.name), relative)));
    else files.push(relative);
  }
  return files.sort();
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function scripted(name: string | null | undefined): boolean {
  return typeof name === "string" && SCRIPTED_NAME.test(name);
}

/** What a run may not start with; each refusal is the one W4-A's preflight makes too. */
function refuse(input: PlannedRunInput): void {
  const brain = [input.env["OVERLORD_BRAIN_MODEL"], process.env["OVERLORD_BRAIN_MODEL"]];
  if (brain.some((value) => value !== undefined && value.trim() !== "")) {
    throw new RunRefusedError("brain");
  }
  const pins = [input.models.a, ...(input.models.b === null ? [] : [input.models.b])];
  if (input.mode === "offline") {
    if (!pins.every((pin) => scripted(pin.provider) && pin.model === SCRIPTED_MODEL)) {
      throw new RunRefusedError("offlineProvider");
    }
    return;
  }
  const scripts = input.scripts ?? {};
  if (
    pins.some((pin) => Object.hasOwn(scripts, pin.provider)) ||
    input.traceDir !== undefined ||
    input.limitsOverride !== undefined ||
    input.dryRun !== undefined ||
    input.faults !== undefined
  ) {
    throw new RunRefusedError("paidOffline");
  }
  if (input.expectedModels === undefined) throw new RunRefusedError("paidExpected");
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function emptyOrAbsent(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length === 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * Runs one planned run and writes its run directory. The outcome it records
 * is a placeholder (`included`, or `run_failed` when the driver threw) until
 * `finalizeRun` applies the exclusion rules.
 */
export async function runPlannedRun(input: PlannedRunInput): Promise<PlannedRunResult> {
  refuse(input);
  const startedAt = Date.now();
  const started = new Date(startedAt).toISOString();
  const composed = composeRun({
    run: input.run,
    mode: input.mode,
    models: input.models,
    ...(input.limitsOverride === undefined ? {} : { limitsOverride: input.limitsOverride }),
    ...(input.dryRun === undefined ? {} : { dryRun: input.dryRun }),
    ...(input.campaignId === undefined ? {} : { campaignId: input.campaignId }),
  });
  const offline = input.mode === "offline";
  const scripts = input.scripts ?? {};
  // Offline, every child the run starts needs a script. A scripted-B arm's B
  // is served in-process and starts none.
  const children = (["builder", "reviewer", "integration", "planner"] as const)
    .map((role) => composed.providers[role])
    .concat(composed.arm.b === "model" ? [composed.providers.watcher] : []);
  if (offline && !children.every((provider) => provider !== null && Object.hasOwn(scripts, provider))) {
    throw new RunRefusedError("offlineScript");
  }

  const runDir = path.join(input.runsDir, input.batchId, input.run.runId);
  if (!(await emptyOrAbsent(runDir))) throw new RunRefusedError("runDir");
  await mkdir(runDir, { recursive: true });
  const piAgentDir = path.join(os.tmpdir(), "ling-pi-agent", randomBytes(4).toString("hex"));
  await mkdir(piAgentDir, { recursive: true });
  // A child's LING_SCRIPTED_MODEL names its script; under the run directory
  // it would carry the batch and run ids (F24). Copied there after the run.
  const scriptDir = path.join(os.tmpdir(), "ling-scripts", randomBytes(4).toString("hex"));

  const leases: PlannedRunLease[] = [];
  // Every runtime directory made, also for a worker torn down before beforePost.
  const runtimeDirs: string[] = [];
  const makeRuntimeDir = defaultRuntimeDirectoryFactory(path.resolve(os.tmpdir(), "ling-overlord-workers"));
  const resolved: { a: LingResolvedModel | null; b: LingResolvedModel | null } = { a: null, b: null };
  const keep = (role: string, model: LingResolvedModel | null) => {
    if (role === "builder") resolved.a = model;
    else if (role === "watcher") resolved.b = model;
  };
  const paidCheck =
    input.expectedModels === undefined ? undefined : resolvedModelCheck(input.expectedModels, keep);
  let builderFaulted = false;
  const beforePost: LocalBeforePostHook = async (worker) => {
    const role = requestKeyRole(worker.requestKey) ?? null;
    leases.push({ workerId: worker.workerId, role, runtimeDir: worker.runtimePaths.runtimeDir });
    if (input.faults?.failFirstBuilderSummon === true && role === "builder" && !builderFaulted) {
      builderFaulted = true;
      throw new Error("The first builder's summon fails on purpose (the one-A check).");
    }
    const health = worker.health;
    if (!offline && health.provider === "openrouter") {
      await paidCheck!(worker);
      return;
    }
    const expected = role === null ? undefined : composed.providers[role as ComposedRole];
    if (health.provider !== expected || health.models?.join() !== SCRIPTED_MODEL) {
      throw new Error(
        `The ${String(role)}'s child came up as ${String(health.provider)}/` +
          `${String(health.models?.join())}, not ${String(expected)}/${SCRIPTED_MODEL}.`,
      );
    }
    if (role !== null) keep(role, health.model ?? null);
  };

  const passThrough = offline
    ? []
    : [input.models.a.provider, ...(input.models.b === null ? [] : [input.models.b.provider])];
  // No runtimeRootDir: the default root names nothing (F24).
  const provisioner = new LocalTaskProvisioner({
    sourceLingDir: input.sourceLingDir,
    env: input.env,
    ...(input.childArgs === undefined ? {} : { args: input.childArgs }),
    piAgentDir,
    beforePost,
    bootstrap: scriptedBootstrap(scripts, scriptDir, input.traceDir, passThrough),
    runtimeDirectoryFactory: async (request, workerId, sourceLingDir) => {
      const made = await makeRuntimeDir(request, workerId, sourceLingDir);
      runtimeDirs.push(made.path);
      return made;
    },
    startupTimeoutMs: 120_000,
    terminateGraceMs: 2_000,
  });
  let watchdog: NodeJS.Timeout | undefined;
  let kill: NodeJS.Timeout | undefined;
  try {
    const provisioned = new ProvisionedLingClient({
      provisioner,
      resolveProfile: resolvedWorkerProfileFromSpawnInput,
      defaultLeaseTtlMs: 60 * 60_000,
    });
    const capture = withCapture(provisioned, provisioner, input.captureHooks);
    let client: CampaignLingClient = capture;
    if (composed.watcherScript !== null) {
      const watched = withScriptedWatcher(capture, scriptedWatcherOptions(composed.watcherScript));
      assert(Array.isArray(watched.watchers), "the scripted-B client keeps no watchers (F11)");
      client = watched;
    }
    const store = new CampaignManifestStore(path.join(runDir, "manifest.json"));
    const artifacts = new CampaignArtifactStore(
      runDir,
      path.join(runDir, "workspaces"),
      provisioned,
    );
    await initializeCampaign(store, artifacts, composed.definition);
    const driver = new CampaignDriver({
      client,
      store,
      artifacts,
      policy: composed.policy,
      oversight: { timings: composed.driverTimings },
      ...(composed.settleGraceMs === undefined ? {} : { settleGraceMs: composed.settleGraceMs }),
    });
    // Past the driver's own longest wait, the run is stopped from outside: the
    // driver is shut down, and its releases capture as usual. Only a driver
    // that does not stop within the grace has its fleet killed, captures or not.
    const watchdogMs = workerMaxRunMs(composed.limits.a.maxWallClockMs) + WATCHDOG_EXTRA_MS;
    let stopping: Promise<void> | undefined;
    watchdog = setTimeout(() => {
      stopping = driver.shutdown().catch(() => undefined);
      kill = setTimeout(() => void provisioner.forceShutdown().catch(() => undefined), WATCHDOG_KILL_GRACE_MS);
    }, watchdogMs);
    let runError: string | null = null;
    try {
      await driver.run();
    } catch (error) {
      runError = message(error);
    }
    clearTimeout(watchdog);
    clearTimeout(kill);
    if (stopping !== undefined) {
      // The shutdown's own releases end before anything else is captured or killed.
      await stopping;
      const stopped = `watchdog: the run was stopped from outside after ${watchdogMs} ms`;
      runError = runError === null ? stopped : `${stopped}; ${runError}`;
    }
    await capture.captureUnreleased();
    await provisioner.forceShutdown();
    const runtimeRemoved = await waitRuntimeRemoved([
      ...new Set([...runtimeDirs, ...leases.map((lease) => lease.runtimeDir)]),
    ]);
    if (await exists(scriptDir)) await cp(scriptDir, path.join(runDir, "scripts"), { recursive: true });
    const manifest = await store.load();
    const captures = capture.captures();
    const experiment = await recordRun({
      input,
      composed,
      runDir,
      manifest,
      captures,
      runtimeRemoved,
      resolved,
      piAgentDir,
      started,
      runError,
    });
    return {
      runDir,
      experiment,
      manifest,
      composed,
      captures,
      leases,
      piAgentDir,
      elapsedMs: Date.now() - startedAt,
      runError,
    };
  } finally {
    clearTimeout(watchdog);
    clearTimeout(kill);
    await provisioner.forceShutdown().catch(() => undefined);
    await rm(scriptDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    if (input.keepPiAgentDir !== true) {
      await rm(piAgentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
}

interface RunFacts {
  input: PlannedRunInput;
  composed: ComposedRun;
  runDir: string;
  manifest: CampaignManifest;
  captures: readonly CapturedTask[];
  runtimeRemoved: boolean;
  resolved: { a: LingResolvedModel | null; b: LingResolvedModel | null };
  piAgentDir: string;
  started: string;
  runError: string | null;
}

/** `experiment.json` from what the run left, written with the captures beside it. */
async function recordRun(facts: RunFacts): Promise<ExperimentJson> {
  const { input, composed, runDir, manifest, captures } = facts;
  const builders = manifest.tasks.filter((task) => task.role === "builder");
  const watcher = manifest.tasks.find((task) => task.role === "watcher");
  const builder = capturedBuilder(captures);
  const modelB = composed.b.kind === "model";
  // `served` from every builder's record and a model B's, each judged whole
  // or not: a call missing from an incomplete record would be dropped, not
  // counted as served-unknown, so `finalizeRun` excludes such a run.
  const coverage: EventCoverage[] = [];
  const recorded = async (side: EventCoverage["side"], taskId: string) => {
    const events: readonly LingEvent[] = (await readEventRecord(runDir, taskId)) ?? [];
    const assessed = assessEventSequence(events);
    coverage.push({
      side,
      taskId,
      complete: assessed.complete,
      reason: assessed.complete ? null : (assessed.reason ?? "no event record"),
    });
    return events;
  };
  const aEvents: LingEvent[] = [];
  for (const task of builders) aEvents.push(...(await recorded("a", task.id)));
  if (modelB && watcher === undefined) {
    coverage.push({ side: "b", taskId: "", complete: false, reason: "the manifest holds no watcher task" });
  }
  const bEvents: readonly LingEvent[] =
    modelB && watcher !== undefined ? await recorded("b", watcher.id) : [];
  const child = childPathsFrom(builder, facts.runtimeRemoved);
  const settings = await readLingSettings({ sourceLingDir: input.sourceLingDir, env: input.env });
  const sum = (tasks: readonly { costUsd: number }[]) =>
    tasks.reduce((total, task) => total + task.costUsd, 0);
  const b: ExperimentJson["b"] =
    composed.b.kind === "model" ? { ...composed.b, resolved: facts.resolved.b } : composed.b;
  const experiment: ExperimentJson = {
    version: 1,
    batchId: input.batchId,
    runId: input.run.runId,
    experiment: input.run.experiment,
    cell: input.run.cell,
    arm: input.run.arm,
    scenario: input.run.scenario,
    variant: input.run.variant,
    prompted: input.run.prompted,
    rep: input.run.rep,
    rerunOf: null,
    a: { ...input.models.a, routing: null, resolved: facts.resolved.a },
    b,
    limits: composed.limits,
    minBatchIntervalMs: composed.driverTimings.minBatchIntervalMs ?? null,
    maxRounds: composed.maxRounds,
    maxTasks: composed.maxTasks,
    brain: "unset",
    lingSettings: settings.inForce,
    instrument: { ...input.instrument, piAgentDir: { files: await listFiles(facts.piAgentDir) } },
    manifestSha256: input.manifestSha256,
    promptDigest: builder?.finalState?.promptDigest ?? null,
    child,
    approval: input.approval,
    campaign: { id: composed.campaignId },
    tasks: { builderIds: builders.map((task) => task.id), watcherId: watcher?.id ?? null },
    workspaceDir: child.workspaceDir,
    started: facts.started,
    ended: new Date().toISOString(),
    cost: { a: sum(builders), b: modelB && watcher !== undefined ? watcher.costUsd : null, reconciled: null },
    served: servedCalls({ a: aEvents, ...(modelB ? { b: bEvents } : {}) }),
    outcome:
      facts.runError === null
        ? { status: "included", reason: null }
        : { status: "excluded", reason: "run_failed" },
  };
  await writeCaptures(runDir, captures);
  await writeFile(path.join(runDir, EVENT_COVERAGE_FILE), json(coverage));
  if (facts.runError !== null) {
    await writeFile(path.join(runDir, "run-error.txt"), `${facts.runError}\n`);
  }
  await writeFile(path.join(runDir, "experiment.json"), json(experiment));
  return experiment;
}

/**
 * The run's outcome from W1-D's exclusion rules, written to `experiment.json`.
 * W4-A calls it after its served lookups and meter have amended `served` and
 * `cost`; with no context the outcome is left as it is. Only the reasons are
 * read, W1-D's with `coverageReasons`, never the contamination verdict's shape.
 */
export async function finalizeRun(
  runDir: string,
  experiment: ExperimentJson,
  context: ScoreContext | null,
): Promise<ExperimentJson> {
  let final = experiment;
  if (context !== null) {
    await writeFile(path.join(runDir, "experiment.json"), json(experiment));
    const records = await loadRunRecords(runDir);
    const exclusion = computeExclusion({ ...records, experiment }, context);
    const reasons = [...exclusion.reasons, ...(await coverageReasons(runDir, experiment))].sort(
      (left, right) => EXCLUSION_REASONS.indexOf(left.reason) - EXCLUSION_REASONS.indexOf(right.reason),
    );
    final = {
      ...experiment,
      outcome:
        reasons.length > 0
          ? { status: "excluded", reason: reasons[0]!.reason }
          : { status: "included", reason: null },
    };
  }
  await writeFile(path.join(runDir, "experiment.json"), json(final));
  return final;
}

/**
 * `events_incomplete` for each EventRecord `served` was built from that the
 * scorer does not judge itself: a model B's, and every builder's but the
 * one it reads. A run directory with no coverage file has nothing to show
 * its records whole, so it is excluded too.
 */
export async function coverageReasons(
  runDir: string,
  experiment: Pick<ExperimentJson, "tasks">,
): Promise<{ reason: ExclusionReason; detail: string }[]> {
  let coverage: EventCoverage[];
  try {
    coverage = JSON.parse(await readFile(path.join(runDir, EVENT_COVERAGE_FILE), "utf8")) as EventCoverage[];
  } catch (error) {
    return [{ reason: "events_incomplete", detail: `${EVENT_COVERAGE_FILE} could not be read: ${message(error)}` }];
  }
  const judged = experiment.tasks.builderIds[0];
  return coverage
    .filter((entry) => !entry.complete && !(entry.side === "a" && entry.taskId === judged))
    .map((entry) => ({
      reason: "events_incomplete" as const,
      detail: `${entry.side === "a" ? "A" : "B"}'s EventRecord ${entry.taskId === "" ? "(no task)" : entry.taskId}: ${entry.reason ?? "incomplete"}`,
    }));
}
