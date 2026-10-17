/**
 * The pair runtime's last rungs, against fake clients: offline, no process,
 * no model, a minute at most.
 *
 * - A worker A that will not stop is given up on at its own deadline,
 *   cancelled, and killed once the cancel goes unconfirmed past
 *   cancelGraceMs; one whose worker stops answering is killed as
 *   unreachable. Either kill is written down before it is applied, and
 *   recorded on the task with its reason. A watched A's deadline is its own
 *   wall clock plus the hold credit its ling may have granted plus a grace,
 *   so here a wedged A is found in under a second, not twice its longest
 *   possible run later. On a client that can kill, any task the driver gives
 *   up on, still runs once the campaign has stopped, or finds running in a
 *   capped campaign is killed the same way.
 * - After an overlord restart a provisioned client holds no lease for the
 *   workers an earlier process summoned. It says so with its own code, which
 *   reconcile reads as a task not found, so a watched attempt left running
 *   takes the orphan path and a resume abandons it, charging each member its
 *   ceiling; a released worker, and a task known to be on another worker
 *   than its record names, still stop reconcile.
 *
 * pair-e2e-check runs the wedged A with real ling processes.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CampaignArtifactStore } from "../campaign/artifacts.js";
import { CampaignDriver, type CampaignLingClient } from "../campaign/driver.js";
import { assessEventSequence } from "../campaign/event-record.js";
import { initializeCampaign } from "../campaign/initialize.js";
import { CampaignManifestStore } from "../campaign/manifest.js";
import {
  OVERSIGHT_LIMITS,
  pairIdFor,
  type OversightMessage,
  type OversightTimings,
} from "../campaign/oversight.js";
import {
  OversightPair,
  classifyDeliveryError,
  newPairRecord,
  type OversightClient,
  type OversightClock,
  type PairHost,
} from "../campaign/oversight-coordinator.js";
import { withScriptedWatcher, type WatcherScript } from "../campaign/oversight-scripted.js";
import { campaignRequestKey } from "../campaign/request-key.js";
import type { ArtifactRef, CampaignManifest, CampaignTaskRecord } from "../campaign/schema.js";
import { LingClientError, type LingEventOptions } from "../ling/client.js";
import {
  LingProvisionerError,
  ProvisionedLingClient,
  resolvedWorkerProfileFromSpawnInput,
  type LingProvisionRequest,
  type LingProvisioner,
  type ProvisionedLeaseTermination,
  type ProvisionedWorkerClient,
  type ProvisionedWorkerLease,
} from "../ling/provisioner.js";
import type {
  LingArtifactList,
  LingEvent,
  LingHealth,
  LingOversightMessage,
  LingOversightResponse,
  LingPeerMessageResponse,
  LingTask,
  LingTaskStatus,
  SpawnInput,
  SpawnResponse,
} from "../ling/types.js";
import { DEFAULT_ALLOWED_TOOLS, type SpawnPolicy } from "../policy.js";

let failures = 0;

async function check(label: string, run: () => void | Promise<void>): Promise<void> {
  try {
    await run();
    console.log(`PASS  ${label}`);
  } catch (error) {
    failures += 1;
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(`FAIL  ${label} -- ${detail}`);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function settle(): Promise<void> {
  for (let index = 0; index < 40; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const ORPHAN_GAP = "Overlord could not reconcile this in-flight task after Ling restarted.";

const unanswered = () =>
  new LingClientError("Ling request failed at the transport boundary.", undefined, true);

const POLICY: SpawnPolicy = {
  allowedTools: DEFAULT_ALLOWED_TOOLS,
  maxCostUsdPerTask: 2,
  maxTurnsPerTask: 40,
  maxWallClockMsPerTask: 900_000,
  maxTasksPerRun: 20,
  maxConcurrentTasks: 2,
  maxTotalCostUsd: 10,
};

const TIMINGS: Partial<OversightTimings> = {
  readyMs: 2_000,
  outliveMs: 1_500,
  cancelGraceMs: 200,
  pollMs: 5,
  outboxRetryMs: 10,
  outboxDeadlineMs: 200,
  watchSilenceMs: 30_000,
  minBatchIntervalMs: 1,
};

const OVERSIGHT_HEALTH: LingHealth = {
  ok: true,
  queued: 0,
  capabilities: {
    oversight: { version: 1, adviceWaitMs: 120000, watchIdleMs: 60000, maxHoldMs: 300000 },
  },
};

const BUILDER_COST_USD = 0.75;

/** One slice, watched or not; or, unwatched, two slices built side by side. */
function definition(id: string, builderWallClockMs: number, watched: boolean, parallel = false) {
  const role = (tools: string[], maxWallClockMs = 300_000) => ({
    tools,
    maxCostUsd: 0.5,
    maxTurns: 16,
    maxWallClockMs,
  });
  return {
    id,
    goal: "Produce output.",
    acceptance: [{ id: "output", kind: "file", requirement: "output.txt says good" }],
    budget: { maxTasks: 8, maxTotalCostUsd: 10 },
    maxRounds: 1,
    slices: parallel
      ? [
          { id: "01", spec: "Write output.txt.", dependsOn: [] },
          { id: "02", spec: "Write output.txt.", dependsOn: [] },
        ]
      : [{ id: "01", spec: "Write output.txt." }],
    roles: {
      planner: role(["read", "write"]),
      builder: {
        tools: ["read", "write"],
        maxCostUsd: BUILDER_COST_USD,
        maxTurns: 24,
        maxWallClockMs: builderWallClockMs,
        provider: "anthropic",
        model: "claude-fixture",
      },
      reviewer: role(["read", "ls", "write_result"]),
      integration: role(["read", "ls", "write_result"]),
    },
    ...(watched
      ? {
          coordination: {
            enabled: true,
            watch: { condition: "channel", watcher: { provider: "openai", model: "gpt-fixture" } },
          },
        }
      : parallel
        ? { coordination: { enabled: true, parallelSlices: true } }
        : {}),
  };
}

function reviewResult(kind: "review" | "integration") {
  return {
    status: "success",
    summary: `${kind} accept.`,
    data: {
      kind,
      verdict: "accept",
      checks: [{ criterion: "output", passed: true, evidence: "good" }],
      evidence: ["verified output"],
      gaps: [],
      barFetch: null,
    },
    steps: ["checked output"],
  };
}

// ---------------------------------------------------------------------------
// A fake ling for every task but B, which the scripted watcher plays.

class FakeTask {
  readonly events: LingEvent[] = [];
  status: LingTaskStatus = "running";
  result: unknown;
  /** A wedged worker: its cancel is accepted and changes nothing. */
  ignoreCancel = false;
  /** While set, every read and cancel of this task fails with what it returns. */
  failure: (() => Error) | undefined;
  killed = false;
  private readonly listeners = new Set<() => void>();

  constructor(
    readonly id: string,
    readonly input: SpawnInput,
    readonly workspaceDir: string,
  ) {}

  emit(type: string, data?: unknown): void {
    this.events.push({
      seq: this.events.length + 1,
      at: new Date().toISOString(),
      type,
      ...(data === undefined ? {} : { data }),
    });
    this.notify();
  }

  /** Write the deliverable and end, as a builder that did its work. */
  async complete(): Promise<void> {
    await mkdir(this.workspaceDir, { recursive: true });
    await writeFile(path.join(this.workspaceDir, "output.txt"), "good", "utf8");
    if (this.status !== "running") return;
    this.result = {
      status: "success",
      summary: "Built output.",
      data: { kind: "build", artifacts: [{ path: "output.txt" }] },
      steps: ["wrote output"],
    };
    this.status = "completed";
    this.emit("task_finished", { status: "completed", stoppedBy: "finished" });
  }

  cancel(): void {
    if (this.status !== "running" || this.ignoreCancel) return;
    this.status = "cancelled";
    this.emit("task_finished", { status: "cancelled", stoppedBy: "cancelled" });
  }

  /**
   * A hard kill: the task ends with no terminal event of its own, and reads
   * as a provisioned client reads a killed task, interrupted at its ceiling.
   */
  kill(): void {
    this.killed = true;
    if (this.status === "running") this.status = "interrupted";
    this.notify();
  }

  snapshot(): LingTask {
    return {
      id: this.id,
      ...(this.input.requestKey === undefined ? {} : { requestKey: this.input.requestKey }),
      workerId: "local",
      status: this.status,
      prompt: this.input.task,
      options: { ...(this.input.tools === undefined ? {} : { tools: this.input.tools }) },
      createdAt: new Date().toISOString(),
      workspaceDir: this.workspaceDir,
      seededFiles: Object.keys(this.input.files ?? {}),
      ...(this.result === undefined ? {} : { result: this.result }),
      stats: {
        turns: 1,
        cost: this.killed ? (this.input.maxCostUsd ?? 0) : 0.01,
        tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
      },
    };
  }

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
        if (event.type === "task_finished") return;
      }
      // Killed: the stream stops with no terminal event, as a dead worker's does.
      if (this.killed) return;
      await new Promise<void>((resolve) => {
        const done = () => {
          this.listeners.delete(done);
          resolve();
        };
        this.listeners.add(done);
        options.signal?.addEventListener("abort", done, { once: true });
      });
    }
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

type BuilderScript = (task: FakeTask) => void | Promise<void>;

class FakeLing implements CampaignLingClient {
  readonly tasks = new Map<string, FakeTask>();
  readonly cancels: { id: string; at: number }[] = [];
  readonly kills: [string, string][] = [];
  readonly oversight: { taskId: string; message: OversightMessage }[] = [];
  /** While set, terminate() fails, as a kill that cannot be confirmed. */
  killFails = false;
  /** What the campaign's persisted record said of each kill as it was applied. */
  readonly recordedAtKill: CampaignTaskRecord["terminated"][] = [];
  recorded: (id: string) => CampaignTaskRecord["terminated"] = () => undefined;

  constructor(
    private readonly workspacesDir: string,
    private readonly builder: BuilderScript,
  ) {}

  builderTask(): FakeTask | undefined {
    return [...this.tasks.values()].find((task) => /:builder:/.test(task.input.requestKey ?? ""));
  }

  async spawn(input: SpawnInput): Promise<SpawnResponse> {
    const role = input.requestKey?.match(/:(planner|builder|reviewer|integration):/)?.[1];
    const id = `task-${String(this.tasks.size + 1).padStart(2, "0")}`;
    const task = new FakeTask(id, input, path.join(this.workspacesDir, id));
    this.tasks.set(id, task);
    if (role === "builder") {
      void this.builder(task);
    } else {
      task.result = reviewResult(role === "integration" ? "integration" : "review");
      task.status = "completed";
    }
    return {
      id,
      ...(input.requestKey === undefined ? {} : { requestKey: input.requestKey }),
      workerId: "local",
      status: task.status,
      options: { ...(input.tools === undefined ? {} : { tools: input.tools }) },
      seededFiles: Object.keys(input.files ?? {}),
    };
  }

  private known(id: string): FakeTask {
    const task = this.tasks.get(id);
    if (task === undefined) {
      throw new LingClientError("Ling returned 404: no such task", 404, false);
    }
    return task;
  }

  async get(id: string): Promise<LingTask> {
    const task = this.known(id);
    if (task.failure !== undefined) throw task.failure();
    return task.snapshot();
  }

  async list(): Promise<LingTask[]> {
    return [...this.tasks.values()]
      .filter((task) => task.failure === undefined)
      .map((task) => task.snapshot());
  }

  async cancel(id: string): Promise<void> {
    const task = this.known(id);
    this.cancels.push({ id, at: Date.now() });
    if (task.failure !== undefined) throw task.failure();
    task.cancel();
  }

  events(id: string, _workerId?: string, options?: LingEventOptions): AsyncIterable<LingEvent> {
    return this.known(id).stream(options);
  }

  async sendOversight(
    id: string,
    message: OversightMessage,
  ): Promise<{ accepted: true; duplicate: boolean }> {
    const duplicate = this.oversight.some(
      (entry) => entry.taskId === id && entry.message.id === message.id,
    );
    if (!duplicate) this.oversight.push({ taskId: id, message: structuredClone(message) });
    return { accepted: true, duplicate };
  }

  async health(): Promise<Record<string, LingHealth>> {
    return { local: OVERSIGHT_HEALTH };
  }

  async terminate(
    id: string,
    reason: string,
  ): Promise<{ reason: string; requestedAt: string; completedAt?: string; errors: string[] }> {
    this.kills.push([id, reason]);
    this.recordedAtKill.push(this.recorded(id));
    if (this.killFails) throw new Error("kill failed");
    this.known(id).kill();
    const at = new Date().toISOString();
    return { reason, requestedAt: at, completedAt: at, errors: [] };
  }
}

/** A builder that starts and never ends, its cancel accepted and ignored. */
const WEDGED: BuilderScript = (task) => {
  task.ignoreCancel = true;
  task.emit("task_started");
};

/** A builder that works for `ms` in steps the watcher is shown, then completes. */
const workFor =
  (ms: number): BuilderScript =>
  async (task) => {
    task.emit("task_started");
    const ends = Date.now() + ms;
    while (Date.now() < ends && task.status === "running") {
      task.emit("tool_start", { tool: "read", args: { path: "SPEC.md" } });
      await sleep(200);
      task.emit("tool_end", { tool: "read", error: false });
    }
    await task.complete();
  };

let tmpRoot = "";

async function runCampaign(
  name: string,
  options: {
    builder: BuilderScript;
    builderWallClockMs: number;
    settleGraceMs: number;
    unreachableMs?: number;
    watched?: boolean;
    /** Unwatched, two slices at once. */
    parallel?: boolean;
    watcher?: WatcherScript;
    killFails?: boolean;
  },
) {
  const root = path.join(tmpRoot, name);
  const workspaces = path.join(root, "workspaces");
  const store = new CampaignManifestStore(path.join(root, "manifest.json"));
  const artifacts = new CampaignArtifactStore(root, workspaces);
  const parallel = options.parallel === true;
  const watched = !parallel && (options.watched ?? true);
  await initializeCampaign(
    store,
    artifacts,
    definition(name, options.builderWallClockMs, watched, parallel),
  );
  const ling = new FakeLing(workspaces, options.builder);
  ling.killFails = options.killFails === true;
  let persisted: CampaignManifest | undefined;
  ling.recorded = (id) => persisted?.tasks.find((task) => task.id === id)?.terminated;
  const client = withScriptedWatcher(ling, () => ({
    ...(options.watcher === undefined ? {} : { script: options.watcher }),
  }));
  const started = Date.now();
  const manifest = await new CampaignDriver({
    client,
    store,
    artifacts,
    policy: POLICY,
    pollIntervalMs: 5,
    settleGraceMs: options.settleGraceMs,
    ...(options.unreachableMs === undefined ? {} : { unreachableMs: options.unreachableMs }),
    oversight: { timings: TIMINGS },
    onProgress: (snapshot) => {
      persisted = structuredClone(snapshot);
    },
  }).run();
  return { manifest, ling, watchers: client.watchers, elapsedMs: Date.now() - started };
}

function taskOf(manifest: CampaignManifest, role: CampaignTaskRecord["role"]): CampaignTaskRecord {
  const record = manifest.tasks.find((task) => task.role === role);
  assert(record !== undefined, `no ${role} task was recorded`);
  return record;
}

function summonOf(manifest: CampaignManifest, record: CampaignTaskRecord) {
  return manifest.summons.find((intent) => intent.requestKey === record.requestKey);
}

// ---------------------------------------------------------------------------
// One pair against a fake clock, for the credit the driver waits on.

class FakeClock implements OversightClock {
  private current = Date.parse("2026-10-04T10:00:00.000Z");
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.current;
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { at: this.current + Math.max(0, ms), callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    for (;;) {
      await settle();
      let next: [number, { at: number; callback: () => void }] | undefined;
      for (const entry of this.timers) {
        if (entry[1].at <= target && (next === undefined || entry[1].at < next[1].at)) next = entry;
      }
      if (next === undefined) break;
      this.timers.delete(next[0]);
      this.current = Math.max(this.current, next[1].at);
      next[1].callback();
    }
    this.current = target;
    await settle();
  }
}

/**
 * A pair watching, B holding batch 1 (with fact o:1), on a fake clock. A
 * message `refuse` picks is refused delivery for good.
 */
async function creditPair(refuse: (message: OversightMessage) => boolean) {
  const clock = new FakeClock();
  const client: OversightClient = {
    sendOversight: async (_id, message) => {
      if (refuse(message)) {
        throw new LingClientError("Ling returned 409: full", 409, false, undefined, "inbox_full");
      }
      return { accepted: true, duplicate: false };
    },
    get: async (id) => ({
      id,
      status: "running",
      prompt: "fixture",
      options: {},
      createdAt: new Date(clock.now()).toISOString(),
      workspaceDir: "",
      seededFiles: [],
    }),
    cancel: async () => undefined,
  };
  const host: PairHost = {
    save: async () => undefined,
    storeText: async (namespace, sourcePath, content): Promise<ArtifactRef> => {
      const sha256 = createHash("sha256").update(content).digest("hex");
      return {
        artifactId: `sha256:${sha256}`,
        path: `artifacts/${namespace}/${sha256}/${sourcePath}`,
        sha256,
      };
    },
    workerIdOf: () => undefined,
    kill: async () => {
      const at = new Date(clock.now()).toISOString();
      return {
        task: undefined,
        termination: { reason: "cancel-unconfirmed", requestedAt: at, completedAt: at, errors: [] },
      };
    },
    workerRecordAssessment: () => assessEventSequence([]),
    workerRecordEvents: () => [],
    workerDeclaresIntent: () => false,
  };
  const pair = new OversightPair({
    record: newPairRecord("pair-credit", "channel", true),
    client,
    host,
    workerWallClockMs: 600_000,
    clock,
    timings: { pollMs: 50 },
  });
  let workerSeq = 0;
  let watcherSeq = 0;
  const event = (seq: number, type: string, data?: unknown): LingEvent => ({
    seq,
    at: new Date(clock.now()).toISOString(),
    type,
    ...(data === undefined ? {} : { data }),
  });
  const worker = async (type: string, data?: unknown) => {
    workerSeq += 1;
    await pair.onWorkerEvent(event(workerSeq, type, data));
    await settle();
  };
  const watcher = async (type: string, data?: unknown) => {
    watcherSeq += 1;
    await pair.onWatcherEvent(event(watcherSeq, type, data));
    await settle();
  };
  pair.watcherAccepted("watcher");
  await watcher("task_started");
  await watcher("tool_start", { tool: "watch_next", args: {} });
  assert.equal(await pair.waitReady(), true);
  await pair.workerAccepted("worker");
  await worker("task_started");
  await watcher("oversight_watch_returned", {
    result: "batch",
    batch: 1,
    waitedMs: 0,
    buffered: 0,
  });
  await watcher("tool_end", { tool: "watch_next", error: false });
  await watcher("tool_start", { tool: "watch_next", args: {} });
  return { clock, pair, worker, watcher };
}

// ---------------------------------------------------------------------------
// A provisioner after an overlord restart: it holds only the leases a check
// gives it, as a recover() that rebuilt none holds none, and summons nothing.

class LeasedWorker implements ProvisionedWorkerClient {
  constructor(private readonly tasks: LingTask[]) {}

  async health(): Promise<LingHealth> {
    return OVERSIGHT_HEALTH;
  }

  async spawn(): Promise<SpawnResponse> {
    throw new Error("This fixture worker takes no tasks.");
  }

  async get(id: string): Promise<LingTask> {
    const task = this.tasks.find((candidate) => candidate.id === id);
    if (task === undefined) {
      throw new LingClientError("Ling returned 404: no such task", 404, false);
    }
    return structuredClone(task);
  }

  async list(): Promise<LingTask[]> {
    return structuredClone(this.tasks);
  }

  async cancel(): Promise<void> {}

  async *events(): AsyncIterable<LingEvent> {}

  async sendPeerMessage(): Promise<LingPeerMessageResponse> {
    return { accepted: true, duplicate: false };
  }

  async sendOversight(_id: string, message: LingOversightMessage): Promise<LingOversightResponse> {
    return { accepted: true, duplicate: false, kind: message.kind };
  }

  async fetchLog(): Promise<LingEvent[]> {
    return [];
  }

  async listArtifacts(): Promise<LingArtifactList> {
    return { files: [], totalBytes: 0 };
  }

  async readArtifact(): Promise<Uint8Array> {
    throw new Error("This fixture worker has no artifacts.");
  }
}

class HeldLease implements ProvisionedWorkerLease {
  readonly requestKey: string;
  readonly profile = { profileId: "fixture", tools: [] };
  readonly createdAt = "2026-10-04T10:00:00.000Z";
  readonly expiresAt = "2026-10-04T12:00:00.000Z";
  readonly releaseCaveats: readonly string[] = [];
  termination: ProvisionedLeaseTermination | undefined;

  constructor(
    readonly workerId: string,
    readonly client: ProvisionedWorkerClient,
    public released = false,
  ) {
    this.requestKey = `fixture:${workerId}`;
  }

  async release(): Promise<void> {
    this.released = true;
  }

  async terminate(): Promise<ProvisionedLeaseTermination> {
    throw new Error("This fixture lease is not killed.");
  }
}

class RestartedProvisioner implements LingProvisioner {
  readonly summoned: string[] = [];

  constructor(private readonly held: ProvisionedWorkerLease[] = []) {}

  async recover(): Promise<void> {}

  async summon(request: LingProvisionRequest): Promise<ProvisionedWorkerLease> {
    this.summoned.push(request.requestKey);
    throw new Error("This fixture provisioner summons nothing.");
  }

  lease(workerId: string): ProvisionedWorkerLease | undefined {
    return this.held.find((lease) => lease.workerId === workerId);
  }

  leases(): readonly ProvisionedWorkerLease[] {
    return this.held;
  }
}

function provisionedClient(provisioner: LingProvisioner): ProvisionedLingClient {
  return new ProvisionedLingClient({
    provisioner,
    resolveProfile: resolvedWorkerProfileFromSpawnInput,
  });
}

/**
 * A watched attempt an earlier overlord left running: both members recorded
 * with the workers they were summoned on, their summons spawned.
 */
async function leftRunning(name: string) {
  const root = path.join(tmpRoot, name);
  const store = new CampaignManifestStore(path.join(root, "manifest.json"));
  const artifacts = new CampaignArtifactStore(root, path.join(root, "workspaces"));
  const initialized = await initializeCampaign(store, artifacts, {
    ...definition(name, 600_000, true),
    maxRounds: 3,
  });
  const pairId = pairIdFor(initialized.id, "01", 1);
  await store.update((manifest) => {
    manifest.status = "running";
    manifest.slices[0]!.status = "building";
    manifest.slices[0]!.attempts.push({
      round: 1,
      builderId: "task-builder",
      reviewerId: null,
      artifacts: [],
      verdict: null,
      evidence: [],
      gaps: [],
      costUsd: 0,
      watch: {
        ...newPairRecord(pairId, "channel", true),
        state: "watching",
        workerTaskId: "task-builder",
        watcherTaskId: "task-watcher",
      },
    });
    for (const role of ["builder", "watcher"] as const) {
      const requestKey = campaignRequestKey(initialized.id, role, "01", 1);
      const at = "2026-10-04T10:00:00.000Z";
      manifest.tasks.push({
        id: `task-${role}`,
        requestKey,
        workerId: `local-${role}`,
        role,
        sliceId: "01",
        round: 1,
        status: "running",
        costUsd: 0,
        totalTokens: 0,
        seedProvenance: "recorded",
        seededArtifacts: [],
        seededMessageIds: [],
        pairId,
        createdAt: at,
      });
      manifest.summons.push({
        requestKey,
        role,
        sliceId: "01",
        round: 1,
        profileSha256: "a".repeat(64),
        requestSha256: "b".repeat(64),
        state: "spawned",
        workerId: `local-${role}`,
        taskId: `task-${role}`,
        preparedAt: at,
        updatedAt: at,
        error: null,
      });
    }
  });
  const run = (provisioner: LingProvisioner, resumeBlocked = false) =>
    new CampaignDriver({
      client: provisionedClient(provisioner),
      store,
      artifacts,
      policy: POLICY,
      pollIntervalMs: 5,
      oversight: { timings: TIMINGS },
    }).run(resumeBlocked ? { resumeBlocked: true } : {});
  return { store, run };
}

function runningTask(id: string, workerId: string): LingTask {
  return {
    id,
    workerId,
    status: "running",
    prompt: "fixture",
    options: {},
    createdAt: "2026-10-04T10:00:00.000Z",
    workspaceDir: "",
    seededFiles: [],
  };
}

// ===========================================================================

try {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "pair-runtime-check-"));

  // -------------------------------------------------------------------------
  // The rung past cancel, for A.

  await check(
    "a wedged A is given up on at its own wall clock plus the grace, and killed when its cancel goes unconfirmed",
    async () => {
      const wallClockMs = 300;
      const graceMs = 300;
      const run = await runCampaign("wedged-builder", {
        builder: WEDGED,
        builderWallClockMs: wallClockMs,
        settleGraceMs: graceMs,
      });
      const builder = taskOf(run.manifest, "builder");
      assert.equal(run.manifest.status, "blocked");
      assert(
        run.manifest.integration.gaps.includes(
          `Timed out waiting for campaign task ${builder.id} to settle; killed it when its cancel went unconfirmed.`,
        ),
        run.manifest.integration.gaps.join("; "),
      );
      // Cancelled first, and only once its own deadline had passed.
      const started = Date.parse(run.ling.tasks.get(builder.id)!.events[0]!.at);
      const cancelled = run.ling.cancels.find((cancel) => cancel.id === builder.id);
      assert(cancelled !== undefined, "A was never cancelled");
      assert(
        cancelled.at - started >= wallClockMs + graceMs,
        `A was cancelled ${cancelled.at - started} ms after it started`,
      );
      // Twice A's longest run would be 22 minutes; it was found in seconds.
      assert(run.elapsedMs < 20_000, `the campaign took ${run.elapsedMs} ms`);
      assert.deepEqual(run.ling.kills, [[builder.id, "cancel-unconfirmed"]]);
      // The cancel had cancelGraceMs to be confirmed, not the driver's own 5 s.
      const killedAt = Date.parse(builder.terminated?.requestedAt ?? "");
      assert(
        killedAt - cancelled.at < 2_000,
        `A was killed ${killedAt - cancelled.at} ms after its cancel`,
      );
      // The kill was on the record before it was applied, as an open one.
      assert.equal(run.ling.recordedAtKill.length, 1);
      assert.equal(run.ling.recordedAtKill[0]?.reason, "cancel-unconfirmed");
      assert.equal(run.ling.recordedAtKill[0]?.completedAt, null);
      assert.deepEqual(run.ling.recordedAtKill[0]?.errors, []);
      assert.equal(builder.terminated?.reason, "cancel-unconfirmed");
      assert.notEqual(builder.terminated?.completedAt ?? null, null);
      assert.equal(builder.status, "interrupted");
      // Read again after the kill, at the most it may have spent.
      assert.equal(builder.costUsd, BUILDER_COST_USD);
      assert.equal(summonOf(run.manifest, builder)?.state, "released");
      assert.notEqual(builder.logs?.record ?? null, null, "A's record was not kept");
      const pair = run.manifest.slices[0]?.attempts[0]?.watch;
      assert.equal(pair?.state, "aborted");
      assert.equal(taskOf(run.manifest, "watcher").status, "cancelled");
    },
  );

  await check(
    "a watched A is waited on past its own wall clock while its watcher's hold earns it credit",
    async () => {
      // Uncredited, A would be given up on 1 000 ms after it started. Held
      // from its first batch, it is waited on until it ends at 3 000 ms.
      let held = false;
      const run = await runCampaign("credited-builder", {
        builder: workFor(3_000),
        builderWallClockMs: 500,
        settleGraceMs: 500,
        watcher: () => {
          if (held) return [];
          held = true;
          return [{ type: "hold", reason: "Pausing the worker.", evidence: ["o:1"] }];
        },
      });
      assert.equal(run.manifest.status, "completed", run.manifest.integration.gaps.join("; "));
      assert.deepEqual(run.ling.kills, []);
      const builder = taskOf(run.manifest, "builder");
      assert.equal(builder.status, "completed");
      const events = run.ling.tasks.get(builder.id)!.events;
      const ranMs = Date.parse(events.at(-1)!.at) - Date.parse(events[0]!.at);
      assert(ranMs >= 2_500, `A ran ${ranMs} ms`);
      const hold = run.manifest.slices[0]?.attempts[0]?.watch?.holds[0];
      assert.equal(hold?.origin, "watcher");
      assert.equal(hold?.endReason, "worker_ended", "the hold ended before A did");
    },
  );

  await check(
    "the credit is what A reported or what its watcher holds add up to, an active one to now, each to its lapse",
    async () => {
      // Every release refused: hold-1 stays active, as one whose release
      // never reached A does until A's lapse.
      const watched = await creditPair((message) => message.kind === "release");
      await watched.watcher("oversight_hold_request", {
        requestId: "h1",
        reason: "Stop.",
        evidence: ["o:1"],
      });
      const hold = watched.pair.record.holds[0];
      assert.equal(hold?.origin, "watcher");
      assert.equal(hold?.status, "active");
      await watched.clock.advance(10_000);
      assert.equal(watched.pair.workerCreditMs(), 10_000);
      // Past its lapse it counts no further: maxMs and the ling's 30 000 ms.
      await watched.clock.advance(400_000);
      assert.equal(hold?.status, "active", "the hold's release reached A");
      assert.equal(watched.pair.workerCreditMs(), OVERSIGHT_LIMITS.maxHoldMs + 30_000);
      // What A's ling reports counts where it is more.
      await watched.worker("oversight_clock", {
        holdId: "hold-1",
        heldMs: 400_000,
        creditMs: 400_000,
        limitMs: 1_000_000,
      });
      assert.equal(watched.pair.workerCreditMs(), 400_000);
      watched.pair.dispose();

      // A hold that ended counts what it lasted, and no more.
      const released = await creditPair(() => false);
      await released.watcher("oversight_hold_request", {
        requestId: "h1",
        reason: "Stop.",
        evidence: ["o:1"],
      });
      await released.clock.advance(10_000);
      await released.watcher("oversight_release_request", { holdId: "hold-1" });
      assert.equal(released.pair.record.holds[0]?.status, "ended");
      await released.clock.advance(50_000);
      assert.equal(released.pair.workerCreditMs(), 10_000);
      released.pair.dispose();

      // A self-hold earns nothing: A chose it.
      const asked = await creditPair(() => false);
      await asked.worker("oversight_question", {
        questionId: "q1",
        question: "Go on?",
        holdSelf: true,
      });
      assert.equal(asked.pair.record.holds[0]?.origin, "worker");
      assert.equal(asked.pair.record.holds[0]?.status, "active");
      await asked.clock.advance(5_000);
      assert.equal(asked.pair.workerCreditMs(), 0);
      asked.pair.dispose();
    },
  );

  await check(
    "an A whose worker stops answering is killed as unreachable once unreachableMs has passed",
    async () => {
      const run = await runCampaign("silent-builder", {
        builder: (task) => {
          task.emit("task_started");
          setTimeout(() => {
            task.failure = unanswered;
          }, 50);
        },
        builderWallClockMs: 600_000,
        settleGraceMs: 60_000,
        unreachableMs: 300,
      });
      const builder = taskOf(run.manifest, "builder");
      assert.equal(run.manifest.status, "blocked");
      assert.deepEqual(run.ling.kills, [[builder.id, "worker-unreachable"]]);
      assert.equal(builder.terminated?.reason, "worker-unreachable");
      assert.notEqual(builder.terminated?.completedAt ?? null, null);
      assert.equal(builder.status, "interrupted");
      assert.match(
        run.manifest.integration.gaps.join("; "),
        new RegExp(
          `Worker for task ${builder.id} did not answer for 300 ms, so it was killed: Ling request failed at the transport boundary\\.`,
        ),
      );
      assert.equal(run.manifest.slices[0]?.attempts[0]?.watch?.state, "aborted");
    },
  );

  await check(
    "an unreachable A whose kill is not confirmed blocks the campaign, saying so, and is left running",
    async () => {
      const run = await runCampaign("silent-builder-unkilled", {
        builder: (task) => {
          task.emit("task_started");
          setTimeout(() => {
            task.failure = unanswered;
          }, 50);
        },
        builderWallClockMs: 600_000,
        settleGraceMs: 60_000,
        unreachableMs: 300,
        killFails: true,
      });
      const builder = taskOf(run.manifest, "builder");
      assert.equal(run.manifest.status, "blocked");
      assert.match(
        run.manifest.integration.gaps.join("; "),
        new RegExp(
          `Task ${builder.id} stopped answering and could not be confirmed killed: kill failed\\.`,
        ),
      );
      assert.equal(builder.terminated?.reason, "worker-unreachable");
      assert.equal(builder.terminated?.completedAt, null);
      assert.deepEqual(builder.terminated?.errors, ["kill failed"]);
      assert.equal(run.ling.recordedAtKill[0]?.completedAt, null);
      assert.deepEqual(run.ling.recordedAtKill[0]?.errors, []);
      assert.equal(builder.status, "running");
    },
  );

  await check("a read the worker answered with an error still blocks at once, with no kill", async () => {
    const run = await runCampaign("refusing-builder", {
      builder: (task) => {
        task.emit("task_started");
        setTimeout(() => {
          task.failure = () => new LingClientError("Ling returned 500: fixture failure", 500, true);
        }, 50);
      },
      builderWallClockMs: 600_000,
      settleGraceMs: 60_000,
      unreachableMs: 60_000,
    });
    const builder = taskOf(run.manifest, "builder");
    assert.equal(run.manifest.status, "blocked");
    assert.deepEqual(run.ling.kills, []);
    assert(
      run.manifest.integration.gaps.includes(
        `Worker became unavailable while waiting for task ${builder.id}: Ling returned 500: fixture failure`,
      ),
      run.manifest.integration.gaps.join("; "),
    );
    assert(run.elapsedMs < 30_000, "unreachableMs was waited out for a worker that answered");
  });

  await check(
    "a task the driver gives up on is killed when its cancel goes unconfirmed, watched or not",
    async () => {
      const run = await runCampaign("wedged-unwatched", {
        builder: WEDGED,
        builderWallClockMs: 100,
        settleGraceMs: 100,
        watched: false,
      });
      const builder = taskOf(run.manifest, "builder");
      assert.equal(run.manifest.status, "blocked");
      assert.deepEqual(run.ling.kills, [[builder.id, "cancel-unconfirmed"]]);
      assert.equal(builder.terminated?.reason, "cancel-unconfirmed");
      assert.equal(builder.status, "interrupted");
      assert(
        run.manifest.integration.gaps.includes(
          `Timed out waiting for campaign task ${builder.id} to settle; killed it when its cancel went unconfirmed.`,
        ),
        run.manifest.integration.gaps.join("; "),
      );
    },
  );

  await check(
    "a task still running once another has stopped the campaign is killed when its cancel goes unconfirmed, not asked again until its deadline",
    async () => {
      // Two builders side by side: one wedged, and one whose worker answers
      // with an error, which blocks the campaign while the first still runs.
      let builders = 0;
      const run = await runCampaign("wedged-sibling", {
        builder: (task) => {
          builders += 1;
          if (builders === 1) return WEDGED(task);
          task.emit("task_started");
          setTimeout(() => {
            task.failure = () => new LingClientError("Ling returned 500: fixture failure", 500, true);
          }, 200);
        },
        // Its deadline would be 15 s away.
        builderWallClockMs: 5_000,
        settleGraceMs: 5_000,
        parallel: true,
      });
      const tasks = [...run.ling.tasks.values()];
      const wedged = tasks.find((task) => task.ignoreCancel);
      const refusing = tasks.find((task) => task.failure !== undefined);
      assert(wedged !== undefined && refusing !== undefined, "both builders did not run");
      assert.equal(run.manifest.status, "blocked");
      const gaps = run.manifest.integration.gaps;
      assert(
        gaps.includes(
          `Worker became unavailable while waiting for task ${refusing.id}: Ling returned 500: fixture failure`,
        ),
        gaps.join("; "),
      );
      assert.deepEqual(run.ling.kills, [[wedged.id, "cancel-unconfirmed"]]);
      assert.equal(
        run.ling.cancels.filter((cancel) => cancel.id === wedged.id).length,
        1,
        "the wedged builder's cancel was asked again",
      );
      const record = run.manifest.tasks.find((task) => task.id === wedged.id);
      assert.equal(record?.terminated?.reason, "cancel-unconfirmed");
      assert.notEqual(record?.terminated?.completedAt ?? null, null);
      assert.equal(record?.status, "interrupted");
      assert.equal(record?.costUsd, BUILDER_COST_USD);
      assert.equal(
        gaps.some((gap) => gap.startsWith("Timed out waiting")),
        false,
        gaps.join("; "),
      );
      assert(run.elapsedMs < 5_000, `the campaign took ${run.elapsedMs} ms`);
    },
  );

  await check(
    "a capped campaign's task left running is killed when its cancel goes unconfirmed",
    async () => {
      const name = "capped-wedged";
      const root = path.join(tmpRoot, name);
      const workspaces = path.join(root, "workspaces");
      const store = new CampaignManifestStore(path.join(root, "manifest.json"));
      const artifacts = new CampaignArtifactStore(root, workspaces);
      const initialized = await initializeCampaign(
        store,
        artifacts,
        definition(name, 600_000, false),
      );
      const ling = new FakeLing(workspaces, WEDGED);
      const requestKey = campaignRequestKey(initialized.id, "builder", "01", 1);
      const spawned = await ling.spawn({
        task: "Build only slice 01.",
        requestKey,
        tools: ["read", "write"],
        maxCostUsd: BUILDER_COST_USD,
      });
      await store.update((manifest) => {
        manifest.status = "capped";
        manifest.slices[0]!.status = "building";
        manifest.slices[0]!.attempts.push({
          round: 1,
          builderId: spawned.id,
          reviewerId: null,
          artifacts: [],
          verdict: null,
          evidence: [],
          gaps: [],
          costUsd: 0,
        });
        manifest.tasks.push({
          id: spawned.id,
          requestKey,
          workerId: "local",
          role: "builder",
          sliceId: "01",
          round: 1,
          status: "running",
          costUsd: 0,
          totalTokens: 0,
          seedProvenance: "recorded",
          seededArtifacts: [],
          seededMessageIds: [],
          createdAt: new Date().toISOString(),
        });
      });
      const manifest = await new CampaignDriver({
        client: ling,
        store,
        artifacts,
        policy: POLICY,
        pollIntervalMs: 5,
        oversight: { timings: TIMINGS },
      }).run();
      assert.equal(manifest.status, "capped");
      assert.deepEqual(ling.kills, [[spawned.id, "cancel-unconfirmed"]]);
      const record = manifest.tasks.find((task) => task.id === spawned.id);
      assert.equal(record?.terminated?.reason, "cancel-unconfirmed");
      assert.notEqual(record?.terminated?.completedAt ?? null, null);
      assert.equal(record?.status, "interrupted");
      assert.equal(record?.costUsd, BUILDER_COST_USD);
      assert.equal(
        manifest.integration.gaps.some((gap) => gap.startsWith("Capped campaign could not confirm")),
        false,
        manifest.integration.gaps.join("; "),
      );
    },
  );

  // -------------------------------------------------------------------------
  // A restart that finds no leases.

  await check(
    "a provisioned client tells a worker it holds no lease for from a task on another worker",
    async () => {
      const elsewhere = new HeldLease(
        "local-other",
        new LeasedWorker([runningTask("task-builder", "local-other")]),
      );
      const gone = new HeldLease("local-gone", new LeasedWorker([]), true);
      const client = provisionedClient(new RestartedProvisioner([elsewhere, gone]));
      const code = (error: unknown) =>
        error instanceof LingProvisionerError ? error.code : String(error);
      await assert.rejects(client.get("task-watcher", "local-watcher"), (error: unknown) => {
        assert.equal(code(error), "no_lease");
        return true;
      });
      await assert.rejects(client.get("task-watcher"), (error: unknown) => {
        assert.equal(code(error), "unknown_task");
        return true;
      });
      await client.list();
      await assert.rejects(client.get("task-builder", "local-builder"), (error: unknown) => {
        assert.equal(code(error), "unknown_worker");
        return true;
      });
      await assert.rejects(client.get("task-old", "local-gone"), (error: unknown) => {
        assert.equal(code(error), "worker_released");
        return true;
      });
      // A pair's outbox reads a member with no lease as gone, not as a retry.
      assert.deepEqual(classifyDeliveryError(new LingProvisionerError("x", "no_lease")), {
        kind: "undeliverable",
        code: "not_found",
        protocol: false,
      });
    },
  );

  await check(
    "after a restart with no leases a watched attempt takes the orphan path, and a resume abandons it",
    async () => {
      const left = await leftRunning("restart-no-lease");
      const blocked = await left.run(new RestartedProvisioner());
      assert.equal(blocked.status, "blocked");
      assert.deepEqual(blocked.slices[0]?.attempts[0]?.gaps, [ORPHAN_GAP]);
      assert.equal(
        blocked.integration.gaps.some((gap) => gap.startsWith("Worker reconciliation failed")),
        false,
        blocked.integration.gaps.join("; "),
      );
      // The resume abandons both members and the pair, and starts the next
      // round, whose watcher this provisioner cannot summon.
      const provisioner = new RestartedProvisioner();
      const resumed = await left.run(provisioner, true);
      assert.equal(resumed.status, "blocked");
      assert.deepEqual(
        resumed.tasks.map((task) => [task.id, task.status]),
        [
          ["task-builder", "failed"],
          ["task-watcher", "failed"],
        ],
      );
      // Neither member's end was seen, and each was recorded at $0 while it
      // ran, so each is charged its ceiling: the books do not lose them.
      const watcherCeiling = Math.min(
        resumed.coordination.watch?.watcherMaxCostUsd ?? Number.NaN,
        POLICY.maxCostUsdPerTask,
      );
      assert.deepEqual(
        resumed.tasks.map((task) => [task.id, task.costUsd]),
        [
          ["task-builder", BUILDER_COST_USD],
          ["task-watcher", watcherCeiling],
        ],
      );
      assert(
        Math.abs(resumed.spentUsdSnapshot - (BUILDER_COST_USD + watcherCeiling)) < 1e-9,
        `the ledger counted ${resumed.spentUsdSnapshot}`,
      );
      const [first, second] = resumed.slices[0]?.attempts ?? [];
      assert.equal(first?.costUsd, BUILDER_COST_USD);
      assert.equal(first?.verdict, "revise");
      assert(first?.gaps.includes(ORPHAN_GAP));
      assert.equal(first?.watch?.state, "lost");
      assert.equal(second?.watch?.outcome, "watcher_spawn_failed");
      assert.equal(provisioner.summoned.length, 1);
      // And a resume after that is not stopped by the earlier members'
      // teardown: there is nothing left of them to release.
      const again = await left.run(new RestartedProvisioner(), true);
      assert.equal(
        again.integration.gaps.some((gap) => gap.startsWith("Provisioned worker teardown")),
        false,
        again.integration.gaps.join("; "),
      );
      for (const task of ["task-builder", "task-watcher"]) {
        assert.equal(
          again.summons.find((intent) => intent.taskId === task)?.state,
          "released",
          task,
        );
      }
      assert.equal(again.slices[0]?.attempts.length, 3);
    },
  );

  await check(
    "a released worker, or a task on another worker than its record names, still stops reconcile",
    async () => {
      const released = await leftRunning("restart-released");
      const stopped = await released.run(
        new RestartedProvisioner([
          new HeldLease("local-builder", new LeasedWorker([]), true),
          new HeldLease("local-watcher", new LeasedWorker([]), true),
        ]),
      );
      assert.equal(stopped.status, "blocked");
      assert.equal(
        stopped.integration.gaps.at(-1),
        "Worker reconciliation failed for task task-builder: Worker local-builder was released before task task-builder was snapshotted.",
      );
      assert.deepEqual(stopped.slices[0]?.attempts[0]?.gaps, []);
      assert.equal(stopped.tasks.find((task) => task.id === "task-builder")?.status, "running");

      const moved = await leftRunning("restart-elsewhere");
      const refused = await moved.run(
        new RestartedProvisioner([
          new HeldLease(
            "local-other",
            new LeasedWorker([runningTask("task-builder", "local-other")]),
          ),
        ]),
      );
      assert.equal(refused.status, "blocked");
      assert.equal(
        refused.integration.gaps.at(-1),
        "Worker reconciliation failed for task task-builder: Task task-builder belongs to worker local-other, not local-builder.",
      );
      assert.deepEqual(refused.slices[0]?.attempts[0]?.gaps, []);
    },
  );
} finally {
  await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
}

console.log(
  failures === 0 ? "\nall pair runtime checks passed" : `\n${failures} pair runtime check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
