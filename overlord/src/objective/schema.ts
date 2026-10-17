import path from "node:path";
import type { ArtifactRef, CampaignStatus } from "../campaign/schema.js";
import { collapseToSingleLine, contentAddress } from "../text.js";

/**
 * Version 2 widened the record from a product pointer to the objective's whole
 * standing state: its charter, the chunks it has finished, the viability
 * assessments it has recorded, and whether it has halted. Version 1 is not read.
 */
export const OBJECTIVE_VERSION = 2 as const;
export const PRODUCT_SNAPSHOT_VERSION = 1 as const;
export const MAX_PRODUCT_SNAPSHOT_FILES = 4_096;
export const MAX_PRODUCT_SNAPSHOT_MANIFEST_BYTES = 4 * 1024 * 1024;

/**
 * Caps on the record's parts. There is deliberately no cap on the encoded whole:
 * this is the most crash-critical state in the system, and a byte ceiling on it
 * converts growth into an inability to record work that has already been paid for.
 * Bounding growth is the loop's job — compaction, and archiving finished chunks
 * beside the campaign manifests they point at.
 */
export const MAX_OBJECTIVE_STATEMENT_CHARS = 4_000;
export const MAX_OBJECTIVE_CONSTRAINTS = 64;
export const MAX_CONSTRAINT_CHARS = 400;
export const MAX_CHUNK_STATEMENT_CHARS = 2_000;
export const MAX_CHUNK_CRITERIA = 16;
export const MAX_CRITERION_CHARS = 400;
export const MAX_OBJECTIVE_CHUNKS = 5_000;
export const MAX_OBJECTIVE_ASSESSMENTS = 20_000;
export const MAX_OBJECTIVE_REFORMS = 64;
export const MAX_ASSESSMENT_BASIS = 16;
export const MAX_BASIS_CHARS = 400;
export const MAX_HALT_SUMMARY_CHARS = 2_000;

export interface ProductSnapshotPointer {
  snapshotId: string;
  path: string;
  sha256: string;
}

/**
 * What the objective was started with, and the one part of the record that does not
 * change as work proceeds.
 *
 * It is grouped rather than spread across the manifest because the grouping is what
 * makes immutability enforceable in one comparison. `ObjectiveManifestStore` refuses
 * any ordinary save that alters it; the only path through is `reformCharter`, which
 * demands the principal's report id and records what it replaced. That is aimed at a
 * specific failure this system is otherwise wide open to: an overlord that quietly
 * downgrades the objective to whatever it can still afford and then reports success.
 * A goal that cannot be edited in passing cannot be downgraded in passing.
 */
export interface ObjectiveCharter {
  /** 1 at creation, and incremented only by a recorded reform. */
  revision: number;
  /** The standing goal, as the principal stated it. */
  statement: string;
  budget: ObjectiveBudget;
  limits: ObjectiveLimits;
  /** Constraints the objective was started under, each independently stated. */
  constraints: string[];
  createdAt: string;
}

/**
 * The objective's total, which depletes for its whole life. There is nobody to grant
 * a top-up, so this is the outer bound on spend rather than a per-campaign cap, and
 * the loop draws each chunk's allocation from it.
 */
export interface ObjectiveBudget {
  maxTotalCostUsd: number;
  /** Null when no token ceiling was set; the cost ceiling still binds. */
  maxTotalTokens: number | null;
}

/**
 * Pace, as distinct from the budget above. These refill and shape how fast the loop
 * may move; the budget depletes and is what ends things. Conflating the two is how a
 * pace control gets mistaken for a stop condition.
 *
 * `maxCampaignsPerWindow` is also the graduated-autonomy dial: attended operation is
 * a small number here plus a person reading this record between windows.
 */
export interface ObjectiveLimits {
  maxCampaignsPerWindow: number;
  windowMs: number;
  /** Consecutive `blocked` or `capped` chunks after which the loop stops starting new ones. */
  maxConsecutiveFailedCampaigns: number;
}

/**
 * Deliberately slow. These are the numbers an objective gets when nobody chose any,
 * so they are set to the attended posture rather than a comfortable one: four
 * campaigns a day is a pace a person can actually read the record between, and the
 * cost of a default that is too slow is a delay, while the cost of one that is too
 * fast is unattended spend nobody reviewed.
 */
export const DEFAULT_OBJECTIVE_LIMITS: ObjectiveLimits = {
  maxCampaignsPerWindow: 4,
  windowMs: 24 * 60 * 60 * 1000,
  maxConsecutiveFailedCampaigns: 3,
};

/**
 * How a chunk ended. These are campaign statuses, not a parallel vocabulary, so a
 * new terminal campaign status has to be considered here rather than silently
 * absent — see `verdictsAreCampaignStatuses` below.
 */
export const OBJECTIVE_CHUNK_VERDICTS = [
  "completed",
  "blocked",
  "capped",
  "budget_exhausted",
] as const;

export type ObjectiveChunkVerdict = (typeof OBJECTIVE_CHUNK_VERDICTS)[number];

/** A compile-time assertion, not a runtime one. */
const verdictsAreCampaignStatuses: readonly CampaignStatus[] = OBJECTIVE_CHUNK_VERDICTS;
void verdictsAreCampaignStatuses;

/**
 * One finished chunk. Appended when its campaign reaches a terminal status, never
 * rewritten afterwards.
 *
 * `chunkId` is a content address over the statement and criteria, which is what lets
 * the loop recognise a chunk it has already tried. The roadmap's rule is that the
 * loop may not keep retrying variations of a failing chunk; an address turns that
 * from a hope into a comparison. It catches an exact restatement and not a
 * paraphrase, so it is a floor rather than the whole guarantee.
 */
export interface ObjectiveChunkRecord {
  /** 1-based and dense, so a gap means a lost append rather than a skipped chunk. */
  index: number;
  chunkId: string;
  campaignId: string;
  statement: string;
  criteria: string[];
  verdict: ObjectiveChunkVerdict;
  startedAt: string;
  finishedAt: string;
  costUsd: number;
}

/** Why an assessment was taken. The cadence case is the unprompted one. */
export const OBJECTIVE_ASSESSMENT_TRIGGERS = [
  "cadence",
  "campaign_blocked",
  "channel_exhausted",
  "survival_rate_fell",
  "question_unanswerable",
] as const;

export type ObjectiveAssessmentTrigger = (typeof OBJECTIVE_ASSESSMENT_TRIGGERS)[number];

/**
 * One recorded judgement of whether the objective is still reachable.
 *
 * The estimate is a number rather than a label because the *trajectory* is the thing
 * being kept: an estimate that declines slowly across forty cycles as evidence
 * accumulates is credible, and one that collapses from likely to hopeless in two
 * cycles right after the work got hard is an overlord looking for the exit. Only a
 * recorded history distinguishes those, and only an ordered numeric series makes the
 * distinction readable. No claim is made that the number is calibrated; its
 * direction over time is what is read.
 */
export interface ObjectiveAssessment {
  at: string;
  /** 0 through 1. Reachability of the objective with what remains. */
  estimate: number;
  trigger: ObjectiveAssessmentTrigger;
  /** What the estimate rested on, so a later reader can check it against the record. */
  basis: string[];
}

export const HALT_DELIVERY_STATES = ["unsent", "sent"] as const;
export type HaltDelivery = (typeof HALT_DELIVERY_STATES)[number];

/**
 * The halted state, persisted because an overlord that crashes and restarts must not
 * forget it halted — otherwise a process supervisor silently resumes spending
 * against the principal's silence.
 *
 * `delivery` exists because composing the report and sending it are separate acts
 * with a gap between them: until the human-contact ling tool lands, an overlord that
 * concludes an objective is hopeless halts holding an *unsent* report. And a reply
 * cannot be awaited for a report that was never sent, which is why `awaitingReply`
 * requires `sent`.
 *
 * The report's own contents are not stored here. Its shape is the business of the
 * item that gates it on cited evidence; this holds its address, so whatever shape it
 * takes can be pointed at without this record having guessed it.
 */
export interface ObjectiveHalt {
  at: string;
  reportId: string;
  summary: string;
  delivery: HaltDelivery;
  awaitingReply: boolean;
}

/**
 * One occasion on which the principal's reply re-formed the objective.
 *
 * It names the report it answers and the address of the charter it replaced, so the
 * record shows not just that the goal changed but which goal changed into which.
 */
export interface ObjectiveReform {
  at: string;
  reportId: string;
  priorCharterRevision: number;
  priorCharterAddress: string;
  note: string;
}

export interface ObjectiveManifest {
  version: typeof OBJECTIVE_VERSION;
  id: string;
  charter: ObjectiveCharter;
  currentProductSnapshot: ProductSnapshotPointer | null;
  /** Finished chunks, oldest first. Append-only; see `ObjectiveManifestStore`. */
  chunks: ObjectiveChunkRecord[];
  /** Viability assessments, oldest first. Append-only, because the trajectory is the point. */
  assessments: ObjectiveAssessment[];
  reforms: ObjectiveReform[];
  halt: ObjectiveHalt | null;
  updatedAt: string;
}

export interface ProductSnapshotFile {
  /** Original path reported by the campaign artifact. */
  path: string;
  /** Objective-owned, content-addressed copy of the artifact. */
  artifact: ArtifactRef;
}

export interface ProductSnapshotManifest {
  version: typeof PRODUCT_SNAPSHOT_VERSION;
  objectiveId: string;
  parent: ProductSnapshotPointer | null;
  campaignId: string;
  campaignUpdatedAt: string;
  createdAt: string;
  files: ProductSnapshotFile[];
}

export class ObjectiveSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObjectiveSchemaError";
  }
}

function fail(location: string, message: string): never {
  throw new ObjectiveSchemaError(`${location}: ${message}`);
}

function object(value: unknown, location: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(location, "must be an object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  location: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  const missing = allowed.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length > 0) fail(location, `unknown field(s): ${unknown.join(", ")}`);
  if (missing.length > 0) fail(location, `missing field(s): ${missing.join(", ")}`);
}

function nonemptyString(value: unknown, location: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    fail(location, "must be a non-empty string");
  }
  return value;
}

function isoDate(value: unknown, location: string): string {
  const parsed = nonemptyString(value, location);
  if (Number.isNaN(Date.parse(parsed))) fail(location, "must be an ISO date");
  return parsed;
}

function sha256(value: unknown, location: string): string {
  const parsed = nonemptyString(value, location);
  if (!/^[a-f0-9]{64}$/.test(parsed)) {
    fail(location, "must be a lowercase SHA-256 hex digest");
  }
  return parsed;
}

/** A `sha256:`-prefixed content address, as `contentAddress` produces. */
function address(value: unknown, location: string): string {
  const parsed = nonemptyString(value, location);
  if (!/^sha256:[a-f0-9]{64}$/.test(parsed)) {
    fail(location, "must be a sha256 content address");
  }
  return parsed;
}

function positiveInteger(value: unknown, location: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    fail(location, "must be a positive integer");
  }
  return value;
}

function positiveNumber(value: unknown, location: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    fail(location, "must be a positive number");
  }
  return value;
}

function nonnegativeNumber(value: unknown, location: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail(location, "must be a non-negative number");
  }
  return value;
}

function boolean(value: unknown, location: string): boolean {
  if (typeof value !== "boolean") fail(location, "must be a boolean");
  return value;
}

/**
 * Prose the record stores and, in most cases, later puts in a prompt. Normalized
 * through the same path as pooled facts, so an invisible character cannot ride into
 * a prompt inside a goal any more than inside a claim.
 */
function prose(value: unknown, location: string, maxChars: number): string {
  if (typeof value !== "string") fail(location, "must be a string");
  const collapsed = collapseToSingleLine(value);
  if (collapsed === "") fail(location, "must not be blank");
  if (collapsed.length > maxChars) {
    fail(location, `must be at most ${maxChars} characters, got ${collapsed.length}`);
  }
  return collapsed;
}

function proseList(
  value: unknown,
  location: string,
  options: { maxEntries: number; maxChars: number; unique?: boolean },
): string[] {
  if (!Array.isArray(value)) fail(location, "must be an array");
  if (value.length > options.maxEntries) {
    fail(location, `must contain at most ${options.maxEntries} entries`);
  }
  const entries = value.map((entry, index) =>
    prose(entry, `${location}[${index}]`, options.maxChars),
  );
  if (options.unique === true) {
    const seen = new Set<string>();
    for (const entry of entries) {
      if (seen.has(entry)) fail(location, "must not contain duplicates");
      seen.add(entry);
    }
  }
  return entries;
}

function member<T extends string>(
  value: unknown,
  allowed: readonly T[],
  location: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    fail(location, `must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

export function parseProductPath(value: unknown, location = "product path"): string {
  const parsed = nonemptyString(value, location);
  const normalized = path.posix.normalize(parsed);
  if (
    parsed.includes("\\") ||
    path.posix.isAbsolute(parsed) ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized !== parsed
  ) {
    fail(location, "must be a normalized relative POSIX path");
  }
  return parsed;
}

function parseArtifact(value: unknown, location: string): ArtifactRef {
  const raw = object(value, location);
  exactKeys(raw, ["artifactId", "path", "sha256"], location);
  const digest = sha256(raw["sha256"], `${location}.sha256`);
  const artifactId = nonemptyString(raw["artifactId"], `${location}.artifactId`);
  if (artifactId !== `sha256:${digest}`) {
    fail(`${location}.artifactId`, "must identify the artifact's SHA-256 digest");
  }
  return {
    artifactId,
    path: parseProductPath(raw["path"], `${location}.path`),
    sha256: digest,
  };
}

export function parseProductSnapshotPointer(
  value: unknown,
  location = "product snapshot pointer",
): ProductSnapshotPointer {
  const raw = object(value, location);
  exactKeys(raw, ["snapshotId", "path", "sha256"], location);
  const digest = sha256(raw["sha256"], `${location}.sha256`);
  const snapshotId = nonemptyString(raw["snapshotId"], `${location}.snapshotId`);
  if (snapshotId !== `sha256:${digest}`) {
    fail(`${location}.snapshotId`, "must identify the snapshot manifest's SHA-256 digest");
  }
  const snapshotPath = parseProductPath(raw["path"], `${location}.path`);
  if (snapshotPath !== `snapshots/${digest}.json`) {
    fail(`${location}.path`, "must be the content-addressed snapshot manifest path");
  }
  return { snapshotId, path: snapshotPath, sha256: digest };
}

/**
 * The address of a chunk: what it asked for, and what would have to be true for it to
 * count as done. Both, because a statement re-attempted under weaker criteria is not
 * the same chunk, and treating it as one would let the loop launder a failure into a
 * pass by lowering the bar.
 */
export function chunkAddress(statement: string, criteria: readonly string[]): string {
  // Criteria are a set, not a sequence: they are checked independently and the schema
  // already forbids duplicates, so their order is presentation. Sorting before hashing
  // is what stops the repeat check being defeated by a model that re-emits the same
  // criteria in a different order — which is exactly what a model asked to try again
  // is likely to do. Sorted by code unit rather than locale, because a locale-
  // dependent address would differ between machines.
  const normalized = criteria.map((criterion) => collapseToSingleLine(criterion)).sort();
  return contentAddress(["chunk", collapseToSingleLine(statement), ...normalized]);
}

/**
 * The address of a charter, used to compare two of them and to record which one a
 * reform replaced. Positional, so a field added to `ObjectiveCharter` must be added
 * here too or it will not be covered by the comparison.
 */
export function charterAddress(charter: ObjectiveCharter): string {
  return contentAddress([
    "charter",
    String(charter.revision),
    charter.statement,
    charter.budget.maxTotalCostUsd.toString(),
    charter.budget.maxTotalTokens === null ? "null" : charter.budget.maxTotalTokens.toString(),
    charter.limits.maxCampaignsPerWindow.toString(),
    charter.limits.windowMs.toString(),
    charter.limits.maxConsecutiveFailedCampaigns.toString(),
    charter.createdAt,
    String(charter.constraints.length),
    ...charter.constraints,
  ]);
}

export function parseObjectiveBudget(value: unknown, location = "objective.charter.budget"): ObjectiveBudget {
  const raw = object(value, location);
  exactKeys(raw, ["maxTotalCostUsd", "maxTotalTokens"], location);
  return {
    maxTotalCostUsd: positiveNumber(raw["maxTotalCostUsd"], `${location}.maxTotalCostUsd`),
    maxTotalTokens:
      raw["maxTotalTokens"] === null
        ? null
        : positiveInteger(raw["maxTotalTokens"], `${location}.maxTotalTokens`),
  };
}

export function parseObjectiveLimits(value: unknown, location = "objective.charter.limits"): ObjectiveLimits {
  const raw = object(value, location);
  exactKeys(
    raw,
    ["maxCampaignsPerWindow", "windowMs", "maxConsecutiveFailedCampaigns"],
    location,
  );
  return {
    maxCampaignsPerWindow: positiveInteger(
      raw["maxCampaignsPerWindow"],
      `${location}.maxCampaignsPerWindow`,
    ),
    windowMs: positiveInteger(raw["windowMs"], `${location}.windowMs`),
    maxConsecutiveFailedCampaigns: positiveInteger(
      raw["maxConsecutiveFailedCampaigns"],
      `${location}.maxConsecutiveFailedCampaigns`,
    ),
  };
}

export function parseObjectiveCharter(
  value: unknown,
  location = "objective.charter",
): ObjectiveCharter {
  const raw = object(value, location);
  exactKeys(
    raw,
    ["revision", "statement", "budget", "limits", "constraints", "createdAt"],
    location,
  );
  return {
    revision: positiveInteger(raw["revision"], `${location}.revision`),
    statement: prose(raw["statement"], `${location}.statement`, MAX_OBJECTIVE_STATEMENT_CHARS),
    budget: parseObjectiveBudget(raw["budget"], `${location}.budget`),
    limits: parseObjectiveLimits(raw["limits"], `${location}.limits`),
    constraints: proseList(raw["constraints"], `${location}.constraints`, {
      maxEntries: MAX_OBJECTIVE_CONSTRAINTS,
      maxChars: MAX_CONSTRAINT_CHARS,
      unique: true,
    }),
    createdAt: isoDate(raw["createdAt"], `${location}.createdAt`),
  };
}

function parseChunks(value: unknown, location: string): ObjectiveChunkRecord[] {
  if (!Array.isArray(value)) fail(location, "must be an array");
  if (value.length > MAX_OBJECTIVE_CHUNKS) {
    fail(location, `must contain at most ${MAX_OBJECTIVE_CHUNKS} entries`);
  }
  return value.map((entry, position): ObjectiveChunkRecord => {
    const at = `${location}[${position}]`;
    const raw = object(entry, at);
    exactKeys(
      raw,
      [
        "index",
        "chunkId",
        "campaignId",
        "statement",
        "criteria",
        "verdict",
        "startedAt",
        "finishedAt",
        "costUsd",
      ],
      at,
    );
    const index = positiveInteger(raw["index"], `${at}.index`);
    if (index !== position + 1) {
      fail(`${at}.index`, `must be ${position + 1} for a dense, ordered history`);
    }
    const statement = prose(raw["statement"], `${at}.statement`, MAX_CHUNK_STATEMENT_CHARS);
    const criteria = proseList(raw["criteria"], `${at}.criteria`, {
      maxEntries: MAX_CHUNK_CRITERIA,
      maxChars: MAX_CRITERION_CHARS,
      unique: true,
    });
    if (criteria.length === 0) {
      fail(`${at}.criteria`, "must contain at least one criterion");
    }
    const chunkId = address(raw["chunkId"], `${at}.chunkId`);
    if (chunkId !== chunkAddress(statement, criteria)) {
      fail(`${at}.chunkId`, "must address the chunk's own statement and criteria");
    }
    const startedAt = isoDate(raw["startedAt"], `${at}.startedAt`);
    const finishedAt = isoDate(raw["finishedAt"], `${at}.finishedAt`);
    if (Date.parse(finishedAt) < Date.parse(startedAt)) {
      fail(`${at}.finishedAt`, "must not precede startedAt");
    }
    return {
      index,
      chunkId,
      campaignId: nonemptyString(raw["campaignId"], `${at}.campaignId`),
      statement,
      criteria,
      verdict: member(raw["verdict"], OBJECTIVE_CHUNK_VERDICTS, `${at}.verdict`),
      startedAt,
      finishedAt,
      costUsd: nonnegativeNumber(raw["costUsd"], `${at}.costUsd`),
    };
  });
}

function parseAssessments(value: unknown, location: string): ObjectiveAssessment[] {
  if (!Array.isArray(value)) fail(location, "must be an array");
  if (value.length > MAX_OBJECTIVE_ASSESSMENTS) {
    fail(location, `must contain at most ${MAX_OBJECTIVE_ASSESSMENTS} entries`);
  }
  const assessments = value.map((entry, position): ObjectiveAssessment => {
    const at = `${location}[${position}]`;
    const raw = object(entry, at);
    exactKeys(raw, ["at", "estimate", "trigger", "basis"], at);
    const estimate = raw["estimate"];
    if (typeof estimate !== "number" || !Number.isFinite(estimate) || estimate < 0 || estimate > 1) {
      fail(`${at}.estimate`, "must be a number between 0 and 1");
    }
    return {
      at: isoDate(raw["at"], `${at}.at`),
      estimate,
      trigger: member(raw["trigger"], OBJECTIVE_ASSESSMENT_TRIGGERS, `${at}.trigger`),
      basis: proseList(raw["basis"], `${at}.basis`, {
        maxEntries: MAX_ASSESSMENT_BASIS,
        maxChars: MAX_BASIS_CHARS,
      }),
    };
  });
  // Non-strict, because two assessments can share a millisecond and a clock can be
  // adjusted; what matters is that the series is not reordered, since the trajectory
  // is the evidence.
  for (let index = 1; index < assessments.length; index += 1) {
    if (Date.parse(assessments[index]!.at) < Date.parse(assessments[index - 1]!.at)) {
      fail(`${location}[${index}].at`, "must not precede the assessment before it");
    }
  }
  return assessments;
}

function parseReforms(value: unknown, location: string): ObjectiveReform[] {
  if (!Array.isArray(value)) fail(location, "must be an array");
  if (value.length > MAX_OBJECTIVE_REFORMS) {
    fail(location, `must contain at most ${MAX_OBJECTIVE_REFORMS} entries`);
  }
  return value.map((entry, position): ObjectiveReform => {
    const at = `${location}[${position}]`;
    const raw = object(entry, at);
    exactKeys(raw, ["at", "reportId", "priorCharterRevision", "priorCharterAddress", "note"], at);
    const priorCharterRevision = positiveInteger(
      raw["priorCharterRevision"],
      `${at}.priorCharterRevision`,
    );
    if (priorCharterRevision !== position + 1) {
      fail(`${at}.priorCharterRevision`, `must be ${position + 1} for an ordered history`);
    }
    return {
      at: isoDate(raw["at"], `${at}.at`),
      reportId: address(raw["reportId"], `${at}.reportId`),
      priorCharterRevision,
      priorCharterAddress: address(raw["priorCharterAddress"], `${at}.priorCharterAddress`),
      note: prose(raw["note"], `${at}.note`, MAX_CONSTRAINT_CHARS),
    };
  });
}

function parseHalt(value: unknown, location: string): ObjectiveHalt | null {
  if (value === null) return null;
  const raw = object(value, location);
  exactKeys(raw, ["at", "reportId", "summary", "delivery", "awaitingReply"], location);
  const delivery = member(raw["delivery"], HALT_DELIVERY_STATES, `${location}.delivery`);
  const awaitingReply = boolean(raw["awaitingReply"], `${location}.awaitingReply`);
  if (awaitingReply && delivery !== "sent") {
    fail(`${location}.awaitingReply`, "must be false while the report is unsent");
  }
  return {
    at: isoDate(raw["at"], `${location}.at`),
    reportId: address(raw["reportId"], `${location}.reportId`),
    summary: prose(raw["summary"], `${location}.summary`, MAX_HALT_SUMMARY_CHARS),
    delivery,
    awaitingReply,
  };
}

export function parseObjectiveManifest(value: unknown): ObjectiveManifest {
  const raw = object(value, "objective");
  exactKeys(
    raw,
    [
      "version",
      "id",
      "charter",
      "currentProductSnapshot",
      "chunks",
      "assessments",
      "reforms",
      "halt",
      "updatedAt",
    ],
    "objective",
  );
  if (raw["version"] !== OBJECTIVE_VERSION) {
    fail("objective.version", `unsupported version ${String(raw["version"])}`);
  }
  const charter = parseObjectiveCharter(raw["charter"], "objective.charter");
  const reforms = parseReforms(raw["reforms"], "objective.reforms");
  // The charter's revision is not free-standing: it counts the recorded reforms that
  // produced it. A record claiming revision 4 with two reforms has lost the evidence
  // for two changes of goal, which is the audit trail this grouping exists to keep.
  if (charter.revision !== reforms.length + 1) {
    fail(
      "objective.charter.revision",
      `must be ${reforms.length + 1}, one more than the ${reforms.length} recorded reform(s)`,
    );
  }
  return {
    version: OBJECTIVE_VERSION,
    id: nonemptyString(raw["id"], "objective.id"),
    charter,
    currentProductSnapshot:
      raw["currentProductSnapshot"] === null
        ? null
        : parseProductSnapshotPointer(
            raw["currentProductSnapshot"],
            "objective.currentProductSnapshot",
          ),
    chunks: parseChunks(raw["chunks"], "objective.chunks"),
    assessments: parseAssessments(raw["assessments"], "objective.assessments"),
    reforms,
    halt: parseHalt(raw["halt"], "objective.halt"),
    updatedAt: isoDate(raw["updatedAt"], "objective.updatedAt"),
  };
}

export function parseProductSnapshotManifest(value: unknown): ProductSnapshotManifest {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw new ObjectiveSchemaError(
      `product snapshot: must be JSON-serializable (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (encoded === undefined) fail("product snapshot", "must be JSON-serializable");
  if (Buffer.byteLength(encoded, "utf8") > MAX_PRODUCT_SNAPSHOT_MANIFEST_BYTES) {
    fail(
      "product snapshot",
      `must encode to at most ${MAX_PRODUCT_SNAPSHOT_MANIFEST_BYTES} UTF-8 bytes`,
    );
  }
  const raw = object(value, "product snapshot");
  exactKeys(
    raw,
    [
      "version",
      "objectiveId",
      "parent",
      "campaignId",
      "campaignUpdatedAt",
      "createdAt",
      "files",
    ],
    "product snapshot",
  );
  if (raw["version"] !== PRODUCT_SNAPSHOT_VERSION) {
    fail("product snapshot.version", `unsupported version ${String(raw["version"])}`);
  }
  if (!Array.isArray(raw["files"])) fail("product snapshot.files", "must be an array");
  if (raw["files"].length > MAX_PRODUCT_SNAPSHOT_FILES) {
    fail(
      "product snapshot.files",
      `must contain at most ${MAX_PRODUCT_SNAPSHOT_FILES} entries`,
    );
  }
  const files = raw["files"].map((value, index): ProductSnapshotFile => {
    const location = `product snapshot.files[${index}]`;
    const file = object(value, location);
    exactKeys(file, ["path", "artifact"], location);
    return {
      path: parseProductPath(file["path"], `${location}.path`),
      artifact: parseArtifact(file["artifact"], `${location}.artifact`),
    };
  });
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.path)) {
      fail("product snapshot.files", `contains duplicate path ${JSON.stringify(file.path)}`);
    }
    seen.add(file.path);
  }
  for (let index = 1; index < files.length; index += 1) {
    if (files[index - 1]!.path >= files[index]!.path) {
      fail("product snapshot.files", "must be sorted by path");
    }
  }
  return {
    version: PRODUCT_SNAPSHOT_VERSION,
    objectiveId: nonemptyString(raw["objectiveId"], "product snapshot.objectiveId"),
    parent:
      raw["parent"] === null
        ? null
        : parseProductSnapshotPointer(raw["parent"], "product snapshot.parent"),
    campaignId: nonemptyString(raw["campaignId"], "product snapshot.campaignId"),
    campaignUpdatedAt: isoDate(
      raw["campaignUpdatedAt"],
      "product snapshot.campaignUpdatedAt",
    ),
    createdAt: isoDate(raw["createdAt"], "product snapshot.createdAt"),
    files,
  };
}
