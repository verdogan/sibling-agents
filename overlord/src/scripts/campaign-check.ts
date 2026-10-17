import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { analyzeCampaignCoordination } from "../campaign/analysis.js";
import {
  ArtifactTransportError,
  CampaignArtifactStore,
  artifactRedactorFromEnv,
  assertSeedFileLimits,
} from "../campaign/artifacts.js";
import {
  CampaignBrainError,
  OpenAICompatibleBrain,
  campaignBrainFromEnv,
  resolveBrainEndpoint,
  type CampaignBrain,
  type CampaignBrainChoice,
  type CampaignBrainRequest,
} from "../campaign/brain.js";
import {
  campaignRequestKey,
  CampaignDriver,
  recoveryReconcileAt,
  type CampaignLingClient,
} from "../campaign/driver.js";
import { readEventRecord } from "../campaign/event-record.js";
import { DEFAULT_CAMPAIGN_ROLES, initializeCampaign } from "../campaign/initialize.js";
import { acquireCampaignLock, CampaignLockError } from "../campaign/lock.js";
import {
  CampaignManifestStore,
  ManifestConcurrentModificationError,
  transitionCampaign,
  transitionSlice,
} from "../campaign/manifest.js";
import { CampaignProgressReporter } from "../campaign/progress.js";
import { parseWorkerResult, WorkerResultError } from "../campaign/results.js";
import {
  CAMPAIGN_VERSION,
  assertCampaignTransition,
  CampaignSchemaError,
  parseCampaignManifest,
  type CampaignManifest,
} from "../campaign/schema.js";
import { LingClientError } from "../ling/client.js";
import { LingProvisionerError, type LingProvisionerErrorCode } from "../ling/provisioner.js";
import type {
  LingEvent,
  LingLogEvent,
  LingPeerMessage,
  LingPeerMessageResponse,
  LingTask,
  SpawnInput,
  SpawnResponse,
} from "../ling/types.js";
import { FleetLedgerStore } from "../ledger.js";
import { DEFAULT_ALLOWED_TOOLS, type SpawnPolicy } from "../policy.js";
import { ProfileLibrary } from "../profiles/index.js";

let failures = 0;
const execFileAsync = promisify(execFile);

async function check(label: string, run: () => void | Promise<void>): Promise<void> {
  try {
    await run();
    console.log(`PASS  ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${label} -- ${error instanceof Error ? error.message : String(error)}`);
  }
}

interface FakeOutcome {
  result: unknown;
  files?: Record<string, string>;
  cost?: number;
  status?: "completed" | "failed" | "cancelled" | "running";
  /** Return running from spawn, then settle to status after this delay. */
  settleAfterMs?: number;
  error?: string;
}

type FakeHandler = (input: SpawnInput, index: number) => FakeOutcome | Promise<FakeOutcome>;

class FakeLing implements CampaignLingClient {
  readonly inputs: SpawnInput[] = [];
  readonly cancelled: string[] = [];
  /** Every cancellation asked for, including the ones made to fail. */
  readonly cancelAttempts: string[] = [];
  readonly injectedMessages: Array<{ taskId: string; message: LingPeerMessage }> = [];
  readonly peerMessageAttempts: Array<{ taskId: string; message: LingPeerMessage }> = [];
  private readonly tasks = new Map<string, LingTask>();
  private peerMessageGate: Promise<void> | undefined;
  private statusGate: Promise<void> | undefined;
  private cancelAcknowledgeOnly = false;
  private cancellationFailuresRemaining = 0;
  private readonly scheduledEvents: Array<{
    taskId: string;
    minimumInputs: number;
    event: LingEvent;
    afterTerminal: boolean;
    emitted: boolean;
  }> = [];

  constructor(
    private readonly workspacesDir: string,
    private readonly handler: FakeHandler,
  ) {}

  /**
   * One recorded event log, returned for every task. Enough to prove the
   * declared-intent comparison runs and persists; which task saw which log is
   * `intent-check.ts`'s job, not this one's.
   */
  logEvents: LingLogEvent[] | undefined;
  private historyFails = false;

  seed(task: LingTask): void {
    this.tasks.set(task.id, task);
  }

  failHistory(): void {
    this.historyFails = true;
  }

  async history(_task: LingTask): Promise<LingLogEvent[]> {
    if (this.historyFails) throw new Error("history unavailable");
    return this.logEvents ?? [];
  }

  holdPeerMessages(): () => void {
    let release!: () => void;
    this.peerMessageGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return () => {
      release();
      this.peerMessageGate = undefined;
    };
  }

  /**
   * Wedge every status read until the returned function is called.
   *
   * This is what a partitioned or hung worker does to an overlord: the run loop is
   * inside a request that never comes back, so it cannot notice a shutdown, cancel
   * anything, or settle. Nothing short of this actually tests a bounded wait.
   */
  holdStatus(): () => void {
    let release!: () => void;
    this.statusGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return () => {
      release();
      this.statusGate = undefined;
    };
  }

  /**
   * Accept every cancellation and stop nothing, the way a real worker does: the API
   * answers 202 `cancelling` and abort is cooperative, so a task mid-turn keeps running
   * and keeps spending.
   */
  acknowledgeCancelWithoutStopping(): void {
    this.cancelAcknowledgeOnly = true;
  }

  failNextCancellations(count: number): void {
    this.cancellationFailuresRemaining = Math.max(0, count);
  }

  scheduleEvent(
    taskId: string,
    minimumInputs: number,
    event: LingEvent,
    afterTerminal = false,
  ): void {
    this.scheduledEvents.push({
      taskId,
      minimumInputs,
      event,
      afterTerminal,
      emitted: false,
    });
  }

  async spawn(input: SpawnInput): Promise<SpawnResponse> {
    this.inputs.push(input);
    const index = this.inputs.length;
    const id = `task-${String(index).padStart(2, "0")}`;
    const workspaceDir = path.join(this.workspacesDir, id);
    await mkdir(workspaceDir, { recursive: true });
    for (const [filename, content] of Object.entries(input.files ?? {})) {
      const target = path.join(workspaceDir, ...filename.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    }
    const outcome = await this.handler(input, index);
    for (const [filename, content] of Object.entries(outcome.files ?? {})) {
      const target = path.join(workspaceDir, ...filename.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    }
    const terminalStatus = outcome.status ?? "completed";
    const status = outcome.settleAfterMs === undefined ? terminalStatus : "running";
    const task: LingTask = {
      id,
      ...(input.requestKey === undefined ? {} : { requestKey: input.requestKey }),
      workerId: "local",
      status,
      prompt: input.task,
      options: {
        provider: input.provider,
        model: input.model,
        thinking: input.thinking,
        tools: input.tools,
        skills: input.skills,
        inlineSkills: input.inlineSkills,
        instructions: input.instructions,
        maxCostUsd: input.maxCostUsd,
        maxTurns: input.maxTurns,
        maxWallClockMs: input.maxWallClockMs,
      },
      createdAt: new Date().toISOString(),
      ...(status === "running" ? {} : { finishedAt: new Date().toISOString() }),
      workspaceDir,
      seededFiles: Object.keys(input.files ?? {}),
      result: outcome.result,
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
      stats: {
        turns: 1,
        cost: outcome.cost ?? 0.01,
        tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
      },
    };
    this.tasks.set(id, task);
    if (outcome.settleAfterMs !== undefined) {
      setTimeout(() => {
        const current = this.tasks.get(id);
        if (current === undefined || current.status !== "running") return;
        this.tasks.set(id, {
          ...current,
          status: terminalStatus,
          finishedAt: new Date().toISOString(),
        });
      }, outcome.settleAfterMs);
    }
    return {
      id,
      ...(input.requestKey === undefined ? {} : { requestKey: input.requestKey }),
      workerId: "local",
      status,
      options: task.options,
      seededFiles: task.seededFiles,
    };
  }

  async get(id: string): Promise<LingTask> {
    if (this.statusGate !== undefined) await this.statusGate;
    const task = this.tasks.get(id);
    if (task === undefined) throw new LingClientError("No such task", 404, false);
    return task;
  }

  async list(): Promise<LingTask[]> {
    return [...this.tasks.values()];
  }

  async cancel(id: string): Promise<void> {
    this.cancelAttempts.push(id);
    const task = this.tasks.get(id);
    if (task === undefined) throw new LingClientError("No such task", 404, false);
    if (this.cancellationFailuresRemaining > 0) {
      this.cancellationFailuresRemaining -= 1;
      throw new LingClientError("Transient cancellation failure", 503, true);
    }
    if (task.status !== "queued" && task.status !== "running") {
      throw new LingClientError("Task already settled", 409, false);
    }
    this.cancelled.push(id);
    if (this.cancelAcknowledgeOnly) return;
    this.tasks.set(id, { ...task, status: "cancelled", finishedAt: new Date().toISOString() });
  }

  async *events(
    id: string,
    _workerId?: string,
    options: { signal?: AbortSignal } = {},
  ): AsyncIterable<LingEvent> {
    while (!options.signal?.aborted) {
      // Gated alongside `get`, or the wedge is only half a wedge: a loop that cannot
      // read a status can still learn a task ended from its event stream and settle,
      // which quietly makes a bounded wait indistinguishable from an unbounded one.
      if (this.statusGate !== undefined) await this.statusGate;
      const task = this.tasks.get(id);
      if (task === undefined) return;
      const scheduled = this.scheduledEvents.find(
        (candidate) =>
          candidate.taskId === id &&
          !candidate.emitted &&
          this.inputs.length >= candidate.minimumInputs &&
          (!candidate.afterTerminal ||
            ["completed", "failed", "cancelled", "interrupted"].includes(task.status)),
      );
      if (scheduled !== undefined) {
        scheduled.emitted = true;
        yield scheduled.event;
      }
      if (["completed", "failed", "cancelled", "interrupted"].includes(task.status)) {
        yield {
          seq: 10_000,
          at: new Date().toISOString(),
          type: task.status === "completed" ? "task_finished" : "task_failed",
        };
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  async sendPeerMessage(
    id: string,
    message: LingPeerMessage,
  ): Promise<LingPeerMessageResponse> {
    this.peerMessageAttempts.push({ taskId: id, message });
    await this.peerMessageGate;
    const task = this.tasks.get(id);
    if (task === undefined || task.status !== "running") {
      throw new LingClientError("Task is not running", 409, false);
    }
    const duplicate = this.injectedMessages.some(
      (entry) => entry.taskId === id && entry.message.id === message.id,
    );
    if (!duplicate) this.injectedMessages.push({ taskId: id, message });
    return { accepted: true, duplicate };
  }
}

class LifecycleFakeLing extends FakeLing {
  readonly collected: string[] = [];
  readonly released: string[] = [];
  private releaseFailuresRemaining = 0;

  failNextReleases(count: number): void {
    this.releaseFailuresRemaining = Math.max(0, count);
  }

  async collectComplete(id: string): Promise<void> {
    this.collected.push(id);
  }

  async release(id: string): Promise<void> {
    if (this.releaseFailuresRemaining > 0) {
      this.releaseFailuresRemaining -= 1;
      throw new Error("fixture teardown interruption");
    }
    this.released.push(id);
  }
}

class FakeBrain implements CampaignBrain {
  readonly model = "fixture-local-model";
  readonly requests: CampaignBrainRequest[] = [];

  constructor(
    readonly maxAttempts: number,
    private readonly handler: (
      request: CampaignBrainRequest,
      index: number,
    ) => CampaignBrainChoice | Promise<CampaignBrainChoice>,
  ) {}

  async decide(request: CampaignBrainRequest): Promise<CampaignBrainChoice> {
    this.requests.push(structuredClone(request));
    return this.handler(request, this.requests.length);
  }
}

const policy: SpawnPolicy = {
  allowedTools: DEFAULT_ALLOWED_TOOLS,
  maxCostUsdPerTask: 2,
  maxTurnsPerTask: 40,
  maxWallClockMsPerTask: 900_000,
  maxTasksPerRun: 20,
  maxConcurrentTasks: 1,
  maxTotalCostUsd: 10,
};
const parallelPolicy: SpawnPolicy = {
  ...policy,
  maxConcurrentTasks: 2,
  maxTasksPerRun: 20,
};

const criterion = { id: "output", kind: "file" as const, requirement: "output.txt says good" };

function buildResult(pathname = "output.txt") {
  return {
    status: "success",
    summary: "Built output.",
    data: { kind: "build", artifacts: [{ path: pathname }] },
    steps: ["wrote output"],
  };
}

function planResult(summary = "Planned one slice.") {
  return {
    result: {
      status: "success",
      summary,
      data: {
        kind: "plan",
        artifacts: [{ path: "plan.json" }, { path: "slices/01.md" }],
      },
      steps: ["planned"],
    },
    files: {
      "plan.json": JSON.stringify({
        version: 1,
        slices: [{ id: "01", path: "slices/01.md", dependsOn: [] }],
      }),
      "slices/01.md": "Write output.txt.",
    },
  };
}

function reviewResult(kind: "review" | "integration", verdict: "accept" | "revise" | "blocked") {
  const accepted = verdict === "accept";
  return {
    status: accepted ? "success" : "partial",
    summary: `${kind} ${verdict}.`,
    data: {
      kind,
      verdict,
      checks: [{ criterion: "output", passed: accepted, evidence: accepted ? "good" : "bad" }],
      evidence: [accepted ? "verified output" : "found mismatch"],
      gaps: accepted ? [] : [kind === "integration" ? "[slice:01] output is inconsistent" : "write good"],
      barFetch: null,
    },
    steps: ["checked output"],
  };
}

const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "campaign-check-"));

try {
  await check("default campaign roles keep all generally useful capabilities", () => {
    for (const role of ["planner", "builder"] as const) {
      assert.equal(DEFAULT_CAMPAIGN_ROLES[role].tools.includes("bash"), true);
      assert.equal(DEFAULT_CAMPAIGN_ROLES[role].tools.includes("http_request"), true);
      assert.equal(DEFAULT_CAMPAIGN_ROLES[role].tools.includes("agent_browser"), true);
      // Host-privileged scripting is not a "generally useful capability": it runs
      // model-authored code in the worker process, so it must be asked for explicitly.
      assert.equal(DEFAULT_CAMPAIGN_ROLES[role].tools.includes("browser_script"), false);
    }
    for (const role of ["reviewer", "integration"] as const) {
      assert.equal(DEFAULT_CAMPAIGN_ROLES[role].tools.includes("grep"), true);
      assert.equal(DEFAULT_CAMPAIGN_ROLES[role].tools.includes("bash"), true);
      assert.equal(DEFAULT_CAMPAIGN_ROLES[role].tools.includes("agent_browser"), true);
      assert.equal(DEFAULT_CAMPAIGN_ROLES[role].tools.includes("browser_script"), false);
      assert.equal(DEFAULT_CAMPAIGN_ROLES[role].tools.includes("write_result"), true);
      assert.equal(DEFAULT_CAMPAIGN_ROLES[role].tools.includes("write"), false);
      assert.equal(DEFAULT_CAMPAIGN_ROLES[role].tools.includes("edit"), false);
    }
  });

  await check("versioned profiles resolve into auditable per-task spawn settings", async () => {
    const root = path.join(tmpRoot, "resolved-profiles");
    const store = new CampaignManifestStore(path.join(root, "manifest.json"));
    const artifacts = new CampaignArtifactStore(root, path.join(root, "workspaces"));
    const profileLibrary = new ProfileLibrary({
      version: 1,
      fragments: {
        common: {
          provider: "fixture-provider",
          model: "fixture-model",
          thinking: "low",
          namedSkills: ["browsing-rules"],
          inlineSkills: [
            {
              name: "task-rules",
              content: "---\nname: task-rules\ndescription: Task rules\n---\nStay within the task.",
            },
          ],
          instructions: "Follow the selected role and return the exact result contract.",
          seedFiles: [{ path: "profile/guide.txt", content: "profile context" }],
        },
        planner: { tools: ["read", "write"] },
        builder: { tools: ["read", "write"] },
        reviewer: { tools: ["read", "ls", "write_result"] },
        integration: { tools: ["read", "ls", "write_result"] },
      },
      profiles: {
        planner: { fragments: ["common", "planner"] },
        builder: { fragments: ["common", "builder"] },
        reviewer: { fragments: ["common", "reviewer"] },
        integration: { fragments: ["common", "integration"] },
      },
    });
    const initialized = await initializeCampaign(
      store,
      artifacts,
      {
        id: "resolved-profiles",
        goal: "Produce output.",
        acceptance: [criterion],
        budget: { maxTasks: 4, maxTotalCostUsd: 5 },
        slices: [{ id: "01", spec: "Write output.txt." }],
        roles: {
          planner: "planner",
          builder: "builder",
          reviewer: "reviewer",
          integration: "integration",
        },
      },
      { profileLibrary },
    );
    assert.equal(initialized.version, CAMPAIGN_VERSION);
    assert.equal(initialized.roles.builder.sourceProfile?.name, "builder");
    assert.match(initialized.roles.builder.sourceProfile?.sha256 ?? "", /^[a-f0-9]{64}$/);

    const ling = new FakeLing(path.join(root, "workspaces"), (input) => {
      if (input.task.startsWith("Build only")) {
        return { result: buildResult(), files: { "output.txt": "good" } };
      }
      if (input.task.startsWith("Review the disposable")) {
        return { result: reviewResult("review", "accept") };
      }
      return { result: reviewResult("integration", "accept") };
    });
    const manifest = await new CampaignDriver({
      client: ling,
      store,
      artifacts,
      policy: { ...policy, allowInlineSkills: true },
      pollIntervalMs: 2,
    }).run();
    assert.equal(manifest.status, "completed");
    assert.equal(manifest.summons.length, 3);
    assert.equal(manifest.summons.every((intent) => intent.state === "collected"), true);
    for (const input of ling.inputs) {
      assert.equal(input.provider, "fixture-provider");
      assert.equal(input.model, "fixture-model");
      assert.equal(input.thinking, "low");
      assert.deepEqual(input.skills, ["browsing-rules"]);
      assert.equal(input.inlineSkills?.[0]?.name, "task-rules");
      assert.match(input.instructions ?? "", /exact result contract/);
      assert.equal(input.files?.["profile/guide.txt"], "profile context");
    }
  });

  await check("ephemeral lifecycle releases workers only after durable successful output", async () => {
    const root = path.join(tmpRoot, "ephemeral-release-order");
    const store = new CampaignManifestStore(path.join(root, "manifest.json"));
    const artifacts = new CampaignArtifactStore(root, path.join(root, "workspaces"));
    await initializeCampaign(store, artifacts, {
      id: "ephemeral-release-order",
      goal: "Produce output.",
      acceptance: [criterion],
      budget: { maxTasks: 4, maxTotalCostUsd: 5 },
      slices: [{ id: "01", spec: "Write output.txt." }],
    });
    const statesObservedInsideSpawn: string[] = [];
    const ling = new LifecycleFakeLing(path.join(root, "workspaces"), async (input) => {
      const duringSpawn = await store.load();
      statesObservedInsideSpawn.push(
        duringSpawn.summons.find((intent) => intent.requestKey === input.requestKey)?.state ??
          "missing",
      );
      if (input.task.startsWith("Build only")) {
        return { result: buildResult(), files: { "output.txt": "good" } };
      }
      if (input.task.startsWith("Review the disposable")) {
        return { result: reviewResult("review", "accept") };
      }
      return { result: reviewResult("integration", "accept") };
    });
    const manifest = await new CampaignDriver({
      client: ling,
      store,
      artifacts,
      policy,
      pollIntervalMs: 2,
    }).run();
    assert.equal(manifest.status, "completed");
    assert.deepEqual(statesObservedInsideSpawn, ["prepared", "prepared", "prepared"]);
    assert.deepEqual(ling.collected, ["task-01", "task-02", "task-03"]);
    assert.deepEqual(ling.released, ling.collected);
    assert.equal(manifest.summons.every((intent) => intent.state === "released"), true);
  });

  await check("restart reconciliation finishes teardown from a collected intent", async () => {
    const root = path.join(tmpRoot, "ephemeral-teardown-recovery");
    const store = new CampaignManifestStore(path.join(root, "manifest.json"));
    const artifacts = new CampaignArtifactStore(root, path.join(root, "workspaces"));
    await initializeCampaign(store, artifacts, {
      id: "ephemeral-teardown-recovery",
      goal: "Produce output.",
      acceptance: [criterion],
      budget: { maxTasks: 4, maxTotalCostUsd: 5 },
      slices: [{ id: "01", spec: "Write output.txt." }],
    });
    const ling = new LifecycleFakeLing(path.join(root, "workspaces"), (input) => {
      if (input.task.startsWith("Build only")) {
        return { result: buildResult(), files: { "output.txt": "good" } };
      }
      if (input.task.startsWith("Review the disposable")) {
        return { result: reviewResult("review", "accept") };
      }
      return { result: reviewResult("integration", "accept") };
    });
    ling.failNextReleases(1);
    await assert.rejects(
      new CampaignDriver({
        client: ling,
        store,
        artifacts,
        policy,
        pollIntervalMs: 2,
      }).run(),
      /fixture teardown interruption/,
    );
    const interrupted = await store.load();
    assert.equal(interrupted.summons[0]?.state, "collected");
    const recovered = await new CampaignDriver({
      client: ling,
      store,
      artifacts,
      policy,
      pollIntervalMs: 2,
    }).run();
    assert.equal(recovered.status, "completed");
    assert.equal(recovered.summons.every((intent) => intent.state === "released"), true);
  });

  await check("artifact collection failure retains the ephemeral worker", async () => {
    const root = path.join(tmpRoot, "ephemeral-collection-failure");
    const store = new CampaignManifestStore(path.join(root, "manifest.json"));
    const artifacts = new CampaignArtifactStore(root, path.join(root, "workspaces"));
    await initializeCampaign(store, artifacts, {
      id: "ephemeral-collection-failure",
      goal: "Produce output.",
      acceptance: [criterion],
      budget: { maxTasks: 2, maxTotalCostUsd: 5 },
      maxRounds: 1,
      slices: [{ id: "01", spec: "Write output.txt." }],
    });
    const ling = new LifecycleFakeLing(
      path.join(root, "workspaces"),
      () => ({ result: buildResult() }),
    );
    const manifest = await new CampaignDriver({
      client: ling,
      store,
      artifacts,
      policy,
      pollIntervalMs: 2,
    }).run();
    assert.equal(manifest.status, "capped");
    assert.deepEqual(ling.collected, []);
    assert.deepEqual(ling.released, []);
    assert.equal(manifest.summons[0]?.state, "spawned");
  });

  await check("a settled task's declared intent is compared and persisted", async () => {
    const AT = "2026-09-01T00:00:00.000Z";
    const runCase = async (
      name: string,
      configure: (ling: FakeLing) => void,
      runPolicy: SpawnPolicy = policy,
    ): Promise<CampaignManifest> => {
      const root = path.join(tmpRoot, name);
      const store = new CampaignManifestStore(path.join(root, "manifest.json"));
      const artifacts = new CampaignArtifactStore(root, path.join(root, "workspaces"));
      await initializeCampaign(store, artifacts, {
        id: name,
        goal: "Produce output.",
        acceptance: [criterion],
        budget: { maxTasks: 4, maxTotalCostUsd: 5 },
        slices: [{ id: "01", spec: "Write output.txt." }],
      });
      const ling = new FakeLing(path.join(root, "workspaces"), (input) => {
        if (input.task.startsWith("Build only")) {
          return { result: buildResult(), files: { "output.txt": "good" } };
        }
        if (input.task.startsWith("Review the disposable")) {
          return { result: reviewResult("review", "accept") };
        }
        return { result: reviewResult("integration", "accept") };
      });
      configure(ling);
      const manifest = await new CampaignDriver({
        client: ling,
        store,
        artifacts,
        policy: runPolicy,
        pollIntervalMs: 2,
      }).run();
      assert.equal(manifest.status, "completed");
      return manifest;
    };

    // The default roles carry declare_intent, so a campaign that declares
    // nothing while acting must not come back clean.
    const silent = await runCase("intent-silent", (ling) => {
      ling.logEvents = [{ at: AT, type: "tool_start", data: { tool: "bash", args: { command: "curl http://x.test" } } }];
    });
    for (const task of silent.tasks) {
      assert.equal(task.intent?.outcome, "undeclared", `${task.role} should be undeclared`);
      assert.equal(task.intent?.declarations, 0);
      assert.ok((task.intent?.observed.commands ?? 0) > 0);
      assert.equal(task.effectiveTools?.includes("declare_intent"), true);
    }

    const honest = await runCase("intent-honest", (ling) => {
      ling.logEvents = [
        { at: AT, type: "intent_declared", data: { commands: ["curl"], hosts: [], writes: [] } },
        { at: AT, type: "tool_start", data: { tool: "bash", args: { command: "curl http://x.test" } } },
      ];
    });
    assert.equal(honest.tasks.every((task) => task.intent?.outcome === "clean"), true);

    // A declaration that arrives after the action does not cover it, end to end.
    const retroactive = await runCase("intent-retroactive", (ling) => {
      ling.logEvents = [
        { at: AT, type: "tool_start", data: { tool: "bash", args: { command: "curl http://x.test" } } },
        { at: AT, type: "intent_declared", data: { commands: ["curl"], hosts: [], writes: [] } },
      ];
    });
    assert.equal(retroactive.tasks.every((task) => task.intent?.outcome === "diverged"), true);
    assert.equal(
      retroactive.tasks[0]?.intent?.undeclared.some(
        (item) => item.value === "curl" && item.declaredLater,
      ),
      true,
    );

    // An unreadable log is recorded as unknown rather than as a pass.
    const blind = await runCase("intent-unavailable", (ling) => ling.failHistory());
    assert.equal(blind.tasks.every((task) => task.intent?.outcome === "unavailable"), true);

    // With no readable log, the live stream is the only source — and the fake
    // stream starts at a high sequence number, exactly like a real replay that
    // joined after the retained tail had already rolled. A partial account must
    // not be promoted to a complete one.
    const truncated = await runCase("intent-truncated", (ling) => {
      ling.failHistory();
      ling.scheduleEvent("task-01", 1, {
        seq: 900,
        at: AT,
        type: "tool_start",
        data: { tool: "bash", args: { command: "curl http://x.test" } },
      });
    });
    const firstTask = truncated.tasks.find((task) => task.id === "task-01");
    assert.equal(firstTask?.intent?.outcome, "unavailable");

    // A deployment may deliberately withhold intent observation. Applicability
    // follows the effective grant after policy, not the broader role profile.
    const withoutIntent = await runCase(
      "intent-policy-opt-out",
      (ling) => {
        ling.logEvents = [
          {
            at: AT,
            type: "tool_start",
            data: { tool: "bash", args: { command: "curl http://x.test" } },
          },
        ];
      },
      {
        ...policy,
        allowedTools: policy.allowedTools.filter((tool) => tool !== "declare_intent"),
      },
    );
    for (const task of withoutIntent.tasks) {
      assert.equal(task.effectiveTools?.includes("declare_intent"), false);
      assert.equal(task.intent?.outcome, "inapplicable");
    }

    // And the whole record survives a manifest round trip.
    const store = new CampaignManifestStore(
      path.join(tmpRoot, "intent-retroactive", "manifest.json"),
    );
    const reloaded = await store.load();
    assert.deepEqual(reloaded.tasks[0]?.intent, retroactive.tasks[0]?.intent);
  });

  await check("a tapped task is judged from the overlord's own event record, not the service's log", async () => {
    const AT = "2026-09-01T00:00:00.000Z";
    const tapped: LingEvent[] = [
      { seq: 1, at: AT, type: "task_started" },
      { seq: 2, at: AT, type: "intent_declared", data: { commands: ["ls"], hosts: [], writes: [] } },
      { seq: 3, at: AT, type: "tool_start", data: { tool: "bash", args: { command: "curl http://x.test" } } },
      { seq: 4, at: AT, type: "task_finished", data: { status: "completed", stoppedBy: "finished" } },
    ];
    /** Streams a whole, gapless account once a task has settled. */
    class RecordedFakeLing extends FakeLing {
      override async *events(
        id: string,
        _workerId?: string,
        options: { signal?: AbortSignal; sinceSeq?: number } = {},
      ): AsyncIterable<LingEvent> {
        while (!options.signal?.aborted) {
          const task = await this.get(id).catch(() => undefined);
          if (task === undefined) return;
          if (task.status !== "running" && task.status !== "queued") {
            for (const event of tapped) if (event.seq > (options.sinceSeq ?? 0)) yield event;
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
      }
    }
    const root = path.join(tmpRoot, "intent-event-record");
    const store = new CampaignManifestStore(path.join(root, "manifest.json"));
    const artifacts = new CampaignArtifactStore(root, path.join(root, "workspaces"));
    await initializeCampaign(store, artifacts, {
      id: "intent-event-record",
      goal: "Produce output.",
      acceptance: [criterion],
      budget: { maxTasks: 4, maxTotalCostUsd: 5 },
      slices: [{ id: "01", spec: "Write output.txt." }],
    });
    const ling = new RecordedFakeLing(path.join(root, "workspaces"), (input) => {
      if (input.task.startsWith("Build only")) {
        return { result: buildResult(), files: { "output.txt": "good" }, settleAfterMs: 20 };
      }
      if (input.task.startsWith("Review the disposable")) {
        return { result: reviewResult("review", "accept") };
      }
      return { result: reviewResult("integration", "accept") };
    });
    // The service's log, which a task sharing the service's user could have
    // rewritten, tells a clean story.
    ling.logEvents = [
      { at: AT, type: "intent_declared", data: { commands: ["curl"], hosts: [], writes: [] } },
      { at: AT, type: "tool_start", data: { tool: "bash", args: { command: "curl http://x.test" } } },
    ];
    const manifest = await new CampaignDriver({
      client: ling,
      store,
      artifacts,
      policy,
      pollIntervalMs: 2,
    }).run();
    assert.equal(manifest.status, "completed");
    const builder = manifest.tasks.find((task) => task.role === "builder");
    assert.equal(builder?.id, "task-01");
    assert.equal(builder?.intent?.outcome, "diverged");
    assert.equal(builder?.intent?.undeclared.some((item) => item.value === "curl"), true);
    // The record is on disk where a later process would look for it.
    assert.deepEqual(await readEventRecord(root, "task-01"), tapped);
    // Tasks whose streams were never tapped are still judged from the log.
    for (const task of manifest.tasks.filter((candidate) => candidate.role !== "builder")) {
      assert.equal(task.intent?.outcome, "clean", task.role);
    }
  });

  await check("manifest transitions reject illegal completion", () => {
    assert.throws(
      () => assertCampaignTransition("pending", "completed"),
      CampaignSchemaError,
    );
  });

  await check("pre-v6 manifests are refused rather than upgraded", async () => {
    const root = path.join(tmpRoot, "pre-v6-manifests");
    const store = new CampaignManifestStore(path.join(root, "manifest.json"));
    const artifacts = new CampaignArtifactStore(root, path.join(root, "workspaces"));
    const current = await initializeCampaign(store, artifacts, {
      id: "pre-v6-manifests",
      goal: "Produce output.",
      acceptance: [criterion],
      budget: { maxTasks: 4, maxTotalCostUsd: 5 },
      slices: [{ id: "01", spec: "Write output.txt." }],
    });
    const write = (value: Record<string, unknown>) =>
      writeFile(store.filename, `${JSON.stringify(value, null, 2)}\n`, "utf8");

    // Version 5 used to be upgraded in memory. It is refused now even with every
    // current field present, so nothing older can reach the driver.
    const v5 = structuredClone(current) as unknown as Record<string, unknown>;
    v5["version"] = 5;
    await write(v5);
    await assert.rejects(store.load(), /manifest\.version: unsupported version 5/);

    // And a v6 manifest missing a field an older version lacked is not given a
    // default for it.
    const withoutSummons = structuredClone(current) as unknown as Record<string, unknown>;
    delete withoutSummons["summons"];
    await write(withoutSummons);
    await assert.rejects(store.load(), /manifest\.summons: must be an array/);

    // Ids past the 64-byte creation limit still load. The bound is checked when a
    // campaign is created and when a request key is built, not on every read.
    const longIds = structuredClone(current) as unknown as Record<string, unknown>;
    const longCampaignId = "legacy-".repeat(12);
    const longSliceId = "slice-".repeat(14);
    longIds["id"] = longCampaignId;
    longIds["currentSliceId"] = longSliceId;
    for (const slice of longIds["slices"] as Array<Record<string, unknown>>) {
      slice["id"] = longSliceId;
    }
    await write(longIds);
    const loaded = await store.load();
    assert.equal(loaded.version, CAMPAIGN_VERSION);
    assert.equal(loaded.id, longCampaignId);
    assert.equal(loaded.slices[0]?.id, longSliceId);
  });

  await check("seed provenance rejects forged, contradictory, and unknown context", async () => {
    const root = path.join(tmpRoot, "seed-provenance-schema");
    const store = new CampaignManifestStore(path.join(root, "manifest.json"));
    const artifacts = new CampaignArtifactStore(root, path.join(root, "workspaces"));
    const current = await initializeCampaign(store, artifacts, {
      id: "seed-provenance-schema",
      goal: "Validate durable seed provenance.",
      acceptance: [criterion],
      budget: { maxTasks: 4, maxTotalCostUsd: 5 },
      slices: [{ id: "01", spec: "Write output.txt." }],
    });
    const task = {
      id: "telemetry-task",
      role: "builder" as const,
      sliceId: "01",
      round: 1,
      status: "failed" as const,
      costUsd: 0,
      totalTokens: 0,
      seedProvenance: "recorded" as const,
      seededArtifacts: [
        {
          artifact: current.slices[0]!.spec,
          destination: "accepted/c2xpY2UtMDE/spec.md",
          channel: "accepted" as const,
        },
      ],
      seededMessageIds: [],
      createdAt: new Date().toISOString(),
    };
    const valid = parseCampaignManifest({ ...current, tasks: [task] });
    assert.equal(valid.tasks[0]?.seededArtifacts.length, 1);

    assert.throws(
      () =>
        parseCampaignManifest({
          ...current,
          tasks: [
            {
              ...task,
              seedProvenance: "unavailable",
            },
          ],
        }),
      /unavailable seed provenance/,
    );
    assert.throws(
      () =>
        parseCampaignManifest({
          ...current,
          tasks: [
            {
              ...task,
              seededArtifacts: [
                {
                  ...task.seededArtifacts[0],
                  artifact: {
                    ...current.slices[0]!.spec,
                    path: "artifacts/forged/spec.md",
                  },
                },
              ],
            },
          ],
        }),
      /does not identify an artifact retained/,
    );
    assert.throws(
      () =>
        parseCampaignManifest({
          ...current,
          tasks: [
            {
              ...task,
              seededArtifacts: [
                {
                  ...task.seededArtifacts[0],
                  destination: "proposal/spec.md",
                },
              ],
            },
          ],
        }),
      /inconsistent with task role and destination/,
    );
    assert.throws(
      () =>
        parseCampaignManifest({
          ...current,
          tasks: [
            {
              ...task,
              seededMessageIds: ["missing-message"],
            },
          ],
        }),
      /does not identify a durable campaign message/,
    );
  });

  await check("brain client defaults remote, honours the cell-local opt-in, and parses JSON", async () => {
    assert.equal(
      resolveBrainEndpoint("https://api.openai.com/v1").href,
      "https://api.openai.com/v1/chat/completions",
    );
    assert.equal(
      resolveBrainEndpoint("http://127.0.0.1:11434/v1").href,
      "http://127.0.0.1:11434/v1/chat/completions",
    );
    assert.equal(
      resolveBrainEndpoint("http://localhost:11434/v1").href,
      "http://127.0.0.1:11434/v1/chat/completions",
    );
    // A local deployment can still refuse anything that would leave the cell.
    assert.throws(
      () => resolveBrainEndpoint("https://api.openai.com/v1", true),
      CampaignBrainError,
    );
    assert.equal(
      resolveBrainEndpoint("http://127.0.0.1:11434/v1", true).href,
      "http://127.0.0.1:11434/v1/chat/completions",
    );
    assert.throws(
      () =>
        campaignBrainFromEnv({
          OVERLORD_BRAIN_BASE_URL: "https://api.openai.com/v1",
          OVERLORD_BRAIN_MODEL: "fixture",
          OVERLORD_BRAIN_REQUIRE_CELL_LOCAL: "true",
        }),
      CampaignBrainError,
    );
    assert(
      campaignBrainFromEnv({
        OVERLORD_BRAIN_BASE_URL: "https://api.openai.com/v1",
        OVERLORD_BRAIN_MODEL: "fixture",
        OPENAI_API_KEY: "fixture-key",
      }) instanceof OpenAICompatibleBrain,
    );
    let posted: Record<string, unknown> | undefined;
    const brain = new OpenAICompatibleBrain({
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "local-fixture",
      fetch: async (_url, init) => {
        posted = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    action: "continue",
                    rationale: "The legal work is bounded.",
                    arguments: {},
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    const choice = await brain.decide({
      key: "fixture",
      phase: "scheduling",
      goal: "Test.",
      state: {},
      legalActions: [
        { action: "continue", description: "Continue.", argumentsSchema: {} },
      ],
    });
    assert.equal(posted?.["model"], "local-fixture");
    assert.equal(choice.action, "continue");

    let redirectMode: RequestRedirect | undefined;
    const redirecting = new OpenAICompatibleBrain({
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "local-fixture",
      fetch: async (_url, init) => {
        redirectMode = init?.redirect;
        return new Response("", {
          status: 307,
          headers: { location: "https://api.openai.com/v1/chat/completions" },
        });
      },
    });
    await assert.rejects(
      redirecting.decide({
        key: "redirect",
        phase: "scheduling",
        goal: "Do not leave the cell.",
        state: {},
        legalActions: [
          { action: "continue", description: "Continue.", argumentsSchema: {} },
        ],
      }),
      /HTTP 307/,
    );
    assert.equal(redirectMode, "manual");

    const oversized = new OpenAICompatibleBrain({
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "local-fixture",
      fetch: async () => new Response("x".repeat(65 * 1024), { status: 200 }),
    });
    await assert.rejects(
      oversized.decide({
        key: "oversized",
        phase: "scheduling",
        goal: "Bound memory.",
        state: {},
        legalActions: [
          { action: "continue", description: "Continue.", argumentsSchema: {} },
        ],
      }),
      /response exceeds/,
    );
  });

  await check("campaign token budgets require a positive safe integer", async () => {
    const root = path.join(tmpRoot, "invalid-token-budget");
    const store = new CampaignManifestStore(path.join(root, "manifest.json"));
    const artifacts = new CampaignArtifactStore(root, path.join(root, "workspaces"));
    await assert.rejects(
      initializeCampaign(store, artifacts, {
        id: "invalid-token-budget",
        goal: "Produce output.",
        acceptance: [criterion],
        budget: { maxTasks: 4, maxTotalCostUsd: 5, maxTotalTokens: 0 },
        slices: [{ id: "01", spec: "Write output.txt." }],
      }),
      CampaignSchemaError,
    );
  });

  await check("campaign and slice ids stay within downstream request-key bounds", async () => {
    const root = path.join(tmpRoot, "bounded-campaign-ids");
    const create = (definition: Record<string, unknown>) =>
      initializeCampaign(
        new CampaignManifestStore(path.join(root, `${Math.random()}.json`)),
        new CampaignArtifactStore(root, path.join(root, "workspaces")),
        definition,
      );
    const base = {
      goal: "Produce output.",
      acceptance: [criterion],
      budget: { maxTasks: 4, maxTotalCostUsd: 5 },
    };
    await assert.rejects(
      create({
        ...base,
        id: "c".repeat(65),
        slices: [{ id: "01", spec: "Write output.txt." }],
      }),
      /at most 64/,
    );
    await assert.rejects(
      create({
        ...base,
        id: "界".repeat(64),
        slices: [{ id: "01", spec: "Write output.txt." }],
      }),
      /64 UTF-8 bytes/,
    );
    await assert.rejects(
      create({
        ...base,
        id: "bounded",
        slices: [{ id: "s".repeat(65), spec: "Write output.txt." }],
      }),
      /at most 64/,
    );
  });

  await check("parallel coordination keeps unsafe budget and graph cases opt-in rejected", async () => {
    const withDefinition = async (name: string, definition: Record<string, unknown>) => {
      const root = path.join(tmpRoot, name);
      return initializeCampaign(
        new CampaignManifestStore(path.join(root, "manifest.json")),
        new CampaignArtifactStore(root, path.join(root, "workspaces")),
        definition,
      );
    };
    const base = {
      goal: "Produce output.",
      acceptance: [criterion],
      budget: { maxTasks: 8, maxTotalCostUsd: 5 },
    };
    await assert.rejects(
      withDefinition("parallel-with-token-budget", {
        ...base,
        id: "parallel-with-token-budget",
        budget: { ...base.budget, maxTotalTokens: 100 },
        slices: [{ id: "01", spec: "Work.", dependsOn: [] }],
        coordination: { enabled: true, parallelSlices: true },
      }),
      /cannot use maxTotalTokens/,
    );
    await assert.rejects(
      withDefinition("parallel-with-implicit-dependencies", {
        ...base,
        id: "parallel-with-implicit-dependencies",
        slices: [{ id: "01", spec: "Work." }],
        coordination: { enabled: true, parallelSlices: true },
      }),
      /requires every supplied slice to declare dependsOn/,
    );
    await assert.rejects(
      withDefinition("radio-without-parallelism", {
        ...base,
        id: "radio-without-parallelism",
        slices: [{ id: "01", spec: "Work." }],
        coordination: { enabled: true, passiveMessaging: true },
      }),
      /passiveMessaging requires parallelSlices/,
    );
    await assert.rejects(
      withDefinition("parallel-cycle", {
        ...base,
        id: "parallel-cycle",
        slices: [
          { id: "01", spec: "First.", dependsOn: ["02"] },
          { id: "02", spec: "Second.", dependsOn: ["01"] },
        ],
        coordination: { enabled: true, parallelSlices: true },
      }),
      /dependency graph contains a cycle/,
    );
  });

  await check("campaign lock refuses a second writer and releases cleanly", async () => {
    const root = path.join(tmpRoot, "lock");
    await mkdir(root, { recursive: true });
    const first = await acquireCampaignLock(root);
    await assert.rejects(acquireCampaignLock(root), CampaignLockError);
    await first.release();
    const next = await acquireCampaignLock(root);
    await next.release();
  });

  await check("campaign lock renews and stale recovery has one winner", async () => {
    const root = path.join(tmpRoot, "lock-renewal");
    await mkdir(root, { recursive: true });
    const held = await acquireCampaignLock(root, 90);
    await new Promise((resolve) => setTimeout(resolve, 140));
    await held.assertOwned();
    await assert.rejects(acquireCampaignLock(root, 90), CampaignLockError);
    await held.release();

    const lockPath = path.join(root, ".campaign-run.lock");
    await writeFile(
      lockPath,
      `${JSON.stringify({
        token: "pid-reuse-fixture",
        pid: process.pid,
        hostname: os.hostname(),
        startedAt: "2020-01-01T00:00:00.000Z",
      })}\n`,
      "utf8",
    );
    const old = new Date("2020-01-01T00:00:00.000Z");
    await utimes(lockPath, old, old);
    const contenders = await Promise.allSettled([
      acquireCampaignLock(root, 50),
      acquireCampaignLock(root, 50),
    ]);
    const winners = contenders.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireCampaignLock>>> =>
        result.status === "fulfilled",
    );
    assert.equal(winners.length, 1);
    await winners[0]!.value.release();
  });

  await check("manifest save detects a stale read", async () => {
    const root = path.join(tmpRoot, "manifest-cas");
    const store = new CampaignManifestStore(path.join(root, "manifest.json"));
    const artifacts = new CampaignArtifactStore(root, path.join(root, "workspaces"));
    await initializeCampaign(store, artifacts, {
      id: "manifest-cas",
      goal: "Produce output.",
      acceptance: [criterion],
      budget: { maxTasks: 4, maxTotalCostUsd: 5 },
      slices: [{ id: "01", spec: "Write output.txt." }],
    });
    const first = await store.load();
    const stale = await store.load();
    first.goal = "Updated goal.";
    await store.save(first);
    stale.goal = "Stale update.";
    await assert.rejects(store.save(stale), ManifestConcurrentModificationError);
  });

  await check("a manifest save waits out a reader holding the file open", async () => {
    // On Windows the save's rename over the manifest is refused while any handle has
    // it open, and it used to give up after five attempts within about 100 ms. A
    // reader polling every 2 ms beat that often enough to crash a run of this script.
    // Here the reader holds the file for 500 ms. Elsewhere the rename is not refused,
    // and this passes without a retry.
    const root = path.join(tmpRoot, "manifest-held-open");
    const filename = path.join(root, "manifest.json");
    const store = new CampaignManifestStore(filename);
    const artifacts = new CampaignArtifactStore(root, path.join(root, "workspaces"));
    await initializeCampaign(store, artifacts, {
      id: "manifest-held-open",
      goal: "Produce output.",
      acceptance: [criterion],
      budget: { maxTasks: 4, maxTotalCostUsd: 5 },
      slices: [{ id: "01", spec: "Write output.txt." }],
    });
    const reader = await open(filename, "r");
    // Settled into a value at once, so a save that gives up while the handle is held
    // fails this check rather than going unhandled.
    const saved = store
      .update((manifest) => {
        manifest.goal = "Saved past a reader.";
      })
      .then(
        (manifest) => ({ manifest }),
        (error: unknown) => ({ error }),
      );
    await new Promise((resolve) => setTimeout(resolve, 500));
    await reader.close();
    const outcome = await saved;
    if ("error" in outcome) throw outcome.error;
    assert.equal(outcome.manifest.goal, "Saved past a reader.");
    assert.equal((await store.load()).goal, "Saved past a reader.");
  });

  await check("progress webhooks are asynchronous, retried, and detect stalls", async () => {
    const root = path.join(tmpRoot, "progress");
    const store = new CampaignManifestStore(path.join(root, "manifest.json"));
    const artifacts = new CampaignArtifactStore(root, path.join(root, "workspaces"));
    const manifest = await initializeCampaign(store, artifacts, {
      id: "progress-campaign",
      goal: "Produce output.",
      acceptance: [criterion],
      budget: { maxTasks: 4, maxTotalCostUsd: 5 },
      slices: [{ id: "01", spec: "Write output.txt." }],
    });
    let release: ((response: Response) => void) | undefined;
    let calls = 0;
    const reporter = new CampaignProgressReporter({
      filename: path.join(root, "progress.jsonl"),
      webhookUrl: "https://alerts.invalid/progress",
      webhookRetryBaseMs: 10,
      fetch: async () => {
        calls += 1;
        if (calls === 1) {
          return new Promise<Response>((resolve) => {
            release = resolve;
          });
        }
        return new Response("", { status: 200 });
      },
    });
    await reporter.report(manifest);
    while (calls === 0) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    release?.(new Response("", { status: 503 }));
    await reporter.flush();
    assert.equal(calls, 2);
    const progressEvents = (await readFile(path.join(root, "progress.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            coordination?: { tasksWithRecordedSeedProvenance?: number };
          },
      );
    assert.equal(
      progressEvents[0]?.coordination?.tasksWithRecordedSeedProvenance,
      0,
    );

    const stallReporter = new CampaignProgressReporter({
      filename: path.join(root, "stalls.jsonl"),
      stallMs: 30,
    });
    stallReporter.startStallDetection(() => store.load());
    const stallFile = path.join(root, "stalls.jsonl");
    const stallDeadline = Date.now() + 1_000;
    let stallText: string | undefined;
    while (stallText === undefined && Date.now() < stallDeadline) {
      stallText = await readFile(stallFile, "utf8").catch(() => undefined);
      if (stallText === undefined) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    stallReporter.stopStallDetection();
    assert.notEqual(stallText, undefined);
    const events = (stallText ?? "")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { status: string; severity: string });
    assert(events.some((event) => event.status === "stalled" && event.severity === "critical"));
  });

  await check("a rolling window paces tasks, spend, and decisions independently", () => {
    const ledger = new FleetLedgerStore(path.join(tmpRoot, "fleet-rate-ledger.db"), {
      retentionMs: 60_000,
      inFlightStaleMs: 60_000,
      rateWindowMs: 60_000,
    });
    const limits = { maxConcurrentTasks: 8, maxTotalCostUsd: 100 };
    const task = (id: string, cost: number, status: LingTask["status"] = "completed"): LingTask => ({
      id,
      status,
      prompt: "",
      options: {},
      createdAt: new Date().toISOString(),
      workspaceDir: "",
      seededFiles: [],
      stats: {
        turns: 1,
        cost,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    try {
      // The window counts work, not bookkeeping. `record` is called repeatedly for one
      // task as its status changes, and spend is re-stated as a running total, so a
      // window that counted calls would rise without any new work happening.
      ledger.record(task("task-1", 0.5, "running"), "campaign-a");
      ledger.record(task("task-1", 1.25, "running"), "campaign-a");
      ledger.record(task("task-1", 1.25), "campaign-a");
      assert.equal(ledger.windowTotal("task", 60_000), 1);
      assert.equal(ledger.windowTotal("spend", 60_000), 1.25);

      // Each limit is independent, and an unset one is unlimited rather than zero.
      assert.equal(ledger.rateBlockReason({ windowMs: 60_000, maxTasks: 2 }, { tasks: 1 }), undefined);
      assert.equal(
        ledger.rateBlockReason({ windowMs: 60_000, maxTasks: 1 }, { tasks: 1 }),
        "rate_tasks",
      );
      assert.equal(ledger.rateBlockReason({ windowMs: 60_000, maxTasks: 1 }, {}), undefined);
      assert.equal(
        ledger.rateBlockReason({ windowMs: 60_000, maxSpendUsd: 1.5 }, { spendUsd: 0.3 }),
        "rate_spend",
      );
      assert.equal(
        ledger.rateBlockReason({ windowMs: 60_000, maxSpendUsd: 1.5 }, { spendUsd: 0.2 }),
        undefined,
      );
      // A decision ceiling is not implied by a task ceiling: the cheap thing that runs
      // away is metered separately.
      assert.equal(
        ledger.rateBlockReason({ windowMs: 60_000, maxDecisions: 1 }, { decisions: 1 }),
        undefined,
      );
      ledger.recordDecision("campaign-a");
      assert.equal(
        ledger.rateBlockReason({ windowMs: 60_000, maxDecisions: 1 }, { decisions: 1 }),
        "rate_decisions",
      );

      // A reservation is refused by the window even when concurrency and the depleting
      // budget both have room, and refused inside the same transaction that grants it.
      assert.equal(
        ledger.reserveSpawn("request-rate", "campaign-a", 0.1, limits, 60_000, {
          windowMs: 60_000,
          maxTasks: 1,
        }),
        "rate_tasks",
      );
      assert.equal(
        ledger.reserveSpawn("request-rate", "campaign-a", 0.1, limits, 60_000, {
          windowMs: 60_000,
          maxSpendUsd: 1.3,
        }),
        "rate_spend",
      );
      assert.equal(
        ledger.reserveSpawn("request-rate", "campaign-a", 0.1, limits, 60_000, {
          windowMs: 60_000,
          maxTasks: 4,
          maxSpendUsd: 10,
        }),
        undefined,
      );

      // An outstanding reservation weighs on the window whatever its age, because it is
      // not history: it is a task about to exist, and its own TTL bounds how long it can
      // count. That granted reservation is still live here.
      assert.equal(
        ledger.rateBlockReason({ windowMs: 60_000, maxTasks: 1 }, { tasks: 1 }, Date.now() + 120_000),
        "rate_tasks",
      );
      ledger.releaseReservation("request-rate");
      // With nothing promised, the window slides. A limit that counted forever would be
      // a depleting ceiling wearing a rate limit's name.
      assert.equal(
        ledger.rateBlockReason({ windowMs: 60_000, maxTasks: 1 }, { tasks: 1 }, Date.now() + 120_000),
        undefined,
      );
    } finally {
      ledger.close();
    }
  });

  await check("a promised task counts against the window before it is recorded", () => {
    // The race this closes: a task event is only written when the task's row first
    // appears, so reservations taken before that all saw the same empty window. With a
    // limit of one and concurrency of eight, eight tasks would have started.
    const ledger = new FleetLedgerStore(path.join(tmpRoot, "fleet-rate-reservations.db"), {
      rateWindowMs: 60_000,
    });
    const limits = { maxConcurrentTasks: 8, maxTotalCostUsd: 100 };
    try {
      const rate = { windowMs: 60_000, maxTasks: 1 };
      assert.equal(ledger.reserveSpawn("req-1", "campaign-a", 0.1, limits, 60_000, rate), undefined);
      // No task has been recorded yet, so the window's own event count is still zero.
      assert.equal(ledger.windowTotal("task", 60_000), 0);
      assert.equal(
        ledger.reserveSpawn("req-2", "campaign-a", 0.1, limits, 60_000, rate),
        "rate_tasks",
      );
      // Releasing the promise frees the slot again: an expired or abandoned reservation
      // must not consume a window forever.
      ledger.releaseReservation("req-1");
      assert.equal(ledger.reserveSpawn("req-2", "campaign-a", 0.1, limits, 60_000, rate), undefined);

      // The same applies to promised spend, which the depleting budget already counted
      // and the window did not.
      const spendLedger = new FleetLedgerStore(path.join(tmpRoot, "fleet-rate-promised-spend.db"), {
        rateWindowMs: 60_000,
      });
      try {
        const spendRate = { windowMs: 60_000, maxSpendUsd: 1 };
        assert.equal(
          spendLedger.reserveSpawn("req-a", "campaign-a", 0.6, limits, 60_000, spendRate),
          undefined,
        );
        assert.equal(
          spendLedger.reserveSpawn("req-b", "campaign-a", 0.6, limits, 60_000, spendRate),
          "rate_spend",
        );
      } finally {
        spendLedger.close();
      }
    } finally {
      ledger.close();
    }
  });

  await check("admitting a decision and counting it are one act", () => {
    // Checking then recording is a race with a limit of one: two decisions in flight
    // both read an empty window and both proceed. Parallel slices make that ordinary.
    const ledger = new FleetLedgerStore(path.join(tmpRoot, "fleet-rate-decisions.db"), {
      rateWindowMs: 60_000,
    });
    try {
      const rate = { windowMs: 60_000, maxDecisions: 1 };
      assert.equal(ledger.tryRecordDecision(rate, "campaign-a"), undefined);
      assert.equal(ledger.tryRecordDecision(rate, "campaign-a"), "rate_decisions");
      // A refused admission records nothing, or a burst of refusals would poison the
      // window it was refused by.
      assert.equal(ledger.windowTotal("decision", 60_000), 1);
      // With no limits configured it still counts, because a window nobody enforces yet
      // is the record an operator sizes a limit from.
      assert.equal(ledger.tryRecordDecision(undefined, "campaign-a"), undefined);
      assert.equal(ledger.windowTotal("decision", 60_000), 2);
    } finally {
      ledger.close();
    }
  });

  await check("the reaper reads in-flight work and refuses to summon a worker", async () => {
    const ledgerPath = path.join(tmpRoot, "reap-ledger", "fleet-ledger.db");
    const ledger = new FleetLedgerStore(ledgerPath);
    ledger.record(
      {
        id: "task-live",
        status: "running",
        prompt: "",
        options: {},
        createdAt: new Date().toISOString(),
        workspaceDir: "",
        seededFiles: [],
      },
      "campaign-live",
    );
    ledger.record(
      {
        id: "task-done",
        status: "completed",
        prompt: "",
        options: {},
        createdAt: new Date().toISOString(),
        workspaceDir: "",
        seededFiles: [],
      },
      "campaign-live",
    );
    assert.deepEqual(
      ledger.inFlightTasks().map((task) => task.id),
      ["task-live"],
    );
    assert.deepEqual(ledger.inFlightTasks("campaign-other"), []);
    // A terminal row cannot be re-cancelled, so a reaper can tell what it actually
    // stopped from what had already finished.
    assert.equal(ledger.markTaskStatus("task-done", "cancelled"), false);
    ledger.close();

    const tsxCli = fileURLToPath(
      new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url),
    );
    const reaper = fileURLToPath(new URL("./reap.ts", import.meta.url));
    // Deliberately stripped of any worker registry. The dangerous failure for a reaper
    // is bootstrapping a local worker, which is what the overlord's own entrypoint
    // does when none is configured: it would create the thing it exists to stop.
    const env: NodeJS.ProcessEnv = { ...process.env, FLEET_LEDGER_PATH: ledgerPath };
    delete env["FLEET_WORKERS"];
    delete env["LING_BASE_URL"];
    delete env["LING_TOKEN"];

    const dry = await execFileAsync(process.execPath, [tsxCli, reaper, "--dry-run"], { env });
    assert.match(dry.stdout, /1 task\(s\) in flight/);
    assert.match(dry.stdout, /would cancel {2}task-live/);

    await assert.rejects(
      execFileAsync(process.execPath, [tsxCli, reaper], { env }),
      (error: unknown) => {
        const failure = error as { code?: number; stderr?: string };
        assert.equal(failure.code, 1);
        assert.match(failure.stderr ?? "", /refusing to reap without a configured worker registry/);
        return true;
      },
    );
    // Refusing left the work alone rather than marking it stopped.
    const after = new FleetLedgerStore(ledgerPath);
    assert.deepEqual(
      after.inFlightTasks().map((task) => task.id),
      ["task-live"],
    );
    after.close();
  });

  await check("the reaper refuses to call a partly inspected fleet empty", async () => {
    // `list()` returns whatever succeeded and throws only when every worker fails, so an
    // unreachable worker holding an orphan looked exactly like an empty fleet. Printing
    // "nothing in flight" and exiting zero is the one answer this command must never get
    // wrong: an operator reads it as "the spending stopped".
    const ledgerPath = path.join(tmpRoot, "reap-partial", "fleet-ledger.db");
    new FleetLedgerStore(ledgerPath).close();
    const reachable = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/tasks") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ tasks: [] }));
        return;
      }
      response.writeHead(404).end("{}");
    });
    await new Promise<void>((resolve) => reachable.listen(0, "127.0.0.1", resolve));
    const reachableAddress = reachable.address();
    const reachablePort =
      typeof reachableAddress === "object" && reachableAddress !== null
        ? reachableAddress.port
        : 0;
    // A port nothing is listening on, obtained by opening and closing one.
    const spare = createServer();
    await new Promise<void>((resolve) => spare.listen(0, "127.0.0.1", resolve));
    const spareAddress = spare.address();
    const deadPort =
      typeof spareAddress === "object" && spareAddress !== null ? spareAddress.port : 0;
    await new Promise<void>((resolve) => spare.close(() => resolve()));
    try {
      const tsxCli = fileURLToPath(
        new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url),
      );
      const reaper = fileURLToPath(new URL("./reap.ts", import.meta.url));
      await assert.rejects(
        execFileAsync(process.execPath, [tsxCli, reaper, "--campaign", "campaign-anything"], {
          env: {
            ...process.env,
            FLEET_LEDGER_PATH: ledgerPath,
            LING_WORKERS_JSON: JSON.stringify([
              { id: "up", baseUrl: `http://127.0.0.1:${reachablePort}`, token: "t" },
              { id: "down", baseUrl: `http://127.0.0.1:${deadPort}`, token: "t" },
            ]),
            LING_REQUEST_TIMEOUT_MS: "1500",
          },
        }),
        (error: unknown) => {
          const failure = error as { code?: number; stdout?: string; stderr?: string };
          assert.equal(failure.code, 1);
          assert.match(failure.stderr ?? "", /worker down could not be listed/);
          assert.match(failure.stderr ?? "", /may still be spending/);
          // And crucially it did not claim the fleet was clear.
          assert.doesNotMatch(failure.stdout ?? "", /nothing in flight/);
          return true;
        },
      );
    } finally {
      await new Promise<void>((resolve) => reachable.close(() => resolve()));
    }
  });

  await check("the reaper does not call an accepted cancellation a stopped task", async () => {
    // `POST /tasks/:id/cancel` answers 202 `cancelling: true`, which means accepted and
    // not stopped: abort is cooperative. Believing the 202 would write `cancelled` into
    // the ledger while the worker was still billing, turning live spend into a record
    // that says there is none.
    const ledgerPath = path.join(tmpRoot, "reap-unconfirmed", "fleet-ledger.db");
    const ledger = new FleetLedgerStore(ledgerPath);
    const stubbornTask = {
      id: "task-stubborn",
      status: "running",
      prompt: "",
      options: {},
      createdAt: new Date().toISOString(),
      workspaceDir: "",
      seededFiles: [] as string[],
    };
    ledger.record(stubbornTask as LingTask, "campaign-stubborn");
    ledger.close();

    // A worker that accepts every cancellation and never stops the work.
    let cancelRequests = 0;
    const server = createServer((request, response) => {
      const url = request.url ?? "";
      if (request.method === "POST" && url.endsWith("/cancel")) {
        cancelRequests += 1;
        response.writeHead(202, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: stubbornTask.id, cancelling: true }));
        return;
      }
      if (request.method === "GET" && url === "/tasks") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ tasks: [stubbornTask] }));
        return;
      }
      if (request.method === "GET" && url.startsWith("/tasks/")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(stubbornTask));
        return;
      }
      response.writeHead(404).end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const tsxCli = fileURLToPath(
        new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url),
      );
      const reaper = fileURLToPath(new URL("./reap.ts", import.meta.url));
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        FLEET_LEDGER_PATH: ledgerPath,
        LING_WORKERS_JSON: JSON.stringify([
          { id: "stub", baseUrl: `http://127.0.0.1:${port}`, token: "stub-token" },
        ]),
        // Short, because the point is what it reports when confirmation never comes.
        REAP_CONFIRM_TIMEOUT_MS: "1500",
      };
      await assert.rejects(
        execFileAsync(process.execPath, [tsxCli, reaper, "--campaign", "campaign-stubborn"], { env }),
        (error: unknown) => {
          const failure = error as { code?: number; stdout?: string; stderr?: string };
          assert.equal(failure.code, 1);
          assert.match(failure.stderr ?? "", /cancellation requested but not confirmed/);
          assert.match(failure.stdout ?? "", /0 cancelled, 1 unconfirmed/);
          return true;
        },
      );
      assert.ok(cancelRequests > 0, "the reaper never asked the worker to cancel");
      // And it finds work the ledger never recorded. A spawn is reserved under a request
      // key carrying no task id, and the row only appears once the overlord records the
      // task, so an overlord that dies in between leaves a task the ledger cannot name.
      // The worker knows, which is why it is asked.
      const orphanId = "campaign-orphan";
      const orphanLedger = path.join(tmpRoot, "reap-orphan", "fleet-ledger.db");
      new FleetLedgerStore(orphanLedger).close();
      let orphanCancelled = false;
      const orphan = {
        ...stubbornTask,
        id: "task-orphan",
        requestKey: `campaign:${Buffer.from(orphanId).toString("base64url")}:builder:MDE:1`,
      };
      const orphanServer = createServer((request, response) => {
        const url = request.url ?? "";
        if (request.method === "POST" && url.endsWith("/cancel")) {
          orphanCancelled = true;
          orphan.status = "cancelled";
          response.writeHead(202, { "content-type": "application/json" });
          response.end(JSON.stringify({ id: orphan.id, cancelling: true }));
          return;
        }
        if (request.method === "GET" && url === "/tasks") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ tasks: [orphan] }));
          return;
        }
        if (request.method === "GET" && url.startsWith("/tasks/")) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(orphan));
          return;
        }
        response.writeHead(404).end("{}");
      });
      await new Promise<void>((resolve) => orphanServer.listen(0, "127.0.0.1", resolve));
      const orphanAddress = orphanServer.address();
      const orphanPort =
        typeof orphanAddress === "object" && orphanAddress !== null ? orphanAddress.port : 0;
      try {
        const orphanRun = await execFileAsync(
          process.execPath,
          [tsxCli, reaper, "--campaign", orphanId],
          {
            env: {
              ...process.env,
              FLEET_LEDGER_PATH: orphanLedger,
              LING_WORKERS_JSON: JSON.stringify([
                { id: "stub", baseUrl: `http://127.0.0.1:${orphanPort}`, token: "stub-token" },
              ]),
              REAP_CONFIRM_TIMEOUT_MS: "3000",
            },
          },
        );
        assert.ok(orphanCancelled, "the reaper never cancelled the task the ledger did not know");
        assert.match(orphanRun.stdout, /1 task\(s\) in flight for campaign campaign-orphan/);
        assert.match(orphanRun.stdout, /1 cancelled, 0 unconfirmed/);
      } finally {
        await new Promise<void>((resolve) => orphanServer.close(() => resolve()));
      }
      // And the row stays in flight, because it is: a later sweep needs to know.
      const reopened = new FleetLedgerStore(ledgerPath);
      try {
        assert.deepEqual(
          reopened.inFlightTasks().map((task) => task.id),
          ["task-stubborn"],
        );
      } finally {
        reopened.close();
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  await check("retention cannot empty a window an operator asked to be counted", () => {
    // Retention and rate windows are different things, and this is where they collide:
    // a short retention setting used to be enough to delete the events a long rate
    // window is counting, and a limit that counts nothing permits everything.
    const ledger = new FleetLedgerStore(path.join(tmpRoot, "fleet-rate-retention.db"), {
      retentionMs: 60_000,
      inFlightStaleMs: 60_000,
      rateWindowMs: 6 * 60 * 60 * 1000,
    });
    try {
      ledger.recordDecision("campaign-a");
      assert.equal(ledger.windowTotal("decision", 6 * 60 * 60 * 1000), 1);
      // Well past task retention, comfortably inside the rate window.
      ledger.prune(Date.now() + 30 * 60_000);
      assert.equal(ledger.windowTotal("decision", 6 * 60 * 60 * 1000), 1);
      // Past both.
      ledger.prune(Date.now() + 7 * 60 * 60 * 1000);
      assert.equal(ledger.windowTotal("decision", 6 * 60 * 60 * 1000), 0);
    } finally {
      ledger.close();
    }
  });

  await check("persistent fleet ledger shares concurrency and spend", () => {
    const ledger = new FleetLedgerStore(path.join(tmpRoot, "fleet-ledger.db"), {
      retentionMs: 60_000,
      inFlightStaleMs: 60_000,
    });
    const limits = { maxConcurrentTasks: 1, maxTotalCostUsd: 1 };
    assert.equal(ledger.reserveSpawn("request-a", "campaign-a", 0.6, limits, 60_000), undefined);
    assert.equal(
      ledger.reserveSpawn("request-b", "campaign-b", 0.2, limits, 60_000),
      "concurrency",
    );
    ledger.record(
      {
        id: "task-a",
        requestKey: "request-a",
        status: "completed",
        prompt: "",
        options: {},
        createdAt: new Date().toISOString(),
        workspaceDir: "",
        seededFiles: [],
        stats: {
          turns: 1,
          cost: 0.6,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
      "campaign-a",
    );
    assert.equal(
      ledger.reserveSpawn("request-b", "campaign-b", 0.5, limits, 60_000),
      "budget",
    );
    ledger.record(
      {
        id: "task-a-replacement",
        requestKey: "request-a",
        status: "completed",
        prompt: "",
        options: {},
        createdAt: new Date().toISOString(),
        workspaceDir: "",
        seededFiles: [],
        stats: {
          turns: 1,
          cost: 0.2,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
      "campaign-a",
    );
    assert.equal(ledger.spentUsd(), 0.6);
    ledger.record(
      {
        id: "stale-active",
        status: "running",
        prompt: "",
        options: {},
        createdAt: new Date().toISOString(),
        workspaceDir: "",
        seededFiles: [],
      },
      "campaign-c",
    );
    assert.equal(ledger.inFlight(), 1);
    ledger.prune(Date.now() + 61_000);
    assert.equal(ledger.inFlight(), 0);
    assert.equal(ledger.spentUsd(), 0);
    ledger.close();
  });

  await check("fleet ledger reservations are atomic across processes", async () => {
    const dbPath = path.join(tmpRoot, "cross-process-ledger.db");
    const tsxCli = fileURLToPath(
      new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url),
    );
    const child = fileURLToPath(new URL("./ledger-reserve-child.ts", import.meta.url));
    const results = await Promise.all(
      ["a", "b"].map((key) =>
        execFileAsync(process.execPath, [tsxCli, child, dbPath, key]),
      ),
    );
    assert.deepEqual(
      results.map((result) => result.stdout.trim()).sort(),
      ["concurrency", "reserved"],
    );
  });

  await check("worker contract rejects self-approved builds", () => {
    assert.throws(
      () =>
        parseWorkerResult(
          {
            status: "success",
            summary: "bad",
            data: {
              kind: "build",
              artifacts: [{ path: "output.txt" }],
              verdict: "accept",
            },
            steps: [],
          },
          "builder",
          [criterion],
          null,
        ),
      WorkerResultError,
    );
  });

  await check("worker contract requires every acceptance check", () => {
    assert.throws(
      () =>
        parseWorkerResult(
          {
            status: "success",
            summary: "bad",
            data: {
              kind: "review",
              verdict: "accept",
              checks: [],
              evidence: [],
              gaps: [],
              barFetch: null,
            },
            steps: [],
          },
          "reviewer",
          [criterion],
          null,
        ),
      WorkerResultError,
    );
  });

  await check("failed reference fetch forces a blocked verdict", () => {
    const bar = { kind: "url" as const, ref: "https://example.com/bar", appliesTo: ["output"] };
    assert.throws(
      () =>
        parseWorkerResult(
          {
            status: "partial",
            summary: "bar unavailable",
            data: {
              kind: "review",
              verdict: "revise",
              checks: [{ criterion: "output", passed: false, evidence: "not evaluated" }],
              evidence: [],
              gaps: ["reference unavailable"],
              barFetch: { ref: bar.ref, fetched: false, evidence: "HTTP 503" },
            },
            steps: [],
          },
          "reviewer",
          [criterion],
          bar,
        ),
      WorkerResultError,
    );
  });

  await check("artifact transport hashes local and authenticated remote text", async () => {
    const root = path.join(tmpRoot, "artifact-case");
    const workspaces = path.join(root, "workspaces");
    const remoteBytes = Buffer.from("remote hello secret-token-123", "utf8");
    const remoteHash = createHash("sha256").update(remoteBytes).digest("hex");
    const artifacts = new CampaignArtifactStore(
      root,
      workspaces,
      {
        listArtifacts: async () => ({
          files: [{ path: "out.txt", size: remoteBytes.length, sha256: remoteHash }],
        }),
        readArtifact: async () => remoteBytes,
      },
      (content) => content.replace("secret-token-123", "[REDACTED]"),
    );
    const ref = await artifacts.storeText("specs/1", "spec.md", "hello");
    assert.equal((await artifacts.readText(ref)), "hello");
    assert.equal(ref.sha256.length, 64);
    const remote = await artifacts.collectTaskArtifacts(
      {
        id: "remote",
        workerId: "worker-2",
        status: "completed",
        prompt: "",
        options: {},
        createdAt: new Date().toISOString(),
        workspaceDir: "/remote/workspaces/remote",
        seededFiles: [],
      },
      [{ path: "out.txt", sha256: remoteHash }],
      "remote",
    );
    assert.equal(await artifacts.readText(remote[0]!), "remote hello [REDACTED]");
  });

  await check("required evidence is collected without the worker claiming it", async () => {
    const root = path.join(tmpRoot, "required-file-local");
    const workspaces = path.join(root, "workspaces");
    const artifacts = new CampaignArtifactStore(root, workspaces, undefined, (content) =>
      content.replace("secret-token-123", "[REDACTED]"),
    );
    const workspace = path.join(workspaces, "task-1");
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "findings.json"), '{"findings":[]} secret-token-123', "utf8");
    const task: LingTask = {
      id: "task-1",
      status: "completed",
      prompt: "",
      options: {},
      createdAt: new Date().toISOString(),
      workspaceDir: workspace,
      seededFiles: [],
    };

    // The worker claims nothing at all, which is exactly the omission that would
    // otherwise hide a fabricated finding set behind an ungradeable empty one.
    const ref = await artifacts.collectRequiredFile(task, "findings.json", "evidence");
    assert.notEqual(ref, undefined);
    assert.equal(await artifacts.readText(ref!), '{"findings":[]} [REDACTED]');

    // A task that genuinely recorded nothing is honest, and says so by absence.
    assert.equal(await artifacts.collectRequiredFile(task, "no-such-file.json", "evidence"), undefined);
  });

  await check("a broken collection is never reported as an honest absence", async () => {
    const root = path.join(tmpRoot, "required-file-absence");
    const workspaces = path.join(root, "workspaces");
    const missingWorkspaceTask: LingTask = {
      id: "gone",
      status: "completed",
      prompt: "",
      options: {},
      createdAt: new Date().toISOString(),
      workspaceDir: path.join(workspaces, "gone"),
      seededFiles: [],
    };
    // A vanished workspace took its evidence with it. Reading that as "recorded
    // nothing" would hand a clean record to whatever broke.
    await assert.rejects(
      () =>
        new CampaignArtifactStore(root, workspaces).collectRequiredFile(
          missingWorkspaceTask,
          "findings.json",
          "evidence",
        ),
      (error: unknown) =>
        error instanceof ArtifactTransportError && error.code === "transport_unavailable",
    );

    const remoteTask: LingTask = {
      id: "remote",
      workerId: "worker-9",
      status: "completed",
      prompt: "",
      options: {},
      createdAt: new Date().toISOString(),
      workspaceDir: "/remote/workspaces/remote",
      seededFiles: [],
    };
    const notFound = new CampaignArtifactStore(root, workspaces, {
      listArtifacts: async () => ({ files: [] }),
      readArtifact: async () => {
        throw new LingClientError("no such artifact", 404, false);
      },
    });
    assert.equal(
      await notFound.collectRequiredFile(remoteTask, "findings.json", "evidence"),
      undefined,
    );

    // A worker that is merely unreachable must not look like one that found
    // nothing, or "break the transport" becomes a way to pass the gate.
    const unreachable = new CampaignArtifactStore(root, workspaces, {
      listArtifacts: async () => ({ files: [] }),
      readArtifact: async () => {
        throw new LingClientError("bad gateway", 502, true);
      },
    });
    await assert.rejects(
      () => unreachable.collectRequiredFile(remoteTask, "findings.json", "evidence"),
      /bad gateway/,
    );

    // And no worker gets to nominate operational data or a path outside itself.
    for (const reserved of ["result.json", "events.jsonl"]) {
      await assert.rejects(
        () =>
          new CampaignArtifactStore(root, workspaces).collectRequiredFile(
            remoteTask,
            reserved,
            "evidence",
          ),
        (error: unknown) =>
          error instanceof ArtifactTransportError && error.code === "invalid_path",
      );
    }
    await assert.rejects(
      () =>
        new CampaignArtifactStore(root, workspaces).collectRequiredFile(
          remoteTask,
          "../escape.json",
          "evidence",
        ),
      ArtifactTransportError,
    );
  });

  await check("the driver takes a builder's findings even when result.json omits them", async () => {
    const root = path.join(tmpRoot, "driver-collects-findings");
    const store = new CampaignManifestStore(path.join(root, "manifest.json"));
    const artifacts = new CampaignArtifactStore(root, path.join(root, "workspaces"));
    const findingsBody = JSON.stringify({
      findings: [
        {
          id: "lead-1",
          claim: "A buyer enquiry names Antalya.",
          confidence: "asserted",
          source: {
            kind: "url",
            locator: "https://example.invalid/thread/1",
            retrievedAt: "2026-09-01T10:00:00.000Z",
            excerpt: "looking to buy a two bedroom flat in Antalya this autumn",
          },
          fields: { city: "Antalya" },
        },
      ],
    });
    const library = (builderTools: string[]): ProfileLibrary =>
      new ProfileLibrary({
        version: 1,
        fragments: {
          planner: { tools: ["read", "write"] },
          builder: { tools: builderTools },
          reviewer: { tools: ["read", "ls", "write_result"] },
          integration: { tools: ["read", "ls", "write_result"] },
        },
        profiles: {
          planner: { fragments: ["planner"] },
          builder: { fragments: ["builder"] },
          reviewer: { fragments: ["reviewer"] },
          integration: { fragments: ["integration"] },
        },
      });

    const run = async (id: string, builderTools: string[]) => {
      const caseRoot = path.join(root, id);
      const caseStore = new CampaignManifestStore(path.join(caseRoot, "manifest.json"));
      const caseArtifacts = new CampaignArtifactStore(caseRoot, path.join(caseRoot, "workspaces"));
      await initializeCampaign(
        caseStore,
        caseArtifacts,
        {
          id,
          goal: "Find buyers.",
          acceptance: [criterion],
          budget: { maxTasks: 4, maxTotalCostUsd: 5 },
          slices: [{ id: "01", spec: "Research and record leads." }],
          roles: {
            planner: "planner",
            builder: "builder",
            reviewer: "reviewer",
            integration: "integration",
          },
        },
        { profileLibrary: library(builderTools) },
      );
      const ling = new FakeLing(path.join(caseRoot, "workspaces"), (input) => {
        if (input.task.startsWith("Build only")) {
          // Claims output.txt only. findings.json is on disk and unmentioned.
          return {
            result: buildResult(),
            files: { "output.txt": "good", "findings.json": findingsBody },
          };
        }
        if (input.task.startsWith("Review the disposable")) {
          return { result: reviewResult("review", "accept") };
        }
        return { result: reviewResult("integration", "accept") };
      });
      const manifest = await new CampaignDriver({
        client: ling,
        store: caseStore,
        artifacts: caseArtifacts,
        policy,
        pollIntervalMs: 2,
      }).run();
      assert.equal(manifest.status, "completed");
      return { manifest, artifacts: caseArtifacts };
    };

    const granted = await run("findings-granted", ["read", "write", "record_finding"]);
    const attempt = granted.manifest.slices[0]?.attempts[0];
    assert.notEqual(attempt?.findings, null);
    assert.notEqual(attempt?.findings, undefined);
    assert.equal(await granted.artifacts.readText(attempt!.findings!), findingsBody);
    // Evidence stays out of the deliverables, which are what dependents are seeded with.
    assert.deepEqual(
      attempt!.artifacts.map((ref) => path.posix.basename(ref.path)),
      ["output.txt"],
    );
    // And it survives a reload, so the audit trail is not in memory only.
    const reloaded = await new CampaignManifestStore(
      path.join(root, "findings-granted", "manifest.json"),
    ).load();
    assert.deepEqual(reloaded.slices[0]?.attempts[0]?.findings, attempt?.findings);

    // The grant is the trigger, not the file being there: an ungranted builder
    // that somehow wrote one is not credited with evidence it could not record.
    const ungranted = await run("findings-ungranted", ["read", "write"]);
    assert.equal(ungranted.manifest.slices[0]?.attempts[0]?.findings, null);
  });

  await check("the evidence gate decides whether a researched slice is accepted", async () => {
    const root = path.join(tmpRoot, "evidence-gate");
    const EXCERPT = "looking to buy a two bedroom flat in Antalya this autumn";
    const findingsBody = JSON.stringify({
      findings: [
        {
          id: "lead-1",
          claim: "A buyer enquiry names Antalya.",
          confidence: "asserted",
          source: {
            kind: "url",
            locator: "https://example.invalid/thread/1",
            retrievedAt: "2026-09-01T10:00:00.000Z",
            excerpt: EXCERPT,
          },
          fields: { city: "Antalya" },
        },
      ],
    });
    const verificationBody = (observedText: string | undefined) =>
      JSON.stringify({
        verifications: [
          {
            findingId: "lead-1",
            locatorFetched: observedText !== undefined,
            ...(observedText === undefined ? {} : { observedText }),
            evidence: "Opened the thread.",
            checkedAt: "2026-09-01T11:00:00.000Z",
          },
        ],
      });
    const library = (reviewerTools: string[]): ProfileLibrary =>
      new ProfileLibrary({
        version: 1,
        fragments: {
          planner: { tools: ["read", "write"] },
          builder: { tools: ["read", "write", "record_finding"] },
          reviewer: { tools: reviewerTools },
          integration: { tools: ["read", "ls", "write_result"] },
        },
        profiles: {
          planner: { fragments: ["planner"] },
          builder: { fragments: ["builder"] },
          reviewer: { fragments: ["reviewer"] },
          integration: { fragments: ["integration"] },
        },
      });

    const run = async (
      id: string,
      reviewerTools: string[],
      reviewerFiles: Record<string, string>,
      builderFindings: string = findingsBody,
    ) => {
      const caseRoot = path.join(root, id);
      const caseStore = new CampaignManifestStore(path.join(caseRoot, "manifest.json"));
      const caseArtifacts = new CampaignArtifactStore(caseRoot, path.join(caseRoot, "workspaces"));
      await initializeCampaign(
        caseStore,
        caseArtifacts,
        {
          id,
          goal: "Find buyers.",
          acceptance: [criterion],
          budget: { maxTasks: 6, maxTotalCostUsd: 5 },
          // One round, so a refused attempt caps instead of retrying forever.
          maxRounds: 1,
          slices: [{ id: "01", spec: "Research and record leads." }],
          roles: {
            planner: "planner",
            builder: "builder",
            reviewer: "reviewer",
            integration: "integration",
          },
        },
        { profileLibrary: library(reviewerTools) },
      );
      const ling = new FakeLing(path.join(caseRoot, "workspaces"), (input) => {
        if (input.task.startsWith("Build only")) {
          return {
            result: buildResult(),
            files: { "output.txt": "good", "findings.json": builderFindings },
          };
        }
        if (input.task.startsWith("Review the disposable")) {
          // Always accepts, so the only thing that can refuse the slice is the gate.
          return { result: reviewResult("review", "accept"), files: reviewerFiles };
        }
        return { result: reviewResult("integration", "accept") };
      });
      const manifest = await new CampaignDriver({
        client: ling,
        store: caseStore,
        artifacts: caseArtifacts,
        policy,
        pollIntervalMs: 2,
      }).run();
      return { manifest, artifacts: caseArtifacts, ling };
    };

    const verifying = ["read", "ls", "write_result", "verify_finding"];

    const confirmed = await run("confirmed", verifying, {
      "verification.json": verificationBody(`Posted yesterday: ${EXCERPT}. Replies welcome.`),
    });
    assert.equal(confirmed.manifest.status, "completed");
    const passed = confirmed.manifest.slices[0]?.attempts[0];
    assert.equal(passed?.verdict, "accept");
    assert.equal(passed?.findingsGate?.outcome, "pass");
    assert.equal(passed?.findingsGate?.survivalRate, 1);
    assert.deepEqual(passed?.findingsSample?.ids, ["lead-1"]);
    assert.notEqual(passed?.verification, null);
    assert.notEqual(passed?.verification, undefined);

    // The verifier is told what to check and pointedly not what it has to find.
    const request = confirmed.ling.inputs.find((input) =>
      input.task.startsWith("Review the disposable"),
    )?.files?.["campaign/verification-request.json"];
    assert.ok(request !== undefined, "reviewer was not seeded with a verification request");
    assert.match(request, /https:\/\/example\.invalid\/thread\/1/);
    assert.match(request, /A buyer enquiry names Antalya\./);
    assert.equal(request.includes(EXCERPT), false, "the excerpt leaked into the request");

    // A reviewer that fetched the page and did not find the quoted text refuses the
    // slice even though it also said accept. Without this the gate is decoration.
    const refuted = await run("refuted", verifying, {
      "verification.json": verificationBody("This thread is about renting a garage in Izmir."),
    });
    assert.notEqual(refuted.manifest.status, "completed");
    const failed = refuted.manifest.slices[0]?.attempts[0];
    assert.notEqual(failed?.verdict, "accept");
    assert.notEqual(refuted.manifest.slices[0]?.status, "accepted");
    assert.equal(failed?.findingsGate?.outcome, "fail");
    assert.equal(failed?.findingsGate?.survivalRate, 0);
    assert.ok(
      failed?.gaps.some((gap) => gap.includes("survival")),
      `gate reason missing from gaps: ${JSON.stringify(failed?.gaps)}`,
    );

    // Silence is not consent: reporting nothing leaves the sample unchecked, which
    // is inconclusive rather than a pass, and inconclusive does not accept.
    const silent = await run("silent", verifying, {});
    assert.notEqual(silent.manifest.status, "completed");
    const unchecked = silent.manifest.slices[0]?.attempts[0];
    assert.notEqual(unchecked?.verdict, "accept");
    assert.equal(unchecked?.findingsGate?.outcome, "inconclusive");
    assert.equal(unchecked?.verification, null);

    // Link rot is the verifier's honest "cannot tell", and it must not read as
    // fabrication by the producer.
    const rotted = await run("unreachable", verifying, {
      "verification.json": verificationBody(undefined),
    });
    assert.notEqual(rotted.manifest.status, "completed");
    assert.equal(rotted.manifest.slices[0]?.attempts[0]?.findingsGate?.outcome, "inconclusive");

    // A campaign whose reviewer cannot verify has opted out. It must behave exactly
    // as it did before the gate existed rather than stalling every research slice.
    const optedOut = await run("not-verifying", ["read", "ls", "write_result"], {});
    assert.equal(optedOut.manifest.status, "completed");
    const skipped = optedOut.manifest.slices[0]?.attempts[0];
    assert.equal(skipped?.verdict, "accept");
    assert.equal(skipped?.findingsSample, null);
    assert.equal(skipped?.findingsGate?.outcome, "inapplicable");
    // The opt-out is now recorded as the decision it is, rather than sharing a reason
    // with a set nobody could check.
    assert.match(skipped?.findingsGate?.reasons.join(" ") ?? "", /withheld verify_finding/);

    // Nothing sampleable is not the same as nothing to sample. Only `url` sources can
    // be re-fetched, so a set of calls and documents yields an empty sample — and the
    // gate used to read that as "inapplicable" and let the reviewer's accept stand.
    // `judgeFindings` has always called it a failure; nothing asked it.
    const unsampleableBody = JSON.stringify({
      findings: [
        {
          id: "lead-1",
          claim: "A caller said they want a flat in Antalya.",
          confidence: "asserted",
          source: {
            kind: "call",
            locator: "phone call with the agency",
            retrievedAt: "2026-09-01T10:00:00.000Z",
            excerpt: EXCERPT,
          },
          fields: { city: "Antalya" },
        },
      ],
    });
    const unsampleable = await run("unsampleable", verifying, {}, unsampleableBody);
    assert.notEqual(unsampleable.manifest.status, "completed");
    const refused = unsampleable.manifest.slices[0]?.attempts[0];
    assert.equal(refused?.findingsGate?.outcome, "fail");
    assert.deepEqual(refused?.findingsSample?.ids, []);
    assert.match(
      refused?.findingsGate?.reasons.join(" ") ?? "",
      /nothing in this set could be checked/,
    );

    // The same hole through the other door: a re-fetchable source whose excerpt is too
    // short to prove a match. Eight normalized characters is the floor.
    const shortExcerptBody = JSON.stringify({
      findings: [
        {
          id: "lead-1",
          claim: "A buyer enquiry names Antalya.",
          confidence: "asserted",
          source: {
            kind: "url",
            locator: "https://example.invalid/thread/1",
            retrievedAt: "2026-09-01T10:00:00.000Z",
            excerpt: "buy",
          },
          fields: { city: "Antalya" },
        },
      ],
    });
    const tooShort = await run("short-excerpt", verifying, {}, shortExcerptBody);
    assert.notEqual(tooShort.manifest.status, "completed");
    assert.equal(tooShort.manifest.slices[0]?.attempts[0]?.findingsGate?.outcome, "fail");

    // And an empty findings document stays honest: recording nothing is allowed, so it
    // must not become gradeable as failure just because the set is technically present.
    const emptyBody = JSON.stringify({ findings: [] });
    const empty = await run("empty-findings", verifying, {}, emptyBody);
    assert.equal(empty.manifest.status, "completed");
    assert.equal(
      empty.manifest.slices[0]?.attempts[0]?.findingsGate?.outcome,
      "inapplicable",
    );
  });

  await check("artifact reference provenance survives reload and CLI inspection", async () => {
    const root = path.join(tmpRoot, "artifact-reference-provenance");
    const workspaces = path.join(root, "workspaces");
    const store = new CampaignManifestStore(path.join(root, "manifest.json"));
    const artifacts = new CampaignArtifactStore(root, workspaces);
    await initializeCampaign(store, artifacts, {
      id: "artifact-reference-provenance",
      goal: "Build output against a durable reference.",
      acceptance: [criterion],
      bar: {
        kind: "artifact",
        ref: "golden-output",
        appliesTo: ["output"],
        content: "gold standard",
      },
      budget: { maxTasks: 4, maxTotalCostUsd: 5 },
      slices: [{ id: "01", spec: "Write output.txt." }],
    });
    const ling = new FakeLing(workspaces, (input): FakeOutcome => {
      if (input.task.startsWith("Build only")) {
        return { result: buildResult(), files: { "output.txt": "good" } };
      }
      const kind = input.task.startsWith("Review the disposable")
        ? "review"
        : "integration";
      const baseResult = reviewResult(kind, "accept");
      const contract = JSON.parse(
        input.files?.["campaign/result-contract.json"] ?? "{}",
      ) as { data?: { barFetch?: { ref?: string } | null } };
      const result = {
        ...baseResult,
        data: {
          ...baseResult.data,
          barFetch: {
            ref: contract.data?.barFetch?.ref ?? "",
            fetched: true,
            evidence: "Read reference-bar/content.",
          },
        },
      };
      assert.equal(input.files?.["reference-bar/content"], "gold standard");
      return { result };
    });
    const manifest = await new CampaignDriver({
      client: ling,
      store,
      artifacts,
      policy,
      pollIntervalMs: 2,
    }).run();
    assert.equal(manifest.status, "completed");
    const reloaded = await store.load();
    const analysis = analyzeCampaignCoordination(reloaded);
    assert.equal(analysis.metrics.referenceArtifactSeedEdges, 2);
    assert.equal(
      reloaded.tasks.filter((task) =>
        task.seededArtifacts.some((seeded) => seeded.channel === "reference"),
      ).length,
      2,
    );

    const tsxCli = fileURLToPath(
      new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url),
    );
    const campaignCli = fileURLToPath(new URL("./campaign.ts", import.meta.url));
    const inspected = await execFileAsync(process.execPath, [
      tsxCli,
      campaignCli,
      "inspect",
      store.filename,
    ]);
    const inspectOutput = JSON.parse(inspected.stdout) as {
      metrics?: { referenceArtifactSeedEdges?: number };
      artifactSeeds?: unknown[];
    };
    assert.equal(inspectOutput.metrics?.referenceArtifactSeedEdges, 2);
    assert.equal(inspectOutput.artifactSeeds?.length, 4);

    const status = await execFileAsync(process.execPath, [
      tsxCli,
      campaignCli,
      "status",
      store.filename,
    ]);
    const statusOutput = JSON.parse(status.stdout) as {
      coordination?: {
        metrics?: { referenceArtifactSeedEdges?: number };
      };
    };
    assert.equal(
      statusOutput.coordination?.metrics?.referenceArtifactSeedEdges,
      2,
    );
  });

  await check("real artifact redactor scrubs configured and common credentials", () => {
    const redact = artifactRedactorFromEnv({
      SERVICE_TOKEN: "configured-secret-value",
    });
    const output = redact(
      "configured-secret-value sk-proj-abcdefghijklmnop ghp_abcdefghijklmnopqrstuvwxyz",
    );
    assert(!output.includes("configured-secret-value"));
    assert(!output.includes("sk-proj-"));
    assert(!output.includes("ghp_"));
  });

  await check("seed transport enforces Ling file-count limits", () => {
    const files = Object.fromEntries(
      Array.from({ length: 21 }, (_, index) => [`f${index}.txt`, "x"]),
    );
    assert.throws(() => assertSeedFileLimits(files), ArtifactTransportError);
  });

  await check("seed transport enforces Ling path-length limits", () => {
    assert.throws(
      () => assertSeedFileLimits({ [`${"a".repeat(241)}.txt`]: "x" }),
      ArtifactTransportError,
    );
  });

  await check("JSON-expanded requests are rejected before spawn", async () => {
    const root = path.join(tmpRoot, "request-body");
    const workspaces = path.join(root, "workspaces");
    const store = new CampaignManifestStore(path.join(root, "manifest.json"));
    const artifacts = new CampaignArtifactStore(root, workspaces);
    await initializeCampaign(store, artifacts, {
      id: "request-body-campaign",
      goal: "Produce output.",
      acceptance: [criterion],
      budget: { maxTasks: 5, maxTotalCostUsd: 5 },
      slices: [{ id: "01", spec: `${"\0".repeat(90_000)}work` }],
    });
    const ling = new FakeLing(workspaces, () => {
      throw new Error("An oversized JSON request must not spawn.");
    });
    const manifest = await new CampaignDriver({
      client: ling,
      store,
      artifacts,
      policy,
      pollIntervalMs: 10,
    }).run();
    assert.equal(manifest.status, "blocked");
    assert.equal(ling.inputs.length, 0);
    assert.match(manifest.integration.gaps.at(-1) ?? "", /JSON encoding/);
  });

  await check("supplied slices retry with fresh workers then integrate", async () => {
    const root = path.join(tmpRoot, "retry");
    const workspaces = path.join(root, "workspaces");
    const store = new CampaignManifestStore(path.join(root, "manifest.json"));
    const artifacts = new CampaignArtifactStore(root, workspaces);
    await initializeCampaign(store, artifacts, {
      id: "retry-campaign",
      goal: "Produce a good output.",
      acceptance: [criterion],
      budget: { maxTasks: 8, maxTotalCostUsd: 5 },
      maxRounds: 2,
      slices: [{ id: "01", spec: "Write output.txt." }],
    });

    let builders = 0;
    let reviews = 0;
    const ling = new FakeLing(workspaces, (input): FakeOutcome => {
      if (input.task.startsWith("Build only")) {
        builders += 1;
        return {
          result: buildResult(),
          files: { "output.txt": builders === 1 ? "bad" : "good" },
        };
      }
      if (input.task.startsWith("Review the disposable")) {
        reviews += 1;
        return { result: reviewResult("review", reviews === 1 ? "revise" : "accept") };
      }
      if (input.task.startsWith("Perform final integration")) {
        return { result: reviewResult("integration", "accept") };
      }
      throw new Error(`Unexpected fake task: ${input.task}`);
    });
    const manifest = await new CampaignDriver({
      client: ling,
      store,
      artifacts,
      policy,
      pollIntervalMs: 10,
    }).run();
    assert.equal(manifest.status, "completed");
    assert.equal(manifest.slices[0]?.attempts.length, 2);
    assert.equal(manifest.integration.verdict, "accept");
    assert.equal(manifest.tasks.length, 5);
    assert.equal(manifest.spentUsdSnapshot, 0.05);
    const secondBuilder = ling.inputs.filter((input) => input.task.startsWith("Build only"))[1];
    assert.match(secondBuilder?.files?.["campaign/prior-gaps.txt"] ?? "", /LING-UNTRUSTED/);
    for (const input of ling.inputs.filter((candidate) => candidate.task.includes("disposable"))) {
      assert(input.tools?.includes("write_result"));
      assert(!input.tools?.includes("write"));
      assert(!input.tools?.includes("edit"));
      const contract = JSON.parse(input.files?.["campaign/result-contract.json"] ?? "{}") as {
        data?: { checks?: { criterion?: string }[] };
      };
      assert.equal(contract.data?.checks?.[0]?.criterion, "output");
    }
  });

  await check("declared slice dependencies scope builder and reviewer seeds", async () => {
    const runTwoSlices = async (name: string, dependsOn: string[] | undefined) => {
      const root = path.join(tmpRoot, name);
      const workspaces = path.join(root, "workspaces");
      const store = new CampaignManifestStore(path.join(root, "manifest.json"));
      const artifacts = new CampaignArtifactStore(root, workspaces);
      await initializeCampaign(store, artifacts, {
        id: name,
        goal: "Produce two independent outputs.",
        acceptance: [criterion],
        budget: { maxTasks: 12, maxTotalCostUsd: 5 },
        slices: [
          { id: "01", spec: "Write output.txt." },
          {
            id: "02",
            spec: "Write output.txt.",
            ...(dependsOn === undefined ? {} : { dependsOn }),
          },
        ],
      });
      const ling = new FakeLing(workspaces, (input): FakeOutcome => {
        if (input.task.startsWith("Build only")) {
          return { result: buildResult(), files: { "output.txt": "good" } };
        }
        if (input.task.startsWith("Review the disposable")) {
          return { result: reviewResult("review", "accept") };
        }
        if (input.task.startsWith("Perform final integration")) {
          return { result: reviewResult("integration", "accept") };
        }
        throw new Error(`Unexpected fake task: ${input.task}`);
      });
      const manifest = await new CampaignDriver({
        client: ling,
        store,
        artifacts,
        policy,
        pollIntervalMs: 10,
      }).run();
      assert.equal(manifest.status, "completed");
      return { inputs: ling.inputs, manifest };
    };
    const seededAccepted = (input: SpawnInput | undefined): string[] =>
      Object.keys(input?.files ?? {}).filter((name) => name.startsWith("accepted/"));

    const scoped = await runTwoSlices("slice-deps-scoped", []);
    const scopedBuilders = scoped.inputs.filter((input) => input.task.startsWith("Build only"));
    const scopedReviewers = scoped.inputs.filter((input) =>
      input.task.startsWith("Review the disposable"),
    );
    assert.deepEqual(seededAccepted(scopedBuilders[1]), []);
    assert.deepEqual(seededAccepted(scopedReviewers[1]), []);
    // Integration still verifies cross-slice consistency, so it keeps both.
    const integration = scoped.inputs.find((input) =>
      input.task.startsWith("Perform final integration"),
    );
    assert.equal(seededAccepted(integration).length, 2);
    const scopedAnalysis = analyzeCampaignCoordination(scoped.manifest);
    assert.equal(scopedAnalysis.metrics.artifactSeedEdges, 4);
    assert.equal(scopedAnalysis.metrics.acceptedArtifactSeedEdges, 2);
    assert.equal(scopedAnalysis.metrics.proposalArtifactSeedEdges, 2);
    assert.equal(scopedAnalysis.metrics.crossSliceArtifactSeedEdges, 0);

    const unscoped = await runTwoSlices("slice-deps-default", undefined);
    const unscopedBuilders = unscoped.inputs.filter((input) =>
      input.task.startsWith("Build only"),
    );
    assert.equal(seededAccepted(unscopedBuilders[1]).length, 1);
    const unscopedAnalysis = analyzeCampaignCoordination(unscoped.manifest);
    assert.equal(unscopedAnalysis.metrics.artifactSeedEdges, 6);
    assert.equal(unscopedAnalysis.metrics.acceptedArtifactSeedEdges, 4);
    assert.equal(unscopedAnalysis.metrics.crossTaskArtifactSeedEdges, 6);
    assert.equal(unscopedAnalysis.metrics.crossSliceArtifactSeedEdges, 2);
    assert.equal(unscopedAnalysis.metrics.distinctSeededArtifacts, 2);
    assert.equal(unscopedAnalysis.metrics.maxArtifactConsumerTasks, 4);
    assert.equal(unscopedAnalysis.metrics.tasksWithUnavailableSeedProvenance, 0);
  });

  await check("a slice dependency must name a known slice", async () => {
    const root = path.join(tmpRoot, "slice-deps-unknown");
    const store = new CampaignManifestStore(path.join(root, "manifest.json"));
    const artifacts = new CampaignArtifactStore(root, path.join(root, "workspaces"));
    await assert.rejects(
      initializeCampaign(store, artifacts, {
        id: "slice-deps-unknown",
        goal: "Produce output.",
        acceptance: [criterion],
        budget: { maxTasks: 4, maxTotalCostUsd: 5 },
        slices: [{ id: "01", spec: "Write output.txt.", dependsOn: ["99"] }],
      }),
      CampaignSchemaError,
    );
  });

  await check("a task that never settles is cancelled before the campaign blocks", async () => {
    const root = path.join(tmpRoot, "settle-timeout");
    const workspaces = path.join(root, "workspaces");
    const store = new CampaignManifestStore(path.join(root, "manifest.json"));
    const artifacts = new CampaignArtifactStore(root, workspaces);
    await initializeCampaign(store, artifacts, {
      id: "stuck-campaign",
      goal: "Produce a good output.",
      acceptance: [criterion],
      budget: { maxTasks: 4, maxTotalCostUsd: 5 },
      slices: [{ id: "01", spec: "Write output.txt." }],
      roles: {
        ...DEFAULT_CAMPAIGN_ROLES,
        builder: { ...DEFAULT_CAMPAIGN_ROLES.builder, maxWallClockMs: 1 },
      },
    });
    const ling = new FakeLing(workspaces, (): FakeOutcome => ({
      result: buildResult(),
      status: "running",
    }));
    const manifest = await new CampaignDriver({
      client: ling,
      store,
      artifacts,
      policy,
      pollIntervalMs: 10,
      settleGraceMs: 50,
    }).run();
    assert.equal(manifest.status, "blocked");
    assert.deepEqual(ling.cancelled, ["task-01"]);
    assert.equal(manifest.tasks[0]?.status, "cancelled");
    assert.match(manifest.integration.gaps.at(-1) ?? "", /cancelled it/);
  });

  await check("driver shutdown cancels tracked work and persists it", async () => {
    const root = path.join(tmpRoot, "shutdown");
    const workspaces = path.join(root, "workspaces");
    const store = new CampaignManifestStore(path.join(root, "manifest.json"));
    const artifacts = new CampaignArtifactStore(root, workspaces);
    await initializeCampaign(store, artifacts, {
      id: "shutdown-campaign",
      goal: "Produce output.",
      acceptance: [criterion],
      budget: { maxTasks: 4, maxTotalCostUsd: 5 },
      slices: [{ id: "01", spec: "Write output.txt." }],
    });
    const ling = new FakeLing(workspaces, (): FakeOutcome => ({
      result: buildResult(),
      status: "running",
    }));
    const driver = new CampaignDriver({
      client: ling,
      store,
      artifacts,
      policy,
      pollIntervalMs: 10,
    });
    const run = driver.run();
    while (ling.inputs.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    await driver.shutdown();
    await run;
    const persisted = await store.load();
    assert.deepEqual(ling.cancelled, ["task-01"]);
    assert.equal(persisted.tasks[0]?.status, "cancelled");
    assert.equal(persisted.tasks[0]?.requestKey, ling.inputs[0]?.requestKey);
  });

  await check("a shutdown between a summon's persist and its POST spawns nothing", async () => {
    // The driver asked whether the campaign was running before it wrote the
    // prepared summon, and POSTed after the write without asking again, so a
    // stop that landed during the write still started a child.
    const root = path.join(tmpRoot, "shutdown-before-post");
    const workspaces = path.join(root, "workspaces");
    const store = new CampaignManifestStore(path.join(root, "manifest.json"));
    const artifacts = new CampaignArtifactStore(root, workspaces);
    await initializeCampaign(store, artifacts, {
      id: "shutdown-before-post",
      goal: "Produce output.",
      acceptance: [criterion],
      budget: { maxTasks: 4, maxTotalCostUsd: 5 },
      slices: [{ id: "01", spec: "Write output.txt." }],
    });
    const ling = new FakeLing(workspaces, (): FakeOutcome => ({
      result: buildResult(),
      status: "running",
    }));
    let stopping: Promise<void> | undefined;
    const driver: CampaignDriver = new CampaignDriver({
      client: ling,
      store,
      artifacts,
      policy,
      pollIntervalMs: 10,
      // Called inside the prepared write, before it returns: the stop lands
      // between the persist and the POST, every run.
      onProgress: (current) => {
        if (stopping === undefined && current.summons.some((intent) => intent.state === "prepared")) {
          stopping = driver.shutdown();
        }
      },
    });
    await driver.run();
    await stopping;
    assert.notEqual(stopping, undefined, "the stop was injected");
    assert.equal(ling.inputs.length, 0, "no child was started after the stop");
    const persisted = await store.load();
    assert.equal(persisted.status, "running", "a stop changes no verdict");
    assert.deepEqual(persisted.tasks, []);
    assert.deepEqual(persisted.summons, [], "nothing was asked for, so nothing is on record");
  });

  await check("a child whose POST was out when a shutdown landed is stopped and recorded", async () => {
    const root = path.join(tmpRoot, "shutdown-during-post");
    const workspaces = path.join(root, "workspaces");
    const store = new CampaignManifestStore(path.join(root, "manifest.json"));
    const artifacts = new CampaignArtifactStore(root, workspaces);
    await initializeCampaign(store, artifacts, {
      id: "shutdown-during-post",
      goal: "Produce output.",
      acceptance: [criterion],
      budget: { maxTasks: 4, maxTotalCostUsd: 5 },
      slices: [{ id: "01", spec: "Write output.txt." }],
    });
    let stopping: Promise<void> | undefined;
    let cancelledBeforeRunEnded: string[] | undefined;
    // The stop lands inside the POST, so its cancel pass sees no task yet.
    const ling = new FakeLing(workspaces, (): FakeOutcome => {
      stopping ??= driver.shutdown();
      return { result: buildResult(), status: "running" };
    });
    const driver: CampaignDriver = new CampaignDriver({
      client: ling,
      store,
      artifacts,
      policy,
      pollIntervalMs: 10,
    });
    await driver.run().then(() => {
      cancelledBeforeRunEnded = [...ling.cancelled];
    });
    await stopping;
    assert.equal(ling.inputs.length, 1);
    // The loop stops the child itself, rather than leaving it to a shutdown
    // pass that runs only if the loop settles in time.
    assert.deepEqual(cancelledBeforeRunEnded, ["task-01"]);
    const persisted = await store.load();
    assert.equal(persisted.tasks[0]?.id, "task-01");
    assert.equal(persisted.tasks[0]?.status, "cancelled");
    assert.equal(persisted.summons[0]?.taskId, "task-01");
    assert.equal(persisted.status, "running", "a stop changes no verdict");
  });

  await check("a finished campaign restarts without contacting a worker", async () => {
    const root = path.join(tmpRoot, "finished-restart");
    const workspaces = path.join(root, "workspaces");
    const store = new CampaignManifestStore(path.join(root, "manifest.json"));
    const artifacts = new CampaignArtifactStore(root, workspaces);
    await initializeCampaign(store, artifacts, {
      id: "finished-restart",
      goal: "Produce output.",
      acceptance: [criterion],
      budget: { maxTasks: 6, maxTotalCostUsd: 5 },
      slices: [{ id: "01", spec: "Write output.txt." }],
    });
    const ling = new FakeLing(workspaces, (input): FakeOutcome => {
      if (input.task.startsWith("Build only")) {
        return { result: buildResult(), files: { "output.txt": "good" } };
      }
      if (input.task.startsWith("Review the disposable")) {
        return { result: reviewResult("review", "accept") };
      }
      if (input.task.startsWith("Perform final integration")) {
        return { result: reviewResult("integration", "accept") };
      }
      throw new Error(`Unexpected fake task: ${input.task}`);
    });
    const completed = await new CampaignDriver({
      client: ling,
      store,
      artifacts,
      policy,
      pollIntervalMs: 10,
    }).run();
    assert.equal(completed.status, "completed");

    // Reboot recovery leaves the unit enabled, so a finished campaign is started
    // again on every boot. No worker is reachable here and auto-start is off, so
    // this only exits cleanly if it settles the manifest before the fleet.
    const tsxCli = fileURLToPath(
      new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url),
    );
    const cli = fileURLToPath(new URL("./campaign.ts", import.meta.url));
    const { stdout } = await execFileAsync(
      process.execPath,
      [tsxCli, cli, "run", path.join(root, "manifest.json"), "--resume"],
      {
        env: {
          ...process.env,
          LING_AUTO_START: "false",
          LING_WORKERS_JSON: "",
          LING_BASE_URL: "http://127.0.0.1:9",
          LING_TOKEN: "unreachable",
          LING_REQUEST_TIMEOUT_MS: "500",
          FLEET_LEDGER_PATH: path.join(root, "fleet-ledger.db"),
        },
      },
    );
    assert.match(stdout, /already finished/);
  });

  await check("a capped restart reconciles and cancels active task records", async () => {
    const root = path.join(tmpRoot, "capped-active-restart");
    const workspaces = path.join(root, "workspaces");
    const store = new CampaignManifestStore(path.join(root, "manifest.json"));
    const artifacts = new CampaignArtifactStore(root, workspaces);
    await initializeCampaign(store, artifacts, {
      id: "capped-active-restart",
      goal: "Clean up stale active work.",
      acceptance: [criterion],
      budget: { maxTasks: 4, maxTotalCostUsd: 5 },
      maxRounds: 1,
      slices: [{ id: "01", spec: "Long-running work." }],
    });
    const requestKey = campaignRequestKey(
      "capped-active-restart",
      "builder",
      "01",
      1,
    );
    const activeTask: LingTask = {
      id: "active-builder",
      requestKey,
      workerId: "local",
      status: "running",
      prompt: "campaign task",
      options: {},
      createdAt: new Date().toISOString(),
      workspaceDir: path.join(workspaces, "active-builder"),
      seededFiles: [],
      stats: {
        turns: 1,
        cost: 0.01,
        tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
      },
    };
    const ling = new FakeLing(workspaces, () => {
      throw new Error("A capped restart must not spawn replacement work.");
    });
    ling.seed(activeTask);
    await store.update((manifest) => {
      transitionCampaign(manifest, "capped");
      transitionSlice(manifest, "01", "capped");
      manifest.slices[0]?.attempts.push({
        round: 1,
        builderId: activeTask.id,
        reviewerId: null,
        artifacts: [],
        verdict: "revise",
        evidence: [],
        gaps: ["campaign already capped"],
        costUsd: 0.01,
      });
      manifest.tasks.push({
        id: activeTask.id,
        requestKey,
        workerId: "local",
        role: "builder",
        sliceId: "01",
        round: 1,
        status: "running",
        costUsd: 0.01,
        totalTokens: 2,
        seedProvenance: "unavailable",
        seededArtifacts: [],
        seededMessageIds: [],
        createdAt: activeTask.createdAt,
      });
    });
    const tsxCli = fileURLToPath(
      new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url),
    );
    const cli = fileURLToPath(new URL("./campaign.ts", import.meta.url));
    await assert.rejects(
      execFileAsync(process.execPath, [tsxCli, cli, "run", store.filename], {
        env: {
          ...process.env,
          LING_AUTO_START: "false",
          LING_WORKERS_JSON: "",
          LING_BASE_URL: "http://127.0.0.1:9",
          LING_TOKEN: "unreachable",
          LING_REQUEST_TIMEOUT_MS: "100",
          FLEET_LEDGER_PATH: path.join(root, "fleet-ledger.db"),
        },
      }),
      (error: unknown) =>
        !String((error as { stdout?: unknown }).stdout ?? "").includes(
          "already finished",
        ),
    );
    const manifest = await new CampaignDriver({
      client: ling,
      store,
      artifacts,
      policy,
      pollIntervalMs: 2,
    }).run();
    assert.equal(manifest.status, "capped");
    assert.deepEqual(ling.cancelled, ["active-builder"]);
    assert.equal(manifest.tasks[0]?.status, "cancelled");
  });

  await check("planner produces versioned slices before the role loop", async () => {
    const root = path.join(tmpRoot, "planner");
    const workspaces = path.join(root, "workspaces");
    const store = new CampaignManifestStore(path.join(root, "manifest.json"));
    const artifacts = new CampaignArtifactStore(root, workspaces);
    await initializeCampaign(store, artifacts, {
      id: "planned-campaign",
      goal: "Plan and produce output.",
      acceptance: [criterion],
      budget: { maxTasks: 6, maxTotalCostUsd: 5 },
      allowPlanning: true,
    });
    const ling = new FakeLing(workspaces, (input): FakeOutcome => {
      if (input.task.startsWith("Plan this campaign")) {
        return {
          result: {
            status: "success",
            summary: "Planned one slice.",
            data: {
              kind: "plan",
              artifacts: [{ path: "plan.json" }, { path: "slices/01.md" }],
            },
            steps: ["planned"],
          },
          files: {
            "plan.json": JSON.stringify({
              version: 1,
              slices: [{ id: "01", path: "slices/01.md" }],
            }),
            "slices/01.md": "Write output.txt.",
          },
        };
      }
      if (input.task.startsWith("Build only")) {
        return { result: buildResult(), files: { "output.txt": "good" } };
      }
      if (input.task.startsWith("Review the disposable")) {
        return { result: reviewResult("review", "accept") };
      }
      return { result: reviewResult("integration", "accept") };
    });
    const manifest = await new CampaignDriver({
      client: ling,
      store,
      artifacts,
      policy,
      pollIntervalMs: 10,
    }).run();
    assert.equal(manifest.status, "completed");
    assert.equal(manifest.planning.status, "completed");
    assert.equal(manifest.slices[0]?.id, "01");
    assert.equal(manifest.tasks.length, 4);
  });

  await check("negotiated planning persists candidates before synthesis", async () => {
    const root = path.join(tmpRoot, "negotiated-planner");
    const workspaces = path.join(root, "workspaces");
    const store = new CampaignManifestStore(path.join(root, "manifest.json"));
    const artifacts = new CampaignArtifactStore(root, workspaces);
    await initializeCampaign(store, artifacts, {
      id: "negotiated-planner-campaign",
      goal: "Plan from independent perspectives and produce output.",
      acceptance: [criterion],
      budget: { maxTasks: 8, maxTotalCostUsd: 8 },
      allowPlanning: true,
      coordination: {
        enabled: true,
        planningCandidates: 2,
      },
    });
    const ling = new FakeLing(workspaces, (input): FakeOutcome => {
      if (input.task.startsWith("Independently draft candidate plan")) {
        return planResult("Independent planning proposal.");
      }
      if (input.task.startsWith("Synthesize the independently produced")) {
        assert.match(input.files?.["campaign/candidate-plan-1.json"] ?? "", /proposal/);
        assert.match(input.files?.["campaign/candidate-plan-2.json"] ?? "", /proposal/);
        return planResult("Synthesized both proposals.");
      }
      if (input.task.startsWith("Build only")) {
        return { result: buildResult(), files: { "output.txt": "good" } };
      }
      if (input.task.startsWith("Review the disposable")) {
        return { result: reviewResult("review", "accept") };
      }
      return { result: reviewResult("integration", "accept") };
    });
    const manifest = await new CampaignDriver({
      client: ling,
      store,
      artifacts,
      policy,
      pollIntervalMs: 2,
    }).run();
    assert.equal(manifest.status, "completed");
    assert.equal(manifest.planning.candidateTaskIds.length, 2);
    assert.equal(manifest.planning.candidateArtifacts.length, 2);
    assert.equal(manifest.tasks.filter((task) => task.role === "planner").length, 3);
    const synthesisTask = manifest.tasks.find(
      (task) => task.id === manifest.planning.taskId,
    );
    assert.equal(synthesisTask?.seededArtifacts.length, 2);
    assert(
      synthesisTask?.seededArtifacts.every(
        (seeded) => seeded.channel === "planning_candidate",
      ),
    );
    assert.equal(
      analyzeCampaignCoordination(manifest).metrics.planningCandidateSeedEdges,
      2,
    );
    assert.deepEqual(
      manifest.coordination.decisions.map((decision) => decision.action),
      ["request_candidate_plan", "request_candidate_plan", "synthesize_plan"],
    );
  });

  await check("negotiated planning checks token budget between candidates", async () => {
    const root = path.join(tmpRoot, "negotiated-planner-token-budget");
    const workspaces = path.join(root, "workspaces");
    const store = new CampaignManifestStore(path.join(root, "manifest.json"));
    const artifacts = new CampaignArtifactStore(root, workspaces);
    await initializeCampaign(store, artifacts, {
      id: "negotiated-planner-token-budget",
      goal: "Plan without crossing the token ceiling.",
      acceptance: [criterion],
      budget: { maxTasks: 8, maxTotalCostUsd: 8, maxTotalTokens: 2 },
      allowPlanning: true,
      coordination: {
        enabled: true,
        planningCandidates: 2,
      },
    });
    const ling = new FakeLing(workspaces, () => planResult("One bounded proposal."));
    const manifest = await new CampaignDriver({
      client: ling,
      store,
      artifacts,
      policy,
      pollIntervalMs: 2,
    }).run();
    assert.equal(manifest.status, "budget_exhausted");
    assert.equal(ling.inputs.length, 1);
    assert.equal(manifest.planning.candidateArtifacts.length, 1);
  });

  await check("explicit dependency-ready slices run in parallel batches", async () => {
    const root = path.join(tmpRoot, "parallel-slices");
    const workspaces = path.join(root, "workspaces");
    const store = new CampaignManifestStore(path.join(root, "manifest.json"));
    const artifacts = new CampaignArtifactStore(root, workspaces);
    await initializeCampaign(store, artifacts, {
      id: "parallel-slices-campaign",
      goal: "Build two independent outputs.",
      acceptance: [criterion],
      budget: { maxTasks: 8, maxTotalCostUsd: 8 },
      slices: [
        { id: "01", spec: "First independent slice.", dependsOn: [] },
        { id: "02", spec: "Second independent slice.", dependsOn: [] },
      ],
      coordination: {
        enabled: true,
        parallelSlices: true,
      },
    });
    const ling = new FakeLing(workspaces, (input): FakeOutcome => {
      if (input.task.startsWith("Build only")) {
        return { result: buildResult(), files: { "output.txt": "good" } };
      }
      if (input.task.startsWith("Review the disposable")) {
        return { result: reviewResult("review", "accept") };
      }
      return { result: reviewResult("integration", "accept") };
    });
    const manifest = await new CampaignDriver({
      client: ling,
      store,
      artifacts,
      policy: parallelPolicy,
      pollIntervalMs: 2,
    }).run();
    assert.equal(manifest.status, "completed");
    assert.equal(ling.inputs[0]?.task.startsWith("Build only"), true);
    assert.equal(ling.inputs[1]?.task.startsWith("Build only"), true);
    assert.deepEqual(
      manifest.coordination.decisions
        .filter((decision) => decision.action === "schedule_slice")
        .map((decision) => decision.refs[0]),
      ["slice:01", "slice:02"],
    );
  });

  await check("first parallel terminal outcome wins without losing sibling results", async () => {
    const root = path.join(tmpRoot, "parallel-terminal-race");
    const workspaces = path.join(root, "workspaces");
    const store = new CampaignManifestStore(path.join(root, "manifest.json"));
    const artifacts = new CampaignArtifactStore(root, workspaces);
    await initializeCampaign(store, artifacts, {
      id: "parallel-terminal-race",
      goal: "Exercise simultaneous capped slice outcomes.",
      acceptance: [criterion],
      budget: { maxTasks: 4, maxTotalCostUsd: 8 },
      maxRounds: 1,
      slices: [
        { id: "01", spec: "First invalid build.", dependsOn: [] },
        { id: "02", spec: "Second invalid build.", dependsOn: [] },
      ],
      coordination: {
        enabled: true,
        parallelSlices: true,
      },
    });
    const ling = new FakeLing(workspaces, (): FakeOutcome => ({
      result: { status: "failure", summary: "invalid", data: {}, steps: [] },
    }));
    const manifest = await new CampaignDriver({
      client: ling,
      store,
      artifacts,
      policy: parallelPolicy,
      pollIntervalMs: 2,
    }).run();
    assert.equal(manifest.status, "capped");
    assert.deepEqual(
      manifest.slices.map((slice) => slice.status),
      ["capped", "capped"],
    );
  });

  await check("a parallel build that ends after its sibling capped the campaign is still judged", async () => {
    // The check above used to pass only when both builds were read before either was
    // judged. In one or two runs in a hundred on Windows the second spawn was still in
    // flight when the first build's failure capped the campaign, and its result, read
    // after the cap, was recorded on the task and dropped from the slice, left building
    // in a campaign that is never resumed. That order is forced here: whichever build
    // is spawned second is answered only once the campaign is capped.
    const root = path.join(tmpRoot, "parallel-terminal-after-cap");
    const workspaces = path.join(root, "workspaces");
    const store = new CampaignManifestStore(path.join(root, "manifest.json"));
    const artifacts = new CampaignArtifactStore(root, workspaces);
    await initializeCampaign(store, artifacts, {
      id: "parallel-terminal-after-cap",
      goal: "Judge a build whose result arrives after its sibling capped the campaign.",
      acceptance: [criterion],
      budget: { maxTasks: 4, maxTotalCostUsd: 8 },
      maxRounds: 1,
      slices: [
        { id: "01", spec: "First invalid build.", dependsOn: [] },
        { id: "02", spec: "Second invalid build.", dependsOn: [] },
      ],
      coordination: { enabled: true, parallelSlices: true },
    });
    let markCapped!: () => void;
    const capped = new Promise<void>((resolve) => {
      markCapped = resolve;
    });
    const ling = new FakeLing(workspaces, async (_input, index): Promise<FakeOutcome> => {
      // Bounded, so a campaign that never caps fails below rather than hanging here.
      if (index === 2) {
        await Promise.race([capped, new Promise((resolve) => setTimeout(resolve, 10_000))]);
      }
      return { result: { status: "failure", summary: "invalid", data: {}, steps: [] } };
    });
    const manifest = await new CampaignDriver({
      client: ling,
      store,
      artifacts,
      policy: parallelPolicy,
      pollIntervalMs: 2,
      onProgress: (current) => {
        if (current.status === "capped") markCapped();
      },
    }).run();
    assert.equal(manifest.status, "capped");
    assert.equal(ling.inputs.length, 2);
    assert.deepEqual(
      manifest.tasks.map((task) => task.status),
      ["completed", "completed"],
    );
    assert.deepEqual(
      manifest.slices.map((slice) => slice.status),
      ["capped", "capped"],
    );
    for (const slice of manifest.slices) {
      assert.equal(slice.attempts.length, 1);
      assert.equal(slice.attempts[0]?.verdict, "revise");
      assert.match(slice.attempts[0]?.gaps[0] ?? "", /^Builder result rejected: /);
    }
    assert.deepEqual(
      (await store.load()).slices.map((slice) => slice.status),
      ["capped", "capped"],
    );
  });

  await check("a stopped parallel campaign cancels siblings still spending", async () => {
    const root = path.join(tmpRoot, "parallel-stop-cancels-sibling");
    const workspaces = path.join(root, "workspaces");
    const store = new CampaignManifestStore(path.join(root, "manifest.json"));
    const artifacts = new CampaignArtifactStore(root, workspaces);
    await initializeCampaign(store, artifacts, {
      id: "parallel-stop-cancels-sibling",
      goal: "Stop sibling spend after the first capped result.",
      acceptance: [criterion],
      budget: { maxTasks: 4, maxTotalCostUsd: 8 },
      maxRounds: 1,
      slices: [
        { id: "01", spec: "Fail quickly.", dependsOn: [] },
        { id: "02", spec: "Keep running until cancelled.", dependsOn: [] },
      ],
      coordination: { enabled: true, parallelSlices: true },
    });
    const ling = new FakeLing(workspaces, (input): FakeOutcome => {
      if (input.files?.["campaign/slice.md"] === "Fail quickly.") {
        return { result: { status: "failure", summary: "invalid", data: {}, steps: [] } };
      }
      return { result: buildResult(), status: "running" };
    });
    ling.failNextCancellations(1);
    const manifest = await new CampaignDriver({
      client: ling,
      store,
      artifacts,
      policy: parallelPolicy,
      pollIntervalMs: 2,
    }).run();
    assert.equal(manifest.status, "capped");
    assert.deepEqual(ling.cancelled, ["task-02"]);
    assert.equal(manifest.tasks.find((task) => task.id === "task-02")?.status, "cancelled");
  });

  await check("temporary parallel USD reservations defer instead of halting", async () => {
    const root = path.join(tmpRoot, "parallel-budget-deferral");
    const workspaces = path.join(root, "workspaces");
    const store = new CampaignManifestStore(path.join(root, "manifest.json"));
    const artifacts = new CampaignArtifactStore(root, workspaces);
    await initializeCampaign(store, artifacts, {
      id: "parallel-budget-deferral",
      goal: "Run cheap tasks despite conservative overlapping ceilings.",
      acceptance: [criterion],
      budget: { maxTasks: 8, maxTotalCostUsd: 1 },
      slices: [
        { id: "01", spec: "First cheap slice.", dependsOn: [] },
        { id: "02", spec: "Second cheap slice.", dependsOn: [] },
      ],
      coordination: {
        enabled: true,
        parallelSlices: true,
      },
    });
    const ling = new FakeLing(workspaces, (input): FakeOutcome => {
      if (input.task.startsWith("Build only")) {
        return {
          result: buildResult(),
          files: { "output.txt": "good" },
          settleAfterMs: 30,
        };
      }
      if (input.task.startsWith("Review the disposable")) {
        return {
          result: reviewResult("review", "accept"),
          settleAfterMs: 30,
        };
      }
      return { result: reviewResult("integration", "accept") };
    });
    const manifest = await new CampaignDriver({
      client: ling,
      store,
      artifacts,
      policy: parallelPolicy,
      pollIntervalMs: 2,
    }).run();
    assert.equal(manifest.status, "completed");
    assert.equal(manifest.spentUsdSnapshot < 1, true);
  });

  await check("shutdown releases a spawn waiting on a temporary reservation", async () => {
    const root = path.join(tmpRoot, "parallel-budget-shutdown");
    const workspaces = path.join(root, "workspaces");
    const store = new CampaignManifestStore(path.join(root, "manifest.json"));
    const artifacts = new CampaignArtifactStore(root, workspaces);
    await initializeCampaign(store, artifacts, {
      id: "parallel-budget-shutdown",
      goal: "Stop while the next parallel spawn is deferred.",
      acceptance: [criterion],
      budget: { maxTasks: 8, maxTotalCostUsd: 1 },
      slices: [
        { id: "01", spec: "First long slice.", dependsOn: [] },
        { id: "02", spec: "Deferred second slice.", dependsOn: [] },
      ],
      coordination: { enabled: true, parallelSlices: true },
    });
    const ling = new FakeLing(workspaces, (): FakeOutcome => ({
      result: buildResult(),
      status: "running",
    }));
    const driver = new CampaignDriver({
      client: ling,
      store,
      artifacts,
      policy: parallelPolicy,
      pollIntervalMs: 2,
    });
    const run = driver.run();
    while (ling.inputs.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    let shutdownTimer: NodeJS.Timeout | undefined;
    await Promise.race([
      driver.shutdown(),
      new Promise<never>((_resolve, reject) => {
        shutdownTimer = setTimeout(
          () => reject(new Error("parallel shutdown timed out")),
          1_000,
        );
      }),
    ]);
    if (shutdownTimer !== undefined) clearTimeout(shutdownTimer);
    await run;
    assert.deepEqual(ling.cancelled, ["task-01"]);
  });

  await check("passive messages persist before live delivery and later seeding", async () => {
    const root = path.join(tmpRoot, "campaign-radio");
    const workspaces = path.join(root, "workspaces");
    const store = new CampaignManifestStore(path.join(root, "manifest.json"));
    const artifacts = new CampaignArtifactStore(root, workspaces);
    await initializeCampaign(store, artifacts, {
      id: "campaign-radio-campaign",
      goal: "Build two independent outputs with live coordination.",
      acceptance: [criterion],
      budget: { maxTasks: 8, maxTotalCostUsd: 8 },
      slices: [
        { id: "01", spec: "First radio slice.", dependsOn: [] },
        { id: "02", spec: "Second radio slice.", dependsOn: [] },
      ],
      coordination: {
        enabled: true,
        parallelSlices: true,
        passiveMessaging: true,
      },
    });
    const ling = new FakeLing(workspaces, (input): FakeOutcome => {
      if (input.task.startsWith("Build only")) {
        return {
          result: buildResult(),
          files: { "output.txt": "good" },
          settleAfterMs: 500,
        };
      }
      if (input.task.startsWith("Review the disposable")) {
        return { result: reviewResult("review", "accept") };
      }
      return { result: reviewResult("integration", "accept") };
    });
    ling.scheduleEvent("task-01", 2, {
      seq: 7,
      at: "2026-08-22T16:00:00.000Z",
      type: "campaign_message",
      data: {
        thread: "worklog",
        content: "The shared format requires a trailing newline.",
        mentions: ["02"],
        priority: "urgent",
      },
    });
    const manifest = await new CampaignDriver({
      client: ling,
      store,
      artifacts,
      policy: parallelPolicy,
      pollIntervalMs: 2,
    }).run();
    assert.equal(manifest.status, "completed");
    assert.equal(manifest.coordination.messages.length, 1);
    assert.deepEqual(manifest.coordination.messages[0]?.deliveredToTaskIds, ["task-02"]);
    assert.equal(ling.injectedMessages[0]?.taskId, "task-02");
    const secondReviewer = ling.inputs.find(
      (input) =>
        input.task.startsWith("Review the disposable") &&
        input.files?.["campaign/slice.md"] === "Second radio slice.",
    );
    assert.match(
      secondReviewer?.files?.["campaign/peer-messages.json"] ?? "",
      /trailing newline/,
    );
    assert.match(
      secondReviewer?.files?.["campaign/coordination.json"] ?? "",
      /"sliceId": "02"/,
    );
    const secondReviewerRecord = manifest.tasks.find(
      (task) => task.role === "reviewer" && task.sliceId === "02",
    );
    assert.deepEqual(secondReviewerRecord?.seededMessageIds, [
      manifest.coordination.messages[0]?.id,
    ]);
    const coordinationAnalysis = analyzeCampaignCoordination(manifest);
    assert.equal(coordinationAnalysis.metrics.peerMessages, 1);
    assert.equal(coordinationAnalysis.metrics.initialPeerMessageSeedEdges, 1);
    assert.equal(coordinationAnalysis.metrics.livePeerMessageDeliveryEdges, 1);
  });

  await check("terminal SSE is drained before a radio task settles", async () => {
    const root = path.join(tmpRoot, "campaign-radio-terminal-drain");
    const workspaces = path.join(root, "workspaces");
    const store = new CampaignManifestStore(path.join(root, "manifest.json"));
    const artifacts = new CampaignArtifactStore(root, workspaces);
    await initializeCampaign(store, artifacts, {
      id: "campaign-radio-terminal-drain",
      goal: "Preserve a final pre-terminal discovery.",
      acceptance: [criterion],
      budget: { maxTasks: 8, maxTotalCostUsd: 8 },
      slices: [
        { id: "01", spec: "Fast radio source.", dependsOn: [] },
        { id: "02", spec: "Slow radio recipient.", dependsOn: [] },
      ],
      coordination: {
        enabled: true,
        parallelSlices: true,
        passiveMessaging: true,
      },
    });
    const ling = new FakeLing(workspaces, (input): FakeOutcome => {
      if (input.task.startsWith("Build only")) {
        const source = input.files?.["campaign/slice.md"] === "Fast radio source.";
        return {
          result: buildResult(),
          files: { "output.txt": "good" },
          // Summon intent persistence deliberately precedes spawn. Leave enough
          // time for the sibling's serialized admission before this fixture
          // emits its final pre-terminal message.
          settleAfterMs: source ? 500 : 1000,
        };
      }
      if (input.task.startsWith("Review the disposable")) {
        return { result: reviewResult("review", "accept") };
      }
      return { result: reviewResult("integration", "accept") };
    });
    ling.scheduleEvent(
      "task-01",
      2,
      {
        seq: 21,
        at: "2026-08-22T16:00:00.000Z",
        type: "campaign_message",
        data: {
          thread: "worklog",
          content: "Final discovery emitted immediately before completion.",
          mentions: ["02"],
          priority: "urgent",
        },
      },
      true,
    );
    const manifest = await new CampaignDriver({
      client: ling,
      store,
      artifacts,
      policy: parallelPolicy,
      pollIntervalMs: 2,
    }).run();
    assert.equal(manifest.status, "completed");
    assert.equal(manifest.coordination.messages[0]?.content.includes("Final discovery"), true);
  });

  await check("a reopened event record replays what it holds before the stream is joined", async () => {
    const id = "campaign-radio-replay";
    const root = path.join(tmpRoot, id);
    const workspaces = path.join(root, "workspaces");
    const store = new CampaignManifestStore(path.join(root, "manifest.json"));
    const artifacts = new CampaignArtifactStore(root, workspaces);
    await initializeCampaign(store, artifacts, {
      id,
      goal: "Recover a message an earlier process recorded but never handled.",
      acceptance: [criterion],
      budget: { maxTasks: 8, maxTotalCostUsd: 8 },
      slices: [
        { id: "01", spec: "Radio source.", dependsOn: [] },
        { id: "02", spec: "Radio recipient.", dependsOn: [] },
      ],
      coordination: { enabled: true, parallelSlices: true, passiveMessaging: true },
    });
    const AT = "2026-09-01T00:00:00.000Z";
    // The earlier process appended the message to its record and died before
    // handleCampaignMessage persisted it.
    const held: LingEvent[] = [
      { seq: 1, at: AT, type: "task_started" },
      {
        seq: 2,
        at: AT,
        type: "campaign_message",
        data: {
          thread: "worklog",
          content: "Recovered from the overlord's record.",
          mentions: ["02"],
          priority: "urgent",
        },
      },
    ];
    await mkdir(path.join(root, "events"), { recursive: true });
    await writeFile(
      path.join(root, "events", "radio-source.jsonl"),
      held.map((event) => `${JSON.stringify(event)}\n`).join(""),
    );
    /** Ling's stream for the source honours sinceSeq, as the real SSE replay does. */
    class ResumingFakeLing extends FakeLing {
      readonly joinedAt: number[] = [];

      override async *events(
        taskId: string,
        workerId?: string,
        options: { signal?: AbortSignal; sinceSeq?: number } = {},
      ): AsyncIterable<LingEvent> {
        if (taskId !== "radio-source") {
          yield* super.events(taskId, workerId, options);
          return;
        }
        this.joinedAt.push(options.sinceSeq ?? 0);
        const finished: LingEvent = {
          seq: 3,
          at: AT,
          type: "task_finished",
          data: { status: "completed", stoppedBy: "finished" },
        };
        while (!options.signal?.aborted) {
          const task = await this.get(taskId).catch(() => undefined);
          if (task === undefined) return;
          if (task.status !== "running") {
            for (const event of [...held, finished]) {
              if (event.seq > (options.sinceSeq ?? 0)) yield event;
            }
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
      }
    }
    const ling = new ResumingFakeLing(workspaces, (input): FakeOutcome => {
      if (input.task.startsWith("Build only")) {
        return { result: buildResult(), files: { "output.txt": "good" }, settleAfterMs: 500 };
      }
      if (input.task.startsWith("Review the disposable")) {
        return { result: reviewResult("review", "accept") };
      }
      return { result: reviewResult("integration", "accept") };
    });
    const requestKey = campaignRequestKey(id, "builder", "01", 1);
    const source: LingTask = {
      id: "radio-source",
      requestKey,
      workerId: "local",
      status: "running",
      prompt: "campaign task",
      options: {},
      createdAt: AT,
      workspaceDir: path.join(workspaces, "radio-source"),
      seededFiles: [],
      stats: {
        turns: 1,
        cost: 0.01,
        tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
      },
    };
    ling.seed(source);
    await store.update((manifest) => {
      transitionCampaign(manifest, "running");
      transitionSlice(manifest, "01", "building");
      manifest.slices[0]?.attempts.push({
        round: 1,
        builderId: source.id,
        reviewerId: null,
        artifacts: [],
        verdict: null,
        evidence: [],
        gaps: [],
        costUsd: 0,
      });
      manifest.tasks.push({
        id: source.id,
        requestKey,
        workerId: "local",
        role: "builder",
        sliceId: "01",
        round: 1,
        status: "running",
        costUsd: 0.01,
        totalTokens: 2,
        seedProvenance: "unavailable",
        seededArtifacts: [],
        seededMessageIds: [],
        createdAt: AT,
      });
    });
    const settle = setTimeout(() => {
      void (async () => {
        await mkdir(source.workspaceDir, { recursive: true });
        await writeFile(path.join(source.workspaceDir, "output.txt"), "good", "utf8");
        ling.seed({ ...source, status: "completed", result: buildResult(), finishedAt: AT });
      })();
    }, 300);
    try {
      const manifest = await new CampaignDriver({
        client: ling,
        store,
        artifacts,
        policy: parallelPolicy,
        pollIntervalMs: 2,
      }).run();
      assert.equal(manifest.status, "completed", manifest.integration.gaps.join("; "));
      assert.deepEqual(ling.joinedAt, [2], "the stream is joined after what the record holds");
      const message = manifest.coordination.messages.find(
        (candidate) => candidate.id === "radio-source:2",
      );
      assert.equal(message?.content, "Recovered from the overlord's record.");
      const recipient = manifest.tasks.find(
        (task) => task.role === "builder" && task.sliceId === "02",
      );
      assert.notEqual(recipient, undefined);
      const delivered =
        message?.deliveredToTaskIds.includes(recipient?.id ?? "") === true ||
        ling.inputs.some((input) =>
          (input.files?.["campaign/peer-messages.json"] ?? "").includes("Recovered from"),
        );
      assert.equal(delivered, true, "the recovered message reached slice 02");
    } finally {
      clearTimeout(settle);
    }
  });

  await check("run waits for in-flight radio handlers before teardown", async () => {
    const root = path.join(tmpRoot, "campaign-radio-teardown-drain");
    const workspaces = path.join(root, "workspaces");
    const store = new CampaignManifestStore(path.join(root, "manifest.json"));
    const artifacts = new CampaignArtifactStore(root, workspaces);
    await initializeCampaign(store, artifacts, {
      id: "campaign-radio-teardown-drain",
      goal: "Hold the campaign lock through radio persistence.",
      acceptance: [criterion],
      budget: { maxTasks: 8, maxTotalCostUsd: 8 },
      slices: [
        { id: "01", spec: "Radio source.", dependsOn: [] },
        { id: "02", spec: "Radio recipient.", dependsOn: [] },
      ],
      coordination: {
        enabled: true,
        parallelSlices: true,
        passiveMessaging: true,
      },
    });
    const ling = new FakeLing(workspaces, (): FakeOutcome => ({
      result: buildResult(),
      status: "running",
    }));
    const releaseMessage = ling.holdPeerMessages();
    ling.scheduleEvent("task-01", 2, {
      seq: 31,
      at: "2026-08-22T16:00:00.000Z",
      type: "campaign_message",
      data: {
        thread: "worklog",
        content: "Persist me before releasing the campaign lock.",
        mentions: ["02"],
        priority: "urgent",
      },
    });
    const driver = new CampaignDriver({
      client: ling,
      store,
      artifacts,
      policy: parallelPolicy,
      pollIntervalMs: 2,
    });
    const run = driver.run();
    while (ling.peerMessageAttempts.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    let shutdownResolved = false;
    const shutdown = driver.shutdown().then(() => {
      shutdownResolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(shutdownResolved, false);
    releaseMessage();
    await shutdown;
    await run;
    const persisted = await store.load();
    // The received message is still persisted in full, which is what holding the lock
    // through the handler is for. What it is no longer is *delivered*: shutdown now
    // cancels workers before it waits for the loop, so handing a fresh message to a
    // task being cancelled would be work started during a stop. Recording it as
    // received-but-undelivered is the true version of what happened.
    const message = persisted.coordination.messages[0];
    assert.equal(message?.content, "Persist me before releasing the campaign lock.");
    assert.deepEqual(message?.toSliceIds, ["02"]);
    assert.deepEqual(message?.deliveredToTaskIds, []);
    assert.deepEqual([...ling.cancelled].sort(), ["task-01", "task-02"]);
  });

  await check("a worker that only acknowledges cancellation is not recorded as stopped", async () => {
    // Cancellation is a request. The driver used to write `cancelled` whenever five
    // seconds passed without a terminal read, which freed the concurrency and spend
    // commitments of a task that was still running and released a worker still working.
    const root = path.join(tmpRoot, "campaign-unconfirmed-cancel");
    const workspaces = path.join(root, "workspaces");
    const store = new CampaignManifestStore(path.join(root, "manifest.json"));
    const artifacts = new CampaignArtifactStore(root, workspaces);
    await initializeCampaign(store, artifacts, {
      id: "campaign-unconfirmed-cancel",
      goal: "Time out and fail to stop.",
      acceptance: [criterion],
      budget: { maxTasks: 4, maxTotalCostUsd: 4 },
      slices: [{ id: "01", spec: "Never finish." }],
      // Short enough that the builder is timed out almost immediately.
      roles: {
        planner: { tools: ["read", "write"], maxCostUsd: 0.2, maxTurns: 4, maxWallClockMs: 50 },
        builder: { tools: ["read", "write"], maxCostUsd: 0.2, maxTurns: 4, maxWallClockMs: 50 },
        reviewer: {
          tools: ["read", "ls", "write_result"],
          maxCostUsd: 0.2,
          maxTurns: 4,
          maxWallClockMs: 50,
        },
        integration: {
          tools: ["read", "ls", "write_result"],
          maxCostUsd: 0.2,
          maxTurns: 4,
          maxWallClockMs: 50,
        },
      },
    });
    const ling = new FakeLing(workspaces, (): FakeOutcome => ({
      result: buildResult(),
      status: "running",
      settleAfterMs: 10 * 60_000,
    }));
    ling.acknowledgeCancelWithoutStopping();
    const fleetStore = new FleetLedgerStore(path.join(root, "fleet-ledger.db"));
    try {
      const driver = new CampaignDriver({
        client: ling,
        store,
        artifacts,
        policy,
        fleetStore,
        pollIntervalMs: 2,
        settleGraceMs: 50,
      });
      const manifest = await driver.run();
      // Blocked, and blocked for the honest reason.
      assert.equal(manifest.status, "blocked");
      assert.ok(ling.cancelAttempts.length > 0, "cancellation was never attempted");
      // The record still says running, because that is what the worker last reported.
      const record = manifest.tasks.find((task) => task.id === "task-01");
      assert.equal(record?.status, "running");
      // And the ledger still counts it, so its concurrency and spend commitments stand
      // rather than being freed by a status nobody observed.
      assert.deepEqual(
        fleetStore.inFlightTasks().map((task) => task.id),
        ["task-01"],
      );

      // The same rule through the other door. `shutdown`'s accounting pass runs once the
      // loop has settled — which it has, since the campaign blocked — and it used to
      // write `cancelled` for any task it could not read as terminal, then release the
      // worker still holding it.
      await driver.shutdown();
      const afterShutdown = await store.load();
      assert.equal(
        afterShutdown.tasks.find((task) => task.id === "task-01")?.status,
        "running",
      );
      assert.deepEqual(
        fleetStore.inFlightTasks().map((task) => task.id),
        ["task-01"],
      );
    } finally {
      fleetStore.close();
    }
  });

  await check("shutdown cancels remote work without waiting for the run loop", async () => {
    // The defect this covers: shutdown used to begin by awaiting the run promise, so on
    // a driver that never settles the cancellation loop was not slow, it was
    // unreachable. A killed overlord cancelled nothing and its workers kept spending.
    const root = path.join(tmpRoot, "campaign-kill-path");
    const workspaces = path.join(root, "workspaces");
    const store = new CampaignManifestStore(path.join(root, "manifest.json"));
    const artifacts = new CampaignArtifactStore(root, workspaces);
    await initializeCampaign(store, artifacts, {
      id: "campaign-kill-path",
      goal: "Wedge the loop inside a worker call.",
      acceptance: [criterion],
      budget: { maxTasks: 8, maxTotalCostUsd: 8 },
      slices: [
        { id: "01", spec: "Radio source.", dependsOn: [] },
        { id: "02", spec: "Radio recipient.", dependsOn: [] },
      ],
      coordination: { enabled: true, parallelSlices: true, passiveMessaging: true },
    });
    const ling = new FakeLing(workspaces, (): FakeOutcome => ({
      result: buildResult(),
      status: "running",
    }));
    const driver = new CampaignDriver({
      client: ling,
      store,
      artifacts,
      policy: parallelPolicy,
      pollIntervalMs: 2,
      // The driver clamps this to a one-second floor, so this is the shortest bound it
      // will honour rather than a number chosen for the test.
      shutdownSettleMs: 1_000,
    });
    const run = driver.run();
    // Wait for the manifest to hold both tasks, not merely for the fake to have seen
    // two spawns: cancellation reads the manifest, and there is a window after a spawn
    // where the record is not in it yet.
    while ((await store.load()).tasks.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    // Now wedge every status read. The run loop is inside a request that will never
    // return, which is what a partitioned or hung worker does: it cannot notice the
    // shutdown, cannot cancel anything, and cannot settle.
    const releaseStatus = ling.holdStatus();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const before = await store.load();
    const started = Date.now();
    await driver.shutdown();
    const elapsed = Date.now() - started;
    // It returned while the loop is still stuck, having already told both workers to
    // stop. The old ordering could not return at all here: it awaited the loop first,
    // so cancellation was unreachable rather than merely late.
    assert.ok(elapsed < 3_000, `shutdown took ${elapsed}ms`);
    assert.deepEqual([...ling.cancelled].sort(), ["task-01", "task-02"]);
    // And it wrote nothing. Reconciling the books means persisting the manifest, which
    // the run loop still owns — trading a spend leak for a lost update is not a trade
    // worth making, and the next run's reconciliation settles the books from the
    // workers themselves. An unchanged `updatedAt` is the whole assertion.
    const after = await store.load();
    assert.equal(after.updatedAt, before.updatedAt, "shutdown persisted while the loop was live");
    assert.equal(after.status, "running");
    releaseStatus();
    await run;
  });

  await check("parallel radio admission enforces the message cap atomically", async () => {
    const root = path.join(tmpRoot, "campaign-radio-cap");
    const workspaces = path.join(root, "workspaces");
    const store = new CampaignManifestStore(path.join(root, "manifest.json"));
    const artifacts = new CampaignArtifactStore(root, workspaces);
    await initializeCampaign(store, artifacts, {
      id: "campaign-radio-cap",
      goal: "Race two bounded radio messages.",
      acceptance: [criterion],
      budget: { maxTasks: 8, maxTotalCostUsd: 8 },
      slices: [
        { id: "01", spec: "First radio source.", dependsOn: [] },
        { id: "02", spec: "Second radio source.", dependsOn: [] },
      ],
      coordination: {
        enabled: true,
        parallelSlices: true,
        passiveMessaging: true,
        maxMessages: 1,
      },
    });
    const ling = new FakeLing(workspaces, (input): FakeOutcome => {
      if (input.task.startsWith("Build only")) {
        return {
          result: buildResult(),
          files: { "output.txt": "good" },
          settleAfterMs: 200,
        };
      }
      if (input.task.startsWith("Review the disposable")) {
        return { result: reviewResult("review", "accept") };
      }
      return { result: reviewResult("integration", "accept") };
    });
    for (const [taskId, seq, target] of [
      ["task-01", 11, "02"],
      ["task-02", 12, "01"],
    ] as const) {
      ling.scheduleEvent(taskId, 2, {
        seq,
        at: "2026-08-22T16:00:00.000Z",
        type: "campaign_message",
        data: {
          thread: "worklog",
          content: `Message from ${taskId}.`,
          mentions: [target],
          priority: "normal",
        },
      });
    }
    const manifest = await new CampaignDriver({
      client: ling,
      store,
      artifacts,
      policy: parallelPolicy,
      pollIntervalMs: 2,
    }).run();
    assert.equal(manifest.status, "completed");
    assert.equal(manifest.coordination.messages.length, 1);
    assert.equal((await store.load()).coordination.messages.length, 1);
  });

  await check("passive messaging is required by policy instead of silently trimmed", async () => {
    const root = path.join(tmpRoot, "campaign-radio-policy");
    const workspaces = path.join(root, "workspaces");
    const store = new CampaignManifestStore(path.join(root, "manifest.json"));
    const artifacts = new CampaignArtifactStore(root, workspaces);
    await initializeCampaign(store, artifacts, {
      id: "campaign-radio-policy",
      goal: "Require the live messaging tool.",
      acceptance: [criterion],
      budget: { maxTasks: 4, maxTotalCostUsd: 8 },
      slices: [{ id: "01", spec: "Radio-enabled slice.", dependsOn: [] }],
      coordination: {
        enabled: true,
        parallelSlices: true,
        passiveMessaging: true,
      },
    });
    const ling = new FakeLing(workspaces, () => {
      throw new Error("A policy-trimmed radio task must not spawn.");
    });
    const manifest = await new CampaignDriver({
      client: ling,
      store,
      artifacts,
      policy: {
        ...parallelPolicy,
        allowedTools: parallelPolicy.allowedTools.filter(
          (tool) => tool !== "campaign_send",
        ),
      },
      pollIntervalMs: 2,
    }).run();
    assert.equal(manifest.status, "blocked");
    assert.equal(ling.inputs.length, 0);
    assert.match(manifest.integration.gaps.at(-1) ?? "", /campaign_send/);
  });

  await check("integration gaps deterministically reopen the tagged slice", async () => {
    const root = path.join(tmpRoot, "integration-retry");
    const workspaces = path.join(root, "workspaces");
    const store = new CampaignManifestStore(path.join(root, "manifest.json"));
    const artifacts = new CampaignArtifactStore(root, workspaces);
    await initializeCampaign(store, artifacts, {
      id: "integration-retry-campaign",
      goal: "Produce integrated output.",
      acceptance: [criterion],
      budget: { maxTasks: 8, maxTotalCostUsd: 5 },
      maxRounds: 2,
      slices: [{ id: "01", spec: "Write output.txt." }],
    });
    let integrations = 0;
    const ling = new FakeLing(workspaces, (input) => {
      if (input.task.startsWith("Build only")) {
        return { result: buildResult(), files: { "output.txt": "good" } };
      }
      if (input.task.startsWith("Review the disposable")) {
        return { result: reviewResult("review", "accept") };
      }
      integrations += 1;
      return {
        result: reviewResult("integration", integrations === 1 ? "revise" : "accept"),
      };
    });
    const manifest = await new CampaignDriver({
      client: ling,
      store,
      artifacts,
      policy,
      pollIntervalMs: 10,
    }).run();
    assert.equal(manifest.status, "completed");
    assert.equal(manifest.slices[0]?.attempts.length, 2);
    assert.equal(manifest.integration.attempts.length, 2);
    const builders = ling.inputs.filter((input) => input.task.startsWith("Build only"));
    assert.match(builders[1]?.files?.["campaign/prior-gaps.txt"] ?? "", /\[slice:01\]/);
  });

  await check("brain retries invalid choices, persists fallback, then acts", async () => {
    const root = path.join(tmpRoot, "brain-fallback");
    const workspaces = path.join(root, "workspaces");
    const store = new CampaignManifestStore(path.join(root, "manifest.json"));
    const artifacts = new CampaignArtifactStore(root, workspaces);
    await initializeCampaign(store, artifacts, {
      id: "brain-fallback",
      goal: "Produce output with replayable scheduling.",
      acceptance: [criterion],
      budget: { maxTasks: 6, maxTotalCostUsd: 5 },
      slices: [{ id: "01", spec: "Write output.txt." }],
      brain: { enabled: true, maxDecisions: 8 },
    });
    const brain = new FakeBrain(2, () => ({
      action: "invented_illegal_action",
      rationale: "This must be rejected.",
      arguments: {},
    }));
    let firstSpawn = true;
    const ling = new FakeLing(workspaces, async (input) => {
      if (firstSpawn) {
        firstSpawn = false;
        const beforeSpawn = await store.load();
        const decision = beforeSpawn.brain.decisions[0];
        assert.equal(decision?.source, "fallback");
        assert.notEqual(decision?.appliedAt, null);
      }
      if (input.task.startsWith("Build only")) {
        return { result: buildResult(), files: { "output.txt": "good" } };
      }
      if (input.task.startsWith("Review the disposable")) {
        return { result: reviewResult("review", "accept") };
      }
      return { result: reviewResult("integration", "accept") };
    });
    const manifest = await new CampaignDriver({
      client: ling,
      store,
      artifacts,
      policy,
      brain,
      pollIntervalMs: 2,
    }).run();
    assert.equal(manifest.status, "completed");
    assert.equal(brain.requests.length, 2);
    assert.equal(manifest.brain.decisions[0]?.action, "schedule_slices");
    assert.equal(manifest.brain.decisions[0]?.source, "fallback");
  });

  await check("a full decision window takes the fallback instead of the model", async () => {
    const root = path.join(tmpRoot, "brain-rate-window");
    const workspaces = path.join(root, "workspaces");
    const store = new CampaignManifestStore(path.join(root, "manifest.json"));
    const artifacts = new CampaignArtifactStore(root, workspaces);
    await initializeCampaign(store, artifacts, {
      id: "brain-rate-window",
      goal: "Produce output without consulting a rate-limited model.",
      acceptance: [criterion],
      budget: { maxTasks: 6, maxTotalCostUsd: 5 },
      slices: [{ id: "01", spec: "Write output.txt." }],
      brain: { enabled: true, maxDecisions: 8 },
    });
    const fleetStore = new FleetLedgerStore(path.join(root, "fleet-ledger.db"), {
      rateWindowMs: 60_000,
    });
    // The window is already full before the campaign starts.
    fleetStore.recordDecision("someone-else");
    const brain = new FakeBrain(1, () => ({
      action: "schedule_slices",
      rationale: "The model should never be asked.",
      arguments: { sliceIds: ["01"] },
    }));
    const ling = new FakeLing(workspaces, (input) => {
      if (input.task.startsWith("Build only")) {
        return { result: buildResult(), files: { "output.txt": "good" } };
      }
      if (input.task.startsWith("Review the disposable")) {
        return { result: reviewResult("review", "accept") };
      }
      return { result: reviewResult("integration", "accept") };
    });
    try {
      const manifest = await new CampaignDriver({
        client: ling,
        store,
        artifacts,
        policy,
        brain,
        fleetStore,
        rateLimits: { windowMs: 60_000, maxDecisions: 1 },
        pollIntervalMs: 2,
      }).run();
      // The campaign still completes. A pace control that turned into an outage would
      // be a worse pace control, and the deterministic fallback is already the tested
      // route for "the model did not answer".
      assert.equal(manifest.status, "completed");
      assert.equal(brain.requests.length, 0, "the model was consulted despite a full window");
      assert.ok(manifest.brain.decisions.length > 0);
      assert.equal(
        manifest.brain.decisions.every((decision) => decision.source === "fallback"),
        true,
      );
      // The reason is recorded, because a fallback with no stated cause is how a dead
      // brain hides behind a healthy-looking decision count.
      assert.match(manifest.brain.decisions[0]?.rationale ?? "", /rate_decisions/);
      // And nothing was counted against the window, since no decision reached a model.
      assert.equal(fleetStore.windowTotal("decision", 60_000), 1);

      // The counting half, on a window with room: a limit that never counts anything
      // permits everything, so the two directions are asserted together.
      const secondRoot = path.join(tmpRoot, "brain-rate-window-open");
      const secondStore = new CampaignManifestStore(path.join(secondRoot, "manifest.json"));
      const secondArtifacts = new CampaignArtifactStore(
        secondRoot,
        path.join(secondRoot, "workspaces"),
      );
      await initializeCampaign(secondStore, secondArtifacts, {
        id: "brain-rate-window-open",
        goal: "Consult the model within its window.",
        acceptance: [criterion],
        budget: { maxTasks: 6, maxTotalCostUsd: 5 },
        slices: [{ id: "01", spec: "Write output.txt." }],
        brain: { enabled: true, maxDecisions: 8 },
      });
      const willingBrain = new FakeBrain(1, () => ({
        action: "schedule_slices",
        rationale: "Within the window.",
        arguments: { sliceIds: ["01"] },
      }));
      const secondManifest = await new CampaignDriver({
        client: new FakeLing(path.join(secondRoot, "workspaces"), (input) => {
          if (input.task.startsWith("Build only")) {
            return { result: buildResult(), files: { "output.txt": "good" } };
          }
          if (input.task.startsWith("Review the disposable")) {
            return { result: reviewResult("review", "accept") };
          }
          return { result: reviewResult("integration", "accept") };
        }),
        store: secondStore,
        artifacts: secondArtifacts,
        policy,
        brain: willingBrain,
        fleetStore,
        rateLimits: { windowMs: 60_000, maxDecisions: 50 },
        pollIntervalMs: 2,
      }).run();
      assert.equal(secondManifest.status, "completed");
      assert.ok(willingBrain.requests.length > 0, "the model was never consulted");
      assert.equal(
        fleetStore.windowTotal("decision", 60_000),
        1 + secondManifest.brain.decisions.length,
      );

      // And counted with no limit configured at all, because a window nobody is
      // enforcing yet is the record an operator sizes the limit from.
      const beforeUnlimited = fleetStore.windowTotal("decision", 60_000);
      const thirdRoot = path.join(tmpRoot, "brain-rate-window-unlimited");
      const thirdStore = new CampaignManifestStore(path.join(thirdRoot, "manifest.json"));
      const thirdArtifacts = new CampaignArtifactStore(
        thirdRoot,
        path.join(thirdRoot, "workspaces"),
      );
      await initializeCampaign(thirdStore, thirdArtifacts, {
        id: "brain-rate-window-unlimited",
        goal: "Consult the model with no window configured.",
        acceptance: [criterion],
        budget: { maxTasks: 6, maxTotalCostUsd: 5 },
        slices: [{ id: "01", spec: "Write output.txt." }],
        brain: { enabled: true, maxDecisions: 8 },
      });
      const thirdManifest = await new CampaignDriver({
        client: new FakeLing(path.join(thirdRoot, "workspaces"), (input) => {
          if (input.task.startsWith("Build only")) {
            return { result: buildResult(), files: { "output.txt": "good" } };
          }
          if (input.task.startsWith("Review the disposable")) {
            return { result: reviewResult("review", "accept") };
          }
          return { result: reviewResult("integration", "accept") };
        }),
        store: thirdStore,
        artifacts: thirdArtifacts,
        policy,
        brain: new FakeBrain(1, () => ({
          action: "schedule_slices",
          rationale: "No window at all.",
          arguments: { sliceIds: ["01"] },
        })),
        fleetStore,
        pollIntervalMs: 2,
      }).run();
      assert.equal(thirdManifest.status, "completed");
      assert.equal(
        fleetStore.windowTotal("decision", 60_000),
        beforeUnlimited + thirdManifest.brain.decisions.length,
      );
    } finally {
      fleetStore.close();
    }
  });

  await check("review revision remains reviewing until its brain decision is durable", async () => {
    const root = path.join(tmpRoot, "brain-review-crash-window");
    const workspaces = path.join(root, "workspaces");
    const store = new CampaignManifestStore(path.join(root, "manifest.json"));
    const artifacts = new CampaignArtifactStore(root, workspaces);
    await initializeCampaign(store, artifacts, {
      id: "brain-review-window",
      goal: "Do not retry before the decision is recorded.",
      acceptance: [criterion],
      budget: { maxTasks: 6, maxTotalCostUsd: 5 },
      maxRounds: 2,
      slices: [{ id: "01", spec: "Write output.txt." }],
      brain: { enabled: true, maxDecisions: 8 },
    });
    const brain = new FakeBrain(1, async (request) => {
      if (request.phase === "scheduling") {
        return {
          action: "schedule_slices",
          rationale: "Run the ready slice.",
          arguments: { sliceIds: ["01"] },
        };
      }
      if (request.phase === "reviewing") {
        const beforeDecision = await store.load();
        assert.equal(beforeDecision.slices[0]?.status, "reviewing");
        assert.equal(beforeDecision.slices[0]?.attempts[0]?.verdict, "revise");
        return {
          action: "halt_campaign",
          rationale: "Exercise the crash-safe halt path.",
          arguments: {},
        };
      }
      throw new Error(`Unexpected brain phase ${request.phase}.`);
    });
    const ling = new FakeLing(workspaces, (input) => {
      if (input.task.startsWith("Build only")) {
        return { result: buildResult(), files: { "output.txt": "bad" } };
      }
      return { result: reviewResult("review", "revise") };
    });
    const manifest = await new CampaignDriver({
      client: ling,
      store,
      artifacts,
      policy,
      brain,
      pollIntervalMs: 2,
    }).run();
    assert.equal(manifest.status, "blocked");
    assert.equal(ling.inputs.filter((input) => input.task.startsWith("Build only")).length, 1);
    assert.equal(
      manifest.brain.decisions.find((decision) => decision.phase === "reviewing")?.appliedAt ===
        null,
      false,
    );
  });

  await check("pending recovery survives a crash before its delay elapses", async () => {
    const root = path.join(tmpRoot, "brain-pending-recovery");
    const workspaces = path.join(root, "workspaces");
    const store = new CampaignManifestStore(path.join(root, "manifest.json"));
    const artifacts = new CampaignArtifactStore(root, workspaces);
    await initializeCampaign(store, artifacts, {
      id: "brain-pending-recovery",
      goal: "Resume a previously decided recovery.",
      acceptance: [criterion],
      budget: { maxTasks: 6, maxTotalCostUsd: 5 },
      maxRounds: 2,
      slices: [{ id: "01", spec: "Write output.txt." }],
      brain: { enabled: true, maxDecisions: 8, maxHaltReopens: 1 },
    });
    const decisionKey = "recovery:1:blocked:fixture";
    const notBefore = new Date(Date.now() + 30).toISOString();
    await store.update((manifest) => {
      transitionCampaign(manifest, "blocked");
      manifest.integration.gaps.push("Transient fixture halt.");
      manifest.brain.decisions.push({
        seq: 1,
        key: decisionKey,
        at: new Date().toISOString(),
        phase: "recovery",
        source: "model",
        model: "fixture-local-model",
        action: "reopen_campaign",
        rationale: "The transient cause should be retried after a delay.",
        arguments: { delayMs: 30 },
        legalActions: ["reopen_campaign", "leave_halted"],
        stateHash: "0".repeat(64),
        appliedAt: null,
      });
      manifest.brain.pendingRecovery = { decisionKey, notBefore };
    });
    const ling = new FakeLing(workspaces, (input) => {
      if (input.task.startsWith("Build only")) {
        return { result: buildResult(), files: { "output.txt": "good" } };
      }
      if (input.task.startsWith("Review the disposable")) {
        return { result: reviewResult("review", "accept") };
      }
      return { result: reviewResult("integration", "accept") };
    });
    const startedAt = Date.now();
    const manifest = await new CampaignDriver({
      client: ling,
      store,
      artifacts,
      policy,
      pollIntervalMs: 2,
    }).run();
    assert.equal(manifest.status, "completed");
    assert.equal(manifest.brain.pendingRecovery, null);
    assert.equal(manifest.brain.haltReopensUsed, 1);
    assert.notEqual(
      manifest.brain.decisions.find((decision) => decision.key === decisionKey)?.appliedAt,
      null,
    );
    assert(Date.now() - startedAt >= 20);
  });

  await check("failed reconciliation consumes one pending recovery without looping", async () => {
    const root = path.join(tmpRoot, "brain-recovery-reconcile-failure");
    const workspaces = path.join(root, "workspaces");
    const store = new CampaignManifestStore(path.join(root, "manifest.json"));
    const artifacts = new CampaignArtifactStore(root, workspaces);
    await initializeCampaign(store, artifacts, {
      id: "brain-reconcile-failure",
      goal: "Stop after one failed recovery reconciliation.",
      acceptance: [criterion],
      budget: { maxTasks: 6, maxTotalCostUsd: 5 },
      maxRounds: 2,
      slices: [{ id: "01", spec: "Write output.txt." }],
      brain: { enabled: true, maxDecisions: 8, maxHaltReopens: 1 },
    });
    const decisionKey = "recovery:1:blocked:reconcile-fixture";
    const activeTask: LingTask = {
      id: "unreachable-task",
      requestKey: campaignRequestKey(
        "brain-reconcile-failure",
        "builder",
        "01",
        1,
      ),
      workerId: "unreachable",
      status: "running",
      prompt: "Build.",
      options: {},
      createdAt: new Date().toISOString(),
      workspaceDir: path.join(workspaces, "unreachable-task"),
      seededFiles: [],
      stats: {
        turns: 0,
        cost: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    await store.update((manifest) => {
      transitionCampaign(manifest, "running");
      transitionSlice(manifest, "01", "building");
      manifest.slices[0]?.attempts.push({
        round: 1,
        builderId: activeTask.id,
        reviewerId: null,
        artifacts: [],
        verdict: null,
        evidence: [],
        gaps: [],
        costUsd: 0,
      });
      manifest.tasks.push({
        id: activeTask.id,
        requestKey: activeTask.requestKey,
        workerId: activeTask.workerId,
        role: "builder",
        sliceId: "01",
        round: 1,
        status: "running",
        costUsd: 0,
        totalTokens: 0,
        seedProvenance: "unavailable",
        seededArtifacts: [],
        seededMessageIds: [],
        createdAt: activeTask.createdAt,
      });
      transitionCampaign(manifest, "blocked");
      manifest.brain.haltReopensUsed = 1;
      manifest.brain.decisions.push({
        seq: 1,
        key: decisionKey,
        at: new Date().toISOString(),
        phase: "recovery",
        source: "model",
        model: "fixture-local-model",
        action: "reopen_campaign",
        rationale: "Retry worker reconciliation once.",
        arguments: { delayMs: 0 },
        legalActions: ["reopen_campaign", "leave_halted"],
        stateHash: "1".repeat(64),
        appliedAt: new Date().toISOString(),
      });
      manifest.brain.pendingRecovery = {
        decisionKey,
        notBefore: new Date().toISOString(),
      };
    });
    let listCalls = 0;
    const unavailable: CampaignLingClient = {
      async spawn() {
        throw new Error("No spawn expected.");
      },
      async get() {
        throw new Error("Task reads must not run after listing fails.");
      },
      async list() {
        listCalls += 1;
        throw new LingClientError("Worker unavailable", 503, true);
      },
      async cancel() {},
    };
    const manifest = await new CampaignDriver({
      client: unavailable,
      store,
      artifacts,
      policy,
      pollIntervalMs: 2,
    }).run();
    assert.equal(manifest.status, "blocked");
    assert.equal(manifest.brain.pendingRecovery, null);
    assert.equal(listCalls, 1);
  });

  await check("brain can add bounded slices after integration revision", async () => {
    const root = path.join(tmpRoot, "brain-replan");
    const workspaces = path.join(root, "workspaces");
    const store = new CampaignManifestStore(path.join(root, "manifest.json"));
    const artifacts = new CampaignArtifactStore(root, workspaces);
    await initializeCampaign(store, artifacts, {
      id: "brain-replan",
      goal: "Produce and repair integrated output.",
      acceptance: [criterion],
      budget: { maxTasks: 10, maxTotalCostUsd: 8 },
      maxRounds: 3,
      slices: [{ id: "01", spec: "Write the primary output.", dependsOn: [] }],
      coordination: { enabled: true, parallelSlices: true },
      brain: { enabled: true, maxDecisions: 12 },
    });
    const brain = new FakeBrain(1, (request) => {
      if (request.phase === "scheduling") {
        const ready = request.state["readySlices"] as Array<{ id: string }>;
        return {
          action: "schedule_slices",
          rationale: "Run the dependency-ready work.",
          arguments: { sliceIds: [ready[0]?.id] },
        };
      }
      if (request.phase === "integration") {
        return {
          action: "replan",
          rationale: "The integration gap needs a dedicated repair slice.",
          arguments: {
            retrySliceIds: [],
            slices: [
              {
                id: "repair",
                spec: "Create repair.txt documenting and resolving the integration mismatch.",
                dependsOn: ["01"],
              },
            ],
          },
        };
      }
      throw new Error(`Unexpected brain phase ${request.phase}.`);
    });
    let integrations = 0;
    const ling = new FakeLing(workspaces, (input) => {
      if (input.task.startsWith("Build only")) {
        const repair = input.files?.["campaign/slice.md"]?.includes("repair.txt") === true;
        const outputPath = repair ? "repair.txt" : "output.txt";
        return {
          result: buildResult(outputPath),
          files: { [outputPath]: repair ? "fixed" : "good" },
        };
      }
      if (input.task.startsWith("Review the disposable")) {
        return { result: reviewResult("review", "accept") };
      }
      integrations += 1;
      return {
        result: reviewResult("integration", integrations === 1 ? "revise" : "accept"),
      };
    });
    const manifest = await new CampaignDriver({
      client: ling,
      store,
      artifacts,
      policy: parallelPolicy,
      brain,
      pollIntervalMs: 2,
    }).run();
    assert.equal(manifest.status, "completed");
    assert.equal(manifest.brain.replansUsed, 1);
    assert.equal(manifest.slices.find((slice) => slice.id === "repair")?.createdInRound, 1);
    assert.equal(manifest.slices.find((slice) => slice.id === "repair")?.status, "accepted");
    assert(
      manifest.brain.decisions.some(
        (decision) => decision.phase === "integration" && decision.action === "replan",
      ),
    );
  });

  await check("brain diagnoses and reopens one transient halted campaign", async () => {
    const root = path.join(tmpRoot, "brain-recovery");
    const workspaces = path.join(root, "workspaces");
    const store = new CampaignManifestStore(path.join(root, "manifest.json"));
    const artifacts = new CampaignArtifactStore(root, workspaces);
    await initializeCampaign(store, artifacts, {
      id: "brain-recovery",
      goal: "Recover from one transient review block.",
      acceptance: [criterion],
      budget: { maxTasks: 8, maxTotalCostUsd: 8 },
      maxRounds: 2,
      slices: [{ id: "01", spec: "Write output.txt." }],
      brain: { enabled: true, maxDecisions: 12, maxHaltReopens: 1 },
    });
    const brain = new FakeBrain(1, (request) => {
      if (request.phase === "scheduling") {
        const ready = request.state["readySlices"] as Array<{ id: string }>;
        return {
          action: "schedule_slices",
          rationale: "Run the ready slice.",
          arguments: { sliceIds: [ready[0]?.id] },
        };
      }
      if (request.phase === "recovery") {
        return {
          action: "reopen_campaign",
          rationale: "The first review block is plausibly transient.",
          arguments: { delayMs: 0 },
        };
      }
      throw new Error(`Unexpected brain phase ${request.phase}.`);
    });
    let reviews = 0;
    const ling = new FakeLing(workspaces, (input) => {
      if (input.task.startsWith("Build only")) {
        return { result: buildResult(), files: { "output.txt": "good" } };
      }
      if (input.task.startsWith("Review the disposable")) {
        reviews += 1;
        return {
          result: reviewResult("review", reviews === 1 ? "blocked" : "accept"),
        };
      }
      return { result: reviewResult("integration", "accept") };
    });
    const manifest = await new CampaignDriver({
      client: ling,
      store,
      artifacts,
      policy,
      brain,
      pollIntervalMs: 2,
    }).run();
    assert.equal(manifest.status, "completed");
    assert.equal(manifest.brain.haltReopensUsed, 1);
    assert.equal(manifest.slices[0]?.attempts.length, 2);
    assert(
      manifest.brain.decisions.some(
        (decision) => decision.phase === "recovery" && decision.action === "reopen_campaign",
      ),
    );
  });

  await check("brain-driven integration cannot replan past maxRounds", async () => {
    const root = path.join(tmpRoot, "brain-round-cap");
    const workspaces = path.join(root, "workspaces");
    const store = new CampaignManifestStore(path.join(root, "manifest.json"));
    const artifacts = new CampaignArtifactStore(root, workspaces);
    await initializeCampaign(store, artifacts, {
      id: "brain-round-cap",
      goal: "Respect the global integration cap.",
      acceptance: [criterion],
      budget: { maxTasks: 6, maxTotalCostUsd: 5 },
      maxRounds: 1,
      slices: [{ id: "01", spec: "Write output.txt." }],
      brain: { enabled: true, maxDecisions: 8 },
    });
    const brain = new FakeBrain(1, (request) => {
      if (request.phase !== "scheduling") {
        throw new Error("The model must not be asked to bypass the round cap.");
      }
      return {
        action: "schedule_slices",
        rationale: "Run the only ready slice.",
        arguments: { sliceIds: ["01"] },
      };
    });
    const ling = new FakeLing(workspaces, (input) => {
      if (input.task.startsWith("Build only")) {
        return { result: buildResult(), files: { "output.txt": "good" } };
      }
      if (input.task.startsWith("Review the disposable")) {
        return { result: reviewResult("review", "accept") };
      }
      return { result: reviewResult("integration", "revise") };
    });
    const manifest = await new CampaignDriver({
      client: ling,
      store,
      artifacts,
      policy,
      brain,
      pollIntervalMs: 2,
    }).run();
    assert.equal(manifest.status, "capped");
    assert.equal(brain.requests.filter((request) => request.phase === "integration").length, 0);
  });

  await check("fleet budget is checked before every spawn", async () => {
    const root = path.join(tmpRoot, "budget");
    const workspaces = path.join(root, "workspaces");
    const store = new CampaignManifestStore(path.join(root, "manifest.json"));
    const artifacts = new CampaignArtifactStore(root, workspaces);
    await initializeCampaign(store, artifacts, {
      id: "budget-campaign",
      goal: "Produce output.",
      acceptance: [criterion],
      budget: { maxTasks: 5, maxTotalCostUsd: 0.1 },
      slices: [{ id: "01", spec: "Write output.txt." }],
    });
    const ling = new FakeLing(workspaces, () => {
      throw new Error("A budget-exhausted campaign must not spawn.");
    });
    const manifest = await new CampaignDriver({
      client: ling,
      store,
      artifacts,
      policy,
      pollIntervalMs: 10,
    }).run();
    assert.equal(manifest.status, "budget_exhausted");
    assert.equal(ling.inputs.length, 0);
  });

  await check("campaign token budget stops the next worker task", async () => {
    const root = path.join(tmpRoot, "token-budget");
    const workspaces = path.join(root, "workspaces");
    const store = new CampaignManifestStore(path.join(root, "manifest.json"));
    const artifacts = new CampaignArtifactStore(root, workspaces);
    await initializeCampaign(store, artifacts, {
      id: "token-budget-campaign",
      goal: "Produce output.",
      acceptance: [criterion],
      budget: { maxTasks: 5, maxTotalCostUsd: 5, maxTotalTokens: 2 },
      slices: [{ id: "01", spec: "Write output.txt." }],
    });
    const ling = new FakeLing(workspaces, (input) => {
      if (input.task.startsWith("Build only")) {
        return { result: buildResult(), files: { "output.txt": "good" } };
      }
      throw new Error("The token budget must stop the reviewer from spawning.");
    });
    const manifest = await new CampaignDriver({
      client: ling,
      store,
      artifacts,
      policy,
      pollIntervalMs: 10,
    }).run();
    assert.equal(manifest.status, "budget_exhausted");
    assert.equal(ling.inputs.length, 1);
    assert.equal(manifest.tasks[0]?.totalTokens, 2);
    assert.equal(manifest.spentTokensSnapshot, 2);
  });

  await check("reconciliation adopts a request-key task missing from the manifest", async () => {
    const root = path.join(tmpRoot, "adoption");
    const workspaces = path.join(root, "workspaces");
    const store = new CampaignManifestStore(path.join(root, "manifest.json"));
    const artifacts = new CampaignArtifactStore(root, workspaces);
    await initializeCampaign(store, artifacts, {
      id: "adoption-campaign",
      goal: "Produce output.",
      acceptance: [criterion],
      budget: { maxTasks: 5, maxTotalCostUsd: 5 },
      slices: [{ id: "01", spec: "Write output.txt." }],
    });
    await store.update((manifest) => {
      transitionCampaign(manifest, "running");
      transitionSlice(manifest, "01", "building");
      manifest.slices[0]?.attempts.push({
        round: 1,
        builderId: null,
        reviewerId: null,
        artifacts: [],
        verdict: null,
        evidence: [],
        gaps: [],
        costUsd: 0,
      });
    });
    const orphanId = "accepted-before-manifest-write";
    const workspace = path.join(workspaces, orphanId);
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "output.txt"), "good", "utf8");
    const ling = new FakeLing(workspaces, (input) => {
      if (input.task.startsWith("Review the disposable")) {
        return { result: reviewResult("review", "accept") };
      }
      return { result: reviewResult("integration", "accept") };
    });
    ling.seed({
      id: orphanId,
      requestKey: campaignRequestKey("adoption-campaign", "builder", "01", 1),
      workerId: "local",
      status: "completed",
      prompt: "Build only the assigned slice.",
      options: {},
      createdAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      workspaceDir: workspace,
      seededFiles: [],
      result: buildResult(),
      stats: {
        turns: 1,
        cost: 0.01,
        tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
      },
    });
    const manifest = await new CampaignDriver({
      client: ling,
      store,
      artifacts,
      policy,
      pollIntervalMs: 10,
    }).run();
    assert.equal(manifest.status, "completed");
    assert.equal(manifest.slices[0]?.attempts[0]?.builderId, orphanId);
    const adopted = manifest.tasks.find((task) => task.id === orphanId);
    assert.equal(adopted?.workerId, "local");
    assert.equal(adopted?.seedProvenance, "unavailable");
    assert.deepEqual(adopted?.seededArtifacts, []);
    assert.deepEqual(adopted?.seededMessageIds, []);
    assert.equal(
      analyzeCampaignCoordination(manifest).metrics.tasksWithUnavailableSeedProvenance,
      1,
    );
    assert.equal(ling.inputs.length, 2);
  });

  await check("restart reconciliation blocks then explicitly retries an orphan", async () => {
    const root = path.join(tmpRoot, "recovery");
    const workspaces = path.join(root, "workspaces");
    const store = new CampaignManifestStore(path.join(root, "manifest.json"));
    const artifacts = new CampaignArtifactStore(root, workspaces);
    await initializeCampaign(store, artifacts, {
      id: "recovery-campaign",
      goal: "Produce output.",
      acceptance: [criterion],
      budget: { maxTasks: 8, maxTotalCostUsd: 5 },
      maxRounds: 2,
      slices: [{ id: "01", spec: "Write output.txt." }],
    });
    await store.update((manifest) => {
      transitionCampaign(manifest, "running");
      transitionSlice(manifest, "01", "building");
      manifest.slices[0]?.attempts.push({
        round: 1,
        builderId: "lost-task",
        reviewerId: null,
        artifacts: [],
        verdict: null,
        evidence: [],
        gaps: [],
        costUsd: 0,
      });
      manifest.tasks.push({
        id: "lost-task",
        role: "builder",
        sliceId: "01",
        round: 1,
        status: "running",
        costUsd: 0,
        totalTokens: 0,
        seedProvenance: "unavailable",
        seededArtifacts: [],
        seededMessageIds: [],
        createdAt: new Date().toISOString(),
      });
    });
    const emptyLing = new FakeLing(workspaces, () => {
      throw new Error("No task should spawn before the orphan is acknowledged.");
    });
    const blocked = await new CampaignDriver({
      client: emptyLing,
      store,
      artifacts,
      policy,
      pollIntervalMs: 10,
    }).run();
    assert.equal(blocked.status, "blocked");
    assert.equal(emptyLing.inputs.length, 0);

    const replacementLing = new FakeLing(workspaces, (input) => {
      if (input.task.startsWith("Build only")) {
        return { result: buildResult(), files: { "output.txt": "good" } };
      }
      if (input.task.startsWith("Review the disposable")) {
        return { result: reviewResult("review", "accept") };
      }
      return { result: reviewResult("integration", "accept") };
    });
    const recovered = await new CampaignDriver({
      client: replacementLing,
      store,
      artifacts,
      policy,
      pollIntervalMs: 10,
    }).run({ resumeBlocked: true });
    assert.equal(recovered.status, "completed");
    assert.equal(recovered.tasks.find((task) => task.id === "lost-task")?.status, "failed");
    assert.equal(recovered.slices[0]?.attempts.length, 2);
  });

  {
    /**
     * A ling that answers for a task it does not know as ProvisionedLingClient
     * does, with a LingProvisionerError rather than a 404.
     */
    class ProvisionedFakeLing extends FakeLing {
      constructor(
        workspacesDir: string,
        handler: FakeHandler,
        private readonly code: LingProvisionerErrorCode,
      ) {
        super(workspacesDir, handler);
      }

      override async get(id: string): Promise<LingTask> {
        try {
          return await super.get(id);
        } catch (error) {
          if (!(error instanceof LingClientError) || error.status !== 404) throw error;
          throw new LingProvisionerError(`No route to task ${id}.`, this.code);
        }
      }
    }

    /** A campaign whose builder was running when its overlord stopped, run by a new one. */
    const lostBuilder = async (name: string, code: LingProvisionerErrorCode) => {
      const root = path.join(tmpRoot, name);
      const workspaces = path.join(root, "workspaces");
      const store = new CampaignManifestStore(path.join(root, "manifest.json"));
      const artifacts = new CampaignArtifactStore(root, workspaces);
      await initializeCampaign(store, artifacts, {
        id: name,
        goal: "Produce output.",
        acceptance: [criterion],
        budget: { maxTasks: 8, maxTotalCostUsd: 5 },
        maxRounds: 2,
        slices: [{ id: "01", spec: "Write output.txt." }],
      });
      await store.update((manifest) => {
        transitionCampaign(manifest, "running");
        transitionSlice(manifest, "01", "building");
        manifest.slices[0]?.attempts.push({
          round: 1,
          builderId: "lost-task",
          reviewerId: null,
          artifacts: [],
          verdict: null,
          evidence: [],
          gaps: [],
          costUsd: 0,
        });
        manifest.tasks.push({
          id: "lost-task",
          role: "builder",
          sliceId: "01",
          round: 1,
          status: "running",
          costUsd: 0,
          totalTokens: 0,
          seedProvenance: "unavailable",
          seededArtifacts: [],
          seededMessageIds: [],
          createdAt: new Date().toISOString(),
        });
      });
      const ling = new ProvisionedFakeLing(
        workspaces,
        (input) => {
          if (input.task.startsWith("Build only")) {
            return { result: buildResult(), files: { "output.txt": "good" } };
          }
          if (input.task.startsWith("Review the disposable")) {
            return { result: reviewResult("review", "accept") };
          }
          return { result: reviewResult("integration", "accept") };
        },
        code,
      );
      const run = (resumeBlocked: boolean) =>
        new CampaignDriver({ client: ling, store, artifacts, policy, pollIntervalMs: 10 }).run(
          resumeBlocked ? { resumeBlocked: true } : {},
        );
      return { ling, run };
    };

    await check(
      "a provisioned client's unknown_task is a task not found: the orphan blocks, and a resume retries it",
      async () => {
        const { ling, run } = await lostBuilder("provisioned-unknown-task", "unknown_task");
        const blocked = await run(false);
        assert.equal(blocked.status, "blocked");
        assert.equal(ling.inputs.length, 0);
        assert.deepEqual(blocked.slices[0]?.attempts[0]?.gaps, [
          "Overlord could not reconcile this in-flight task after Ling restarted.",
        ]);
        assert.equal(
          blocked.integration.gaps.some((gap) => gap.startsWith("Worker reconciliation failed")),
          false,
        );
        const recovered = await run(true);
        assert.equal(recovered.status, "completed", recovered.integration.gaps.join("; "));
        assert.equal(recovered.tasks.find((task) => task.id === "lost-task")?.status, "failed");
        assert.equal(recovered.slices[0]?.attempts.length, 2);
      },
    );

    await check(
      "any other provisioner error stops reconcile, and a resume does not abandon the task",
      async () => {
        const { ling, run } = await lostBuilder("provisioned-worker-released", "worker_released");
        for (const resumeBlocked of [false, true]) {
          const blocked = await run(resumeBlocked);
          assert.equal(blocked.status, "blocked");
          assert.equal(
            blocked.integration.gaps.at(-1),
            "Worker reconciliation failed for task lost-task: No route to task lost-task.",
          );
          assert.equal(blocked.tasks.find((task) => task.id === "lost-task")?.status, "running");
          assert.deepEqual(blocked.slices[0]?.attempts[0]?.gaps, []);
        }
        assert.equal(ling.inputs.length, 0);
      },
    );
  }

  await check("a pending recovery delay does not outlive a shutdown request", async () => {
    const root = path.join(tmpRoot, "shutdown-during-recovery-delay");
    const workspaces = path.join(root, "workspaces");
    const store = new CampaignManifestStore(path.join(root, "manifest.json"));
    const artifacts = new CampaignArtifactStore(root, workspaces);
    await initializeCampaign(store, artifacts, {
      id: "shutdown-during-recovery-delay",
      goal: "Stay stoppable while a recovery delay is pending.",
      acceptance: [criterion],
      budget: { maxTasks: 4, maxTotalCostUsd: 5 },
      maxRounds: 2,
      slices: [{ id: "01", spec: "Write output.txt." }],
      brain: { enabled: true, maxDecisions: 8, maxHaltReopens: 2 },
    });
    const decisionKey = "recovery:1:blocked:shutdown-fixture";
    await store.update((manifest) => {
      transitionCampaign(manifest, "running");
      transitionCampaign(manifest, "blocked");
      manifest.brain.decisions.push({
        seq: 1,
        key: decisionKey,
        at: new Date().toISOString(),
        phase: "recovery",
        source: "model",
        model: "fixture-local-model",
        action: "reopen_campaign",
        rationale: "Wait, then retry.",
        arguments: { delayMs: 50_000 },
        legalActions: ["reopen_campaign", "leave_halted"],
        stateHash: "2".repeat(64),
        appliedAt: null,
      });
      // Well inside the decision ceiling, so nothing but the shutdown request can
      // end this wait early.
      manifest.brain.pendingRecovery = {
        decisionKey,
        notBefore: new Date(Date.now() + 50_000).toISOString(),
      };
    });
    const idle: CampaignLingClient = {
      async spawn() {
        throw new Error("No spawn expected while shutting down.");
      },
      async get() {
        throw new Error("No task reads expected.");
      },
      async list() {
        return [];
      },
      async cancel() {},
    };
    const driver = new CampaignDriver({
      client: idle,
      store,
      artifacts,
      policy,
      pollIntervalMs: 5,
    });
    const running = driver.run();
    const startedAt = Date.now();
    await driver.shutdown();
    const elapsedMs = Date.now() - startedAt;
    const manifest = await running;
    // The wait had 50 seconds left to run. A cooperative sleep gives the loop back
    // within a poll or two; an uninterruptible one would sit here for all of it.
    assert.ok(elapsedMs < 5_000, `shutdown took ${elapsedMs}ms during a recovery delay`);
    assert.equal(manifest.status, "blocked");
    // Shutdown is not a decision. The recovery must still be pending, and unapplied,
    // so the next run honours it instead of losing a reopen to a restart.
    assert.equal(manifest.brain.pendingRecovery?.decisionKey, decisionKey);
    assert.equal(manifest.brain.haltReopensUsed, 0);
    assert.equal(manifest.brain.decisions[0]?.appliedAt, null);
  });

  await check("a tampered notBefore cannot park recovery past the decision ceiling", async () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const soon = new Date(now + 10_000).toISOString();
    assert.equal(recoveryReconcileAt(soon, now), now + 10_000);
    // The validator caps a decision at 60s; a manifest that says otherwise was not
    // written by a decision, and must not buy a longer park than one could ask for.
    assert.equal(recoveryReconcileAt(new Date(now + 86_400_000).toISOString(), now), now + 60_000);
    assert.equal(recoveryReconcileAt("not a timestamp", now), now);
    // A deadline already past means reconcile now, never "wait for it to come round".
    assert.equal(recoveryReconcileAt(new Date(now - 5_000).toISOString(), now), now - 5_000);
  });
} finally {
  await rm(tmpRoot, { recursive: true, force: true });
}

console.log(
  failures === 0 ? "\nall campaign checks passed" : `\n${failures} campaign check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
