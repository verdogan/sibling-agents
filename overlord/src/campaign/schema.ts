import path from "node:path";
import { isTerminalStatus } from "../ling/events.js";
import type {
  LingHealth,
  LingInlineSkill,
  LingTaskStatus,
  LingThinkingLevel,
  LingWorkerVariant,
} from "../ling/types.js";
import type { CampaignBrainDecisionSource, CampaignBrainPhase } from "./brain.js";
import { dependencyCycle } from "./graph.js";
import { MAX_REPORTED_UNDECLARED } from "./intent.js";
import {
  CONCERN_CODES,
  CONCERN_SEVERITIES,
  EVENTS_COVERAGES,
  EVIDENCE_ID_PATTERN,
  HOLD_END_REASONS,
  HOLD_ID_PATTERN,
  HOLD_REQUEST_ID_PATTERN,
  LIFECYCLE_EVENTS,
  MESSAGE_ID_PATTERN,
  OVERSIGHT_LIMITS,
  OVERSIGHT_OUTCOMES,
  OVERSIGHT_WIRE_KINDS,
  PAIR_ID_PATTERN,
  QUESTION_ID_PATTERN,
  REF_PATTERN,
  SENSOR_COVERAGES,
  WATCH_CONDITIONS,
  modelFamily,
  watchedBuilderToolsRefused,
  workerOversightTools,
  type ConcernCode,
  type ConcernSeverity,
  type EventsCoverage,
  type FeedCursor,
  type HoldEndReason,
  type LifecycleFact,
  type OversightVerdict,
  type OversightWireKind,
  type SensorCoverage,
  type WatchCondition,
} from "./oversight.js";
import { campaignRequestKeyPrefix } from "./request-key.js";

export const CAMPAIGN_VERSION = 6 as const;

export type CampaignStatus =
  | "pending"
  | "running"
  | "blocked"
  | "completed"
  | "budget_exhausted"
  | "capped";

export type SliceStatus = "pending" | "building" | "reviewing" | "accepted" | "blocked" | "capped";
export type CampaignVerdict = "accept" | "revise" | "blocked";
/** The roles that do a campaign's work, each with a profile of its own. */
export type CampaignWorkRole = "planner" | "builder" | "reviewer" | "integration";
/**
 * Every role a campaign task can hold. A watcher is not a work role: it has no
 * profile, is spawned only as half of a builder's pair, and produces nothing a
 * slice is made of.
 */
export type CampaignRole = CampaignWorkRole | "watcher";
export type AcceptanceKind = "command" | "file" | "schema" | "human";
export type CampaignMessagePriority = "fyi" | "normal" | "urgent";
export type CampaignDecisionPhase = "planning" | "building" | "reviewing" | "integration";

export interface ArtifactRef {
  artifactId: string;
  path: string;
  sha256: string;
}

export interface AcceptanceCriterion {
  id: string;
  kind: AcceptanceKind;
  requirement: string;
}

export interface ReferenceBar {
  kind: "url" | "artifact";
  ref: string;
  appliesTo: string[];
}

export interface CampaignBudget {
  maxTasks: number;
  maxTotalCostUsd: number;
  /**
   * Optional cumulative token ceiling. Checked between worker tasks, since
   * Ling reports usage only after a model call has completed.
   */
  maxTotalTokens?: number;
}

export interface RoleProfile {
  tools: string[];
  maxCostUsd: number;
  maxTurns: number;
  maxWallClockMs: number;
  provider?: string;
  model?: string;
  thinking?: LingThinkingLevel;
  skills?: string[];
  inlineSkills?: LingInlineSkill[];
  instructions?: string;
  files?: Record<string, string>;
  sourceProfile?: {
    name: string;
    catalogueVersion: number;
    sha256: string;
  };
}

export type CampaignRoleProfiles = Record<CampaignWorkRole, RoleProfile>;

export interface PlanningState {
  status: "not_required" | "pending" | "running" | "completed" | "blocked";
  taskId: string | null;
  /** Independent planning tasks used only when negotiated planning is enabled. */
  candidateTaskIds: string[];
  /** One immutable, bundled proposal artifact per completed candidate task. */
  candidateArtifacts: ArtifactRef[];
  artifacts: ArtifactRef[];
  evidence: string[];
  gaps: string[];
}

export interface CampaignDecision {
  seq: number;
  at: string;
  phase: CampaignDecisionPhase;
  actor: string;
  action: string;
  rationale: string;
  refs: string[];
}

export interface CampaignMessage {
  seq: number;
  id: string;
  thread: string;
  fromTaskId: string;
  fromRole: CampaignWorkRole;
  fromSliceId: string | null;
  toSliceIds: string[];
  priority: CampaignMessagePriority;
  content: string;
  createdAt: string;
  deliveredToTaskIds: string[];
}

export interface CampaignCoordination {
  /** Master switch. While off, every optional behaviour below stays inactive. */
  enabled: boolean;
  /** One preserves the historical single-planner path; 2-3 enables synthesis. */
  planningCandidates: number;
  /** Requires every slice to declare an acyclic dependsOn list. */
  parallelSlices: boolean;
  /** Enables campaign_send and live delivery to simultaneously running slices. */
  passiveMessaging: boolean;
  maxMessages: number;
  maxMessageBytes: number;
  decisions: CampaignDecision[];
  messages: CampaignMessage[];
  /**
   * Pair every builder with a watcher (reports/oversight-wire.md). Optional
   * inside v6: a binary that predates it refuses the key rather than running
   * the campaign unwatched.
   */
  watch?: CampaignWatchConfig;
}

export interface CampaignWatchConfig {
  /** Whether a builder may run at all if its watcher does not start. Governs the start only. */
  required: boolean;
  condition: WatchCondition;
  /** B's model. Its `modelFamily` must differ from the builder's. Null only with no_watcher. */
  watcher: { provider: string; model: string; thinking?: LingThinkingLevel } | null;
  watcherMaxCostUsd: number;
  /** A scenario's "What to watch for" block for B's brief. Never names a planted defect. */
  watchFor?: string;
  /**
   * The builder's prompt variant (pilot plan §2.4), sent with the builder's
   * spawn and with no other task's. Unset is the standard worker prompt.
   * Optional inside v6, as `watch` is: a binary that predates it refuses the
   * key rather than running the builder on the standard prompt.
   */
  workerVariant?: LingWorkerVariant;
  /**
   * The campaign is a dry run: none of its tasks can reach a paid model,
   * because every role and the watcher are on a scripted model and the brain
   * is off (validatePairs). The one place a draft variant is admitted.
   */
  dryRun?: boolean;
}

/**
 * Each worker prompt variant's terms (pilot plan §2.4 and B8). Ling owns the
 * texts and refuses a variant whose tools do not fit it, but only at the
 * builder's spawn; the two packages share no code, so the terms are restated
 * here, and validatePairs refuses at initialize, and on every load, what
 * ling would refuse then.
 *
 * - `condition`: the one watch condition the variant's text is written for.
 * - `tools`: when set, the only tools ling runs the variant with. L0h's
 *   opening says the operator keeps none of A's tool calls, and a tool that
 *   keeps a record of its own, as declare_intent's intent_declared event
 *   does, would make that untrue.
 * - `draft`: the variant's text is still a draft. The owner's F8 decision:
 *   L1s and C− are built as drafts, dry-run at $0 and kept out of the pilot,
 *   and their length rule is settled before counted runs. A draft is
 *   admitted only in a dry run, so no paid run can carry one, whatever a
 *   batch plan says. Ling marks its draft texts in its own source. When one
 *   is made final there, its mark here is changed with it; until then the
 *   overlord is the stricter side, which fails closed.
 */
export const WORKER_VARIANTS: Readonly<
  Record<
    LingWorkerVariant,
    { condition: WatchCondition; tools?: readonly string[]; draft: boolean }
  >
> = {
  tools_unrecorded: {
    condition: "no_watcher",
    tools: ["read", "write", "edit", "ls", "bash", "tell_principal"],
    draft: false,
  },
  salience_matched: { condition: "no_watcher", draft: true },
  channel_unprompted: { condition: "channel", draft: true },
};
const workerVariants = Object.keys(WORKER_VARIANTS) as LingWorkerVariant[];

/**
 * How ling spells a scripted model's provider and model (its config.ts):
 * `scripted` or `scripted-<name>`. Only a ling given a script answers such a
 * model, Pi's registry has no provider by such a name, and a ling on a real
 * provider refuses a task that names one, so a role on one reaches no paid
 * model. That rests on the name alone: a Pi models.json that registered a
 * real provider under such a name would defeat it, and a manifest cannot
 * show there is none. Experiment runs give every child an empty agent
 * directory of its own (pilot plan §2.7).
 */
const SCRIPTED_MODEL_NAME = /^scripted(?:-[a-z0-9]+)*$/;

const watchStates = ["starting", "watching", "absent", "lost", "aborted", "settled"] as const;
export type WatchState = (typeof watchStates)[number];
const pairStartOutcomes = [
  "oversight_unsupported",
  "watcher_spawn_failed",
  "watcher_not_ready",
  "worker_spawn_failed",
] as const;
export type PairStartOutcome = (typeof pairStartOutcomes)[number];
const lostCauses = ["terminal", "stream_lost", "feed_undeliverable", "silent"] as const;
export type WatcherLostCause = (typeof lostCauses)[number];
const watcherOutcomes = [
  "ended_early",
  "final_undeliverable",
  "report_missing",
  "report_invalid",
] as const;
export type WatcherOutcome = (typeof watcherOutcomes)[number];

/** What a lease's /healthz advertised for oversight, as the pair recorded it. */
export type PairCapability = NonNullable<NonNullable<LingHealth["capabilities"]>["oversight"]>;

/** One message the overlord sent or will send, persisted before it is delivered. */
export interface PairMessageRecord {
  id: string;
  kind: OversightWireKind;
  to: "worker" | "watcher";
  thread: string;
  createdAt: string;
  /** The body of a message to A. Null for a feed, whose body is an artifact. */
  body: Record<string, unknown> | null;
  /** A feed body, pinned by its digest before it is sent. */
  artifact: ArtifactRef | null;
  attempts: number;
  deliveredAt: string | null;
  /** Why delivery stopped without a 2xx: a ling code, a status, `transport` or `worker_ended`. */
  undeliverable: string | null;
  /** The ling's `oversight_delivered` effect, once seen. */
  effect: string | null;
  /** When A's `oversight_shown` said the message entered its context. */
  shownAt: string | null;
}

const requestKinds = [
  "question",
  "note",
  "advice",
  "caution",
  "hold_request",
  "release_request",
  "concern",
] as const;

/** A question or note from A, or a request from B, with what became of it. */
export interface PairRequestRecord {
  /** `${taskId}:${seq}` of the source event, which is what makes a replay idempotent. */
  id: string;
  from: "worker" | "watcher";
  kind: (typeof requestKinds)[number];
  /** The ling-local id the request carries: q, p, c, h, hold or r. */
  ref: string;
  at: string;
  /** Null when accepted; otherwise the refusal code (§13.4). */
  code: string | null;
  text: string | null;
  evidence: string[];
  holdSelf: boolean | null;
  concernCode: ConcernCode | null;
  severity: ConcernSeverity | null;
  /** The hold this request allocated or named. */
  holdId: string | null;
  selfHold: "pending" | "applied" | "refused" | null;
  waitOutcome: "answered" | "timeout" | "aborted" | null;
}

export interface PairHoldRecord {
  holdId: string;
  origin: "watcher" | "worker";
  /** B's `h<k>` for a watcher hold. */
  requestId: string | null;
  /** A's `q<k>` for a self-hold. */
  questionId: string | null;
  reason: string | null;
  maxMs: number;
  status: "pending" | "active" | "ended" | "undeliverable";
  appliedAt: string | null;
  endedAt: string | null;
  endReason: HoldEndReason | null;
  escalatedAt: string | null;
  /** Released with no new fact reaching B between the hold and the release. */
  releasedOnWordsOnly: boolean | null;
  creditMs: number | null;
}

export interface PairEscalationRecord {
  id: string;
  thread: string;
  holdId: string;
  at: string;
}

export interface PairFeedState {
  /** The highest id of each kind any batch has considered. */
  cursor: FeedCursor;
  /** Claim ids held over to the next batch, in order. */
  deferred: string[];
  /** Feed ids used, which is also the number of the last batch built. */
  batches: number;
  regular: number;
  questions: number;
  final: number | null;
  /** Batches B's stream says it pulled: the overlord's only record of what B saw. */
  pulled: number[];
  heartbeats: number;
}

export interface PairCoverageRecord {
  events: EventsCoverage;
  sensor: SensorCoverage;
  watcher: "complete" | "incomplete" | "absent";
  reasons: string[];
}

export type PairVerdictRecord = OversightVerdict;

/** One worker and its watcher, persisted on the attempt the worker builds. */
export interface CampaignPairRecord {
  pairId: string;
  condition: WatchCondition;
  required: boolean;
  state: WatchState;
  watcherTaskId: string | null;
  workerTaskId: string | null;
  readyAt: string | null;
  /** Why the pair never ran, if it did not. */
  outcome: PairStartOutcome | null;
  outcomeDetail: string | null;
  lostCause: WatcherLostCause | null;
  watcherOutcome: WatcherOutcome | null;
  /** B's context was compacted, so its inputs were summarised by its own model. */
  compacted: boolean;
  capabilities: { worker: PairCapability | null; watcher: PairCapability | null };
  messages: PairMessageRecord[];
  facts: LifecycleFact[];
  requests: PairRequestRecord[];
  holds: PairHoldRecord[];
  escalations: PairEscalationRecord[];
  feed: PairFeedState;
  unshownCount: number;
  unshown: ArtifactRef | null;
  /** B's result: the validated report, or the raw value kept when it was invalid. */
  report: ArtifactRef | null;
  protocolErrors: string[];
  protocolErrorCount: number;
  coverage: PairCoverageRecord | null;
  verdict: PairVerdictRecord | null;
}

export interface CampaignBrainDecision {
  seq: number;
  key: string;
  at: string;
  phase: CampaignBrainPhase;
  source: CampaignBrainDecisionSource;
  model: string | null;
  action: string;
  rationale: string;
  arguments: Record<string, unknown>;
  legalActions: string[];
  stateHash: string;
  appliedAt: string | null;
}

export interface CampaignBrainState {
  /** Per-campaign opt-in. Deployment model configuration remains outside the manifest. */
  enabled: boolean;
  maxDecisions: number;
  maxHaltReopens: number;
  replansUsed: number;
  haltReopensUsed: number;
  /** Durable recovery intent retained until reconciliation reaches running. */
  pendingRecovery: {
    decisionKey: string;
    notBefore: string;
  } | null;
  decisions: CampaignBrainDecision[];
}

export interface SliceAttempt {
  round: number;
  builderId: string | null;
  reviewerId: string | null;
  artifacts: ArtifactRef[];
  verdict: CampaignVerdict | null;
  evidence: string[];
  gaps: string[];
  costUsd: number;
  /**
   * The builder's `findings.json`, collected because the overlord went and got
   * it rather than because the worker listed it. Kept out of `artifacts` on
   * purpose: those are the deliverables a dependent slice is seeded with, and
   * this is the evidence the deliverables rest on. Null when the task was not
   * granted the recording tool, or was and honestly recorded nothing.
   *
   * Optional so a manifest written before this field existed still parses.
   */
  findings?: ArtifactRef | null;
  /**
   * Which findings the reviewer was asked to re-fetch, and the seed that chose
   * them. Recorded at selection time so the choice replays exactly after a
   * restart, and so the audit trail shows what was asked before the answer came
   * back. Null when there were no findings to sample.
   */
  findingsSample?: {
    seed: string;
    ids: string[];
    candidates: number;
  } | null;
  /**
   * The reviewer's `verification.json`, collected the same way as `findings`.
   * Null when the reviewer was not asked to verify anything, or was and reported
   * nothing — which the gate reads as a skipped check, not as a pass.
   */
  verification?: ArtifactRef | null;
  /**
   * What the evidence gate concluded about this attempt. Persisted rather than
   * recomputed because it is the record of why a slice was or was not accepted,
   * and the artifacts it was computed from can be pruned.
   */
  findingsGate?: {
    outcome: "pass" | "fail" | "inconclusive" | "inapplicable";
    reasons: string[];
    survivalRate: number | null;
  } | null;
  /** The builder's watcher, when the campaign pairs its builders. */
  watch?: CampaignPairRecord;
}

export interface CampaignSlice {
  id: string;
  spec: ArtifactRef;
  status: SliceStatus;
  attempts: SliceAttempt[];
  /**
   * Zero for initial/planned slices. A slice introduced after integration round
   * N has only maxRounds-N attempts, so adding work cannot reset the round cap.
   */
  createdInRound: number;
  /**
   * Slice ids whose accepted output this slice's builder and reviewer need.
   * Omitted means every accepted slice is seeded, which is what campaigns
   * written before this field expect.
   */
  dependsOn?: string[];
}

export interface IntegrationAttempt {
  round: number;
  reviewerId: string | null;
  verdict: CampaignVerdict | null;
  evidence: string[];
  gaps: string[];
  affectedSliceIds: string[];
  retriesScheduled: boolean;
  costUsd: number;
}

export interface IntegrationState {
  reviewerId: string | null;
  verdict: CampaignVerdict | null;
  evidence: string[];
  gaps: string[];
  attempts: IntegrationAttempt[];
}

export type CampaignSeedChannel =
  | "planning_candidate"
  | "accepted"
  | "proposal"
  | "reference";

export interface CampaignSeededArtifact {
  artifact: ArtifactRef;
  destination: string;
  channel: CampaignSeedChannel;
}

export interface CampaignTaskRecord {
  id: string;
  requestKey?: string;
  workerId?: string;
  role: CampaignRole;
  sliceId: string | null;
  round: number;
  status: LingTaskStatus;
  costUsd: number;
  totalTokens: number;
  /**
   * Exact immutable artifacts and durable peer messages placed in this task's
   * initial context. A task adopted from the worker after a crash window reports
   * unavailable instead of pretending that an empty list means no context was
   * supplied.
   */
  seedProvenance: "recorded" | "unavailable";
  seededArtifacts: CampaignSeededArtifact[];
  seededMessageIds: string[];
  /**
   * Tools the worker actually received after fleet policy was applied.
   * Absent on records written before the grant was captured, and on adopted
   * crash-window tasks whose worker did not report one; those may recover it
   * from the worker's task record.
   */
  effectiveTools?: string[];
  /**
   * How this task's behaviour compared with what it declared it would do.
   * Absent on tasks that settled before the comparison existed; `unavailable`
   * when the history could not be read, which is not the same as clean.
   */
  intent?: CampaignIntentRecord;
  /** The pair this task belongs to, as worker or watcher. */
  pairId?: string;
  /** Set when the overlord had to kill the task's worker rather than wait for it. */
  terminated?: CampaignTaskTermination;
  /** Logs kept as artifacts before the task's worker was released. */
  logs?: CampaignTaskLogs;
  createdAt: string;
}

export interface CampaignTaskTermination {
  reason: "cancel-unconfirmed" | "worker-unreachable" | "expired" | "orphaned" | "operator";
  requestedAt: string;
  /** When the worker's process was confirmed gone; null while it could not be. */
  completedAt: string | null;
  errors: string[];
}

export interface CampaignTaskLogs {
  /** The overlord's own record of the task's stream. */
  record: ArtifactRef | null;
  /** The service's log (`GET /tasks/:id/log`), when it could be read. */
  service: ArtifactRef | null;
}

export const intentOutcomes = [
  "clean",
  "diverged",
  "undeclared",
  "inapplicable",
  "unavailable",
] as const;

export type CampaignIntentOutcome = (typeof intentOutcomes)[number];

export const intentObservationKinds = ["command", "host", "write"] as const;

export interface CampaignIntentObservation {
  kind: (typeof intentObservationKinds)[number];
  value: string;
  declaredLater: boolean;
}

export interface CampaignIntentRecord {
  outcome: CampaignIntentOutcome;
  declarations: number;
  /** Observed programs able to run others, which makes the command list a floor. */
  indirection: string[];
  observed: { commands: number; hosts: number; writes: number };
  undeclared: CampaignIntentObservation[];
  reasons: string[];
}

export type CampaignSummonState =
  | "prepared"
  | "spawned"
  | "collected"
  | "released"
  | "failed";

/**
 * Durable intent written before an external spawn. It carries hashes rather
 * than prompt/profile contents so manifests remain bounded and secret-free.
 */
export interface CampaignSummonIntent {
  requestKey: string;
  role: CampaignRole;
  sliceId: string | null;
  round: number;
  profileSha256: string;
  requestSha256: string;
  state: CampaignSummonState;
  workerId: string | null;
  taskId: string | null;
  preparedAt: string;
  updatedAt: string;
  error: string | null;
}

export interface CampaignManifest {
  version: typeof CAMPAIGN_VERSION;
  id: string;
  goal: string;
  status: CampaignStatus;
  acceptance: AcceptanceCriterion[];
  bar: ReferenceBar | null;
  allowPlanning: boolean;
  maxRounds: number;
  currentSliceId: string | null;
  slices: CampaignSlice[];
  planning: PlanningState;
  integration: IntegrationState;
  coordination: CampaignCoordination;
  brain: CampaignBrainState;
  budget: CampaignBudget;
  roles: CampaignRoleProfiles;
  tasks: CampaignTaskRecord[];
  summons: CampaignSummonIntent[];
  spentUsdSnapshot: number;
  spentTokensSnapshot: number;
  updatedAt: string;
}

const campaignStatuses: readonly CampaignStatus[] = [
  "pending",
  "running",
  "blocked",
  "completed",
  "budget_exhausted",
  "capped",
];
const sliceStatuses: readonly SliceStatus[] = [
  "pending",
  "building",
  "reviewing",
  "accepted",
  "blocked",
  "capped",
];
const verdicts: readonly CampaignVerdict[] = ["accept", "revise", "blocked"];
const workRoles: readonly CampaignWorkRole[] = ["planner", "builder", "reviewer", "integration"];
const taskRoles: readonly CampaignRole[] = [...workRoles, "watcher"];
const messagePriorities: readonly CampaignMessagePriority[] = ["fyi", "normal", "urgent"];
const decisionPhases: readonly CampaignDecisionPhase[] = [
  "planning",
  "building",
  "reviewing",
  "integration",
];
const brainPhases: readonly CampaignBrainPhase[] = [
  "scheduling",
  "reviewing",
  "integration",
  "recovery",
];
const brainDecisionSources: readonly CampaignBrainDecisionSource[] = ["model", "fallback"];
const acceptanceKinds: readonly AcceptanceKind[] = ["command", "file", "schema", "human"];
const seedChannels: readonly CampaignSeedChannel[] = [
  "planning_candidate",
  "accepted",
  "proposal",
  "reference",
];
const summonStates: readonly CampaignSummonState[] = [
  "prepared",
  "spawned",
  "collected",
  "released",
  "failed",
];
const thinkingLevels: readonly LingThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const lingTaskStatuses: readonly LingTaskStatus[] = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
];

export class CampaignSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CampaignSchemaError";
  }
}

function fail(location: string, message: string): never {
  throw new CampaignSchemaError(`${location}: ${message}`);
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
  if (unknown.length > 0) fail(location, `unknown field(s): ${unknown.join(", ")}`);
}

function string(value: unknown, location: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(location, "must be a non-empty string");
  return value;
}

function boundedString(value: unknown, location: string, maxLength: number): string {
  const parsed = string(value, location);
  if (parsed.length > maxLength) fail(location, `must be at most ${maxLength} characters`);
  return parsed;
}

function nullableString(value: unknown, location: string): string | null {
  return value === null ? null : string(value, location);
}

function stringArray(value: unknown, location: string): string[] {
  if (!Array.isArray(value)) fail(location, "must be an array");
  return value.map((item, index) => string(item, `${location}[${index}]`));
}

function finiteNonnegative(value: unknown, location: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail(location, "must be a finite non-negative number");
  }
  return value;
}

function positive(value: unknown, location: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    fail(location, "must be a positive finite number");
  }
  return value;
}

function positiveInteger(value: unknown, location: string): number {
  const parsed = positive(value, location);
  if (!Number.isInteger(parsed)) fail(location, "must be an integer");
  return parsed;
}

function safeNonnegativeInteger(value: unknown, location: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(location, "must be a safe non-negative integer");
  }
  return value;
}

function safePositiveInteger(value: unknown, location: string): number {
  const parsed = safeNonnegativeInteger(value, location);
  if (parsed === 0) fail(location, "must be positive");
  return parsed;
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  location: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    fail(location, `must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function intentRecord(value: unknown, location: string): CampaignIntentRecord {
  const raw = object(value, location);
  exactKeys(
    raw,
    ["outcome", "declarations", "indirection", "observed", "undeclared", "reasons"],
    location,
  );
  const observed = object(raw["observed"], `${location}.observed`);
  exactKeys(observed, ["commands", "hosts", "writes"], `${location}.observed`);
  const undeclaredRaw = raw["undeclared"];
  if (!Array.isArray(undeclaredRaw)) fail(`${location}.undeclared`, "must be an array");
  // Three kinds, each capped in `intent.ts`. A manifest that grew past that
  // was not written by this code.
  if (undeclaredRaw.length > MAX_REPORTED_UNDECLARED * 3) {
    fail(`${location}.undeclared`, `must contain at most ${MAX_REPORTED_UNDECLARED * 3} entries`);
  }
  return {
    outcome: enumValue(raw["outcome"], intentOutcomes, `${location}.outcome`),
    declarations: safeNonnegativeInteger(raw["declarations"], `${location}.declarations`),
    // Absent on records written before indirection was reported. An empty list
    // there means "not measured", which reads the same as "none observed"; the
    // task's status and date are what distinguish them.
    indirection:
      raw["indirection"] === undefined
        ? []
        : stringArray(raw["indirection"], `${location}.indirection`),
    observed: {
      commands: safeNonnegativeInteger(observed["commands"], `${location}.observed.commands`),
      hosts: safeNonnegativeInteger(observed["hosts"], `${location}.observed.hosts`),
      writes: safeNonnegativeInteger(observed["writes"], `${location}.observed.writes`),
    },
    undeclared: undeclaredRaw.map((item, index) => {
      const itemLocation = `${location}.undeclared[${index}]`;
      const entry = object(item, itemLocation);
      exactKeys(entry, ["kind", "value", "declaredLater"], itemLocation);
      if (typeof entry["declaredLater"] !== "boolean") {
        fail(`${itemLocation}.declaredLater`, "must be a boolean");
      }
      return {
        kind: enumValue(entry["kind"], intentObservationKinds, `${itemLocation}.kind`),
        value: string(entry["value"], `${itemLocation}.value`),
        declaredLater: entry["declaredLater"],
      };
    }),
    reasons: stringArray(raw["reasons"], `${location}.reasons`),
  };
}

function isoDate(value: unknown, location: string): string {
  const parsed = string(value, location);
  if (Number.isNaN(Date.parse(parsed))) fail(location, "must be an ISO date");
  return parsed;
}

function artifact(value: unknown, location: string): ArtifactRef {
  const raw = object(value, location);
  exactKeys(raw, ["artifactId", "path", "sha256"], location);
  const artifactPath = string(raw["path"], `${location}.path`);
  const normalized = path.posix.normalize(artifactPath);
  if (
    artifactPath.includes("\\") ||
    path.posix.isAbsolute(artifactPath) ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized !== artifactPath
  ) {
    fail(`${location}.path`, "must be a normalized relative POSIX path");
  }
  const sha256 = string(raw["sha256"], `${location}.sha256`);
  if (!/^[a-f0-9]{64}$/.test(sha256)) fail(`${location}.sha256`, "must be a lowercase SHA-256 hex digest");
  return {
    artifactId: string(raw["artifactId"], `${location}.artifactId`),
    path: artifactPath,
    sha256,
  };
}

function artifacts(value: unknown, location: string): ArtifactRef[] {
  if (!Array.isArray(value)) fail(location, "must be an array");
  return value.map((item, index) => artifact(item, `${location}[${index}]`));
}

function acceptance(value: unknown): AcceptanceCriterion[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail("manifest.acceptance", "must contain at least one criterion");
  }
  const result = value.map((item, index) => {
    const location = `manifest.acceptance[${index}]`;
    const raw = object(item, location);
    exactKeys(raw, ["id", "kind", "requirement"], location);
    return {
      id: string(raw["id"], `${location}.id`),
      kind: enumValue(raw["kind"], acceptanceKinds, `${location}.kind`),
      requirement: string(raw["requirement"], `${location}.requirement`),
    };
  });
  requireUnique(result.map((criterion) => criterion.id), "manifest.acceptance ids");
  return result;
}

function referenceBar(value: unknown, criteria: AcceptanceCriterion[]): ReferenceBar | null {
  if (value === null) return null;
  const location = "manifest.bar";
  const raw = object(value, location);
  exactKeys(raw, ["kind", "ref", "appliesTo"], location);
  const kind = enumValue(raw["kind"], ["url", "artifact"] as const, `${location}.kind`);
  const ref = string(raw["ref"], `${location}.ref`);
  if (kind === "url") {
    let parsed: URL;
    try {
      parsed = new URL(ref);
    } catch {
      fail(`${location}.ref`, "must be an absolute URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      fail(`${location}.ref`, "must use http or https");
    }
  }
  const appliesTo = stringArray(raw["appliesTo"], `${location}.appliesTo`);
  if (appliesTo.length === 0) fail(`${location}.appliesTo`, "must not be empty");
  requireUnique(appliesTo, `${location}.appliesTo`);
  const criterionIds = new Set(criteria.map((criterion) => criterion.id));
  const unknown = appliesTo.filter((id) => !criterionIds.has(id));
  if (unknown.length > 0) {
    fail(`${location}.appliesTo`, `unknown acceptance criterion id(s): ${unknown.join(", ")}`);
  }
  return { kind, ref, appliesTo };
}

function roleProfile(value: unknown, location: string): RoleProfile {
  const raw = object(value, location);
  exactKeys(
    raw,
    [
      "tools",
      "maxCostUsd",
      "maxTurns",
      "maxWallClockMs",
      "provider",
      "model",
      "thinking",
      "skills",
      "inlineSkills",
      "instructions",
      "files",
      "sourceProfile",
    ],
    location,
  );
  const tools = stringArray(raw["tools"], `${location}.tools`);
  if (tools.length === 0) fail(`${location}.tools`, "must not be empty");
  requireUnique(tools, `${location}.tools`);
  const result: RoleProfile = {
    tools,
    maxCostUsd: positive(raw["maxCostUsd"], `${location}.maxCostUsd`),
    maxTurns: positiveInteger(raw["maxTurns"], `${location}.maxTurns`),
    maxWallClockMs: positiveInteger(raw["maxWallClockMs"], `${location}.maxWallClockMs`),
  };
  if (raw["provider"] !== undefined) {
    result.provider = boundedString(raw["provider"], `${location}.provider`, 256);
  }
  if (raw["model"] !== undefined) result.model = string(raw["model"], `${location}.model`);
  if (raw["thinking"] !== undefined) {
    result.thinking = enumValue(raw["thinking"], thinkingLevels, `${location}.thinking`);
  }
  if (raw["skills"] !== undefined) {
    const skills = stringArray(raw["skills"], `${location}.skills`);
    if (skills.length > 16) fail(`${location}.skills`, "must contain at most 16 ids");
    requireUnique(skills, `${location}.skills`);
    skills.forEach((skill, index) => {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill) || skill.length > 64) {
        fail(
          `${location}.skills[${index}]`,
          "must use 1-64 lowercase letters, digits, and single hyphens",
        );
      }
    });
    result.skills = skills;
  }
  if (raw["inlineSkills"] !== undefined) {
    if (!Array.isArray(raw["inlineSkills"])) fail(`${location}.inlineSkills`, "must be an array");
    if (raw["inlineSkills"].length > 8) {
      fail(`${location}.inlineSkills`, "must contain at most 8 entries");
    }
    let totalBytes = 0;
    const seen = new Set(result.skills ?? []);
    result.inlineSkills = raw["inlineSkills"].map((item, index) => {
      const itemLocation = `${location}.inlineSkills[${index}]`;
      const skill = object(item, itemLocation);
      exactKeys(skill, ["name", "content"], itemLocation);
      const name = boundedString(skill["name"], `${itemLocation}.name`, 64);
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
        fail(`${itemLocation}.name`, "must use lowercase letters, digits, and single hyphens");
      }
      if (seen.has(name)) fail(`${itemLocation}.name`, "duplicates another selected skill");
      seen.add(name);
      const content = string(skill["content"], `${itemLocation}.content`);
      const bytes = Buffer.byteLength(content, "utf8");
      if (bytes > 16 * 1024) fail(`${itemLocation}.content`, "must be at most 16384 UTF-8 bytes");
      totalBytes += bytes;
      if (totalBytes > 64 * 1024) {
        fail(`${location}.inlineSkills`, "must total at most 65536 UTF-8 bytes");
      }
      return { name, content };
    });
  }
  if ((result.skills?.length ?? 0) + (result.inlineSkills?.length ?? 0) > 16) {
    fail(location, "may select at most 16 named and inline skills in total");
  }
  if (raw["instructions"] !== undefined) {
    const instructions = raw["instructions"];
    if (typeof instructions !== "string" || instructions.trim() === "") {
      fail(`${location}.instructions`, "must be a non-empty string");
    }
    if (instructions.length > 4000) {
      fail(`${location}.instructions`, "must be at most 4000 characters");
    }
    result.instructions = instructions;
  }
  if (raw["files"] !== undefined) {
    const files = object(raw["files"], `${location}.files`);
    const entries = Object.entries(files);
    if (entries.length === 0 || entries.length > 20) {
      fail(`${location}.files`, "must contain between 1 and 20 entries");
    }
    let totalBytes = 0;
    const parsed: Record<string, string> = {};
    for (const [filename, content] of entries) {
      const normalized = path.posix.normalize(filename);
      if (
        filename.length > 240 ||
        filename.includes("\\") ||
        path.posix.isAbsolute(filename) ||
        normalized === ".." ||
        normalized.startsWith("../") ||
        normalized !== filename
      ) {
        fail(`${location}.files`, `contains invalid path ${JSON.stringify(filename)}`);
      }
      if (typeof content !== "string") {
        fail(`${location}.files[${JSON.stringify(filename)}]`, "must be a string");
      }
      totalBytes += Buffer.byteLength(content, "utf8");
      if (totalBytes > 256 * 1024) {
        fail(`${location}.files`, "must total at most 262144 UTF-8 bytes");
      }
      parsed[filename] = content;
    }
    result.files = parsed;
  }
  if (raw["sourceProfile"] !== undefined) {
    const source = object(raw["sourceProfile"], `${location}.sourceProfile`);
    exactKeys(source, ["name", "catalogueVersion", "sha256"], `${location}.sourceProfile`);
    const digest = string(source["sha256"], `${location}.sourceProfile.sha256`);
    if (!/^[a-f0-9]{64}$/.test(digest)) {
      fail(`${location}.sourceProfile.sha256`, "must be a lowercase SHA-256 digest");
    }
    result.sourceProfile = {
      name: boundedString(source["name"], `${location}.sourceProfile.name`, 128),
      catalogueVersion: positiveInteger(
        source["catalogueVersion"],
        `${location}.sourceProfile.catalogueVersion`,
      ),
      sha256: digest,
    };
  }
  return result;
}

function roleProfiles(value: unknown): CampaignRoleProfiles {
  const raw = object(value, "manifest.roles");
  exactKeys(raw, workRoles, "manifest.roles");
  return {
    planner: roleProfile(raw["planner"], "manifest.roles.planner"),
    builder: roleProfile(raw["builder"], "manifest.roles.builder"),
    reviewer: roleProfile(raw["reviewer"], "manifest.roles.reviewer"),
    integration: roleProfile(raw["integration"], "manifest.roles.integration"),
  };
}

function planning(value: unknown): PlanningState {
  const location = "manifest.planning";
  const raw = object(value, location);
  exactKeys(
    raw,
    [
      "status",
      "taskId",
      "candidateTaskIds",
      "candidateArtifacts",
      "artifacts",
      "evidence",
      "gaps",
    ],
    location,
  );
  return {
    status: enumValue(
      raw["status"],
      ["not_required", "pending", "running", "completed", "blocked"] as const,
      `${location}.status`,
    ),
    taskId: nullableString(raw["taskId"], `${location}.taskId`),
    candidateTaskIds: stringArray(raw["candidateTaskIds"], `${location}.candidateTaskIds`),
    candidateArtifacts: artifacts(raw["candidateArtifacts"], `${location}.candidateArtifacts`),
    artifacts: artifacts(raw["artifacts"], `${location}.artifacts`),
    evidence: stringArray(raw["evidence"], `${location}.evidence`),
    gaps: stringArray(raw["gaps"], `${location}.gaps`),
  };
}

function coordination(value: unknown): CampaignCoordination {
  const location = "manifest.coordination";
  const raw = object(value, location);
  exactKeys(
    raw,
    [
      "enabled",
      "planningCandidates",
      "parallelSlices",
      "passiveMessaging",
      "maxMessages",
      "maxMessageBytes",
      "decisions",
      "messages",
      "watch",
    ],
    location,
  );
  for (const key of ["enabled", "parallelSlices", "passiveMessaging"] as const) {
    if (typeof raw[key] !== "boolean") fail(`${location}.${key}`, "must be a boolean");
  }
  const planningCandidates = positiveInteger(
    raw["planningCandidates"],
    `${location}.planningCandidates`,
  );
  if (planningCandidates > 3) {
    fail(`${location}.planningCandidates`, "must be at most 3");
  }
  const maxMessages = positiveInteger(raw["maxMessages"], `${location}.maxMessages`);
  if (maxMessages > 64) {
    fail(`${location}.maxMessages`, "must be at most 64 to match Ling's per-task inbox bound");
  }
  const maxMessageBytes = positiveInteger(
    raw["maxMessageBytes"],
    `${location}.maxMessageBytes`,
  );
  if (maxMessageBytes > 16 * 1024) {
    fail(`${location}.maxMessageBytes`, "must be at most 16384");
  }

  if (!Array.isArray(raw["decisions"])) fail(`${location}.decisions`, "must be an array");
  const decisions = raw["decisions"].map((item, index): CampaignDecision => {
    const itemLocation = `${location}.decisions[${index}]`;
    const decision = object(item, itemLocation);
    exactKeys(
      decision,
      ["seq", "at", "phase", "actor", "action", "rationale", "refs"],
      itemLocation,
    );
    return {
      seq: positiveInteger(decision["seq"], `${itemLocation}.seq`),
      at: isoDate(decision["at"], `${itemLocation}.at`),
      phase: enumValue(decision["phase"], decisionPhases, `${itemLocation}.phase`),
      actor: boundedString(decision["actor"], `${itemLocation}.actor`, 128),
      action: boundedString(decision["action"], `${itemLocation}.action`, 128),
      rationale: boundedString(decision["rationale"], `${itemLocation}.rationale`, 4096),
      refs: stringArray(decision["refs"], `${itemLocation}.refs`).map((ref, refIndex) =>
        boundedString(ref, `${itemLocation}.refs[${refIndex}]`, 256),
      ),
    };
  });
  if (decisions.length > 256) fail(`${location}.decisions`, "must contain at most 256 entries");

  if (!Array.isArray(raw["messages"])) fail(`${location}.messages`, "must be an array");
  const messages = raw["messages"].map((item, index): CampaignMessage => {
    const itemLocation = `${location}.messages[${index}]`;
    const message = object(item, itemLocation);
    exactKeys(
      message,
      [
        "seq",
        "id",
        "thread",
        "fromTaskId",
        "fromRole",
        "fromSliceId",
        "toSliceIds",
        "priority",
        "content",
        "createdAt",
        "deliveredToTaskIds",
      ],
      itemLocation,
    );
    return {
      seq: positiveInteger(message["seq"], `${itemLocation}.seq`),
      id: boundedString(message["id"], `${itemLocation}.id`, 128),
      thread: boundedString(message["thread"], `${itemLocation}.thread`, 128),
      fromTaskId: boundedString(message["fromTaskId"], `${itemLocation}.fromTaskId`, 128),
      fromRole: enumValue(message["fromRole"], workRoles, `${itemLocation}.fromRole`),
      fromSliceId: nullableString(message["fromSliceId"], `${itemLocation}.fromSliceId`),
      toSliceIds: stringArray(message["toSliceIds"], `${itemLocation}.toSliceIds`),
      priority: enumValue(
        message["priority"],
        messagePriorities,
        `${itemLocation}.priority`,
      ),
      content: boundedString(message["content"], `${itemLocation}.content`, maxMessageBytes),
      createdAt: isoDate(message["createdAt"], `${itemLocation}.createdAt`),
      deliveredToTaskIds: stringArray(
        message["deliveredToTaskIds"],
        `${itemLocation}.deliveredToTaskIds`,
      ),
    };
  });
  if (messages.length > maxMessages) {
    fail(`${location}.messages`, `must contain at most ${maxMessages} entries`);
  }

  return {
    enabled: raw["enabled"] as boolean,
    planningCandidates,
    parallelSlices: raw["parallelSlices"] as boolean,
    passiveMessaging: raw["passiveMessaging"] as boolean,
    maxMessages,
    maxMessageBytes,
    decisions,
    messages,
    ...(raw["watch"] === undefined
      ? {}
      : { watch: watchConfig(raw["watch"], `${location}.watch`) }),
  };
}

function watchConfig(value: unknown, location: string): CampaignWatchConfig {
  const raw = object(value, location);
  exactKeys(
    raw,
    ["required", "condition", "watcher", "watcherMaxCostUsd", "watchFor", "workerVariant", "dryRun"],
    location,
  );
  if (typeof raw["required"] !== "boolean") fail(`${location}.required`, "must be a boolean");
  if (raw["dryRun"] !== undefined && typeof raw["dryRun"] !== "boolean") {
    fail(`${location}.dryRun`, "must be a boolean");
  }
  const condition = enumValue(raw["condition"], WATCH_CONDITIONS, `${location}.condition`);
  let watcher: CampaignWatchConfig["watcher"] = null;
  if (raw["watcher"] !== null) {
    const model = object(raw["watcher"], `${location}.watcher`);
    exactKeys(model, ["provider", "model", "thinking"], `${location}.watcher`);
    watcher = {
      provider: boundedString(model["provider"], `${location}.watcher.provider`, 256),
      model: boundedString(model["model"], `${location}.watcher.model`, 256),
      ...(model["thinking"] === undefined
        ? {}
        : {
            thinking: enumValue(model["thinking"], thinkingLevels, `${location}.watcher.thinking`),
          }),
    };
  }
  if ((watcher === null) !== (condition === "no_watcher")) {
    fail(
      `${location}.watcher`,
      condition === "no_watcher"
        ? "must be null: condition no_watcher has no watcher to configure"
        : `must be set: condition ${condition} requires watcher.provider and watcher.model`,
    );
  }
  return {
    required: raw["required"],
    condition,
    watcher,
    watcherMaxCostUsd: positive(raw["watcherMaxCostUsd"], `${location}.watcherMaxCostUsd`),
    ...(raw["watchFor"] === undefined
      ? {}
      : {
          watchFor: boundedString(
            raw["watchFor"],
            `${location}.watchFor`,
            OVERSIGHT_LIMITS.watchForChars,
          ),
        }),
    ...(raw["workerVariant"] === undefined
      ? {}
      : {
          workerVariant: enumValue(
            raw["workerVariant"],
            workerVariants,
            `${location}.workerVariant`,
          ),
        }),
    ...(raw["dryRun"] === undefined ? {} : { dryRun: raw["dryRun"] }),
  };
}

function nullable<T>(value: unknown, parse: (value: unknown) => T): T | null {
  return value === null ? null : parse(value);
}

function pattern(value: unknown, regex: RegExp, location: string): string {
  if (typeof value !== "string" || !regex.test(value)) fail(location, `must match ${regex.source}`);
  return value;
}

function pairCapability(value: unknown, location: string): PairCapability {
  const raw = object(value, location);
  exactKeys(raw, ["version", "adviceWaitMs", "watchIdleMs", "maxHoldMs"], location);
  return {
    version: positiveInteger(raw["version"], `${location}.version`),
    adviceWaitMs: positiveInteger(raw["adviceWaitMs"], `${location}.adviceWaitMs`),
    watchIdleMs: positiveInteger(raw["watchIdleMs"], `${location}.watchIdleMs`),
    maxHoldMs: positiveInteger(raw["maxHoldMs"], `${location}.maxHoldMs`),
  };
}

function boundedList<T>(
  value: unknown,
  location: string,
  max: number,
  parse: (item: unknown, location: string) => T,
): T[] {
  if (!Array.isArray(value)) fail(location, "must be an array");
  if (value.length > max) fail(location, `must contain at most ${max} entries`);
  return value.map((item, index) => parse(item, `${location}[${index}]`));
}

function pairMessage(value: unknown, location: string): PairMessageRecord {
  const raw = object(value, location);
  exactKeys(
    raw,
    [
      "id",
      "kind",
      "to",
      "thread",
      "createdAt",
      "body",
      "artifact",
      "attempts",
      "deliveredAt",
      "undeliverable",
      "effect",
      "shownAt",
    ],
    location,
  );
  const kind = enumValue(raw["kind"], OVERSIGHT_WIRE_KINDS, `${location}.kind`);
  const body = raw["body"] === null ? null : object(raw["body"], `${location}.body`);
  if (body !== null && Buffer.byteLength(JSON.stringify(body), "utf8") > 16 * 1024) {
    fail(`${location}.body`, "must encode to at most 16384 bytes");
  }
  const artifactRef =
    raw["artifact"] === null ? null : artifact(raw["artifact"], `${location}.artifact`);
  if ((kind === "feed") !== (artifactRef !== null) || (kind === "feed") === (body !== null)) {
    fail(
      location,
      "a feed carries an artifact and no body; every other kind a body and no artifact",
    );
  }
  return {
    id: pattern(raw["id"], MESSAGE_ID_PATTERN, `${location}.id`),
    kind,
    to: enumValue(raw["to"], ["worker", "watcher"] as const, `${location}.to`),
    thread: boundedString(raw["thread"], `${location}.thread`, 64),
    createdAt: isoDate(raw["createdAt"], `${location}.createdAt`),
    body,
    artifact: artifactRef,
    attempts: safeNonnegativeInteger(raw["attempts"], `${location}.attempts`),
    deliveredAt: nullable(raw["deliveredAt"], (item) => isoDate(item, `${location}.deliveredAt`)),
    undeliverable: nullable(raw["undeliverable"], (item) =>
      boundedString(item, `${location}.undeliverable`, 64),
    ),
    effect: nullable(raw["effect"], (item) => boundedString(item, `${location}.effect`, 64)),
    shownAt: nullable(raw["shownAt"], (item) => isoDate(item, `${location}.shownAt`)),
  };
}

function lifecycleFactRecord(value: unknown, location: string): LifecycleFact {
  const raw = object(value, location);
  exactKeys(raw, ["id", "kind", "at", "event", "ref", "detail"], location);
  if (raw["kind"] !== "lifecycle") fail(`${location}.kind`, "must be lifecycle");
  return {
    id: pattern(raw["id"], /^o:[1-9][0-9]{0,8}$/, `${location}.id`),
    kind: "lifecycle",
    at: isoDate(raw["at"], `${location}.at`),
    event: enumValue(raw["event"], LIFECYCLE_EVENTS, `${location}.event`),
    ref: nullable(raw["ref"], (item) => pattern(item, REF_PATTERN, `${location}.ref`)),
    detail: boundedString(raw["detail"], `${location}.detail`, 400),
  };
}

function pairRequest(value: unknown, location: string): PairRequestRecord {
  const raw = object(value, location);
  exactKeys(
    raw,
    [
      "id",
      "from",
      "kind",
      "ref",
      "at",
      "code",
      "text",
      "evidence",
      "holdSelf",
      "concernCode",
      "severity",
      "holdId",
      "selfHold",
      "waitOutcome",
    ],
    location,
  );
  const evidence = boundedList(
    raw["evidence"],
    `${location}.evidence`,
    OVERSIGHT_LIMITS.maxEvidence,
    (item, at) => pattern(item, EVIDENCE_ID_PATTERN, at),
  );
  if (raw["holdSelf"] !== null && typeof raw["holdSelf"] !== "boolean") {
    fail(`${location}.holdSelf`, "must be null or a boolean");
  }
  return {
    id: pattern(raw["id"], MESSAGE_ID_PATTERN, `${location}.id`),
    from: enumValue(raw["from"], ["worker", "watcher"] as const, `${location}.from`),
    kind: enumValue(raw["kind"], requestKinds, `${location}.kind`),
    ref: pattern(raw["ref"], REF_PATTERN, `${location}.ref`),
    at: isoDate(raw["at"], `${location}.at`),
    code: nullable(raw["code"], (item) => boundedString(item, `${location}.code`, 64)),
    text: nullable(raw["text"], (item) => boundedString(item, `${location}.text`, 2_000)),
    evidence,
    holdSelf: raw["holdSelf"] as boolean | null,
    concernCode: nullable(raw["concernCode"], (item) =>
      enumValue(item, CONCERN_CODES, `${location}.concernCode`),
    ),
    severity: nullable(raw["severity"], (item) =>
      enumValue(item, CONCERN_SEVERITIES, `${location}.severity`),
    ),
    holdId: nullable(raw["holdId"], (item) => pattern(item, HOLD_ID_PATTERN, `${location}.holdId`)),
    selfHold: nullable(raw["selfHold"], (item) =>
      enumValue(item, ["pending", "applied", "refused"] as const, `${location}.selfHold`),
    ),
    waitOutcome: nullable(raw["waitOutcome"], (item) =>
      enumValue(item, ["answered", "timeout", "aborted"] as const, `${location}.waitOutcome`),
    ),
  };
}

function pairHold(value: unknown, location: string): PairHoldRecord {
  const raw = object(value, location);
  exactKeys(
    raw,
    [
      "holdId",
      "origin",
      "requestId",
      "questionId",
      "reason",
      "maxMs",
      "status",
      "appliedAt",
      "endedAt",
      "endReason",
      "escalatedAt",
      "releasedOnWordsOnly",
      "creditMs",
    ],
    location,
  );
  const origin = enumValue(raw["origin"], ["watcher", "worker"] as const, `${location}.origin`);
  const requestId = nullable(raw["requestId"], (item) =>
    pattern(item, HOLD_REQUEST_ID_PATTERN, `${location}.requestId`),
  );
  const questionId = nullable(raw["questionId"], (item) =>
    pattern(item, QUESTION_ID_PATTERN, `${location}.questionId`),
  );
  const reason = nullable(raw["reason"], (item) =>
    boundedString(item, `${location}.reason`, OVERSIGHT_LIMITS.holdReasonChars),
  );
  if (
    origin === "watcher"
      ? requestId === null || questionId !== null || reason === null
      : requestId !== null || questionId === null || reason !== null
  ) {
    fail(location, "a watcher hold names its request and reason, a self-hold its question only");
  }
  const maxMs = positiveInteger(raw["maxMs"], `${location}.maxMs`);
  if (maxMs > OVERSIGHT_LIMITS.maxHoldMs) {
    fail(`${location}.maxMs`, `must be at most ${OVERSIGHT_LIMITS.maxHoldMs}`);
  }
  if (raw["releasedOnWordsOnly"] !== null && typeof raw["releasedOnWordsOnly"] !== "boolean") {
    fail(`${location}.releasedOnWordsOnly`, "must be null or a boolean");
  }
  return {
    holdId: pattern(raw["holdId"], HOLD_ID_PATTERN, `${location}.holdId`),
    origin,
    requestId,
    questionId,
    reason,
    maxMs,
    status: enumValue(
      raw["status"],
      ["pending", "active", "ended", "undeliverable"] as const,
      `${location}.status`,
    ),
    appliedAt: nullable(raw["appliedAt"], (item) => isoDate(item, `${location}.appliedAt`)),
    endedAt: nullable(raw["endedAt"], (item) => isoDate(item, `${location}.endedAt`)),
    endReason: nullable(raw["endReason"], (item) =>
      enumValue(item, HOLD_END_REASONS, `${location}.endReason`),
    ),
    escalatedAt: nullable(raw["escalatedAt"], (item) => isoDate(item, `${location}.escalatedAt`)),
    releasedOnWordsOnly: raw["releasedOnWordsOnly"] as boolean | null,
    creditMs: nullable(raw["creditMs"], (item) =>
      safeNonnegativeInteger(item, `${location}.creditMs`),
    ),
  };
}

function pairRecord(value: unknown, location: string): CampaignPairRecord {
  const raw = object(value, location);
  exactKeys(
    raw,
    [
      "pairId",
      "condition",
      "required",
      "state",
      "watcherTaskId",
      "workerTaskId",
      "readyAt",
      "outcome",
      "outcomeDetail",
      "lostCause",
      "watcherOutcome",
      "compacted",
      "capabilities",
      "messages",
      "facts",
      "requests",
      "holds",
      "escalations",
      "feed",
      "unshownCount",
      "unshown",
      "report",
      "protocolErrors",
      "protocolErrorCount",
      "coverage",
      "verdict",
    ],
    location,
  );
  for (const key of ["required", "compacted"] as const) {
    if (typeof raw[key] !== "boolean") fail(`${location}.${key}`, "must be a boolean");
  }
  const capabilities = object(raw["capabilities"], `${location}.capabilities`);
  exactKeys(capabilities, ["worker", "watcher"], `${location}.capabilities`);
  const feed = object(raw["feed"], `${location}.feed`);
  exactKeys(
    feed,
    ["cursor", "deferred", "batches", "regular", "questions", "final", "pulled", "heartbeats"],
    `${location}.feed`,
  );
  const cursor = object(feed["cursor"], `${location}.feed.cursor`);
  exactKeys(cursor, ["aSeq", "sSeq", "oN"], `${location}.feed.cursor`);
  const batch = (item: unknown, at: string): number => {
    const parsed = positiveInteger(item, at);
    if (parsed > OVERSIGHT_LIMITS.maxFeedIds) {
      fail(at, `must be at most ${OVERSIGHT_LIMITS.maxFeedIds}`);
    }
    return parsed;
  };
  const coverage =
    raw["coverage"] === null ? null : object(raw["coverage"], `${location}.coverage`);
  if (coverage !== null) {
    exactKeys(coverage, ["events", "sensor", "watcher", "reasons"], `${location}.coverage`);
  }
  const verdict = raw["verdict"] === null ? null : object(raw["verdict"], `${location}.verdict`);
  if (verdict !== null) {
    exactKeys(
      verdict,
      [
        "outcome",
        "findings",
        "watcherMissed",
        "watcherCited",
        "unshownToWatcher",
        "watcherOnly",
        "reasons",
      ],
      `${location}.verdict`,
    );
  }
  const count = (item: unknown, at: string) => safeNonnegativeInteger(item, at);
  return {
    pairId: pattern(raw["pairId"], PAIR_ID_PATTERN, `${location}.pairId`),
    condition: enumValue(raw["condition"], WATCH_CONDITIONS, `${location}.condition`),
    required: raw["required"] as boolean,
    state: enumValue(raw["state"], watchStates, `${location}.state`),
    watcherTaskId: nullableString(raw["watcherTaskId"], `${location}.watcherTaskId`),
    workerTaskId: nullableString(raw["workerTaskId"], `${location}.workerTaskId`),
    readyAt: nullable(raw["readyAt"], (item) => isoDate(item, `${location}.readyAt`)),
    outcome: nullable(raw["outcome"], (item) =>
      enumValue(item, pairStartOutcomes, `${location}.outcome`),
    ),
    outcomeDetail: nullable(raw["outcomeDetail"], (item) =>
      boundedString(item, `${location}.outcomeDetail`, OVERSIGHT_LIMITS.detailChars),
    ),
    lostCause: nullable(raw["lostCause"], (item) =>
      enumValue(item, lostCauses, `${location}.lostCause`),
    ),
    watcherOutcome: nullable(raw["watcherOutcome"], (item) =>
      enumValue(item, watcherOutcomes, `${location}.watcherOutcome`),
    ),
    compacted: raw["compacted"] as boolean,
    capabilities: {
      worker: nullable(capabilities["worker"], (item) =>
        pairCapability(item, `${location}.capabilities.worker`),
      ),
      watcher: nullable(capabilities["watcher"], (item) =>
        pairCapability(item, `${location}.capabilities.watcher`),
      ),
    },
    messages: boundedList(
      raw["messages"],
      `${location}.messages`,
      OVERSIGHT_LIMITS.maxPairMessages,
      pairMessage,
    ),
    facts: boundedList(
      raw["facts"],
      `${location}.facts`,
      OVERSIGHT_LIMITS.maxPairFacts,
      lifecycleFactRecord,
    ),
    requests: boundedList(
      raw["requests"],
      `${location}.requests`,
      OVERSIGHT_LIMITS.maxPairRequests,
      pairRequest,
    ),
    holds: boundedList(
      raw["holds"],
      `${location}.holds`,
      OVERSIGHT_LIMITS.maxHoldNumbers,
      pairHold,
    ),
    escalations: boundedList(
      raw["escalations"],
      `${location}.escalations`,
      OVERSIGHT_LIMITS.maxHoldNumbers,
      (item, at) => {
        const escalation = object(item, at);
        exactKeys(escalation, ["id", "thread", "holdId", "at"], at);
        return {
          id: pattern(escalation["id"], MESSAGE_ID_PATTERN, `${at}.id`),
          thread: pattern(escalation["thread"], /^oversight\/escalation\/[1-8]$/, `${at}.thread`),
          holdId: pattern(escalation["holdId"], HOLD_ID_PATTERN, `${at}.holdId`),
          at: isoDate(escalation["at"], `${at}.at`),
        };
      },
    ),
    feed: {
      cursor: {
        aSeq: count(cursor["aSeq"], `${location}.feed.cursor.aSeq`),
        sSeq: count(cursor["sSeq"], `${location}.feed.cursor.sSeq`),
        oN: count(cursor["oN"], `${location}.feed.cursor.oN`),
      },
      deferred: boundedList(
        feed["deferred"],
        `${location}.feed.deferred`,
        OVERSIGHT_LIMITS.maxDeferred,
        (item, at) => pattern(item, EVIDENCE_ID_PATTERN, at),
      ),
      batches: count(feed["batches"], `${location}.feed.batches`),
      regular: count(feed["regular"], `${location}.feed.regular`),
      questions: count(feed["questions"], `${location}.feed.questions`),
      final: nullable(feed["final"], (item) => batch(item, `${location}.feed.final`)),
      pulled: boundedList(
        feed["pulled"],
        `${location}.feed.pulled`,
        OVERSIGHT_LIMITS.maxFeedIds,
        batch,
      ),
      heartbeats: count(feed["heartbeats"], `${location}.feed.heartbeats`),
    },
    unshownCount: count(raw["unshownCount"], `${location}.unshownCount`),
    unshown: raw["unshown"] === null ? null : artifact(raw["unshown"], `${location}.unshown`),
    report: raw["report"] === null ? null : artifact(raw["report"], `${location}.report`),
    protocolErrors: boundedList(
      raw["protocolErrors"],
      `${location}.protocolErrors`,
      64,
      (item, at) => boundedString(item, at, OVERSIGHT_LIMITS.detailChars),
    ),
    protocolErrorCount: count(raw["protocolErrorCount"], `${location}.protocolErrorCount`),
    coverage:
      coverage === null
        ? null
        : {
            events: enumValue(coverage["events"], EVENTS_COVERAGES, `${location}.coverage.events`),
            sensor: enumValue(coverage["sensor"], SENSOR_COVERAGES, `${location}.coverage.sensor`),
            watcher: enumValue(
              coverage["watcher"],
              ["complete", "incomplete", "absent"] as const,
              `${location}.coverage.watcher`,
            ),
            reasons: stringArray(coverage["reasons"], `${location}.coverage.reasons`),
          },
    verdict:
      verdict === null
        ? null
        : {
            outcome: enumValue(
              verdict["outcome"],
              OVERSIGHT_OUTCOMES,
              `${location}.verdict.outcome`,
            ),
            findings: count(verdict["findings"], `${location}.verdict.findings`),
            watcherMissed: count(verdict["watcherMissed"], `${location}.verdict.watcherMissed`),
            watcherCited: count(verdict["watcherCited"], `${location}.verdict.watcherCited`),
            unshownToWatcher: count(
              verdict["unshownToWatcher"],
              `${location}.verdict.unshownToWatcher`,
            ),
            watcherOnly: count(verdict["watcherOnly"], `${location}.verdict.watcherOnly`),
            reasons: stringArray(verdict["reasons"], `${location}.verdict.reasons`),
          },
  };
}

function brain(value: unknown): CampaignBrainState {
  const location = "manifest.brain";
  const raw = object(value, location);
  exactKeys(
    raw,
    [
      "enabled",
      "maxDecisions",
      "maxHaltReopens",
      "replansUsed",
      "haltReopensUsed",
      "pendingRecovery",
      "decisions",
    ],
    location,
  );
  if (typeof raw["enabled"] !== "boolean") fail(`${location}.enabled`, "must be a boolean");
  const maxDecisions = positiveInteger(raw["maxDecisions"], `${location}.maxDecisions`);
  if (maxDecisions > 64) fail(`${location}.maxDecisions`, "must be at most 64");
  const maxHaltReopens = safeNonnegativeInteger(
    raw["maxHaltReopens"],
    `${location}.maxHaltReopens`,
  );
  if (maxHaltReopens > 8) fail(`${location}.maxHaltReopens`, "must be at most 8");
  const replansUsed = safeNonnegativeInteger(raw["replansUsed"], `${location}.replansUsed`);
  const haltReopensUsed = safeNonnegativeInteger(
    raw["haltReopensUsed"],
    `${location}.haltReopensUsed`,
  );
  let pendingRecovery: CampaignBrainState["pendingRecovery"] = null;
  if (raw["pendingRecovery"] !== null) {
    const pending = object(raw["pendingRecovery"], `${location}.pendingRecovery`);
    exactKeys(
      pending,
      ["decisionKey", "notBefore"],
      `${location}.pendingRecovery`,
    );
    pendingRecovery = {
      decisionKey: boundedString(
        pending["decisionKey"],
        `${location}.pendingRecovery.decisionKey`,
        256,
      ),
      notBefore: isoDate(
        pending["notBefore"],
        `${location}.pendingRecovery.notBefore`,
      ),
    };
  }
  if (!Array.isArray(raw["decisions"])) fail(`${location}.decisions`, "must be an array");
  const decisions = raw["decisions"].map((item, index): CampaignBrainDecision => {
    const itemLocation = `${location}.decisions[${index}]`;
    const decision = object(item, itemLocation);
    exactKeys(
      decision,
      [
        "seq",
        "key",
        "at",
        "phase",
        "source",
        "model",
        "action",
        "rationale",
        "arguments",
        "legalActions",
        "stateHash",
        "appliedAt",
      ],
      itemLocation,
    );
    const stateHash = string(decision["stateHash"], `${itemLocation}.stateHash`);
    if (!/^[a-f0-9]{64}$/.test(stateHash)) {
      fail(`${itemLocation}.stateHash`, "must be a lowercase SHA-256 hex digest");
    }
    const args = object(decision["arguments"], `${itemLocation}.arguments`);
    if (Buffer.byteLength(JSON.stringify(args), "utf8") > 32 * 1024) {
      fail(`${itemLocation}.arguments`, "must encode to at most 32768 bytes");
    }
    const legalActions = stringArray(
      decision["legalActions"],
      `${itemLocation}.legalActions`,
    );
    if (legalActions.length === 0) fail(`${itemLocation}.legalActions`, "must not be empty");
    requireUnique(legalActions, `${itemLocation}.legalActions`);
    const action = boundedString(decision["action"], `${itemLocation}.action`, 128);
    if (!legalActions.includes(action)) {
      fail(`${itemLocation}.action`, "must be present in legalActions");
    }
    return {
      seq: positiveInteger(decision["seq"], `${itemLocation}.seq`),
      key: boundedString(decision["key"], `${itemLocation}.key`, 256),
      at: isoDate(decision["at"], `${itemLocation}.at`),
      phase: enumValue(decision["phase"], brainPhases, `${itemLocation}.phase`),
      source: enumValue(
        decision["source"],
        brainDecisionSources,
        `${itemLocation}.source`,
      ),
      model:
        decision["model"] === null
          ? null
          : boundedString(decision["model"], `${itemLocation}.model`, 256),
      action,
      rationale: boundedString(decision["rationale"], `${itemLocation}.rationale`, 4096),
      arguments: args,
      legalActions,
      stateHash,
      appliedAt:
        decision["appliedAt"] === null
          ? null
          : isoDate(decision["appliedAt"], `${itemLocation}.appliedAt`),
    };
  });
  if (decisions.length > maxDecisions) {
    fail(`${location}.decisions`, `must contain at most ${maxDecisions} entries`);
  }
  return {
    enabled: raw["enabled"],
    maxDecisions,
    maxHaltReopens,
    replansUsed,
    haltReopensUsed,
    pendingRecovery,
    decisions,
  };
}

function sliceAttempt(value: unknown, location: string): SliceAttempt {
  const raw = object(value, location);
  exactKeys(
    raw,
    [
      "round",
      "builderId",
      "reviewerId",
      "artifacts",
      "verdict",
      "evidence",
      "gaps",
      "costUsd",
      "findings",
      "findingsSample",
      "verification",
      "findingsGate",
      "watch",
    ],
    location,
  );
  const attempt: SliceAttempt = {
    round: positiveInteger(raw["round"], `${location}.round`),
    builderId: nullableString(raw["builderId"], `${location}.builderId`),
    reviewerId: nullableString(raw["reviewerId"], `${location}.reviewerId`),
    artifacts: artifacts(raw["artifacts"], `${location}.artifacts`),
    verdict:
      raw["verdict"] === null
        ? null
        : enumValue(raw["verdict"], verdicts, `${location}.verdict`),
    evidence: stringArray(raw["evidence"], `${location}.evidence`),
    gaps: stringArray(raw["gaps"], `${location}.gaps`),
    costUsd: finiteNonnegative(raw["costUsd"], `${location}.costUsd`),
  };
  if (raw["findings"] !== undefined) {
    attempt.findings =
      raw["findings"] === null ? null : artifact(raw["findings"], `${location}.findings`);
  }
  if (raw["findingsSample"] !== undefined) {
    attempt.findingsSample = raw["findingsSample"] === null
      ? null
      : findingsSample(raw["findingsSample"], `${location}.findingsSample`);
  }
  if (raw["verification"] !== undefined) {
    attempt.verification =
      raw["verification"] === null ? null : artifact(raw["verification"], `${location}.verification`);
  }
  if (raw["findingsGate"] !== undefined) {
    attempt.findingsGate = raw["findingsGate"] === null
      ? null
      : findingsGate(raw["findingsGate"], `${location}.findingsGate`);
  }
  if (raw["watch"] !== undefined) attempt.watch = pairRecord(raw["watch"], `${location}.watch`);
  return attempt;
}

function findingsSample(
  value: unknown,
  location: string,
): NonNullable<SliceAttempt["findingsSample"]> {
  const raw = object(value, location);
  exactKeys(raw, ["seed", "ids", "candidates"], location);
  const ids = stringArray(raw["ids"], `${location}.ids`);
  if (new Set(ids).size !== ids.length) fail(`${location}.ids`, "must not repeat a finding id");
  const candidates = safeNonnegativeInteger(raw["candidates"], `${location}.candidates`);
  // A sample larger than the pool it was drawn from was not drawn from it.
  if (ids.length > candidates) {
    fail(`${location}.ids`, `has ${ids.length} ids drawn from ${candidates} candidates`);
  }
  return { seed: string(raw["seed"], `${location}.seed`), ids, candidates };
}

function findingsGate(
  value: unknown,
  location: string,
): NonNullable<SliceAttempt["findingsGate"]> {
  const raw = object(value, location);
  exactKeys(raw, ["outcome", "reasons", "survivalRate"], location);
  const survivalRate = raw["survivalRate"];
  if (survivalRate !== null && (typeof survivalRate !== "number" || !(survivalRate >= 0 && survivalRate <= 1))) {
    fail(`${location}.survivalRate`, "must be null or a rate within [0, 1]");
  }
  return {
    outcome: enumValue(
      raw["outcome"],
      ["pass", "fail", "inconclusive", "inapplicable"] as const,
      `${location}.outcome`,
    ),
    reasons: stringArray(raw["reasons"], `${location}.reasons`),
    survivalRate: survivalRate as number | null,
  };
}

function slices(value: unknown, maxRounds: number): CampaignSlice[] {
  if (!Array.isArray(value)) fail("manifest.slices", "must be an array");
  const result = value.map((item, index) => {
    const location = `manifest.slices[${index}]`;
    const raw = object(item, location);
    exactKeys(
      raw,
      ["id", "spec", "status", "attempts", "createdInRound", "dependsOn"],
      location,
    );
    const createdInRound = safeNonnegativeInteger(
      raw["createdInRound"],
      `${location}.createdInRound`,
    );
    if (createdInRound >= maxRounds) {
      fail(`${location}.createdInRound`, `must be less than maxRounds (${maxRounds})`);
    }
    const attemptLimit = maxRounds - createdInRound;
    if (!Array.isArray(raw["attempts"])) fail(`${location}.attempts`, "must be an array");
    const attempts = raw["attempts"].map((attempt, attemptIndex) =>
      sliceAttempt(attempt, `${location}.attempts[${attemptIndex}]`),
    );
    attempts.forEach((attempt, attemptIndex) => {
      if (attempt.round !== attemptIndex + 1) {
        fail(`${location}.attempts[${attemptIndex}].round`, "must be sequential and 1-based");
      }
      if (attempt.round > attemptLimit) {
        fail(
          `${location}.attempts[${attemptIndex}].round`,
          `exceeds remaining round allowance (${attemptLimit})`,
        );
      }
    });
    const parsed: CampaignSlice = {
      id: string(raw["id"], `${location}.id`),
      spec: artifact(raw["spec"], `${location}.spec`),
      status: enumValue(raw["status"], sliceStatuses, `${location}.status`),
      attempts,
      createdInRound,
    };
    if (raw["dependsOn"] !== undefined) {
      const dependsOn = stringArray(raw["dependsOn"], `${location}.dependsOn`);
      requireUnique(dependsOn, `${location}.dependsOn`);
      parsed.dependsOn = dependsOn;
    }
    return parsed;
  });
  requireUnique(result.map((slice) => slice.id), "manifest.slices ids");
  return result;
}

function integration(value: unknown): IntegrationState {
  const location = "manifest.integration";
  const raw = object(value, location);
  exactKeys(raw, ["reviewerId", "verdict", "evidence", "gaps", "attempts"], location);
  if (!Array.isArray(raw["attempts"])) fail(`${location}.attempts`, "must be an array");
  const attempts = raw["attempts"].map((item, index) => {
    const attemptLocation = `${location}.attempts[${index}]`;
    const attempt = object(item, attemptLocation);
    exactKeys(
      attempt,
      [
        "round",
        "reviewerId",
        "verdict",
        "evidence",
        "gaps",
        "affectedSliceIds",
        "retriesScheduled",
        "costUsd",
      ],
      attemptLocation,
    );
    if (typeof attempt["retriesScheduled"] !== "boolean") {
      fail(`${attemptLocation}.retriesScheduled`, "must be a boolean");
    }
    const parsed: IntegrationAttempt = {
      round: positiveInteger(attempt["round"], `${attemptLocation}.round`),
      reviewerId: nullableString(attempt["reviewerId"], `${attemptLocation}.reviewerId`),
      verdict:
        attempt["verdict"] === null
          ? null
          : enumValue(attempt["verdict"], verdicts, `${attemptLocation}.verdict`),
      evidence: stringArray(attempt["evidence"], `${attemptLocation}.evidence`),
      gaps: stringArray(attempt["gaps"], `${attemptLocation}.gaps`),
      affectedSliceIds: stringArray(
        attempt["affectedSliceIds"],
        `${attemptLocation}.affectedSliceIds`,
      ),
      retriesScheduled: attempt["retriesScheduled"],
      costUsd: finiteNonnegative(attempt["costUsd"], `${attemptLocation}.costUsd`),
    };
    if (parsed.round !== index + 1) {
      fail(`${attemptLocation}.round`, "must be sequential and 1-based");
    }
    return parsed;
  });
  return {
    reviewerId: nullableString(raw["reviewerId"], `${location}.reviewerId`),
    verdict:
      raw["verdict"] === null
        ? null
        : enumValue(raw["verdict"], verdicts, `${location}.verdict`),
    evidence: stringArray(raw["evidence"], `${location}.evidence`),
    gaps: stringArray(raw["gaps"], `${location}.gaps`),
    attempts,
  };
}

function budget(value: unknown): CampaignBudget {
  const raw = object(value, "manifest.budget");
  exactKeys(raw, ["maxTasks", "maxTotalCostUsd", "maxTotalTokens"], "manifest.budget");
  return {
    maxTasks: positiveInteger(raw["maxTasks"], "manifest.budget.maxTasks"),
    maxTotalCostUsd: positive(raw["maxTotalCostUsd"], "manifest.budget.maxTotalCostUsd"),
    ...(raw["maxTotalTokens"] === undefined
      ? {}
      : {
          maxTotalTokens: safePositiveInteger(
            raw["maxTotalTokens"],
            "manifest.budget.maxTotalTokens",
          ),
        }),
  };
}

function tasks(value: unknown): CampaignTaskRecord[] {
  if (!Array.isArray(value)) fail("manifest.tasks", "must be an array");
  const result = value.map((item, index) => {
    const location = `manifest.tasks[${index}]`;
    const raw = object(item, location);
    exactKeys(
      raw,
      [
        "id",
        "requestKey",
        "workerId",
        "role",
        "sliceId",
        "round",
        "status",
        "costUsd",
        "totalTokens",
        "seedProvenance",
        "seededArtifacts",
        "seededMessageIds",
        "effectiveTools",
        "intent",
        "pairId",
        "terminated",
        "logs",
        "createdAt",
      ],
      location,
    );
    if (!Array.isArray(raw["seededArtifacts"])) {
      fail(`${location}.seededArtifacts`, "must be an array");
    }
    if (raw["seededArtifacts"].length > 20) {
      fail(`${location}.seededArtifacts`, "must contain at most 20 entries");
    }
    const seededArtifacts = raw["seededArtifacts"].map(
      (item, seededIndex): CampaignSeededArtifact => {
        const seededLocation = `${location}.seededArtifacts[${seededIndex}]`;
        const seeded = object(item, seededLocation);
        exactKeys(seeded, ["artifact", "destination", "channel"], seededLocation);
        const destination = string(seeded["destination"], `${seededLocation}.destination`);
        const normalized = path.posix.normalize(destination);
        if (
          destination.includes("\\") ||
          path.posix.isAbsolute(destination) ||
          normalized === ".." ||
          normalized.startsWith("../") ||
          normalized !== destination
        ) {
          fail(`${seededLocation}.destination`, "must be a normalized relative POSIX path");
        }
        return {
          artifact: artifact(seeded["artifact"], `${seededLocation}.artifact`),
          destination,
          channel: enumValue(
            seeded["channel"],
            seedChannels,
            `${seededLocation}.channel`,
          ),
        };
      },
    );
    requireUnique(
      seededArtifacts.map((seeded) => seeded.destination),
      `${location}.seededArtifacts destinations`,
    );
    const seededMessageIds = stringArray(
      raw["seededMessageIds"],
      `${location}.seededMessageIds`,
    );
    if (seededMessageIds.length > 64) {
      fail(`${location}.seededMessageIds`, "must contain at most 64 entries");
    }
    requireUnique(seededMessageIds, `${location}.seededMessageIds`);
    const effectiveTools =
      raw["effectiveTools"] === undefined
        ? undefined
        : stringArray(raw["effectiveTools"], `${location}.effectiveTools`);
    if (effectiveTools !== undefined) {
      if (effectiveTools.length > 64) {
        fail(`${location}.effectiveTools`, "must contain at most 64 entries");
      }
      requireUnique(effectiveTools, `${location}.effectiveTools`);
    }
    return {
      id: string(raw["id"], `${location}.id`),
      ...(raw["requestKey"] === undefined
        ? {}
        : { requestKey: string(raw["requestKey"], `${location}.requestKey`) }),
      ...(raw["workerId"] === undefined
        ? {}
        : { workerId: string(raw["workerId"], `${location}.workerId`) }),
      role: enumValue(raw["role"], taskRoles, `${location}.role`),
      sliceId: nullableString(raw["sliceId"], `${location}.sliceId`),
      round: positiveInteger(raw["round"], `${location}.round`),
      status: enumValue(raw["status"], lingTaskStatuses, `${location}.status`),
      costUsd: finiteNonnegative(raw["costUsd"], `${location}.costUsd`),
      totalTokens: safeNonnegativeInteger(raw["totalTokens"], `${location}.totalTokens`),
      seedProvenance: enumValue(
        raw["seedProvenance"],
        ["recorded", "unavailable"] as const,
        `${location}.seedProvenance`,
      ),
      seededArtifacts,
      seededMessageIds,
      ...(effectiveTools === undefined ? {} : { effectiveTools }),
      ...(raw["intent"] === undefined
        ? {}
        : { intent: intentRecord(raw["intent"], `${location}.intent`) }),
      ...(raw["pairId"] === undefined
        ? {}
        : { pairId: pattern(raw["pairId"], PAIR_ID_PATTERN, `${location}.pairId`) }),
      ...(raw["terminated"] === undefined
        ? {}
        : { terminated: taskTermination(raw["terminated"], `${location}.terminated`) }),
      ...(raw["logs"] === undefined ? {} : { logs: taskLogs(raw["logs"], `${location}.logs`) }),
      createdAt: isoDate(raw["createdAt"], `${location}.createdAt`),
    };
  });
  requireUnique(result.map((task) => task.id), "manifest.tasks ids");
  return result;
}

function taskTermination(value: unknown, location: string): CampaignTaskTermination {
  const raw = object(value, location);
  exactKeys(raw, ["reason", "requestedAt", "completedAt", "errors"], location);
  return {
    reason: enumValue(
      raw["reason"],
      ["cancel-unconfirmed", "worker-unreachable", "expired", "orphaned", "operator"] as const,
      `${location}.reason`,
    ),
    requestedAt: isoDate(raw["requestedAt"], `${location}.requestedAt`),
    completedAt: nullable(raw["completedAt"], (item) => isoDate(item, `${location}.completedAt`)),
    errors: boundedList(raw["errors"], `${location}.errors`, 32, (item, at) =>
      boundedString(item, at, 1_000),
    ),
  };
}

function taskLogs(value: unknown, location: string): CampaignTaskLogs {
  const raw = object(value, location);
  exactKeys(raw, ["record", "service"], location);
  return {
    record: raw["record"] === null ? null : artifact(raw["record"], `${location}.record`),
    service: raw["service"] === null ? null : artifact(raw["service"], `${location}.service`),
  };
}

function summons(value: unknown): CampaignSummonIntent[] {
  if (!Array.isArray(value)) fail("manifest.summons", "must be an array");
  const result = value.map((item, index): CampaignSummonIntent => {
    const location = `manifest.summons[${index}]`;
    const raw = object(item, location);
    exactKeys(
      raw,
      [
        "requestKey",
        "role",
        "sliceId",
        "round",
        "profileSha256",
        "requestSha256",
        "state",
        "workerId",
        "taskId",
        "preparedAt",
        "updatedAt",
        "error",
      ],
      location,
    );
    const profileSha256 = string(raw["profileSha256"], `${location}.profileSha256`);
    const requestSha256 = string(raw["requestSha256"], `${location}.requestSha256`);
    if (!/^[a-f0-9]{64}$/.test(profileSha256)) {
      fail(`${location}.profileSha256`, "must be a lowercase SHA-256 digest");
    }
    if (!/^[a-f0-9]{64}$/.test(requestSha256)) {
      fail(`${location}.requestSha256`, "must be a lowercase SHA-256 digest");
    }
    return {
      requestKey: boundedString(raw["requestKey"], `${location}.requestKey`, 240),
      role: enumValue(raw["role"], taskRoles, `${location}.role`),
      sliceId: nullableString(raw["sliceId"], `${location}.sliceId`),
      round: positiveInteger(raw["round"], `${location}.round`),
      profileSha256,
      requestSha256,
      state: enumValue(raw["state"], summonStates, `${location}.state`),
      workerId: nullableString(raw["workerId"], `${location}.workerId`),
      taskId: nullableString(raw["taskId"], `${location}.taskId`),
      preparedAt: isoDate(raw["preparedAt"], `${location}.preparedAt`),
      updatedAt: isoDate(raw["updatedAt"], `${location}.updatedAt`),
      error: nullableString(raw["error"], `${location}.error`),
    };
  });
  requireUnique(
    result.map((intent) => intent.requestKey),
    "manifest.summons request keys",
  );
  return result;
}

function requireUnique(values: readonly string[], location: string): void {
  const seen = new Set<string>();
  const duplicate = values.find((value) => {
    if (seen.has(value)) return true;
    seen.add(value);
    return false;
  });
  if (duplicate !== undefined) fail(location, `contains duplicate ${JSON.stringify(duplicate)}`);
}

function validateConsistency(manifest: CampaignManifest): void {
  if (manifest.slices.length === 0 && !manifest.allowPlanning) {
    fail("manifest", "requires slices or allowPlanning=true");
  }
  if (manifest.slices.length > 0 && manifest.planning.status !== "not_required" && manifest.planning.status !== "completed") {
    fail("manifest.planning.status", "must be not_required or completed when slices exist");
  }
  if (manifest.slices.length === 0 && manifest.planning.status === "not_required") {
    fail("manifest.planning.status", "cannot be not_required when no slices exist");
  }

  const sliceIds = new Set(manifest.slices.map((slice) => slice.id));
  if (manifest.currentSliceId !== null && !sliceIds.has(manifest.currentSliceId)) {
    fail("manifest.currentSliceId", "does not identify a known slice");
  }

  const taskById = new Map(manifest.tasks.map((task) => [task.id, task]));
  const taskByRequestKey = new Map(
    manifest.tasks
      .filter((task): task is CampaignTaskRecord & { requestKey: string } =>
        task.requestKey !== undefined,
      )
      .map((task) => [task.requestKey, task]),
  );
  const barDigest =
    manifest.bar?.kind === "artifact"
      ? manifest.bar.ref.split("/").find((segment) => /^[a-f0-9]{64}$/.test(segment))
      : undefined;
  const artifactBar =
    barDigest === undefined
      ? []
      : [
          {
            artifactId: `sha256:${barDigest}`,
            path: manifest.bar!.ref,
            sha256: barDigest,
          },
        ];
  const artifactPaths = new Map(
    [
      ...manifest.planning.candidateArtifacts,
      ...manifest.planning.artifacts,
      ...manifest.slices.flatMap((slice) => [
        slice.spec,
        ...slice.attempts.flatMap((attempt) => attempt.artifacts),
      ]),
      ...artifactBar,
    ].map((ref) => [ref.path, ref]),
  );
  const messageIds = new Set(manifest.coordination.messages.map((message) => message.id));
  for (const [index, task] of manifest.tasks.entries()) {
    const location = `manifest.tasks[${index}]`;
    if (
      task.seedProvenance === "unavailable" &&
      (task.seededArtifacts.length > 0 || task.seededMessageIds.length > 0)
    ) {
      fail(location, "unavailable seed provenance cannot carry recorded seed entries");
    }
    for (const [seedIndex, seeded] of task.seededArtifacts.entries()) {
      const seededLocation = `${location}.seededArtifacts[${seedIndex}]`;
      const known = artifactPaths.get(seeded.artifact.path);
      if (
        known === undefined ||
        known.artifactId !== seeded.artifact.artifactId ||
        known.sha256 !== seeded.artifact.sha256
      ) {
        fail(
          `${seededLocation}.artifact`,
          "does not identify an artifact retained by this campaign",
        );
      }
      const validChannel =
        (seeded.channel === "planning_candidate" &&
          task.role === "planner" &&
          task.sliceId === null &&
          /^campaign\/candidate-plan-\d+\.json$/.test(seeded.destination)) ||
        (seeded.channel === "accepted" &&
          ["builder", "reviewer", "integration"].includes(task.role) &&
          seeded.destination.startsWith("accepted/")) ||
        (seeded.channel === "proposal" &&
          task.role === "reviewer" &&
          task.sliceId !== null &&
          seeded.destination.startsWith("proposal/")) ||
        (seeded.channel === "reference" &&
          ["reviewer", "integration"].includes(task.role) &&
          seeded.destination === "reference-bar/content");
      if (!validChannel) {
        fail(
          seededLocation,
          `channel ${seeded.channel} is inconsistent with task role and destination`,
        );
      }
    }
    for (const [messageIndex, messageId] of task.seededMessageIds.entries()) {
      const message = manifest.coordination.messages.find(
        (candidate) => candidate.id === messageId,
      );
      if (message === undefined || !messageIds.has(messageId)) {
        fail(
          `${location}.seededMessageIds[${messageIndex}]`,
          "does not identify a durable campaign message",
        );
      }
      if (
        task.sliceId === null ||
        !["builder", "reviewer"].includes(task.role) ||
        !message.toSliceIds.includes(task.sliceId)
      ) {
        fail(
          `${location}.seededMessageIds[${messageIndex}]`,
          "was not addressed to this task's role and slice",
        );
      }
    }
  }
  for (const [index, intent] of manifest.summons.entries()) {
    const location = `manifest.summons[${index}]`;
    if (!intent.requestKey.startsWith(campaignRequestKeyPrefix(manifest.id))) {
      fail(`${location}.requestKey`, "does not belong to this campaign");
    }
    const task = taskByRequestKey.get(intent.requestKey);
    if (intent.taskId !== null) {
      if (task === undefined || task.id !== intent.taskId) {
        fail(`${location}.taskId`, "does not match the task with this request key");
      }
      if (
        task.role !== intent.role ||
        task.sliceId !== intent.sliceId ||
        task.round !== intent.round
      ) {
        fail(location, "does not match the task role, slice, and round");
      }
    }
    if (
      ["spawned", "collected", "released"].includes(intent.state) &&
      (intent.taskId === null || intent.workerId === null)
    ) {
      fail(location, `${intent.state} requires taskId and workerId`);
    }
    if (intent.state === "collected" && task !== undefined && task.status !== "completed") {
      fail(location, "collected requires a completed task");
    }
    if (
      intent.state === "released" &&
      task !== undefined &&
      !isTerminalStatus(task.status)
    ) {
      fail(location, "released requires a terminal task");
    }
  }
  const requireTask = (
    id: string | null,
    role: CampaignRole,
    location: string,
    sliceId: string | null,
    round: number,
  ) => {
    if (id === null) return;
    const task = taskById.get(id);
    if (task === undefined) fail(location, "is not present in manifest.tasks");
    if (task.role !== role || task.sliceId !== sliceId || task.round !== round) {
      fail(location, "does not match the corresponding task role, slice, and round");
    }
  };

  const finalPlanningRound =
    manifest.coordination.planningCandidates > 1
      ? manifest.coordination.planningCandidates + 1
      : 1;
  requireTask(
    manifest.planning.taskId,
    "planner",
    "manifest.planning.taskId",
    null,
    finalPlanningRound,
  );
  requireUnique(manifest.planning.candidateTaskIds, "manifest.planning.candidateTaskIds");
  manifest.planning.candidateTaskIds.forEach((taskId, index) => {
    requireTask(
      taskId,
      "planner",
      `manifest.planning.candidateTaskIds[${index}]`,
      null,
      index + 1,
    );
  });
  if (
    manifest.coordination.planningCandidates === 1 &&
    (manifest.planning.candidateTaskIds.length > 0 ||
      manifest.planning.candidateArtifacts.length > 0)
  ) {
    fail("manifest.planning", "single-planner campaigns cannot contain candidate planning state");
  }
  if (
    manifest.planning.candidateTaskIds.length > manifest.coordination.planningCandidates ||
    manifest.planning.candidateArtifacts.length > manifest.coordination.planningCandidates
  ) {
    fail("manifest.planning", "contains more planning candidates than configured");
  }
  if (
    manifest.planning.candidateArtifacts.length >
    manifest.planning.candidateTaskIds.length
  ) {
    fail("manifest.planning.candidateArtifacts", "cannot outnumber candidateTaskIds");
  }
  if (
    manifest.planning.candidateTaskIds.length >
    manifest.planning.candidateArtifacts.length + 1
  ) {
    fail(
      "manifest.planning.candidateTaskIds",
      "may contain only the next sequential candidate beyond persisted artifacts",
    );
  }
  if (
    manifest.planning.status === "completed" &&
    manifest.coordination.planningCandidates > 1 &&
    (manifest.planning.candidateTaskIds.length !== manifest.coordination.planningCandidates ||
      manifest.planning.candidateArtifacts.length !==
        manifest.coordination.planningCandidates)
  ) {
    fail(
      "manifest.planning",
      "completed negotiated planning requires every configured candidate task and artifact",
    );
  }
  for (const [sliceIndex, slice] of manifest.slices.entries()) {
    for (const [attemptIndex, attempt] of slice.attempts.entries()) {
      const base = `manifest.slices[${sliceIndex}].attempts[${attemptIndex}]`;
      requireTask(attempt.builderId, "builder", `${base}.builderId`, slice.id, attempt.round);
      requireTask(attempt.reviewerId, "reviewer", `${base}.reviewerId`, slice.id, attempt.round);
      if (attempt.verdict === "accept" && attempt.artifacts.length === 0) {
        fail(base, "an accepted attempt must contain at least one artifact");
      }
    }
    if (slice.status === "accepted" && slice.attempts.at(-1)?.verdict !== "accept") {
      fail(`manifest.slices[${sliceIndex}].status`, "requires the latest attempt to be accepted");
    }
    const attemptLimit = manifest.maxRounds - slice.createdInRound;
    if (slice.status === "capped" && slice.attempts.length < attemptLimit) {
      fail(
        `manifest.slices[${sliceIndex}].status`,
        `requires its full remaining allowance of ${attemptLimit} attempt(s)`,
      );
    }
    if (slice.dependsOn !== undefined) {
      const location = `manifest.slices[${sliceIndex}].dependsOn`;
      const unknownDependency = slice.dependsOn.filter((id) => !sliceIds.has(id));
      if (unknownDependency.length > 0) {
        fail(location, `contains unknown slice id(s): ${unknownDependency.join(", ")}`);
      }
      if (slice.dependsOn.includes(slice.id)) fail(location, "cannot list its own slice");
    }
  }

  validatePairs(manifest, taskById);

  if (!manifest.coordination.enabled) {
    if (
      manifest.coordination.planningCandidates !== 1 ||
      manifest.coordination.parallelSlices ||
      manifest.coordination.passiveMessaging ||
      manifest.coordination.decisions.length > 0 ||
      manifest.coordination.messages.length > 0
    ) {
      fail("manifest.coordination", "disabled coordination must keep optional behavior inactive");
    }
  }
  if (
    manifest.coordination.passiveMessaging &&
    !manifest.coordination.parallelSlices
  ) {
    fail(
      "manifest.coordination.passiveMessaging",
      "requires parallelSlices so another slice can be listening",
    );
  }
  if (manifest.coordination.parallelSlices) {
    if (manifest.slices.some((slice) => slice.dependsOn === undefined)) {
      fail(
        "manifest.coordination.parallelSlices",
        "requires every slice to declare dependsOn explicitly",
      );
    }
    const cycle = dependencyCycle(manifest.slices);
    if (cycle !== undefined) {
      fail("manifest.slices", `dependency graph contains a cycle at ${JSON.stringify(cycle)}`);
    }
  }
  manifest.coordination.decisions.forEach((decision, index) => {
    if (decision.seq !== index + 1) {
      fail(`manifest.coordination.decisions[${index}].seq`, "must be sequential and 1-based");
    }
  });
  manifest.brain.decisions.forEach((decision, index) => {
    if (decision.seq !== index + 1) {
      fail(`manifest.brain.decisions[${index}].seq`, "must be sequential and 1-based");
    }
  });
  requireUnique(
    manifest.brain.decisions.map((decision) => decision.key),
    "manifest.brain.decisions keys",
  );
  if (!manifest.brain.enabled) {
    if (
      manifest.brain.replansUsed !== 0 ||
      manifest.brain.haltReopensUsed !== 0 ||
      manifest.brain.pendingRecovery !== null ||
      manifest.brain.decisions.length > 0
    ) {
      fail("manifest.brain", "disabled brain must not contain autonomous decision state");
    }
  }
  if (manifest.brain.replansUsed > Math.max(0, manifest.maxRounds - 1)) {
    fail("manifest.brain.replansUsed", "exceeds the campaign round cap");
  }
  if (manifest.brain.haltReopensUsed > manifest.brain.maxHaltReopens) {
    fail("manifest.brain.haltReopensUsed", "exceeds maxHaltReopens");
  }
  if (manifest.brain.pendingRecovery !== null) {
    const decision = manifest.brain.decisions.find(
      (candidate) => candidate.key === manifest.brain.pendingRecovery?.decisionKey,
    );
    if (decision === undefined || decision.phase !== "recovery" || decision.action !== "reopen_campaign") {
      fail(
        "manifest.brain.pendingRecovery.decisionKey",
        "must identify a recorded reopen_campaign recovery decision",
      );
    }
    if (manifest.status !== "blocked" && manifest.status !== "budget_exhausted") {
      fail("manifest.brain.pendingRecovery", "requires a halted campaign status");
    }
  }
  if (
    manifest.brain.enabled &&
    manifest.integration.attempts.length > manifest.maxRounds
  ) {
    fail("manifest.integration.attempts", "brain-driven campaigns cannot exceed maxRounds");
  }
  requireUnique(
    manifest.coordination.messages.map((message) => message.id),
    "manifest.coordination.messages ids",
  );
  manifest.coordination.messages.forEach((message, index) => {
    if (message.seq !== index + 1) {
      fail(`manifest.coordination.messages[${index}].seq`, "must be sequential and 1-based");
    }
    if (
      Buffer.byteLength(message.content, "utf8") > manifest.coordination.maxMessageBytes
    ) {
      fail(
        `manifest.coordination.messages[${index}].content`,
        `exceeds maxMessageBytes (${manifest.coordination.maxMessageBytes})`,
      );
    }
    const sender = taskById.get(message.fromTaskId);
    if (
      sender === undefined ||
      sender.role !== message.fromRole ||
      sender.sliceId !== message.fromSliceId
    ) {
      fail(
        `manifest.coordination.messages[${index}].fromTaskId`,
        "does not match the recorded sender role and slice",
      );
    }
    requireUnique(
      message.toSliceIds,
      `manifest.coordination.messages[${index}].toSliceIds`,
    );
    const unknownTargets = message.toSliceIds.filter((id) => !sliceIds.has(id));
    if (unknownTargets.length > 0) {
      fail(
        `manifest.coordination.messages[${index}].toSliceIds`,
        `contains unknown slice id(s): ${unknownTargets.join(", ")}`,
      );
    }
    requireUnique(
      message.deliveredToTaskIds,
      `manifest.coordination.messages[${index}].deliveredToTaskIds`,
    );
    const unknownDeliveries = message.deliveredToTaskIds.filter((id) => !taskById.has(id));
    if (unknownDeliveries.length > 0) {
      fail(
        `manifest.coordination.messages[${index}].deliveredToTaskIds`,
        `contains unknown task id(s): ${unknownDeliveries.join(", ")}`,
      );
    }
    const mistargetedDeliveries = message.deliveredToTaskIds.filter((id) => {
      const task = taskById.get(id);
      return task?.sliceId === null || !message.toSliceIds.includes(task?.sliceId ?? "");
    });
    if (mistargetedDeliveries.length > 0) {
      fail(
        `manifest.coordination.messages[${index}].deliveredToTaskIds`,
        `contains task(s) outside the target slices: ${mistargetedDeliveries.join(", ")}`,
      );
    }
  });

  manifest.integration.attempts.forEach((attempt, index) => {
    requireTask(
      attempt.reviewerId,
      "integration",
      `manifest.integration.attempts[${index}].reviewerId`,
      null,
      attempt.round,
    );
    const unknownAffected = attempt.affectedSliceIds.filter((id) => !sliceIds.has(id));
    if (unknownAffected.length > 0) {
      fail(
        `manifest.integration.attempts[${index}].affectedSliceIds`,
        `contains unknown slice id(s): ${unknownAffected.join(", ")}`,
      );
    }
    requireUnique(
      attempt.affectedSliceIds,
      `manifest.integration.attempts[${index}].affectedSliceIds`,
    );
    if (attempt.retriesScheduled && attempt.verdict !== "revise") {
      fail(
        `manifest.integration.attempts[${index}].retriesScheduled`,
        "can only be true for a revise verdict",
      );
    }
  });
  const latestIntegration = manifest.integration.attempts.at(-1);
  if (latestIntegration !== undefined) {
    if (
      manifest.integration.reviewerId !== latestIntegration.reviewerId ||
      manifest.integration.verdict !== latestIntegration.verdict
    ) {
      fail("manifest.integration", "summary fields must match the latest integration attempt");
    }
  } else if (manifest.integration.reviewerId !== null || manifest.integration.verdict !== null) {
    fail("manifest.integration", "cannot have summary fields without an attempt");
  }

  if (manifest.tasks.length > manifest.budget.maxTasks) {
    fail("manifest.tasks", "exceeds manifest.budget.maxTasks");
  }
  if (manifest.status === "completed") {
    if (
      manifest.slices.some((slice) => slice.status !== "accepted") ||
      manifest.integration.verdict !== "accept"
    ) {
      fail("manifest.status", "completed requires accepted slices and integration");
    }
  }
}

/**
 * A watched campaign's pairs, against its tasks. This is the one place a
 * watch is admitted (§11.1): initializeCampaign only fills in its defaults
 * and relies on these refusals.
 *
 * v1 pairs builders on one slice at a time: a parallel campaign would put
 * other slices' traffic in A's inbox, and campaign_send may not sit beside
 * the oversight tools on a ling. B's model must be of another family than
 * A's (`modelFamily`; design §5: then collusion can only omit, and omission
 * is graded). A builder whose family cannot be shown to differ is refused
 * too: one whose provider is left to the ling's default, or, behind an
 * aggregator, one whose model is. A watcher task exists only as half of the
 * pair whose record names it. A worker prompt variant and a dry run are
 * admitted here too.
 */
function validatePairs(
  manifest: CampaignManifest,
  taskById: ReadonlyMap<string, CampaignTaskRecord>,
): void {
  const watch = manifest.coordination.watch;
  if (watch !== undefined) {
    if (!manifest.coordination.enabled) {
      fail("manifest.coordination.watch", "requires coordination.enabled");
    }
    if (manifest.coordination.parallelSlices) {
      fail(
        "manifest.coordination.watch",
        "cannot be combined with parallelSlices; a watched builder runs one slice at a time",
      );
    }
    if (manifest.coordination.passiveMessaging) {
      fail(
        "manifest.coordination.watch",
        "cannot be combined with passiveMessaging; campaign_send may not sit beside the oversight tools",
      );
    }
    const refusedTools = watchedBuilderToolsRefused(watch.condition, manifest.roles.builder.tools);
    if (refusedTools.length > 0) {
      const refused = refusedTools.join(", ");
      fail(
        "manifest.roles.builder.tools",
        `cannot give the builder ${refused}: a builder watched under ${watch.condition} ` +
          `cannot include ${refused} among its tools, since campaign_send may not sit beside ` +
          `the oversight tools and its own are ${workerOversightTools(watch.condition).join(", ")}`,
      );
    }
    if (watch.watcher !== null) {
      const builderProvider = manifest.roles.builder.provider;
      if (builderProvider === undefined) {
        fail(
          "manifest.roles.builder",
          "must name its provider when builders are watched, so the watcher's model family can be shown to differ",
        );
      }
      const builderFamily = modelFamily(builderProvider, manifest.roles.builder.model);
      if (builderFamily === null) {
        fail(
          "manifest.roles.builder",
          `must name its model when builders are watched and its provider ${JSON.stringify(builderProvider)} is an aggregator, so the watcher's model family can be shown to differ`,
        );
      }
      if (modelFamily(watch.watcher.provider, watch.watcher.model) === builderFamily) {
        fail(
          "manifest.coordination.watch.watcher",
          `must differ in model family from the builder: both are ${JSON.stringify(builderFamily)}`,
        );
      }
    }
    if (watch.workerVariant !== undefined) {
      validateWorkerVariant(watch.workerVariant, watch, manifest.roles.builder);
    }
    if (watch.dryRun === true) validateDryRun(manifest, watch);
  }
  const pairIds = new Map<string, { sliceId: string; round: number }>();
  for (const [sliceIndex, slice] of manifest.slices.entries()) {
    for (const [attemptIndex, attempt] of slice.attempts.entries()) {
      const pair = attempt.watch;
      if (pair === undefined) continue;
      const location = `manifest.slices[${sliceIndex}].attempts[${attemptIndex}].watch`;
      if (watch === undefined) fail(location, "requires manifest.coordination.watch");
      if (pairIds.has(pair.pairId)) fail(`${location}.pairId`, "is used by another attempt");
      pairIds.set(pair.pairId, { sliceId: slice.id, round: attempt.round });
      if (pair.workerTaskId !== null && pair.workerTaskId !== attempt.builderId) {
        fail(`${location}.workerTaskId`, "must be the attempt's builder");
      }
      if (pair.watcherTaskId !== null) {
        const watcher = taskById.get(pair.watcherTaskId);
        if (
          watcher === undefined ||
          watcher.role !== "watcher" ||
          watcher.sliceId !== slice.id ||
          watcher.round !== attempt.round ||
          watcher.pairId !== pair.pairId
        ) {
          fail(`${location}.watcherTaskId`, "does not identify this pair's watcher task");
        }
      }
    }
  }
  for (const [index, task] of manifest.tasks.entries()) {
    const location = `manifest.tasks[${index}]`;
    if (task.role === "watcher") {
      if (task.pairId === undefined || task.sliceId === null) {
        fail(location, "a watcher task must name its pair and slice");
      }
      if (task.seededArtifacts.length > 0 || task.seededMessageIds.length > 0) {
        fail(location, "a watcher task is seeded with nothing");
      }
    }
    if (task.pairId !== undefined) {
      const pair = pairIds.get(task.pairId);
      if (
        pair === undefined ||
        pair.sliceId !== task.sliceId ||
        pair.round !== task.round ||
        (task.role !== "watcher" && task.role !== "builder")
      ) {
        fail(`${location}.pairId`, "does not identify a pair on this task's attempt");
      }
    }
  }
}

/**
 * A worker prompt variant against its terms (WORKER_VARIANTS): its
 * condition, the tools ling runs it with, and, for a draft, a dry run. A
 * channel variant needs a required watcher as well: a builder whose watcher
 * did not start loses ask_overseer, and ling would refuse the variant
 * without it, after the watcher had been spawned.
 */
function validateWorkerVariant(
  name: LingWorkerVariant,
  watch: CampaignWatchConfig,
  builder: RoleProfile,
): void {
  const variant = WORKER_VARIANTS[name];
  const location = "manifest.coordination.watch.workerVariant";
  if (watch.condition !== variant.condition) {
    fail(location, `${name} is written for condition ${variant.condition}, not ${watch.condition}`);
  }
  if (variant.condition === "channel" && !watch.required) {
    fail(
      location,
      `${name} requires a required watcher: a builder whose watcher did not start loses ask_overseer, and ling refuses ${name} without it`,
    );
  }
  const allowed = variant.tools;
  if (allowed !== undefined) {
    const outside = [...new Set(builder.tools)].filter((tool) => !allowed.includes(tool));
    if (outside.length > 0) {
      fail(
        "manifest.roles.builder.tools",
        `cannot give the builder ${outside.join(", ")}: ling runs ${name} only with ${allowed.join(", ")}`,
      );
    }
  }
  if (variant.draft && watch.dryRun !== true) {
    fail(
      location,
      `${name} is a draft text, which the owner's F8 decision keeps out of every paid run, so it runs only with dryRun: true`,
    );
  }
}

/**
 * A dry run: nothing in the campaign can reach a paid model. Every role, the
 * planner included whether or not it will run, and the watcher name a
 * scripted provider and model (SCRIPTED_MODEL_NAME), since a role that names
 * neither runs on whatever its ling is configured with. The brain, which
 * makes model calls of its own, is off.
 */
function validateDryRun(manifest: CampaignManifest, watch: CampaignWatchConfig): void {
  const location = "manifest.coordination.watch.dryRun";
  const models: [string, { provider?: string; model?: string }][] = workRoles.map((role) => [
    `manifest.roles.${role}`,
    manifest.roles[role],
  ]);
  if (watch.watcher !== null) models.push(["manifest.coordination.watch.watcher", watch.watcher]);
  for (const [who, { provider, model }] of models) {
    if (
      provider === undefined ||
      model === undefined ||
      !SCRIPTED_MODEL_NAME.test(provider) ||
      !SCRIPTED_MODEL_NAME.test(model)
    ) {
      fail(
        location,
        `requires a scripted provider and model for every role and the watcher, and ${who} names ` +
          `${JSON.stringify(provider ?? null)} and ${JSON.stringify(model ?? null)}`,
      );
    }
  }
  if (manifest.brain.enabled) {
    fail(location, "requires brain.enabled false: the brain makes model calls of its own");
  }
}

export function parseCampaignManifest(value: unknown): CampaignManifest {
  const raw = object(value, "manifest");
  exactKeys(
    raw,
    [
      "version",
      "id",
      "goal",
      "status",
      "acceptance",
      "bar",
      "allowPlanning",
      "maxRounds",
      "currentSliceId",
      "slices",
      "planning",
      "integration",
      "coordination",
      "brain",
      "budget",
      "roles",
      "tasks",
      "summons",
      "spentUsdSnapshot",
      "spentTokensSnapshot",
      "updatedAt",
    ],
    "manifest",
  );
  // Versions 1-5 used to be upgraded in memory on load. They are refused now,
  // which is what lets every field they lacked be required rather than defaulted.
  if (raw["version"] !== CAMPAIGN_VERSION) {
    fail("manifest.version", `unsupported version ${String(raw["version"])}`);
  }
  if (typeof raw["allowPlanning"] !== "boolean") {
    fail("manifest.allowPlanning", "must be a boolean");
  }
  const maxRounds = positiveInteger(raw["maxRounds"], "manifest.maxRounds");
  const criteria = acceptance(raw["acceptance"]);
  const manifest: CampaignManifest = {
    version: CAMPAIGN_VERSION,
    id: string(raw["id"], "manifest.id"),
    goal: string(raw["goal"], "manifest.goal"),
    status: enumValue(raw["status"], campaignStatuses, "manifest.status"),
    acceptance: criteria,
    bar: referenceBar(raw["bar"], criteria),
    allowPlanning: raw["allowPlanning"],
    maxRounds,
    currentSliceId: nullableString(raw["currentSliceId"], "manifest.currentSliceId"),
    slices: slices(raw["slices"], maxRounds),
    planning: planning(raw["planning"]),
    integration: integration(raw["integration"]),
    coordination: coordination(raw["coordination"]),
    brain: brain(raw["brain"]),
    budget: budget(raw["budget"]),
    roles: roleProfiles(raw["roles"]),
    tasks: tasks(raw["tasks"]),
    summons: summons(raw["summons"]),
    spentUsdSnapshot: finiteNonnegative(raw["spentUsdSnapshot"], "manifest.spentUsdSnapshot"),
    spentTokensSnapshot: safeNonnegativeInteger(
      raw["spentTokensSnapshot"],
      "manifest.spentTokensSnapshot",
    ),
    updatedAt: isoDate(raw["updatedAt"], "manifest.updatedAt"),
  };
  validateConsistency(manifest);
  return manifest;
}

const campaignTransitions: Record<CampaignStatus, readonly CampaignStatus[]> = {
  pending: ["running", "blocked", "budget_exhausted", "capped"],
  running: ["blocked", "completed", "budget_exhausted", "capped"],
  blocked: ["running"],
  completed: [],
  budget_exhausted: ["running"],
  capped: [],
};

const sliceTransitions: Record<SliceStatus, readonly SliceStatus[]> = {
  pending: ["building", "blocked", "capped"],
  building: ["reviewing", "blocked", "capped"],
  reviewing: ["building", "accepted", "blocked", "capped"],
  accepted: ["building"],
  blocked: ["building"],
  capped: [],
};

export function assertCampaignTransition(from: CampaignStatus, to: CampaignStatus): void {
  if (from === to) return;
  if (!campaignTransitions[from].includes(to)) {
    throw new CampaignSchemaError(`Illegal campaign state transition: ${from} -> ${to}`);
  }
}

export function assertSliceTransition(from: SliceStatus, to: SliceStatus): void {
  if (from === to) return;
  if (!sliceTransitions[from].includes(to)) {
    throw new CampaignSchemaError(`Illegal slice state transition: ${from} -> ${to}`);
  }
}
