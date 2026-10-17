import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CampaignArtifactStore } from "../campaign/artifacts.js";
import { initializeCampaign } from "../campaign/initialize.js";
import { CampaignManifestStore } from "../campaign/manifest.js";
import type { CampaignManifest } from "../campaign/schema.js";
import {
  bootstrapLing,
  killProcessTree,
  processTreeTargets,
  sigkillTargets,
  type LingBootstrapOptions,
  type ProcessTableRow,
} from "../ling/bootstrap.js";
import { LingClient, LingClientError, type LingEventOptions } from "../ling/client.js";
import { FleetLingClient } from "../ling/fleet.js";
import {
  LingProvisionerError,
  ProvisionedLingClient,
  applyResolvedWorkerProfile,
  normalizeResolvedWorkerProfile,
  resolvedWorkerProfileFromSpawnInput,
  type LingProvisionRequest,
  type LingProvisioner,
  type ProvisionedLeaseReleaseReason,
  type ProvisionedLeaseTerminateOptions,
  type ProvisionedLeaseTerminateReason,
  type ProvisionedLeaseTermination,
  type ProvisionedWorkerClient,
  type ProvisionedWorkerLease,
} from "../ling/provisioner.js";
import { LocalTaskProvisioner, type LocalContainerRuntime } from "../ling/local-provisioner.js";
import type {
  LingArtifactList,
  LingEvent,
  LingHealth,
  LingOversightMessage,
  LingOversightResponse,
  LingPeerMessage,
  LingPeerMessageResponse,
  LingTask,
  SpawnInput,
  SpawnResponse,
} from "../ling/types.js";
import {
  MAX_PRODUCT_SNAPSHOT_FILES,
  MAX_PRODUCT_SNAPSHOT_MANIFEST_BYTES,
  ObjectiveConcurrentModificationError,
  ObjectiveManifestStore,
  ProductSnapshotError,
  ProductSnapshotStore,
  initializeObjective,
  parseProductSnapshotManifest,
} from "../objective/index.js";
import { profileCapabilityViolation } from "../policy.js";
import { ProfileCompositionError, ProfileLibrary } from "../profiles/index.js";

let failures = 0;

async function check(label: string, run: () => void | Promise<void>): Promise<void> {
  try {
    await run();
    console.log(`PASS  ${label}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${label} -- ${error instanceof Error ? error.message : String(error)}`);
  }
}

class FakeWorkerClient implements ProvisionedWorkerClient {
  readonly inputs: SpawnInput[] = [];
  /** While set, get(), list() and cancel() fail as a dead worker's would. */
  unreachable = false;
  private readonly tasks = new Map<string, LingTask>();

  constructor(private readonly workerId: string) {}

  async health(): Promise<LingHealth> {
    return { ok: true, workerId: this.workerId, queued: 0, running: 0, maxConcurrency: 1 };
  }

  async spawn(input: SpawnInput): Promise<SpawnResponse> {
    this.inputs.push(input);
    const id = `${this.workerId}-task`;
    const failed = input.task === "fail";
    const status = input.task === "hang" ? "running" : failed ? "failed" : "completed";
    const task: LingTask = {
      id,
      ...(input.requestKey === undefined ? {} : { requestKey: input.requestKey }),
      status,
      prompt: input.task,
      options: {
        ...(input.provider === undefined ? {} : { provider: input.provider }),
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.thinking === undefined ? {} : { thinking: input.thinking }),
        ...(input.tools === undefined ? {} : { tools: input.tools }),
        ...(input.skills === undefined ? {} : { skills: input.skills }),
        ...(input.inlineSkills === undefined ? {} : { inlineSkills: input.inlineSkills }),
        ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
        // Ling echoes the limits a POST asked for, and only those.
        ...(input.maxTurns === undefined ? {} : { maxTurns: input.maxTurns }),
        ...(input.maxWallClockMs === undefined ? {} : { maxWallClockMs: input.maxWallClockMs }),
        ...(input.maxCostUsd === undefined ? {} : { maxCostUsd: input.maxCostUsd }),
      },
      createdAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      workspaceDir: `/remote/${id}`,
      seededFiles: Object.keys(input.files ?? {}),
      ...(failed ? { error: "fixture failure" } : { result: { ok: true } }),
      stats: {
        turns: 1,
        cost: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    this.tasks.set(id, task);
    return {
      id,
      ...(input.requestKey === undefined ? {} : { requestKey: input.requestKey }),
      status: task.status,
      options: task.options,
      seededFiles: task.seededFiles,
    };
  }

  async get(id: string): Promise<LingTask> {
    if (this.unreachable) throw new Error(`fixture worker ${this.workerId} is unreachable`);
    const task = this.tasks.get(id);
    if (task === undefined) throw new Error(`Unknown fake task ${id}.`);
    return task;
  }

  async list(): Promise<LingTask[]> {
    if (this.unreachable) throw new Error(`fixture worker ${this.workerId} is unreachable`);
    return [...this.tasks.values()];
  }

  async cancel(id: string): Promise<void> {
    const task = await this.get(id);
    if (task.status === "queued" || task.status === "running") task.status = "cancelled";
  }

  async *events(_id: string, _options?: LingEventOptions): AsyncIterable<LingEvent> {}

  async sendPeerMessage(
    _id: string,
    _message: LingPeerMessage,
  ): Promise<LingPeerMessageResponse> {
    return { accepted: true, duplicate: false };
  }

  /** Every oversight message this worker was sent, with the task it was sent to. */
  readonly oversight: Array<{ id: string; message: LingOversightMessage }> = [];

  async sendOversight(id: string, message: LingOversightMessage): Promise<LingOversightResponse> {
    const duplicate = this.oversight.some(
      (entry) => entry.id === id && entry.message.id === message.id,
    );
    if (!duplicate) this.oversight.push({ id, message });
    return { accepted: true, duplicate, kind: message.kind };
  }

  async fetchLog(id: string): Promise<LingEvent[]> {
    await this.get(id);
    return [{ seq: 1, at: "2026-08-25T18:00:00.000Z", type: "task_started" }];
  }

  async listArtifacts(_id: string): Promise<LingArtifactList> {
    const bytes = Buffer.from("artifact", "utf8");
    return {
      files: [
        {
          path: "output.txt",
          size: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      ],
      totalBytes: bytes.byteLength,
    };
  }

  async readArtifact(_id: string, artifactPath: string): Promise<Uint8Array> {
    if (artifactPath !== "output.txt") throw new Error("Unknown fake artifact.");
    return Buffer.from("artifact", "utf8");
  }
}

class FakeLease implements ProvisionedWorkerLease {
  released = false;
  releaseCaveats: readonly string[] = [];
  /** While set, terminate() cannot confirm the worker dead, so the termination stays open. */
  killFails = false;
  /** While set, release() fails, as one whose directory a survivor holds open does. */
  releaseFails = false;
  readonly client: FakeWorkerClient;
  releaseReason: ProvisionedLeaseReleaseReason | undefined;
  termination: ProvisionedLeaseTermination | undefined;
  readonly terminateCalls: Array<{
    reason: ProvisionedLeaseTerminateReason;
    options: ProvisionedLeaseTerminateOptions | undefined;
  }> = [];

  constructor(readonly request: LingProvisionRequest, readonly workerId: string) {
    this.client = new FakeWorkerClient(workerId);
  }

  get requestKey(): string {
    return this.request.requestKey;
  }
  get profile() {
    return this.request.profile;
  }
  get createdAt(): string {
    return this.request.createdAt;
  }
  get expiresAt(): string {
    return this.request.expiresAt;
  }

  async release(reason: ProvisionedLeaseReleaseReason): Promise<void> {
    this.releaseReason = reason;
    if (this.releaseFails) throw new Error("fixture release failure");
    this.released = true;
  }

  async terminate(
    reason: ProvisionedLeaseTerminateReason,
    options?: ProvisionedLeaseTerminateOptions,
  ): Promise<ProvisionedLeaseTermination> {
    this.terminateCalls.push({ reason, options });
    this.termination ??= {
      reason,
      requestedAt: new Date().toISOString(),
      containers: [],
      errors: [],
    };
    if (this.killFails) {
      this.termination.errors = [`kill worker ${this.workerId}: fixture root still running`];
    } else {
      this.termination.completedAt ??= new Date().toISOString();
      this.termination.errors = [];
      this.released = true;
    }
    return structuredClone(this.termination);
  }
}

class FakeProvisioner implements LingProvisioner {
  private readonly byRequest = new Map<string, FakeLease>();
  private readonly byWorker = new Map<string, FakeLease>();
  recoverCalls = 0;

  async recover(): Promise<void> {
    this.recoverCalls += 1;
  }

  async summon(request: LingProvisionRequest): Promise<ProvisionedWorkerLease> {
    const existing = this.byRequest.get(request.requestKey);
    if (existing !== undefined) return existing;
    const lease = new FakeLease(request, `worker-${this.byWorker.size + 1}`);
    this.byRequest.set(request.requestKey, lease);
    this.byWorker.set(lease.workerId, lease);
    return lease;
  }

  lease(workerId: string): ProvisionedWorkerLease | undefined {
    return this.byWorker.get(workerId);
  }

  leases(): readonly ProvisionedWorkerLease[] {
    return [...this.byWorker.values()];
  }
}

async function completedCampaign(
  root: string,
  id: string,
  files: Record<string, string>,
): Promise<{ manifest: CampaignManifest; artifacts: CampaignArtifactStore }> {
  const store = new CampaignManifestStore(path.join(root, "manifest.json"));
  const artifacts = new CampaignArtifactStore(
    root,
    path.join(root, "workspaces"),
    undefined,
    (value) => value,
  );
  const initial = await initializeCampaign(store, artifacts, {
    id,
    goal: "Produce product files.",
    acceptance: [{ id: "files", kind: "file", requirement: "Product files exist." }],
    budget: { maxTasks: 4, maxTotalCostUsd: 1 },
    maxRounds: 1,
    slices: [{ id: "01", spec: "Produce the requested product files." }],
  });
  const refs = [];
  for (const [index, [filename, content]] of Object.entries(files).entries()) {
    refs.push(await artifacts.storeText(`fixture/${index + 1}`, filename, content));
  }
  const candidate = structuredClone(initial);
  candidate.status = "completed";
  candidate.slices[0]!.status = "accepted";
  candidate.slices[0]!.attempts = [
    {
      round: 1,
      builderId: null,
      reviewerId: null,
      artifacts: refs,
      verdict: "accept",
      evidence: ["fixture"],
      gaps: [],
      costUsd: 0,
    },
  ];
  candidate.integration = {
    reviewerId: null,
    verdict: "accept",
    evidence: ["fixture"],
    gaps: [],
    attempts: [
      {
        round: 1,
        reviewerId: null,
        verdict: "accept",
        evidence: ["fixture"],
        gaps: [],
        affectedSliceIds: [],
        retriesScheduled: false,
        costUsd: 0,
      },
    ],
  };
  return { manifest: await store.save(candidate), artifacts };
}

/**
 * Local provisioners whose children are fakes, recording what terminations and
 * releases do to them: hard kills, release sweeps and container removals in
 * `steps`, graceful stops in `stops`, directory removals in `disposed`. A gate
 * holds a worker's stop, or a container's removal, until it resolves. A
 * worker's `survivors` are what its kill or sweep could not confirm.
 */
function terminateFixture(root: string) {
  const steps: string[] = [];
  const stops: string[] = [];
  const disposed: string[] = [];
  const removals: Array<{ runtime: LocalContainerRuntime; name: string; env: NodeJS.ProcessEnv }> =
    [];
  const failKill = new Set<string>();
  const failSweep = new Set<string>();
  const failRemoval = new Set<string>();
  const survivors = new Map<string, string[]>();
  const stopGates = new Map<string, Promise<void>>();
  const removalGates = new Map<string, Promise<void>>();
  const provisioner = (label: string, env: NodeJS.ProcessEnv) => {
    let workers = 0;
    let port = 44_100;
    return new LocalTaskProvisioner({
      sourceLingDir: path.join(root, `terminate-source-${label}`),
      env,
      portFactory: async () => (port += 1),
      workerIdFactory: async () => `${label}-worker-${(workers += 1)}`,
      runtimeDirectoryFactory: async (_request, workerId) => ({
        path: path.join(root, "terminate-workers", workerId),
        dispose: async () => {
          disposed.push(workerId);
        },
      }),
      bootstrap: async (options) => {
        const workerId = options.env?.["WORKER_ID"] ?? "";
        return {
          client: new FakeWorkerClient(workerId),
          startedByOverlord: true,
          stop: async () => {
            stops.push(workerId);
            await stopGates.get(workerId);
          },
          kill: async () => {
            steps.push(`kill ${workerId}`);
            if (failKill.delete(workerId)) throw new Error("fixture kill failure");
            // What bootstrap's kill() says of a root that a stop() has ended.
            if (stops.includes(workerId)) return ["fixture root had exited before the kill"];
            return survivors.get(workerId) ?? [];
          },
          stopTree: async () => {
            stops.push(workerId);
            await stopGates.get(workerId);
            steps.push(`sweep ${workerId}`);
            if (failSweep.delete(workerId)) throw new Error("fixture sweep failure");
            return survivors.get(workerId) ?? [];
          },
        };
      },
      removeContainer: async (runtime, name, removerEnv) => {
        steps.push(`remove ${name}`);
        removals.push({ runtime, name, env: removerEnv });
        await removalGates.get(name);
        if (failRemoval.delete(name)) throw new Error("fixture removal failure");
      },
    });
  };
  const request = (requestKey: string): LingProvisionRequest => ({
    requestKey,
    profile: { profileId: "builder", tools: ["read"] },
    createdAt: "2026-08-25T18:00:00.000Z",
    expiresAt: "2026-08-25T19:00:00.000Z",
  });
  return {
    provisioner,
    request,
    steps,
    stops,
    disposed,
    removals,
    failKill,
    failSweep,
    failRemoval,
    survivors,
    stopGates,
    removalGates,
  };
}

/** A promise and the function that resolves it. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "ling-foundation-check-"));

try {
  await check("profile fragments compose deterministically under policy ceilings", () => {
    const library = new ProfileLibrary({
      version: 1,
      fragments: {
        base: {
          provider: "openai",
          tools: ["read"],
          namedSkills: ["browsing-rules"],
          maxCostUsd: 1,
          maxTurns: 10,
          maxWallClockMs: 60_000,
        },
        builder: {
          tools: ["write"],
          instructions: "Build the requested output.",
          maxCostUsd: 0.5,
        },
      },
      profiles: { builder: { fragments: ["base", "builder"] } },
    });
    const resolved = library.resolveProfile("builder");
    assert.deepEqual(resolved.tools, ["read", "write"]);
    assert.deepEqual(resolved.namedSkills, ["browsing-rules"]);
    assert.equal(resolved.maxCostUsd, 0.5);
    assert.equal(
      profileCapabilityViolation(
        { provider: resolved.provider, skills: resolved.namedSkills },
        {
          allowedTools: ["read", "write"],
          allowedProviders: ["openai"],
          allowedSkills: ["browsing-rules"],
          maxCostUsdPerTask: 1,
          maxTurnsPerTask: 10,
          maxWallClockMsPerTask: 60_000,
          maxTasksPerRun: 2,
          maxConcurrentTasks: 1,
          maxTotalCostUsd: 2,
        },
      ),
      undefined,
    );
    assert.throws(
      () =>
        new ProfileLibrary({
          version: 1,
          fragments: {
            a: { provider: "openai", tools: ["read"] },
            b: { provider: "anthropic", tools: ["write"] },
          },
          profiles: { conflict: { fragments: ["a", "b"] } },
        }).resolve("conflict"),
      ProfileCompositionError,
    );
    assert.throws(
      () =>
        new ProfileLibrary({
          version: 1,
          fragments: {
            a: { tools: ["read"], seedFiles: [{ path: "context.txt", content: "one" }] },
            b: { tools: ["write"], seedFiles: [{ path: "context.txt", content: "two" }] },
          },
          profiles: { conflict: { fragments: ["a", "b"] } },
        }).resolve("conflict"),
      (error: unknown) =>
        error instanceof ProfileCompositionError && error.code === "seed_collision",
    );
  });

  await check("provisioned workers cannot release successful work before collection", async () => {
    const provisioner = new FakeProvisioner();
    const retentionAlerts: string[] = [];
    const resolveProfile = (input: Readonly<SpawnInput>) => ({
      profileId: "builder",
      provider: "openai",
      tools: input.tools ?? ["read"],
      skills: input.skills,
      inlineSkills: input.inlineSkills,
      instructions: input.instructions,
      files: input.files,
      model: input.model,
      thinking: input.thinking,
    });
    const client = new ProvisionedLingClient({
      provisioner,
      resolveProfile,
      now: () => Date.parse("2026-08-25T18:00:00.000Z"),
      onRetentionAlert: (alert) => {
        retentionAlerts.push(alert.reason);
      },
    });
    const spawned = await client.spawn({
      task: "complete",
      requestKey: "foundation-complete",
      provider: "openai",
      tools: ["read"],
      skills: ["browsing-rules"],
      instructions: "Return one artifact.",
    });
    await assert.rejects(
      client.release(spawned.id, spawned.workerId),
      (error: unknown) =>
        error instanceof LingProvisionerError && error.code === "collection_pending",
    );
    const recoveredClient = new ProvisionedLingClient({
      provisioner,
      resolveProfile,
      now: () => Date.parse("2026-08-25T18:00:00.000Z"),
    });
    assert.equal((await recoveredClient.list())[0]?.id, spawned.id);
    assert.equal(provisioner.recoverCalls, 2);
    const cleanup = await client.cleanupExpired(
      Date.parse("2026-08-25T20:00:00.000Z"),
    );
    assert.deepEqual(cleanup.retainedTaskIds, [spawned.id]);
    assert.equal(cleanup.alerts[0]?.reason, "collection_pending");
    assert.deepEqual(retentionAlerts, ["collection_pending"]);
    assert.equal(provisioner.lease(spawned.workerId!)?.released, false);
    assert.equal(
      Buffer.from(await client.readArtifact(spawned.id, "output.txt", spawned.workerId)).toString(
        "utf8",
      ),
      "artifact",
    );
    await client.collectComplete(spawned.id, spawned.workerId);
    await client.release(spawned.id, spawned.workerId);
    assert.equal(provisioner.lease(spawned.workerId!)?.released, true);
    assert.equal((await client.get(spawned.id, spawned.workerId)).status, "completed");

    const failed = await client.spawn({
      task: "fail",
      requestKey: "foundation-failed",
      tools: ["read"],
    });
    await client.release(failed.id, failed.workerId);
    assert.equal(provisioner.lease(failed.workerId!)?.released, true);
  });

  await check("local provisioner isolates worker identity, provider, token, and teardown", async () => {
    const captured: Array<{ baseUrl?: string; env?: NodeJS.ProcessEnv }> = [];
    let stopped = 0;
    let disposed = 0;
    const provisioner = new LocalTaskProvisioner({
      sourceLingDir: path.join(tmpRoot, "source-ling"),
      runtimeRootDir: path.join(tmpRoot, "local-workers"),
      portFactory: async () => 43123,
      tokenFactory: async () => "fixture-token",
      workerIdFactory: async () => "fixture-worker",
      runtimeDirectoryFactory: async () => ({
        path: path.join(tmpRoot, "local-workers", "fixture-worker"),
        dispose: async () => {
          disposed += 1;
        },
      }),
      bootstrap: async (options) => {
        captured.push({ baseUrl: options.baseUrl, env: options.env });
        return {
          client: new FakeWorkerClient("fixture-worker"),
          startedByOverlord: true,
          stop: async () => {
            throw new Error("a release stops the tree, not only the root");
          },
          kill: async () => {
            throw new Error("forceShutdown must release, not kill");
          },
          stopTree: async () => {
            stopped += 1;
            return [];
          },
        };
      },
    });
    const lease = await provisioner.summon({
      requestKey: "local-worker",
      profile: {
        profileId: "builder",
        provider: "fixture-provider",
        model: "fixture-model",
        thinking: "low",
        tools: ["read"],
        inlineSkills: [
          {
            name: "local-rules",
            content: "---\nname: local-rules\ndescription: Local rules\n---\nStay local.",
          },
        ],
      },
      createdAt: "2026-08-25T18:00:00.000Z",
      expiresAt: "2026-08-25T19:00:00.000Z",
    });
    assert.equal(lease.workerId, "fixture-worker");
    assert.equal(captured[0]?.baseUrl, "http://127.0.0.1:43123");
    assert.equal(captured[0]?.env?.["AGENT_PROVIDER"], "fixture-provider");
    assert.equal(captured[0]?.env?.["AGENT_MODEL"], "fixture-model");
    assert.equal(captured[0]?.env?.["ALLOW_INLINE_SKILLS"], "true");
    assert.deepEqual(JSON.parse(captured[0]?.env?.["AGENT_TOKENS_JSON"] ?? "{}"), {
      overlord: "fixture-token",
    });
    await lease.client.spawn({
      task: "complete",
      requestKey: "local-worker-task",
      tools: ["read"],
    });
    assert.deepEqual(await provisioner.shutdown(), {
      retainedWorkerIds: ["fixture-worker"],
    });
    assert.equal(stopped, 0);
    await provisioner.forceShutdown();
    assert.equal(stopped, 1);
    assert.equal(disposed, 1);
  });

  await check("provisioned client hard-kills one active worker that release refuses", async () => {
    const provisioner = new FakeProvisioner();
    const client = new ProvisionedLingClient({
      provisioner,
      resolveProfile: (input) => ({ profileId: "builder", tools: input.tools ?? ["read"] }),
    });
    const active = await client.spawn({ task: "hang", requestKey: "foundation-hang", tools: ["read"] });
    const bystander = await client.spawn({
      task: "hang",
      requestKey: "foundation-bystander",
      tools: ["read"],
    });
    await assert.rejects(
      client.release(active.id, active.workerId),
      (error: unknown) => error instanceof LingProvisionerError && error.code === "task_active",
    );
    const termination = await client.terminate(active.id, "cancel-unconfirmed", active.workerId);
    assert.equal(termination.reason, "cancel-unconfirmed");
    const lease = provisioner.lease(active.workerId!) as FakeLease;
    assert.deepEqual(lease.terminateCalls, [
      { reason: "cancel-unconfirmed", options: { taskIds: [active.id] } },
    ]);
    assert.equal(lease.released, true);
    const untouched = provisioner.lease(bystander.workerId!) as FakeLease;
    assert.equal(untouched.released, false);
    assert.equal(untouched.terminateCalls.length, 0);
    // The worker is gone, so the release that refused before has nothing to do.
    await client.release(active.id, active.workerId);
  });

  await check("provisioned and fleet clients route oversight messages by worker, and a released worker refuses them", async () => {
    const provisioner = new FakeProvisioner();
    const client = new ProvisionedLingClient({
      provisioner,
      resolveProfile: (input) => ({ profileId: "builder", tools: input.tools ?? ["read"] }),
    });
    const worker = await client.spawn({ task: "hang", requestKey: "foundation-pair-a", tools: ["read"] });
    const watcher = await client.spawn({ task: "hang", requestKey: "foundation-pair-b", tools: ["read"] });
    const hold: LingOversightMessage = {
      id: "pair-1:hold:1",
      thread: "oversight/hold/1",
      from: "overlord",
      kind: "hold",
      createdAt: "2026-08-25T18:00:00.000Z",
      body: { holdId: "hold-1", origin: "watcher", questionId: null, reason: "Fixture.", maxMs: 300_000 },
    };
    assert.deepEqual(await client.sendOversight(worker.id, hold, worker.workerId), {
      accepted: true,
      duplicate: false,
      kind: "hold",
    });
    // By the task alone too, once its route is known; the worker deduplicates.
    assert.equal((await client.sendOversight(worker.id, hold)).duplicate, true);
    const workerLease = provisioner.lease(worker.workerId!) as FakeLease;
    const watcherLease = provisioner.lease(watcher.workerId!) as FakeLease;
    assert.deepEqual(
      workerLease.client.oversight.map((entry) => [entry.id, entry.message.id]),
      [[worker.id, "pair-1:hold:1"]],
    );
    assert.deepEqual(watcherLease.client.oversight, []);
    assert.equal((await client.fetchLog(worker.id, worker.workerId))[0]?.type, "task_started");
    await assert.rejects(
      client.sendOversight(worker.id, hold, watcher.workerId),
      (error: unknown) => error instanceof LingProvisionerError && error.code === "unknown_worker",
    );
    // A pair reads worker_released as a member that is gone, not as a retry.
    await client.terminate(watcher.id, "cancel-unconfirmed", watcher.workerId);
    for (const call of [
      () => client.sendOversight(watcher.id, hold, watcher.workerId),
      () => client.fetchLog(watcher.id, watcher.workerId),
    ]) {
      await assert.rejects(
        call,
        (error: unknown) => error instanceof LingProvisionerError && error.code === "worker_released",
      );
    }

    const posted: string[] = [];
    const fleet = new FleetLingClient({
      workers: [
        { id: "fleet-a", baseUrl: "http://127.0.0.1:1", token: "fleet-a-token" },
        { id: "fleet-b", baseUrl: "http://127.0.0.1:2", token: "fleet-b-token" },
      ],
      clientFactory: (config) =>
        new LingClient({
          baseUrl: config.baseUrl,
          token: config.token,
          fetch: async (input, init) => {
            posted.push(`${config.id} ${init?.method ?? "GET"} ${String(input)}`);
            return new Response(
              JSON.stringify({ id: "t", messageId: hold.id, kind: "hold", accepted: true, duplicate: false }),
              { status: 202, headers: { "content-type": "application/json" } },
            );
          },
        }),
    });
    assert.equal((await fleet.sendOversight("t", hold, "fleet-b")).kind, "hold");
    assert.deepEqual(posted, ["fleet-b POST http://127.0.0.1:2/tasks/t/oversight"]);
  });

  await check("a gone worker's unfinished task reads as interrupted at its cost ceiling, and a finished one keeps its end", async () => {
    const provisioner = new FakeProvisioner();
    const client = new ProvisionedLingClient({
      provisioner,
      resolveProfile: (input) => ({
        profileId: "builder",
        tools: input.tools ?? ["read"],
        // A ceiling the worker was given that the task's own POST does not repeat.
        ...(input.requestKey === "gone-released" ? { limits: { maxCostUsd: 0.25 } } : {}),
      }),
      now: () => Date.parse("2026-08-25T18:30:00.000Z"),
    });
    const noTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

    // Terminated before anyone asked the worker: what the spawn reported is
    // all there is, and it settles to interrupted with the reason. What it
    // spent is unknown, so its cost is its ceiling, the most it may have.
    const unasked = await client.spawn({
      task: "hang",
      requestKey: "gone-unasked",
      tools: ["read"],
      maxCostUsd: 0.5,
    });
    await client.terminate(unasked.id, "cancel-unconfirmed", unasked.workerId);
    const terminated = await client.get(unasked.id, unasked.workerId);
    assert.equal(terminated.status, "interrupted");
    assert.equal(terminated.stoppedBy, "interrupted");
    assert.equal(terminated.prompt, "hang");
    assert.equal(terminated.workerId, unasked.workerId);
    assert.match(
      terminated.error ?? "",
      /terminated \(cancel-unconfirmed\) while this task was last reported running, so its end, and anything it spent after that report, were never reported; its cost reads as \$0\.5, the higher of that report's and its ceiling\.$/,
    );
    // The spawn's report had no turns or tokens, and none are made up.
    assert.deepEqual(terminated.stats, { turns: 0, cost: 0.5, tokens: noTokens });
    const lease = provisioner.lease(unasked.workerId!) as FakeLease;
    assert.equal(terminated.finishedAt, lease.termination?.requestedAt);
    // Nothing asks the dead worker again, and nothing treats the task as live.
    const listed = (await client.list()).find((task) => task.id === unasked.id);
    assert.equal(listed?.status, "interrupted");
    assert.equal(listed?.stats?.cost, 0.5);
    await client.cancel(unasked.id, unasked.workerId);

    // Released under it by the provisioner, as forceShutdown() does, after a
    // snapshot that said running. The ceiling is the one its profile gave the
    // worker, and the turns are that snapshot's.
    const running = await client.spawn({
      task: "hang",
      requestKey: "gone-released",
      tools: ["read"],
    });
    assert.equal((await client.get(running.id, running.workerId)).status, "running");
    await provisioner.lease(running.workerId!)?.release("shutdown");
    const released = await client.get(running.id, running.workerId);
    assert.equal(released.status, "interrupted");
    assert.equal(released.finishedAt, "2026-08-25T18:30:00.000Z");
    assert.match(released.error ?? "", /was released while this task was last reported running/);
    assert.deepEqual(released.stats, { turns: 1, cost: 0.25, tokens: noTokens });
    assert.equal((await client.get(running.id, running.workerId)).error, released.error);

    // A last report already past the ceiling stands: ling stops a task from
    // projections of each call, so one can overshoot.
    const over = await client.spawn({
      task: "hang",
      requestKey: "gone-over",
      tools: ["read"],
      maxCostUsd: 0.5,
    });
    const overLease = provisioner.lease(over.workerId!) as FakeLease;
    (await overLease.client.get(over.id)).stats!.cost = 0.6;
    assert.equal((await client.get(over.id, over.workerId)).stats?.cost, 0.6);
    await client.terminate(over.id, "operator", over.workerId);
    assert.equal((await client.get(over.id, over.workerId)).stats?.cost, 0.6);

    // With no ceiling known, nothing is made up, and the error says so.
    const unbounded = await client.spawn({
      task: "hang",
      requestKey: "gone-unbounded",
      tools: ["read"],
    });
    await client.terminate(unbounded.id, "orphaned", unbounded.workerId);
    const unknown = await client.get(unbounded.id, unbounded.workerId);
    assert.equal(unknown.status, "interrupted");
    assert.equal(unknown.stats, undefined);
    assert.match(
      unknown.error ?? "",
      /; no cost ceiling is known for it, so its cost is only what that report said\.$/,
    );

    // A task that had ended keeps its own end, whatever became of the worker.
    const finished = await client.spawn({
      task: "complete",
      requestKey: "gone-finished",
      tools: ["read"],
    });
    assert.equal((await client.get(finished.id, finished.workerId)).status, "completed");
    await client.terminate(finished.id, "orphaned", finished.workerId);
    const kept = await client.get(finished.id, finished.workerId);
    assert.equal(kept.status, "completed");
    assert.equal(kept.error, undefined);
  });

  await check("a task whose worker's kill is unconfirmed is still asked about, not settled", async () => {
    const provisioner = new FakeProvisioner();
    const client = new ProvisionedLingClient({
      provisioner,
      resolveProfile: (input) => ({ profileId: "builder", tools: input.tools ?? ["read"] }),
    });

    // The kill did not land and the worker is alive: its own word stands, and
    // a cancel reaches it, as any cancel does.
    const alive = await client.spawn({ task: "hang", requestKey: "open-alive", tools: ["read"] });
    const aliveLease = provisioner.lease(alive.workerId!) as FakeLease;
    aliveLease.killFails = true;
    const open = await client.terminate(alive.id, "cancel-unconfirmed", alive.workerId);
    assert.equal(open.completedAt, undefined);
    assert.equal((await client.get(alive.id, alive.workerId)).status, "running");
    assert.equal((await client.list()).find((task) => task.id === alive.id)?.status, "running");
    await client.cancel(alive.id, alive.workerId);
    assert.equal((await aliveLease.client.get(alive.id)).status, "cancelled");
    assert.equal((await client.get(alive.id, alive.workerId)).status, "cancelled");

    // A worker that no longer answers while its termination is open is not
    // read as ended: every read and the cancel fail, and list() keeps the
    // last snapshot, which said running.
    const silent = await client.spawn({
      task: "hang",
      requestKey: "open-silent",
      tools: ["read"],
      maxCostUsd: 0.4,
    });
    const silentLease = provisioner.lease(silent.workerId!) as FakeLease;
    assert.equal((await client.get(silent.id, silent.workerId)).status, "running");
    silentLease.killFails = true;
    await client.terminate(silent.id, "worker-unreachable", silent.workerId);
    silentLease.client.unreachable = true;
    await assert.rejects(client.get(silent.id, silent.workerId), /is unreachable/);
    await assert.rejects(client.cancel(silent.id, silent.workerId), /is unreachable/);
    await assert.rejects(client.release(silent.id, silent.workerId), /is unreachable/);
    assert.equal((await client.list()).find((task) => task.id === silent.id)?.status, "running");

    // Once a retry confirms the kill, the task settles, keeping the last
    // report's turns, at its ceiling, and saying that what came after is unknown.
    silentLease.killFails = false;
    const done = await client.terminate(silent.id, "operator", silent.workerId);
    assert.notEqual(done.completedAt, undefined);
    assert.equal(done.reason, "worker-unreachable");
    const settled = await client.get(silent.id, silent.workerId);
    assert.equal(settled.status, "interrupted");
    assert.equal(settled.stats?.turns, 1);
    assert.equal(settled.stats?.cost, 0.4);
    assert.match(
      settled.error ?? "",
      /terminated \(worker-unreachable\) .* anything it spent after that report, were never reported; its cost reads as \$0\.4/,
    );
    await client.cancel(silent.id, silent.workerId);
  });

  await check("a release's unconfirmed sweep is reported, not dropped", async () => {
    const provisioner = new FakeProvisioner();
    const reports: unknown[] = [];
    const client = new ProvisionedLingClient({
      provisioner,
      resolveProfile: (input) => ({ profileId: "builder", tools: input.tools ?? ["read"] }),
      onReleaseCaveats: (report) => {
        reports.push(report);
      },
    });
    const clean = await client.spawn({ task: "fail", requestKey: "caveats-clean", tools: ["read"] });
    await client.release(clean.id, clean.workerId);
    assert.deepEqual(reports, []);

    const leaky = await client.spawn({ task: "fail", requestKey: "caveats-leaky", tools: ["read"] });
    (provisioner.lease(leaky.workerId!) as FakeLease).releaseCaveats = ["fixture survivor 4545"];
    await client.release(leaky.id, leaky.workerId);
    assert.deepEqual(reports, [
      {
        workerId: leaky.workerId,
        taskId: leaky.id,
        requestKey: "caveats-leaky",
        reason: "task-failed",
        released: true,
        caveats: ["fixture survivor 4545"],
      },
    ]);

    // A release that fails after its sweep still passes on what the sweep
    // saw, since that may be why, and a retry does not pass it on again.
    const held = await client.spawn({ task: "fail", requestKey: "caveats-held", tools: ["read"] });
    const heldLease = provisioner.lease(held.workerId!) as FakeLease;
    heldLease.releaseCaveats = ["fixture survivor 4747"];
    heldLease.releaseFails = true;
    await assert.rejects(client.release(held.id, held.workerId), /fixture release failure/);
    assert.deepEqual(reports.slice(1), [
      {
        workerId: held.workerId,
        taskId: held.id,
        requestKey: "caveats-held",
        reason: "task-failed",
        released: false,
        caveats: ["fixture survivor 4747"],
      },
    ]);
    heldLease.releaseFails = false;
    await client.release(held.id, held.workerId);
    assert.equal(heldLease.released, true);
    assert.equal(reports.length, 2);

    // The expiry sweep's releases are reported too, and a report that cannot
    // be delivered does not undo the release.
    const failing = new ProvisionedLingClient({
      provisioner,
      resolveProfile: (input) => ({ profileId: "builder", tools: input.tools ?? ["read"] }),
      onReleaseCaveats: () => {
        throw new Error("fixture delivery failure");
      },
    });
    const expired = await failing.spawn({ task: "fail", requestKey: "caveats-expired", tools: ["read"] });
    const expiredLease = provisioner.lease(expired.workerId!) as FakeLease;
    expiredLease.releaseCaveats = ["fixture survivor 4646"];
    const logged: string[] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    const cleanup = await failing
      .cleanupExpired(Date.parse(expiredLease.expiresAt) + 1)
      .finally(() => {
        console.error = consoleError;
      });
    assert.deepEqual(cleanup.releasedWorkerIds, [expired.workerId]);
    assert.equal(expiredLease.released, true);
    assert.equal(logged.length, 1);
    assert.match(
      logged[0] ?? "",
      /^PROVISIONER_RELEASE_CAVEATS_DELIVERY_FAILED .*fixture survivor 4646.*: fixture delivery failure$/,
    );
  });

  await check("a provisioned task's own limits and browser login become its worker's profile", async () => {
    const watcher = resolvedWorkerProfileFromSpawnInput({
      task: "watch",
      requestKey: "limits-watcher",
      tools: ["watch_next", "report_concern", "write_result"],
      maxTurns: 154,
      maxWallClockMs: 1_620_000,
      maxCostUsd: 0.75,
      storageState: "site",
    });
    assert.deepEqual(watcher.limits, { maxTurns: 154, maxWallClockMs: 1_620_000, maxCostUsd: 0.75 });
    assert.equal(watcher.storageState, "site");
    const plain = resolvedWorkerProfileFromSpawnInput({
      task: "build",
      requestKey: "limits-plain",
      tools: ["read"],
      storageState: "  ",
    });
    assert.equal("limits" in plain, false);
    assert.equal("storageState" in plain, false, "a blank login names none, as ling reads it");
    assert.deepEqual(
      resolvedWorkerProfileFromSpawnInput({ task: "t", tools: ["read"], maxTurns: 24 }).limits,
      { maxTurns: 24 },
    );
    const invalid = [{ maxTurns: 0 }, { maxCostUsd: Number.NaN }, { maxWallClockMs: Infinity }];
    for (const limits of invalid) {
      assert.throws(
        () => normalizeResolvedWorkerProfile({ profileId: "builder", tools: ["read"], limits }),
        (error: unknown) => error instanceof LingProvisionerError && error.code === "invalid_request",
        JSON.stringify(limits),
      );
    }

    // The worker holds only its profile's login, so a task cannot name another.
    const withLogin = { profileId: "browser", tools: ["browser_open"], storageState: "site" };
    assert.equal(applyResolvedWorkerProfile({ task: "t" }, withLogin).storageState, "site");
    assert.equal(
      applyResolvedWorkerProfile({ task: "t", storageState: "site" }, withLogin).storageState,
      "site",
    );
    assert.throws(
      () => applyResolvedWorkerProfile({ task: "t", storageState: "other" }, withLogin),
      /conflicts with profile browser login "site"/,
    );
    assert.throws(
      () =>
        applyResolvedWorkerProfile(
          { task: "t", storageState: "site" },
          { profileId: "b", tools: ["read"] },
        ),
      /which profile b does not provide/,
    );
  });

  await check("local terminate kills one lease, then removes its containers, and keeps the first reason", async () => {
    const fixture = terminateFixture(tmpRoot);
    const { request, steps, stops, disposed, removals, failRemoval } = fixture;
    fixture.failKill.add("docker-worker-1");
    fixture.survivors.set("docker-worker-3", ["fixture survivor 4242"]);
    const docker = fixture.provisioner("docker", {
      PATH: process.env["PATH"] ?? "",
      SANDBOX_MODE: "docker",
      CONTAINER_RUNTIME: "docker",
      ANTHROPIC_API_KEY: "dummy-anthropic-key",
      AGENT_PROVIDER: "anthropic",
    });
    const target = await docker.summon(request("terminate-target"));
    const bystander = await docker.summon(request("terminate-bystander"));
    await target.client.spawn({ task: "hang", requestKey: "terminate-target-task", tools: ["read"] });
    const taskId = `${target.workerId}-task`;
    const container = `pi-task-${taskId}`;
    assert.equal((await target.client.get(taskId)).status, "running");

    const unconfirmed = await target.terminate("cancel-unconfirmed", { taskIds: [taskId] });
    assert.equal(unconfirmed.completedAt, undefined);
    assert.match(unconfirmed.errors.join("\n"), /fixture kill failure/);
    assert.equal(target.released, false);
    assert.equal(disposed.length, 0, "the runtime directory outlives an unconfirmed kill");
    // Removed after the kill, so a dying service cannot start one behind it.
    assert.deepEqual(steps, ["kill docker-worker-1", `remove ${container}`]);

    const confirmed = await target.terminate("operator", { taskIds: [taskId] });
    assert.equal(confirmed.reason, "cancel-unconfirmed");
    assert.notEqual(confirmed.completedAt, undefined);
    assert.deepEqual(confirmed.errors, []);
    assert.deepEqual(confirmed.containers, [container]);
    assert.equal(target.released, true);
    assert.equal(target.termination?.reason, "cancel-unconfirmed");
    // A removal made while the kill was unconfirmed is made again.
    assert.deepEqual(steps, [
      "kill docker-worker-1",
      `remove ${container}`,
      "kill docker-worker-1",
      `remove ${container}`,
    ]);
    assert.deepEqual(stops, [], "a hard kill never asks the worker to stop");
    assert.deepEqual(disposed, ["docker-worker-1"]);
    assert.deepEqual(
      removals.map((entry) => entry.runtime),
      ["docker", "docker"],
    );
    // HOME is the child's, where rootless podman keeps its state, and so is
    // its temp directory, the lease's, which rootless podman can fall back to
    // for its runtime directory. Nothing else of the child's crosses: on Linux
    // a removal carrying WORKER_ID would be a target of the lease's own tree
    // kill.
    assert.deepEqual(
      Object.keys(removals[0]?.env ?? {}).sort(),
      ["HOME", "PATH", "TEMP", "TMP", "TMPDIR"],
    );
    assert.equal(
      removals[0]?.env["HOME"],
      path.join(tmpRoot, "terminate-workers", "docker-worker-1", "runtime-home"),
    );
    assert.equal(
      removals[0]?.env["TMPDIR"],
      path.join(tmpRoot, "terminate-workers", "docker-worker-1", "tmp"),
    );
    await target.terminate("operator");
    assert.equal(steps.length, 4, "a completed termination is not repeated");

    assert.equal(bystander.released, false);
    assert.equal(bystander.termination, undefined);
    await bystander.release("shutdown");
    assert.deepEqual(stops, ["docker-worker-2"]);

    // A container that could not be removed holds the termination open, and
    // the directory with it, and only that removal is retried.
    steps.length = 0;
    const leaky = await docker.summon(request("terminate-leaky"));
    failRemoval.add("pi-task-leaky-b");
    const open = await leaky.terminate("worker-unreachable", { taskIds: ["leaky-a", "leaky-b"] });
    assert.equal(open.completedAt, undefined);
    assert.equal(leaky.released, false);
    assert(!disposed.includes(leaky.workerId), "the directory went with a container still up");
    assert.deepEqual(open.errors, [
      "kill worker docker-worker-3: fixture survivor 4242",
      "remove container pi-task-leaky-b: fixture removal failure",
    ]);
    // A release finishes the open termination instead of stopping the worker
    // and removing the directory beside it, and fails while that cannot.
    failRemoval.add("pi-task-leaky-b");
    await assert.rejects(
      leaky.release("shutdown"),
      /termination is open: .*fixture removal failure/,
    );
    assert.equal(leaky.released, false);
    assert(!disposed.includes(leaky.workerId), "a release removed the directory under a container");
    // fixture.stops, because the assertion above narrowed `stops` to never[].
    assert(!fixture.stops.includes(leaky.workerId), "a release asked a terminated worker to stop");
    const closed = await leaky.terminate("operator");
    assert.notEqual(closed.completedAt, undefined);
    assert.equal(closed.reason, "worker-unreachable");
    assert.deepEqual(closed.containers, ["pi-task-leaky-a", "pi-task-leaky-b"]);
    // What the kill could not confirm stays on the record; the retry cannot
    // reach it again.
    assert.deepEqual(closed.errors, ["kill worker docker-worker-3: fixture survivor 4242"]);
    assert.deepEqual(steps, [
      "kill docker-worker-3",
      "remove pi-task-leaky-a",
      "remove pi-task-leaky-b",
      "remove pi-task-leaky-b",
      "remove pi-task-leaky-b",
    ]);
    assert.equal(leaky.released, true);
    assert(disposed.includes(leaky.workerId));
    await leaky.release("shutdown");
    assert.equal(steps.length, 5, "a release after a completed termination redid some of it");

    const unsandboxed = fixture.provisioner("plain", { PATH: process.env["PATH"] ?? "" });
    const plain = await unsandboxed.summon(request("terminate-plain"));
    const removalsBefore = removals.length;
    const plainTermination = await plain.terminate("worker-unreachable", { taskIds: ["plain-task"] });
    assert.deepEqual(plainTermination.containers, []);
    assert.equal(removals.length, removalsBefore);
    assert.equal(plain.released, true);
  });

  await check("local terminate after or beside a release removes the containers, and owns the directory", async () => {
    const fixture = terminateFixture(path.join(tmpRoot, "terminate-release"));
    const { request, steps, disposed } = fixture;
    const docker = fixture.provisioner("docker", {
      PATH: process.env["PATH"] ?? "",
      SANDBOX_MODE: "docker",
      CONTAINER_RUNTIME: "docker",
    });

    // A release kills what outlived its stop, looking before the root was
    // gone. Where it could not confirm the tree, a later terminate kills once
    // more, without the root, then removes the containers; what both kills
    // could not confirm stays on record. A retry of a finished termination
    // does neither again.
    fixture.survivors.set("docker-worker-1", ["fixture survivor 4343"]);
    const releasedFirst = await docker.summon(request("released-first"));
    await releasedFirst.release("shutdown");
    assert.equal(releasedFirst.released, true);
    assert.deepEqual(releasedFirst.releaseCaveats, [
      "release worker docker-worker-1: fixture survivor 4343",
    ]);
    const late = await releasedFirst.terminate("orphaned", { taskIds: ["late"] });
    assert.deepEqual(steps, ["sweep docker-worker-1", "kill docker-worker-1", "remove pi-task-late"]);
    assert.notEqual(late.completedAt, undefined);
    assert.deepEqual(late.errors, [
      "release worker docker-worker-1: fixture survivor 4343",
      "kill worker docker-worker-1: fixture root had exited before the kill",
    ]);
    assert.deepEqual(await releasedFirst.terminate("operator", { taskIds: ["late"] }), late);
    assert.equal(steps.length, 3, "a finished termination killed or removed again");

    // With the sandbox on and no task id, there is nothing to name a container
    // by, and the record says so.
    steps.length = 0;
    const unnamed = await docker.summon(request("unnamed"));
    const blind = await unnamed.terminate("worker-unreachable");
    assert.deepEqual(steps, ["kill docker-worker-2"]);
    assert.notEqual(blind.completedAt, undefined);
    assert.deepEqual(blind.containers, []);
    assert.match(blind.errors.join("\n"), /^remove containers: .*no task ids were given/);

    // A release under way when terminate() is called leaves the directory to
    // the termination, which removes it only after its container.
    steps.length = 0;
    const racing = await docker.summon(request("racing"));
    const stopping = gate();
    const removing = gate();
    fixture.stopGates.set(racing.workerId, stopping.promise);
    fixture.removalGates.set("pi-task-race", removing.promise);
    const releasing = racing.release("shutdown");
    const terminating = racing.terminate("cancel-unconfirmed", { taskIds: ["race"] });
    while (!steps.includes("remove pi-task-race")) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    stopping.open();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert(!disposed.includes(racing.workerId), "the release removed the directory first");
    removing.open();
    await releasing;
    const raced = await terminating;
    assert.notEqual(raced.completedAt, undefined);
    assert.equal(raced.reason, "cancel-unconfirmed");
    assert.equal(racing.released, true);
    assert.deepEqual(
      disposed.filter((workerId) => workerId === racing.workerId),
      [racing.workerId],
    );

    // Rootless podman keeps its state in the directory, so once a release has
    // removed that, podman is not asked, and the record says why. That
    // release's sweep came back clean, so nothing is killed again either.
    steps.length = 0;
    const podman = fixture.provisioner("podman", {
      PATH: process.env["PATH"] ?? "",
      SANDBOX_MODE: "docker",
    });
    const stateless = await podman.summon(request("stateless"));
    await stateless.release("shutdown");
    const unreachable = await stateless.terminate("orphaned", { taskIds: ["gone"] });
    assert.deepEqual(steps, ["sweep podman-worker-1"]);
    assert.notEqual(unreachable.completedAt, undefined);
    assert.deepEqual(unreachable.containers, ["pi-task-gone"]);
    assert.deepEqual(unreachable.errors, [
      "remove container pi-task-gone: not attempted, because release() had already removed " +
        "the runtime directory and rootless podman's state in it; it may still be running",
    ]);
  });

  await check("a tree kill whose root had already exited says so, and a reused service is not killed", async () => {
    // A real process that has exited, so whatever this host's kill path is runs.
    const exited = spawn(process.execPath, ["-e", ""], { stdio: "ignore", windowsHide: true });
    await new Promise((resolve) => exited.once("exit", resolve));
    assert.notEqual(exited.pid, undefined);
    const notes = await killProcessTree(exited.pid, { rootExited: () => true, graceMs: 100 });
    assert.match(notes[0] ?? "", /^the root had exited before the kill, so its tree /);
    assert.match((await killProcessTree(undefined))[0] ?? "", /root had exited before the kill/);

    const reused = await bootstrapLing({
      client: {
        health: async () => ({ ok: true as const, queued: 0 }),
        list: async () => [],
      } as unknown as LingClient,
      token: "fixture-token",
      baseUrl: "http://127.0.0.1:1",
    });
    assert.equal(reused.startedByOverlord, false);
    assert.deepEqual(await reused.kill(), [
      "the service at http://127.0.0.1:1 was already running, so nothing was killed",
    ]);
    assert.deepEqual(await reused.stopTree(), [
      "the service at http://127.0.0.1:1 was already running, so nothing was killed",
    ]);
  });

  await check("a stop with a sweep kills what the root left running, looking before it stopped", async () => {
    // A real root that starts a detached sleeper, as a finished task's
    // backgrounded server would be, and on SIGTERM exits without it. POSIX
    // stops the root gracefully and then must find the sleeper from the look
    // it took before, since its parent is gone by then; Windows has no
    // graceful stop and kills the tree from the live root instead.
    const posix = process.platform !== "win32";
    const root = spawn(
      process.execPath,
      [
        "-e",
        [
          'const { spawn } = require("node:child_process");',
          'const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"],',
          '  { detached: true, stdio: "ignore", windowsHide: true });',
          'process.stdout.write(`${sleeper.pid}\\n`);',
          "setInterval(() => {}, 1 << 30);",
        ].join("\n"),
      ],
      { detached: posix, stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    let rootExited = false;
    root.once("exit", () => {
      rootExited = true;
    });
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const settled = async (condition: () => boolean) => {
      const deadline = Date.now() + 10_000;
      while (!condition() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return condition();
    };
    let sleeper: number | undefined;
    try {
      sleeper = await new Promise<number>((resolve, reject) => {
        let output = "";
        root.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString("utf8");
          if (output.includes("\n")) resolve(Number(output.trim()));
        });
        root.once("exit", () => reject(new Error("the root exited before starting its sleeper")));
      });
      assert(Number.isSafeInteger(sleeper) && alive(sleeper));
      let stops = 0;
      const notes = await killProcessTree(root.pid, {
        groupLeader: posix,
        graceMs: 1_000,
        rootExited: () => rootExited,
        stopRoot: async () => {
          stops += 1;
          root.kill("SIGTERM");
          await settled(() => rootExited);
        },
      });
      assert.deepEqual(notes, []);
      assert.equal(stops, posix ? 1 : 0);
      assert(await settled(() => rootExited), "the root outlived the stop");
      const sleeperPid = sleeper;
      assert(await settled(() => !alive(sleeperPid)), "the sleeper outlived the sweep");
    } finally {
      if (!rootExited) root.kill("SIGKILL");
      if (sleeper !== undefined && alive(sleeper)) process.kill(sleeper, "SIGKILL");
    }
  });

  await check("a kill taskkill cannot make still ends the root, and says what it could not", async () => {
    // A real owned root. On Windows taskkill is found under SystemRoot, so
    // pointing that nowhere is a taskkill that cannot run; POSIX does not use
    // it, and its kill must simply work as before.
    let probes = 0;
    const runtime = await bootstrapLing({
      client: {
        health: async () => {
          probes += 1;
          if (probes === 1) throw new LingClientError("offline", undefined, true);
          return { ok: true as const, queued: 0 };
        },
        list: async () => [],
      } as unknown as LingClient,
      token: "fixture-token",
      lingDir: process.cwd(),
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1 << 30)"],
      startupTimeoutMs: 5_000,
      killGraceMs: 100,
    });
    assert.equal(runtime.startedByOverlord, true);
    const pid = runtime.pid;
    assert(pid !== undefined);
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const systemRoot = process.env["SystemRoot"];
    process.env["SystemRoot"] = path.join(tmpRoot, "no-system-root");
    let survived = true;
    const notes = await runtime.kill().finally(() => {
      if (systemRoot === undefined) delete process.env["SystemRoot"];
      else process.env["SystemRoot"] = systemRoot;
      survived = alive();
      // A root the kill missed would hold this check open.
      if (survived) process.kill(pid, "SIGKILL");
    });
    assert.equal(survived, false, "the root outlived the kill");
    if (process.platform === "win32") {
      assert.equal(notes.length, 2, notes.join("; "));
      assert.match(notes[0] ?? "", /^taskkill could not run: /);
      assert.equal(
        notes[1],
        "the root outlived taskkill and was terminated through its own handle, so what its " +
          "tree started detached, or through a shell, may still be running",
      );
    } else {
      assert.deepEqual(notes, []);
    }
  });

  await check("local children get a named environment and no copied .env", async () => {
    const sourceLingDir = path.join(tmpRoot, "allowlist-source-ling");
    await mkdir(path.join(sourceLingDir, "agent", "skills", "fixture"), { recursive: true });
    await writeFile(path.join(sourceLingDir, "agent", "skills", "fixture", "SKILL.md"), "fixture");
    await writeFile(
      path.join(sourceLingDir, ".env"),
      [
        "ANTHROPIC_API_KEY=dotenv-anthropic",
        "OPENAI_API_KEY=dotenv-openai",
        "GROQ_API_KEY=dotenv-groq",
        "SANDBOX_MODE=docker",
        "MAX_COST_USD=0.5",
        "BLOCK_PRIVATE_NETWORK=false",
        'AGENT_TOKENS_JSON={"intruder":"dotenv-token-that-must-not-cross"}',
        "OVERLORD_BRAIN_API_KEY=dotenv-brain-key",
      ].join("\n"),
    );
    const captured: LingBootstrapOptions[] = [];
    let workers = 0;
    let port = 44_300;
    const provisioner = new LocalTaskProvisioner({
      sourceLingDir,
      runtimeRootDir: path.join(tmpRoot, "allowlist-workers"),
      env: {
        PATH: "fixture-path",
        OVERLORD_BRAIN_API_KEY: "dummy-brain-key",
        LING_TOKEN: "dummy-ling-token",
        LING_WORKERS_JSON: '[{"id":"w","baseUrl":"http://w","token":"dummy-fleet-token"}]',
        CAMPAIGN_PROGRESS_WEBHOOK_TOKEN: "dummy-webhook-token",
        OPENROUTER_API_KEY: "dummy-openrouter-key",
        ANTHROPIC_API_KEY: "env-anthropic",
        MAX_TURNS: "7",
        LING_SHUTDOWN_TIMEOUT_MS: "1234",
      },
      portFactory: async () => (port += 1),
      tokenFactory: async () => `allowlist-token-${workers}`,
      workerIdFactory: async () => `allowlist-worker-${(workers += 1)}`,
      bootstrap: async (options) => {
        captured.push(options);
        const lingDir = options.lingDir ?? "";
        assert.equal(existsSync(path.join(lingDir, ".env")), false, ".env was copied");
        assert.equal(existsSync(path.join(lingDir, "agent", "skills", "fixture", "SKILL.md")), true);
        return {
          client: new FakeWorkerClient(options.env?.["WORKER_ID"] ?? ""),
          startedByOverlord: true,
          stop: async () => undefined,
          kill: async () => [],
          stopTree: async () => [],
        };
      },
    });
    const request = (requestKey: string, provider?: string): LingProvisionRequest => ({
      requestKey,
      profile: { profileId: "builder", tools: ["read"], ...(provider === undefined ? {} : { provider }) },
      createdAt: "2026-08-25T18:00:00.000Z",
      expiresAt: "2026-08-25T19:00:00.000Z",
    });
    const anthropic = await provisioner.summon(request("allowlist-anthropic", "anthropic"));
    const fallback = await provisioner.summon(request("allowlist-default"));

    const env = captured[0]?.env ?? {};
    assert.deepEqual(Object.keys(env).sort(), [
      "AGENT_PROVIDER",
      "AGENT_TOKEN",
      "AGENT_TOKENS_JSON",
      "ALLOW_INLINE_SKILLS",
      "ANTHROPIC_API_KEY",
      "BLOCK_PRIVATE_NETWORK",
      "HOME",
      "LING_PARENT_PID",
      "MAX_CONCURRENCY",
      "MAX_COST_USD",
      "MAX_TURNS",
      "PATH",
      "PLAYWRIGHT_BROWSERS_PATH",
      "SANDBOX_MODE",
      "TEMP",
      "TMP",
      "TMPDIR",
      "WORKER_ID",
    ]);
    assert.equal(env["LING_PARENT_PID"], String(process.pid), "the child is not told which process to exit with");
    assert.equal(env["ANTHROPIC_API_KEY"], "env-anthropic", "the overlord's value wins over .env");
    assert.equal(env["AGENT_PROVIDER"], "anthropic");
    assert.match(env["AGENT_TOKEN"] ?? "", /^allowlist-token-/);
    assert.deepEqual(JSON.parse(env["AGENT_TOKENS_JSON"] ?? "{}"), {
      overlord: env["AGENT_TOKEN"],
    });
    assert.equal(env["SANDBOX_MODE"], "docker", "ling's own settings still come from its .env");
    assert.equal(env["MAX_COST_USD"], "0.5");
    assert.equal(env["MAX_TURNS"], "7");
    // The operator's setting still reaches the child; ling's own default
    // applies only where neither ling/.env nor the overlord sets one.
    assert.equal(env["BLOCK_PRIVATE_NETWORK"], "false");
    assert.equal(captured[0]?.ownProcessGroup, true);
    assert.equal(captured[0]?.processMarker, `WORKER_ID=${anthropic.workerId}`);
    assert.equal(captured[0]?.shutdownTimeoutMs, 1234);

    const fallbackEnv = captured[1]?.env ?? {};
    assert.equal(fallbackEnv["AGENT_PROVIDER"], undefined);
    assert.equal(fallbackEnv["OPENAI_API_KEY"], "dotenv-openai", "ling's default provider gets its key");
    assert.equal(fallbackEnv["ANTHROPIC_API_KEY"], undefined);

    const everything = JSON.stringify(captured.map((options) => options.env));
    for (const secret of ["dummy-", "dotenv-brain", "dotenv-groq", "must-not-cross"]) {
      assert(!everything.includes(secret), `${secret} reached a child`);
    }

    await anthropic.release("shutdown");
    await fallback.release("shutdown");
    assert.deepEqual(await readdir(path.join(tmpRoot, "allowlist-workers")), []);
  });

  await check("a local lease's ceilings are its task's own limits, set over ling's settings", async () => {
    const sourceLingDir = path.join(tmpRoot, "ceilings-source-ling");
    await mkdir(sourceLingDir, { recursive: true });
    await writeFile(
      path.join(sourceLingDir, ".env"),
      ["MAX_TURNS=3", "MAX_TOOL_RESULT_CHARS=8000"].join("\n"),
    );
    const captured = new Map<string, NodeJS.ProcessEnv>();
    let workers = 0;
    let port = 44_400;
    const provisioner = (env: NodeJS.ProcessEnv) =>
      new LocalTaskProvisioner({
        sourceLingDir,
        env: { PATH: "fixture-path", ...env },
        portFactory: async () => (port += 1),
        workerIdFactory: async () => `ceilings-worker-${(workers += 1)}`,
        runtimeDirectoryFactory: async (_request, workerId) => ({
          path: path.join(tmpRoot, "ceilings-workers", workerId),
          dispose: async () => undefined,
        }),
        bootstrap: async (options) => {
          captured.set(options.env?.["WORKER_ID"] ?? "", options.env ?? {});
          return {
            client: new FakeWorkerClient(options.env?.["WORKER_ID"] ?? ""),
            startedByOverlord: true,
            stop: async () => undefined,
            kill: async () => [],
            stopTree: async () => [],
          };
        },
      });
    const summon = async (
      local: LocalTaskProvisioner,
      requestKey: string,
      input: Omit<SpawnInput, "task" | "requestKey">,
    ) => {
      const lease = await local.summon({
        requestKey,
        profile: resolvedWorkerProfileFromSpawnInput({ task: "t", requestKey, ...input }),
        createdAt: "2026-08-25T18:00:00.000Z",
        expiresAt: "2026-08-25T19:00:00.000Z",
      });
      return captured.get(lease.workerId) ?? {};
    };
    const ceilings = (env: NodeJS.ProcessEnv) =>
      Object.fromEntries(
        ["MAX_TURNS", "MAX_WALL_CLOCK_MS", "MAX_COST_USD", "MAX_TOOL_RESULT_CHARS"].map((name) => [
          name,
          env[name],
        ]),
      );
    const local = provisioner({
      MAX_COST_USD: "0.5",
      OVERSIGHT_ADVICE_WAIT_MS: "15000",
      OVERSIGHT_WATCH_IDLE_MS: "45000",
    });

    // A watcher's spawn input for a worker at the builder default of 600 000
    // ms: every limit is above ling's defaults (40 turns, 900 000 ms), and the
    // oversight tools need MAX_TOOL_RESULT_CHARS of at least 12 000.
    const watcher = await summon(local, "ceilings-watcher", {
      tools: ["watch_next", "advise", "caution", "hold", "release", "report_concern", "write_result"],
      maxTurns: 154,
      maxWallClockMs: 1_620_000,
      maxCostUsd: 0.75,
    });
    assert.deepEqual(ceilings(watcher), {
      MAX_TURNS: "154",
      MAX_WALL_CLOCK_MS: "1620000",
      MAX_COST_USD: "0.75",
      MAX_TOOL_RESULT_CHARS: "12000",
    });
    assert.equal(watcher["OVERSIGHT_ADVICE_WAIT_MS"], "15000");
    assert.equal(watcher["OVERSIGHT_WATCH_IDLE_MS"], "45000");
    // The worker's lease gets its own limits, which are what it asks for.
    const worker = await summon(local, "ceilings-worker", {
      tools: ["read", "write", "ask_overseer", "tell_principal"],
      maxTurns: 24,
      maxWallClockMs: 600_000,
      maxCostUsd: 0.75,
    });
    assert.deepEqual(ceilings(worker), {
      MAX_TURNS: "24",
      MAX_WALL_CLOCK_MS: "600000",
      MAX_COST_USD: "0.75",
      MAX_TOOL_RESULT_CHARS: "12000",
    });
    // A limit left unset keeps the inherited ceiling, an integer one rounds up
    // rather than refuse the request it came from, and without an oversight
    // tool MAX_TOOL_RESULT_CHARS is ling's setting.
    const builder = await summon(local, "ceilings-builder", { tools: ["read"], maxTurns: 24.5 });
    assert.deepEqual(ceilings(builder), {
      MAX_TURNS: "25",
      MAX_WALL_CLOCK_MS: undefined,
      MAX_COST_USD: "0.5",
      MAX_TOOL_RESULT_CHARS: "8000",
    });
    const unlimited = await summon(local, "ceilings-unlimited", { tools: ["read"] });
    assert.equal(unlimited["MAX_TURNS"], "3");
    // A larger inherited MAX_TOOL_RESULT_CHARS is never lowered.
    const roomy = await summon(provisioner({ MAX_TOOL_RESULT_CHARS: "20000" }), "ceilings-roomy", {
      tools: ["watch_next", "report_concern", "write_result"],
    });
    assert.equal(roomy["MAX_TOOL_RESULT_CHARS"], "20000");
  });

  await check("a local child gets the reviewed skills, its own provider's credential and only the browser login its task names", async () => {
    const sourceLingDir = path.join(tmpRoot, "copy-source-ling");
    const openaiEntry = { type: "api_key", key: "dummy-openai-credential" };
    const groqEntry = { type: "oauth", access: "dummy-groq-access", refresh: "r", expires: 1 };
    const sourceFiles: Record<string, string> = {
      "agent/skills/fixture/SKILL.md": "fixture skill",
      "agent/settings.json": '{"retry":{"enabled":true}}',
      // With a byte-order mark, which Pi reads past.
      "agent/auth.json":
        String.fromCharCode(0xfeff) + JSON.stringify({ openai: openaiEntry, groq: groqEntry }),
      "agent/models.json": '{"providers":{"custom":{"apiKey":"dummy-custom-key"}}}',
      "agent/models-store.json": "{}",
      "auth/site.json": '{"cookies":["site"]}',
      "auth/other.json": '{"cookies":["other"]}',
      "auth/team/shared.json": '{"cookies":["shared"]}',
      "recipes/fixture.json": "{}",
    };
    for (const [name, content] of Object.entries(sourceFiles)) {
      await mkdir(path.dirname(path.join(sourceLingDir, name)), { recursive: true });
      await writeFile(path.join(sourceLingDir, name), content);
    }
    const workersDir = path.join(tmpRoot, "copy-workers");
    const trees = new Map<string, Record<string, string>>();
    let workers = 0;
    let port = 44_500;
    const provisioner = new LocalTaskProvisioner({
      sourceLingDir,
      runtimeRootDir: workersDir,
      env: { PATH: "fixture-path" },
      portFactory: async () => (port += 1),
      workerIdFactory: async () => `copy-worker-${(workers += 1)}`,
      bootstrap: async (options) => {
        const lingDir = options.lingDir ?? "";
        const tree: Record<string, string> = {};
        for (const entry of await readdir(lingDir, { recursive: true, withFileTypes: true })) {
          if (!entry.isFile()) continue;
          const file = path.join(entry.parentPath, entry.name);
          tree[path.relative(lingDir, file).split(path.sep).join("/")] = await readFile(file, "utf8");
        }
        trees.set(options.env?.["WORKER_ID"] ?? "", tree);
        return {
          client: new FakeWorkerClient(options.env?.["WORKER_ID"] ?? ""),
          startedByOverlord: true,
          stop: async () => undefined,
          kill: async () => [],
          stopTree: async () => [],
        };
      },
    });
    const summon = (requestKey: string, storageState?: string, provider?: string) =>
      provisioner.summon({
        requestKey,
        profile: {
          profileId: "browser",
          tools: ["browser_open"],
          ...(storageState === undefined ? {} : { storageState }),
          ...(provider === undefined ? {} : { provider }),
        },
        createdAt: "2026-08-25T18:00:00.000Z",
        expiresAt: "2026-08-25T19:00:00.000Z",
      });
    const credential = (provider: string, entry: unknown) => ({
      "agent/auth.json": `${JSON.stringify({ [provider]: entry }, null, 2)}\n`,
    });
    const shared = {
      "agent/skills/fixture/SKILL.md": "fixture skill",
      "agent/settings.json": '{"retry":{"enabled":true}}',
      "recipes/fixture.json": "{}",
    };

    // Of Pi's credentials only the entry of the provider the child runs,
    // ling's default here; never the model cache, the custom models or
    // another provider's entry; and no login unless one is named.
    const plain = await summon("copy-plain");
    assert.deepEqual(trees.get(plain.workerId), { ...shared, ...credential("openai", openaiEntry) });
    const groq = await summon("copy-groq", undefined, "groq");
    assert.deepEqual(trees.get(groq.workerId), { ...shared, ...credential("groq", groqEntry) });
    // A provider the store has no entry for gets no store.
    const bare = await summon("copy-bare", undefined, "anthropic");
    assert.deepEqual(trees.get(bare.workerId), shared);
    const site = await summon("copy-site", "site", "anthropic");
    assert.deepEqual(trees.get(site.workerId), {
      ...shared,
      "auth/site.json": '{"cookies":["site"]}',
    });
    const nested = await summon("copy-nested", "team/shared.json", "anthropic");
    assert.deepEqual(trees.get(nested.workerId), {
      ...shared,
      "auth/team/shared.json": '{"cookies":["shared"]}',
    });
    // A login that is not there is the child's to report, as before.
    const missing = await summon("copy-missing", "absent", "anthropic");
    assert.deepEqual(trees.get(missing.workerId), shared);
    // A name that leads out of auth/ copies nothing and starts nothing.
    const before = await readdir(workersDir);
    await assert.rejects(
      summon("copy-escape", "../agent/auth"),
      (error: unknown) =>
        error instanceof LingProvisionerError &&
        error.code === "invalid_request" &&
        /outside ling's auth directory/.test(error.message),
    );
    assert.deepEqual(await readdir(workersDir), before);
    // A credential store Pi could not read fails the summon before anything
    // starts, as it would have failed the child.
    await writeFile(path.join(sourceLingDir, "agent", "auth.json"), "{not json");
    await assert.rejects(
      summon("copy-unreadable"),
      /^Error: Cannot take provider openai's entry from .*auth\.json: /,
    );
    assert.deepEqual(await readdir(workersDir), before);
    assert.equal(trees.size, 6);

    for (const lease of [plain, groq, bare, site, nested, missing]) {
      await lease.release("collection-complete");
    }
    assert.deepEqual(await readdir(workersDir), []);
  });

  await check("a local release stops the worker, sweeps its tree, and only then removes the directory", async () => {
    const fixture = terminateFixture(path.join(tmpRoot, "release-sweep"));
    const { request, steps, stops, disposed } = fixture;
    const plain = fixture.provisioner("sweep", { PATH: process.env["PATH"] ?? "" });

    const clean = await plain.summon(request("sweep-clean"));
    await clean.release("collection-complete");
    assert.deepEqual(steps, ["sweep sweep-worker-1"]);
    assert.deepEqual(stops, ["sweep-worker-1"]);
    assert.deepEqual(disposed, ["sweep-worker-1"]);
    assert.equal(clean.released, true);
    assert.deepEqual(clean.releaseCaveats, []);
    await clean.release("collection-complete");
    assert.equal(steps.length, 1, "a second release swept again");

    // What the sweep could not confirm is kept on the lease.
    fixture.survivors.set("sweep-worker-2", ["fixture survivor 4444"]);
    const leaky = await plain.summon(request("sweep-leaky"));
    await leaky.release("task-failed");
    assert.equal(leaky.released, true);
    assert.deepEqual(leaky.releaseCaveats, ["release worker sweep-worker-2: fixture survivor 4444"]);

    // A sweep that cannot confirm the root gone keeps the directory, and the
    // release can be retried.
    fixture.failSweep.add("sweep-worker-3");
    const stubborn = await plain.summon(request("sweep-stubborn"));
    await assert.rejects(stubborn.release("task-cancelled"), /fixture sweep failure/);
    assert.equal(stubborn.released, false);
    assert(
      !disposed.includes(stubborn.workerId),
      "the directory went before the tree was confirmed dead",
    );
    await stubborn.release("task-cancelled");
    assert.equal(stubborn.released, true);
    assert.deepEqual(
      steps.filter((step) => step === "sweep sweep-worker-3"),
      ["sweep sweep-worker-3", "sweep sweep-worker-3"],
    );
    assert(disposed.includes(stubborn.workerId));
  });

  await check("a local summon that fails after its child started sweeps the tree as a release does", async () => {
    let stopped = 0;
    let swept = 0;
    let disposed = 0;
    /** What the next sweep and directory removal do: return notes, or fail. */
    let sweepOutcome: string[] | Error = [];
    let disposeFails = false;
    let workers = 0;
    let port = 44_600;
    const provisioner = new LocalTaskProvisioner({
      sourceLingDir: path.join(tmpRoot, "failed-summon-source"),
      env: { PATH: "fixture-path" },
      portFactory: async () => (port += 1),
      workerIdFactory: async () => `failed-summon-worker-${(workers += 1)}`,
      runtimeDirectoryFactory: async (_request, workerId) => ({
        path: path.join(tmpRoot, "failed-summon-workers", workerId),
        dispose: async () => {
          disposed += 1;
          if (disposeFails) throw new Error("fixture directory held open");
        },
      }),
      bootstrap: async () => ({
        // A child that answers as some other worker.
        client: new FakeWorkerClient("someone-else"),
        startedByOverlord: true,
        stop: async () => {
          stopped += 1;
        },
        kill: async () => [],
        stopTree: async () => {
          swept += 1;
          if (sweepOutcome instanceof Error) throw sweepOutcome;
          return sweepOutcome;
        },
      }),
    });
    const logged: string[] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    const failSummon = (requestKey: string, worker: number) =>
      assert.rejects(
        provisioner.summon({
          requestKey,
          profile: { profileId: "builder", tools: ["read"] },
          createdAt: "2026-08-25T18:00:00.000Z",
          expiresAt: "2026-08-25T19:00:00.000Z",
        }),
        new RegExp(`reported id someone-else, expected failed-summon-worker-${worker}\\.$`),
      );
    const reported = (index: number) =>
      JSON.parse((logged[index] ?? "").replace(/^PROVISIONER_RELEASE_CAVEATS /, "")) as unknown;
    try {
      // A clean teardown says nothing.
      await failSummon("failed-summon-clean", 1);
      assert.deepEqual({ stopped, swept, disposed }, { stopped: 0, swept: 1, disposed: 1 });
      assert.deepEqual(logged, []);

      // What the teardown could not confirm is reported, and the summon's own
      // error is still what the caller gets.
      sweepOutcome = ["fixture survivor 4848"];
      await failSummon("failed-summon-leaky", 2);
      assert.equal(logged.length, 1);
      assert.match(logged[0] ?? "", /^PROVISIONER_RELEASE_CAVEATS /);
      assert.deepEqual(reported(0), {
        workerId: "failed-summon-worker-2",
        taskId: null,
        requestKey: "failed-summon-leaky",
        reason: "spawn-failed",
        released: true,
        caveats: ["release worker failed-summon-worker-2: fixture survivor 4848"],
      });

      // A root the sweep cannot confirm gone, and a directory that cannot go,
      // are reported as a release that did not finish.
      sweepOutcome = new Error("fixture root still running");
      disposeFails = true;
      await failSummon("failed-summon-stuck", 3);
      assert.deepEqual(reported(1), {
        workerId: "failed-summon-worker-3",
        taskId: null,
        requestKey: "failed-summon-stuck",
        reason: "spawn-failed",
        released: false,
        caveats: [
          "release worker failed-summon-worker-3: fixture root still running",
          "remove runtime directory: fixture directory held open",
        ],
      });
    } finally {
      console.error = consoleError;
    }
    assert.equal(stopped, 0);
    assert.deepEqual(provisioner.leases(), []);
  });

  await check("a POSIX tree kill reaches detached bash groups and marked orphans, never the overlord or its tools", () => {
    // Shaped like a local child under Pi: tsx leads the child's group and runs
    // the server inside it, each bash command leads a group of its own, and a
    // job backgrounded by a bash that has since exited is parented to init.
    const rows = [
      { pid: 100, ppid: 1, pgid: 100, marked: false }, // the overlord
      { pid: 101, ppid: 100, pgid: 100, marked: false }, // a helper in the overlord's group
      { pid: 200, ppid: 100, pgid: 200, marked: true }, // tsx, the lease's root
      { pid: 201, ppid: 200, pgid: 200, marked: true }, // the ling server
      { pid: 300, ppid: 201, pgid: 300, marked: true }, // a bash command, detached by Pi
      { pid: 301, ppid: 300, pgid: 300, marked: true },
      { pid: 400, ppid: 1, pgid: 399, marked: true }, // a job whose bash exited
      { pid: 401, ppid: 1, pgid: 399, marked: false }, // the same, environment cleared
      { pid: 600, ppid: 100, pgid: 600, marked: false }, // another lease's root
      { pid: 601, ppid: 600, pgid: 600, marked: false },
      // A container removal the overlord runs for this lease, and what it
      // starts, had it been given the child's environment: the overlord's own
      // tools are never the task's.
      { pid: 700, ppid: 100, pgid: 100, marked: true },
      { pid: 701, ppid: 700, pgid: 100, marked: true },
    ];
    const sorted = (values: number[]) => [...values].sort((left, right) => left - right);
    const root = { pid: 200, exited: false, groupLeader: true };
    const live = processTreeTargets(rows, root, 100);
    assert.deepEqual(sorted(live.pids), [200, 201, 300, 301, 400]);
    assert.deepEqual(sorted(live.groups), [200, 300]);
    // The documented gap: an orphan that cleared its environment is not found.
    assert(!live.pids.includes(401));
    // A live root's group is signalled even when the table shows nothing.
    assert.deepEqual(processTreeTargets([], root, 100), { pids: [200], groups: [200] });

    // A reaped root is not signalled by its pid, which may be reused; what is
    // left in its group, what that started and what carries the marker are.
    const gone = { ...root, exited: true };
    const reapedRows = rows
      .filter((row) => row.pid !== 200)
      .map((row) => (row.pid === 201 ? { ...row, ppid: 1 } : row));
    const reaped = processTreeTargets(reapedRows, gone, 100);
    assert.deepEqual(sorted(reaped.pids), [201, 300, 301, 400]);
    assert.deepEqual(sorted(reaped.groups), [200, 300]);
    // Off Linux nothing is marked, so the group is the only way left in, and
    // the backgrounded job is out of reach.
    const unmarked = reapedRows.map((row) => ({ ...row, marked: false }));
    const unmarkedReaped = processTreeTargets(unmarked, gone, 100);
    assert.deepEqual(sorted(unmarkedReaped.pids), [201, 300, 301]);
    assert.deepEqual(sorted(unmarkedReaped.groups), [200, 300]);
    // Once the group has emptied, the root's pid can be a stranger's, leading
    // a group of the same id; neither is touched.
    const strangerRows = [
      ...reapedRows.filter((row) => row.pgid !== 200),
      { pid: 200, ppid: 77, pgid: 200, marked: false },
      { pid: 202, ppid: 200, pgid: 200, marked: false },
    ];
    const stranger = processTreeTargets(strangerRows, gone, 100);
    assert.deepEqual(sorted(stranger.pids), [300, 301, 400]);
    assert.deepEqual(sorted(stranger.groups), [300]);
    // A root that was not a group leader leaves no group to look in.
    const ungrouped = processTreeTargets(unmarked, { ...gone, groupLeader: false }, 100);
    assert.deepEqual(ungrouped, { pids: [], groups: [] });

    // An overlord running as pid 1 inherits orphans, so its marked children
    // are what the marker is for.
    const init = processTreeTargets(
      [
        { pid: 1, ppid: 0, pgid: 1, marked: false },
        { pid: 200, ppid: 1, pgid: 200, marked: true },
        { pid: 400, ppid: 1, pgid: 399, marked: true },
        { pid: 500, ppid: 1, pgid: 500, marked: false },
      ],
      root,
      1,
    );
    assert.deepEqual(sorted(init.pids), [200, 400]);
  });

  await check("a POSIX tree kill sends SIGKILL only to what is provably the process it first saw", () => {
    const table = (rows: ProcessTableRow[]) => new Map(rows.map((row) => [row.pid, row]));
    const sorted = (values: number[]) => [...values].sort((left, right) => left - right);
    const noneAlive = () => false;
    const first = {
      pids: [200, 201, 300, 301, 500, 600],
      groups: [200, 300, 500, 600],
      rows: table([
        { pid: 200, ppid: 100, pgid: 200, started: "t200", marked: false }, // the root
        { pid: 201, ppid: 200, pgid: 200, started: "t201", marked: false }, // the server
        { pid: 300, ppid: 201, pgid: 300, started: "t300", marked: false }, // a detached bash
        { pid: 301, ppid: 300, pgid: 300, started: "t301", marked: false },
        { pid: 500, ppid: 201, pgid: 500, started: "t500", marked: false }, // another, alone
        { pid: 600, ppid: 201, pgid: 600, started: "t600", marked: false }, // and another
      ]),
    };
    // After the grace the root has exited; the server and 301 survived and were
    // reparented; 300 exited, leaving its group to 301; 500 exited and its pid
    // went to a stranger; 600 exited and a stranger took its pid and its group id.
    const after = {
      pids: [],
      groups: [],
      rows: table([
        { pid: 201, ppid: 1, pgid: 200, started: "t201", marked: false },
        { pid: 301, ppid: 1, pgid: 300, started: "t301", marked: false },
        { pid: 500, ppid: 77, pgid: 77, started: "t-stranger", marked: false },
        { pid: 600, ppid: 1, pgid: 600, started: "t-stranger", marked: false },
      ]),
    };
    const rootGone = sigkillTargets(first, after, 200, () => true, noneAlive);
    assert.deepEqual(sorted(rootGone.pids), [201, 301]);
    assert.deepEqual(sorted(rootGone.groups), [200, 300]);
    // The root's handle, not its pid, says whether it is still the root.
    const rootRows = new Map(after.rows);
    rootRows.set(200, { pid: 200, ppid: 100, pgid: 200, started: "t200", marked: false });
    const rootLive = sigkillTargets(first, { ...after, rows: rootRows }, 200, () => false, noneAlive);
    assert.deepEqual(sorted(rootLive.pids), [200, 201, 301]);
    const reused = new Map(after.rows);
    reused.delete(201);
    reused.set(200, { pid: 200, ppid: 1, pgid: 200, started: "t-stranger", marked: false });
    const rootReused = sigkillTargets(first, { ...after, rows: reused }, 200, () => true, noneAlive);
    assert(!rootReused.pids.includes(200) && !rootReused.groups.includes(200));
    // What the second look found is signalled whatever the first saw.
    const forked = sigkillTargets(first, { ...after, pids: [700], groups: [700] }, 200, () => true);
    assert(forked.pids.includes(700) && forked.groups.includes(700));
  });

  await check("product snapshots overlay atomically and expose bounded context", async () => {
    const objectiveRoot = path.join(tmpRoot, "objective");
    const objectiveStore = new ObjectiveManifestStore(
      path.join(objectiveRoot, "objective.json"),
    );
    await initializeObjective(objectiveStore, {
      id: "objective-one",
      charter: {
        statement: "Ship the thing.",
        budget: { maxTotalCostUsd: 10, maxTotalTokens: null },
      },
    });

    const first = await completedCampaign(
      path.join(tmpRoot, "campaign-one"),
      "campaign-one",
      { "app.txt": "secret-one" },
    );
    const firstSnapshots = new ProductSnapshotStore(
      path.join(objectiveRoot, "product"),
      objectiveStore,
      first.artifacts,
      (value) => value.replaceAll("secret", "[redacted]"),
    );
    const staleObjective = await objectiveStore.load();
    const promotedFirst = await firstSnapshots.promote(first.manifest);
    assert.equal(promotedFirst.manifest.parent, null);
    assert.equal(
      (await firstSnapshots.selectContext(["app.txt"]))["app.txt"],
      "[redacted]-one",
    );

    const second = await completedCampaign(
      path.join(tmpRoot, "campaign-two"),
      "campaign-two",
      { "README.md": "second" },
    );
    const secondSnapshots = new ProductSnapshotStore(
      path.join(objectiveRoot, "product"),
      objectiveStore,
      second.artifacts,
    );
    const promotedSecond = await secondSnapshots.promote(second.manifest);
    assert.equal(promotedSecond.manifest.files.length, 2);
    assert.deepEqual(await secondSnapshots.selectContext(["app.txt", "README.md"]), {
      "app.txt": "[redacted]-one",
      "README.md": "second",
    });
    await assert.rejects(
      objectiveStore.save(staleObjective),
      ObjectiveConcurrentModificationError,
    );
    const currentObjective = await objectiveStore.load();
    await assert.rejects(
      objectiveStore.compareAndSwapProductSnapshot(
        {
          ...currentObjective,
          currentProductSnapshot: promotedFirst.pointer,
        },
        promotedFirst.pointer,
      ),
      ObjectiveConcurrentModificationError,
    );
    await assert.rejects(
      secondSnapshots.selectContext(["missing.txt"]),
      (error: unknown) => error instanceof ProductSnapshotError && error.code === "missing",
    );

    const oversizedFiles = Array.from(
      { length: MAX_PRODUCT_SNAPSHOT_FILES + 1 },
      (_, index) => {
        const digest = createHash("sha256").update(`oversized-${index}`).digest("hex");
        const sourcePath = `file-${String(index).padStart(5, "0")}.txt`;
        return {
          path: sourcePath,
          artifact: {
            artifactId: `sha256:${digest}`,
            path: `artifacts/product/${digest}/${sourcePath}`,
            sha256: digest,
          },
        };
      },
    );
    assert.throws(
      () =>
        parseProductSnapshotManifest({
          version: 1,
          objectiveId: "objective-one",
          parent: promotedSecond.pointer,
          campaignId: "oversized",
          campaignUpdatedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          files: oversizedFiles,
        }),
      /must contain at most/,
    );
    assert.throws(
      () =>
        parseProductSnapshotManifest({
          version: 1,
          objectiveId: "x".repeat(MAX_PRODUCT_SNAPSHOT_MANIFEST_BYTES),
          parent: promotedSecond.pointer,
          campaignId: "oversized-metadata",
          campaignUpdatedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          files: [],
        }),
      /must encode to at most/,
    );
    const oversizedCampaign = structuredClone(second.manifest);
    oversizedCampaign.id = "oversized-campaign";
    oversizedCampaign.slices[0]!.attempts[0]!.artifacts = oversizedFiles.map(
      (file) => file.artifact,
    );
    await assert.rejects(
      secondSnapshots.promote(oversizedCampaign),
      (error: unknown) => error instanceof ProductSnapshotError && error.code === "limit",
    );

    const collision = await completedCampaign(
      path.join(tmpRoot, "campaign-collision"),
      "campaign-collision",
      { "duplicate.txt": "one" },
    );
    const collidingManifest = structuredClone(collision.manifest);
    const conflicting = await collision.artifacts.storeText(
      "fixture/conflict",
      "duplicate.txt",
      "two",
    );
    collidingManifest.slices.push({
      id: "02",
      spec: collidingManifest.slices[0]!.spec,
      status: "accepted",
      createdInRound: 0,
      attempts: [
        {
          round: 1,
          builderId: null,
          reviewerId: null,
          artifacts: [conflicting],
          verdict: "accept",
          evidence: ["fixture"],
          gaps: [],
          costUsd: 0,
        },
      ],
    });
    const collisionSnapshots = new ProductSnapshotStore(
      path.join(objectiveRoot, "product"),
      objectiveStore,
      collision.artifacts,
    );
    await assert.rejects(
      collisionSnapshots.promote(collidingManifest),
      (error: unknown) => error instanceof ProductSnapshotError && error.code === "collision",
    );
  });
} finally {
  await rm(tmpRoot, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} foundation check(s) failed`);
  process.exitCode = 1;
} else {
  console.log("\nall foundation checks passed");
}
