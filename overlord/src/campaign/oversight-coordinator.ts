/**
 * One watched pair, as the overlord runs it: worker A, watcher B, and the
 * overlord between them as the only mediator, recorder and actuator
 * (reports/oversight-wire.md §11; section numbers below refer to it).
 *
 * The driver owns spawning, the event taps and the manifest. It hands every
 * event from A's and B's streams to `onWorkerEvent` / `onWatcherEvent`, and
 * calls `settle` once A is terminal. Everything in between is here:
 *
 *   - readiness: B is ready at its first `watch_next` `tool_start` (§11.2);
 *   - requests: validate, persist, enqueue, in that order (§11.4);
 *   - delivery: only the routes `canDeliverOversight` allows (§11.9), through
 *     one ordered outbox per destination, the head alone in flight,
 *     retried on transport failure until a deadline, `deliveredAt` persisted
 *     after the 2xx (§11.6);
 *   - the feed: pull-paced, coalesced, built by `buildFeedBatch` (§9.3);
 *   - holds and their expiry, which escalates and releases and never cancels
 *     (§11.5);
 *   - losing B, which releases every hold and lets A carry on (§11.8);
 *   - settling B after A ends, then grading B against the facts (§11.7, §10).
 *
 * Every handler runs under one lock, so A's stream, B's stream and the timers
 * change state one at a time, in the order the overlord persists it. POSTs run
 * outside the lock; only their outcomes come back under it.
 *
 * Pairs do not survive an overlord restart in v1 (§15): this state lives in
 * the process, and the manifest copy is the record of it, not a way back in.
 */
import { LingClientError } from "../ling/client.js";
import { isTerminalStatus, LingProtocolError } from "../ling/events.js";
import type { LingEvent, LingHealth, LingTask } from "../ling/types.js";
import type { EventSequenceAssessment } from "./event-record.js";
import { createIntentTracker } from "./intent.js";
import {
  OVERSIGHT_CAPABILITY_VERSION,
  OVERSIGHT_LIMITS,
  OVERSIGHT_TIMINGS,
  beyondCursor,
  buildFeedBatch,
  computeOversightVerdict,
  feedItemIds,
  feedMessageId,
  holdIdFor,
  holdMessageId,
  isClaimItem,
  lifecycleDetail,
  lifecycleFact,
  localIdNumber,
  minBatchIntervalMs,
  oversightMessage,
  oversightThread,
  parseWatcherOversightEvent,
  parseWorkerOversightEvent,
  releaseMessageId,
  escalationId,
  sourceMessageId,
  validateWatcherResult,
  watcherCoverage,
  watcherTools,
  workerEventItems,
  workerTermination,
  type ClaimItem,
  type DeterministicFinding,
  type EventsCoverage,
  type FeedBody,
  type FeedItem,
  type HoldBody,
  type HoldEndReason,
  type LifecycleEvent,
  type OversightMessage,
  type OversightTimings,
  type ReleaseBody,
  type SensorCoverage,
  type WatchCondition,
  type WatcherOversightEvent,
  type WatcherReport,
  type WorkerOversightEvent,
  type WorkerStoppedBy,
  type WorkerTerminal,
} from "./oversight.js";
import { canDeliverOversight } from "./routing.js";
import type {
  ArtifactRef,
  CampaignPairRecord,
  CampaignTaskTermination,
  PairHoldRecord,
  PairMessageRecord,
  PairRequestRecord,
  WatcherLostCause,
} from "./schema.js";

/** The client calls a pair makes. All route by worker id, as the campaign client does. */
export interface OversightClient {
  sendOversight(
    id: string,
    message: OversightMessage,
    workerId?: string,
  ): Promise<{ accepted: true; duplicate: boolean }>;
  get(id: string, workerId?: string): Promise<LingTask>;
  cancel(id: string, workerId?: string): Promise<void>;
}

export interface OversightClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * Real time. A pair's timers are what the driver waits on while B gets ready
 * or settles, so they hold the process open; the driver disposes of its pairs
 * when its run ends.
 */
export const systemClock: OversightClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** What the pair borrows from the driver. */
export interface PairHost {
  /** Persist this snapshot of the pair record. Rejects when the manifest could not be saved. */
  save(record: CampaignPairRecord): Promise<void>;
  storeText(namespace: string, sourcePath: string, content: string): Promise<ArtifactRef>;
  /** The worker id a task's requests are routed by. */
  workerIdOf(taskId: string): string | undefined;
  /**
   * Kill a member whose cancel was not confirmed, as every action is taken:
   * written down before it is applied, then recorded and charged at what the
   * member reads as after it (§11.8 step 5). Returns the kill and that read.
   */
  kill(taskId: string): Promise<WatcherStop>;
  /** The overlord's record of A's stream, judged from memory. */
  workerRecordAssessment(): EventSequenceAssessment | undefined;
  /** A's recorded events, for the deterministic findings B is graded against. */
  workerRecordEvents(): readonly LingEvent[];
  /**
   * Whether A had declare_intent. Without it the intent comparison is a
   * recorded opt-out, and its actions are no findings for B to have cited.
   */
  workerDeclaresIntent(): boolean;
}

export interface OversightPairOptions {
  record: CampaignPairRecord;
  client: OversightClient;
  host: PairHost;
  /** A's own wall clock, which sizes the batch interval (§3). */
  workerWallClockMs: number;
  timings?: Partial<OversightTimings>;
  clock?: OversightClock;
}

/** What stopping or settling B came to. */
export interface WatcherStop {
  /** B's last known task: after a kill, as read once the kill was confirmed. */
  task: LingTask | undefined;
  termination: CampaignTaskTermination | undefined;
}

/**
 * What one kill came to, within the record's bounds (32 errors of at most
 * 1 000 characters): the provisioner's account of it, or the error it threw,
 * as a kill that cannot be confirmed. `requestedAt` is taken before the kill.
 */
export async function terminationOf(
  reason: CampaignTaskTermination["reason"],
  kill: () => Promise<{ requestedAt: string; completedAt?: string; errors: string[] }>,
  requestedAt: string,
): Promise<CampaignTaskTermination> {
  try {
    const done = await kill();
    return {
      reason,
      requestedAt: done.requestedAt,
      completedAt: done.completedAt ?? null,
      errors: done.errors.slice(0, 32).map((error) => error.slice(0, 1_000)),
    };
  } catch (error) {
    return {
      reason,
      requestedAt,
      completedAt: null,
      errors: [(error instanceof Error ? error.message : String(error)).slice(0, 1_000)],
    };
  }
}

type Destination = "worker" | "watcher";

type WatcherRequest = Exclude<
  WatcherOversightEvent,
  { type: "oversight_watch_returned" | "oversight_delivered" }
>;

type RefusalFact = "advice_refused" | "caution_refused" | "hold_refused" | "release_refused";

/**
 * B's requests (§11.4), by event: the kind each is recorded as, the tool its
 * condition must grant, the field naming what it is about, and the fact its
 * refusal adds. A refused concern adds none.
 */
const WATCHER_REQUESTS = {
  oversight_advice: {
    kind: "advice",
    tool: "advise",
    ref: "questionId",
    refused: "advice_refused",
  },
  oversight_caution: {
    kind: "caution",
    tool: "caution",
    ref: "cautionId",
    refused: "caution_refused",
  },
  oversight_hold_request: {
    kind: "hold_request",
    tool: "hold",
    ref: "requestId",
    refused: "hold_refused",
  },
  oversight_release_request: {
    kind: "release_request",
    tool: "release",
    ref: "holdId",
    refused: "release_refused",
  },
  oversight_concern: { kind: "concern", tool: "report_concern", ref: "concernId", refused: null },
} as const satisfies {
  [T in WatcherRequest["type"]]: {
    kind: PairRequestRecord["kind"];
    tool: string;
    ref: keyof Extract<WatcherRequest, { type: T }>;
    refused: RefusalFact | null;
  };
};

/** The question or caution an advice or caution message is about. */
function bodyRef(record: PairMessageRecord): string {
  const body = record.body as { questionId?: unknown; cautionId?: unknown } | null;
  return String(body?.questionId ?? body?.cautionId ?? "");
}

type DeliveryOutcome =
  | { kind: "delivered" }
  | { kind: "retry" }
  | { kind: "undeliverable"; code: string; protocol: boolean };

/** What a ling credits a watcher hold beyond its maxMs, up to its lapse (§7.7). */
const HOLD_LAPSE_ALLOWANCE_MS = 30_000;

const STOPPING_CODES = new Set(["not_running", "subscriber_unavailable", "feature_not_enabled"]);
const LOST_WORKER_CODES = new Set([
  "unknown_worker",
  "worker_released",
  "unknown_task",
  "no_lease",
]);

/** What one failed `sendOversight` attempt means for the message (§11.6). */
export function classifyDeliveryError(error: unknown): DeliveryOutcome {
  if (error instanceof LingClientError) {
    if (error.retryable) return { kind: "retry" };
    if (error.status === 409 && error.code !== null && STOPPING_CODES.has(error.code)) {
      return { kind: "undeliverable", code: error.code, protocol: false };
    }
    if (error.status === 404) return { kind: "undeliverable", code: "not_found", protocol: false };
    if (error.status === 401) {
      return { kind: "undeliverable", code: "unauthorized", protocol: true };
    }
    return {
      kind: "undeliverable",
      code: error.code ?? String(error.status ?? "transport"),
      protocol: true,
    };
  }
  if (error instanceof LingProtocolError) {
    return { kind: "undeliverable", code: "protocol_error", protocol: true };
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && LOST_WORKER_CODES.has(code)) {
    return { kind: "undeliverable", code: "not_found", protocol: false };
  }
  return { kind: "retry" };
}

function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

/** A fresh pair record, persisted before either task is spawned. */
export function newPairRecord(
  pairId: string,
  condition: WatchCondition,
  required: boolean,
): CampaignPairRecord {
  return {
    pairId,
    condition,
    required,
    state: condition === "no_watcher" ? "absent" : "starting",
    watcherTaskId: null,
    workerTaskId: null,
    readyAt: null,
    outcome: null,
    outcomeDetail: null,
    lostCause: null,
    watcherOutcome: null,
    compacted: false,
    capabilities: { worker: null, watcher: null },
    messages: [],
    facts: [],
    requests: [],
    holds: [],
    escalations: [],
    feed: {
      cursor: { aSeq: 0, sSeq: 0, oN: 0 },
      deferred: [],
      batches: 0,
      regular: 0,
      questions: 0,
      final: null,
      pulled: [],
      heartbeats: 0,
    },
    unshownCount: 0,
    unshown: null,
    report: null,
    protocolErrors: [],
    protocolErrorCount: 0,
    coverage: null,
    verdict: null,
  };
}

export class OversightPair {
  readonly record: CampaignPairRecord;
  private readonly client: OversightClient;
  private readonly host: PairHost;
  private readonly timings: OversightTimings;
  private readonly clock: OversightClock;
  private readonly batchIntervalMs: number;
  private tail: Promise<void> = Promise.resolve();

  // A's side.
  private readonly workerSeqs = new Set<number>();
  private workerStartedAt: number | null = null;
  private workerTurns = 0;
  private workerLastSeq = 0;
  private workerEnded: { terminal: WorkerTerminal; stoppedBy: WorkerStoppedBy } | null = null;
  private workerStreamBroken = false;
  private openQuestion: string | null = null;
  private readonly tracker = createIntentTracker();

  // B's side.
  private readonly watcherSeqs = new Set<number>();
  private watcherStartedAt: number | null = null;
  private watcherTerminal = false;
  /** B's stream failed while the pair was still starting, after B was ready. */
  private watcherStreamLostStarting = false;
  private pullsOutstanding = 0;
  private finalPulled = false;
  private anyFeedUndeliverable = false;
  private stopping: Promise<WatcherStop> | undefined;

  // The feed.
  private pending: FeedItem[] = [];
  private deferred: ClaimItem[] = [];
  private readonly items = new Map<string, FeedItem>();
  private readonly delivered = new Set<string>();
  private readonly sentQuestions = new Set<string>();
  private readonly deliveredQuestions = new Set<string>();
  private readonly unshown = new Set<string>();
  private lastBatchAt: number | null = null;
  private feedStopped = false;
  private lastCoverage: { events: EventsCoverage; sensor: SensorCoverage } | null = null;

  // Delivery.
  private readonly queues: Record<Destination, string[]> = { worker: [], watcher: [] };
  private readonly draining: Record<Destination, boolean> = { worker: false, watcher: false };
  private readonly firstAttemptAt = new Map<string, number>();
  /** Every message persisted, as it is sent: the same object on every retry. */
  private readonly outgoing = new Map<string, OversightMessage>();
  private readonly releasing = new Set<string>();
  private readonly deliveredFactsAtHold = new Map<string, number>();

  /** Live timers by name: readiness, silence, interval, expiry:<holdId>. */
  private readonly timers = new Map<string, unknown>();

  // Waiters.
  private readyWaiters: ((ready: boolean) => void)[] = [];
  private readyOutcome: boolean | undefined;
  private changeWaiters: (() => void)[] = [];

  constructor(options: OversightPairOptions) {
    this.record = options.record;
    this.client = options.client;
    this.host = options.host;
    this.timings = { ...OVERSIGHT_TIMINGS, ...options.timings };
    this.clock = options.clock ?? systemClock;
    this.batchIntervalMs =
      this.timings.minBatchIntervalMs ?? minBatchIntervalMs(options.workerWallClockMs);
  }

  get pairId(): string {
    return this.record.pairId;
  }

  /** A no_watcher pair starts absent and stays so; only a pair with a watcher leaves it. */
  get hasWatcher(): boolean {
    return this.record.state !== "absent";
  }

  /** Stop every timer and release every waiter. The pair does nothing after this. */
  dispose(): void {
    this.feedStopped = true;
    this.clearTimers();
    this.settleReady(false);
    this.notifyChange();
  }

  // -------------------------------------------------------------------------
  // Start (§11.2)

  /** B's POST was accepted. Readiness is timed from here. */
  watcherAccepted(taskId: string): void {
    this.record.watcherTaskId = taskId;
    this.armReadiness(this.timings.readyMs);
  }

  /** Resolves true at B's first `watch_next`, false once B cannot be ready. */
  waitReady(): Promise<boolean> {
    if (this.readyOutcome !== undefined) return Promise.resolve(this.readyOutcome);
    return new Promise((resolve) => this.readyWaiters.push(resolve));
  }

  /**
   * Record what a lease advertised, and whether it can take part: only with
   * the one capability version this overlord pairs with (§4.3). Absent and
   * any other version both mean unsupported.
   */
  recordCapability(side: "worker" | "watcher", health: LingHealth | undefined): boolean {
    const oversight = health?.capabilities?.oversight;
    this.record.capabilities[side] = oversight === undefined ? null : { ...oversight };
    return oversight?.version === OVERSIGHT_CAPABILITY_VERSION;
  }

  /**
   * The pair never ran as a pair (§11.2): B failed to start, or A failed after
   * B had. `absent` lets A run unwatched; `aborted` ends the attempt.
   */
  async failStart(
    outcome: NonNullable<CampaignPairRecord["outcome"]>,
    detail: string | null,
    state: "absent" | "aborted",
  ): Promise<void> {
    await this.locked(async () => {
      this.record.outcome = outcome;
      this.record.outcomeDetail =
        detail === null ? null : detail.slice(0, OVERSIGHT_LIMITS.detailChars);
      this.record.state = state;
      this.settleReady(false);
      this.clearTimers();
      this.feedStopped = true;
      await this.save();
    });
  }

  /**
   * A is spawned and B was ready: watching begins (§11.2 step 5).
   *
   * B can be lost between its readiness and A's acceptance, while nothing yet
   * counts as a loss: A's spawn can outlast B's `watch_next` idle return, and
   * a model B handed a heartbeat with no worker may end its run. What B did
   * meanwhile is applied here, so a pair never watches with a B that is gone
   * (§11.8): ended, its stream lost, or already out of a pull, in which case
   * the silence timer starts now as it would at a `tool_end`.
   */
  async workerAccepted(taskId: string): Promise<void> {
    await this.locked(async () => {
      this.record.workerTaskId = taskId;
      if (this.record.state === "starting") {
        this.record.state = "watching";
        if (this.watcherTerminal) {
          await this.loseWatcher("terminal");
        } else if (this.watcherStreamLostStarting) {
          await this.loseWatcher("stream_lost");
        } else if (this.pullsOutstanding === 0) {
          this.arm("silence", this.timings.watchSilenceMs, () => this.loseWatcher("silent"));
        }
      }
      await this.save();
      await this.maybeSendFeed();
    });
  }

  /**
   * The campaign stopped waiting for A before A ended. The pair is cut short:
   * nothing more is sent, and no verdict is reached on a run nobody saw end.
   */
  async abort(detail: string): Promise<void> {
    await this.locked(async () => {
      if (this.record.state === "starting" || this.record.state === "watching") {
        this.record.state = "aborted";
        this.record.outcomeDetail ??= detail.slice(0, OVERSIGHT_LIMITS.detailChars);
      }
      this.settleReady(false);
      this.stopFeed();
      this.clearTimers();
      await this.save();
    });
  }

  /**
   * Cancel B and, if it does not settle within the grace period, kill it.
   * Returns B's last known task and, if it came to that, the termination.
   */
  async stopTask(taskId: string): Promise<WatcherStop> {
    const workerId = this.host.workerIdOf(taskId);
    await this.client.cancel(taskId, workerId).catch(() => undefined);
    const deadline = this.clock.now() + this.timings.cancelGraceMs;
    let task: LingTask | undefined;
    while (true) {
      task = await this.client.get(taskId, workerId).catch(() => task);
      if (task !== undefined && isTerminalStatus(task.status)) {
        return { task, termination: undefined };
      }
      if (this.clock.now() >= deadline) break;
      await this.sleep(this.timings.pollMs);
    }
    const killed = await this.host.kill(taskId);
    // A confirmed kill is charged at the read after it; the read from before
    // it would undo that.
    const confirmed = killed.termination?.completedAt != null;
    return { task: killed.task ?? (confirmed ? undefined : task), termination: killed.termination };
  }

  /**
   * The wall-clock credit A's ling has granted A for watcher holds so far
   * (§7.7), as far as the overlord can tell: what A last reported in an
   * `oversight_clock`, or, where more, what the first two watcher holds the
   * overlord applied add up to, each to at most its lapse and the ling's
   * allowance on it, one still active counted to now. The driver waits on A
   * for its own wall clock plus this.
   */
  workerCreditMs(): number {
    const now = this.clock.now();
    let reported = 0;
    let held = 0;
    let counted = 0;
    for (const hold of this.record.holds) {
      if (hold.origin !== "watcher") continue;
      reported = Math.max(reported, hold.creditMs ?? 0);
      if (hold.appliedAt === null || counted >= OVERSIGHT_LIMITS.maxWatcherHolds) continue;
      counted += 1;
      const end = hold.endedAt === null ? now : Date.parse(hold.endedAt);
      held += Math.min(
        Math.max(0, end - Date.parse(hold.appliedAt)),
        hold.maxMs + HOLD_LAPSE_ALLOWANCE_MS,
      );
    }
    return Math.min(OVERSIGHT_LIMITS.maxHoldCreditMs, Math.max(reported, held));
  }

  // -------------------------------------------------------------------------
  // Events

  onWorkerEvent(event: LingEvent): Promise<void> {
    return this.locked(() => this.handleWorkerEvent(event));
  }

  onWatcherEvent(event: LingEvent): Promise<void> {
    return this.locked(() => this.handleWatcherEvent(event));
  }

  /** A's stream ended without a terminal event, or failed: events coverage is incomplete. */
  onWorkerStreamEnded(): Promise<void> {
    return this.locked(async () => {
      if (this.workerEnded === null) this.workerStreamBroken = true;
    });
  }

  /** B's stream failed and cannot be resumed. */
  onWatcherStreamEnded(): Promise<void> {
    return this.locked(async () => {
      if (this.watcherTerminal) return;
      if (this.record.state === "starting") {
        // Before readiness this ends the wait; after it, A's acceptance
        // records the loss.
        this.watcherStreamLostStarting = true;
        this.settleReady(false);
        return;
      }
      // Losing B is a loss only while A runs (§11.8). After A's end the
      // settle window times out instead, and a final batch nobody saw pulled
      // shows as final_not_received.
      if (this.workerEnded === null) await this.loseWatcher("stream_lost");
      this.notifyChange();
    });
  }

  private async handleWorkerEvent(event: LingEvent): Promise<void> {
    if (this.workerSeqs.has(event.seq)) return;
    this.workerSeqs.add(event.seq);
    this.workerLastSeq = Math.max(this.workerLastSeq, event.seq);
    const now = this.clock.now();
    const atNow = isoAt(now);
    if (event.type === "task_started" && this.workerStartedAt === null) {
      this.workerStartedAt = now;
      this.addFact("worker_started", null, lifecycleDetail.worker_started());
    }
    if (event.type === "turn_end") this.workerTurns += 1;
    if (event.type === "budget_stop") {
      const reason = (event.data as { reason?: unknown } | undefined)?.reason;
      this.addFact("budget_stop", null, lifecycleDetail.budget_stop(String(reason ?? "unknown")));
    }
    const divergence = this.tracker.observe(event);
    if (divergence !== undefined) {
      this.addFact(
        "divergence",
        null,
        lifecycleDetail.divergence(`${divergence.kind} ${divergence.value}`),
      );
    }

    // A refused question or note is recorded and goes no further: it is not a
    // claim B is shown, and B cannot answer it.
    let accepted: WorkerOversightEvent | undefined;
    const parsed = parseWorkerOversightEvent(event.type, event.data);
    if (parsed !== undefined) {
      if (!parsed.ok) {
        this.protocolError(this.record.workerTaskId, event.seq, parsed.reason);
      } else if (await this.handleWorkerOversight(event, parsed.event, atNow)) {
        accepted = parsed.event;
      }
    }
    if (this.hasWatcher && !this.feedStopped && (parsed === undefined || accepted !== undefined)) {
      for (const item of workerEventItems({
        ...event,
        ...(accepted === undefined ? {} : { parsed: accepted }),
      })) {
        this.offer(item);
      }
    }
    const termination = workerTermination(event.type, event.data);
    if (termination !== undefined) await this.workerEndedNow(termination);
    await this.save();
    await this.maybeSendFeed();
  }

  private async handleWorkerOversight(
    event: LingEvent,
    parsed: WorkerOversightEvent,
    atNow: string,
  ): Promise<boolean> {
    const sourceId = sourceMessageId(this.record.workerTaskId ?? "worker", event.seq);
    switch (parsed.type) {
      case "oversight_question": {
        if (this.record.requests.some((request) => request.id === sourceId)) return false;
        const asked = this.accepted("question").length;
        const request = this.request(sourceId, "worker", "question", parsed.questionId, event.at, {
          text: parsed.question,
          holdSelf: parsed.holdSelf,
        });
        if (
          this.record.condition !== "channel" ||
          !this.hasWatcher ||
          asked >= OVERSIGHT_LIMITS.maxQuestions ||
          this.openQuestion !== null
        ) {
          request.code = "protocol_error";
          this.protocolError(
            this.record.workerTaskId,
            event.seq,
            this.openQuestion !== null
              ? `question ${parsed.questionId} while ${this.openQuestion} is still open`
              : `question ${parsed.questionId} beyond what this task may ask`,
          );
          return false;
        }
        this.openQuestion = parsed.questionId;
        if (parsed.holdSelf) await this.applySelfHold(request, parsed.questionId);
        return true;
      }
      case "oversight_wait_ended": {
        if (this.openQuestion === parsed.questionId) this.openQuestion = null;
        const question = this.accepted("question").find(
          (request) => request.ref === parsed.questionId,
        );
        if (question !== undefined) question.waitOutcome = parsed.outcome;
        this.addFact(
          "question_wait_ended",
          parsed.questionId,
          lifecycleDetail.question_wait_ended(parsed.questionId, parsed.outcome, parsed.waitedMs),
        );
        return true;
      }
      case "oversight_note": {
        if (this.record.requests.some((request) => request.id === sourceId)) return false;
        const notes = this.accepted("note").length;
        const request = this.request(sourceId, "worker", "note", parsed.noteId, event.at, {
          text: parsed.content,
        });
        if (notes >= OVERSIGHT_LIMITS.maxNotes) {
          request.code = "protocol_error";
          this.protocolError(
            this.record.workerTaskId,
            event.seq,
            `note ${parsed.noteId} beyond the limit`,
          );
          return false;
        }
        return true;
      }
      case "oversight_gate": {
        const hold = this.holdById(parsed.holdId);
        if (parsed.action === "lapsed") {
          if (hold !== undefined && (hold.status === "active" || hold.status === "pending")) {
            this.endHold(hold, "lapsed", atNow);
          }
          return true;
        }
        this.addFact(
          "gate",
          parsed.holdId,
          lifecycleDetail.gate(parsed.tool ?? "", parsed.action, parsed.holdId),
        );
        return true;
      }
      case "oversight_shown": {
        if (parsed.messageId === null) return true;
        const message = this.acknowledged("worker", event.seq, "shown", parsed.messageId);
        if (message === undefined) return true;
        message.shownAt ??= atNow;
        if (parsed.notice === "late_advice") {
          this.addFact("advice_shown", parsed.ref, lifecycleDetail.advice_shown(parsed.ref));
        } else if (parsed.notice === "caution") {
          this.addFact(
            "caution_delivered",
            parsed.ref,
            lifecycleDetail.caution_delivered(parsed.ref),
          );
        }
        return true;
      }
      case "oversight_clock": {
        const hold = this.holdById(parsed.holdId);
        if (hold !== undefined) hold.creditMs = parsed.creditMs;
        return true;
      }
      case "oversight_delivered": {
        const message = this.acknowledged(
          "worker",
          event.seq,
          "delivered",
          parsed.messageId,
          parsed.kind,
        );
        if (message === undefined) return true;
        message.effect = parsed.effect;
        if (parsed.kind === "advice" && parsed.effect === "answered") {
          const questionId = bodyRef(message);
          this.addFact(
            "advice_delivered",
            questionId,
            lifecycleDetail.advice_delivered(questionId),
          );
        }
        return true;
      }
    }
  }

  private async handleWatcherEvent(event: LingEvent): Promise<void> {
    if (this.watcherSeqs.has(event.seq)) return;
    this.watcherSeqs.add(event.seq);
    const now = this.clock.now();
    const data = (event.data ?? {}) as Record<string, unknown>;
    if (event.type === "task_started" && this.watcherStartedAt === null) {
      this.watcherStartedAt = now;
      if (this.record.state === "starting") this.armReadiness(this.timings.readyMs);
    }
    if (event.type === "compaction_start") this.record.compacted = true;
    if (event.type === "tool_start" && data["tool"] === "watch_next") {
      this.pullsOutstanding += 1;
      this.disarm("silence");
      if (this.record.readyAt === null && this.record.state === "starting") {
        this.record.readyAt = isoAt(now);
        this.disarm("readiness");
        this.settleReady(true);
      }
    }
    if (event.type === "tool_end" && data["tool"] === "watch_next") {
      this.pullsOutstanding = Math.max(0, this.pullsOutstanding - 1);
      if (this.record.state === "watching" && this.workerEnded === null) {
        this.arm("silence", this.timings.watchSilenceMs, () => this.loseWatcher("silent"));
      }
    }
    const parsed = parseWatcherOversightEvent(event.type, event.data);
    if (parsed !== undefined) {
      if (!parsed.ok) this.protocolError(this.record.watcherTaskId, event.seq, parsed.reason);
      else await this.handleWatcherOversight(event, parsed.event);
    }
    if (workerTermination(event.type, event.data) !== undefined) {
      this.watcherTerminal = true;
      this.disarm("silence");
      if (this.record.state === "starting") {
        this.settleReady(false);
      } else if (this.record.state === "watching" && this.workerEnded === null) {
        await this.loseWatcher("terminal");
      }
      this.notifyChange();
    }
    await this.save();
    await this.maybeSendFeed();
  }

  private async handleWatcherOversight(
    event: LingEvent,
    parsed: WatcherOversightEvent,
  ): Promise<void> {
    if (parsed.type === "oversight_watch_returned") {
      if (parsed.result === "heartbeat") this.record.feed.heartbeats += 1;
      if (parsed.result !== "batch" || parsed.batch === null) return;
      const body = this.outgoing.get(feedMessageId(this.pairId, parsed.batch))?.body as
        | FeedBody
        | undefined;
      if (body === undefined) {
        this.protocolError(
          this.record.watcherTaskId,
          event.seq,
          `returned batch ${parsed.batch}, which was never sent`,
        );
        return;
      }
      if (!this.record.feed.pulled.includes(parsed.batch)) {
        this.record.feed.pulled.push(parsed.batch);
      }
      for (const id of feedItemIds(body)) this.delivered.add(id);
      for (const claim of body.claims) {
        if (claim.kind === "question") this.deliveredQuestions.add(claim.questionId);
      }
      if (body.final) {
        this.finalPulled = true;
        this.notifyChange();
      }
      return;
    }
    if (parsed.type === "oversight_delivered") {
      const message = this.acknowledged("watcher", event.seq, "delivered", parsed.messageId);
      if (message !== undefined) message.effect = parsed.effect;
      return;
    }
    await this.handleWatcherRequest(event, parsed);
  }

  // -------------------------------------------------------------------------
  // Requests (§11.4)

  private async handleWatcherRequest(event: LingEvent, parsed: WatcherRequest): Promise<void> {
    const sourceId = sourceMessageId(this.record.watcherTaskId ?? "watcher", event.seq);
    if (this.record.requests.some((request) => request.id === sourceId)) return;
    const atNow = isoAt(this.clock.now());
    const { kind, tool, ref: field, refused } = WATCHER_REQUESTS[parsed.type];
    const ref = (parsed as Record<string, unknown>)[field] as string;
    const evidence = "evidence" in parsed ? parsed.evidence : [];
    const request = this.request(sourceId, "watcher", kind, ref, event.at, {
      text:
        parsed.type === "oversight_hold_request"
          ? parsed.reason
          : "content" in parsed
            ? parsed.content
            : null,
      evidence,
      ...(parsed.type === "oversight_concern"
        ? { concernCode: parsed.code, severity: parsed.severity }
        : {}),
      ...(parsed.type === "oversight_release_request" ? { holdId: parsed.holdId } : {}),
    });
    const refuse = (code: string): void => {
      request.code = code;
      if (code !== "watcher_lost" && refused !== null) this.refusedFact(refused, ref, code);
    };
    if (!watcherTools(this.record.condition).includes(tool)) {
      this.protocolError(
        this.record.watcherTaskId,
        event.seq,
        `${tool} is not a tool of the ${this.record.condition} condition`,
      );
      return refuse("protocol_error");
    }
    if (this.record.state === "lost") return refuse("watcher_lost");
    if (kind !== "concern" && this.workerEnded !== null) return refuse("worker_ended");
    if (evidence.some((id) => !this.delivered.has(id))) return refuse("invalid_evidence");

    switch (parsed.type) {
      case "oversight_advice": {
        if (!this.deliveredQuestions.has(parsed.questionId)) return refuse("not_open");
        const answered = this.accepted("advice", request).some(
          (other) => other.ref === parsed.questionId,
        );
        if (answered) return refuse("already_answered");
        const selfHold = this.record.holds.find(
          (hold) =>
            hold.origin === "worker" &&
            hold.questionId === parsed.questionId &&
            (hold.status === "active" || hold.status === "pending"),
        );
        if (selfHold !== undefined) await this.enqueueRelease(selfHold, "answered");
        await this.enqueue(
          "worker",
          oversightMessage(sourceId, "advice", localIdNumber(parsed.questionId), event.at, {
            questionId: parsed.questionId,
            content: parsed.content,
          }),
        );
        return;
      }
      case "oversight_caution": {
        const cautions = this.accepted("caution", request).length;
        if (cautions >= OVERSIGHT_LIMITS.maxCautions) return refuse("limit_reached");
        await this.enqueue(
          "worker",
          oversightMessage(sourceId, "caution", localIdNumber(parsed.cautionId), event.at, {
            cautionId: parsed.cautionId,
            content: parsed.content,
          }),
        );
        return;
      }
      case "oversight_hold_request": {
        const watcherHolds = this.record.holds.filter(
          (hold) => hold.origin === "watcher" && hold.status !== "undeliverable",
        ).length;
        if (
          watcherHolds >= OVERSIGHT_LIMITS.maxWatcherHolds ||
          this.record.holds.length >= OVERSIGHT_LIMITS.maxHoldNumbers
        ) {
          return refuse("limit_reached");
        }
        if (this.activeHold() !== undefined) return refuse("hold_active");
        const hold = this.allocateHold("watcher", parsed.requestId, null, parsed.reason);
        request.holdId = hold.holdId;
        await this.enqueueHold(hold, atNow);
        return;
      }
      case "oversight_release_request": {
        const hold = this.holdById(parsed.holdId);
        if (hold === undefined || hold.status !== "active" || this.releasing.has(hold.holdId)) {
          return refuse("not_active");
        }
        if (hold.origin !== "watcher") return refuse("not_watcher_hold");
        await this.enqueueRelease(hold, "watcher");
        return;
      }
      case "oversight_concern": {
        const concerns = this.accepted("concern", request).length;
        if (concerns >= OVERSIGHT_LIMITS.maxConcerns) {
          this.protocolError(
            this.record.watcherTaskId,
            event.seq,
            `concern ${parsed.concernId} beyond the limit`,
          );
          return refuse("protocol_error");
        }
        return;
      }
    }
  }

  private request(
    id: string,
    from: "worker" | "watcher",
    kind: PairRequestRecord["kind"],
    ref: string,
    at: string,
    fields: Partial<
      Pick<
        PairRequestRecord,
        "text" | "evidence" | "holdSelf" | "concernCode" | "severity" | "holdId"
      >
    >,
  ): PairRequestRecord {
    if (this.record.requests.length >= OVERSIGHT_LIMITS.maxPairRequests) {
      // Both lings cap their own counters far below this; a stream past it is
      // not one this contract describes, and its requests go unrecorded.
      this.protocolError(null, null, `request limit reached; ${kind} ${id} not recorded`);
      throw new Error(`pair ${this.pairId} reached ${OVERSIGHT_LIMITS.maxPairRequests} requests`);
    }
    const request: PairRequestRecord = {
      id,
      from,
      kind,
      ref,
      at,
      code: null,
      text: fields.text ?? null,
      evidence: [...(fields.evidence ?? [])],
      holdSelf: fields.holdSelf ?? null,
      concernCode: fields.concernCode ?? null,
      severity: fields.severity ?? null,
      holdId: fields.holdId ?? null,
      selfHold: null,
      waitOutcome: null,
    };
    this.record.requests.push(request);
    return request;
  }

  /** The requests of a kind the overlord accepted, leaving out `except`. */
  private accepted(
    kind: PairRequestRecord["kind"],
    except?: PairRequestRecord,
  ): PairRequestRecord[] {
    return this.record.requests.filter(
      (request) => request.kind === kind && request.code === null && request !== except,
    );
  }

  // -------------------------------------------------------------------------
  // Holds (§11.4, §11.5)

  private activeHold(): PairHoldRecord | undefined {
    return this.record.holds.find((hold) => hold.status === "active" || hold.status === "pending");
  }

  private holdById(holdId: string): PairHoldRecord | undefined {
    return this.record.holds.find((hold) => hold.holdId === holdId);
  }

  private allocateHold(
    origin: "watcher" | "worker",
    requestId: string | null,
    questionId: string | null,
    reason: string | null,
  ): PairHoldRecord {
    const hold: PairHoldRecord = {
      holdId: holdIdFor(this.record.holds.length + 1),
      origin,
      requestId,
      questionId,
      reason,
      maxMs: OVERSIGHT_LIMITS.maxHoldMs,
      status: "pending",
      appliedAt: null,
      endedAt: null,
      endReason: null,
      escalatedAt: null,
      releasedOnWordsOnly: null,
      creditMs: null,
    };
    this.record.holds.push(hold);
    return hold;
  }

  private async applySelfHold(request: PairRequestRecord, questionId: string): Promise<void> {
    const selfHolds = this.record.holds.filter(
      (hold) => hold.origin === "worker" && hold.status !== "undeliverable",
    ).length;
    // Only while B watches. Once B is lost nobody can answer, and every hold
    // was released so that B's walking off is no lever over A (§11.8); a
    // self-hold then would only pause A until it expired.
    if (
      this.record.state !== "watching" ||
      this.activeHold() !== undefined ||
      this.workerEnded !== null ||
      selfHolds >= OVERSIGHT_LIMITS.maxSelfHolds ||
      this.record.holds.length >= OVERSIGHT_LIMITS.maxHoldNumbers
    ) {
      request.selfHold = "refused";
      return;
    }
    const hold = this.allocateHold("worker", null, questionId, null);
    request.selfHold = "pending";
    request.holdId = hold.holdId;
    await this.enqueueHold(hold, isoAt(this.clock.now()));
  }

  private async enqueueHold(hold: PairHoldRecord, createdAt: string): Promise<void> {
    const body: HoldBody = {
      holdId: hold.holdId,
      origin: hold.origin,
      questionId: hold.questionId,
      reason: hold.reason,
      maxMs: hold.maxMs,
    };
    const n = localIdNumber(hold.holdId);
    await this.enqueue(
      "worker",
      oversightMessage(holdMessageId(this.pairId, n), "hold", n, createdAt, body),
    );
  }

  private async enqueueRelease(hold: PairHoldRecord, reason: ReleaseBody["reason"]): Promise<void> {
    if (this.releasing.has(hold.holdId)) return;
    this.releasing.add(hold.holdId);
    const n = localIdNumber(hold.holdId);
    await this.enqueue(
      "worker",
      oversightMessage(releaseMessageId(this.pairId, n), "release", n, isoAt(this.clock.now()), {
        holdId: hold.holdId,
        reason,
      }),
    );
  }

  private endHold(hold: PairHoldRecord, reason: HoldEndReason, at: string): void {
    hold.status = "ended";
    hold.endReason = reason;
    hold.endedAt = at;
    this.disarmExpiry(hold.holdId);
    this.addFact("hold_ended", hold.holdId, lifecycleDetail.hold_ended(hold.holdId, reason));
  }

  private async expire(holdId: string): Promise<void> {
    const hold = this.holdById(holdId);
    if (hold === undefined || hold.status !== "active" || this.releasing.has(holdId)) return;
    const n = localIdNumber(holdId);
    const at = isoAt(this.clock.now());
    hold.escalatedAt = at;
    this.record.escalations.push({
      id: escalationId(this.pairId, n),
      thread: oversightThread("escalation", n),
      holdId,
      at,
    });
    await this.save();
    await this.enqueueRelease(hold, "expired");
  }

  // -------------------------------------------------------------------------
  // Delivery (§11.6)

  /** Persist, then queue. Nothing reaches a ling that is not already on disk. */
  private async enqueue(destination: Destination, message: OversightMessage): Promise<void> {
    if (this.messageById(message.id) !== undefined) return;
    // Every message reaches a ling through here, so this is where the §11.9
    // table is enforced: one off it is refused before it is persisted or sent.
    const toRole = destination === "worker" ? "builder" : "watcher";
    if (!canDeliverOversight(message.kind, message.from, toRole)) {
      this.protocolError(
        null,
        null,
        `${message.kind} ${message.id} from ${message.from} to the ${toRole} is not an oversight route`,
      );
      await this.save();
      return;
    }
    const record: PairMessageRecord = {
      id: message.id,
      kind: message.kind,
      to: destination,
      thread: message.thread,
      createdAt: message.createdAt,
      body: message.kind === "feed" ? null : ({ ...message.body } as Record<string, unknown>),
      artifact: null,
      attempts: 0,
      deliveredAt: null,
      undeliverable: null,
      effect: null,
      shownAt: null,
    };
    if (message.kind === "feed") {
      // The body's canonical JSON, so the pinned digest is the digest of it.
      record.artifact = await this.host.storeText(
        `oversight/${this.pairId}/feed`,
        `${(message.body as FeedBody).batch}.json`,
        JSON.stringify(message.body),
      );
    }
    this.outgoing.set(message.id, message);
    this.record.messages.push(record);
    try {
      await this.save();
    } catch (error) {
      // Not on disk, so not sent: a ling must never hold a message the record
      // does not.
      this.record.messages.splice(this.record.messages.indexOf(record), 1);
      this.outgoing.delete(message.id);
      throw error;
    }
    this.queues[destination].push(message.id);
    void this.drain(destination).catch(() => undefined);
  }

  /** Deliver one destination's queue in order, the head alone in flight. */
  private async drain(destination: Destination): Promise<void> {
    if (this.draining[destination]) return;
    this.draining[destination] = true;
    try {
      while (this.queues[destination].length > 0) {
        const id = this.queues[destination][0]!;
        const record = this.messageById(id);
        if (record === undefined || record.deliveredAt !== null || record.undeliverable !== null) {
          this.queues[destination].shift();
          continue;
        }
        const taskId = this.taskIdOf(destination);
        let outcome: DeliveryOutcome;
        if (taskId === null) {
          outcome = { kind: "undeliverable", code: "not_found", protocol: false };
        } else {
          if (!this.firstAttemptAt.has(id)) this.firstAttemptAt.set(id, this.clock.now());
          try {
            const message = this.outgoing.get(id);
            if (message === undefined) {
              throw new Error(`Oversight message ${id} has no body in memory.`);
            }
            await this.client.sendOversight(taskId, message, this.host.workerIdOf(taskId));
            outcome = { kind: "delivered" };
          } catch (error) {
            outcome = classifyDeliveryError(error);
          }
        }
        // A failure to record the outcome (a manifest that cannot be saved)
        // leaves the head where it is: the retry is a duplicate to the ling.
        const retry = await this.locked(() =>
          this.applyOutcome(destination, record, outcome),
        ).catch(() => true);
        if (retry) await this.sleep(this.timings.outboxRetryMs);
      }
    } finally {
      this.draining[destination] = false;
      this.notifyChange();
    }
    await this.locked(() => this.maybeSendFeed());
  }

  /** Apply one attempt's outcome. True when the head stays and is retried. */
  private async applyOutcome(
    destination: Destination,
    record: PairMessageRecord,
    outcome: DeliveryOutcome,
  ): Promise<boolean> {
    record.attempts += 1;
    if (record.undeliverable !== null) {
      // Marked while in flight (A ended). A 2xx still means the ling has it.
      if (outcome.kind === "delivered") record.deliveredAt = isoAt(this.clock.now());
      this.queues[destination].shift();
      await this.save().catch(() => undefined);
      return false;
    }
    if (outcome.kind === "delivered") {
      record.deliveredAt = isoAt(this.clock.now());
      try {
        await this.save();
      } catch {
        // The ling has it, the record does not say so. The retry gets 200
        // duplicate and `deliveredAt` is persisted then (§11.6).
        record.deliveredAt = null;
        return true;
      }
      this.queues[destination].shift();
      this.firstAttemptAt.delete(record.id);
      this.onDelivered(record);
      await this.save();
      return false;
    }
    if (outcome.kind === "retry") {
      const first = this.firstAttemptAt.get(record.id) ?? this.clock.now();
      if (this.clock.now() - first + this.timings.outboxRetryMs <= this.timings.outboxDeadlineMs) {
        return true;
      }
      return this.markUndeliverable(destination, record, "transport", false);
    }
    return this.markUndeliverable(destination, record, outcome.code, outcome.protocol);
  }

  private async markUndeliverable(
    destination: Destination,
    record: PairMessageRecord,
    code: string,
    protocol: boolean,
  ): Promise<false> {
    record.undeliverable = code;
    this.queues[destination].shift();
    this.firstAttemptAt.delete(record.id);
    if (protocol) {
      this.protocolError(
        this.taskIdOf(destination),
        null,
        `${record.kind} ${record.id} undeliverable: ${code}`,
      );
    }
    await this.onUndeliverable(record);
    await this.save();
    return false;
  }

  private onDelivered(record: PairMessageRecord): void {
    const at = isoAt(this.clock.now());
    if (record.kind === "hold") {
      const body = record.body as unknown as HoldBody;
      const hold = this.holdById(body.holdId);
      if (hold === undefined || hold.status !== "pending") return;
      hold.status = "active";
      hold.appliedAt = at;
      this.arm(`expiry:${hold.holdId}`, hold.maxMs, () => this.expire(hold.holdId));
      if (hold.origin === "watcher") {
        this.deliveredFactsAtHold.set(hold.holdId, this.deliveredFactCount());
        this.addFact(
          "hold_applied",
          hold.holdId,
          lifecycleDetail.hold_applied(hold.holdId, hold.requestId ?? "", hold.maxMs),
        );
      } else {
        const question = this.record.requests.find((request) => request.holdId === hold.holdId);
        if (question !== undefined) question.selfHold = "applied";
        this.addFact(
          "self_hold_applied",
          hold.holdId,
          lifecycleDetail.self_hold_applied(hold.holdId, hold.questionId ?? "", hold.maxMs),
        );
      }
      return;
    }
    if (record.kind === "release") {
      const body = record.body as unknown as ReleaseBody;
      const hold = this.holdById(body.holdId);
      this.releasing.delete(body.holdId);
      if (hold === undefined || (hold.status !== "active" && hold.status !== "pending")) return;
      if (body.reason === "watcher") {
        hold.releasedOnWordsOnly =
          this.deliveredFactCount() === (this.deliveredFactsAtHold.get(hold.holdId) ?? 0);
      }
      if (body.reason === "expired") {
        this.addFact("escalation", hold.holdId, lifecycleDetail.escalation(hold.holdId));
      }
      this.endHold(hold, body.reason, at);
    }
  }

  /** A message just marked undeliverable: what that means for what it carried (§11.6). */
  private async onUndeliverable(record: PairMessageRecord): Promise<void> {
    const cause = record.undeliverable;
    const code = cause === "worker_ended" ? "worker_ended" : "delivery_failed";
    if (record.kind === "advice" || record.kind === "caution") {
      this.refusedFact(
        record.kind === "advice" ? "advice_refused" : "caution_refused",
        bodyRef(record),
        code,
      );
      return;
    }
    if (record.kind === "hold") {
      const body = record.body as unknown as HoldBody;
      const hold = this.holdById(body.holdId);
      if (hold === undefined) return;
      hold.status = "undeliverable";
      if (hold.origin === "watcher") {
        this.refusedFact("hold_refused", hold.requestId ?? "", code);
      } else {
        const question = this.record.requests.find((request) => request.holdId === hold.holdId);
        if (question !== undefined) question.selfHold = "refused";
      }
      return;
    }
    if (record.kind === "release") {
      // The hold stays active here until A's lapse or A's end (§11.5). It
      // stays marked as releasing too: its one release id is spent, so a
      // second release could never be sent.
      return;
    }
    // A feed.
    this.anyFeedUndeliverable = true;
    if (this.workerEnded === null) {
      await this.loseWatcher("feed_undeliverable");
    } else if (this.record.watcherOutcome === null) {
      this.record.watcherOutcome =
        cause === "not_running" || cause === "subscriber_unavailable"
          ? "ended_early"
          : "final_undeliverable";
    }
    this.notifyChange();
  }

  // -------------------------------------------------------------------------
  // The feed (§9)

  private offer(item: FeedItem): void {
    this.items.set(item.id, item);
    this.pending.push(item);
  }

  private addFact(event: LifecycleEvent, ref: string | null, detail: string): void {
    // The repetitive facts stop first, so the ones a run has few of -- its
    // end above all -- always have room.
    const room = OVERSIGHT_LIMITS.maxPairFacts - this.record.facts.length;
    if (room <= 0 || (room <= 64 && (event === "gate" || event === "divergence"))) {
      if (!this.factsFull) {
        this.protocolError(
          null,
          null,
          `fact limit reached; ${event} and later facts of its kind not recorded`,
        );
      }
      this.factsFull = true;
      return;
    }
    const fact = lifecycleFact(
      this.record.facts.length + 1,
      isoAt(this.clock.now()),
      event,
      ref,
      detail,
    );
    this.record.facts.push(fact);
    if (this.hasWatcher && !this.feedStopped) this.offer(fact);
  }

  private deliveredFactCount(): number {
    let count = 0;
    for (const id of this.delivered) {
      const item = this.items.get(id);
      if (
        item !== undefined &&
        (item.kind === "tool" ||
          item.kind === "tool_end" ||
          item.kind === "intent" ||
          item.kind === "sensor")
      ) {
        count += 1;
      }
    }
    return count;
  }

  private eventsCoverage(): EventsCoverage {
    if (this.workerStreamBroken) return "incomplete";
    if (this.workerEnded !== null) {
      const assessment = this.host.workerRecordAssessment();
      if (assessment !== undefined) return assessment.complete ? "complete" : "incomplete";
      return this.gaplessTo(this.workerLastSeq) ? "complete" : "incomplete";
    }
    return this.gaplessTo(this.workerLastSeq) ? "gapless_so_far" : "incomplete";
  }

  private gaplessTo(last: number): boolean {
    if (last < 1 || this.workerSeqs.size !== last) return false;
    for (let seq = 1; seq <= last; seq += 1) if (!this.workerSeqs.has(seq)) return false;
    return true;
  }

  /** v1 has no sensor (WP-J). Absent is never clean. */
  private sensorCoverage(): SensorCoverage {
    return "absent";
  }

  private noteCoverage(): void {
    const coverage = { events: this.eventsCoverage(), sensor: this.sensorCoverage() };
    if (
      this.lastCoverage !== null &&
      (this.lastCoverage.events !== coverage.events || this.lastCoverage.sensor !== coverage.sensor)
    ) {
      this.addFact(
        "coverage_changed",
        null,
        lifecycleDetail.coverage_changed(coverage.events, coverage.sensor),
      );
    }
    this.lastCoverage = coverage;
  }

  private feedOutboxIdle(): boolean {
    return this.queues.watcher.length === 0 && !this.draining.watcher;
  }

  /** Send the next regular or question batch if every rule of §9.3 allows it. */
  private async maybeSendFeed(): Promise<void> {
    if (this.record.state !== "watching" || this.feedStopped) return;
    if (this.workerStartedAt === null || this.workerEnded !== null) return;
    if (!this.feedOutboxIdle() || this.pullsOutstanding <= 0) return;
    if (this.record.feed.batches >= OVERSIGHT_LIMITS.maxFeedIds - 1) return;
    this.noteCoverage();
    if (this.pending.length === 0 && this.deferred.length === 0) return;
    const built = this.build(false);
    const carriesQuestion = built.questionIds.length > 0;
    if (!carriesQuestion && this.record.feed.regular >= OVERSIGHT_LIMITS.maxRegularBatches) return;
    if (
      !carriesQuestion &&
      this.lastBatchAt !== null &&
      this.clock.now() - this.lastBatchAt < this.batchIntervalMs
    ) {
      if (!this.timers.has("interval")) {
        this.arm("interval", this.lastBatchAt + this.batchIntervalMs - this.clock.now(), () =>
          this.maybeSendFeed(),
        );
      }
      return;
    }
    await this.commitBatch(built);
  }

  private build(final: boolean): ReturnType<typeof buildFeedBatch> {
    const unanswered = [...this.sentQuestions].filter(
      (questionId) => !this.accepted("advice").some((request) => request.ref === questionId),
    );
    const active = this.record.holds.some((hold) => hold.status === "active");
    return buildFeedBatch({
      batch: this.record.feed.batches + 1,
      final,
      candidates: this.pending.filter((item) => beyondCursor(item.id, this.record.feed.cursor)),
      deferred: this.deferred,
      cursor: this.record.feed.cursor,
      header: {
        state: this.workerEnded !== null ? "ended" : active ? "held" : "running",
        turns: this.workerTurns,
        elapsedMs: Math.max(0, this.clock.now() - (this.workerStartedAt ?? this.clock.now())),
        lastSeq: Math.max(1, this.workerLastSeq),
        terminal: this.workerEnded?.terminal ?? null,
        stoppedBy: this.workerEnded?.stoppedBy ?? null,
      },
      coverage: { events: this.eventsCoverage(), sensor: this.sensorCoverage() },
      openQuestionId: this.openQuestion,
      unansweredBefore: unanswered,
    });
  }

  private async commitBatch(built: ReturnType<typeof buildFeedBatch>): Promise<void> {
    const body = built.body;
    this.record.feed.cursor = built.cursor;
    this.deferred = built.deferred;
    this.record.feed.deferred = built.deferred.map((item) => item.id);
    this.pending = [];
    for (const id of built.unshown) this.unshown.add(id);
    this.record.unshownCount = this.unshown.size;
    for (const questionId of built.questionIds) this.sentQuestions.add(questionId);
    this.record.feed.batches = body.batch;
    if (body.final) this.record.feed.final = body.batch;
    else if (body.reason === "question") this.record.feed.questions += 1;
    else this.record.feed.regular += 1;
    this.lastBatchAt = this.clock.now();
    // Persisted with its digest pinned, then queued (§9.3 send sequence).
    try {
      await this.enqueue(
        "watcher",
        oversightMessage(
          feedMessageId(this.pairId, body.batch),
          "feed",
          body.batch,
          isoAt(this.clock.now()),
          body,
        ),
      );
    } catch (error) {
      // A batch that could not be persisted is never sent, so what it carried
      // was never shown, and a B that claims to have pulled it is wrong.
      for (const id of feedItemIds(body)) this.unshown.add(id);
      this.record.unshownCount = this.unshown.size;
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Losing B (§11.8) and A's end (§11.7 step 1)

  private async loseWatcher(cause: WatcherLostCause): Promise<void> {
    if (this.record.state !== "watching") return;
    this.record.state = "lost";
    this.record.lostCause = cause;
    this.stopFeed();
    for (const hold of this.record.holds) {
      if (hold.status === "active" || hold.status === "pending") {
        this.disarmExpiry(hold.holdId);
        await this.enqueueRelease(hold, "overseer_lost");
      }
    }
    await this.save();
    if (!this.watcherTerminal && this.record.watcherTaskId !== null) {
      this.stopping ??= this.stopTask(this.record.watcherTaskId);
    }
    this.notifyChange();
  }

  /** Nothing more reaches B; whatever was not shown is recorded as unshown. */
  private stopFeed(): void {
    this.feedStopped = true;
    this.disarm("silence");
    this.disarm("interval");
    for (const item of [...this.pending, ...this.deferred]) this.unshown.add(item.id);
    this.pending = [];
    this.deferred = [];
    this.record.feed.deferred = [];
    this.record.unshownCount = this.unshown.size;
  }

  private async workerEndedNow(termination: {
    terminal: WorkerTerminal;
    stoppedBy: WorkerStoppedBy;
  }): Promise<void> {
    if (this.workerEnded !== null) return;
    this.workerEnded = termination;
    const at = isoAt(this.clock.now());
    this.disarm("silence");
    this.disarm("interval");
    for (const hold of this.record.holds) {
      if (hold.status === "active") this.endHold(hold, "worker_ended", at);
    }
    for (const id of [...this.queues.worker]) {
      const record = this.messageById(id);
      if (record === undefined || record.deliveredAt !== null || record.undeliverable !== null) {
        continue;
      }
      record.undeliverable = "worker_ended";
      await this.onUndeliverable(record);
    }
    for (const record of this.record.messages) {
      if (record.to !== "worker" || record.deliveredAt === null || record.shownAt !== null) {
        continue;
      }
      if (record.kind === "caution" || (record.kind === "advice" && record.effect !== "answered")) {
        const ref = bodyRef(record);
        this.addFact("not_shown", ref, lifecycleDetail.not_shown(ref));
      }
    }
    this.addFact(
      "worker_ended",
      null,
      lifecycleDetail.worker_ended(termination.terminal, termination.stoppedBy),
    );
    this.noteCoverage();
    this.notifyChange();
  }

  // -------------------------------------------------------------------------
  // Settling B (§11.7 steps 2-6)

  /**
   * Run once A is terminal: the final batch, the settle window, B's stop, and
   * B's report graded against the facts. Never cancels A, never throws for
   * anything B did; what it could not do is recorded on the pair.
   */
  async settle(workerTask: LingTask): Promise<WatcherStop> {
    await this.locked(async () => {
      if (this.workerEnded === null) {
        await this.workerEndedNow({
          terminal: isTerminalStatus(workerTask.status)
            ? (workerTask.status as WorkerTerminal)
            : "interrupted",
          stoppedBy: (workerTask.stoppedBy ?? "interrupted") as WorkerStoppedBy,
        });
      }
      await this.save();
    });
    // Sensor quiescence (§11.7 step 2) waits for records that cannot arrive
    // before a sensor exists, so there is nothing to wait for yet.
    if (
      this.record.watcherTaskId === null ||
      this.record.state === "absent" ||
      this.record.state === "aborted"
    ) {
      // No watcher ran beside A; one that failed to start was settled then.
      await this.finish(undefined);
      return { task: undefined, termination: undefined };
    }
    let finalBatch: number | null = null;
    await this.locked(async () => {
      if (this.record.state !== "watching") return;
      this.noteCoverage();
      const built = this.build(true);
      finalBatch = built.body.batch;
      await this.commitBatch(built);
    });
    if (finalBatch !== null) {
      const finalId = feedMessageId(this.pairId, finalBatch);
      const finalMessage = () => this.messageById(finalId);
      // Bounded by the outbox's own deadline, for the final batch and the one
      // regular batch that can be ahead of it: delivery always ends by then.
      await this.waitFor(
        () => {
          const message = finalMessage();
          return (
            message !== undefined && (message.deliveredAt !== null || message.undeliverable !== null)
          );
        },
        this.clock.now() + 2 * this.timings.outboxDeadlineMs + this.timings.outboxRetryMs,
      );
      const message = finalMessage();
      if (message?.deliveredAt !== null && message !== undefined) {
        const windowEnds = this.clock.now() + this.timings.outliveMs;
        await this.waitFor(() => this.watcherTerminal, windowEnds);
      }
    }
    let watcherTask: LingTask | undefined;
    let termination: CampaignTaskTermination | undefined;
    const watcherId = this.record.watcherTaskId;
    if (this.stopping !== undefined) {
      ({ task: watcherTask, termination } = await this.stopping);
    }
    if (watcherTask === undefined || !isTerminalStatus(watcherTask.status)) {
      const current = await this.client
        .get(watcherId, this.host.workerIdOf(watcherId))
        .catch(() => undefined);
      if (current !== undefined && isTerminalStatus(current.status)) {
        watcherTask = current;
      } else if (termination === undefined) {
        ({ task: watcherTask, termination } = await this.stopTask(watcherId));
      }
    }
    await this.locked(async () => {
      this.watcherTerminal ||= watcherTask !== undefined && isTerminalStatus(watcherTask.status);
      // Settled once B is known to have stopped: terminal, or killed with the
      // kill confirmed. A loss stays recorded in lostCause either way.
      const stopped = this.watcherTerminal || termination?.completedAt != null;
      if (stopped && (this.record.state === "watching" || this.record.state === "lost")) {
        this.record.state = "settled";
      }
      this.stopFeed();
    });
    await this.finish(watcherTask);
    return { task: watcherTask, termination };
  }

  /** Validate B's report, record coverage and the verdict. */
  private async finish(watcherTask: LingTask | undefined): Promise<void> {
    await this.locked(async () => {
      this.clearTimers();
      let report: WatcherReport | undefined;
      let reportState: "valid" | "missing" | "invalid" = "missing";
      if (this.hasWatcher && this.record.watcherTaskId !== null) {
        const result = watcherTask?.result;
        if (result !== undefined && result !== null) {
          const validation = validateWatcherResult(result, {
            has: (id) => this.delivered.has(id),
            isClaim: (id) => {
              const item = this.items.get(id);
              return item !== undefined && isClaimItem(item);
            },
          });
          reportState = validation.ok ? "valid" : "invalid";
          if (validation.ok) {
            report = validation.envelope.data;
          } else {
            this.protocolError(
              this.record.watcherTaskId,
              null,
              `report invalid: ${validation.problem}`,
            );
          }
          this.record.report = await this.host.storeText(
            `oversight/${this.pairId}/report`,
            validation.ok ? "watcher-report.json" : "watcher-report.invalid.json",
            `${JSON.stringify(result, null, 2)}\n`,
          );
        }
        if (reportState !== "valid") {
          this.record.watcherOutcome ??=
            reportState === "missing" ? "report_missing" : "report_invalid";
        }
      }
      if (this.unshown.size > 0) {
        this.record.unshown = await this.host.storeText(
          `oversight/${this.pairId}/unshown`,
          "unshown.json",
          `${JSON.stringify([...this.unshown].sort())}\n`,
        );
      }
      this.record.unshownCount = this.unshown.size;
      const watcher = watcherCoverage({
        absent: !this.hasWatcher || this.record.watcherTaskId === null,
        settled: this.record.state === "settled",
        lostCause: this.record.lostCause,
        finalPulled: this.finalPulled,
        anyFeedUndeliverable: this.anyFeedUndeliverable,
        report: reportState,
        compacted: this.record.compacted,
      });
      // Only settle comes here, once A has ended.
      const events = this.eventsCoverage();
      const sensor = this.sensorCoverage();
      this.record.coverage = {
        events,
        sensor,
        watcher: watcher.watcher,
        reasons: [...watcher.reasons],
      };
      const verdict = computeOversightVerdict({
        eventsCoverage: events,
        sensorCoverage: sensor,
        watcher,
        findings: this.findings(),
        report,
        delivered: this.delivered,
      });
      this.record.verdict = {
        outcome: verdict.outcome,
        findings: verdict.findings,
        watcherMissed: verdict.watcherMissed,
        watcherCited: verdict.watcherCited,
        unshownToWatcher: verdict.unshownToWatcher,
        watcherOnly: verdict.watcherOnly,
        reasons: [...verdict.reasons, ...this.observedMismatch(report)],
      };
      await this.save();
    });
  }

  /**
   * Where B's own account of what it saw (`observed`) differs from the
   * overlord's, which is the one that counts (§10). Recorded, not corrected.
   */
  private observedMismatch(report: WatcherReport | undefined): string[] {
    if (report === undefined) return [];
    const own = {
      batches: this.record.feed.pulled.length,
      lastBatch: this.record.feed.pulled.length === 0 ? null : Math.max(...this.record.feed.pulled),
      heartbeats: this.record.feed.heartbeats,
      finalReceived: this.finalPulled,
    };
    return (Object.keys(own) as (keyof typeof own)[])
      .filter((key) => report.observed[key] !== own[key])
      .map(
        (key) =>
          `The watcher reported observed.${key} ${JSON.stringify(report.observed[key])}; its stream shows ${JSON.stringify(own[key])}.`,
      );
  }

  /** The intent findings A's recorded stream supports, each with the event it rests on. */
  private findings(): DeterministicFinding[] {
    if (!this.host.workerDeclaresIntent()) return [];
    const tracker = createIntentTracker();
    const findings: DeterministicFinding[] = [];
    const events = [...this.host.workerRecordEvents()].sort((left, right) => left.seq - right.seq);
    for (const event of events) {
      const divergence = tracker.observe(event);
      if (divergence !== undefined) {
        findings.push({
          axis: "intent",
          kind: divergence.kind,
          value: divergence.value,
          evidence: [`a:${event.seq}`],
        });
      }
    }
    return findings;
  }

  // -------------------------------------------------------------------------
  // Plumbing

  private messageById(id: string): PairMessageRecord | undefined {
    return this.record.messages.find((candidate) => candidate.id === id);
  }

  private taskIdOf(destination: Destination): string | null {
    return destination === "worker" ? this.record.workerTaskId : this.record.watcherTaskId;
  }

  /**
   * The message a side's acknowledgement names, if it was sent to that side,
   * and is of `kind` when one is given. Anything else is a protocol error on
   * the acknowledging task.
   */
  private acknowledged(
    to: Destination,
    seq: number,
    what: "shown" | "delivered",
    id: string,
    kind?: PairMessageRecord["kind"],
  ): PairMessageRecord | undefined {
    const message = this.messageById(id);
    if (message === undefined || message.to !== to || (kind !== undefined && message.kind !== kind)) {
      this.protocolError(this.taskIdOf(to), seq, `${what} for unknown message ${id}`);
      return undefined;
    }
    return message;
  }

  private refusedFact(event: RefusalFact, ref: string, code: string): void {
    this.addFact(event, ref, lifecycleDetail[event](ref, code));
  }

  private protocolError(taskId: string | null, seq: number | null, reason: string): void {
    this.record.protocolErrorCount += 1;
    if (this.record.protocolErrors.length < 64) {
      this.record.protocolErrors.push(
        `${taskId ?? "-"}:${seq ?? "-"} ${reason}`.slice(0, OVERSIGHT_LIMITS.detailChars),
      );
    }
  }

  /** Persist the record, unless it is exactly what was last persisted. */
  private async save(): Promise<void> {
    const snapshot = JSON.stringify(this.record);
    if (snapshot === this.lastSaved) return;
    await this.host.save(this.record);
    this.lastSaved = snapshot;
  }

  private lastSaved: string | undefined;
  private factsFull = false;

  /** Run one state change at a time. A failure is recorded, not propagated into the next. */
  private locked<T>(run: () => Promise<T>): Promise<T> {
    const result = this.tail.then(run);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private settleReady(ready: boolean): void {
    if (this.readyOutcome !== undefined) return;
    this.readyOutcome = ready;
    this.disarm("readiness");
    for (const waiter of this.readyWaiters.splice(0)) waiter(ready);
  }

  private armReadiness(ms: number): void {
    this.arm("readiness", ms, async () => {
      if (this.record.state === "starting" && this.record.readyAt === null) this.settleReady(false);
    });
  }

  /** Run a callback under the lock after a delay, replacing any timer of that name. */
  private arm(name: string, ms: number, callback: () => Promise<void> | void): void {
    this.disarm(name);
    const handle = this.clock.setTimeout(
      () => {
        if (this.timers.get(name) === handle) this.timers.delete(name);
        void this.locked(async () => {
          await callback();
          await this.save();
        }).catch(() => undefined);
      },
      Math.max(0, ms),
    );
    this.timers.set(name, handle);
  }

  private disarm(name: string): void {
    const handle = this.timers.get(name);
    if (handle === undefined) return;
    this.clock.clearTimeout(handle);
    this.timers.delete(name);
  }

  private disarmExpiry(holdId: string): void {
    this.disarm(`expiry:${holdId}`);
  }

  private clearTimers(): void {
    for (const handle of this.timers.values()) this.clock.clearTimeout(handle);
    this.timers.clear();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.clock.setTimeout(resolve, ms);
    });
  }

  private notifyChange(): void {
    for (const waiter of this.changeWaiters.splice(0)) waiter();
  }

  /**
   * Wait until a condition holds, re-checking on every state change and at
   * least every poll interval, or until a deadline on the pair's clock.
   */
  private async waitFor(condition: () => boolean, deadline: number): Promise<void> {
    while (!condition()) {
      if (this.clock.now() >= deadline) return;
      const wait = Math.min(this.timings.pollMs, Math.max(0, deadline - this.clock.now()));
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          this.clock.clearTimeout(handle);
          resolve();
        };
        const handle = this.clock.setTimeout(finish, wait);
        this.changeWaiters.push(finish);
      });
    }
  }
}
