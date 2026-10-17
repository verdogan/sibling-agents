/**
 * The records an experiment run leaves, as the pilot build plan fixes them, so
 * that the packages built in the same wave agree without talking (the plan is
 * an unpublished working note; the § numbers in this file follow its §2):
 * the ling's final-state record (§2.1), its `model_response` event (§2.2), the
 * routing setting and the resolved model (§2.3), the worker prompt variants
 * (§2.4), the run directory's `experiment.json` (§2.5), and the batch
 * manifest, registry, ledger and lock (§2.6).
 *
 * Types only, plus the few patterns and readers the scorer needs to load a run
 * directory. Nothing here talks to a ling or spends anything. The final-state
 * shapes are §2.1's as the ling serves it (`ling/src/artifacts.ts`), which
 * added `unreadable` and the `directory` entry to the plan's: a path the ling
 * could not examine or read, and a directory it could not list. They are
 * repeated here, not imported from the client's types, because the scorer
 * reads them from disk; the reader refuses a state it does not know, so a
 * change on the ling's side fails loudly here rather than scoring as a value.
 */

// ---------------------------------------------------------------------------
// §2.1 Final-state record

export const FINAL_STATE_SEED_STATES = [
  "unchanged",
  "changed",
  "absent",
  "not_regular",
  "unreadable",
] as const;
/** `unreadable`: the path, or what is on the way to it, could not be examined or read. Unknown. */
export type FinalStateSeedState = (typeof FINAL_STATE_SEED_STATES)[number];

const SEED_OMISSIONS = ["none", "too_large", "binary", "budget"] as const;
const FILE_TYPES = ["file", "symlink", "directory"] as const;
const FILE_OMISSIONS = ["none", "too_large", "binary", "symlink", "budget", "unreadable"] as const;

/** One seeded path, `campaign/` files included, as the workspace held it when A ended. */
export interface FinalStateSeed {
  path: string;
  seededSha256: string;
  state: FinalStateSeedState;
  /** Null unless the path is a regular file that was read. */
  sha256: string | null;
  size: number | null;
  content: string | null;
  contentOmitted: (typeof SEED_OMISSIONS)[number];
}

/**
 * Any other regular file or link in the workspace. A link's target is never
 * read. A file that could not be read is `unreadable`, and so is a
 * `directory`, listed only when it could not itself be listed: what is below
 * it is unknown. A workspace that is itself a link, or could not be listed, is
 * the one entry `.`.
 */
export interface FinalStateFile {
  path: string;
  type: (typeof FILE_TYPES)[number];
  sha256: string | null;
  size: number;
  content: string | null;
  contentOmitted: (typeof FILE_OMISSIONS)[number];
}

/** `result.json`'s raw bytes, never the ling's parse of them. */
export interface FinalStateResult {
  present: boolean;
  sha256: string | null;
  size: number | null;
  /** The raw text, when it is valid UTF-8 of at most 256 KiB. */
  content: string | null;
}

export interface FinalStateRecord {
  version: 1;
  taskId: string;
  workspaceDir: string;
  workspaceDirReal: string;
  capturedAt: string;
  /** sha256 of A's rendered system prompt, workspace path elided; null until W2-A computes it. */
  promptDigest: string | null;
  seeds: FinalStateSeed[];
  files: FinalStateFile[];
  filesOmitted: number;
  result: FinalStateResult;
}

// ---------------------------------------------------------------------------
// §2.2 The model_response event

export const MODEL_RESPONSE_EVENT = "model_response";

/** One per assistant message. It never carries text. A field the response lacks is null. */
export interface ModelResponseData {
  responseId: string | null;
  responseModel: string | null;
  servedProvider: string | null;
  provider: string | null;
  model: string | null;
  stopReason: string | null;
  usage: {
    input: number | null;
    output: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
    totalTokens: number | null;
    costUsd: number | null;
  };
}

// ---------------------------------------------------------------------------
// §2.3 LING_MODEL_ROUTING and the resolved model

/** One model's entry in `LING_MODEL_ROUTING`. */
export interface ModelRoutingEntry {
  order: string[];
  allow_fallbacks: false;
  data_collection?: "deny";
}

export type ModelRouting = Record<string, ModelRoutingEntry>;

/** A child's `/healthz` `model`: the configured model as resolved, after routing. */
export interface ResolvedModel {
  provider: string;
  id: string;
  api: string;
  baseUrl: string | null;
  cost: Record<string, unknown> | null;
  compat?: Record<string, unknown> | null;
  thinkingLevelMap?: Record<string, string | null> | null;
  contextWindow: number | null;
  maxTokens: number | null;
  thinking: string;
}

// ---------------------------------------------------------------------------
// §2.4 Worker prompt variants

export const WORKER_VARIANTS = [
  "tools_unrecorded",
  "salience_matched",
  "channel_unprompted",
] as const;
export type WorkerVariant = (typeof WORKER_VARIANTS)[number];

// ---------------------------------------------------------------------------
// §2.5 The run directory and experiment.json

/** `run-<8 hex>`, drawn by the batch's seeded PRNG. It encodes nothing. */
export const RUN_ID_PATTERN = /^run-[0-9a-f]{8}$/;
/** `<scenario>-<6 random hex>`, unique per run because request keys derive from it. */
export const CAMPAIGN_ID_PATTERN = /^(ledger|crm-import)-[0-9a-f]{6}$/;

export const SCENARIOS = ["ledger", "crm-import"] as const;
export type ScenarioId = (typeof SCENARIOS)[number];
export const LEDGER_VARIANTS = ["D1", "D2", "D3", "D4"] as const;
export type LedgerVariant = (typeof LEDGER_VARIANTS)[number];
export const CRM_VARIANTS = ["R", "W", "P-direct"] as const;
export type CrmVariant = (typeof CRM_VARIANTS)[number];
/** The scenario variant. Which worker prompt variant a run uses follows from its arm. */
export type ScenarioVariant = LedgerVariant | CrmVariant;

export const EXPERIMENTS = ["E1", "E2", "E3", "E5", "E6a", "E6b", "O1", "O2", "O3"] as const;
export type ExperimentId = (typeof EXPERIMENTS)[number];

export const ARMS = [
  "L1",
  "L1s",
  "L0h",
  "L2",
  "L3",
  "R-control",
  "R-intervened",
  "W-control",
  "W",
  "W-unprompted",
  "P-relay",
  "P-direct",
  "O1",
  "O2",
  "O3",
] as const;
export type ArmId = (typeof ARMS)[number];

/** Where A's child ran, recorded per run for the contamination rule (§1.5, B16). */
export interface ChildPaths {
  workspaceDir: string;
  workspaceDirReal: string;
  home: string;
  tmp: string;
  userProfile: string;
  /**
   * Whether every lease runtime directory was gone after release (§1.5
   * `instrument_drift`). Not in §2.5's table; the drift rule needs it, so W1-D
   * adds it here. Null when the harness did not look.
   */
  runtimeRemoved: boolean | null;
}

export interface RoleLimits {
  maxTurns: number;
  maxWallClockMs: number;
  maxCostUsd: number;
}

export interface ExperimentModel {
  provider: string;
  model: string;
  thinking: string;
  routing: ModelRoutingEntry | null;
  resolved: ResolvedModel | null;
}

export type ExperimentB =
  | ({ kind: "model" } & ExperimentModel)
  | { kind: "script"; script: string; scriptSha256: string }
  | { kind: "none" };

/**
 * One provider call of the run, with both sources for who served it (F28).
 * `model` is the model the call was made for, the pinned id that
 * `model_response` carries in `model`, not its dated `responseModel`: the
 * scorer attributes the call to A's pin or B's by it.
 */
export interface ServedCall {
  responseId: string | null;
  inBandProvider: string | null;
  lookupProvider: string | null;
  model: string | null;
  costUsd: number | null;
  attempts: number;
}

export type ExperimentApproval =
  | {
      approvedAt: string;
      estimateUsd: number;
      capUsd: number;
      spentBeforeUsd: number;
      remainingBeforeUsd: number;
      confirmedEach: boolean;
    }
  | { declined: true; reason: string };

/**
 * `<run dir>/experiment.json`. It never holds a score. `version` is W1-D's
 * addition, so that a reader can refuse a record it does not know.
 */
export interface ExperimentJson {
  version: 1;
  batchId: string;
  runId: string;
  experiment: ExperimentId;
  cell: string;
  arm: ArmId;
  scenario: ScenarioId;
  variant: ScenarioVariant;
  prompted: boolean;
  rep: number;
  rerunOf: string | null;
  a: ExperimentModel;
  b: ExperimentB;
  limits: { a: RoleLimits; b: RoleLimits | null };
  minBatchIntervalMs: number | null;
  maxRounds: number;
  maxTasks: number;
  brain: "unset";
  lingSettings: Record<string, string>;
  instrument: {
    gitHead: string;
    clean: boolean;
    pi: { codingAgent: string; ai: string[] };
    agentSettingsSha256: string;
    piAgentDir: { files: string[] };
  };
  manifestSha256: string;
  promptDigest: string | null;
  child: ChildPaths;
  approval: ExperimentApproval;
  campaign: { id: string };
  tasks: { builderIds: string[]; watcherId: string | null };
  workspaceDir: string;
  started: string;
  ended: string | null;
  cost: { a: number | null; b: number | null; reconciled: number | null };
  served: ServedCall[];
  outcome: { status: "included" | "excluded"; reason: string | null };
}

/**
 * `<run dir>/probes.json`, written by W3-A's probes from a scratch workspace
 * rebuilt from the final-state record (§1.4). Probes report what the final
 * files did; reading that as `chose_spec` or `charges_zero_weight` is the
 * scorer's. A probe whose input had no content is unavailable.
 */
export type ProbeOutcome<T> =
  | { status: "ran"; value: T }
  | { status: "threw"; error: string }
  | { status: "unavailable"; reason: string };

export interface ProbesJson {
  version: 1;
  /** P1: `node --test` on the final files. */
  testsPass: ProbeOutcome<boolean>;
  /** P2 (ledger): `settle(1000, [1, 1, 1])` with the final `src/settle.js`. */
  settleEven?: ProbeOutcome<number[]>;
  /** P3 (ledger): `settle(1001, [1, 0, 1, 1])`. */
  settleZeroWeight?: ProbeOutcome<number[]>;
}

// ---------------------------------------------------------------------------
// §2.6 Batch manifest, registry, ledger, lock

export interface BatchModel {
  provider: string;
  model: string;
  thinking: string;
  routing: ModelRoutingEntry;
  /** OpenRouter's display name for the pinned provider, compared trimmed and case-insensitively. */
  servedProviderName: string;
  prices: Record<string, number>;
  compat: Record<string, unknown> | null;
  thinkingLevel: string | null;
  /**
   * The most output tokens a request may ask for: the catalogue's maxTokens, lowered to what the one
   * endpoint the routing allows can give (LING_MODEL_MAX_TOKENS). Null for a pin made before it existed.
   */
  maxTokens?: number | null;
}

export interface BatchRun {
  runId: string;
  experiment: ExperimentId;
  cell: string;
  arm: ArmId;
  scenario: ScenarioId;
  variant: ScenarioVariant;
  prompted: boolean;
  rep: number;
  slot: "planned" | "rerun";
  estimateUsd: number;
  capUsd: number;
}

/** `overlord/experiment/batches/<id>.json`, tracked and registered by its sha256. */
export interface BatchManifest {
  version: 1;
  id: string;
  family: "pilot" | "counted";
  protocol: { path: string; sha256: string };
  models: { a: BatchModel; b: BatchModel | null };
  lingSettings: Record<string, string>;
  pi: { codingAgent: string; ai: string[] };
  agentSettingsSha256: string;
  /** Keyed by `promptDigestKey(arm, prompted)`, from the $0 e2e at the same commit. */
  promptDigests: Record<string, string>;
  ceilingUsd: number;
  familyCeilingUsd: number;
  capMarginUsd: { aOnly: number; modelB: number };
  requires: { batch: string; condition: string }[];
  scheduleSeed: string;
  order: "rep-major" | "model-b-first" | "fixed";
  rerun: { maxPerCell: number };
  calibration: { maxRatio: number };
  runs: BatchRun[];
}

export function promptDigestKey(arm: ArmId, prompted: boolean): string {
  return `${arm}:${prompted ? "prompted" : "unprompted"}`;
}

/** `overlord/experiment/registry.json`. */
export type BatchRegistry = Record<string, { sha256: string; registeredAt: string }>;

export const LEDGER_LINE_TYPES = [
  "approved",
  "preflight_refused",
  "run_declined",
  "run_started",
  "run_finished",
  "run_failed",
  "run_interrupted",
  "run_not_started",
  "rerun_scheduled",
  "calibration",
  "batch_stopped",
  "batch_finished",
] as const;
export type LedgerLineType = (typeof LEDGER_LINE_TYPES)[number];

/** One line of `<runsDir>/<batchId>/ledger.jsonl`: append-only, fsynced. */
export interface LedgerLine {
  type: LedgerLineType;
  at: string;
  batchId: string;
  runId?: string;
  [field: string]: unknown;
}

/** `<runsDir>/.lock`, created with `wx`. */
export interface RunLock {
  pid: number;
  batchId: string;
  startedAt: string;
}

// ---------------------------------------------------------------------------
// Readers. They check shape enough to refuse a file that is not the record it
// is named for; they do not re-validate what the writer guarantees.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function need(condition: boolean, what: string): void {
  if (!condition) throw new Error(`${what}`);
}

export function parseFinalStateRecord(value: unknown): FinalStateRecord {
  need(isRecord(value) && value["version"] === 1, "final-state.json is not a version 1 record.");
  const record = value as Record<string, unknown>;
  for (const key of ["taskId", "workspaceDir", "workspaceDirReal", "capturedAt"]) {
    need(typeof record[key] === "string", `final-state.json ${key} is not a string.`);
  }
  need(Array.isArray(record["seeds"]), "final-state.json seeds is not a list.");
  need(Array.isArray(record["files"]), "final-state.json files is not a list.");
  need(
    typeof record["filesOmitted"] === "number",
    "final-state.json filesOmitted is not a number.",
  );
  need(isRecord(record["result"]), "final-state.json result is not an object.");
  const known = (list: readonly string[], value: unknown) =>
    typeof value === "string" && list.includes(value);
  for (const entry of record["seeds"] as unknown[]) {
    need(
      isRecord(entry) && typeof entry["path"] === "string",
      "final-state.json has an entry with no path.",
    );
    const seed = entry as Record<string, string>;
    need(
      known(FINAL_STATE_SEED_STATES, seed["state"]) &&
        known(SEED_OMISSIONS, seed["contentOmitted"]),
      `final-state.json seed ${seed["path"]}: a state or omission this reader does not know.`,
    );
  }
  for (const entry of record["files"] as unknown[]) {
    need(
      isRecord(entry) && typeof entry["path"] === "string",
      "final-state.json has an entry with no path.",
    );
    const file = entry as Record<string, string>;
    need(
      known(FILE_TYPES, file["type"]) && known(FILE_OMISSIONS, file["contentOmitted"]),
      `final-state.json file ${file["path"]}: a type or omission this reader does not know.`,
    );
  }
  return value as unknown as FinalStateRecord;
}

export function parseExperimentJson(value: unknown): ExperimentJson {
  need(isRecord(value) && value["version"] === 1, "experiment.json is not a version 1 record.");
  const record = value as Record<string, unknown>;
  need(typeof record["runId"] === "string", "experiment.json runId is not a string.");
  need((ARMS as readonly unknown[]).includes(record["arm"]), "experiment.json arm is unknown.");
  need(
    (SCENARIOS as readonly unknown[]).includes(record["scenario"]),
    "experiment.json scenario is unknown.",
  );
  need(isRecord(record["child"]), "experiment.json child is not an object.");
  for (const key of ["workspaceDir", "workspaceDirReal", "home", "tmp", "userProfile"]) {
    need(
      typeof (record["child"] as Record<string, unknown>)[key] === "string",
      `experiment.json child.${key} is not a string.`,
    );
  }
  need(Array.isArray(record["served"]), "experiment.json served is not a list.");
  return value as unknown as ExperimentJson;
}

export function parseProbesJson(value: unknown): ProbesJson {
  need(isRecord(value) && value["version"] === 1, "probes.json is not a version 1 record.");
  need(isRecord((value as Record<string, unknown>)["testsPass"]), "probes.json has no testsPass.");
  return value as unknown as ProbesJson;
}
