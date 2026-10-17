import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { LingClientError } from "../ling/client.js";
import { isTerminalStatus, TERMINAL_EVENT_TYPES } from "../ling/events.js";
import { LingProvisionerError } from "../ling/provisioner.js";
import type {
  LingEvent,
  LingHealth,
  LingLogEvent,
  LingPeerMessage,
  LingPeerMessageResponse,
  LingTask,
  LingWorkerVariant,
  SpawnInput,
  SpawnResponse,
} from "../ling/types.js";
import {
  FleetLedger,
  FleetLedgerStore,
  type FleetRateLimits,
  type SpawnBlockReason,
} from "../ledger.js";
import {
  applySpawnPolicy,
  profileCapabilityViolation,
  type SpawnPolicy,
} from "../policy.js";
import {
  MAX_LING_REQUEST_BODY_BYTES,
  artifactSourcePath,
  assertSeedFileLimits,
  type CampaignArtifactStore,
} from "./artifacts.js";
import type { CampaignBrain, CampaignBrainChoice, CampaignBrainPhase } from "./brain.js";
import {
  MAX_RECOVERY_DELAY_MS,
  decisionStateHash,
  hashState,
  integrationDecision,
  parseReplanProposal,
  recoveryDecision,
  reviewingDecision,
  schedulingDecision,
  type BrainDecision,
  type IntegrationInput,
} from "./decisions.js";
import {
  FINDINGS_FILE,
  RECORD_FINDING_TOOL_NAME,
  VERIFICATION_FILE,
  VERIFY_FINDING_TOOL_NAME,
  judgeFindings,
  parseFindingsDocument,
  parseVerificationDocument,
  scoreFindings,
  selectVerificationSample,
  type FindingsGateOutcome,
} from "./findings.js";
import {
  transitionCampaign,
  transitionSlice,
  type CampaignManifestStore,
} from "./manifest.js";
import {
  affectedSliceIds,
  parsePlanDocument,
  parseWorkerResult,
  type BuildWorkerResult,
  type PlanDocument,
  type PlanWorkerResult,
  type ReviewWorkerResult,
} from "./results.js";
import {
  builderTask,
  integrationTask,
  plannerTask,
  reviewerTask,
  type RoleTask,
} from "./roles.js";
import {
  createIntentTracker,
  diffIntent,
  resolveIntentReport,
  DECLARE_INTENT_TOOL_NAME,
  type IntentTracker,
} from "./intent.js";
import {
  campaignRequestKey,
  campaignRequestKeyPrefix,
  parseCampaignRequestKey,
} from "./request-key.js";
import { EventRecord, readEventRecord } from "./event-record.js";
import { PassiveMessaging } from "./messaging.js";
import {
  OVERSIGHT_TIMINGS,
  pairIdFor,
  watcherLimits,
  watcherTools,
  workerMaxRunMs,
  type OversightMessage,
  type OversightTimings,
} from "./oversight.js";
import {
  newPairRecord,
  OversightPair,
  terminationOf,
  type OversightClient,
  type OversightClock,
  type PairHost,
  type WatcherStop,
} from "./oversight-coordinator.js";
import { watcherBrief } from "./roles.js";
import type {
  ArtifactRef,
  CampaignDecisionPhase,
  CampaignIntentRecord,
  CampaignManifest,
  CampaignPairRecord,
  CampaignRole,
  CampaignStatus,
  CampaignSlice,
  CampaignTaskRecord,
  CampaignTaskTermination,
  CampaignWatchConfig,
  CampaignWorkRole,
  IntegrationAttempt,
  PairStartOutcome,
  SliceAttempt,
} from "./schema.js";

// Request keys moved to their own module; callers still import them from here.
export { campaignRequestKey } from "./request-key.js";

export interface CampaignLingClient {
  spawn(input: SpawnInput, preferredWorkerId?: string): Promise<SpawnResponse>;
  get(id: string, workerId?: string): Promise<LingTask>;
  list(): Promise<LingTask[]>;
  cancel(id: string, workerId?: string): Promise<void>;
  events?(
    id: string,
    workerId?: string,
    options?: { signal?: AbortSignal; sinceSeq?: number },
  ): AsyncIterable<LingEvent>;
  sendPeerMessage?(
    id: string,
    message: LingPeerMessage,
    workerId?: string,
  ): Promise<LingPeerMessageResponse>;
  /** Recorded event log for a settled task, for the declared-intent comparison. */
  history?(task: LingTask): Promise<LingLogEvent[]>;
  /** Ephemeral-client hook: durable output has been copied away from the worker. */
  collectComplete?(id: string, workerId?: string): Promise<void>;
  /**
   * Ephemeral-client hook: destroy the terminal worker after collection. With
   * terminate(), what a builder variant that says what the run keeps needs
   * (LEASE_ONLY_VARIANTS).
   */
  release?(id: string, workerId?: string): Promise<void>;
  /** Deliver an oversight message to a pair member (wire §4.2). Watched campaigns need it. */
  sendOversight?(
    id: string,
    message: OversightMessage,
    workerId?: string,
  ): Promise<{ accepted: true; duplicate: boolean }>;
  /** Every live worker's /healthz, keyed by worker id. A pair reads its leases' here. */
  health?(): Promise<Record<string, LingHealth>>;
  /**
   * Hard-kill the worker holding a task: one whose cancel went unconfirmed
   * past cancelGraceMs, or whose worker stopped answering past unreachableMs.
   * With it, a task the driver gives up on is killed rather than left
   * running. A kill that cannot be confirmed blocks the campaign with the
   * task still running, and shutdown() still only cancels.
   */
  terminate?(
    id: string,
    reason: "cancel-unconfirmed" | "worker-unreachable",
    workerId?: string,
  ): Promise<{ reason: string; requestedAt: string; completedAt?: string; errors: string[] }>;
  /** The service's own log for a task (`GET /tasks/:id/log`), stored before a pair is released. */
  fetchLog?(id: string, workerId?: string): Promise<LingEvent[]>;
}

/**
 * What the live event watcher accumulated for one task.
 *
 * `firstSeq` is the sequence number of the first event this watcher received.
 * The service retains a bounded event tail, so a stream that starts above 1 has
 * already dropped events — possibly the declaration itself — and cannot be
 * treated as a complete account no matter how much of it arrived.
 */
interface LiveIntentObservation {
  tracker: IntentTracker;
  firstSeq: number | undefined;
  /** Whether the first divergence has already been persisted mid-run. */
  reported: boolean;
  /** Whether the stream failed, which disqualifies it as a complete source. */
  broken: boolean;
}

export interface CampaignDriverOptions {
  client: CampaignLingClient;
  store: CampaignManifestStore;
  artifacts: CampaignArtifactStore;
  policy: SpawnPolicy;
  /** Optional cell-local model. It is consulted only by manifests with brain.enabled. */
  brain?: CampaignBrain;
  fleetStore?: FleetLedgerStore;
  /**
   * Rolling-window limits on pace, distinct from the depleting ceilings in `policy`.
   * Enforced only when a `fleetStore` is present, because the window is fleet-wide
   * state and an in-process ledger cannot see a sibling overlord's activity.
   */
  rateLimits?: FleetRateLimits;
  onProgress?: (manifest: CampaignManifest) => void | Promise<void>;
  pollIntervalMs?: number;
  /**
   * Allowance on top of twice a role's wall clock before a task is given up
   * on; for a watched builder, on top of its own wall clock and hold credit.
   */
  settleGraceMs?: number;
  /**
   * How long a task's worker may leave status reads unanswered before a
   * client that can kill it does (worker-unreachable). Without terminate()
   * a read that goes unanswered blocks the campaign at once.
   */
  unreachableMs?: number;
  /**
   * How long `shutdown` waits for the run loop to stop after cancelling remote work.
   * It exists to be short: past it, shutdown returns having stopped the spending and
   * left the books to the next run's reconciliation.
   */
  shutdownSettleMs?: number;
  /**
   * Timings and clock for watched pairs. Checks shrink them; production uses
   * the contract's. cancelGraceMs is the driver's too: on a client that can
   * kill, how long any task's cancel has to be confirmed before it is killed.
   */
  oversight?: { timings?: Partial<OversightTimings>; clock?: OversightClock };
}

export interface CampaignRunOptions {
  /** Reopen a previously blocked/budget-exhausted campaign and abandon orphaned tasks. */
  resumeBlocked?: boolean;
}

interface CollectedPlan {
  result: PlanWorkerResult;
  refs: ArtifactRef[];
  document: PlanDocument;
  bundle: string;
}

const MAX_PLANNING_CANDIDATE_BUNDLE_BYTES = 48 * 1024;

/**
 * The moment a pending recovery becomes eligible to reconcile.
 *
 * `notBefore` is read back from a file, so the ceiling the decision validator
 * enforces is applied a second time here. An unparseable timestamp yields `now`:
 * refusing to wait is the safe reading of a delay nobody can interpret.
 */
export function recoveryReconcileAt(notBefore: string, now: number): number {
  const parsed = Date.parse(notBefore);
  if (!Number.isFinite(parsed)) return now;
  return Math.min(parsed, now + MAX_RECOVERY_DELAY_MS);
}

const ORPHAN_GAP = "Overlord could not reconcile this in-flight task after Ling restarted.";

const PAIR_ORPHAN_DETAIL =
  "The overlord process that ran this pair ended before it settled; pairs do not survive a restart.";

/**
 * End a pair an earlier process left behind. One that was watching lost its
 * watcher (the overlord lost the streams); one still starting never ran.
 */
function markPairOrphaned(pair: CampaignPairRecord): void {
  if (pair.state === "watching") {
    pair.state = "lost";
    pair.lostCause ??= "stream_lost";
  } else if (pair.state === "starting") {
    pair.state = "aborted";
    pair.outcomeDetail ??= PAIR_ORPHAN_DETAIL;
  }
}

/**
 * The gap for an attempt whose pair was left open by the process that ran
 * it. A pair that never ran says so; one that failed to start says how, and
 * one a shutdown cut short says that.
 */
function pairLeftOpenGap(pair: CampaignPairRecord): string {
  const ended =
    pair.outcome === null
      ? (pair.outcomeDetail ?? PAIR_ORPHAN_DETAIL)
      : `Pair ${pair.pairId} did not start (${pair.outcome}${pair.outcomeDetail === null ? "" : `: ${pair.outcomeDetail}`}), and the overlord process that ran it ended before it closed the attempt.`;
  return `${ended} Resume to start the slice again.`;
}

/**
 * Why a builder variant runs only on a client with release() and terminate():
 * what its text tells the builder about what the run keeps. Pi's bash tool
 * writes the whole of any output over 50 KB or 2 000 lines to a file in its
 * process's temp directory and never deletes it. A local-task lease sets
 * TEMP, TMP and TMPDIR inside its own directory, which goes with the lease
 * when it is released or killed. A static fleet's worker keeps whatever temp
 * directory it was started with, and outlives its tasks, so the file stays:
 * L0h's "the operator does not keep your tool calls or their output" would
 * be false, and L1s's account of what the run's record holds would leave out
 * a copy of that output kept beside it. The fleet has neither method.
 *
 * Keyed by every variant, so a new one is decided here. Null where the
 * condition's own gate is enough, as for channel_unprompted: its text is the
 * channel paragraph less one sentence, so it tells the builder nothing about
 * what is kept that a standard channel builder is not told, and a channel
 * pair already needs terminate().
 *
 * The two methods stand in for the lease, which the driver cannot see. They
 * are ProvisionedLingClient's, and LocalTaskProvisioner, its one provisioner,
 * is what keeps the temp directory inside the lease. A provisioner whose
 * leases did not, or a wrapper that gives a client the methods it lacks,
 * would get past this, and nothing here can tell; withScriptedWatcher has
 * them only where the client it wraps does.
 */
export const LEASE_ONLY_VARIANTS: Readonly<Record<LingWorkerVariant, string | null>> = {
  tools_unrecorded:
    "its opening tells the builder that the operator does not keep its tool calls or their output",
  salience_matched: "its paragraph tells the builder what the run's record holds",
  channel_unprompted: null,
};

/** First terminal campaign outcome wins when parallel handlers settle together. */
function transitionCampaignIfActive(
  manifest: CampaignManifest,
  next: Exclude<CampaignStatus, "pending" | "running">,
): void {
  if (manifest.status === "pending" || manifest.status === "running") {
    transitionCampaign(manifest, next);
  }
}

/**
 * Reopen slices for an integration retry and mark the revision that asked for it
 * as scheduled, in one mutation.
 *
 * The deterministic path used to save once per slice and set the flag with the
 * first, so a crash between saves left the remaining slices accepted and the
 * flag telling the resumed run their repair was already scheduled.
 * `currentSliceId` is the caller's because the two paths have always persisted
 * different ones: the brain points at the first slice it chose, the
 * deterministic path at the last one tagged.
 */
function reopenForIntegration(
  manifest: CampaignManifest,
  sliceIds: readonly string[],
  currentSliceId: string | null,
): void {
  for (const id of sliceIds) transitionSlice(manifest, id, "building");
  const attempt = manifest.integration.attempts.at(-1);
  if (attempt !== undefined) attempt.retriesScheduled = true;
  manifest.currentSliceId = currentSliceId;
}

/**
 * A ling's own refusal of a task, when its POST was answered 400: how a ling
 * without oversight refuses the oversight tools, and how one with it refuses
 * options the contract forbids (§4.1, §11.2). Undefined for any other failure.
 */
function lingRefusal(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof LingClientError && current.status === 400) {
      return current.message.slice(0, 300);
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function taskTotalTokens(task: LingTask): number {
  const total = task.stats?.tokens.total ?? 0;
  return Number.isSafeInteger(total) && total > 0 ? total : 0;
}

/**
 * Whether a read says the task does not exist where it was asked for: a 404,
 * or ProvisionedLingClient's word that it cannot reach the task at all,
 * `unknown_task` for a task it has no route to and was named no worker for,
 * `no_lease` for a worker it holds no lease for. After a restart whose
 * recover() rebuilt no leases, as local-task's does not, every task an
 * earlier process spawned reads as one or the other. Only those codes. A
 * released or terminated worker is not a task that never existed, and a task
 * known to be on another worker than the one named (`unknown_worker`) is a
 * record at odds with the client, so both still stop reconcile rather than
 * orphan the task.
 */
function isNotFound(error: unknown): boolean {
  if (error instanceof LingProvisionerError) {
    return error.code === "unknown_task" || error.code === "no_lease";
  }
  return error instanceof LingClientError
    ? error.status === 404
    : typeof error === "object" &&
        error !== null &&
        "status" in error &&
        (error as { status?: unknown }).status === 404;
}

/**
 * Whether a read went unanswered: the worker could not be reached, or did
 * not respond in time. A worker that answered, even with an error, is
 * reachable, and a client's own refusal (a released worker, a task with no
 * route) is not the worker's silence.
 */
function isUnanswered(error: unknown): boolean {
  return error instanceof LingClientError && error.status === undefined;
}

function syntheticTask(record: CampaignTaskRecord, workspacesDir: string): LingTask {
  return {
    id: record.id,
    ...(record.requestKey === undefined ? {} : { requestKey: record.requestKey }),
    ...(record.workerId === undefined ? {} : { workerId: record.workerId }),
    status: record.status,
    prompt: "campaign task snapshot",
    options:
      record.effectiveTools === undefined
        ? {}
        : { tools: [...record.effectiveTools] },
    createdAt: record.createdAt,
    workspaceDir: path.join(workspacesDir, record.id),
    seededFiles: [],
    stats: {
      turns: 0,
      cost: record.costUsd,
      tokens: {
        input: record.totalTokens,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: record.totalTokens,
      },
    },
  };
}

export class CampaignDriver {
  private readonly client: CampaignLingClient;
  private readonly store: CampaignManifestStore;
  private readonly artifacts: CampaignArtifactStore;
  private readonly policy: SpawnPolicy;
  private readonly brain: CampaignBrain | undefined;
  private readonly fleetStore: FleetLedgerStore | undefined;
  private readonly rateLimits: FleetRateLimits | undefined;
  private readonly shutdownSettleMs: number;
  private readonly onProgress:
    | ((manifest: CampaignManifest) => void | Promise<void>)
    | undefined;
  private readonly pollIntervalMs: number;
  private readonly settleGraceMs: number;
  private readonly unreachableMs: number;
  private readonly cancelGraceMs: number;
  private readonly messaging: PassiveMessaging;
  private manifest!: CampaignManifest;
  private ledger!: FleetLedger;
  private resumeBlocked = false;
  private integrationAttemptsAtStart = 0;
  private shutdownRequested = false;
  private shutdownPromise: Promise<void> | undefined;
  private persistTail: Promise<void> = Promise.resolve();
  /** Serialize admission/recording while admitted worker tasks run concurrently. */
  private spawnTail: Promise<void> = Promise.resolve();
  /** Serialize model decisions so maxDecisions and replay keys remain atomic. */
  private brainTail: Promise<void> = Promise.resolve();
  private readonly eventTaps = new Map<
    string,
    { controller: AbortController; settled: Promise<void> }
  >();
  /**
   * The overlord's own record of each task's stream, as this process kept it.
   * Held after the tap closes it, because settlement judges from it, and
   * dropped once it has: a long campaign must not keep every task's events.
   */
  private readonly eventRecords = new Map<string, EventRecord>();
  /** Live declared-intent state per task, fed by the event tap as it runs. */
  private readonly intentObservations = new Map<string, LiveIntentObservation>();
  /**
   * Watched pairs this process is running, by the task ids of both members.
   * A pair found in the manifest but not here was left by an earlier process.
   */
  private readonly pairsByTask = new Map<string, OversightPair>();
  private readonly pairsById = new Map<string, OversightPair>();
  /** Tasks whose stored logs were taken while they still ran, to be taken again once they end. */
  private readonly partialLogs = new Set<string>();
  private readonly oversightTimings: Partial<OversightTimings> | undefined;
  private readonly oversightClock: OversightClock | undefined;
  /** Why the last role spawn threw, for a pair to tell a ling's refusal from a failure. */
  private lastSpawnError: unknown;
  private runSettled: Promise<void> | undefined;
  private settleRun: (() => void) | undefined;

  constructor(options: CampaignDriverOptions) {
    this.client = options.client;
    this.store = options.store;
    this.artifacts = options.artifacts;
    this.policy = options.policy;
    this.brain = options.brain;
    this.fleetStore = options.fleetStore;
    this.rateLimits = options.rateLimits;
    this.shutdownSettleMs = Math.max(1_000, options.shutdownSettleMs ?? 30_000);
    this.onProgress = options.onProgress;
    this.pollIntervalMs = Math.max(10, options.pollIntervalMs ?? 250);
    this.settleGraceMs = Math.max(0, options.settleGraceMs ?? 60_000);
    this.unreachableMs = Math.max(0, options.unreachableMs ?? 60_000);
    this.cancelGraceMs = Math.max(
      0,
      options.oversight?.timings?.cancelGraceMs ?? OVERSIGHT_TIMINGS.cancelGraceMs,
    );
    this.oversightTimings = options.oversight?.timings;
    this.oversightClock = options.oversight?.clock;
    this.messaging = new PassiveMessaging({
      manifest: () => this.manifest,
      persist: (mutate) => this.persist(mutate),
      client: this.client,
    });
  }

  async run(options: CampaignRunOptions = {}): Promise<CampaignManifest> {
    if (this.runSettled !== undefined) throw new Error("CampaignDriver.run() may only be called once.");
    this.runSettled = new Promise<void>((resolve) => {
      this.settleRun = resolve;
    });
    try {
      return await this.runCampaign(options);
    } finally {
      for (const pair of this.pairsById.values()) pair.dispose();
      await this.stopEventTaps();
      this.settleRun?.();
      this.settleRun = undefined;
    }
  }

  private async runCampaign(options: CampaignRunOptions): Promise<CampaignManifest> {
    this.resumeBlocked = options.resumeBlocked === true;
    this.manifest = await this.store.load();
    this.integrationAttemptsAtStart = this.manifest.integration.attempts.length;
    this.ledger = new FleetLedger({
      maxTasksPerRun: Math.min(this.policy.maxTasksPerRun, this.manifest.budget.maxTasks),
      maxConcurrentTasks: this.policy.maxConcurrentTasks,
      maxTotalCostUsd: Math.min(
        this.policy.maxTotalCostUsd,
        this.manifest.budget.maxTotalCostUsd,
      ),
      ...(this.manifest.budget.maxTotalTokens === undefined
        ? {}
        : { maxTotalTokens: this.manifest.budget.maxTotalTokens }),
    });
    if (
      this.manifest.coordination.passiveMessaging &&
      this.manifest.status !== "completed" &&
      this.manifest.status !== "capped" &&
      (this.client.events === undefined || this.client.sendPeerMessage === undefined)
    ) {
      await this.blockCampaign(
        "Passive messaging requires a Ling client with events() and sendPeerMessage().",
      );
      return this.manifest;
    }
    const watch = this.manifest.coordination.watch;
    if (
      watch !== undefined &&
      this.manifest.status !== "completed" &&
      this.manifest.status !== "capped" &&
      (this.client.events === undefined ||
        (watch.condition !== "no_watcher" &&
          (this.client.sendOversight === undefined ||
            this.client.health === undefined ||
            this.client.terminate === undefined)))
    ) {
      // The static fleet has no per-task kill, so this is where a campaign
      // with a watcher meets anything but a local-task client. A no_watcher
      // pair calls none of the three, and runs on it unless its builder's
      // variant says what the run keeps (below).
      await this.blockCampaign(
        "Watched builders require a Ling client with events(), sendOversight(), health() and terminate(); v1 pairs run only with LING_PROVISIONER=local-task.",
      );
      return this.manifest;
    }
    const variant = watch?.workerVariant;
    const leaseOnly = variant === undefined ? null : LEASE_ONLY_VARIANTS[variant];
    if (
      leaseOnly !== null &&
      this.manifest.status !== "completed" &&
      this.manifest.status !== "capped" &&
      (this.client.release === undefined || this.client.terminate === undefined)
    ) {
      // At start, as the gate above is, rather than at the builder's spawn,
      // so nothing is spent on a planner or a slice first; a resumed campaign
      // meets it again.
      await this.blockCampaign(
        `Worker variant ${variant} requires a Ling client with release() and terminate(): ${leaseOnly}, and Pi's bash tool keeps any long output in a file in its worker's temp directory, which only a local-task lease removes with the worker. It runs only with LING_PROVISIONER=local-task.`,
      );
      return this.manifest;
    }

    if (this.manifest.status === "completed") {
      return this.manifest;
    }
    if (this.manifest.status === "capped") {
      if (this.manifest.tasks.some((task) => !isTerminalStatus(task.status))) {
        const reconciled = await this.reconcile();
        if (reconciled) {
          for (const task of this.manifest.tasks.filter(
            (candidate) => !isTerminalStatus(candidate.status),
          )) {
            // A kill that is not confirmed has already said so.
            const stop = await this.stopTaskHard(task.id);
            if (!stop.stopped && stop.termination === undefined) {
              await this.blockCampaign(
                `Capped campaign could not confirm cancellation of task ${task.id}.`,
              );
            }
          }
        }
      }
      return this.manifest;
    }
    if (
      (this.manifest.status === "blocked" || this.manifest.status === "budget_exhausted") &&
      (this.manifest.brain.pendingRecovery !== null || !this.resumeBlocked) &&
      !(await this.maybeAutoRecoverHalt())
    ) {
      return this.manifest;
    }

    while (true) {
      const reconciled = await this.reconcile();
      if (!reconciled) {
        await this.clearAppliedPendingRecovery();
        if (await this.maybeAutoRecoverHalt()) continue;
        return this.manifest;
      }

      if (this.manifest.status !== "running") {
        await this.persist((manifest) => {
          transitionCampaign(manifest, "running");
          manifest.brain.pendingRecovery = null;
        });
      }
      // After the transition, not before: a leftover watcher whose kill is
      // not confirmed blocks the campaign, and a block applied first would be
      // undone by the transition, or never applied to a campaign resumed from
      // blocked.
      await this.abandonEarlierPairs();
      if (this.manifest.status !== "running") {
        if (await this.maybeAutoRecoverHalt()) continue;
        return this.manifest;
      }

      if (this.manifest.slices.length === 0) {
        const planned = await this.processPlanning();
        if (!planned) {
          if (await this.maybeAutoRecoverHalt()) continue;
          return this.manifest;
        }
      }

      while (this.manifest.status === "running") {
        const slicesAccepted = await this.processSlices();
        if (!slicesAccepted) break;
        const integrated = await this.processIntegration();
        if (integrated === "retry_slices") continue;
        return this.manifest;
      }
      if (await this.maybeAutoRecoverHalt()) continue;
      return this.manifest;
    }
  }

  /**
   * Stop campaign-owned work without changing the campaign verdict. The CLI
   * awaits this before stopping an overlord-owned Ling process.
   *
   * The order matters more than anything else here, and it used to be wrong. This
   * method began by awaiting `runSettled`, which put cancellation behind the one thing
   * most likely to be stuck: on a wedged driver the cancel loop was not slow, it was
   * unreachable, so a killed overlord cancelled nothing and its workers kept spending
   * with nobody left to collect their output. Bounding the overlord's life is not the
   * same as bounding the fleet's spend.
   *
   * So: cancel first, then wait for the loop, and only reconcile the books if the loop
   * actually stopped. Accounting against a manifest a live loop is still mutating would
   * trade a spend leak for a corrupt record, and reconciliation is recoverable — the
   * next run's `reconcile` reads the same workers and settles what it finds. Spend is
   * not recoverable.
   */
  async shutdown(): Promise<void> {
    this.shutdownRequested = true;
    if (this.shutdownPromise !== undefined) return this.shutdownPromise;
    this.shutdownPromise = (async () => {
      await this.cancelRemoteWorkNow();
      if (!(await this.runSettledWithin(this.shutdownSettleMs))) return;
      if (this.manifest === undefined || this.ledger === undefined) return;
      const activeIds = this.manifest.tasks
        .filter((record) => !isTerminalStatus(record.status))
        .map((record) => record.id);
      const releaseTasks: LingTask[] = [];
      /** Tasks whose cancellation was accepted but never observed to take effect. */
      const unconfirmed: string[] = [];
      for (const id of activeIds) {
        const before = this.manifest.tasks.find((record) => record.id === id);
        if (before === undefined || isTerminalStatus(before.status)) continue;
        try {
          await this.client.cancel(id, before.workerId);
        } catch {
          // It may have settled between the manifest snapshot and cancellation.
        }
        const task = await this.readUntilTerminal(id, before.workerId, 5_000).catch(
          () => undefined,
        );
        const current = this.manifest.tasks.find((record) => record.id === id);
        if (current === undefined) continue;
        // Same rule as `cancelTask`: only a terminal status this process actually read
        // may be written down. A task still running after its cancellation was accepted
        // stays active in the record, keeps its concurrency and spend commitments, and
        // is not released — releasing a worker that is still working is how a stop
        // becomes an orphan. What was observed is still recorded: cost and tokens.
        if (task !== undefined && isTerminalStatus(task.status)) {
          current.status = task.status;
          current.costUsd = Math.max(current.costUsd, task.stats?.cost ?? 0);
          current.totalTokens = Math.max(current.totalTokens, taskTotalTokens(task));
          this.account(task, current.workerId, current.requestKey);
          if (task.status !== "completed") releaseTasks.push(task);
        } else if (task !== undefined) {
          current.costUsd = Math.max(current.costUsd, task.stats?.cost ?? 0);
          current.totalTokens = Math.max(current.totalTokens, taskTotalTokens(task));
          this.account(task, current.workerId, current.requestKey);
          unconfirmed.push(id);
        } else {
          unconfirmed.push(id);
        }
      }
      await this.persist();
      for (const task of releaseTasks) {
        // The loop stopped waiting for a pair member before it ended, and kept
        // its logs as they stood. They are taken again, whole, before its lease goes.
        if (this.partialLogs.has(task.id)) await this.storeTaskLogs(task.id);
        await this.releaseUnsuccessfulTask(task);
      }
      if (unconfirmed.length > 0) {
        // Said out loud rather than left in the manifest to be noticed: an operator
        // stopping a campaign needs to know the fleet may still be spending, and the
        // reaper is the tool that finishes the job.
        console.error(
          `campaign ${this.manifest.id}: cancellation unconfirmed for ${unconfirmed.join(", ")}; run reap to confirm the fleet stopped`,
        );
      }
    })();
    return this.shutdownPromise;
  }

  /**
   * Tell every worker to stop, immediately, and touch no local state.
   *
   * Deliberately concurrent, where the accounting pass below is sequential. The point
   * of this pass is elapsed time — every task cancelled inside one request timeout
   * rather than one timeout per task — which is what stops `TimeoutStopSec` having to
   * scale with `FLEET_MAX_CONCURRENT` to avoid killing a legitimate cleanup halfway.
   *
   * It reads task ids from the manifest and writes nothing, so it is safe to run while
   * the loop is still live: cancellation is idempotent on the worker side, and the loop
   * observes the resulting statuses through its ordinary polling.
   */
  private async cancelRemoteWorkNow(): Promise<void> {
    if (this.manifest === undefined) return;
    const targets = this.manifest.tasks
      .filter((record) => !isTerminalStatus(record.status))
      .map((record) => ({ id: record.id, workerId: record.workerId }));
    await Promise.all(
      targets.map((target) =>
        this.client.cancel(target.id, target.workerId).catch(() => undefined),
      ),
    );
  }

  /** Whether the run loop stopped within the deadline. Never throws, never hangs. */
  private async runSettledWithin(timeoutMs: number): Promise<boolean> {
    if (this.runSettled === undefined) return true;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.runSettled.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async reconcile(): Promise<boolean> {
    for (const record of this.manifest.tasks) {
      const snapshot = syntheticTask(record, this.artifacts.workspacesDir);
      this.account(snapshot, record.workerId, record.requestKey);
    }

    let listed: LingTask[];
    try {
      listed = await this.client.list();
    } catch (error) {
      await this.blockCampaign(`Worker reconciliation listing failed: ${errorMessage(error)}`);
      return false;
    }
    const knownIds = new Set(this.manifest.tasks.map((record) => record.id));
    for (const task of listed) {
      if (
        task.requestKey === undefined ||
        !task.requestKey.startsWith(campaignRequestKeyPrefix(this.manifest.id)) ||
        knownIds.has(task.id)
      ) {
        continue;
      }
      if (this.adoptListedTask(task)) {
        knownIds.add(task.id);
        this.account(task, task.workerId, task.requestKey);
      } else {
        await this.client.cancel(task.id, task.workerId).catch(() => undefined);
      }
    }

    const listedById = new Map(listed.map((task) => [task.id, task]));
    const missingActive: CampaignTaskRecord[] = [];
    for (const original of this.manifest.tasks) {
      const summon = this.manifest.summons.find(
        (intent) => intent.requestKey === original.requestKey,
      );
      if (isTerminalStatus(original.status) && summon?.state === "released") continue;
      try {
        const listedTask = listedById.get(original.id);
        let current = this.manifest.tasks.find((record) => record.id === original.id);
        if (current === undefined) continue;
        if (current.workerId === undefined && listedTask?.workerId !== undefined) {
          current.workerId = listedTask.workerId;
        }
        if (current.requestKey === undefined && listedTask?.requestKey !== undefined) {
          current.requestKey = listedTask.requestKey;
        }
        const task = await this.client.get(current.id, current.workerId);
        current = this.manifest.tasks.find((record) => record.id === original.id);
        if (current === undefined) continue;
        this.account(task, current.workerId, current.requestKey);
        current.status = task.status;
        current.costUsd = Math.max(0, task.stats?.cost ?? current.costUsd);
        current.totalTokens = Math.max(current.totalTokens, taskTotalTokens(task));
        if (task.options.tools !== undefined) {
          current.effectiveTools = [...new Set(task.options.tools)];
        }
      } catch (error) {
        const current = this.manifest.tasks.find((record) => record.id === original.id);
        if (!isNotFound(error)) {
          await this.blockCampaign(
            `Worker reconciliation failed for task ${original.id}: ${errorMessage(error)}`,
          );
          return false;
        }
        if (current !== undefined && !isTerminalStatus(current.status)) missingActive.push(current);
      }
    }

    if (missingActive.length > 0) {
      if (
        this.resumeBlocked &&
        (this.manifest.status === "blocked" || this.manifest.status === "budget_exhausted")
      ) {
        for (const record of missingActive) {
          this.abandonOrphan(record);
          const snapshot = syntheticTask(record, this.artifacts.workspacesDir);
          this.account(snapshot, record.workerId, record.requestKey);
        }
        await this.persist();
        return true;
      }
      const first = missingActive[0];
      await this.markOrphanBlocked(
        first ?? (() => {
          throw new Error("Missing active campaign task.");
        })(),
      );
      return false;
    }

    await this.persist();
    if (!(await this.reconcileProvisionedTeardown())) return false;
    for (const record of this.manifest.tasks) {
      const summon = this.manifest.summons.find(
        (intent) => intent.requestKey === record.requestKey,
      );
      if (summon?.state === "released") continue;
      this.startEventTap(record, true);
    }
    for (const record of this.manifest.tasks) {
      if (isTerminalStatus(record.status)) await this.drainEventTap(record.id);
    }
    return true;
  }

  private async reconcileProvisionedTeardown(): Promise<boolean> {
    if (this.client.release === undefined) return true;
    for (const intent of this.manifest.summons) {
      if (intent.state !== "collected" && intent.state !== "spawned") continue;
      if (intent.taskId === null) continue;
      const record = this.manifest.tasks.find((task) => task.id === intent.taskId);
      if (record === undefined || !isTerminalStatus(record.status)) continue;
      try {
        const task = await this.client.get(record.id, record.workerId);
        if (intent.state === "collected" && task.status === "completed") {
          await this.releaseCollectedTask(task);
        } else if (task.status !== "completed") {
          await this.releaseUnsuccessfulTask(task);
        }
      } catch (error) {
        // Nothing is left here to tear down of a worker this process holds
        // no lease for, as after a restart, whether or not its task was
        // collected; nor of a collected task's worker that is gone.
        if (
          error instanceof LingProvisionerError &&
          (error.code === "no_lease" ||
            (intent.state === "collected" &&
              (error.code === "unknown_worker" || error.code === "worker_released")))
        ) {
          await this.updateSummonState(
            syntheticTask(record, this.artifacts.workspacesDir),
            "released",
          );
          continue;
        }
        await this.blockCampaign(
          `Provisioned worker teardown reconciliation failed for task ${record.id}: ${errorMessage(error)}`,
        );
        return false;
      }
    }
    return true;
  }

  private adoptListedTask(task: LingTask): boolean {
    if (task.requestKey === undefined) return false;
    const parsed = parseCampaignRequestKey(this.manifest.id, task.requestKey);
    if (parsed === undefined) return false;
    let adopted = false;
    let pairId: string | undefined;
    if (parsed.role === "planner" && parsed.sliceId === null) {
      const candidateCount = this.manifest.coordination.planningCandidates;
      const finalRound = candidateCount > 1 ? candidateCount + 1 : 1;
      if (
        candidateCount > 1 &&
        parsed.round <= candidateCount &&
        parsed.round === this.manifest.planning.candidateTaskIds.length + 1
      ) {
        this.manifest.planning.candidateTaskIds.push(task.id);
        this.manifest.planning.status = "running";
        adopted = true;
      } else if (parsed.round === finalRound && this.manifest.planning.taskId === null) {
        this.manifest.planning.taskId = task.id;
        this.manifest.planning.status = "running";
        adopted = true;
      }
    } else if (
      (parsed.role === "builder" || parsed.role === "reviewer") &&
      parsed.sliceId !== null
    ) {
      const slice = this.manifest.slices.find((candidate) => candidate.id === parsed.sliceId);
      const attempt = slice?.attempts.find((candidate) => candidate.round === parsed.round);
      if (attempt !== undefined) {
        if (parsed.role === "builder" && attempt.builderId === null) {
          attempt.builderId = task.id;
          adopted = true;
        }
        if (parsed.role === "reviewer" && attempt.reviewerId === null) {
          attempt.reviewerId = task.id;
          adopted = true;
        }
      }
    } else if (parsed.role === "watcher" && parsed.sliceId !== null) {
      // A watcher spawned in a crash window before it was recorded. It is
      // adopted so its spend is counted and it is recorded, and then stopped:
      // pairs do not survive a restart (abandonEarlierPairs).
      const pair = this.pairRecordOf(this.manifest, parsed);
      if (pair !== undefined && pair.watcherTaskId === null) {
        pair.watcherTaskId = task.id;
        pairId = pair.pairId;
        adopted = true;
      }
    } else if (parsed.role === "integration" && parsed.sliceId === null) {
      const attempt = this.manifest.integration.attempts.find(
        (candidate) => candidate.round === parsed.round,
      );
      if (attempt !== undefined && attempt.reviewerId === null) {
        attempt.reviewerId = task.id;
        if (attempt === this.manifest.integration.attempts.at(-1)) {
          this.manifest.integration.reviewerId = task.id;
        }
        adopted = true;
      }
    }
    if (!adopted) return false;
    this.manifest.tasks.push({
      id: task.id,
      requestKey: task.requestKey,
      ...(task.workerId === undefined ? {} : { workerId: task.workerId }),
      role: parsed.role,
      sliceId: parsed.sliceId,
      round: parsed.round,
      status: task.status,
      costUsd: Math.max(0, task.stats?.cost ?? 0),
      totalTokens: taskTotalTokens(task),
      seedProvenance: "unavailable",
      seededArtifacts: [],
      seededMessageIds: [],
      ...(task.options.tools === undefined
        ? {}
        : { effectiveTools: [...new Set(task.options.tools)] }),
      ...(pairId === undefined ? {} : { pairId }),
      createdAt: task.createdAt,
    });
    return true;
  }

  /**
   * Give up on a task a restart left in flight that no read can find. Its end
   * was never seen, so what it spent is not known, and its record does not
   * say: a task's cost is written to it when the task ends, so one left
   * running reads about $0. It is charged its ceiling, or its recorded cost
   * where that is more, as ProvisionedLingClient charges a task whose worker
   * went before it reported an end. Under local-task every member of a pair
   * a restart left running comes here.
   */
  private abandonOrphan(record: CampaignTaskRecord): void {
    record.status = "failed";
    record.costUsd = Math.max(record.costUsd, this.costCeilingFor(record));
    if (record.role === "planner") {
      this.manifest.planning.status = "pending";
      const candidateIndex = this.manifest.planning.candidateTaskIds.indexOf(record.id);
      if (candidateIndex >= 0) {
        if (candidateIndex === this.manifest.planning.candidateTaskIds.length - 1) {
          this.manifest.planning.candidateTaskIds.splice(candidateIndex);
          this.manifest.planning.candidateArtifacts.splice(candidateIndex);
        } else {
          this.manifest.planning.status = "blocked";
          this.manifest.planning.gaps.push(
            "An earlier planning candidate was orphaned after later candidates were recorded; refusing to shift round identities.",
          );
        }
      } else {
        this.manifest.planning.taskId = null;
      }
      this.manifest.planning.gaps.push(ORPHAN_GAP);
      return;
    }
    if (record.role === "builder" || record.role === "reviewer") {
      const slice = this.requireSlice(record.sliceId);
      const attempt = slice.attempts.find((candidate) => candidate.round === record.round);
      if (attempt !== undefined) {
        attempt.verdict = "revise";
        attempt.gaps.push(ORPHAN_GAP);
        attempt.costUsd = this.costFor(attempt.builderId, attempt.reviewerId);
      }
      if (slice.status !== "building") transitionSlice(this.manifest, slice.id, "building");
      return;
    }
    if (record.role === "watcher") {
      // A watcher is not the attempt's work, so its loss leaves the attempt's
      // verdict alone; it ends the pair, which an earlier process left anyway.
      const pair = this.pairRecordOf(this.manifest, record);
      if (pair !== undefined) markPairOrphaned(pair);
      return;
    }
    const attempt = this.manifest.integration.attempts.find(
      (candidate) => candidate.round === record.round,
    );
    if (attempt !== undefined) {
      attempt.verdict = "blocked";
      attempt.gaps.push(ORPHAN_GAP);
      attempt.costUsd = record.costUsd;
      this.syncIntegrationSummary(attempt);
    }
  }

  private async markOrphanBlocked(record: CampaignTaskRecord): Promise<void> {
    await this.persist((manifest) => {
      if (record.role === "planner") {
        manifest.planning.status = "blocked";
        manifest.planning.gaps.push(ORPHAN_GAP);
      } else if (record.role === "builder" || record.role === "reviewer") {
        const slice = manifest.slices.find((candidate) => candidate.id === record.sliceId);
        if (slice !== undefined && slice.status !== "blocked") {
          transitionSlice(manifest, slice.id, "blocked");
          slice.attempts.at(-1)?.gaps.push(ORPHAN_GAP);
        }
      } else if (record.role === "watcher") {
        // The campaign stops as it does for any orphan, but the gap is the
        // watched attempt's, not integration's, and the attempt's builder is
        // left to be reconciled on its own.
        const pair = this.pairRecordOf(manifest, record);
        if (pair !== undefined) markPairOrphaned(pair);
        const attempt = manifest.slices
          .find((candidate) => candidate.id === record.sliceId)
          ?.attempts.find((candidate) => candidate.round === record.round);
        attempt?.gaps.push(`Watcher ${record.id}: ${ORPHAN_GAP}`);
      } else {
        manifest.integration.gaps.push(ORPHAN_GAP);
      }
      transitionCampaignIfActive(manifest, "blocked");
    });
  }

  /** The pair record a pair member belongs to, in the given manifest. */
  private pairRecordOf(
    manifest: CampaignManifest,
    record: Pick<CampaignTaskRecord, "sliceId" | "round">,
  ): CampaignPairRecord | undefined {
    if (record.sliceId === null) return undefined;
    return manifest.slices
      .find((candidate) => candidate.id === record.sliceId)
      ?.attempts.find((candidate) => candidate.round === record.round)?.watch;
  }

  /**
   * Pairs an earlier process left running (§15): their state lives only in
   * the process that ran them. Each open one is recorded as lost or aborted,
   * and any watcher of a pair this process does not run that is still live is
   * stopped, including one whose kill an earlier pass could not confirm. A
   * kill that is still not confirmed blocks the campaign. The builder carries
   * on as an unwatched task; nothing here cancels it.
   *
   * Stopping needs a client that still reaches the watcher. Under local-task,
   * the only mode pairs run in, an earlier process's leases are not recovered
   * (`recover()` is a no-op): neither member can be reached or killed from
   * here, and each local child exits on its own once the overlord that
   * started it is gone. Reconcile finds both members without a lease and
   * takes the orphan path first, so in v1 this stop runs only against a
   * client that outlives the overlord, which means the checks' fake ones.
   */
  private async abandonEarlierPairs(): Promise<void> {
    const earlier = (manifest: CampaignManifest) =>
      manifest.slices.flatMap((slice) =>
        slice.attempts.flatMap((attempt) =>
          attempt.watch === undefined || this.pairsById.has(attempt.watch.pairId)
            ? []
            : [attempt.watch],
        ),
      );
    // markPairOrphaned changes only a pair still starting or watching.
    const open = (pair: CampaignPairRecord) => pair.state === "starting" || pair.state === "watching";
    if (earlier(this.manifest).some(open)) {
      await this.persist((manifest) => earlier(manifest).forEach(markPairOrphaned));
    }
    for (const { watcherTaskId } of earlier(this.manifest)) {
      if (watcherTaskId === null) continue;
      const record = this.manifest.tasks.find((task) => task.id === watcherTaskId);
      if (record === undefined || isTerminalStatus(record.status)) continue;
      await this.stopTaskHard(watcherTaskId);
    }
  }

  private async processPlanning(): Promise<boolean> {
    if (!this.manifest.allowPlanning) {
      await this.blockCampaign("Campaign has no supplied slices and planning is not allowed.");
      return false;
    }
    if (this.manifest.planning.status === "blocked") {
      await this.blockCampaign(this.manifest.planning.gaps.at(-1) ?? "Planning is blocked.");
      return false;
    }
    const candidateCount = this.manifest.coordination.planningCandidates;
    if (candidateCount > 1 && !(await this.processPlanningCandidates(candidateCount))) {
      return false;
    }
    if (this.manifest.planning.taskId === null) {
      await this.persist((manifest) => {
        manifest.planning.status = "running";
      });
      let roleTask: RoleTask;
      try {
        const candidatePlans =
          candidateCount > 1
            ? await Promise.all(
                this.manifest.planning.candidateArtifacts.map(async (ref) => ({
                  artifact: ref,
                  content: await this.artifacts.readText(ref),
                })),
              )
            : undefined;
        roleTask = await plannerTask(this.manifest, {
          ...(candidatePlans === undefined ? {} : { candidatePlans }),
        });
      } catch (error) {
        await this.blockPlanning(errorMessage(error));
        return false;
      }
      const finalRound = candidateCount > 1 ? candidateCount + 1 : 1;
      await this.recordDecision(
        "planning",
        candidateCount > 1 ? "synthesize_plan" : "create_plan",
        candidateCount > 1
          ? `Synthesize ${candidateCount} independently validated planning proposals.`
          : "Run the compatibility single-planner path.",
        this.manifest.planning.candidateArtifacts.map((ref) => ref.artifactId),
      );
      const spawned = await this.spawnRole(
        "planner",
        null,
        finalRound,
        roleTask,
        (manifest, id) => {
          manifest.planning.taskId = id;
          manifest.planning.status = "running";
        },
      );
      if (spawned === null) return false;
    }

    const plannerId = this.manifest.planning.taskId;
    if (plannerId === null) {
      await this.blockPlanning("Planner task id was not recorded.");
      return false;
    }
    const task = await this.waitForTask(plannerId, this.manifest.roles.planner.maxWallClockMs);
    if (task === undefined) return false;
    if (task.status !== "completed") {
      await this.blockPlanning(`Planner task ${plannerId} ended as ${task.status}: ${task.error ?? "no result"}`);
      await this.releaseUnsuccessfulTask(task);
      return false;
    }

    try {
      const collected = await this.collectPlannerOutput(
        task,
        candidateCount > 1 ? "planning/final" : "planning/1",
      );
      const plannedSlices = collected.document.slices.map((slice) => {
        if (Buffer.byteLength(slice.id, "utf8") > 64) {
          throw new Error(`Planned slice id ${JSON.stringify(slice.id)} exceeds 64 UTF-8 bytes.`);
        }
        campaignRequestKey(
          this.manifest.id,
          "builder",
          slice.id,
          this.manifest.maxRounds,
        );
        const index = collected.result.data.artifacts.findIndex(
          (claim) => claim.path === slice.path,
        );
        const spec = collected.refs[index];
        if (spec === undefined) {
          throw new Error(`Planner did not list specification ${slice.path} as an artifact.`);
        }
        return {
          id: slice.id,
          spec,
          status: "pending" as const,
          attempts: [],
          createdInRound: 0,
          ...(slice.dependsOn === undefined ? {} : { dependsOn: slice.dependsOn }),
        };
      });
      // The save validates the plan against the whole manifest, and a refused
      // save leaves the in-memory manifest untouched, so a bad plan lands in the
      // catch below having changed nothing.
      await this.persist((manifest) => {
        manifest.planning.status = "completed";
        manifest.planning.artifacts = collected.refs;
        manifest.planning.evidence = [collected.result.summary];
        manifest.planning.gaps = [];
        manifest.slices = plannedSlices;
        manifest.currentSliceId = plannedSlices[0]?.id ?? null;
      });
    } catch (error) {
      await this.blockPlanning(`Planner result rejected: ${errorMessage(error)}`);
      return false;
    }
    await this.releaseCollectedTask(task);
    return true;
  }

  private async processPlanningCandidates(candidateCount: number): Promise<boolean> {
    while (this.manifest.planning.candidateArtifacts.length < candidateCount) {
      const candidateIndex = this.manifest.planning.candidateArtifacts.length;
      const candidateNumber = candidateIndex + 1;
      if (this.manifest.planning.candidateTaskIds.length === candidateIndex) {
        await this.recordDecision(
          "planning",
          "request_candidate_plan",
          `Request independent planning candidate ${candidateNumber} of ${candidateCount}.`,
          [`candidate:${candidateNumber}`],
        );
        let roleTask: RoleTask;
        try {
          roleTask = await plannerTask(this.manifest, { candidateNumber });
        } catch (error) {
          await this.blockPlanning(errorMessage(error));
          return false;
        }
        const spawned = await this.spawnRole(
          "planner",
          null,
          candidateNumber,
          roleTask,
          (manifest, id) => {
            manifest.planning.candidateTaskIds.push(id);
            manifest.planning.status = "running";
          },
        );
        if (spawned === null) return false;
      }
      const candidateId = this.manifest.planning.candidateTaskIds[candidateIndex];
      if (candidateId === undefined) {
        await this.blockPlanning("Planning candidate task id was not recorded.");
        return false;
      }
      const task = await this.waitForTask(
        candidateId,
        this.manifest.roles.planner.maxWallClockMs,
      );
      if (task === undefined) return false;
      if (task.status !== "completed") {
        await this.blockPlanning(
          `Planning candidate ${candidateId} ended as ${task.status}: ${task.error ?? "no result"}`,
        );
        await this.releaseUnsuccessfulTask(task);
        return false;
      }
      try {
        const collected = await this.collectPlannerOutput(
          task,
          `planning/candidates/${candidateNumber}`,
        );
        const proposal = await this.artifacts.storeText(
          `planning/candidate-${candidateNumber}`,
          "proposal.json",
          collected.bundle,
        );
        await this.persist((manifest) => {
          manifest.planning.candidateArtifacts.push(proposal);
          manifest.planning.evidence.push(
            `Candidate ${candidateNumber}: ${collected.result.summary}`,
          );
        });
      } catch (error) {
        await this.blockPlanning(
          `Planning candidate result rejected: ${errorMessage(error)}`,
        );
        return false;
      }
      await this.releaseCollectedTask(task);
    }
    return true;
  }

  private async collectPlannerOutput(
    task: LingTask,
    namespace: string,
  ): Promise<CollectedPlan> {
    const parsed = parseWorkerResult(
      task.result,
      "planner",
      this.manifest.acceptance,
      this.manifest.bar,
    );
    if (parsed.data.kind !== "plan") throw new Error("Planner returned the wrong result kind.");
    const result = parsed as PlanWorkerResult;
    const refs = await this.artifacts.collectTaskArtifacts(
      task,
      result.data.artifacts,
      namespace,
    );
    const planIndex = result.data.artifacts.findIndex((claim) => claim.path === "plan.json");
    const planRef = refs[planIndex];
    if (planRef === undefined) throw new Error("Collected planner output did not include plan.json.");
    const document = parsePlanDocument(JSON.parse(await this.artifacts.readText(planRef)));
    const specifications: Record<string, string> = {};
    for (const slice of document.slices) {
      const index = result.data.artifacts.findIndex((claim) => claim.path === slice.path);
      const spec = refs[index];
      if (spec === undefined) {
        throw new Error(`Planner did not list specification ${slice.path} as an artifact.`);
      }
      specifications[slice.id] = await this.artifacts.readText(spec);
    }
    let specificationChars = Math.max(
      256,
      Math.floor(24_000 / Math.max(1, document.slices.length)),
    );
    let bundle = "";
    while (true) {
      const boundedSpecifications = Object.fromEntries(
        Object.entries(specifications).map(([id, content]) => [
          id,
          content.length <= specificationChars
            ? content
            : `${content.slice(0, specificationChars)}\n[specification truncated in candidate bundle]`,
        ]),
      );
      bundle = `${JSON.stringify(
        {
          summary: result.summary,
          plan: document,
          specifications: boundedSpecifications,
        },
        null,
        2,
      )}\n`;
      if (Buffer.byteLength(bundle, "utf8") <= MAX_PLANNING_CANDIDATE_BUNDLE_BYTES) break;
      if (specificationChars <= 64) {
        throw new Error(
          `Planning candidate bundle exceeds ${MAX_PLANNING_CANDIDATE_BUNDLE_BYTES} bytes after bounded specification summaries.`,
        );
      }
      specificationChars = Math.max(64, Math.floor(specificationChars / 2));
    }
    return {
      result,
      refs,
      document,
      bundle,
    };
  }

  private async processSlices(): Promise<boolean> {
    if (this.manifest.brain.enabled) {
      return this.processSlicesWithBrain();
    }
    if (this.manifest.coordination.parallelSlices) {
      return this.processSlicesInParallel();
    }
    for (const sliceId of this.manifest.slices.map((slice) => slice.id)) {
      if (!(await this.processOneSlice(sliceId))) return false;
    }
    return this.manifest.slices.every((slice) => slice.status === "accepted");
  }

  private async processSlicesWithBrain(): Promise<boolean> {
    while (this.manifest.status === "running") {
      const graph = await this.dependencyReady();
      if (graph === undefined) return true;
      const { accepted, ready } = graph;
      if (ready.length === 0) return false;
      const decision = schedulingDecision({
        goal: this.manifest.goal,
        acceptedSliceIds: accepted,
        maxBatch: this.manifest.coordination.parallelSlices
          ? Math.min(this.policy.maxConcurrentTasks, ready.length)
          : 1,
        readySlices: ready.map((slice) => ({
          id: slice.id,
          status: slice.status,
          dependsOn: slice.dependsOn ?? [],
          attemptsUsed: slice.attempts.length,
          attemptsRemaining: this.sliceAttemptLimit(slice) - slice.attempts.length,
          lastGaps: slice.attempts.at(-1)?.gaps ?? [],
        })),
      });
      const key = decision.request.key;
      let choice: CampaignBrainChoice;
      try {
        choice = await this.decideWithBrain(decision);
      } catch (error) {
        await this.blockCampaign(`Brain scheduling failed: ${errorMessage(error)}`);
        return false;
      }
      if (choice.action === "halt_campaign") {
        await this.persist((manifest) => {
          this.markBrainDecisionApplied(manifest, key);
          manifest.integration.gaps.push(`Overlord brain halted scheduling: ${choice.rationale}`);
          transitionCampaignIfActive(manifest, "blocked");
        });
        return false;
      }
      const ids = choice.arguments["sliceIds"] as string[];
      await this.persist((manifest) => this.markBrainDecisionApplied(manifest, key));
      const outcomes = await Promise.all(ids.map((id) => this.processOneSlice(id)));
      if (outcomes.some((outcome) => !outcome) || this.manifest.status !== "running") return false;
    }
    return false;
  }

  private async processSlicesInParallel(): Promise<boolean> {
    while (this.manifest.status === "running") {
      const graph = await this.dependencyReady();
      if (graph === undefined) return true;
      if (graph.ready.length === 0) return false;
      const ready = graph.ready.slice(0, this.policy.maxConcurrentTasks);
      for (const slice of ready) {
        await this.recordDecision(
          "building",
          "schedule_slice",
          `Slice ${slice.id} is dependency-ready and may run with its ready peers.`,
          [`slice:${slice.id}`, `attempts:${slice.attempts.length}`],
        );
      }
      const outcomes = await Promise.all(ready.map((slice) => this.processOneSlice(slice.id)));
      if (outcomes.some((outcome) => !outcome) || this.manifest.status !== "running") return false;
    }
    return false;
  }

  /**
   * Incomplete slices whose declared dependencies are all accepted, with the
   * accepted ids they were judged against. Undefined once nothing is incomplete.
   * Work remaining with none of it ready blocks the campaign and comes back as an
   * empty list.
   */
  private async dependencyReady(): Promise<
    { accepted: string[]; ready: CampaignSlice[] } | undefined
  > {
    const incomplete = this.manifest.slices.filter((slice) => slice.status !== "accepted");
    if (incomplete.length === 0) return undefined;
    const accepted = this.manifest.slices
      .filter((slice) => slice.status === "accepted")
      .map((slice) => slice.id);
    const acceptedIds = new Set(accepted);
    const ready = incomplete.filter((slice) =>
      (slice.dependsOn ?? []).every((dependency) => acceptedIds.has(dependency)),
    );
    if (ready.length === 0) {
      await this.blockCampaign(
        `No dependency-ready slices remain; incomplete: ${incomplete.map((slice) => slice.id).join(", ")}.`,
      );
    }
    return { accepted, ready };
  }

  private async processOneSlice(sliceId: string): Promise<boolean> {
    while (this.manifest.status === "running") {
      const slice = this.requireSlice(sliceId);
      if (slice.status === "accepted") return true;
      if (slice.status === "capped") {
        await this.capCampaign(
          `Slice ${slice.id} exhausted its ${this.sliceAttemptLimit(slice)} allowed round(s).`,
        );
        return false;
      }
      if (slice.status === "blocked") {
        if (!this.resumeBlocked) {
          await this.blockCampaign(
            slice.attempts.at(-1)?.gaps.at(-1) ?? `Slice ${slice.id} is blocked.`,
          );
          return false;
        }
        if (slice.attempts.length >= this.sliceAttemptLimit(slice)) {
          await this.capSlice(slice.id);
          return false;
        }
        await this.persist((manifest) => transitionSlice(manifest, slice.id, "building"));
        continue;
      }
      if (slice.status === "pending") {
        if (!(await this.beginAttempt(slice.id))) return false;
        continue;
      }
      if (slice.status === "building") {
        const latest = slice.attempts.at(-1);
        if (latest === undefined || latest.verdict !== null) {
          if (!(await this.beginAttempt(slice.id))) return false;
          continue;
        }
        if (!(await this.processBuilder(slice.id, latest.round))) return false;
        continue;
      }
      if (slice.status === "reviewing") {
        const latest = slice.attempts.at(-1);
        if (latest === undefined) {
          await this.blockSlice(slice.id, "Reviewing state has no slice attempt.");
          return false;
        }
        const outcome = await this.processReviewer(slice.id, latest.round);
        if (outcome === "stop") return false;
      }
    }
    return false;
  }

  private async beginAttempt(sliceId: string): Promise<boolean> {
    const slice = this.requireSlice(sliceId);
    if (slice.attempts.length >= this.sliceAttemptLimit(slice)) {
      await this.capSlice(sliceId);
      return false;
    }
    const round = slice.attempts.length + 1;
    await this.persist((manifest) => {
      const current = manifest.slices.find((candidate) => candidate.id === sliceId);
      if (current === undefined) throw new Error(`Unknown slice ${sliceId}.`);
      if (current.status !== "building") transitionSlice(manifest, sliceId, "building");
      current.attempts.push({
        round,
        builderId: null,
        reviewerId: null,
        artifacts: [],
        verdict: null,
        evidence: [],
        gaps: [],
        costUsd: 0,
      });
      manifest.currentSliceId = sliceId;
    });
    return true;
  }

  private async processBuilder(sliceId: string, round: number): Promise<boolean> {
    let slice = this.requireSlice(sliceId);
    let attempt = this.requireAttempt(slice, round);
    if (attempt.builderId === null) {
      let roleTask: RoleTask;
      try {
        roleTask = await builderTask(this.manifest, slice, attempt, this.artifacts);
      } catch (error) {
        await this.blockSlice(sliceId, `Builder input could not be prepared: ${errorMessage(error)}`);
        return false;
      }
      const watch = this.manifest.coordination.watch;
      if (watch !== undefined) {
        if (!(await this.startPair(sliceId, round, roleTask, watch))) return false;
      } else {
        const spawned = await this.spawnRole(
          "builder",
          sliceId,
          round,
          roleTask,
          (manifest, id) => {
            const target = this.attemptIn(manifest, sliceId, round);
            target.builderId = id;
          },
        );
        if (spawned === null) return false;
      }
      slice = this.requireSlice(sliceId);
      attempt = this.requireAttempt(slice, round);
    }

    const builderId = attempt.builderId;
    if (builderId === null) {
      await this.blockSlice(sliceId, "Builder task id was not recorded.");
      return false;
    }
    const pair = this.pairsByTask.get(builderId);
    // A watched builder's wall clock is extended by the hold credit its ling
    // grants (§7.7), so it is waited on for that too.
    //
    // A build that ended after a sibling stopped the campaign is judged all
    // the same: judging it spawns nothing and asks no brain, and left
    // unjudged its slice stays building in a campaign that may never resume.
    // A watched build is not: its pair settles by waiting on its watcher,
    // and a stopped campaign stops the watcher instead.
    const task = await this.waitForTask(
      builderId,
      this.manifest.roles.builder.maxWallClockMs,
      pair,
      pair === undefined,
    );
    if (task === undefined) {
      if (pair !== undefined) await this.abortPair(pair);
      return false;
    }
    // The slice moves on only after the watcher settles (§11.7 step 7).
    if (pair !== undefined) await this.settlePair(pair, task);
    if (task.status !== "completed") {
      const shouldContinue = await this.rejectBuilder(
        sliceId,
        round,
        `Builder task ${builderId} ended as ${task.status}: ${task.error ?? "no result"}`,
      );
      await this.releaseUnsuccessfulTask(task);
      return shouldContinue;
    }

    try {
      const result = parseWorkerResult(
        task.result,
        "builder",
        this.manifest.acceptance,
        this.manifest.bar,
      ) as BuildWorkerResult;
      const namespace = `slices/${Buffer.from(sliceId).toString("base64url")}/round-${round}/build`;
      const refs = await this.artifacts.collectTaskArtifacts(
        task,
        result.data.artifacts,
        namespace,
      );
      // Evidence is taken, not requested. A task granted the recording tool does
      // not get to decide whether its findings are collected by leaving the file
      // out of result.json, because an uncollected finding set is scored as an
      // empty one and an empty one cannot be graded.
      const findingsRef = (task.options.tools ?? []).includes(RECORD_FINDING_TOOL_NAME)
        ? ((await this.artifacts.collectRequiredFile(task, FINDINGS_FILE, namespace)) ?? null)
        : null;
      // Chosen here, while the producer is already finished, and recorded before
      // the reviewer is told anything. Selecting at review time instead would put
      // the choice after a restart could have replayed it differently.
      //
      // A campaign whose reviewer profile withholds the verification tool has
      // opted out of re-checking, so no sample is drawn: asking for observations
      // nobody can make would hold every research slice at inconclusive forever.
      const sample =
        findingsRef === null ||
        !this.manifest.roles.reviewer.tools.includes(VERIFY_FINDING_TOOL_NAME)
          ? null
          : selectVerificationSample(
              parseFindingsDocument(JSON.parse(await this.artifacts.readText(findingsRef))),
              { seed: randomUUID() },
            );
      await this.persist((manifest) => {
        const target = this.attemptIn(manifest, sliceId, round);
        target.artifacts = refs;
        target.findings = findingsRef;
        target.findingsSample = sample;
        target.evidence = [result.summary];
        target.costUsd = this.costFor(target.builderId, target.reviewerId);
        transitionSlice(manifest, sliceId, "reviewing");
      });
    } catch (error) {
      return this.rejectBuilder(sliceId, round, `Builder result rejected: ${errorMessage(error)}`);
    }
    await this.releaseCollectedTask(task);
    return true;
  }

  private async rejectBuilder(sliceId: string, round: number, gap: string): Promise<boolean> {
    const atCap = round >= this.sliceAttemptLimit(this.requireSlice(sliceId));
    await this.persist((manifest) => {
      const attempt = this.attemptIn(manifest, sliceId, round);
      attempt.verdict = "revise";
      attempt.gaps = [gap];
      attempt.costUsd = this.costFor(attempt.builderId, attempt.reviewerId);
      if (atCap) {
        transitionSlice(manifest, sliceId, "capped");
        transitionCampaignIfActive(manifest, "capped");
      }
    });
    return !atCap;
  }

  /**
   * Grade the builder's findings against the reviewer's observations.
   *
   * The verification report is taken, not requested, for the same reason the
   * findings are: a reviewer that could suppress its own report by leaving the
   * file out of result.json would turn every refutation into an absence.
   *
   * Persists what it concluded before returning, so the record of why a slice was
   * refused survives even if the verdict transition that follows crashes.
   */
  private async gateFindings(
    task: LingTask,
    sliceId: string,
    round: number,
  ): Promise<FindingsGateOutcome> {
    const attempt = this.requireAttempt(this.requireSlice(sliceId), round);
    const sample = attempt.findingsSample;
    // Three states used to collapse into one, and the third is the one that matters.
    //
    // No findings document at all is honest: a slice that produced code rather than
    // claims has nothing to re-check. A reviewer profile without `verify_finding` is a
    // stated opt-out, recorded as such so it reads as a decision rather than a result.
    //
    // But a *nonempty* set from which nothing could be sampled is neither. It means
    // every claim rests on a source nobody can re-fetch, or on an excerpt too short to
    // match, and `judgeFindings` already calls that a failure. Returning `inapplicable`
    // here skipped that judgement entirely, so a builder could report only calls and
    // documents — or eight-character excerpts — and have an accepting reviewer carry the
    // slice. That is the one hole the whole evidence chain cannot have: the gate exists
    // to override an accept, and no sample meant no override.
    if (attempt.findings == null) {
      await this.persist((manifest) => {
        this.attemptIn(manifest, sliceId, round).findingsGate = {
          outcome: "inapplicable",
          reasons: ["No findings were recorded for this slice."],
          survivalRate: null,
        };
      });
      return "inapplicable";
    }
    if (sample == null) {
      await this.persist((manifest) => {
        this.attemptIn(manifest, sliceId, round).findingsGate = {
          outcome: "inapplicable",
          reasons: [
            "This campaign withheld verify_finding from its reviewer, so no sample was drawn.",
          ],
          survivalRate: null,
        };
      });
      return "inapplicable";
    }

    const namespace = `slices/${Buffer.from(sliceId).toString("base64url")}/round-${round}/review`;
    // Only collected when something was actually asked for. With an empty sample the
    // reviewer was never asked to verify anything, so demanding its report would refuse
    // the slice for the wrong reason.
    const verification =
      sample.ids.length === 0
        ? null
        : ((await this.artifacts.collectRequiredFile(task, VERIFICATION_FILE, namespace)) ?? null);
    const findings = parseFindingsDocument(
      JSON.parse(await this.artifacts.readText(attempt.findings)),
    );
    // An absent report is a report of nothing, which the gate reads as every
    // sampled finding left unchecked. That is not the same as a pass.
    const observations =
      verification === null
        ? []
        : parseVerificationDocument(JSON.parse(await this.artifacts.readText(verification)));
    const judgement = judgeFindings(scoreFindings(findings, observations), sample);
    const record = {
      outcome: judgement.outcome,
      reasons: judgement.reasons,
      survivalRate: judgement.survivalRate ?? null,
    };
    await this.persist((manifest) => {
      const target = this.attemptIn(manifest, sliceId, round);
      target.verification = verification;
      target.findingsGate = record;
    });
    return judgement.outcome;
  }

  private async processReviewer(
    sliceId: string,
    round: number,
  ): Promise<"continue" | "stop"> {
    let slice = this.requireSlice(sliceId);
    let attempt = this.requireAttempt(slice, round);
    if (attempt.reviewerId === null) {
      let roleTask: RoleTask;
      try {
        roleTask = await reviewerTask(this.manifest, slice, attempt, this.artifacts);
      } catch (error) {
        await this.blockSlice(sliceId, `Reviewer input could not be prepared: ${errorMessage(error)}`);
        return "stop";
      }
      const spawned = await this.spawnRole("reviewer", sliceId, round, roleTask, (manifest, id) => {
        this.attemptIn(manifest, sliceId, round).reviewerId = id;
      });
      if (spawned === null) return "stop";
      slice = this.requireSlice(sliceId);
      attempt = this.requireAttempt(slice, round);
    }

    const reviewerId = attempt.reviewerId;
    if (reviewerId === null) {
      await this.blockSlice(sliceId, "Reviewer task id was not recorded.");
      return "stop";
    }
    const task = await this.waitForTask(reviewerId, this.manifest.roles.reviewer.maxWallClockMs);
    if (task === undefined) return "stop";
    if (task.status !== "completed") {
      await this.blockSlice(
        sliceId,
        `Reviewer task ${reviewerId} ended as ${task.status}: ${task.error ?? "no result"}`,
      );
      await this.releaseUnsuccessfulTask(task);
      return "stop";
    }

    let result: ReviewWorkerResult;
    try {
      result = parseWorkerResult(
        task.result,
        "reviewer",
        this.manifest.acceptance,
        this.manifest.bar,
      ) as ReviewWorkerResult;
    } catch (error) {
      await this.blockSlice(sliceId, `Reviewer result rejected: ${errorMessage(error)}`);
      return "stop";
    }

    let gateOutcome: FindingsGateOutcome;
    try {
      gateOutcome = await this.gateFindings(task, sliceId, round);
    } catch (error) {
      // A gate that cannot be evaluated is not a gate that passed. Refusing the
      // attempt is the only reading that does not reward breaking it.
      await this.blockSlice(sliceId, `Evidence could not be graded: ${errorMessage(error)}`);
      await this.releaseUnsuccessfulTask(task);
      return "stop";
    }
    if (gateOutcome === "fail" || gateOutcome === "inconclusive") {
      // The reviewer produced both the observations and the verdict, so honouring
      // its "accept" over a failed gate would make the gate advisory. Rewriting
      // the parsed verdict here rather than forking the flow keeps the retry cap,
      // the brain revision decision and the transitions on their one tested path.
      //
      // "inconclusive" retries the whole attempt even though the builder may be
      // blameless, because the overlord cannot re-run a verification on its own
      // and an unverified finding set must not be accepted.
      const reasons = this.requireAttempt(this.requireSlice(sliceId), round).findingsGate?.reasons;
      result.data.verdict = "revise";
      result.data.gaps = [...(reasons ?? []), ...result.data.gaps];
    }

    if (result.data.verdict === "accept") {
      await this.persist((manifest) => {
        const target = this.attemptIn(manifest, sliceId, round);
        target.verdict = "accept";
        target.evidence = result.data.evidence;
        target.gaps = [];
        target.costUsd = this.costFor(target.builderId, target.reviewerId);
        transitionSlice(manifest, sliceId, "accepted");
        manifest.currentSliceId =
          manifest.slices.find((candidate) => candidate.status !== "accepted")?.id ?? null;
      });
      await this.releaseCollectedTask(task);
      return "continue";
    }

    if (result.data.verdict === "blocked") {
      await this.persist((manifest) => {
        const target = this.attemptIn(manifest, sliceId, round);
        target.verdict = "blocked";
        target.evidence = result.data.evidence;
        target.gaps = result.data.gaps;
        target.costUsd = this.costFor(target.builderId, target.reviewerId);
        transitionSlice(manifest, sliceId, "blocked");
        transitionCampaignIfActive(manifest, "blocked");
      });
      await this.releaseCollectedTask(task);
      return "stop";
    }

    const atCap = round >= this.sliceAttemptLimit(this.requireSlice(sliceId));
    await this.persist((manifest) => {
      const target = this.attemptIn(manifest, sliceId, round);
      target.verdict = "revise";
      target.evidence = result.data.evidence;
      target.gaps = result.data.gaps;
      target.costUsd = this.costFor(target.builderId, target.reviewerId);
      if (atCap) {
        transitionSlice(manifest, sliceId, "capped");
      } else if (!manifest.brain.enabled) {
        transitionSlice(manifest, sliceId, "building");
      }
      if (atCap) transitionCampaignIfActive(manifest, "capped");
    });
    await this.releaseCollectedTask(task);
    if (atCap || !this.manifest.brain.enabled) return atCap ? "stop" : "continue";

    const decision = reviewingDecision({
      goal: this.manifest.goal,
      sliceId,
      round,
      gaps: result.data.gaps,
      evidence: result.data.evidence,
      attemptsRemaining: this.sliceAttemptLimit(this.requireSlice(sliceId)) - round,
    });
    const key = decision.request.key;
    let choice: CampaignBrainChoice;
    try {
      choice = await this.decideWithBrain(decision);
    } catch (error) {
      await this.blockSlice(sliceId, `Brain review decision failed: ${errorMessage(error)}`);
      return "stop";
    }
    if (choice.action === "halt_campaign") {
      await this.persist((manifest) => {
        this.markBrainDecisionApplied(manifest, key);
        const target = this.attemptIn(manifest, sliceId, round);
        target.gaps.push(`Overlord brain stopped retries: ${choice.rationale}`);
        transitionSlice(manifest, sliceId, "blocked");
        transitionCampaignIfActive(manifest, "blocked");
      });
      return "stop";
    }
    await this.persist((manifest) => {
      this.markBrainDecisionApplied(manifest, key);
      transitionSlice(manifest, sliceId, "building");
    });
    return "continue";
  }

  private async processIntegration(): Promise<"finished" | "retry_slices"> {
    let latest = this.manifest.integration.attempts.at(-1);
    if (latest?.verdict === "accept") {
      await this.persist((manifest) => transitionCampaignIfActive(manifest, "completed"));
      return "finished";
    }
    if (latest?.verdict === "blocked") {
      const wasPresentAtStart = latest.round <= this.integrationAttemptsAtStart;
      if (!(this.resumeBlocked && wasPresentAtStart)) {
        await this.blockCampaign(latest.gaps.at(-1) ?? "Integration review is blocked.");
        return "finished";
      }
      latest = undefined;
    }
    if (latest?.verdict === "revise") {
      if (!latest.retriesScheduled) {
        if (this.manifest.brain.enabled) {
          return this.handleBrainIntegrationRevision(latest);
        }
        if (latest.affectedSliceIds.length === 0) {
          await this.blockCampaign(
            "Integration requested revision without identifying affected slices as [slice:ID].",
          );
          return "finished";
        }
        // Every affected slice is checked before any is reopened, so a slice at its
        // cap stops the campaign without leaving an earlier one half-scheduled.
        const affected = latest.affectedSliceIds;
        const exhausted = affected.find((sliceId) => {
          const slice = this.requireSlice(sliceId);
          return slice.attempts.length >= this.sliceAttemptLimit(slice);
        });
        if (exhausted !== undefined) {
          await this.capCampaign(
            `Integration requires another round for slice ${exhausted}, but it already reached maxRounds.`,
          );
          return "finished";
        }
        await this.persist((manifest) =>
          reopenForIntegration(manifest, affected, affected.at(-1) ?? null),
        );
        return "retry_slices";
      }
      latest = undefined;
    }

    if (latest === undefined || latest.verdict !== null) {
      const round = this.manifest.integration.attempts.length + 1;
      if (this.manifest.brain.enabled && round > this.manifest.maxRounds) {
        await this.capCampaign(
          `Integration exhausted the brain-driven campaign cap of ${this.manifest.maxRounds} rounds.`,
        );
        return "finished";
      }
      await this.persist((manifest) => {
        manifest.integration.attempts.push({
          round,
          reviewerId: null,
          verdict: null,
          evidence: [],
          gaps: [],
          affectedSliceIds: [],
          retriesScheduled: false,
          costUsd: 0,
        });
        manifest.integration.reviewerId = null;
        manifest.integration.verdict = null;
        manifest.integration.evidence = [];
        manifest.integration.gaps = [];
      });
      latest = this.manifest.integration.attempts.at(-1);
    }
    if (latest === undefined) {
      await this.blockCampaign("Integration attempt could not be created.");
      return "finished";
    }

    if (latest.reviewerId === null) {
      let roleTask: RoleTask;
      try {
        roleTask = await integrationTask(this.manifest, this.artifacts);
      } catch (error) {
        await this.blockIntegration(`Integration input could not be prepared: ${errorMessage(error)}`);
        return "finished";
      }
      const round = latest.round;
      const spawned = await this.spawnRole("integration", null, round, roleTask, (manifest, id) => {
        const target = manifest.integration.attempts.find((attempt) => attempt.round === round);
        if (target === undefined) throw new Error(`Unknown integration round ${round}.`);
        target.reviewerId = id;
        manifest.integration.reviewerId = id;
      });
      if (spawned === null) return "finished";
      latest = this.manifest.integration.attempts.at(-1);
    }

    const reviewerId = latest?.reviewerId;
    if (reviewerId === null || reviewerId === undefined) {
      await this.blockIntegration("Integration reviewer task id was not recorded.");
      return "finished";
    }
    const task = await this.waitForTask(
      reviewerId,
      this.manifest.roles.integration.maxWallClockMs,
    );
    if (task === undefined) return "finished";
    if (task.status !== "completed") {
      await this.blockIntegration(
        `Integration task ${reviewerId} ended as ${task.status}: ${task.error ?? "no result"}`,
      );
      await this.releaseUnsuccessfulTask(task);
      return "finished";
    }

    let result: ReviewWorkerResult;
    try {
      result = parseWorkerResult(
        task.result,
        "integration",
        this.manifest.acceptance,
        this.manifest.bar,
      ) as ReviewWorkerResult;
    } catch (error) {
      await this.blockIntegration(`Integration result rejected: ${errorMessage(error)}`);
      return "finished";
    }

    const knownIds = this.manifest.slices.map((slice) => slice.id);
    const affected =
      result.data.verdict === "revise" ? affectedSliceIds(result.data.gaps, knownIds) : [];
    await this.persist((manifest) => {
      const target = manifest.integration.attempts.find(
        (attempt) => attempt.reviewerId === reviewerId,
      );
      if (target === undefined) throw new Error(`Unknown integration task ${reviewerId}.`);
      target.verdict = result.data.verdict;
      target.evidence = result.data.evidence;
      target.gaps = result.data.gaps;
      target.affectedSliceIds = affected;
      target.costUsd = this.costFor(reviewerId);
      this.syncIntegrationSummary(target, manifest);
      if (result.data.verdict === "accept") transitionCampaignIfActive(manifest, "completed");
      if (result.data.verdict === "blocked") transitionCampaignIfActive(manifest, "blocked");
    });
    await this.releaseCollectedTask(task);

    if (result.data.verdict === "accept" || result.data.verdict === "blocked") return "finished";
    return this.processIntegration();
  }

  private async handleBrainIntegrationRevision(
    latest: IntegrationAttempt,
  ): Promise<"finished" | "retry_slices"> {
    if (latest.round >= this.manifest.maxRounds) {
      await this.capCampaign(
        `Integration revision reached the brain-driven campaign cap of ${this.manifest.maxRounds} rounds.`,
      );
      return "finished";
    }
    const retryableIds = latest.affectedSliceIds.filter((id) => {
      const slice = this.requireSlice(id);
      return (
        slice.status === "accepted" &&
        slice.attempts.length < this.sliceAttemptLimit(slice)
      );
    });
    const input: IntegrationInput = {
      goal: this.manifest.goal,
      campaignId: this.manifest.id,
      maxRounds: this.manifest.maxRounds,
      integrationRound: latest.round,
      replansUsed: this.manifest.brain.replansUsed,
      gaps: latest.gaps,
      evidence: latest.evidence,
      retryableSliceIds: retryableIds,
      slices: await Promise.all(
        this.manifest.slices.map(async (slice) => ({
          id: slice.id,
          status: slice.status,
          dependsOn: slice.dependsOn ?? [],
          createdInRound: slice.createdInRound,
          attemptsUsed: slice.attempts.length,
          attemptsRemaining: this.sliceAttemptLimit(slice) - slice.attempts.length,
          specification: await this.artifacts.readText(slice.spec),
        })),
      ),
    };
    const decision = integrationDecision(input);
    const key = decision.request.key;
    let choice: CampaignBrainChoice;
    try {
      choice = await this.decideWithBrain(decision);
    } catch (error) {
      await this.blockIntegration(`Brain integration decision failed: ${errorMessage(error)}`);
      return "finished";
    }

    if (choice.action === "halt_campaign") {
      await this.persist((manifest) => {
        this.markBrainDecisionApplied(manifest, key);
        const attempt = manifest.integration.attempts.at(-1);
        if (attempt !== undefined) {
          attempt.gaps.push(`Overlord brain halted integration repair: ${choice.rationale}`);
          this.syncIntegrationSummary(attempt, manifest);
        }
        transitionCampaignIfActive(manifest, "blocked");
      });
      return "finished";
    }

    if (choice.action === "retry_slices") {
      const ids = choice.arguments["sliceIds"] as string[];
      await this.persist((manifest) => {
        this.markBrainDecisionApplied(manifest, key);
        reopenForIntegration(manifest, ids, ids[0] ?? null);
      });
      return "retry_slices";
    }

    const proposal = parseReplanProposal(choice.arguments, input);
    const additions: CampaignSlice[] = [];
    for (const [index, slice] of proposal.slices.entries()) {
      const spec = await this.artifacts.storeText(
        `replans/${latest.round}/${index + 1}`,
        "spec.md",
        slice.spec,
      );
      additions.push({
        id: slice.id,
        spec,
        status: "pending" as const,
        attempts: [],
        createdInRound: latest.round,
        dependsOn: slice.dependsOn,
      });
    }
    await this.persist((manifest) => {
      this.markBrainDecisionApplied(manifest, key);
      manifest.slices.push(...additions);
      manifest.brain.replansUsed += 1;
      reopenForIntegration(
        manifest,
        proposal.retrySliceIds,
        proposal.retrySliceIds[0] ?? additions[0]?.id ?? null,
      );
    });
    return "retry_slices";
  }

  private async spawnRole(
    role: CampaignWorkRole,
    sliceId: string | null,
    round: number,
    roleTask: RoleTask,
    recordId: (manifest: CampaignManifest, id: string) => void,
    pairId?: string,
  ): Promise<LingTask | null> {
    const operation = this.spawnTail.then(() =>
      this.spawnRoleNow(role, sliceId, round, roleTask, recordId, pairId),
    );
    this.spawnTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  /**
   * What fleet policy makes of a role's spawn before anything is reserved: its
   * effective limits and tools, or why it would be refused. A required tool
   * the profile lacks or policy strips, or a profile capability policy
   * forbids, is a refusal.
   */
  private rolePreflight(
    role: CampaignWorkRole,
    roleTask: RoleTask,
  ): { refusal: string } | { effective: ReturnType<typeof applySpawnPolicy> } {
    const profile = this.manifest.roles[role];
    const missingFromProfile = roleTask.requiredTools.filter(
      (tool) => !profile.tools.includes(tool),
    );
    if (missingFromProfile.length > 0) {
      return {
        refusal: `${role} profile does not provide required tool(s): ${missingFromProfile.join(", ")}.`,
      };
    }
    const withheld = new Set(roleTask.withheldTools ?? []);
    const requestedTools = [...new Set(profile.tools)].filter((tool) => !withheld.has(tool));
    const effective = applySpawnPolicy(
      {
        tools: requestedTools,
        max_cost_usd: profile.maxCostUsd,
        max_turns: profile.maxTurns,
        max_wall_clock_ms: profile.maxWallClockMs,
      },
      this.policy,
    );
    const missingRequired = roleTask.requiredTools.filter(
      (tool) => !effective.tools.includes(tool),
    );
    if (missingRequired.length > 0) {
      return {
        refusal: `${role} policy requires tool(s) not allowed by fleet policy: ${missingRequired.join(", ")}.`,
      };
    }
    const capabilityViolation = profileCapabilityViolation(
      {
        ...(profile.provider === undefined ? {} : { provider: profile.provider }),
        ...(profile.model === undefined ? {} : { model: profile.model }),
        ...(profile.skills === undefined ? {} : { skills: profile.skills }),
        inlineSkillCount: profile.inlineSkills?.length ?? 0,
      },
      this.policy,
    );
    if (capabilityViolation !== undefined) {
      return { refusal: `${role} profile violates fleet policy: ${capabilityViolation}.` };
    }
    return { effective };
  }

  private async spawnRoleNow(
    role: CampaignWorkRole,
    sliceId: string | null,
    round: number,
    roleTask: RoleTask,
    recordId: (manifest: CampaignManifest, id: string) => void,
    pairId?: string,
  ): Promise<LingTask | null> {
    this.lastSpawnError = undefined;
    if (this.shutdownRequested || this.manifest.status !== "running") return null;
    const profile = this.manifest.roles[role];
    const preflight = this.rolePreflight(role, roleTask);
    if ("refusal" in preflight) {
      await this.blockCampaign(preflight.refusal);
      return null;
    }
    const { effective } = preflight;
    const requestKey = campaignRequestKey(this.manifest.id, role, sliceId, round);
    const campaignCostCeiling = Math.min(
      this.policy.maxTotalCostUsd,
      this.manifest.budget.maxTotalCostUsd,
    );
    let parallelBudgetBlocked =
      this.manifest.coordination.parallelSlices &&
      this.reservedCampaignCostUsd() + effective.maxCostUsd > campaignCostCeiling;
    while (
      parallelBudgetBlocked &&
      this.manifest.status === "running" &&
      !this.shutdownRequested &&
      this.manifest.tasks.some((task) => !isTerminalStatus(task.status))
    ) {
      // A full active-task reservation is temporary. Wait for the current
      // batch to report actual spend, then decide whether the next role really
      // exhausts the campaign instead of requiring an unnecessary resume.
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
      parallelBudgetBlocked =
        this.reservedCampaignCostUsd() + effective.maxCostUsd > campaignCostCeiling;
    }
    if (this.shutdownRequested || this.manifest.status !== "running") return null;
    const blocked =
      (parallelBudgetBlocked ? ("budget" as const) : undefined) ??
      this.ledger.spawnBlockReason(effective.maxCostUsd) ??
      this.fleetStore?.reserveSpawn(
        requestKey,
        this.manifest.id,
        effective.maxCostUsd,
        this.policy,
        effective.maxWallClockMs * 2 + this.settleGraceMs,
        this.rateLimits,
      );
    if (blocked !== undefined) {
      await this.stopForSpawnBlock(blocked, role);
      return null;
    }

    const files: Record<string, string> = { ...(profile.files ?? {}) };
    for (const [filename, content] of Object.entries(roleTask.files)) {
      if (Object.hasOwn(files, filename) && files[filename] !== content) {
        this.fleetStore?.releaseReservation(requestKey);
        await this.blockCampaign(
          `${role} profile seed ${JSON.stringify(filename)} conflicts with role context.`,
        );
        return null;
      }
      files[filename] = content;
    }
    try {
      assertSeedFileLimits(files);
    } catch (error) {
      this.fleetStore?.releaseReservation(requestKey);
      await this.blockCampaign(`${role} profile context is invalid: ${errorMessage(error)}`);
      return null;
    }
    // A prompt variant is the builder's alone (pilot plan §2.4); no other
    // task, B's included, is given one. Unset, the request, and so its hash,
    // is what it was before variants existed.
    const variant =
      role === "builder" ? this.manifest.coordination.watch?.workerVariant : undefined;
    const input: SpawnInput = {
      task: roleTask.prompt,
      requestKey,
      files,
      tools: effective.tools,
      maxCostUsd: effective.maxCostUsd,
      maxTurns: effective.maxTurns,
      maxWallClockMs: effective.maxWallClockMs,
      ...(profile.provider === undefined ? {} : { provider: profile.provider }),
      ...(profile.model === undefined ? {} : { model: profile.model }),
      ...(profile.thinking === undefined ? {} : { thinking: profile.thinking }),
      ...(profile.skills === undefined ? {} : { skills: profile.skills }),
      ...(profile.inlineSkills === undefined ? {} : { inlineSkills: profile.inlineSkills }),
      ...(profile.instructions === undefined ? {} : { instructions: profile.instructions }),
      ...(variant === undefined ? {} : { variant }),
    };
    const requestBytes = Buffer.byteLength(JSON.stringify(input));
    if (requestBytes > MAX_LING_REQUEST_BODY_BYTES) {
      this.fleetStore?.releaseReservation(requestKey);
      await this.blockCampaign(
        `${role} request is ${requestBytes} bytes after JSON encoding; Ling accepts at most ${MAX_LING_REQUEST_BODY_BYTES}.`,
      );
      return null;
    }
    const profileSha256 = hashState({
      role,
      profile,
      effectiveTools: effective.tools,
      effectiveMaxCostUsd: effective.maxCostUsd,
      effectiveMaxTurns: effective.maxTurns,
      effectiveMaxWallClockMs: effective.maxWallClockMs,
    });
    const summoned = await this.summonTask({
      role,
      sliceId,
      round,
      requestKey,
      input,
      profileSha256,
      requestSha256: hashState(input),
      seededArtifacts: structuredClone(roleTask.seededArtifacts),
      seededMessageIds: [...roleTask.seededMessageIds],
      tools: effective.tools,
      ...(pairId === undefined ? {} : { pairId }),
      recordId,
    });
    if (summoned === null) return null;
    if ("error" in summoned) {
      this.lastSpawnError = summoned.error;
      await this.blockCampaign(`${role} spawn failed: ${errorMessage(summoned.error)}`);
      return null;
    }
    if (this.shutdownRequested) {
      // The shutdown landed while the POST was out, so the child started
      // anyway, and the shutdown's cancel pass, run before it was recorded,
      // missed it; waitForTask would leave it to the pass after the loop,
      // which runs only if the loop settles in time. It is stopped here. A
      // sibling's stop needs nothing here: waitForTask stops a child still
      // running, and judges one that ended on its own.
      if (!isTerminalStatus(summoned.record.status)) await this.stopTaskHard(summoned.record.id);
      return null;
    }
    await this.messaging.deliverPendingMessagesToTask(summoned.record.id);
    return summoned.snapshot;
  }

  /**
   * Spawn one task under its request key, the summon persisted around it:
   * prepared before the POST, failed if it throws, and spawned in the same
   * write as the task's record and `recordId`'s, which says where the task
   * belongs. The task's events are tapped from then on. A spawn that throws
   * is returned for the caller to judge; null when the summon already on
   * record under the key asked for something else, which blocks the campaign,
   * or when the campaign stopped before the POST. A stop that lands while
   * the POST is out is the caller's to act on: the task is recorded first.
   */
  private async summonTask(summon: {
    role: CampaignRole;
    sliceId: string | null;
    round: number;
    requestKey: string;
    input: SpawnInput;
    profileSha256: string;
    requestSha256: string;
    seededArtifacts: CampaignTaskRecord["seededArtifacts"];
    seededMessageIds: string[];
    /** The tools asked for, recorded if the ling does not echo its own. */
    tools: readonly string[];
    pairId?: string;
    recordId: (manifest: CampaignManifest, id: string) => void;
  }): Promise<{ record: CampaignTaskRecord; snapshot: LingTask } | { error: unknown } | null> {
    const { role, sliceId, round, requestKey, profileSha256, requestSha256 } = summon;
    const priorIntent = this.manifest.summons.find(
      (intent) => intent.requestKey === requestKey,
    );
    if (
      priorIntent !== undefined &&
      (priorIntent.profileSha256 !== profileSha256 ||
        priorIntent.requestSha256 !== requestSha256)
    ) {
      this.fleetStore?.releaseReservation(requestKey);
      await this.blockCampaign(
        `${role} summon intent ${requestKey} changed after it was persisted.`,
      );
      return null;
    }
    if (priorIntent === undefined) {
      const now = new Date().toISOString();
      await this.persist((manifest) => {
        manifest.summons.push({
          requestKey,
          role,
          sliceId,
          round,
          profileSha256,
          requestSha256,
          state: "prepared",
          workerId: null,
          taskId: null,
          preparedAt: now,
          updatedAt: now,
          error: null,
        });
      });
    }
    // Asked again after the write, which yields: a shutdown or a sibling's
    // stop can land during it, and a POST sent then starts a child after the
    // stop. Nothing was asked for, so the intent written above is taken back,
    // and the record reads as for a stop one step earlier; one an earlier
    // process wrote stays, since its POST may have gone out.
    if (this.shutdownRequested || this.manifest.status !== "running") {
      this.fleetStore?.releaseReservation(requestKey);
      if (priorIntent === undefined) {
        await this.persist((manifest) => {
          manifest.summons = manifest.summons.filter(
            (intent) => intent.requestKey !== requestKey || intent.state !== "prepared",
          );
        });
      }
      return null;
    }
    let spawned: SpawnResponse;
    try {
      spawned = await this.client.spawn(summon.input);
    } catch (error) {
      this.fleetStore?.releaseReservation(requestKey);
      await this.persist((manifest) => {
        const intent = manifest.summons.find((candidate) => candidate.requestKey === requestKey);
        if (intent !== undefined) {
          intent.state = "failed";
          intent.updatedAt = new Date().toISOString();
          intent.error = errorMessage(error);
        }
      });
      return { error };
    }
    const record: CampaignTaskRecord = {
      id: spawned.id,
      requestKey,
      ...(spawned.workerId === undefined ? {} : { workerId: spawned.workerId }),
      role,
      sliceId,
      round,
      status: spawned.status,
      costUsd: 0,
      totalTokens: 0,
      seedProvenance: "recorded",
      seededArtifacts: summon.seededArtifacts,
      seededMessageIds: summon.seededMessageIds,
      // Campaign spawns always send an explicit tool list. Prefer Ling's echoed
      // effective options, while retaining compatibility with an older worker
      // that omitted the field from its response.
      effectiveTools: [...new Set(spawned.options.tools ?? summon.tools)],
      ...(summon.pairId === undefined ? {} : { pairId: summon.pairId }),
      createdAt: new Date().toISOString(),
    };
    const snapshot = syntheticTask(record, this.artifacts.workspacesDir);
    this.account(snapshot, record.workerId, requestKey);
    await this.persist((manifest) => {
      manifest.tasks.push(record);
      const intent = manifest.summons.find((candidate) => candidate.requestKey === requestKey);
      if (intent === undefined) throw new Error(`Missing summon intent ${requestKey}.`);
      intent.state = "spawned";
      intent.workerId = spawned.workerId ?? null;
      intent.taskId = spawned.id;
      intent.updatedAt = new Date().toISOString();
      intent.error = null;
      summon.recordId(manifest, spawned.id);
    });
    this.startEventTap(record);
    return { record, snapshot };
  }

  // -------------------------------------------------------------------------
  // Watched pairs (reports/oversight-wire.md §11)

  /**
   * Start a watched builder: persist the pair, spawn B, wait for B's first
   * `watch_next`, and only then spawn A, so no stretch of A's run goes
   * unobserved (§11.2). False when the attempt cannot go on; the reason is
   * already recorded on the pair and the slice or campaign.
   */
  private async startPair(
    sliceId: string,
    round: number,
    roleTask: RoleTask,
    watch: CampaignWatchConfig,
  ): Promise<boolean> {
    const earlier = this.requireAttempt(this.requireSlice(sliceId), round).watch;
    if (earlier !== undefined && !this.pairSpawnedNothing(earlier, sliceId, round)) {
      // The attempt's pair spent this round's watcher request key, and the
      // process that ran it ended before it closed the attempt. A new pair
      // needs a new attempt.
      await this.blockSlice(sliceId, pairLeftOpenGap(earlier));
      return false;
    }
    if (this.shutdownRequested || this.manifest.status !== "running") return false;
    // A builder policy would refuse is refused before B is spawned and paid
    // for, as spawnRole would refuse it after.
    const builderPreflight = this.rolePreflight("builder", roleTask);
    if ("refusal" in builderPreflight) {
      await this.blockCampaign(builderPreflight.refusal);
      return false;
    }
    // An earlier pair that spawned nothing was stopped before it started (a
    // budget, a rate window, a policy refusal, a builder that failed to spawn
    // beside no watcher). Its round starts it again, as it would an unwatched
    // builder, and its record is replaced.
    if (earlier !== undefined) this.pairsById.get(earlier.pairId)?.dispose();
    const builderEffective = builderPreflight.effective;
    const record = newPairRecord(
      pairIdFor(this.manifest.id, sliceId, round),
      watch.condition,
      watch.required,
    );
    const pair = new OversightPair({
      record,
      client: this.oversightClient(),
      host: this.pairHost(sliceId, round, record),
      workerWallClockMs: builderEffective.maxWallClockMs,
      ...(this.oversightTimings === undefined ? {} : { timings: this.oversightTimings }),
      ...(this.oversightClock === undefined ? {} : { clock: this.oversightClock }),
    });
    this.pairsById.set(pair.pairId, pair);
    await this.persist((manifest) => {
      this.attemptIn(manifest, sliceId, round).watch = structuredClone(pair.record);
    });

    let workerTask = roleTask;
    if (watch.condition !== "no_watcher") {
      const started = await this.startWatcher(
        sliceId,
        round,
        pair,
        roleTask,
        watch,
        builderEffective,
      );
      if (started !== "ready" && this.shutdownRequested) {
        // A shutdown cancels B with everything else, so B could not have got
        // ready. That is the operator's stop, not a watcher that failed to
        // start: the pair is recorded as cut short and the attempt is left as
        // it is, as for the builder below. Stopping changes no verdict.
        this.fleetStore?.releaseReservation(
          campaignRequestKey(this.manifest.id, "builder", sliceId, round),
        );
        await pair.abort(
          "The overlord was shut down while the watcher was starting; the builder was not spawned.",
        );
        return false;
      }
      if (started === "stopped") {
        await pair.failStart(
          "watcher_spawn_failed",
          pair.record.watcherTaskId === null
            ? "The campaign stopped before the watcher was spawned."
            : "The campaign stopped while the watcher was being spawned; the watcher was stopped.",
          "aborted",
        );
        return false;
      }
      if (started !== "ready") {
        if (watch.required) {
          await pair.failStart(started.outcome, started.detail, "aborted");
          this.fleetStore?.releaseReservation(
            campaignRequestKey(this.manifest.id, "builder", sliceId, round),
          );
          await this.blockSlice(
            sliceId,
            `Watcher did not start (${started.outcome}); a builder whose watcher is required never runs unwatched.`,
          );
          return false;
        }
        await pair.failStart(started.outcome, started.detail, "absent");
        // Nobody would answer ask_overseer, so A is not offered it (§2, absent).
        workerTask = {
          ...roleTask,
          requiredTools: roleTask.requiredTools.filter((tool) => tool !== "ask_overseer"),
          withheldTools: [...(roleTask.withheldTools ?? []), "ask_overseer"],
        };
      }
    }

    const gapsBefore = this.manifest.integration.gaps.length;
    const spawned = await this.spawnRole(
      "builder",
      sliceId,
      round,
      workerTask,
      (manifest, id) => {
        const target = this.attemptIn(manifest, sliceId, round);
        target.builderId = id;
        pair.record.workerTaskId = id;
        if (target.watch !== undefined) target.watch.workerTaskId = id;
        this.pairsByTask.set(id, pair);
      },
      pair.pairId,
    );
    if (spawned === null && this.shutdownRequested && pair.record.workerTaskId !== null) {
      // A spawned while the shutdown landed, and spawnRoleNow has stopped it.
      // That is no A that failed to spawn but a pair the operator cut short, as
      // for a shutdown while waiting on A: B is stopped and the attempt is left
      // as it is, and a resume judges A from its record.
      await this.abortPair(
        pair,
        "The overlord was shut down while the builder was being spawned; both were stopped.",
      );
      return false;
    }
    if (spawned === null) {
      // §11.2 step 5: A failed after B started. spawnRole has already sent the
      // slice down the builder spawn-failure path; what is left is B.
      if (pair.hasWatcher) {
        await this.stopPairWatcher(pair);
        const refusal = lingRefusal(this.lastSpawnError);
        await pair.failStart(
          refusal === undefined ? "worker_spawn_failed" : "oversight_unsupported",
          refusal ?? (this.lastSpawnError === undefined ? null : errorMessage(this.lastSpawnError)),
          "aborted",
        );
      }
      // That path retries an unwatched builder in the same round. A pair whose
      // watcher was spawned cannot be retried there, because the watcher's
      // request key for the round is spent, so the attempt ends here with the
      // reason and a resume starts a new round with a new pair. A shutdown
      // leaves the attempt as it is: stopping changes no verdict.
      if (!this.shutdownRequested && !this.pairSpawnedNothing(pair.record, sliceId, round)) {
        // The first gap since the spawn is the spawn's own; stopping B may add another.
        const reason =
          this.manifest.integration.gaps[gapsBefore] ?? `The campaign is ${this.manifest.status}.`;
        await this.blockSlice(
          sliceId,
          `Builder of pair ${pair.pairId} did not spawn: ${reason} Its watcher was already spawned under this round's request key, so the slice starts again in a new round.`,
        );
      }
      return false;
    }
    if (pair.hasWatcher) {
      const supported = pair.recordCapability("worker", await this.healthOf(spawned.workerId));
      if (!supported) {
        await this.stopTaskHard(spawned.id);
        await this.stopPairWatcher(pair);
        await pair.failStart(
          "oversight_unsupported",
          "The builder's worker does not advertise oversight version 1.",
          "aborted",
        );
        this.forgetPairRecords(pair);
        await this.blockSlice(
          sliceId,
          "The builder's worker does not support oversight; the pair was aborted.",
        );
        return false;
      }
    }
    await pair.workerAccepted(spawned.id);
    return true;
  }

  /**
   * Admit both halves of a pair together, spawn B, and wait until B is ready
   * (§11.2 steps 1-3). "stopped" when the campaign stopped on the way (a
   * budget, a policy refusal); otherwise B is ready, or failed to start for
   * the reason returned, and has been stopped and released.
   */
  private async startWatcher(
    sliceId: string,
    round: number,
    pair: OversightPair,
    workerTask: RoleTask,
    watch: CampaignWatchConfig,
    builderEffective: { maxCostUsd: number; maxTurns: number; maxWallClockMs: number },
  ): Promise<"ready" | "stopped" | { outcome: PairStartOutcome; detail: string | null }> {
    const model = watch.watcher;
    if (model === null) {
      // The schema refuses this; a campaign that got here anyway stops rather
      // than end its run still marked running.
      await this.blockCampaign(`watch.condition ${watch.condition} names no watcher model.`);
      return "stopped";
    }
    const tools = watcherTools(watch.condition);
    // B's turns and wall clock are derived from A's, which policy has already
    // bounded, and are meant to exceed them: B must outlive A's longest run.
    // Its tools and its spend are policy's to allow or trim.
    const limits = watcherLimits(builderEffective.maxWallClockMs, watch.watcherMaxCostUsd);
    const maxCostUsd = Math.min(limits.maxCostUsd, this.policy.maxCostUsdPerTask);
    const allowed = new Set(this.policy.allowedTools);
    const disallowed = tools.filter((tool) => !allowed.has(tool));
    if (disallowed.length > 0) {
      await this.blockCampaign(
        `watcher policy requires tool(s) not allowed by fleet policy: ${disallowed.join(", ")}.`,
      );
      return "stopped";
    }
    const violation = profileCapabilityViolation(
      { provider: model.provider, model: model.model, inlineSkillCount: 0 },
      this.policy,
    );
    if (violation !== undefined) {
      await this.blockCampaign(`watcher profile violates fleet policy: ${violation}.`);
      return "stopped";
    }
    const requestKey = campaignRequestKey(this.manifest.id, "watcher", sliceId, round);
    const builderKey = campaignRequestKey(this.manifest.id, "builder", sliceId, round);
    const blocked =
      this.pairAdmissionBlock(builderEffective.maxCostUsd + maxCostUsd) ??
      this.fleetStore?.reserveSpawn(
        requestKey,
        this.manifest.id,
        maxCostUsd,
        this.policy,
        limits.maxWallClockMs * 2 + this.settleGraceMs,
        this.rateLimits,
      );
    if (blocked !== undefined) {
      await this.stopForSpawnBlock(blocked, "watcher");
      return "stopped";
    }
    // A's reservation is taken now, so a pair is admitted whole or not at all.
    const builderBlocked = this.fleetStore?.reserveSpawn(
      builderKey,
      this.manifest.id,
      builderEffective.maxCostUsd,
      this.policy,
      workerMaxRunMs(builderEffective.maxWallClockMs) * 2 + this.settleGraceMs,
      this.rateLimits,
    );
    if (builderBlocked !== undefined) {
      this.fleetStore?.releaseReservation(requestKey);
      await this.stopForSpawnBlock(builderBlocked, "builder");
      return "stopped";
    }
    const profile = this.manifest.roles.builder;
    const input: SpawnInput = {
      task: watcherBrief({
        workerPrompt: workerTask.prompt,
        workerFiles: { ...(profile.files ?? {}), ...workerTask.files },
        workerMaxTurns: builderEffective.maxTurns,
        workerMaxWallClockMs: builderEffective.maxWallClockMs,
        ...(watch.watchFor === undefined ? {} : { watchFor: watch.watchFor }),
      }),
      requestKey,
      tools,
      maxCostUsd,
      maxTurns: limits.maxTurns,
      maxWallClockMs: limits.maxWallClockMs,
      provider: model.provider,
      model: model.model,
      ...(model.thinking === undefined ? {} : { thinking: model.thinking }),
    };
    const requestBytes = Buffer.byteLength(JSON.stringify(input));
    if (requestBytes > MAX_LING_REQUEST_BODY_BYTES) {
      this.fleetStore?.releaseReservation(requestKey);
      this.fleetStore?.releaseReservation(builderKey);
      await this.blockCampaign(
        `watcher request is ${requestBytes} bytes after JSON encoding; Ling accepts at most ${MAX_LING_REQUEST_BODY_BYTES}.`,
      );
      return "stopped";
    }
    const summoned = await this.summonTask({
      role: "watcher",
      sliceId,
      round,
      requestKey,
      input,
      profileSha256: hashState({
        role: "watcher",
        watch,
        tools,
        limits: { ...limits, maxCostUsd },
      }),
      requestSha256: hashState(input),
      seededArtifacts: [],
      seededMessageIds: [],
      tools,
      pairId: pair.pairId,
      // As the builder's is recorded in startPair: in the same write as the task.
      recordId: (manifest, id) => {
        pair.watcherAccepted(id);
        this.pairsByTask.set(id, pair);
        this.attemptIn(manifest, sliceId, round).watch = structuredClone(pair.record);
      },
    });
    if (summoned === null) {
      this.fleetStore?.releaseReservation(builderKey);
      return "stopped";
    }
    if ("error" in summoned) {
      const refusal = lingRefusal(summoned.error);
      return refusal === undefined
        ? { outcome: "watcher_spawn_failed", detail: errorMessage(summoned.error) }
        : { outcome: "oversight_unsupported", detail: refusal };
    }
    const spawned = summoned.record;
    if (this.shutdownRequested || this.manifest.status !== "running") {
      // As for any role (spawnRoleNow): B started while the stop landed, so
      // it is stopped, its log stored and its lease released (§11.2 step 4).
      await this.stopPairWatcher(pair);
      this.fleetStore?.releaseReservation(builderKey);
      return "stopped";
    }
    if (!pair.recordCapability("watcher", await this.healthOf(spawned.workerId))) {
      await this.stopPairWatcher(pair);
      return {
        outcome: "oversight_unsupported",
        detail: "The watcher's worker does not advertise oversight version 1.",
      };
    }
    if (!(await pair.waitReady())) {
      await this.stopPairWatcher(pair);
      return {
        outcome: "watcher_not_ready",
        detail: "The watcher did not start watching within the readiness window.",
      };
    }
    return "ready";
  }

  /**
   * Whether a pair spawned nothing: no watcher was ever asked for under its
   * round's request key, and no builder was recorded. Only such a pair can be
   * started again in the same round.
   */
  private pairSpawnedNothing(pair: CampaignPairRecord, sliceId: string, round: number): boolean {
    const watcherKey = campaignRequestKey(this.manifest.id, "watcher", sliceId, round);
    return (
      pair.watcherTaskId === null &&
      pair.workerTaskId === null &&
      !this.manifest.summons.some((intent) => intent.requestKey === watcherKey)
    );
  }

  /**
   * Whether two more tasks fit the run's task and concurrency caps and both
   * ceilings fit its budget, before either is spawned (§11.2 step 1).
   */
  private pairAdmissionBlock(costUsd: number): SpawnBlockReason | undefined {
    const maxTasks = Math.min(this.policy.maxTasksPerRun, this.manifest.budget.maxTasks);
    if (
      this.ledger.taskCount() + 2 > maxTasks ||
      this.manifest.tasks.length + 2 > this.manifest.budget.maxTasks
    ) {
      return "task_cap";
    }
    if (this.ledger.inFlight() + 2 > this.policy.maxConcurrentTasks) return "concurrency";
    return this.ledger.spawnBlockReason(costUsd);
  }

  /**
   * After A's end: settle B, record what became of it, keep both tasks' logs,
   * and release B (§11.7). A is released later, after its own artifacts.
   */
  private async settlePair(pair: OversightPair, workerTask: LingTask): Promise<void> {
    // Both undefined, so nothing to record, for a pair whose watcher never
    // ran beside A or was settled when it failed to start.
    const { task: watcherTask, termination } = await pair.settle(workerTask);
    const watcherId = pair.record.watcherTaskId;
    if (watcherId !== null) await this.recordWatcherEnd(watcherId, watcherTask, termination);
    await this.storePairLogs(pair);
    this.forgetPairRecords(pair);
    if (watcherId !== null && watcherTask !== undefined && isTerminalStatus(watcherTask.status)) {
      await this.releaseWatcher(watcherTask);
    }
  }

  /** The campaign stopped waiting for A: B is stopped, and the pair recorded as cut short. */
  private async abortPair(
    pair: OversightPair,
    detail = "The campaign stopped before the builder ended; its watcher was stopped.",
  ): Promise<void> {
    // Cut short first: B's end, which stopping it brings about, is then not
    // taken for a watcher lost while A ran.
    await pair.abort(detail);
    if (pair.hasWatcher) await this.stopPairWatcher(pair);
    await this.storePairLogs(pair);
    this.forgetPairRecords(pair);
  }

  /**
   * A settled pair's members' records are on disk and stored as logs; memory
   * need not keep them. One whose logs were taken while it still ran is kept
   * for the store that replaces them.
   */
  private forgetPairRecords(pair: OversightPair): void {
    for (const taskId of [pair.record.workerTaskId, pair.record.watcherTaskId]) {
      if (taskId !== null && !this.partialLogs.has(taskId)) this.eventRecords.delete(taskId);
    }
  }

  /** Stop B, whatever it is doing, then record, keep its log and release it. */
  private async stopPairWatcher(pair: OversightPair): Promise<void> {
    const watcherId = pair.record.watcherTaskId;
    if (watcherId === null) return;
    const existing = this.manifest.tasks.find((task) => task.id === watcherId);
    if (existing === undefined || isTerminalStatus(existing.status)) return;
    const { task, termination } = await pair.stopTask(watcherId);
    await this.recordWatcherEnd(watcherId, task, termination);
    await this.storeTaskLogs(watcherId);
    this.eventRecords.delete(watcherId);
    if (task !== undefined && isTerminalStatus(task.status)) await this.releaseWatcher(task);
  }

  /**
   * What became of B. A kill the pair made is on record already, written
   * down before it was applied and charged as it was confirmed (killPairMember).
   * One that could not be confirmed blocks the campaign only now, once A has
   * ended or the campaign has stopped: blocking it while A ran would stop A
   * for B's sake (§11.8 step 6).
   */
  private async recordWatcherEnd(
    watcherId: string,
    task: LingTask | undefined,
    termination: CampaignTaskRecord["terminated"],
  ): Promise<void> {
    if (task !== undefined) {
      const record = this.manifest.tasks.find((candidate) => candidate.id === watcherId);
      this.account(task, record?.workerId, record?.requestKey);
      if (isTerminalStatus(task.status)) await this.recordTerminalTask(watcherId, task);
    }
    if (termination !== undefined && termination.completedAt === null) {
      await this.blockUnconfirmedKill(watcherId, termination);
    }
  }

  /**
   * A pair's kill of one of its members, as the driver kills any task: its
   * logs kept, the kill written down before it is applied, then recorded and
   * charged at what the task reads as after it. On a provisioned client that
   * is its whole ceiling, so B's spend up to the kill counts against B's
   * ceiling and the campaign's as soon as B is killed, not once A ends. An
   * unconfirmed kill does not block the campaign here (recordWatcherEnd).
   */
  private async killPairMember(taskId: string): Promise<WatcherStop> {
    const killed = await this.killAndRead(taskId, "cancel-unconfirmed", false);
    return { task: killed?.after, termination: killed?.termination };
  }

  /**
   * Cancel a task and, if the cancel is not confirmed within cancelGraceMs,
   * kill it: the rung past cancel, on any client that can kill. A client
   * that cannot is given cancelTask's own five seconds, as before. `stopped`
   * once the task is known to have ended, by its cancel or by a confirmed
   * kill. `termination` if a kill was tried; it is recorded, and one that
   * could not be confirmed has already blocked the campaign. A provisioned
   * client reads a killed task at its ceiling, so a kill charges the task's
   * whole budget.
   */
  private async stopTaskHard(
    taskId: string,
  ): Promise<{ stopped: boolean; termination?: CampaignTaskTermination }> {
    const confirmMs = this.client.terminate === undefined ? undefined : this.cancelGraceMs;
    if (await this.cancelTask(taskId, confirmMs)) return { stopped: true };
    const termination = await this.killTask(taskId, "cancel-unconfirmed");
    return termination === undefined
      ? { stopped: false }
      : { stopped: termination.completedAt !== null, termination };
  }

  /**
   * Kill the worker holding a task, whatever the task is doing, and record
   * the kill with its reason. Undefined on a client that cannot kill.
   *
   * The kill is written down before it is applied (§4), as an open
   * termination: no completedAt and no errors yet. An overlord that ends
   * between the two leaves that on the record, a kill asked for whose outcome
   * no process saw, rather than nothing.
   */
  private async killTask(
    taskId: string,
    reason: "cancel-unconfirmed" | "worker-unreachable",
  ): Promise<CampaignTaskTermination | undefined> {
    return (await this.killAndRead(taskId, reason, true))?.termination;
  }

  /**
   * killTask, with the task as read after a confirmed kill, and the campaign
   * blocked on an unconfirmed one only if `blockUnconfirmed`.
   */
  private async killAndRead(
    taskId: string,
    reason: "cancel-unconfirmed" | "worker-unreachable",
    blockUnconfirmed: boolean,
  ): Promise<{ termination: CampaignTaskTermination; after: LingTask | undefined } | undefined> {
    const client = this.client;
    if (client.terminate === undefined) return undefined;
    // A kill can take the service's log with the lease, so a pair member's is
    // kept first, as it stands, and taken again once the kill is confirmed.
    await this.storePairMemberLogs(taskId);
    const workerId = this.manifest.tasks.find((candidate) => candidate.id === taskId)?.workerId;
    const requestedAt = new Date().toISOString();
    await this.persist((manifest) => {
      const target = manifest.tasks.find((candidate) => candidate.id === taskId);
      if (target !== undefined) {
        target.terminated = { reason, requestedAt, completedAt: null, errors: [] };
      }
    });
    const termination = await terminationOf(
      reason,
      () => client.terminate!(taskId, reason, workerId),
      requestedAt,
    );
    // Read once more after a confirmed kill: a provisioned client reads a
    // killed task that never reported its end at the most it may have spent,
    // and that is what is charged.
    const after =
      termination.completedAt === null
        ? undefined
        : await client.get(taskId, workerId).catch(() => undefined);
    await this.recordTermination(taskId, termination, after, blockUnconfirmed);
    if (termination.completedAt !== null && this.partialLogs.has(taskId)) {
      await this.storeTaskLogs(taskId);
    }
    return { termination, after };
  }

  /**
   * Write down that a task was killed. A confirmed kill ends the task, which
   * never reported a terminal state of its own, as interrupted; its worker is
   * gone, so its summon is released. An unconfirmed one may still be spending,
   * and stops the campaign so somebody looks.
   *
   * The ledger and the fleet store last heard of a killed task as running, and
   * the task will never say otherwise. So the kill is accounted here too: left
   * running there, it would hold a concurrency slot for the rest of this
   * campaign, and against every other campaign until the store's stale prune.
   */
  private async recordTermination(
    taskId: string,
    termination: NonNullable<CampaignTaskRecord["terminated"]>,
    lastKnown?: LingTask,
    blockUnconfirmed = true,
  ): Promise<void> {
    await this.persist((manifest) => {
      const target = manifest.tasks.find((candidate) => candidate.id === taskId);
      if (target === undefined) return;
      target.terminated = termination;
      if (lastKnown !== undefined) {
        target.costUsd = Math.max(target.costUsd, lastKnown.stats?.cost ?? 0);
        target.totalTokens = Math.max(target.totalTokens, taskTotalTokens(lastKnown));
      }
      if (termination.completedAt !== null && !isTerminalStatus(target.status)) {
        target.status = "interrupted";
        const intent = manifest.summons.find(
          (candidate) => candidate.requestKey === target.requestKey,
        );
        if (intent !== undefined && intent.workerId !== null && intent.taskId !== null) {
          intent.state = "released";
          intent.updatedAt = new Date().toISOString();
        }
      }
    });
    const killed = this.manifest.tasks.find((candidate) => candidate.id === taskId);
    if (termination.completedAt !== null && killed?.status === "interrupted") {
      this.account(
        syntheticTask(killed, this.artifacts.workspacesDir),
        killed.workerId,
        killed.requestKey,
      );
    }
    if (termination.completedAt === null && blockUnconfirmed) {
      await this.blockUnconfirmedKill(taskId, termination);
    }
  }

  /** A kill that could not be confirmed may still be spending: the campaign stops so somebody looks. */
  private async blockUnconfirmedKill(
    taskId: string,
    termination: CampaignTaskTermination,
  ): Promise<void> {
    const why =
      termination.reason === "worker-unreachable"
        ? "stopped answering"
        : "did not stop after its cancel";
    await this.blockCampaign(
      `Task ${taskId} ${why} and could not be confirmed killed: ${termination.errors.join("; ") || "no detail"}.`,
    );
  }

  /** A watcher has no artifacts to collect: completed or not, it is released once recorded. */
  private async releaseWatcher(task: LingTask): Promise<void> {
    try {
      if (task.status === "completed") await this.releaseCollectedTask(task);
      else await this.releaseUnsuccessfulTask(task);
    } catch {
      // The summon state says what was not done; the next reconcile finishes it.
    }
  }

  /** Both members' logs, kept as artifacts before either lease is released (§11.7 step 6). */
  private async storePairLogs(pair: OversightPair): Promise<void> {
    for (const taskId of [pair.record.workerTaskId, pair.record.watcherTaskId]) {
      if (taskId !== null) await this.storeTaskLogs(taskId);
    }
  }

  /**
   * A pair member's logs, before a cancel or a kill releases its lease. Every
   * path that stops a member without settling its pair comes through here.
   */
  private async storePairMemberLogs(taskId: string): Promise<void> {
    if (this.pairsByTask.has(taskId)) await this.storeTaskLogs(taskId);
  }

  /**
   * Keep a task's logs as artifacts: the overlord's record and the service's
   * log. Logs taken while the task still ran are replaced by a later store,
   * which keeps whichever half it could not take again.
   */
  private async storeTaskLogs(taskId: string): Promise<void> {
    const record = this.manifest.tasks.find((candidate) => candidate.id === taskId);
    if (record === undefined) return;
    if (record.logs !== undefined && !this.partialLogs.has(taskId)) return;
    const earlier = record.logs;
    const running = !isTerminalStatus(record.status);
    const lines = (events: readonly LingEvent[]) =>
      events.map((event) => `${JSON.stringify(event)}\n`).join("");
    const namespace = `logs/${Buffer.from(taskId).toString("base64url")}`;
    const kept = this.eventRecords.get(taskId)?.events();
    const recordRef =
      kept === undefined || kept.length === 0
        ? null
        : await this.artifacts
            .storeText(namespace, "overlord-record.jsonl", lines(kept))
            .catch(() => null);
    let serviceRef: ArtifactRef | null = null;
    if (this.client.fetchLog !== undefined) {
      const served = await this.client.fetchLog(taskId, record.workerId).catch(() => undefined);
      if (served !== undefined && served.length > 0) {
        serviceRef = await this.artifacts
          .storeText(namespace, "service-log.jsonl", lines(served))
          .catch(() => null);
      }
    }
    if (recordRef === null && serviceRef === null) return;
    await this.persist((manifest) => {
      const target = manifest.tasks.find((candidate) => candidate.id === taskId);
      if (target !== undefined) {
        target.logs = {
          record: recordRef ?? earlier?.record ?? null,
          service: serviceRef ?? earlier?.service ?? null,
        };
      }
    });
    if (running) this.partialLogs.add(taskId);
    else this.partialLogs.delete(taskId);
  }

  private async healthOf(workerId: string | undefined): Promise<LingHealth | undefined> {
    if (workerId === undefined || this.client.health === undefined) return undefined;
    try {
      return (await this.client.health())[workerId];
    } catch {
      return undefined;
    }
  }

  /**
   * The client calls a pair makes, routed through this campaign's client.
   * run() refuses a pair with a watcher on a client without sendOversight or
   * terminate, and a pair without one calls neither, so sendOversight is
   * looked up only when called: a no_watcher pair may run on a client that
   * lacks them. A pair kills through its host (killPairMember), never here.
   * Not one whose builder's variant says what the run keeps: run() refuses
   * that on a client without terminate or release (LEASE_ONLY_VARIANTS), for
   * what the builder is told rather than for anything the pair calls.
   */
  private oversightClient(): OversightClient {
    const client = this.client;
    return {
      sendOversight: (id, message, workerId) => client.sendOversight!(id, message, workerId),
      get: (id, workerId) => client.get(id, workerId),
      cancel: (id, workerId) => client.cancel(id, workerId),
    };
  }

  /** What a pair borrows from the driver. `record` is the pair's own, never replaced. */
  private pairHost(sliceId: string, round: number, record: CampaignPairRecord): PairHost {
    return {
      save: (snapshot) =>
        this.persist((manifest) => {
          this.attemptIn(manifest, sliceId, round).watch = structuredClone(snapshot);
        }),
      storeText: (namespace, sourcePath, content) =>
        this.artifacts.storeText(namespace, sourcePath, content),
      workerIdOf: (taskId) => this.manifest.tasks.find((task) => task.id === taskId)?.workerId,
      kill: (taskId) => this.killPairMember(taskId),
      workerRecordAssessment: () => {
        const workerId = record.workerTaskId;
        return workerId === null ? undefined : this.eventRecords.get(workerId)?.assess();
      },
      workerRecordEvents: () => {
        const workerId = record.workerTaskId;
        return workerId === null ? [] : (this.eventRecords.get(workerId)?.events() ?? []);
      },
      workerDeclaresIntent: () => {
        const task = this.manifest.tasks.find((candidate) => candidate.id === record.workerTaskId);
        return task !== undefined && this.intentToolAvailable(task);
      },
    };
  }

  /**
   * Conservative campaign-local reservation used only by parallel mode.
   * Terminal tasks contribute observed spend; every active task reserves its
   * full effective role ceiling so a concurrently admitted batch cannot make
   * the campaign's configured USD ceiling meaningless.
   */
  private reservedCampaignCostUsd(): number {
    return this.manifest.tasks.reduce((total, task) => {
      if (isTerminalStatus(task.status)) return total + task.costUsd;
      return total + this.costCeilingFor(task);
    }, 0);
  }

  /**
   * A task's spend ceiling as the campaign reserves it. A watcher has no role
   * profile; its ceiling is the watch configuration's.
   */
  private costCeilingFor(task: Pick<CampaignTaskRecord, "role">): number {
    const ceiling =
      task.role === "watcher"
        ? (this.manifest.coordination.watch?.watcherMaxCostUsd ?? this.policy.maxCostUsdPerTask)
        : this.manifest.roles[task.role].maxCostUsd;
    return Math.min(ceiling, this.policy.maxCostUsdPerTask);
  }

  private intentToolAvailable(
    record: CampaignTaskRecord,
    task?: LingTask,
  ): boolean {
    const effectiveTools = task?.options.tools ?? record.effectiveTools;
    if (effectiveTools !== undefined) {
      return effectiveTools.includes(DECLARE_INTENT_TOOL_NAME);
    }
    // Compatibility for manifests written before the effective grant was
    // recorded and whose worker task can no longer be read. A watcher has no
    // profile, and never declare_intent.
    if (record.role === "watcher") return false;
    return (this.manifest.roles[record.role]?.tools ?? []).includes(
      DECLARE_INTENT_TOOL_NAME,
    );
  }

  /**
   * Watch one task's event stream while it runs.
   *
   * This used to exist only for passive messaging and only for slice tasks. It
   * now also carries declared-intent observation, which wants every task
   * including the planner, so the two consumers have different entry conditions
   * and different failure semantics.
   *
   * Passive messaging *depends* on the stream: a message that cannot be
   * delivered changes what a peer knows, so a failed tap blocks the campaign
   * exactly as before. Intent observation does not: the stream is the live
   * source, the overlord's record is the authoritative one read at settlement,
   * and losing the stream costs visibility rather than correctness. So a failure
   * with no messaging consumer degrades and the run continues.
   *
   * Every event passes through the task's `EventRecord` before any consumer
   * sees it, so the overlord's own copy is never behind what it acted on. The
   * stream is joined after the record's last gapless sequence number, and what
   * a reopened record already holds is replayed to the consumers first, which
   * is what the stream's own replay used to give them. A record that cannot be
   * opened -- a task id no file can carry, a directory that cannot be written --
   * costs the record, not the tap: the consumers run as they did before records
   * existed, and settlement falls back to the service's log.
   *
   * A member of a pair this process runs is always tapped, whatever else it
   * has: its stream is the pair's only input. Its events reach the pair after
   * the record has them, and a pair that fails to take one is recorded on the
   * pair rather than breaking the tap, so the record stays whole.
   */
  private startEventTap(record: CampaignTaskRecord, replayTerminal = false): void {
    const messaging =
      this.manifest.coordination.passiveMessaging && record.sliceId !== null;
    const observing = this.intentToolAvailable(record);
    const pair = this.pairsByTask.get(record.id);
    const asWatcher = record.role === "watcher";
    if (
      (!messaging && !observing && pair === undefined) ||
      (isTerminalStatus(record.status) && !replayTerminal) ||
      this.client.events === undefined ||
      this.eventTaps.has(record.id)
    ) {
      return;
    }
    const observation = observing ? this.trackerFor(record.id) : undefined;
    const controller = new AbortController();
    const consume = async (event: LingEvent): Promise<boolean> => {
      if (observation !== undefined) {
        // The SSE tail is capped, so a stream that does not start at the
        // first sequence number has already lost events. Recording that is
        // what stops a truncated stream reading as a complete account.
        observation.firstSeq ??= event.seq;
        const divergence = observation.tracker.observe(event);
        if (divergence !== undefined && !observation.reported) {
          observation.reported = true;
          await this.recordLiveDivergence(record.id, observation);
        }
      }
      if (messaging && event.type === "task_started") {
        await this.messaging.deliverPendingMessagesToTask(record.id);
      }
      if (messaging && event.type === "campaign_message") {
        await this.messaging.handleCampaignMessage(record.id, event);
      }
      if (pair !== undefined) {
        await (asWatcher ? pair.onWatcherEvent(event) : pair.onWorkerEvent(event)).catch(
          () => undefined,
        );
      }
      return TERMINAL_EVENT_TYPES.has(event.type);
    };
    const settled = (async () => {
      let eventRecord: EventRecord | undefined;
      try {
        eventRecord = await EventRecord.open(this.campaignDirectory(), record.id).catch(
          () => undefined,
        );
        if (eventRecord !== undefined) this.eventRecords.set(record.id, eventRecord);
        const resumeSeq = eventRecord?.resumeSeq ?? 0;
        let ended = false;
        for (const held of eventRecord?.events() ?? []) {
          if (held.seq > resumeSeq) break;
          if (await consume(held)) {
            ended = true;
            break;
          }
        }
        const stream = ended
          ? undefined
          : this.client.events?.(record.id, record.workerId, {
              signal: controller.signal,
              sinceSeq: resumeSeq,
            });
        if (stream !== undefined) {
          for await (const event of eventRecord === undefined ? stream : eventRecord.tap(stream)) {
            if (await consume(event)) {
              ended = true;
              break;
            }
          }
        }
        if (!ended && !controller.signal.aborted && pair !== undefined) {
          await (asWatcher ? pair.onWatcherStreamEnded() : pair.onWorkerStreamEnded());
        }
      } catch (error) {
        if (observation !== undefined) observation.broken = true;
        if (pair !== undefined && !controller.signal.aborted) {
          await (asWatcher ? pair.onWatcherStreamEnded() : pair.onWorkerStreamEnded()).catch(
            () => undefined,
          );
        }
        if (messaging && !controller.signal.aborted && this.manifest.status === "running") {
          await this.blockCampaign(
            `Passive message watcher failed for task ${record.id}: ${errorMessage(error)}`,
          ).catch(() => undefined);
        }
      } finally {
        // Closed before settlement reads it, and still readable after: the
        // record judges from what it holds in memory.
        await eventRecord?.close().catch(() => undefined);
        if (this.eventTaps.get(record.id)?.controller === controller) {
          this.eventTaps.delete(record.id);
        }
      }
    })();
    this.eventTaps.set(record.id, { controller, settled });
  }

  private trackerFor(taskId: string): LiveIntentObservation {
    const existing = this.intentObservations.get(taskId);
    if (existing !== undefined) return existing;
    const created: LiveIntentObservation = {
      tracker: createIntentTracker(),
      firstSeq: undefined,
      reported: false,
      broken: false,
    };
    this.intentObservations.set(taskId, created);
    return created;
  }

  /**
   * Persist the first divergence as soon as it is seen, rather than waiting for
   * settlement. One manifest write per diverging task: the point is that a
   * crash between the divergence and the end of the task does not lose it, and
   * that an operator watching a long task sees it now.
   */
  private async recordLiveDivergence(
    taskId: string,
    observation: LiveIntentObservation,
  ): Promise<void> {
    const report = observation.tracker.report();
    // `persist` notifies onProgress, so writing the partial report is also how
    // an operator watching the run learns about it while the task is still alive.
    await this.persist((manifest) => {
      const target = manifest.tasks.find((candidate) => candidate.id === taskId);
      if (target !== undefined) target.intent = report;
    }).catch(() => undefined);
  }

  private async drainEventTap(taskId: string): Promise<void> {
    const tap = this.eventTaps.get(taskId);
    if (tap === undefined) return;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      tap.settled,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, 5_000);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (!timedOut) return;
    tap.controller.abort();
    await tap.settled;
  }

  private async stopEventTaps(): Promise<void> {
    const taps = [...this.eventTaps.values()];
    for (const tap of taps) tap.controller.abort();
    await Promise.allSettled(taps.map((tap) => tap.settled));
    this.eventTaps.clear();
  }

  /**
   * Wait for a task to end, and stop it if it does not.
   *
   * A task is given up on twice its role's wall clock plus settleGraceMs
   * after the wait began, which leaves room for a queue ahead of it. A
   * watched builder runs on a worker of its own and is given up on sooner:
   * its own wall clock from when it was first read running, plus the hold
   * credit its ling may have granted it so far (§7.7), plus settleGraceMs.
   * So an A that its ling cannot stop is found a grace after its ling
   * should have, not twice its longest run later. A task given up on, or
   * still running once the campaign has stopped, is cancelled, and killed
   * if the cancel is not confirmed within cancelGraceMs (stopTaskHard).
   *
   * A read the worker does not answer at all, on a client that can kill it,
   * is retried for unreachableMs from the first such read; an answer starts
   * the count again. Past it the worker is killed as unreachable. Any other
   * failed read blocks the campaign at once.
   *
   * Once the campaign has stopped, nothing is returned for a task stopped
   * here. A task read as having ended on its own is recorded, and returned
   * only with `judgeAfterStop`: in a parallel batch a sibling's outcome can
   * stop the campaign while this task's result is on its way, and that
   * result is paid for and still the slice's.
   */
  private async waitForTask(
    id: string,
    roleWallClockMs: number,
    pair?: OversightPair,
    judgeAfterStop = false,
  ): Promise<LingTask | undefined> {
    const wallClockMs = Math.max(0, roleWallClockMs);
    const longest = pair === undefined ? wallClockMs : workerMaxRunMs(wallClockMs);
    const outerDeadline = Date.now() + longest * 2 + this.settleGraceMs;
    let runningSince: number | undefined;
    let unansweredSince: number | undefined;
    let stopAsked = false;
    const deadline = () =>
      pair === undefined || runningSince === undefined
        ? outerDeadline
        : runningSince + wallClockMs + pair.workerCreditMs() + this.settleGraceMs;
    while (Date.now() < deadline()) {
      if (this.shutdownRequested) return undefined;
      let task: LingTask;
      try {
        task = await this.readTask(id);
      } catch (error) {
        if (isNotFound(error)) {
          await this.blockCampaign(`Task ${id} disappeared from Ling before settlement.`);
          return undefined;
        }
        if (this.shutdownRequested) return undefined;
        if (this.client.terminate !== undefined && isUnanswered(error)) {
          unansweredSince ??= Date.now();
          if (Date.now() - unansweredSince < this.unreachableMs) {
            await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
            continue;
          }
          // A kill that is not confirmed blocks the campaign on its own.
          const termination = await this.killTask(id, "worker-unreachable");
          if (termination?.completedAt != null) {
            await this.blockCampaign(
              `Worker for task ${id} did not answer for ${this.unreachableMs} ms, so it was killed: ${errorMessage(error)}`,
            );
          }
          return undefined;
        }
        await this.blockCampaign(
          `Worker became unavailable while waiting for task ${id}: ${errorMessage(error)}`,
        );
        return undefined;
      }
      unansweredSince = undefined;
      if (task.status !== "queued") runningSince ??= Date.now();
      const known = this.manifest.tasks.find((candidate) => candidate.id === id);
      this.account(task, known?.workerId, known?.requestKey);
      if (this.manifest.status !== "running") {
        if (isTerminalStatus(task.status)) {
          await this.recordTerminalTask(id, task);
          // An end the cancel below brought about is not a result.
          if (judgeAfterStop && !stopAsked) return task;
        } else {
          // Without a kill, the cancel is asked again until the task ends or
          // the deadline passes. A kill that was tried is the last word.
          stopAsked = true;
          const stop = await this.stopTaskHard(id);
          if (!stop.stopped && stop.termination === undefined) {
            await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
            continue;
          }
        }
        return undefined;
      }
      if (isTerminalStatus(task.status)) {
        await this.recordTerminalTask(id, task);
        return task;
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
    const stop = await this.stopTaskHard(id);
    const outcome = !stop.stopped
      ? "could not cancel it"
      : stop.termination === undefined
        ? "cancelled it"
        : "killed it when its cancel went unconfirmed";
    await this.blockCampaign(`Timed out waiting for campaign task ${id} to settle; ${outcome}.`);
    return undefined;
  }

  private async recordTerminalTask(id: string, task: LingTask): Promise<void> {
    // Drain first. The watcher is the live source for the declared-intent
    // comparison, and judging a task while its stream is still being consumed
    // would read whatever happened to have arrived as the whole account.
    await this.drainEventTap(id);
    const intent = await this.compareDeclaredIntent(id, task);
    await this.persist((manifest) => {
      const record = manifest.tasks.find((candidate) => candidate.id === id);
      if (record !== undefined) {
        record.status = task.status;
        record.costUsd = Math.max(0, task.stats?.cost ?? record.costUsd);
        record.totalTokens = Math.max(record.totalTokens, taskTotalTokens(task));
        if (intent !== undefined) record.intent = intent;
      }
    });
  }

  /**
   * Compare a settled task's behaviour against what it declared it would do.
   *
   * This gathers the possible accounts; `resolveIntentReport` decides which to
   * believe. Called only after the task's tap has drained, so the record and the
   * live source are whole rather than whatever had arrived by now.
   *
   * The record this process kept is passed as itself, so it is judged from
   * memory. Only a task this process kept no record for -- one that settled
   * before a restart, or whose stream was never tapped -- is judged from the
   * record file, with the trust in that file `readEventRecord` describes.
   */
  private async compareDeclaredIntent(
    id: string,
    task: LingTask,
  ): Promise<CampaignIntentRecord | undefined> {
    const record = this.manifest.tasks.find((candidate) => candidate.id === id);
    if (record === undefined) return undefined;
    const toolAvailable = this.intentToolAvailable(record, task);

    let events: LingLogEvent[] | undefined;
    if (toolAvailable && this.client.history !== undefined) {
      try {
        events = await this.client.history(task);
      } catch {
        events = undefined;
      }
    }
    const eventRecord =
      this.eventRecords.get(id) ??
      (toolAvailable
        ? await readEventRecord(this.campaignDirectory(), id).catch(() => undefined)
        : undefined);
    const live = this.intentObservations.get(id);
    this.intentObservations.delete(id);
    // A pair still grades from its members' records and stores them as logs;
    // it lets go of them itself once it has (forgetPairRecords).
    if (!this.pairsByTask.has(id)) this.eventRecords.delete(id);
    return resolveIntentReport({
      toolAvailable,
      ...(eventRecord === undefined ? {} : { eventRecord }),
      recorded: events,
      ...(live === undefined
        ? {}
        : {
            live: {
              sawAnyEvent: live.tracker.sawAnyEvent(),
              firstSeq: live.firstSeq,
              broken: live.broken,
              report: () => live.tracker.report(),
            },
          }),
    });
  }

  /** Mark durable result/artifact capture, then tear down an ephemeral worker. */
  private async releaseCollectedTask(task: LingTask): Promise<void> {
    if (task.status !== "completed") {
      throw new Error(`Cannot mark non-completed task ${task.id} as collected.`);
    }
    await this.updateSummonState(task, "collected");
    try {
      await this.client.collectComplete?.(task.id, task.workerId);
      if (this.client.release !== undefined) {
        await this.client.release(task.id, task.workerId);
        await this.updateSummonState(task, "released");
      }
    } catch (error) {
      await this.updateSummonState(task, "collected", errorMessage(error));
      throw error;
    }
  }

  /** Failed/cancelled/interrupted tasks have no successful artifact contract to preserve. */
  private async releaseUnsuccessfulTask(task: LingTask): Promise<void> {
    if (!isTerminalStatus(task.status) || task.status === "completed") return;
    if (this.client.release === undefined) return;
    try {
      await this.client.release(task.id, task.workerId);
      await this.updateSummonState(task, "released");
    } catch (error) {
      await this.updateSummonState(task, "failed", errorMessage(error));
      throw error;
    }
  }

  private async updateSummonState(
    task: LingTask,
    state: "collected" | "released" | "failed",
    error: string | null = null,
  ): Promise<void> {
    if (task.requestKey === undefined) return;
    await this.persist((manifest) => {
      const intent = manifest.summons.find(
        (candidate) => candidate.requestKey === task.requestKey,
      );
      if (intent === undefined) return;
      intent.state = state;
      intent.workerId = task.workerId ?? intent.workerId;
      intent.taskId = task.id;
      intent.updatedAt = new Date().toISOString();
      intent.error = error;
    });
  }

  /**
   * A task the driver stops waiting on keeps spending until its own ceiling, so
   * it is cancelled before the campaign blocks. `confirmMs` is how long it is
   * read for a terminal state once the cancel is accepted.
   */
  private async cancelTask(id: string, confirmMs = 5_000): Promise<boolean> {
    const before = this.manifest.tasks.find((candidate) => candidate.id === id);
    try {
      await this.client.cancel(id, before?.workerId);
    } catch {
      // It may have settled between the status read and cancellation.
      const settled = await this.client.get(id, before?.workerId).catch(() => undefined);
      if (settled !== undefined && isTerminalStatus(settled.status)) {
        this.account(settled, before?.workerId, before?.requestKey);
        await this.recordTerminalTask(id, settled);
        await this.storePairMemberLogs(id);
        await this.releaseUnsuccessfulTask(settled);
        return true;
      }
      // Already gone or unreachable. The campaign has already stopped.
      return false;
    }
    const task = await this.readUntilTerminal(id, before?.workerId, confirmMs).catch(
      () => undefined,
    );
    const record = this.manifest.tasks.find((candidate) => candidate.id === id);
    // Cancellation is a request, not an outcome: the worker aborts cooperatively, so a
    // task mid-turn keeps running and keeps spending. This used to write `cancelled`
    // whenever five seconds elapsed without a terminal read, which freed the
    // concurrency and spend commitments, suppressed later cleanup, and released a
    // worker that was still working. Unconfirmed is now reported as unconfirmed: the
    // observed cost is still recorded, because that part was observed, but the status
    // is left alone and the caller is told it failed.
    if (record !== undefined && (task === undefined || !isTerminalStatus(task.status))) {
      if (task !== undefined) {
        const observed: CampaignTaskRecord = {
          ...record,
          costUsd: Math.max(record.costUsd, task.stats?.cost ?? 0),
          totalTokens: Math.max(record.totalTokens, taskTotalTokens(task)),
        };
        this.account(task, observed.workerId, observed.requestKey);
        await this.persist((manifest) => {
          const target = manifest.tasks.find((candidate) => candidate.id === id);
          if (target !== undefined) Object.assign(target, observed);
        });
      }
      return false;
    }
    if (record !== undefined && task !== undefined) {
      // Confirmed terminal. It may have settled on its own between the timeout and the
      // cancel; recording that real state keeps the manifest and ledger honest.
      const updated: CampaignTaskRecord = {
        ...record,
        status: task.status,
        costUsd: Math.max(record.costUsd, task.stats?.cost ?? 0),
        totalTokens: Math.max(record.totalTokens, taskTotalTokens(task)),
      };
      const accounted = task;
      this.account(accounted, updated.workerId, updated.requestKey);
      await this.persist((manifest) => {
        const target = manifest.tasks.find((candidate) => candidate.id === id);
        if (target !== undefined) Object.assign(target, updated);
      });
      await this.drainEventTap(id);
      await this.storePairMemberLogs(id);
      await this.releaseUnsuccessfulTask(accounted);
    }
    return true;
  }

  private async readUntilTerminal(
    id: string,
    workerId: string | undefined,
    timeoutMs: number,
  ): Promise<LingTask> {
    const deadline = Date.now() + timeoutMs;
    let latest: LingTask | undefined;
    do {
      latest = await this.client.get(id, workerId);
      if (isTerminalStatus(latest.status)) return latest;
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, this.pollIntervalMs)));
    } while (Date.now() < deadline);
    if (latest !== undefined) return latest;
    throw new Error(`Task ${id} could not be read after cancellation.`);
  }

  private async readTask(id: string): Promise<LingTask> {
    const knownRecord = this.manifest.tasks.find((candidate) => candidate.id === id);
    try {
      return await this.client.get(id, knownRecord?.workerId);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      const record = knownRecord;
      if (record === undefined || !isTerminalStatus(record.status)) throw error;
      const task = syntheticTask(record, this.artifacts.workspacesDir);
      if (record.status === "completed") {
        try {
          task.result = JSON.parse(
            await readFile(path.join(this.artifacts.workspacesDir, id, "result.json"), "utf8"),
          );
        } catch {
          // A completed snapshot without a readable result is rejected by the role handler.
        }
      }
      return task;
    }
  }

  private async stopForSpawnBlock(reason: SpawnBlockReason, role: CampaignRole): Promise<void> {
    if (reason === "budget" || reason === "tokens") {
      await this.persist((manifest) =>
        transitionCampaignIfActive(manifest, "budget_exhausted"),
      );
      return;
    }
    if (reason === "task_cap") {
      await this.capCampaign(`Fleet task cap reached before spawning ${role}.`);
      return;
    }
    // A rate limit blocks rather than waits, and blocks rather than exhausts. Waiting
    // could park a campaign for an hour while its slices carry wall-clock deadlines,
    // and `budget_exhausted` would be a lie: the money is there, the pace is not. So
    // the campaign stops in a state `--resume` can pick up once the window drains,
    // which is also what makes a rate limit visible to an operator rather than a
    // mysterious slowdown.
    if (reason === "rate_tasks" || reason === "rate_spend" || reason === "rate_decisions") {
      await this.blockCampaign(
        `Fleet rolling-window limit (${reason}) prevented spawning ${role}; resume once the window drains.`,
      );
      return;
    }
    await this.blockCampaign(
      reason === "concurrency"
        ? `Fleet concurrency cap prevented spawning ${role}.`
        : `Invalid cost estimate prevented spawning ${role}.`,
    );
  }

  private async blockPlanning(gap: string): Promise<void> {
    await this.persist((manifest) => {
      manifest.planning.status = "blocked";
      manifest.planning.gaps = [gap];
      transitionCampaignIfActive(manifest, "blocked");
    });
  }

  private async blockSlice(sliceId: string, gap: string): Promise<void> {
    await this.persist((manifest) => {
      const slice = manifest.slices.find((candidate) => candidate.id === sliceId);
      if (slice === undefined) throw new Error(`Unknown slice ${sliceId}.`);
      const attempt = slice.attempts.at(-1);
      if (attempt !== undefined) {
        attempt.verdict = "blocked";
        attempt.gaps = [gap];
        attempt.costUsd = this.costFor(attempt.builderId, attempt.reviewerId);
      }
      if (slice.status !== "blocked") transitionSlice(manifest, sliceId, "blocked");
      transitionCampaignIfActive(manifest, "blocked");
    });
  }

  private async blockCampaign(gap: string): Promise<void> {
    await this.persist((manifest) => {
      manifest.integration.gaps = [...manifest.integration.gaps, gap];
      transitionCampaignIfActive(manifest, "blocked");
    });
  }

  private async blockIntegration(gap: string): Promise<void> {
    await this.persist((manifest) => {
      const attempt = manifest.integration.attempts.at(-1);
      if (attempt !== undefined) {
        attempt.verdict = "blocked";
        attempt.gaps = [gap];
        attempt.costUsd = this.costFor(attempt.reviewerId);
        this.syncIntegrationSummary(attempt, manifest);
      } else {
        manifest.integration.gaps = [...manifest.integration.gaps, gap];
      }
      transitionCampaignIfActive(manifest, "blocked");
    });
  }

  private async capSlice(sliceId: string): Promise<void> {
    await this.persist((manifest) => {
      transitionSlice(manifest, sliceId, "capped");
      transitionCampaignIfActive(manifest, "capped");
    });
  }

  private async capCampaign(gap: string): Promise<void> {
    await this.persist((manifest) => {
      manifest.integration.gaps = [...manifest.integration.gaps, gap];
      transitionCampaignIfActive(manifest, "capped");
    });
  }

  /**
   * Wait for a wall-clock deadline without going deaf to shutdown.
   *
   * `shutdown()` cannot cancel anything until the run loop yields the campaign, so
   * an uninterruptible sleep anywhere inside the loop is a window in which the
   * stop path is ignored while live workers keep spending. Polling in
   * `pollIntervalMs` slices costs nothing and bounds that window by one poll.
   *
   * Returns false if shutdown was requested before the deadline arrived, which
   * callers must read as "do not proceed" rather than "the wait is over".
   */
  private async sleepUntil(deadlineMs: number): Promise<boolean> {
    while (!this.shutdownRequested) {
      const remaining = deadlineMs - Date.now();
      if (!(remaining > 0)) return true;
      await new Promise((resolve) => setTimeout(resolve, Math.min(this.pollIntervalMs, remaining)));
    }
    return false;
  }

  private async maybeAutoRecoverHalt(): Promise<boolean> {
    if (
      !this.manifest.brain.enabled ||
      (this.manifest.status !== "blocked" && this.manifest.status !== "budget_exhausted")
    ) {
      return false;
    }
    const pending = this.manifest.brain.pendingRecovery;
    if (pending !== null) {
      const decision = this.manifest.brain.decisions.find(
        (candidate) => candidate.key === pending.decisionKey,
      );
      if (decision === undefined || decision.action !== "reopen_campaign") {
        await this.persist((manifest) => {
          manifest.integration.gaps.push(
            `Pending recovery ${pending.decisionKey} has no replayable reopen decision.`,
          );
          manifest.brain.pendingRecovery = null;
        });
        return false;
      }
      if (!(await this.sleepUntil(recoveryReconcileAt(pending.notBefore, Date.now())))) {
        return false;
      }
      if (decision.appliedAt === null) {
        await this.persist((manifest) => {
          this.markBrainDecisionApplied(manifest, pending.decisionKey);
          manifest.brain.haltReopensUsed += 1;
        });
      }
      this.resumeBlocked = true;
      return true;
    }
    if (this.manifest.brain.haltReopensUsed >= this.manifest.brain.maxHaltReopens) {
      return false;
    }
    const decision = recoveryDecision({
      goal: this.manifest.goal,
      status: this.manifest.status,
      haltReopensUsed: this.manifest.brain.haltReopensUsed,
      maxHaltReopens: this.manifest.brain.maxHaltReopens,
      latestGaps: this.manifest.integration.gaps,
      slices: this.manifest.slices.map((slice) => ({
        id: slice.id,
        status: slice.status,
        attemptsUsed: slice.attempts.length,
        attemptsRemaining: this.sliceAttemptLimit(slice) - slice.attempts.length,
        latestGaps: slice.attempts.at(-1)?.gaps ?? [],
      })),
      tasks: this.manifest.tasks,
      budget: {
        maxTasks: this.manifest.budget.maxTasks,
        tasksUsed: this.manifest.tasks.length,
        maxTotalCostUsd: this.manifest.budget.maxTotalCostUsd,
        spentUsd: this.manifest.spentUsdSnapshot,
        maxTotalTokens: this.manifest.budget.maxTotalTokens ?? null,
        spentTokens: this.manifest.spentTokensSnapshot,
      },
    });
    const key = decision.request.key;
    let choice: CampaignBrainChoice;
    try {
      choice = await this.decideWithBrain(decision);
    } catch (error) {
      await this.persist((manifest) => {
        manifest.integration.gaps.push(`Brain recovery decision failed: ${errorMessage(error)}`);
      });
      return false;
    }
    if (choice.action === "leave_halted") {
      await this.persist((manifest) => this.markBrainDecisionApplied(manifest, key));
      return false;
    }
    const delayMs = choice.arguments["delayMs"] as number;
    await this.persist((manifest) => {
      manifest.brain.pendingRecovery = {
        decisionKey: key,
        notBefore: new Date(Date.now() + delayMs).toISOString(),
      };
    });
    return this.maybeAutoRecoverHalt();
  }

  private async clearAppliedPendingRecovery(): Promise<void> {
    const pending = this.manifest.brain.pendingRecovery;
    if (pending === null) return;
    const decision = this.manifest.brain.decisions.find(
      (candidate) => candidate.key === pending.decisionKey,
    );
    if (decision?.appliedAt === null || decision === undefined) return;
    await this.persist((manifest) => {
      if (manifest.brain.pendingRecovery?.decisionKey === pending.decisionKey) {
        manifest.brain.pendingRecovery = null;
      }
    });
  }

  private async decideWithBrain(decision: BrainDecision): Promise<CampaignBrainChoice> {
    const operation = this.brainTail.then(() => this.decideWithBrainNow(decision));
    this.brainTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async decideWithBrainNow({
    request,
    fallback,
    validate,
  }: BrainDecision): Promise<CampaignBrainChoice> {
    const legalActions = request.legalActions.map((candidate) => candidate.action);
    if (new Set(legalActions).size !== legalActions.length) {
      throw new Error(`Brain decision ${request.key} contains duplicate legal actions.`);
    }
    const stateHash = decisionStateHash(request);
    const existing = this.manifest.brain.decisions.find(
      (decision) => decision.key === request.key,
    );
    if (existing !== undefined) {
      if (existing.stateHash !== stateHash) {
        throw new Error(
          `Recorded brain decision ${request.key} does not match the replayed legal state.`,
        );
      }
      const replayed = {
        action: existing.action,
        rationale: existing.rationale,
        arguments: structuredClone(existing.arguments),
      };
      validate(replayed);
      return replayed;
    }
    if (this.manifest.brain.decisions.length >= this.manifest.brain.maxDecisions) {
      throw new Error(
        `Campaign brain reached its ${this.manifest.brain.maxDecisions}-decision cap.`,
      );
    }

    let selected: CampaignBrainChoice | undefined;
    let source: "model" | "fallback" = "fallback";
    let lastError: unknown;
    // Decisions are metered separately from tasks because they are the cheap thing
    // that runs away: an overlord with no budget left for a worker can still ask a
    // model what to do next, forever, for a fraction of a cent each time.
    //
    // Exceeding the window takes the path an unreachable model already takes — the
    // deterministic fallback — rather than failing the campaign. A pace control that
    // turns into an outage is a worse pace control, and the fallback is already the
    // tested route for "the model did not answer".
    // Admission and accounting are one act, not a check followed by a record: two
    // decisions in flight would otherwise both pass a limit of one.
    // Counted whether or not a limit is configured, the way tasks and spend already
    // are: a window nobody is enforcing yet is still the record an operator sizes the
    // limit from.
    const rateBlocked =
      this.brain === undefined
        ? undefined
        : this.fleetStore?.tryRecordDecision(this.rateLimits, this.manifest.id);
    if (rateBlocked !== undefined) {
      lastError = new Error(
        `Fleet rolling-window limit (${rateBlocked}) reached; using the deterministic fallback.`,
      );
    }
    if (this.brain !== undefined && rateBlocked === undefined) {
      for (let attempt = 1; attempt <= this.brain.maxAttempts; attempt += 1) {
        try {
          const candidate = await this.brain.decide(request);
          if (!legalActions.includes(candidate.action)) {
            throw new Error(
              `Model chose illegal action ${JSON.stringify(candidate.action)}; legal actions: ${legalActions.join(", ")}.`,
            );
          }
          validate(candidate);
          selected = candidate;
          source = "model";
          break;
        } catch (error) {
          lastError = error;
        }
      }
    } else if (this.brain === undefined) {
      // Only when there is genuinely no brain. Overwriting here would replace a rate
      // limit's reason with a wrong one, and the recorded rationale is how an operator
      // finds out why a decision fell back at all.
      lastError = new Error("No overlord brain is configured.");
    }
    if (selected === undefined) {
      const failure = errorMessage(lastError);
      selected = {
        ...structuredClone(fallback),
        rationale: `${fallback.rationale} Failure: ${failure}`.slice(0, 4096),
      };
      validate(selected);
    }
    await this.persist((manifest) => {
      manifest.brain.decisions.push({
        seq: manifest.brain.decisions.length + 1,
        key: request.key,
        at: new Date().toISOString(),
        phase: request.phase as CampaignBrainPhase,
        source,
        model: source === "model" ? (this.brain?.model ?? null) : null,
        action: selected.action,
        rationale: selected.rationale,
        arguments: structuredClone(selected.arguments),
        legalActions,
        stateHash,
        appliedAt: null,
      });
    });
    return selected;
  }

  private markBrainDecisionApplied(manifest: CampaignManifest, key: string): void {
    const decision = manifest.brain.decisions.find((candidate) => candidate.key === key);
    if (decision === undefined) throw new Error(`Unknown brain decision ${key}.`);
    decision.appliedAt ??= new Date().toISOString();
  }

  private sliceAttemptLimit(slice: CampaignSlice): number {
    return this.manifest.maxRounds - slice.createdInRound;
  }

  private async recordDecision(
    phase: CampaignDecisionPhase,
    action: string,
    rationale: string,
    refs: string[],
    actor = "overlord",
  ): Promise<void> {
    if (!this.manifest.coordination.enabled) return;
    const duplicate = this.manifest.coordination.decisions.some(
      (decision) =>
        decision.phase === phase &&
        decision.action === action &&
        decision.actor === actor &&
        decision.refs.length === refs.length &&
        decision.refs.every((ref, index) => ref === refs[index]),
    );
    if (duplicate) return;
    if (this.manifest.coordination.decisions.length >= 256) {
      await this.blockCampaign("Campaign coordination decision log reached its 256-entry limit.");
      return;
    }
    await this.persist((manifest) => {
      manifest.coordination.decisions.push({
        seq: manifest.coordination.decisions.length + 1,
        at: new Date().toISOString(),
        phase,
        actor,
        action,
        rationale,
        refs,
      });
    });
  }

  private async persist(
    mutate: ((manifest: CampaignManifest) => void) | undefined = undefined,
  ): Promise<void> {
    const operation = this.persistTail.then(async () => {
      const candidate = structuredClone(this.manifest);
      mutate?.(candidate);
      candidate.spentUsdSnapshot = this.ledger.spentUsd();
      candidate.spentTokensSnapshot = this.ledger.spentTokens();
      this.manifest = await this.store.save(candidate);
      await this.onProgress?.(this.manifest);
    });
    this.persistTail = operation.catch(() => undefined);
    await operation;
  }

  /**
   * Record a task's observed spend with this run's ledger and, when there is
   * one, the fleet-wide store. The two are always fed together: a task counted
   * by one and not the other is a budget that disagrees with itself.
   */
  private account(
    task: LingTask,
    workerId: string | undefined,
    requestKey: string | undefined,
  ): void {
    this.ledger.record(task);
    this.fleetStore?.record(task, this.manifest.id, workerId, requestKey);
  }

  /** Where the manifest lives, and with it the campaign's event records. */
  private campaignDirectory(): string {
    return path.dirname(this.store.filename);
  }

  private requireSlice(id: string | null): CampaignSlice {
    const slice = id === null ? undefined : this.manifest.slices.find((candidate) => candidate.id === id);
    if (slice === undefined) throw new Error(`Unknown campaign slice ${JSON.stringify(id)}.`);
    return slice;
  }

  private requireAttempt(slice: CampaignSlice, round: number): SliceAttempt {
    const attempt = slice.attempts.find((candidate) => candidate.round === round);
    if (attempt === undefined) throw new Error(`Slice ${slice.id} has no round ${round}.`);
    return attempt;
  }

  private attemptIn(manifest: CampaignManifest, sliceId: string, round: number): SliceAttempt {
    const slice = manifest.slices.find((candidate) => candidate.id === sliceId);
    const attempt = slice?.attempts.find((candidate) => candidate.round === round);
    if (attempt === undefined) throw new Error(`Slice ${sliceId} has no round ${round}.`);
    return attempt;
  }

  private costFor(...ids: (string | null)[]): number {
    let total = 0;
    for (const id of ids) {
      if (id === null) continue;
      total += this.manifest.tasks.find((task) => task.id === id)?.costUsd ?? 0;
    }
    return total;
  }

  private syncIntegrationSummary(
    attempt: IntegrationAttempt,
    manifest: CampaignManifest = this.manifest,
  ): void {
    manifest.integration.reviewerId = attempt.reviewerId;
    manifest.integration.verdict = attempt.verdict;
    manifest.integration.evidence = attempt.evidence;
    manifest.integration.gaps = attempt.gaps;
  }
}
