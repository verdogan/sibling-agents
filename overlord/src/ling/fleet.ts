import { LingClient, LingClientError, type LingEventOptions } from "./client.js";
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
} from "./types.js";

export interface LingWorkerConfig {
  id: string;
  baseUrl: string;
  token: string;
  workspacesDir?: string;
  maxConcurrency?: number;
}

export interface FleetLingClientOptions {
  workers: readonly LingWorkerConfig[];
  clientFactory?: (worker: LingWorkerConfig) => LingClient;
}

export class LingWorkerConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LingWorkerConfigError";
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LingWorkerConfigError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function workersFromEnv(env: NodeJS.ProcessEnv = process.env): LingWorkerConfig[] | undefined {
  const raw = env["LING_WORKERS_JSON"]?.trim();
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new LingWorkerConfigError("LING_WORKERS_JSON must be valid JSON.", { cause: error });
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new LingWorkerConfigError("LING_WORKERS_JSON must be a non-empty array.");
  }
  const workers = parsed.map((entry, index): LingWorkerConfig => {
    const worker = object(entry, `LING_WORKERS_JSON[${index}]`);
    const unknown = Object.keys(worker).filter(
      (key) => !["id", "baseUrl", "token", "workspacesDir", "maxConcurrency"].includes(key),
    );
    if (unknown.length > 0) {
      throw new LingWorkerConfigError(
        `LING_WORKERS_JSON[${index}] has unknown field(s): ${unknown.join(", ")}.`,
      );
    }
    const id = worker["id"];
    const baseUrl = worker["baseUrl"];
    const token = worker["token"];
    if (typeof id !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(id)) {
      throw new LingWorkerConfigError(
        `LING_WORKERS_JSON[${index}].id must use 1-64 letters, digits, dots, underscores or dashes.`,
      );
    }
    if (typeof baseUrl !== "string") {
      throw new LingWorkerConfigError(`LING_WORKERS_JSON[${index}].baseUrl must be a URL.`);
    }
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch (error) {
      throw new LingWorkerConfigError(
        `LING_WORKERS_JSON[${index}].baseUrl must be an absolute URL.`,
        { cause: error },
      );
    }
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new LingWorkerConfigError(
        `LING_WORKERS_JSON[${index}].baseUrl must use http or https.`,
      );
    }
    if (typeof token !== "string" || token.trim() === "") {
      throw new LingWorkerConfigError(
        `LING_WORKERS_JSON[${index}].token must be a non-empty worker credential.`,
      );
    }
    const maxConcurrency = worker["maxConcurrency"];
    if (
      maxConcurrency !== undefined &&
      (typeof maxConcurrency !== "number" ||
        !Number.isInteger(maxConcurrency) ||
        maxConcurrency < 1)
    ) {
      throw new LingWorkerConfigError(
        `LING_WORKERS_JSON[${index}].maxConcurrency must be a positive integer.`,
      );
    }
    const workspacesDir = worker["workspacesDir"];
    if (workspacesDir !== undefined && typeof workspacesDir !== "string") {
      throw new LingWorkerConfigError(
        `LING_WORKERS_JSON[${index}].workspacesDir must be a string.`,
      );
    }
    return {
      id,
      baseUrl: url.toString().replace(/\/+$/, ""),
      token,
      ...(typeof workspacesDir === "string" ? { workspacesDir } : {}),
      ...(typeof maxConcurrency === "number" ? { maxConcurrency } : {}),
    };
  });
  const ids = new Set<string>();
  for (const worker of workers) {
    if (ids.has(worker.id)) throw new LingWorkerConfigError(`Duplicate Ling worker id ${worker.id}.`);
    ids.add(worker.id);
  }
  return workers;
}

/**
 * Static worker registry with health-aware least-in-flight placement. Every
 * task operation can be pinned to its manifest-recorded worker. The workers
 * are long-lived, started with whatever TEMP, TMP and TMPDIR they were given,
 * and shared by the tasks they run; nothing here kills or removes one.
 */
export class FleetLingClient {
  private readonly workers = new Map<
    string,
    { config: LingWorkerConfig; client: LingClient }
  >();
  private readonly taskWorkers = new Map<string, string>();

  constructor(options: FleetLingClientOptions) {
    if (options.workers.length === 0) throw new LingWorkerConfigError("At least one worker is required.");
    for (const worker of options.workers) {
      if (this.workers.has(worker.id)) {
        throw new LingWorkerConfigError(`Duplicate Ling worker id ${worker.id}.`);
      }
      const client =
        options.clientFactory?.(worker) ??
        new LingClient({
          baseUrl: worker.baseUrl,
          token: worker.token,
          workspacesDir: worker.workspacesDir,
        });
      this.workers.set(worker.id, { config: worker, client });
    }
  }

  workerIds(): string[] {
    return [...this.workers.keys()];
  }

  async health(): Promise<Record<string, LingHealth>> {
    const result: Record<string, LingHealth> = {};
    await Promise.all(
      [...this.workers].map(async ([id, worker]) => {
        result[id] = await worker.client.health();
      }),
    );
    return result;
  }

  async spawn(input: SpawnInput, preferredWorkerId?: string): Promise<SpawnResponse> {
    const workerId =
      preferredWorkerId === undefined
        ? await this.place(input)
        : this.requireWorker(preferredWorkerId)[0];
    const worker = this.requireWorker(workerId)[1];
    const spawned = await worker.client.spawn(input);
    this.taskWorkers.set(spawned.id, workerId);
    return { ...spawned, workerId };
  }

  async get(id: string, workerId?: string): Promise<LingTask> {
    const routed = this.route(id, workerId);
    const task = await routed.client.get(id);
    this.taskWorkers.set(id, routed.id);
    return { ...task, workerId: routed.id };
  }

  /**
   * Every worker's listing, with each worker's outcome kept separate.
   *
   * `list()` flattens whatever succeeded and only throws when *every* worker fails,
   * which is right for a caller that wants best-effort visibility and wrong for one
   * deciding whether the fleet has been stopped: an unreachable worker holding a task
   * would look like an empty fleet. A reaper needs to know it did not look everywhere.
   */
  async listByWorker(): Promise<{
    tasks: LingTask[];
    failures: { workerId: string; error: string }[];
  }> {
    const selected = [...this.workers].map(([id, worker]) => ({ id, ...worker }));
    const settled = await this.listPerWorker(selected);
    const tasks: LingTask[] = [];
    const failures: { workerId: string; error: string }[] = [];
    for (const [index, result] of settled.entries()) {
      if (result.status === "fulfilled") {
        tasks.push(...result.value);
      } else {
        failures.push({
          workerId: selected[index]?.id ?? "unknown",
          error: String(result.reason),
        });
      }
    }
    return { tasks, failures };
  }

  private async listPerWorker(
    selected: { id: string; client: LingClient }[],
  ): Promise<PromiseSettledResult<LingTask[]>[]> {
    return Promise.allSettled(
      selected.map(async (worker) =>
        (await worker.client.list()).map((task) => {
          this.taskWorkers.set(task.id, worker.id);
          return { ...task, workerId: worker.id };
        }),
      ),
    );
  }

  async list(workerId?: string): Promise<LingTask[]> {
    const selected = [...this.workers].map(([id, worker]) => ({ id, ...worker }));
    if (workerId !== undefined) {
      const worker = this.route("", workerId);
      return (await worker.client.list()).map((task) => {
        this.taskWorkers.set(task.id, worker.id);
        return { ...task, workerId: worker.id };
      });
    }
    const settled = await this.listPerWorker(selected);
    const lists: LingTask[][] = [];
    for (const result of settled) {
      if (result.status === "fulfilled") lists.push(result.value);
    }
    if (lists.length === 0) {
      throw new LingClientError(
        `Every Ling worker failed task listing: ${settled
          .map((result, index) =>
            result.status === "rejected"
              ? `${selected[index]?.id ?? "unknown"}: ${String(result.reason)}`
              : "",
          )
          .filter(Boolean)
          .join("; ")}`,
        undefined,
        true,
      );
    }
    return lists.flat().sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async cancel(id: string, workerId?: string): Promise<void> {
    await this.route(id, workerId).client.cancel(id);
  }

  async *events(
    id: string,
    workerId?: string,
    options: LingEventOptions = {},
  ): AsyncIterable<LingEvent> {
    const routed = this.route(id, workerId);
    for await (const event of routed.client.events(id, options)) {
      yield event;
    }
  }

  async sendPeerMessage(
    id: string,
    message: LingPeerMessage,
    workerId?: string,
  ): Promise<LingPeerMessageResponse> {
    return this.route(id, workerId).client.sendPeerMessage(id, message);
  }

  /**
   * Routed as a peer message is (oversight-wire 4.4). A static fleet runs no
   * pair with a watcher: it has no per-task terminate(), so a campaign with one
   * refuses to start on it. A no_watcher pair runs on it and sends no
   * oversight, so this is reached only by a caller of its own. The driver
   * refuses even a no_watcher pair here when its builder's variant says what
   * the run keeps (LEASE_ONLY_VARIANTS): the fleet has no release() either,
   * and its workers outlive their tasks, with whatever those tasks left in
   * their temp directories.
   */
  async sendOversight(
    id: string,
    message: LingOversightMessage,
    workerId?: string,
  ): Promise<LingOversightResponse> {
    return this.route(id, workerId).client.sendOversight(id, message);
  }

  async listArtifacts(id: string, workerId?: string): Promise<LingArtifactList> {
    return this.route(id, workerId).client.listArtifacts(id);
  }

  async readArtifact(id: string, artifactPath: string, workerId?: string): Promise<Uint8Array> {
    return this.route(id, workerId).client.readArtifact(id, artifactPath);
  }

  private async place(input: SpawnInput): Promise<string> {
    const health = await Promise.all(
      [...this.workers].map(async ([id, worker]) => {
        try {
          const status = await worker.client.health();
          const incompatibility = this.capabilityMismatch(status, input);
          if (incompatibility !== undefined) return { id, incompatibility };
          const capacity =
            status.maxConcurrency ?? worker.config.maxConcurrency ?? 1;
          const inFlight = status.queued + (status.running ?? 0);
          return { id, score: inFlight / capacity, inFlight, capacity };
        } catch (error) {
          return { id, error };
        }
      }),
    );
    const available: Array<{
      id: string;
      score: number;
      inFlight: number;
      capacity: number;
    }> = [];
    for (const entry of health) {
      if (
        "score" in entry &&
        entry.score !== undefined &&
        entry.inFlight !== undefined &&
        entry.capacity !== undefined &&
        entry.inFlight < entry.capacity
      ) {
        available.push({
          id: entry.id,
          score: entry.score,
          inFlight: entry.inFlight,
          capacity: entry.capacity,
        });
      }
    }
    available.sort(
        (left, right) =>
          left.score - right.score ||
          left.inFlight - right.inFlight ||
          left.id.localeCompare(right.id),
      );
    const selected = available[0];
    if (selected !== undefined) return selected.id;
    const healthy = health.filter((entry) => "score" in entry);
    if (healthy.length > 0) {
      throw new LingClientError(
        "Every healthy Ling worker is at its concurrency limit.",
        429,
        true,
      );
    }
    const incompatible = health.filter((entry) => "incompatibility" in entry);
    if (incompatible.length > 0 && incompatible.length === health.length) {
      throw new LingClientError(
        `No Ling worker satisfies the requested profile: ${incompatible
          .map((entry) => `${entry.id}: ${entry.incompatibility}`)
          .join("; ")}`,
        409,
        false,
      );
    }
    const causes = health
      .map((entry) => ("error" in entry ? `${entry.id}: ${String(entry.error)}` : entry.id))
      .join("; ");
    throw new LingClientError(
      `No healthy Ling worker is available${causes === "" ? "." : `: ${causes}`}`,
      undefined,
      true,
    );
  }

  private capabilityMismatch(status: LingHealth, input: SpawnInput): string | undefined {
    if (input.provider !== undefined && status.provider !== input.provider) {
      return status.provider === undefined
        ? "provider capability is not advertised"
        : `provider is ${status.provider}, not ${input.provider}`;
    }
    if (
      input.model !== undefined &&
      status.models !== undefined &&
      !status.models.includes(input.model)
    ) {
      return `model ${input.model} is unavailable`;
    }
    if (input.skills !== undefined) {
      if (status.skills === undefined) return "named skill capabilities are not advertised";
      const missing = input.skills.filter((skill) => !status.skills!.includes(skill));
      if (missing.length > 0) return `missing named skill(s): ${missing.join(", ")}`;
    }
    if (input.inlineSkills !== undefined && input.inlineSkills.length > 0) {
      const capability = status.capabilities?.inlineSkills;
      if (capability?.enabled !== true) return "inline skills are disabled or unsupported";
      if (
        input.inlineSkills.length > capability.maxInlineSkillsPerTask ||
        input.inlineSkills.length + (input.skills?.length ?? 0) > capability.maxSkillsPerTask
      ) {
        return "inline skill count exceeds worker limits";
      }
      const bytes = input.inlineSkills.map((skill) => Buffer.byteLength(skill.content, "utf8"));
      if (
        bytes.some((size) => size > capability.maxInlineSkillBytes) ||
        bytes.reduce((sum, size) => sum + size, 0) >
          capability.maxInlineSkillsTotalBytes
      ) {
        return "inline skill bytes exceed worker limits";
      }
    }
    return undefined;
  }

  private requireWorker(
    id: string,
  ): [string, { config: LingWorkerConfig; client: LingClient }] {
    const worker = this.workers.get(id);
    if (worker === undefined) throw new LingWorkerConfigError(`Unknown Ling worker ${id}.`);
    return [id, worker];
  }

  private route(
    taskId: string,
    workerId?: string,
  ): { id: string; config: LingWorkerConfig; client: LingClient } {
    const selected = workerId ?? this.taskWorkers.get(taskId);
    if (selected !== undefined) {
      const [id, worker] = this.requireWorker(selected);
      return { id, ...worker };
    }
    if (this.workers.size === 1) {
      const entry = [...this.workers.entries()][0];
      if (entry !== undefined) return { id: entry[0], ...entry[1] };
    }
    throw new LingWorkerConfigError(
      `Task ${taskId} has no recorded worker; routing would be ambiguous.`,
    );
  }
}
