/**
 * A watcher B played by a script instead of a model.
 *
 * It stands in for B's ling at the wire: it accepts feed POSTs with the same
 * idempotency and refusals, returns batches through a `watch_next` loop, emits
 * the events a real watcher's stream carries (`watch_next` starts and ends,
 * `oversight_watch_returned`, `oversight_delivered`, and each request event),
 * keeps the delivered set and refuses what the ling refuses, and writes a
 * WatcherReport at the end. The overlord cannot tell it from a ling, which is
 * the point.
 *
 * Two uses. The checks drive whole pairs with it at no cost. And the
 * experiments use it where the timing of an intervention must be controlled
 * rather than left to when a model happens to act (E3), and as the condition
 * in which the delegate errs (E6): a script can advise against the task, cry
 * wolf, or miss what the facts show, and the pair's verdict grades that
 * against the facts like any other B.
 *
 * `withScriptedWatcher` wraps a campaign client so that a campaign's watcher
 * spawns land here while every other task goes to the real client.
 */
import { LingClientError } from "../ling/client.js";
import { isTerminalEvent, isTerminalStatus } from "../ling/events.js";
import type {
  LingEvent,
  LingHealth,
  LingTask,
  LingTaskStatus,
  SpawnInput,
  SpawnResponse,
} from "../ling/types.js";
import type { CampaignLingClient } from "./driver.js";
import {
  EVIDENCE_ID_PATTERN,
  OVERSIGHT_CAPABILITY_VERSION,
  OVERSIGHT_LIMITS,
  feedItemIds,
  watcherTools,
  type ConcernCode,
  type ConcernSeverity,
  type FeedBody,
  type OversightMessage,
  type WatchCondition,
} from "./oversight.js";

export type ScriptedAction =
  | { type: "advise"; questionId: string; content: string }
  | { type: "caution"; content: string; evidence: string[] }
  | { type: "hold"; reason: string; evidence: string[] }
  | { type: "release"; holdId: string }
  | {
      type: "concern";
      code: ConcernCode;
      severity: ConcernSeverity;
      content: string;
      evidence: string[];
    }
  /** Stop watching and end the task, as a model that ends its turn would. */
  | { type: "end" };

export interface ScriptContext {
  batch: FeedBody;
}

export type WatcherScript = (context: ScriptContext) => readonly ScriptedAction[];

export interface ScriptedWatcherSeen {
  batches: number;
  lastBatch: number | null;
  finalReceived: boolean;
  concerns: { code: ConcernCode; severity: ConcernSeverity; content: string; evidence: string[] }[];
}

export interface ScriptedWatcherOptions {
  taskId: string;
  requestKey?: string;
  workerId?: string;
  condition?: WatchCondition;
  script?: WatcherScript;
  /** How this watcher fails to start, if it does: never_watch starts but never calls watch_next. */
  start?: "normal" | "never_watch";
  /** Ignore cancel, as a wedged worker would. Only terminate stops it then. */
  ignoreCancel?: boolean;
}

/** What a scripted watcher writes when it ends: an honest account of what it was shown and said. */
export function scriptedReport(seen: ScriptedWatcherSeen): unknown {
  return {
    status: seen.finalReceived ? "success" : "partial",
    summary: "Scripted watcher report.",
    data: {
      version: 1,
      summary: `Watched ${seen.batches} batch(es) and raised ${seen.concerns.length} concern(s).`,
      observed: {
        batches: seen.batches,
        lastBatch: seen.lastBatch,
        // Its watch_next has no idle timer, so it never heartbeats.
        heartbeats: 0,
        finalReceived: seen.finalReceived,
      },
      concerns: seen.concerns.map((concern) => ({
        code: concern.code,
        severity: concern.severity,
        refs: concern.evidence,
        note: concern.content,
      })),
      statements: [],
      unobserved: [],
    },
    steps: [],
  };
}

export class ScriptedWatcher {
  readonly taskId: string;
  readonly requestKey: string | undefined;
  readonly workerId: string;
  readonly createdAt = new Date().toISOString();
  status: LingTaskStatus = "running";
  result: unknown;
  /** Every feed POST, accepted or not, for checks. */
  readonly received: OversightMessage[] = [];
  private readonly condition: WatchCondition;
  private readonly script: WatcherScript;
  private readonly start: "normal" | "never_watch";
  private readonly ignoreCancel: boolean;
  private readonly events: LingEvent[] = [];
  private readonly payloads = new Map<string, string>();
  private readonly buffered = new Map<number, FeedBody>();
  private readonly delivered = new Set<string>();
  private readonly deliveredQuestions = new Set<string>();
  private readonly appliedHolds = new Set<string>();
  private readonly endedHolds = new Set<string>();
  private readonly answered = new Set<string>();
  private readonly concerns: ScriptedWatcherSeen["concerns"] = [];
  private readonly counters = { caution: 0, hold: 0, release: 0, concern: 0 };
  private batches = 0;
  private lastBatch: number | null = null;
  private finalReturned = false;
  private highestReturned = 0;
  private cancelled = false;
  private wake: (() => void) | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(options: ScriptedWatcherOptions) {
    this.taskId = options.taskId;
    this.requestKey = options.requestKey;
    this.workerId = options.workerId ?? "scripted-watcher";
    this.condition = options.condition ?? "channel";
    this.script = options.script ?? (() => []);
    this.start = options.start ?? "normal";
    this.ignoreCancel = options.ignoreCancel === true;
    void this.run();
  }

  /** `POST /tasks/:id/oversight`, as a watcher's ling answers it (§4.2). */
  receive(message: OversightMessage): { accepted: true; duplicate: boolean; kind: "feed" } {
    this.received.push(message);
    if (this.status !== "running") throw refusal(409, "not_running", "task is not running");
    if (message.kind !== "feed" || message.from !== "overlord") {
      throw refusal(400, "kind_not_accepted", "kind not accepted");
    }
    const payload = JSON.stringify(message);
    const prior = this.payloads.get(message.id);
    if (prior !== undefined) {
      if (prior !== payload) throw refusal(409, "id_conflict", "id conflict");
      this.wake?.();
      return { accepted: true, duplicate: true, kind: "feed" };
    }
    if (this.payloads.size >= OVERSIGHT_LIMITS.maxFeedIds) {
      throw refusal(409, "inbox_full", "inbox full");
    }
    this.payloads.set(message.id, payload);
    const body = message.body as FeedBody;
    const effect = this.finalReturned
      ? "after_final"
      : body.batch < this.highestReturned
        ? "out_of_order"
        : "buffered";
    if (effect !== "after_final") this.buffered.set(body.batch, body);
    this.emit("oversight_delivered", { messageId: message.id, kind: "feed", effect });
    this.wake?.();
    return { accepted: true, duplicate: false, kind: "feed" };
  }

  cancel(): void {
    if (this.status !== "running" || this.ignoreCancel) return;
    this.cancelled = true;
    this.wake?.();
  }

  /** What a hard kill does: the task ends now, with no terminal event. */
  kill(): void {
    if (this.status !== "running") return;
    this.status = "interrupted";
    this.cancelled = true;
    this.wake?.();
    this.notify();
  }

  task(): LingTask {
    return {
      id: this.taskId,
      ...(this.requestKey === undefined ? {} : { requestKey: this.requestKey }),
      workerId: this.workerId,
      status: this.status,
      prompt: "scripted watcher",
      options: { tools: watcherTools(this.condition) },
      createdAt: this.createdAt,
      workspaceDir: "",
      seededFiles: [],
      ...(this.result === undefined ? {} : { result: this.result }),
      stats: {
        turns: this.batches,
        cost: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
  }

  /** The SSE stream: everything so far, then live events, ending at the terminal one. */
  async *stream(
    options: { signal?: AbortSignal; sinceSeq?: number } = {},
  ): AsyncIterable<LingEvent> {
    let index = 0;
    while (!options.signal?.aborted) {
      while (index < this.events.length) {
        const event = this.events[index]!;
        index += 1;
        if (event.seq <= (options.sinceSeq ?? 0)) continue;
        yield event;
        if (isTerminalEvent(event)) return;
      }
      // Killed: the stream just stops, with no terminal event, as a dead
      // worker's would.
      if (this.status !== "running") return;
      await new Promise<void>((resolve) => {
        const listener = () => {
          this.listeners.delete(listener);
          options.signal?.removeEventListener("abort", listener);
          resolve();
        };
        this.listeners.add(listener);
        options.signal?.addEventListener("abort", listener, { once: true });
      });
    }
  }

  private emit(type: string, data?: unknown): void {
    this.events.push({
      seq: this.events.length + 1,
      at: new Date().toISOString(),
      type,
      ...(data === undefined ? {} : { data }),
    });
    this.notify();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private async run(): Promise<void> {
    this.emit("task_started");
    if (this.start === "never_watch") {
      await this.waitForWake();
      return this.finish("cancelled");
    }
    while (!this.cancelled) {
      this.emit("tool_start", { tool: "watch_next", args: {} });
      const started = Date.now();
      const body = await this.nextBatch();
      const waitedMs = Date.now() - started;
      const returned = (result: "batch" | "aborted", batch: number | null, error: boolean) => {
        this.emit("oversight_watch_returned", {
          result,
          batch,
          waitedMs,
          buffered: this.buffered.size,
        });
        this.emit("tool_end", { tool: "watch_next", error });
      };
      if (body === undefined) {
        returned("aborted", null, true);
        break;
      }
      this.buffered.delete(body.batch);
      this.batches += 1;
      this.lastBatch = body.batch;
      this.highestReturned = Math.max(this.highestReturned, body.batch);
      for (const id of feedItemIds(body)) this.delivered.add(id);
      for (const claim of body.claims) {
        if (claim.kind === "question") this.deliveredQuestions.add(claim.questionId);
      }
      for (const fact of body.facts) {
        if (fact.kind !== "lifecycle" || fact.ref === null) continue;
        if (fact.event === "hold_applied") this.appliedHolds.add(fact.ref);
        if (fact.event === "hold_ended") this.endedHolds.add(fact.ref);
      }
      if (body.final) this.finalReturned = true;
      returned("batch", body.batch, false);
      let ended = false;
      for (const action of this.script({ batch: body })) {
        if (action.type === "end") {
          ended = true;
          break;
        }
        this.act(action);
      }
      if (ended || body.final) break;
    }
    this.finish(this.cancelled ? "cancelled" : "completed");
  }

  private finish(how: "completed" | "cancelled"): void {
    if (this.status !== "running") return;
    this.result = scriptedReport({
      batches: this.batches,
      lastBatch: this.lastBatch,
      finalReceived: this.finalReturned,
      concerns: this.concerns,
    });
    this.status = how;
    this.emit("task_finished", {
      status: how,
      stoppedBy: how === "cancelled" ? "cancelled" : "finished",
    });
  }

  /** One tool call, refused where the ling would refuse it (§6.4-§6.8). */
  private act(action: Exclude<ScriptedAction, { type: "end" }>): void {
    const tool = (
      {
        advise: "advise",
        caution: "caution",
        hold: "hold",
        release: "release",
        concern: "report_concern",
      } as const
    )[action.type];
    if (!watcherTools(this.condition).includes(tool)) return;
    this.emit("tool_start", { tool, args: action });
    const ok = (type: string, data: unknown) => {
      this.emit(type, data);
      this.emit("tool_end", { tool, error: false });
    };
    const refuse = () => this.emit("tool_end", { tool, error: true });
    const evidence = "evidence" in action ? action.evidence : [];
    if (evidence.some((id) => !EVIDENCE_ID_PATTERN.test(id) || !this.delivered.has(id))) {
      return refuse();
    }
    switch (action.type) {
      case "advise":
        if (this.finalReturned || !this.deliveredQuestions.has(action.questionId)) return refuse();
        if (this.answered.has(action.questionId)) return refuse();
        this.answered.add(action.questionId);
        return ok("oversight_advice", { questionId: action.questionId, content: action.content });
      case "caution":
        if (this.counters.caution >= OVERSIGHT_LIMITS.maxCautions || this.finalReturned) {
          return refuse();
        }
        this.counters.caution += 1;
        return ok("oversight_caution", {
          cautionId: `c${this.counters.caution}`,
          content: action.content,
          evidence: action.evidence,
        });
      case "hold":
        if (this.counters.hold >= 4 || this.finalReturned) return refuse();
        this.counters.hold += 1;
        return ok("oversight_hold_request", {
          requestId: `h${this.counters.hold}`,
          reason: action.reason,
          evidence: action.evidence,
        });
      case "release":
        if (
          this.counters.release >= 4 ||
          this.finalReturned ||
          !this.appliedHolds.has(action.holdId) ||
          this.endedHolds.has(action.holdId)
        ) {
          return refuse();
        }
        this.counters.release += 1;
        return ok("oversight_release_request", { holdId: action.holdId });
      case "concern":
        if (this.counters.concern >= OVERSIGHT_LIMITS.maxConcerns) return refuse();
        if (action.evidence.length === 0 && action.code !== "coverage_gap") return refuse();
        this.counters.concern += 1;
        this.concerns.push({
          code: action.code,
          severity: action.severity,
          content: action.content,
          evidence: action.evidence,
        });
        return ok("oversight_concern", {
          concernId: `r${this.counters.concern}`,
          code: action.code,
          severity: action.severity,
          content: action.content,
          evidence: action.evidence,
        });
    }
  }

  /** The lowest buffered batch, waiting for one if none is; undefined once cancelled. */
  private async nextBatch(): Promise<FeedBody | undefined> {
    while (!this.cancelled) {
      const lowest = [...this.buffered.keys()].sort((left, right) => left - right)[0];
      if (lowest !== undefined) return this.buffered.get(lowest);
      await this.waitForWake();
    }
    return undefined;
  }

  private waitForWake(): Promise<void> {
    return new Promise((resolve) => {
      this.wake = () => {
        this.wake = undefined;
        resolve();
      };
    });
  }
}

/** A refusal as the ling's client reports it: the status, and the body's code. */
function refusal(status: number, code: string, text: string): LingClientError {
  return new LingClientError(`Ling returned ${status}: ${text}`, status, false, undefined, code);
}

const WATCHER_KEY = /^campaign:[A-Za-z0-9_-]*:watcher:/;

/**
 * A campaign client whose watcher spawns are served by scripted watchers and
 * whose every other task goes to `inner`. The scripted watcher advertises the
 * oversight capability on its own worker id, so the pair's capability check
 * passes for it exactly as it would for a ling. It has terminate() and
 * release() only where `inner` does, so it is refused what `inner` is.
 */
export function withScriptedWatcher(
  inner: CampaignLingClient,
  options: (
    input: SpawnInput,
  ) => Omit<ScriptedWatcherOptions, "taskId" | "requestKey" | "workerId">,
): CampaignLingClient & { watchers: ScriptedWatcher[] } {
  const watchers: ScriptedWatcher[] = [];
  const byId = (id: string) => watchers.find((watcher) => watcher.taskId === id);
  const capability: LingHealth = {
    ok: true,
    queued: 0,
    capabilities: {
      oversight: {
        version: OVERSIGHT_CAPABILITY_VERSION,
        adviceWaitMs: 120_000,
        watchIdleMs: 60_000,
        maxHoldMs: OVERSIGHT_LIMITS.maxHoldMs,
      },
    },
  };
  const client: CampaignLingClient & { watchers: ScriptedWatcher[] } = {
    watchers,
    async spawn(input: SpawnInput, preferredWorkerId?: string): Promise<SpawnResponse> {
      if (input.requestKey === undefined || !WATCHER_KEY.test(input.requestKey)) {
        return inner.spawn(input, preferredWorkerId);
      }
      const existing = watchers.find((watcher) => watcher.requestKey === input.requestKey);
      const watcher =
        existing ??
        new ScriptedWatcher({
          ...options(input),
          taskId: `scripted-watcher-${watchers.length + 1}`,
          requestKey: input.requestKey,
          workerId: `scripted-watcher-${watchers.length + 1}`,
        });
      if (existing === undefined) watchers.push(watcher);
      return {
        id: watcher.taskId,
        requestKey: input.requestKey,
        workerId: watcher.workerId,
        status: watcher.status,
        options: { ...(input.tools === undefined ? {} : { tools: input.tools }) },
        seededFiles: [],
      };
    },
    async get(id, workerId) {
      return byId(id)?.task() ?? inner.get(id, workerId);
    },
    async list() {
      return [...(await inner.list()), ...watchers.map((watcher) => watcher.task())];
    },
    async cancel(id, workerId) {
      const watcher = byId(id);
      if (watcher === undefined) return inner.cancel(id, workerId);
      watcher.cancel();
    },
    events(id, workerId, eventOptions) {
      const watcher = byId(id);
      if (watcher !== undefined) return watcher.stream(eventOptions);
      if (inner.events === undefined) throw new Error("The inner client has no events().");
      return inner.events(id, workerId, eventOptions);
    },
    async sendOversight(id, message, workerId) {
      const watcher = byId(id);
      if (watcher !== undefined) return watcher.receive(message);
      if (inner.sendOversight === undefined) {
        throw new LingClientError("The inner client has no oversight route.", undefined, false);
      }
      return inner.sendOversight(id, message, workerId);
    },
    async health() {
      const health = (await inner.health?.()) ?? {};
      return {
        ...health,
        ...Object.fromEntries(watchers.map((watcher) => [watcher.workerId, capability])),
      };
    },
    async history(task) {
      return byId(task.id) === undefined && inner.history !== undefined ? inner.history(task) : [];
    },
    async collectComplete(id, workerId) {
      if (byId(id) === undefined) await inner.collectComplete?.(id, workerId);
    },
    async fetchLog(id, workerId) {
      const watcher = byId(id);
      if (watcher !== undefined) {
        const events: LingEvent[] = [];
        if (!isTerminalStatus(watcher.status)) return [];
        for await (const event of watcher.stream()) events.push(event);
        return events;
      }
      return inner.fetchLog === undefined ? [] : inner.fetchLog(id, workerId);
    },
  };
  // Only what `inner` has. The driver reads a lease from a client's having
  // terminate() and release() (LEASE_ONLY_VARIANTS, and the watched-builder
  // gate), so the wrapper adding them would take a static fleet past the
  // gates that refuse it.
  if (inner.terminate !== undefined) {
    client.terminate = async (id, reason, workerId) => {
      const watcher = byId(id);
      if (watcher === undefined) return inner.terminate!(id, reason, workerId);
      watcher.kill();
      const at = new Date().toISOString();
      return { reason, requestedAt: at, completedAt: at, errors: [] };
    };
  }
  if (inner.release !== undefined) {
    client.release = async (id, workerId) => {
      if (byId(id) === undefined) await inner.release!(id, workerId);
    };
  }
  return client;
}
