import type { LingEventOptions } from "./client.js";
import { isTerminalStatus } from "./events.js";
import type {
  LingArtifactList,
  LingEvent,
  LingFinalState,
  LingHealth,
  LingInlineSkill,
  LingOversightMessage,
  LingOversightResponse,
  LingPeerMessage,
  LingPeerMessageResponse,
  LingTask,
  LingThinkingLevel,
  SpawnInput,
  SpawnResponse,
} from "./types.js";

/** A task's own budget, as its POST /tasks asks for it. */
export interface ResolvedWorkerLimits {
  maxTurns?: number;
  maxWallClockMs?: number;
  maxCostUsd?: number;
}

const LIMIT_KEYS = ["maxTurns", "maxWallClockMs", "maxCostUsd"] as const;

export interface ResolvedWorkerProfileInput {
  /** Stable spawning-pool identity used for audit and deduplication. */
  profileId: string;
  /** Inference provider configured when the worker boots, not sent in POST /tasks. */
  provider?: string;
  tools: readonly string[];
  skills?: readonly string[];
  inlineSkills?: readonly LingInlineSkill[];
  instructions?: string;
  files?: Readonly<Record<string, string>>;
  model?: string;
  thinking?: LingThinkingLevel;
  /** Maximum lifetime for a worker summoned from this profile. */
  leaseTtlMs?: number;
  /**
   * The budget of the one task a worker from this profile runs. A provisioner
   * that runs one task per worker sets the worker's ceilings to it, since a
   * ling refuses a task that asks for more than its ceilings, and a task left
   * unset runs with them.
   */
  limits?: Readonly<ResolvedWorkerLimits>;
  /**
   * The saved browser login, by its name under ling's auth/, that the task
   * opens its browser with. A worker gets that login and no other.
   */
  storageState?: string;
}

export interface LingProvisionRequest {
  requestKey: string;
  profile: ResolvedWorkerProfileInput;
  createdAt: string;
  expiresAt: string;
}

export type ProvisionedLeaseReleaseReason =
  | "collection-complete"
  | "task-failed"
  | "task-cancelled"
  | "task-interrupted"
  | "spawn-failed"
  | "expired"
  | "shutdown";

/**
 * Why a worker was hard-killed. Unlike a release reason, none of these implies
 * the task reached a terminal state; reaching one is what failed.
 */
export type ProvisionedLeaseTerminateReason =
  /** A cancel was asked for and the task did not settle in time. */
  | "cancel-unconfirmed"
  /** The worker stopped answering. */
  | "worker-unreachable"
  /** The lease outlived its expiry with work still active. */
  | "expired"
  /** The worker's owner is gone and nothing will collect it. */
  | "orphaned"
  /** A person asked for it. */
  | "operator";

export interface ProvisionedLeaseTerminateOptions {
  /** Tasks the worker ran, so their sandbox containers can be removed by name. */
  taskIds?: readonly string[];
}

/** What terminate() did, kept on the lease. The first reason given is kept. */
export interface ProvisionedLeaseTermination {
  reason: ProvisionedLeaseTerminateReason;
  requestedAt: string;
  /**
   * Set once the worker's root process is confirmed gone, every container in
   * `containers` is removed, or listed in `errors` as one no attempt can
   * reach, and the worker's resources are released. The rest of the process
   * tree is killed as far as the host lets it be found, and is not confirmed:
   * what the kill saw survive or could not check is in `errors`, so
   * completedAt with errors is done with caveats. Absent while any of the
   * three is outstanding; terminate() can be called again, and redoes only
   * what is.
   */
  completedAt?: string;
  /** Sandbox containers whose removal was requested, by name, over every attempt. */
  containers: string[];
  /**
   * What the latest attempt could not do or confirm. A container whose removal
   * failed is listed here and holds the termination open: the container does
   * not die with the worker, and what the task started in it may still be
   * running. Caveats no retry can resolve stay listed on later attempts and do
   * not hold it open: what the kill could not confirm about the tree, a root
   * that had already exited (a crash, or a release() first) so the tree was
   * looked for without it, and containers that could not be named or found.
   */
  errors: string[];
}

/**
 * Where a worker on this host keeps its state, as its process was given it.
 * Every path but `piAgentDir` and `userProfile` is inside `runtimeDir`, and
 * goes with it at release.
 */
export interface ProvisionedWorkerRuntimePaths {
  /** The worker's own directory, and its working directory. */
  runtimeDir: string;
  /** Where its tasks' workspaces are made, one directory per task. */
  workspacesDir: string;
  /** Its HOME. */
  home: string;
  /** Its TEMP, TMP and TMPDIR, so Node's os.tmpdir() and its shells' temp files. */
  tmp: string;
  /**
   * Its PI_CODING_AGENT_DIR, when the provisioner was given one. Absent
   * otherwise, and Pi then uses its default directory under the worker's home
   * directory: its HOME on POSIX, and on Windows the host user's, since
   * USERPROFILE crosses.
   */
  piAgentDir?: string;
  /** Its USERPROFILE, the host's, when it has one: Windows passes it on. */
  userProfile?: string;
}

/**
 * A provider-owned worker and its dedicated authenticated client.
 *
 * `release` is the low-level provider teardown primitive. Application code
 * should use ProvisionedLingClient.release(), which guards completed workers
 * until collectComplete() has acknowledged durable artifact collection.
 */
export interface ProvisionedWorkerLease {
  readonly requestKey: string;
  readonly workerId: string;
  readonly profile: ResolvedWorkerProfileInput;
  readonly client: ProvisionedWorkerClient;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly released: boolean;
  /**
   * Set by a provisioner whose workers run on this host, and kept after the
   * release, so a caller can record where a task ran and see that it is gone.
   */
  readonly runtimePaths?: Readonly<ProvisionedWorkerRuntimePaths>;
  /** Set by the first terminate(); undefined for a worker that was never killed. */
  readonly termination: ProvisionedLeaseTermination | undefined;
  /**
   * What release() could not confirm about the worker's process tree when it
   * killed what outlived the stop, as ProvisionedLeaseTermination.errors does
   * for a kill. Empty before a release, for a release that finished a
   * termination, and when nothing was found surviving, which is not proof
   * that nothing did. ProvisionedLingClient passes on those of the releases
   * it makes (onReleaseCaveats); a provisioner's own release paths, such as a
   * shutdown, leave them here for their caller to read.
   */
  readonly releaseCaveats: readonly string[];
  /**
   * Stop the worker, kill whatever it started that outlived the stop, such as
   * a process its finished task backgrounded, and release its resources. Once
   * terminate() has been called, this finishes that termination instead, and
   * rejects while it cannot finish.
   */
  release(reason: ProvisionedLeaseReleaseReason): Promise<void>;
  /**
   * Kill this worker and everything it started, whatever its task is doing,
   * then release its resources as release() would. It asks the worker nothing,
   * so it works on one that is wedged or unreachable, and it touches no other
   * lease. A worker already released has had its tree killed then, so it is
   * killed again only where that release left releaseCaveats, and its
   * containers are removed either way. Nothing is collected first: whatever
   * the caller has not already copied out is lost.
   */
  terminate(
    reason: ProvisionedLeaseTerminateReason,
    options?: ProvisionedLeaseTerminateOptions,
  ): Promise<ProvisionedLeaseTermination>;
}

export interface ProvisionedWorkerClient {
  health(): Promise<LingHealth>;
  spawn(input: SpawnInput): Promise<SpawnResponse>;
  get(id: string): Promise<LingTask>;
  list(): Promise<LingTask[]>;
  cancel(id: string): Promise<void>;
  events(id: string, options?: LingEventOptions): AsyncIterable<LingEvent>;
  sendPeerMessage(
    id: string,
    message: LingPeerMessage,
  ): Promise<LingPeerMessageResponse>;
  sendOversight(id: string, message: LingOversightMessage): Promise<LingOversightResponse>;
  /** The service's own log for a task (`GET /tasks/:id/log`). */
  fetchLog(id: string): Promise<LingEvent[]>;
  listArtifacts(id: string): Promise<LingArtifactList>;
  readArtifact(id: string, artifactPath: string): Promise<Uint8Array>;
  /**
   * A terminal task's final-state record (`GET /tasks/:id/final-state`).
   * Optional, as on a client written before the route; a ProvisionedLingClient
   * refuses to read one through a worker whose client lacks it.
   */
  finalState?(id: string): Promise<LingFinalState>;
}

/** Provider-neutral worker lifecycle. Static FleetLingClient remains separate. */
export interface LingProvisioner {
  /**
   * Reconstruct every live owned lease before normal operations. Cloud
   * implementations must enumerate provider resources by ownership tags and
   * rebuild authenticated clients from durable secret references.
   */
  recover(): Promise<void>;
  summon(request: LingProvisionRequest): Promise<ProvisionedWorkerLease>;
  lease(workerId: string): ProvisionedWorkerLease | undefined;
  leases(): readonly ProvisionedWorkerLease[];
}

export type WorkerProfileResolver = (
  input: Readonly<SpawnInput>,
) => ResolvedWorkerProfileInput | Promise<ResolvedWorkerProfileInput>;

/**
 * Adapter for already-resolved campaign SpawnInput values. The task's own
 * limits and browser login become the profile's, so the worker is provisioned
 * for exactly the task it will run.
 */
export function resolvedWorkerProfileFromSpawnInput(
  input: Readonly<SpawnInput>,
): ResolvedWorkerProfileInput {
  const limits: ResolvedWorkerLimits = {};
  for (const key of LIMIT_KEYS) {
    if (input[key] !== undefined) limits[key] = input[key];
  }
  const storageState = namedLogin(input.storageState);
  return normalizeResolvedWorkerProfile({
    profileId: input.requestKey ?? "unkeyed-task",
    tools: input.tools ?? [],
    ...(input.provider === undefined ? {} : { provider: input.provider }),
    ...(input.skills === undefined ? {} : { skills: input.skills }),
    ...(input.inlineSkills === undefined ? {} : { inlineSkills: input.inlineSkills }),
    ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
    ...(input.files === undefined ? {} : { files: input.files }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.thinking === undefined ? {} : { thinking: input.thinking }),
    ...(Object.keys(limits).length === 0 ? {} : { limits }),
    ...(storageState === undefined ? {} : { storageState }),
  });
}

/** A task's storageState as ling reads it: blank names no login. */
function namedLogin(storageState: string | undefined): string | undefined {
  return storageState === undefined || storageState.trim() === "" ? undefined : storageState;
}

export interface ProvisionedLingClientOptions {
  provisioner: LingProvisioner;
  resolveProfile: WorkerProfileResolver;
  defaultLeaseTtlMs?: number;
  now?: () => number;
  onRetentionAlert?: (
    alert: ProvisionedRetentionAlert,
  ) => void | Promise<void>;
  /**
   * Told, after each release this client makes or attempts, what the lease
   * says that release could not confirm about the worker's process tree, when
   * it says anything. Default: a PROVISIONER_RELEASE_CAVEATS line on stderr.
   */
  onReleaseCaveats?: (report: ProvisionedReleaseCaveats) => void | Promise<void>;
}

/** A release that left something unconfirmed: ProvisionedWorkerLease.releaseCaveats. */
export interface ProvisionedReleaseCaveats {
  workerId: string;
  taskId: string | null;
  requestKey: string;
  reason: ProvisionedLeaseReleaseReason;
  /**
   * Whether the release finished. A release that failed after its sweep, to
   * remove a directory a survivor holds open, say, is reported too, since the
   * caveats may be why.
   */
  released: boolean;
  caveats: string[];
}

export type ProvisionedRetentionReason =
  | "collection_pending"
  | "task_active"
  | "worker_unreachable";

export interface ProvisionedRetentionAlert {
  workerId: string;
  taskId: string | null;
  requestKey: string;
  expiresAt: string;
  reason: ProvisionedRetentionReason;
  message: string;
}

export interface ProvisionedExpiryCleanupResult {
  releasedWorkerIds: string[];
  cancellationRequestedTaskIds: string[];
  /** Completed-but-uncollected, still-active, or temporarily unreadable tasks. */
  retainedTaskIds: string[];
  alerts: ProvisionedRetentionAlert[];
  errors: Array<{ workerId: string; error: unknown }>;
}

export type LingProvisionerErrorCode =
  | "invalid_request"
  | "request_key_conflict"
  /** A task known to be on a different worker from the one named. */
  | "unknown_worker"
  /** A task named with no worker, which this client has no route to. */
  | "unknown_task"
  /**
   * A worker this provisioner holds no lease for, as every worker is after a
   * restart whose recover() rebuilt none. Nothing here can reach or kill it.
   */
  | "no_lease"
  | "worker_released"
  | "task_active"
  | "collection_pending"
  | "collection_not_applicable";

export class LingProvisionerError extends Error {
  constructor(
    message: string,
    readonly code: LingProvisionerErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LingProvisionerError";
  }
}

interface TaskRoute {
  lease: ProvisionedWorkerLease;
  collectionComplete: boolean;
}

interface SpawnRequest {
  signature: string;
  promise: Promise<SpawnResponse>;
}

function nonBlank(value: string | undefined, label: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (normalized === "" || normalized.length > maxLength) {
    throw new LingProvisionerError(
      `${label} must be a non-empty string of at most ${maxLength} characters.`,
      "invalid_request",
    );
  }
  return normalized;
}

/**
 * A worker that is not asked about its tasks again: a released one cannot
 * answer, and one whose termination has completed is confirmed dead. One whose
 * termination is still open is asked as before, because a kill that has not
 * been confirmed may have left it running, and spending.
 */
function workerGone(lease: ProvisionedWorkerLease): boolean {
  return lease.released || lease.termination?.completedAt !== undefined;
}

/**
 * The cost ceiling a task ran under, as far as the overlord knows: what its
 * POST asked for, as the worker reported it back, or what its profile gave the
 * worker, whichever is higher. Undefined when neither is known, as for a task
 * that asked for none on a worker whose own ceiling the overlord never set.
 */
function costCeiling(task: LingTask, lease: ProvisionedWorkerLease): number | undefined {
  const known = [task.options.maxCostUsd, lease.profile.limits?.maxCostUsd].filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0,
  );
  return known.length === 0 ? undefined : Math.max(...known);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizedStringList(values: readonly string[], label: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = nonBlank(value, label, 128);
    if (normalized === undefined || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export function normalizeResolvedWorkerProfile(
  input: ResolvedWorkerProfileInput,
): ResolvedWorkerProfileInput {
  const profileId = nonBlank(input.profileId, "Worker profile id", 128);
  if (profileId === undefined) {
    throw new LingProvisionerError("Worker profile id is required.", "invalid_request");
  }
  const provider = nonBlank(input.provider, "Worker inference provider", 64);
  const instructions = nonBlank(input.instructions, "Worker profile instructions", 4_000);
  const model = nonBlank(input.model, "Worker profile model", 128);
  if (
    input.leaseTtlMs !== undefined &&
    (!Number.isSafeInteger(input.leaseTtlMs) || input.leaseTtlMs <= 0)
  ) {
    throw new LingProvisionerError(
      "Worker profile leaseTtlMs must be a positive safe integer.",
      "invalid_request",
    );
  }
  const limits: ResolvedWorkerLimits = {};
  for (const key of LIMIT_KEYS) {
    const value = input.limits?.[key];
    if (value === undefined) continue;
    // Positive, as ling requires of a request. Bounded, so an integer ceiling
    // written out as a decimal string never takes an exponent parseInt misreads.
    if (typeof value !== "number" || !(value > 0) || value > Number.MAX_SAFE_INTEGER) {
      throw new LingProvisionerError(
        `Worker profile limit ${key} must be a positive number of at most ${Number.MAX_SAFE_INTEGER}.`,
        "invalid_request",
      );
    }
    limits[key] = value;
  }
  // Kept as given rather than trimmed: ling resolves the name in the task's
  // own body, which is not trimmed either.
  const storageState = input.storageState;
  if (
    storageState !== undefined &&
    (typeof storageState !== "string" || storageState.trim() === "" || storageState.length > 256)
  ) {
    throw new LingProvisionerError(
      "Worker profile storageState must name a saved login in at most 256 characters.",
      "invalid_request",
    );
  }

  const files: Record<string, string> = {};
  for (const [filename, contents] of Object.entries(input.files ?? {})) {
    if (filename.trim() === "" || typeof contents !== "string") {
      throw new LingProvisionerError(
        "Worker profile files must map non-empty paths to string contents.",
        "invalid_request",
      );
    }
    files[filename] = contents;
  }

  const tools = normalizedStringList(input.tools, "Worker profile tool");
  if (tools.length === 0) {
    throw new LingProvisionerError(
      "Worker profile must provide at least one tool.",
      "invalid_request",
    );
  }
  const skills = normalizedStringList(input.skills ?? [], "Worker profile skill");
  skills.forEach((skill) => {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill) || skill.length > 64) {
      throw new LingProvisionerError(
        `Worker profile skill ${JSON.stringify(skill)} is not a valid Ling skill id.`,
        "invalid_request",
      );
    }
  });
  if ((input.inlineSkills?.length ?? 0) > 8) {
    throw new LingProvisionerError(
      "Worker profile may provide at most 8 inline skills.",
      "invalid_request",
    );
  }
  const selectedSkillNames = new Set(skills);
  let inlineSkillBytes = 0;
  const inlineSkills = (input.inlineSkills ?? []).map((skill) => {
    if (
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name) ||
      skill.name.length > 64 ||
      skill.content.trim() === ""
    ) {
      throw new LingProvisionerError(
        `Worker profile inline skill ${JSON.stringify(skill.name)} is invalid.`,
        "invalid_request",
      );
    }
    if (selectedSkillNames.has(skill.name)) {
      throw new LingProvisionerError(
        `Worker profile selects skill ${JSON.stringify(skill.name)} more than once.`,
        "invalid_request",
      );
    }
    selectedSkillNames.add(skill.name);
    const bytes = Buffer.byteLength(skill.content, "utf8");
    if (bytes > 16 * 1024) {
      throw new LingProvisionerError(
        `Worker profile inline skill ${JSON.stringify(skill.name)} exceeds 16384 bytes.`,
        "invalid_request",
      );
    }
    inlineSkillBytes += bytes;
    if (inlineSkillBytes > 64 * 1024) {
      throw new LingProvisionerError(
        "Worker profile inline skills exceed 65536 bytes.",
        "invalid_request",
      );
    }
    return { name: skill.name, content: skill.content };
  });
  if (skills.length + inlineSkills.length > 16) {
    throw new LingProvisionerError(
      "Worker profile may select at most 16 named and inline skills.",
      "invalid_request",
    );
  }

  return {
    profileId,
    tools,
    ...(provider === undefined ? {} : { provider }),
    ...(instructions === undefined ? {} : { instructions }),
    ...(Object.keys(files).length === 0 ? {} : { files }),
    ...(skills.length === 0 ? {} : { skills }),
    ...(inlineSkills.length === 0 ? {} : { inlineSkills }),
    ...(model === undefined ? {} : { model }),
    ...(input.thinking === undefined ? {} : { thinking: input.thinking }),
    ...(input.leaseTtlMs === undefined ? {} : { leaseTtlMs: input.leaseTtlMs }),
    ...(Object.keys(limits).length === 0 ? {} : { limits }),
    ...(storageState === undefined ? {} : { storageState }),
  };
}

/** Merge a resolved spawning-pool profile into the existing POST /tasks body. */
export function applyResolvedWorkerProfile(
  input: SpawnInput,
  unresolvedProfile: ResolvedWorkerProfileInput,
): SpawnInput {
  const profile = normalizeResolvedWorkerProfile(unresolvedProfile);
  const requestedTools =
    input.tools === undefined
      ? [...profile.tools]
      : normalizedStringList(input.tools, "Task tool");
  const allowedTools = new Set(profile.tools);
  const unavailable = requestedTools.filter((tool) => !allowedTools.has(tool));
  if (unavailable.length > 0) {
    throw new LingProvisionerError(
      `Task requests tools outside profile ${profile.profileId}: ${unavailable.join(", ")}.`,
      "invalid_request",
    );
  }
  if (profile.model !== undefined && input.model !== undefined && profile.model !== input.model) {
    throw new LingProvisionerError(
      `Task model ${input.model} conflicts with profile ${profile.profileId} model ${profile.model}.`,
      "invalid_request",
    );
  }
  if (
    profile.thinking !== undefined &&
    input.thinking !== undefined &&
    profile.thinking !== input.thinking
  ) {
    throw new LingProvisionerError(
      `Task thinking level ${input.thinking} conflicts with profile ${profile.profileId} level ${profile.thinking}.`,
      "invalid_request",
    );
  }
  // A worker holds only the login its profile names, so a task naming another
  // would fail inside the worker for want of the file.
  const login = namedLogin(input.storageState);
  if (login !== undefined && login !== profile.storageState) {
    throw new LingProvisionerError(
      profile.storageState === undefined
        ? `Task opens browser login ${JSON.stringify(login)}, which profile ${profile.profileId} does not provide.`
        : `Task browser login ${JSON.stringify(login)} conflicts with profile ${profile.profileId} login ${JSON.stringify(profile.storageState)}.`,
      "invalid_request",
    );
  }

  const files: Record<string, string> = { ...(profile.files ?? {}) };
  for (const [filename, contents] of Object.entries(input.files ?? {})) {
    if (Object.hasOwn(files, filename) && files[filename] !== contents) {
      throw new LingProvisionerError(
        `Task seed file ${filename} conflicts with profile ${profile.profileId}.`,
        "invalid_request",
      );
    }
    files[filename] = contents;
  }
  const instructions = [profile.instructions, input.instructions]
    .filter((value): value is string => value !== undefined && value.trim() !== "")
    .filter((value, index, values) => values.indexOf(value) === index)
    .join("\n\n");

  return {
    ...input,
    tools: requestedTools,
    ...(Object.keys(files).length === 0 ? {} : { files }),
    ...(instructions === "" ? {} : { instructions }),
    ...(profile.provider === undefined ? {} : { provider: profile.provider }),
    ...(profile.storageState === undefined ? {} : { storageState: profile.storageState }),
    ...(profile.skills === undefined ? {} : { skills: [...profile.skills] }),
    ...(profile.inlineSkills === undefined
      ? {}
      : { inlineSkills: profile.inlineSkills.map((skill) => ({ ...skill })) }),
    ...(input.model !== undefined
      ? { model: input.model }
      : profile.model === undefined
        ? {}
        : { model: profile.model }),
    ...(input.thinking !== undefined
      ? { thinking: input.thinking }
      : profile.thinking === undefined
        ? {}
        : { thinking: profile.thinking }),
  };
}

/**
 * Task router for one ephemeral worker per request key.
 *
 * Terminal task snapshots remain readable after release, while methods that
 * need the worker (events, peer and oversight messages, the service's log, the
 * final-state record and artifact transport) fail explicitly.
 * A worker released, or terminated with its termination completed, is not
 * asked again, so a task it last reported queued or running reads from then on
 * as interrupted, saying why, rather than as running for good. What such a
 * task spent after its last snapshot, which may be the spawn's and report
 * nothing, is not known, so its stats.cost is the most it may have spent: its
 * cost ceiling, or its last reported cost if that is higher. Whoever charges
 * stats.cost, as the campaign driver and the ledgers do, so charges its whole
 * budget. That is the closest figure known, not a strict bound: ling stops a
 * task at its ceiling from a projection of each provider call, so a last call
 * can take it a little past. A task with no known ceiling keeps its last
 * snapshot's stats, and its error says so. Turns and tokens stay the last
 * snapshot's, zero where it had none, so a token budget reads them as a
 * floor. While a termination is open the worker is still asked, since its
 * kill may not have landed: its tasks read as it reports them, and a worker
 * that does not answer makes the read or the cancel fail rather than report an
 * end it never reported.
 */
export class ProvisionedLingClient {
  private readonly provisioner: LingProvisioner;
  private readonly resolveProfile: WorkerProfileResolver;
  private readonly defaultLeaseTtlMs: number;
  private readonly now: () => number;
  private readonly onRetentionAlert: (
    alert: ProvisionedRetentionAlert,
  ) => void | Promise<void>;
  private readonly onReleaseCaveats: (
    report: ProvisionedReleaseCaveats,
  ) => void | Promise<void>;
  private recovery: Promise<void> | undefined;
  private readonly spawnRequests = new Map<string, SpawnRequest>();
  private readonly taskRoutes = new Map<string, TaskRoute>();
  private readonly snapshots = new Map<string, LingTask>();
  /** The caveats last passed on for a lease, so a retried release does not repeat them. */
  private readonly reportedCaveats = new WeakMap<ProvisionedWorkerLease, string>();

  constructor(options: ProvisionedLingClientOptions) {
    this.provisioner = options.provisioner;
    this.resolveProfile = options.resolveProfile;
    this.defaultLeaseTtlMs = options.defaultLeaseTtlMs ?? 60 * 60 * 1000;
    if (!Number.isSafeInteger(this.defaultLeaseTtlMs) || this.defaultLeaseTtlMs <= 0) {
      throw new LingProvisionerError(
        "defaultLeaseTtlMs must be a positive safe integer.",
        "invalid_request",
      );
    }
    this.now = options.now ?? Date.now;
    this.onRetentionAlert =
      options.onRetentionAlert ??
      ((alert) => {
        console.error(`PROVISIONER_RETENTION_ALERT ${JSON.stringify(alert)}`);
      });
    this.onReleaseCaveats =
      options.onReleaseCaveats ??
      ((report) => {
        console.error(`PROVISIONER_RELEASE_CAVEATS ${JSON.stringify(report)}`);
      });
  }

  async workerIds(): Promise<string[]> {
    await this.ensureRecovered();
    return this.provisioner
      .leases()
      .filter((lease) => !lease.released)
      .map((lease) => lease.workerId);
  }

  /** Explicit startup hook; all asynchronous operations also call it lazily. */
  async recover(): Promise<void> {
    await this.ensureRecovered();
  }

  async health(): Promise<Record<string, LingHealth>> {
    await this.ensureRecovered();
    const result: Record<string, LingHealth> = {};
    await Promise.all(
      this.provisioner
        .leases()
        .filter((lease) => !lease.released)
        .map(async (lease) => {
          result[lease.workerId] = await lease.client.health();
        }),
    );
    return result;
  }

  async spawn(input: SpawnInput, preferredWorkerId?: string): Promise<SpawnResponse> {
    await this.ensureRecovered();
    if (preferredWorkerId !== undefined) {
      throw new LingProvisionerError(
        "Provisioned workers cannot be selected before summon.",
        "invalid_request",
      );
    }
    const requestKey = nonBlank(input.requestKey, "Provisioned task requestKey", 240);
    if (requestKey === undefined) {
      throw new LingProvisionerError(
        "Provisioned tasks require requestKey so summon is idempotent.",
        "invalid_request",
      );
    }
    const signature = stableJson(input);
    const existing = this.spawnRequests.get(requestKey);
    if (existing !== undefined) {
      if (existing.signature !== signature) {
        throw new LingProvisionerError(
          `Provisioned requestKey ${requestKey} was reused with different task input.`,
          "request_key_conflict",
        );
      }
      return existing.promise;
    }

    const promise = this.spawnOnce({ ...input, requestKey });
    this.spawnRequests.set(requestKey, { signature, promise });
    try {
      return await promise;
    } catch (error) {
      if (this.spawnRequests.get(requestKey)?.promise === promise) {
        this.spawnRequests.delete(requestKey);
      }
      throw error;
    }
  }

  async get(id: string, workerId?: string): Promise<LingTask> {
    await this.ensureRecovered();
    const route = this.route(id, workerId);
    if (workerGone(route.lease)) {
      const snapshot = this.settledSnapshot(id, route.lease);
      if (snapshot !== undefined) return snapshot;
      throw new LingProvisionerError(
        `Worker ${route.lease.workerId} was ${route.lease.released ? "released" : "terminated"} before task ${id} was snapshotted.`,
        "worker_released",
      );
    }
    const task = this.withWorker(await route.lease.client.get(id), route.lease.workerId);
    this.snapshots.set(id, task);
    return task;
  }

  async list(): Promise<LingTask[]> {
    await this.ensureRecovered();
    const tasks = new Map<string, LingTask>();
    for (const lease of this.provisioner.leases()) {
      if (workerGone(lease)) continue;
      try {
        for (const task of await lease.client.list()) {
          const remembered = this.remember(task, lease);
          tasks.set(remembered.id, remembered);
        }
      } catch {
        // Existing snapshots below remain usable during partial provider outages.
      }
    }
    for (const [id, route] of this.taskRoutes) {
      if (!workerGone(route.lease)) {
        try {
          const task = await this.get(id, route.lease.workerId);
          tasks.set(task.id, task);
          continue;
        } catch {
          // A prior terminal snapshot is still useful during partial outages.
        }
      }
      const snapshot = workerGone(route.lease)
        ? this.settledSnapshot(id, route.lease)
        : this.snapshots.get(id);
      if (snapshot !== undefined) tasks.set(snapshot.id, snapshot);
    }
    return [...tasks.values()].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
  }

  async cancel(id: string, workerId?: string): Promise<void> {
    await this.ensureRecovered();
    const route = this.route(id, workerId);
    if (workerGone(route.lease)) {
      const snapshot = this.settledSnapshot(id, route.lease);
      if (snapshot !== undefined && isTerminalStatus(snapshot.status)) return;
      throw new LingProvisionerError(
        `Cannot cancel task ${id}; worker ${route.lease.workerId} is ${route.lease.released ? "released" : "terminated"}.`,
        "worker_released",
      );
    }
    await route.lease.client.cancel(id);
  }

  async *events(
    id: string,
    workerId?: string,
    options: LingEventOptions = {},
  ): AsyncIterable<LingEvent> {
    await this.ensureRecovered();
    const route = this.activeRoute(id, workerId, "stream events");
    for await (const event of route.lease.client.events(id, options)) yield event;
  }

  async sendPeerMessage(
    id: string,
    message: LingPeerMessage,
    workerId?: string,
  ): Promise<LingPeerMessageResponse> {
    await this.ensureRecovered();
    return this.activeRoute(id, workerId, "send a peer message").lease.client.sendPeerMessage(
      id,
      message,
    );
  }

  /**
   * Deliver an oversight message to a pair member, by the same route as a peer
   * message. A released worker refuses it with `worker_released`, which a pair
   * reads as a member that is gone (oversight-wire 11.6).
   */
  async sendOversight(
    id: string,
    message: LingOversightMessage,
    workerId?: string,
  ): Promise<LingOversightResponse> {
    await this.ensureRecovered();
    return this.activeRoute(id, workerId, "send an oversight message").lease.client.sendOversight(
      id,
      message,
    );
  }

  /**
   * The service's own log for a task. It goes with the worker, so a caller
   * that keeps it, as a pair keeps both members' (oversight-wire 11.7), reads
   * it before the release.
   */
  async fetchLog(id: string, workerId?: string): Promise<LingEvent[]> {
    await this.ensureRecovered();
    return this.activeRoute(id, workerId, "read the event log").lease.client.fetchLog(id);
  }

  async listArtifacts(id: string, workerId?: string): Promise<LingArtifactList> {
    await this.ensureRecovered();
    return this.activeRoute(id, workerId, "list artifacts").lease.client.listArtifacts(id);
  }

  /**
   * A terminal task's final-state record. It is read from the task's
   * workspace, which goes with the worker, so a caller that keeps it reads it
   * before the release, as it does the service's log.
   */
  async finalState(id: string, workerId?: string): Promise<LingFinalState> {
    await this.ensureRecovered();
    const { lease } = this.activeRoute(id, workerId, "read the final-state record");
    if (lease.client.finalState === undefined) {
      throw new LingProvisionerError(
        `Worker ${lease.workerId}'s client cannot read a final-state record.`,
        "invalid_request",
      );
    }
    return lease.client.finalState(id);
  }

  async readArtifact(
    id: string,
    artifactPath: string,
    workerId?: string,
  ): Promise<Uint8Array> {
    await this.ensureRecovered();
    return this.activeRoute(id, workerId, "read an artifact").lease.client.readArtifact(
      id,
      artifactPath,
    );
  }

  /**
   * Acknowledge that every required artifact is durably held outside the
   * worker. This does not release the worker; release() is deliberately
   * separate so callers can persist their own state between the two steps.
   */
  async collectComplete(id: string, workerId?: string): Promise<void> {
    await this.ensureRecovered();
    const task = await this.get(id, workerId);
    if (task.status !== "completed") {
      throw new LingProvisionerError(
        `Task ${id} ended as ${task.status}; collection acknowledgment applies only to successful tasks.`,
        "collection_not_applicable",
      );
    }
    this.route(id, workerId).collectionComplete = true;
  }

  /**
   * Release a terminal worker. Completed workers are retained until
   * collectComplete() succeeds; failed/cancelled/interrupted workers can be
   * released without a collection acknowledgment. An active task is refused;
   * terminate() is the path that does not wait for one to settle.
   */
  async release(id: string, workerId?: string): Promise<void> {
    await this.ensureRecovered();
    const route = this.route(id, workerId);
    if (route.lease.released) return;
    const task = await this.get(id, route.lease.workerId);
    if (!isTerminalStatus(task.status)) {
      throw new LingProvisionerError(
        `Task ${id} is ${task.status}; cancel and observe a terminal state before release.`,
        "task_active",
      );
    }
    if (task.status === "completed" && !route.collectionComplete) {
      throw new LingProvisionerError(
        `Task ${id} completed successfully; acknowledge durable collection before release.`,
        "collection_pending",
      );
    }
    await this.releaseLease(route.lease, id, this.releaseReason(task));
  }

  /**
   * Hard-kill the worker holding a task, whatever state the task is in.
   *
   * This is the rung past cancel: release() refuses an active task by design,
   * and a cancel is only a request the worker may never act on. Nothing is
   * read from the worker first, because the cases that need this are the ones
   * where it does not answer. Once the returned termination has completedAt,
   * the worker is not asked about its tasks either: one that had not ended by
   * its last snapshot reads as interrupted, with the termination's reason and
   * its cost ceiling as its cost (see the class), and one that had keeps its
   * end. Until then the termination is open, and the worker is asked as
   * before: call this again to finish it.
   */
  async terminate(
    id: string,
    reason: ProvisionedLeaseTerminateReason,
    workerId?: string,
  ): Promise<ProvisionedLeaseTermination> {
    await this.ensureRecovered();
    const route = this.route(id, workerId);
    const taskIds = [...this.taskRoutes]
      .filter(([, candidate]) => candidate.lease === route.lease)
      .map(([taskId]) => taskId);
    try {
      return await route.lease.terminate(reason, { taskIds });
    } finally {
      if (workerGone(route.lease)) {
        for (const taskId of taskIds) this.settledSnapshot(taskId, route.lease);
      }
    }
  }

  /**
   * Explicit expiry sweep seam. Active tasks are first asked to cancel and are
   * retained until a later sweep observes terminal state. Completed tasks are
   * never released without collection acknowledgment.
   */
  async cleanupExpired(now = this.now()): Promise<ProvisionedExpiryCleanupResult> {
    await this.ensureRecovered();
    const result: ProvisionedExpiryCleanupResult = {
      releasedWorkerIds: [],
      cancellationRequestedTaskIds: [],
      retainedTaskIds: [],
      alerts: [],
      errors: [],
    };
    for (const lease of this.provisioner.leases()) {
      if (lease.released || Date.parse(lease.expiresAt) > now) continue;
      try {
        const routeEntry = [...this.taskRoutes].find(([, route]) => route.lease === lease);
        let taskId = routeEntry?.[0];
        if (taskId === undefined) {
          const matching = (await lease.client.list()).find(
            (task) => task.requestKey === lease.requestKey,
          );
          if (matching === undefined) {
            await this.releaseLease(lease, null, "expired");
            result.releasedWorkerIds.push(lease.workerId);
            continue;
          }
          taskId = matching.id;
          this.remember(matching, lease);
        }

        let task = await this.get(taskId, lease.workerId);
        if (!isTerminalStatus(task.status)) {
          await lease.client.cancel(taskId);
          result.cancellationRequestedTaskIds.push(taskId);
          task = await this.get(taskId, lease.workerId);
          if (!isTerminalStatus(task.status)) {
            result.retainedTaskIds.push(taskId);
            await this.emitRetentionAlert(result, lease, taskId, "task_active");
            continue;
          }
        }
        const route = this.route(taskId, lease.workerId);
        if (task.status === "completed" && !route.collectionComplete) {
          result.retainedTaskIds.push(taskId);
          await this.emitRetentionAlert(result, lease, taskId, "collection_pending");
          continue;
        }
        await this.releaseLease(lease, taskId, this.releaseReason(task));
        result.releasedWorkerIds.push(lease.workerId);
      } catch (error) {
        result.errors.push({ workerId: lease.workerId, error });
        await this.emitRetentionAlert(
          result,
          lease,
          null,
          "worker_unreachable",
          error,
        );
      }
    }
    return result;
  }

  private async ensureRecovered(): Promise<void> {
    if (this.recovery === undefined) {
      const recovery = Promise.resolve(this.provisioner.recover()).catch((error) => {
        if (this.recovery === recovery) this.recovery = undefined;
        throw error;
      });
      this.recovery = recovery;
    }
    await this.recovery;
  }

  private async emitRetentionAlert(
    result: ProvisionedExpiryCleanupResult,
    lease: ProvisionedWorkerLease,
    taskId: string | null,
    reason: ProvisionedRetentionReason,
    error?: unknown,
  ): Promise<void> {
    const detail =
      error === undefined
        ? ""
        : `: ${error instanceof Error ? error.message : String(error)}`;
    const alert: ProvisionedRetentionAlert = {
      workerId: lease.workerId,
      taskId,
      requestKey: lease.requestKey,
      expiresAt: lease.expiresAt,
      reason,
      message:
        reason === "collection_pending"
          ? `Expired worker ${lease.workerId} is retained because completed task ${taskId} has not been durably collected.`
          : reason === "task_active"
            ? `Expired worker ${lease.workerId} is retained because task ${taskId} remains active after cancellation.`
            : `Expired worker ${lease.workerId} could not be inspected${detail}.`,
    };
    result.alerts.push(alert);
    try {
      await this.onRetentionAlert(alert);
    } catch (alertError) {
      result.errors.push({ workerId: lease.workerId, error: alertError });
      console.error(
        `PROVISIONER_RETENTION_ALERT_DELIVERY_FAILED ${JSON.stringify({
          workerId: lease.workerId,
          reason,
        })}: ${alertError instanceof Error ? alertError.message : String(alertError)}`,
      );
    }
  }

  /**
   * Release a lease, and pass on what the release could not confirm, whether
   * or not it then finished: a survivor its sweep saw may be what made it
   * fail. A report that cannot be delivered changes nothing about the
   * release, and is logged instead. A lease's caveats are passed on once,
   * however often a failed release is retried.
   */
  private async releaseLease(
    lease: ProvisionedWorkerLease,
    taskId: string | null,
    reason: ProvisionedLeaseReleaseReason,
  ): Promise<void> {
    try {
      await lease.release(reason);
    } finally {
      await this.reportReleaseCaveats(lease, taskId, reason);
    }
  }

  private async reportReleaseCaveats(
    lease: ProvisionedWorkerLease,
    taskId: string | null,
    reason: ProvisionedLeaseReleaseReason,
  ): Promise<void> {
    const caveats = [...lease.releaseCaveats];
    const signature = JSON.stringify(caveats);
    if (caveats.length === 0 || this.reportedCaveats.get(lease) === signature) return;
    this.reportedCaveats.set(lease, signature);
    try {
      await this.onReleaseCaveats({
        workerId: lease.workerId,
        taskId,
        requestKey: lease.requestKey,
        reason,
        released: lease.released,
        caveats,
      });
    } catch (reportError) {
      console.error(
        `PROVISIONER_RELEASE_CAVEATS_DELIVERY_FAILED ${JSON.stringify({
          workerId: lease.workerId,
          caveats,
        })}: ${reportError instanceof Error ? reportError.message : String(reportError)}`,
      );
    }
  }

  private async spawnOnce(input: SpawnInput & { requestKey: string }): Promise<SpawnResponse> {
    const profile = normalizeResolvedWorkerProfile(await this.resolveProfile(input));
    const now = this.now();
    const ttl = profile.leaseTtlMs ?? this.defaultLeaseTtlMs;
    const request: LingProvisionRequest = {
      requestKey: input.requestKey,
      profile,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttl).toISOString(),
    };
    const lease = await this.provisioner.summon(request);
    let spawned: SpawnResponse;
    try {
      spawned = await lease.client.spawn(applyResolvedWorkerProfile(input, profile));
    } catch (error) {
      // The POST is idempotent but its final transport outcome can be
      // ambiguous. Keep the lease for a request-key retry or expiry sweep.
      throw new LingProvisionerError(
        `Worker ${lease.workerId} was summoned but task submission failed.`,
        "invalid_request",
        { cause: error },
      );
    }
    this.taskRoutes.set(spawned.id, { lease, collectionComplete: false });
    // All that is known of the task until the worker is asked, and what it
    // reads as if the worker is gone before anyone does. The workspace is the
    // worker's to report.
    if (!this.snapshots.has(spawned.id)) {
      this.snapshots.set(spawned.id, {
        id: spawned.id,
        ...(spawned.requestKey === undefined ? {} : { requestKey: spawned.requestKey }),
        workerId: lease.workerId,
        status: spawned.status,
        prompt: input.task,
        options: spawned.options,
        createdAt: request.createdAt,
        workspaceDir: "",
        seededFiles: spawned.seededFiles,
      });
    }
    return { ...spawned, workerId: lease.workerId };
  }

  /**
   * A gone worker's task, as its last snapshot has it, or as interrupted if
   * that snapshot is not terminal, with the most it may have spent as its
   * cost (see the class). The conversion is kept, so the task reads the same
   * from then on.
   */
  private settledSnapshot(id: string, lease: ProvisionedWorkerLease): LingTask | undefined {
    const snapshot = this.snapshots.get(id);
    if (snapshot === undefined || isTerminalStatus(snapshot.status)) return snapshot;
    const termination = lease.termination;
    const ceiling = costCeiling(snapshot, lease);
    const cost = ceiling === undefined ? undefined : Math.max(snapshot.stats?.cost ?? 0, ceiling);
    const unreported =
      `was last reported ${snapshot.status}, so its end, and anything it spent after ` +
      "that report, were never reported; " +
      (cost === undefined
        ? "no cost ceiling is known for it, so its cost is only what that report said."
        : `its cost reads as $${cost}, the higher of that report's and its ceiling.`);
    const settled: LingTask = {
      ...snapshot,
      status: "interrupted",
      stoppedBy: "interrupted",
      finishedAt: termination?.requestedAt ?? new Date(this.now()).toISOString(),
      ...(cost === undefined
        ? {}
        : {
            stats: {
              turns: snapshot.stats?.turns ?? 0,
              cost,
              tokens: snapshot.stats?.tokens ?? {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
          }),
      error:
        termination === undefined
          ? `Worker ${lease.workerId} was released while this task ${unreported}`
          : `Worker ${lease.workerId} was terminated (${termination.reason}) while this task ` +
            unreported,
    };
    this.snapshots.set(id, settled);
    return settled;
  }

  private route(id: string, workerId?: string): TaskRoute {
    const known = this.taskRoutes.get(id);
    if (known !== undefined) {
      if (workerId !== undefined && known.lease.workerId !== workerId) {
        throw new LingProvisionerError(
          `Task ${id} belongs to worker ${known.lease.workerId}, not ${workerId}.`,
          "unknown_worker",
        );
      }
      return known;
    }
    if (workerId !== undefined) {
      const lease = this.provisioner.lease(workerId);
      if (lease !== undefined) {
        const route = { lease, collectionComplete: false };
        this.taskRoutes.set(id, route);
        return route;
      }
      throw new LingProvisionerError(
        `No lease is held for provisioned worker ${workerId}.`,
        "no_lease",
      );
    }
    throw new LingProvisionerError(`Task ${id} has no provisioned worker route.`, "unknown_task");
  }

  private activeRoute(id: string, workerId: string | undefined, operation: string): TaskRoute {
    const route = this.route(id, workerId);
    if (route.lease.released) {
      throw new LingProvisionerError(
        `Cannot ${operation} for task ${id}; worker ${route.lease.workerId} is released.`,
        "worker_released",
      );
    }
    return route;
  }

  private remember(task: LingTask, lease: ProvisionedWorkerLease): LingTask {
    const routed = this.withWorker(task, lease.workerId);
    this.snapshots.set(task.id, routed);
    if (!this.taskRoutes.has(task.id)) {
      this.taskRoutes.set(task.id, { lease, collectionComplete: false });
    }
    return routed;
  }

  private withWorker(task: LingTask, workerId: string): LingTask {
    return { ...task, workerId };
  }

  private releaseReason(task: LingTask): ProvisionedLeaseReleaseReason {
    if (task.status === "completed") return "collection-complete";
    if (task.status === "failed") return "task-failed";
    if (task.status === "cancelled") return "task-cancelled";
    return "task-interrupted";
  }
}
