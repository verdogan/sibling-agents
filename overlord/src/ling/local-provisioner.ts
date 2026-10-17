import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv, promisify } from "node:util";
import {
  bootstrapLing,
  type LingBootstrapOptions,
  type LingProcessStarter,
} from "./bootstrap.js";
import {
  LingProvisionerError,
  normalizeResolvedWorkerProfile,
  type LingProvisioner,
  type LingProvisionRequest,
  type ProvisionedLeaseReleaseReason,
  type ProvisionedLeaseTerminateOptions,
  type ProvisionedLeaseTerminateReason,
  type ProvisionedLeaseTermination,
  type ProvisionedReleaseCaveats,
  type ProvisionedWorkerClient,
  type ProvisionedWorkerLease,
  type ProvisionedWorkerRuntimePaths,
  type ResolvedWorkerProfileInput,
} from "./provisioner.js";
import type { LingHealth } from "./types.js";

const DEFAULT_SOURCE_LING_DIR = fileURLToPath(new URL("../../../ling", import.meta.url));
const UNIQUE_FACTORY_ATTEMPTS = 16;
/** Ling's own default when neither the profile nor its settings name a provider. */
const DEFAULT_LING_PROVIDER = "openai";
/** bootstrapLing's own default startup timeout, which bounds beforePost as well. */
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const execFileAsync = promisify(execFile);

export interface LocalLingRuntime {
  client: ProvisionedWorkerClient;
  startedByOverlord: boolean;
  pid?: number;
  stop(): Promise<void>;
  /** Hard-kill the process tree; see LingRuntime.kill(). */
  kill(): Promise<string[]>;
  /** Stop gracefully, then kill what outlived the stop; see LingRuntime.stopTree(). */
  stopTree(): Promise<string[]>;
}

export type LocalContainerRuntime = "docker" | "podman";

/**
 * Remove one sandbox container by name. `env` is the child's system variables
 * and HOME (see containerRemoverEnvironment()): rootless podman keeps its
 * containers under HOME, and the child's HOME and temp directory are not the
 * overlord's.
 */
export type LocalContainerRemover = (
  runtime: LocalContainerRuntime,
  name: string,
  env: NodeJS.ProcessEnv,
) => Promise<void>;

export type LingBootstrapFactory = (options: LingBootstrapOptions) => Promise<LocalLingRuntime>;
export type LocalPortFactory = (
  request: Readonly<LingProvisionRequest>,
) => number | Promise<number>;
export type LocalTokenFactory = (
  request: Readonly<LingProvisionRequest>,
) => string | Promise<string>;
export type LocalWorkerIdFactory = (
  request: Readonly<LingProvisionRequest>,
) => string | Promise<string>;

export interface LocalWorkerRuntimeDirectory {
  path: string;
  dispose(): Promise<void>;
}

export type LocalRuntimeDirectoryFactory = (
  request: Readonly<LingProvisionRequest>,
  workerId: string,
  sourceLingDir: string,
) => Promise<LocalWorkerRuntimeDirectory>;

/**
 * A worker that has started and answered its /healthz, as beforePost is shown
 * it: before its lease is handed back, so before any task can be posted to it.
 */
export interface LocalStartedWorker {
  requestKey: string;
  workerId: string;
  profile: ResolvedWorkerProfileInput;
  runtimePaths: Readonly<ProvisionedWorkerRuntimePaths>;
  health: LingHealth;
}

/**
 * Inspect a started worker before it is used. A throw, or a rejection, fails
 * the summon with that error: the worker is stopped and its directory removed
 * as for any summon that fails, and no task is posted to it.
 *
 * It is meant to be brief, a comparison of what the worker reports with what
 * the caller expects. While it runs the worker has no lease, so neither
 * leases() nor forceShutdown() can reach it. A hook that has not settled within
 * the startup timeout (startupTimeoutMs, by default 30 s) therefore fails the
 * summon as a throw would; what it goes on to do is not waited for.
 */
export type LocalBeforePostHook = (worker: Readonly<LocalStartedWorker>) => void | Promise<void>;

export interface LocalTaskProvisionerOptions {
  /** Source checkout containing Ling's server and installed dependencies. */
  sourceLingDir?: string;
  /**
   * Parent for isolated per-worker data/workspace directories. Default
   * `os.tmpdir()/ling-overlord-workers`. It begins every task's workspace path,
   * which ling shows the task as its working directory, so a root that names
   * something, such as a run, tells every task that name.
   *
   * On POSIX it also begins the path of the Unix socket tsx's CLI listens on,
   * `<worker dir>/tmp/tsx-<euid>/<pid>.pipe`, since a worker's temp directory
   * is inside its own. A socket path is limited to 107 bytes on Linux and 103
   * on macOS, and the CLI exits when it cannot listen, so a child started
   * through it under too long a root never starts. Under the default root a
   * Linux path whose TMPDIR is /tmp comes to at most about 102 bytes; on macOS,
   * whose temp directory is long, it does not fit. A root more than about 31
   * bytes long does not fit on Linux either, local-provisioner-check's and
   * pair-e2e-check's scratch roots among them. This has been run on Windows
   * only, where tsx uses a named pipe instead.
   */
  runtimeRootDir?: string;
  /**
   * Pi's agent directory for every child, as PI_CODING_AGENT_DIR: where Pi
   * reads models.json and its model cache, and writes its crash log. An
   * absolute path, which the caller creates and removes; it is not inside any
   * lease. Unset, a child has none, and Pi uses its default under the child's
   * home directory, which on Windows is the host user's (USERPROFILE crosses).
   */
  piAgentDir?: string;
  /** Called with every worker that starts, before its lease is handed back. */
  beforePost?: LocalBeforePostHook;
  /**
   * The overlord-side environment children are built from. Only named
   * variables cross; see localChildEnvironment(). Default process.env.
   */
  env?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  /** POSIX only: how long terminate() waits between SIGTERM and SIGKILL. Default 5 s. */
  terminateGraceMs?: number;
  /** Injectable sandbox-container removal for terminate(). */
  removeContainer?: LocalContainerRemover;
  command?: string;
  args?: readonly string[];
  bootstrap?: LingBootstrapFactory;
  /** Injectable child-process boundary passed through to bootstrapLing. */
  startProcess?: LingProcessStarter;
  portFactory?: LocalPortFactory;
  tokenFactory?: LocalTokenFactory;
  workerIdFactory?: LocalWorkerIdFactory;
  runtimeDirectoryFactory?: LocalRuntimeDirectoryFactory;
}

interface RequestEntry {
  profileSignature: string;
  promise: Promise<LocalProvisionedWorkerLease>;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function validRequest(request: LingProvisionRequest): void {
  if (
    request.requestKey.trim() === "" ||
    request.requestKey.length > 240 ||
    !Number.isFinite(Date.parse(request.createdAt)) ||
    !Number.isFinite(Date.parse(request.expiresAt)) ||
    Date.parse(request.expiresAt) <= Date.parse(request.createdAt)
  ) {
    throw new LingProvisionerError(
      "Local summon requires a valid requestKey and an expiry after creation.",
      "invalid_request",
    );
  }
}

async function availableLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Unable to reserve a loopback TCP port."));
        return;
      }
      server.close((error) => {
        if (error === undefined) resolve(address.port);
        else reject(error);
      });
    });
  });
}

async function copyDirectoryIfPresent(source: string, destination: string): Promise<void> {
  if (!existsSync(source)) return;
  await cp(source, destination, {
    recursive: true,
    force: false,
    errorOnExist: true,
  });
}

async function linkDirectoryIfPresent(source: string, destination: string): Promise<void> {
  if (!existsSync(source)) return;
  await symlink(source, destination, process.platform === "win32" ? "junction" : "dir");
}

/**
 * Variables a child takes from the overlord's environment because a process
 * cannot run, reach its provider or reach the container daemon without them.
 * A proxy URL that embeds credentials does cross; nothing else secret is here.
 * On Windows libuv also fills in a fixed handful from the overlord's own
 * environment whatever a child is given, LOGONSERVER and USERDOMAIN beyond
 * this list among them. TEMP, TMP and TMPDIR are then set over by the lease,
 * to a directory of its own (see createLease).
 */
const SYSTEM_ENV_KEYS: readonly string[] = [
  "PATH", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "TZ", "TERM",
  // POSIX.
  "USER", "LOGNAME", "SHELL", "TMPDIR", "XDG_RUNTIME_DIR", "DISPLAY", "WAYLAND_DISPLAY",
  // Windows.
  "PATHEXT", "SystemRoot", "SystemDrive", "windir", "ComSpec", "TEMP", "TMP",
  "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "USERNAME", "APPDATA", "LOCALAPPDATA",
  "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles",
  "CommonProgramFiles(x86)", "CommonProgramW6432", "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE", "OS",
  // A proxy or TLS-inspecting gateway between the host and the provider.
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  // The container daemon, when SANDBOX_MODE=docker.
  "DOCKER_HOST", "CONTAINER_HOST",
];

/**
 * Ling's own settings that carry no secret: everything its config.ts reads
 * except the credentials, identity, address and concurrency the provisioner
 * assigns. Taken from the source checkout's .env and then the overlord's
 * environment, which wins, as it did when the child loaded a copied .env
 * itself. A setting ling gains later reaches local children only once it is
 * listed here; LING_MODEL_ROUTING is listed ahead of the ling that reads it.
 * Every child gets the same values, so a setting that applies to one provider
 * only has to be one a ling of another provider ignores. What a lease sets
 * over these from its own profile is leaseSettings()'s. readLingSettings()
 * reads them as a child would get them before that.
 */
export const LING_SETTING_KEYS: readonly string[] = [
  "AGENT_PROVIDER", "AGENT_MODEL", "AGENT_THINKING",
  "MAX_TURNS", "MAX_WALL_CLOCK_MS", "MAX_COST_USD",
  "MAX_SKILLS_PER_TASK", "MAX_INLINE_SKILLS_PER_TASK", "MAX_INLINE_SKILL_BYTES",
  "MAX_INLINE_SKILLS_TOTAL_BYTES", "TASK_RATE_LIMIT_PER_MINUTE", "TASK_RATE_LIMIT_BURST",
  "SHUTDOWN_GRACE_MS", "SHUTDOWN_CANCEL_WAIT_MS", "SHUTDOWN_HTTP_CLOSE_MS",
  "WORKSPACE_RETENTION_DAYS", "RETENTION_INTERVAL_MS", "QUEUE_RESTORE_MAX_TASKS",
  "QUEUE_RESTORE_MAX_AGE_MS", "RATE_LIMIT_MAX_BUCKETS", "RATE_LIMIT_IDLE_MS",
  "BROWSER_HEADLESS", "BROWSER_TRACE", "AGENT_BROWSER_BIN", "AGENT_BROWSER_MAX_OUTPUT",
  "AGENT_BROWSER_SESSION_PREFIX", "AGENT_BROWSER_IDLE_TIMEOUT_MS",
  "AGENT_BROWSER_REPAIR_COOLDOWN_MS", "HTTP_MAX_BODY_CHARS", "BLOCK_PRIVATE_NETWORK",
  "MAX_TOOL_RESULT_CHARS", "MAX_TOOL_RESULT_CHARS_PER_TURN", "SANDBOX_MODE",
  "CONTAINER_RUNTIME", "SANDBOX_IMAGE", "SANDBOX_NETWORK", "SANDBOX_MEMORY", "SANDBOX_CPUS",
  "SANDBOX_PIDS_LIMIT", "OVERSIGHT_ADVICE_WAIT_MS", "OVERSIGHT_WATCH_IDLE_MS",
  "LING_MODEL_ROUTING", "LING_MODEL_MAX_TOKENS",
];

/**
 * The settings a lease sets over LING_SETTING_KEYS from what its profile
 * states: the provider, model and thinking level it names, and its task's
 * three limits. Each is set only where the profile states it; a profile that
 * states all six leaves none of these as the .env or the overlord's
 * environment had them.
 *
 * One more is set over them, but not from a stated value: a profile with an
 * oversight tool, tell_principal among them, runs with MAX_TOOL_RESULT_CHARS
 * raised to the 12 000 those tools need when the value in force is lower or
 * unset. So either side of a pair can run with a value other than the one in
 * force. It is not listed here, since it is not the profile's to state;
 * leaseSettings() gives the values a given profile's lease sets, it included.
 */
export const LEASE_SET_SETTING_KEYS: readonly string[] = [
  "AGENT_PROVIDER", "AGENT_MODEL", "AGENT_THINKING",
  "MAX_TURNS", "MAX_WALL_CLOCK_MS", "MAX_COST_USD",
];

/** LING_SETTING_KEYS by where a child's values come from. */
export interface LingSettingSources {
  /** As the source checkout's .env sets them. */
  dotEnv: Record<string, string>;
  /** As the overlord's environment sets them. */
  environment: Record<string, string>;
  /** What every child starts from: the environment's over the .env's, before its lease's own. */
  inForce: Record<string, string>;
}

/**
 * The tools of the oversight channel, on either side of a pair. A copy, until
 * the overlord's policy lists them (oversight-wire 11.1): this must then be
 * that list, or a tool renamed there would start without the result room it
 * needs, and ling would refuse it.
 */
const OVERSIGHT_TOOLS: ReadonlySet<string> = new Set([
  "ask_overseer", "tell_principal", "watch_next", "advise", "caution", "hold", "release",
  "report_concern",
]);
/** Below this a ling refuses every oversight tool: a feed batch would not fit one result. */
const OVERSIGHT_MIN_TOOL_RESULT_CHARS = 12_000;

/**
 * Where Pi looks for a provider's credentials, for the providers that do not
 * follow its `<PROVIDER>_API_KEY` convention: the names pi-ai 1.0.3 reads in
 * env-api-keys.js and cloudflare-auth.js, and for Bedrock the companions the
 * AWS SDK needs to use the sources pi-ai accepts. A newer pi-ai can read more.
 * A provider whose credentials live anywhere else starts without them, and
 * ling says so at startup; a credentials file under the overlord's HOME is
 * among those, since a child has a HOME of its own.
 */
const PROVIDER_CREDENTIAL_KEYS: Readonly<Record<string, readonly string[]>> = {
  anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"],
  google: ["GEMINI_API_KEY"],
  "google-vertex": [
    "GOOGLE_CLOUD_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_PROJECT",
    "GCLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION",
  ],
  azure: [
    "AZURE_OPENAI_API_KEY",
    "AZURE_OPENAI_BASE_URL",
    "AZURE_OPENAI_RESOURCE_NAME",
    "AZURE_OPENAI_API_VERSION",
    "AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
  ],
  "amazon-bedrock": [
    "AWS_PROFILE",
    "AWS_CONFIG_FILE",
    "AWS_SHARED_CREDENTIALS_FILE",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "AWS_BEARER_TOKEN_BEDROCK",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_ROLE_ARN",
    "AWS_ROLE_SESSION_NAME",
  ],
  "github-copilot": ["COPILOT_GITHUB_TOKEN"],
  huggingface: ["HF_TOKEN"],
  "vercel-ai-gateway": ["AI_GATEWAY_API_KEY"],
  moonshotai: ["MOONSHOT_API_KEY"],
  "moonshotai-cn": ["MOONSHOT_API_KEY"],
  "kimi-coding": ["KIMI_API_KEY"],
  "cloudflare-workers-ai": ["CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID"],
  "cloudflare-ai-gateway": ["CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID"],
  "opencode-go": ["OPENCODE_API_KEY"],
  "qwen-token-plan-individual": ["QWEN_TOKEN_PLAN_API_KEY"],
};

function providerCredentialKeys(provider: string): readonly string[] {
  return Object.hasOwn(PROVIDER_CREDENTIAL_KEYS, provider)
    ? PROVIDER_CREDENTIAL_KEYS[provider]!
    : [`${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`];
}

/** Windows spells one variable Path, PATH or path; POSIX names are exact. */
function envKey(name: string): string {
  return process.platform === "win32" ? name.toUpperCase() : name;
}

function setEnv(target: NodeJS.ProcessEnv, name: string, value: string | undefined): void {
  if (value === undefined) return;
  for (const existing of Object.keys(target)) {
    if (existing !== name && envKey(existing) === envKey(name)) delete target[existing];
  }
  target[name] = value;
}

function copyNamed(
  target: NodeJS.ProcessEnv,
  source: NodeJS.ProcessEnv,
  names: readonly string[],
): void {
  const wanted = new Set(names.map(envKey));
  for (const [name, value] of Object.entries(source)) {
    if (wanted.has(envKey(name))) setEnv(target, name, value);
  }
}

/** Read a setting the way ling's config does: trimmed, blank meaning unset. */
function envSetting(env: NodeJS.ProcessEnv, name: string): string | undefined {
  for (const [key, value] of Object.entries(env)) {
    if (envKey(key) === envKey(name) && value !== undefined && value.trim() !== "") {
      return value.trim();
    }
  }
  return undefined;
}

function envPositiveInt(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const parsed = Number.parseInt(envSetting(env, name) ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** The source checkout's .env, parsed and never loaded into this process. */
async function readSourceDotEnv(sourceLingDir: string): Promise<NodeJS.ProcessEnv> {
  try {
    return parseEnv(await readFile(path.join(sourceLingDir, ".env"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

/**
 * Of LING_SETTING_KEYS, what one source sets, named as listed there however
 * Windows spells them. Values are as they cross, a blank one included, which
 * ling reads as unset.
 */
function lingSettingsIn(source: NodeJS.ProcessEnv): Record<string, string> {
  const listed = new Map(LING_SETTING_KEYS.map((name) => [envKey(name), name]));
  const settings: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    const key = listed.get(envKey(name));
    if (key !== undefined && value !== undefined) settings[key] = value;
  }
  return settings;
}

function lingSettingSources(
  sourceDotEnv: NodeJS.ProcessEnv,
  overlordEnv: NodeJS.ProcessEnv,
): LingSettingSources {
  const dotEnv = lingSettingsIn(sourceDotEnv);
  const environment = lingSettingsIn(overlordEnv);
  return { dotEnv, environment, inForce: { ...dotEnv, ...environment } };
}

/**
 * Ling's non-secret settings as a local child would be handed them, by source:
 * what the source checkout's .env sets, what the overlord's environment sets,
 * and the two combined, as every child starts from them before its lease sets
 * its own. A child runs with `inForce` under leaseSettings(profile, inForce),
 * and with nothing else of ling's settings changed.
 * Nothing secret is read into the result: LING_SETTING_KEYS holds none.
 */
export async function readLingSettings(
  options: { sourceLingDir?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<LingSettingSources> {
  return lingSettingSources(
    await readSourceDotEnv(path.resolve(options.sourceLingDir ?? DEFAULT_SOURCE_LING_DIR)),
    options.env ?? process.env,
  );
}

/**
 * Build a child's whole environment by name.
 *
 * The child runs shell commands a model chose, so every variable it holds is
 * readable by the task, and by any process that can read its environ. Spreading
 * the overlord's environment handed it the brain key, every worker token and
 * the webhook credentials; copying the source .env handed it every provider
 * key. Now it gets the system variables above, ling's non-secret settings, the
 * credentials of the one provider it runs, and what the provisioner assigns.
 */
function localChildEnvironment(
  overlordEnv: NodeJS.ProcessEnv,
  sourceDotEnv: NodeJS.ProcessEnv,
  provider: string | undefined,
  assigned: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  copyNamed(env, overlordEnv, SYSTEM_ENV_KEYS);
  for (const [name, value] of Object.entries(
    lingSettingSources(sourceDotEnv, overlordEnv).inForce,
  )) {
    setEnv(env, name, value);
  }
  if (provider !== undefined) setEnv(env, "AGENT_PROVIDER", provider);
  const credentials = providerCredentialKeys(
    envSetting(env, "AGENT_PROVIDER") ?? DEFAULT_LING_PROVIDER,
  );
  copyNamed(env, sourceDotEnv, credentials);
  copyNamed(env, overlordEnv, credentials);
  for (const [name, value] of Object.entries(assigned)) setEnv(env, name, value);
  return env;
}

/**
 * The ceilings a lease's ling enforces, set from its one task's own limits.
 *
 * A ling refuses a task that asks for more turns, wall clock or cost than its
 * own ceiling, and a local child runs exactly one task, so the ceiling is that
 * task's request: the overlord's policy is what bounds the request. Without
 * this, a watcher's budget (above ling's defaults of 40 turns and 900 000 ms)
 * would be refused on a default install, and a MAX_TURNS in ling/.env would
 * refuse any task asking for more. A limit the task leaves unset keeps the
 * inherited ceiling, which is then also what the task runs with. Integer
 * ceilings round up, because ling reads them with parseInt and floors only
 * the request. With an oversight tool, MAX_TOOL_RESULT_CHARS is raised to the
 * floor those tools need and never lowered.
 */
function leaseCeilings(
  profile: Readonly<ResolvedWorkerProfileInput>,
  inherited: NodeJS.ProcessEnv,
): Record<string, string> {
  const limits = profile.limits ?? {};
  return {
    ...(limits.maxTurns === undefined ? {} : { MAX_TURNS: String(Math.ceil(limits.maxTurns)) }),
    ...(limits.maxWallClockMs === undefined
      ? {}
      : { MAX_WALL_CLOCK_MS: String(Math.ceil(limits.maxWallClockMs)) }),
    // String() of a double reads back as the same double through parseFloat.
    ...(limits.maxCostUsd === undefined ? {} : { MAX_COST_USD: String(limits.maxCostUsd) }),
    ...(profile.tools.some((tool) => OVERSIGHT_TOOLS.has(tool)) &&
    (envPositiveInt(inherited, "MAX_TOOL_RESULT_CHARS") ?? 0) < OVERSIGHT_MIN_TOOL_RESULT_CHARS
      ? { MAX_TOOL_RESULT_CHARS: String(OVERSIGHT_MIN_TOOL_RESULT_CHARS) }
      : {}),
  };
}

/**
 * What a lease for `profile` sets over the LING_SETTING_KEYS values it
 * inherits, given those: readLingSettings()'s `inForce`, say. That is the
 * provider, model and thinking level the profile names, and the ceilings of
 * leaseCeilings(). Every key is one of LEASE_SET_SETTING_KEYS but
 * MAX_TOOL_RESULT_CHARS, which an oversight tool raises. createLease sets
 * these and no other of ling's settings, so a caller that records the settings
 * a child ran with records the values in force under these.
 */
export function leaseSettings(
  profile: Readonly<ResolvedWorkerProfileInput>,
  inherited: NodeJS.ProcessEnv,
): Record<string, string> {
  return {
    ...(profile.provider === undefined ? {} : { AGENT_PROVIDER: profile.provider }),
    ...(profile.model === undefined ? {} : { AGENT_MODEL: profile.model }),
    ...(profile.thinking === undefined ? {} : { AGENT_THINKING: profile.thinking }),
    ...leaseCeilings(profile, inherited),
  };
}

/**
 * What a container removal runs with: the child's system variables and HOME,
 * so podman or docker finds the state the child's own runtime kept. Among the
 * system variables are the child's TEMP, TMP and TMPDIR, its lease's, which
 * rootless podman can fall back to for its runtime directory. Not the
 * credentials, and above all not WORKER_ID: on Linux the lease's tree kill
 * targets every process carrying it, and would kill the removal with the task.
 */
function containerRemoverEnvironment(childEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  copyNamed(env, childEnv, [...SYSTEM_ENV_KEYS, "HOME"]);
  return env;
}

/** The container runtime a child's sandbox uses, read as ling's config reads it. */
function sandboxRuntime(env: NodeJS.ProcessEnv): LocalContainerRuntime | undefined {
  if (envSetting(env, "SANDBOX_MODE") !== "docker") return undefined;
  return envSetting(env, "CONTAINER_RUNTIME") === "docker" ? "docker" : "podman";
}

async function removeSandboxContainer(
  runtime: LocalContainerRuntime,
  name: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  try {
    await execFileAsync(runtime, ["rm", "--force", name], {
      env,
      timeout: 30_000,
      windowsHide: true,
    });
  } catch (error) {
    // Gone already is the outcome asked for: the container runs with --rm and
    // ling's own shutdown removes it too.
    const stderr = String((error as { stderr?: unknown }).stderr ?? "");
    if (/no such container|no container with name or id/i.test(stderr)) return;
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Where the one saved browser login a task names is, under auth/, found the
 * way ling's runner finds it (resolveStorageState): `<name>` or `<name>.json`,
 * and nothing outside auth/.
 */
function storageStatePath(sourceLingDir: string, name: string | undefined): string | undefined {
  if (name === undefined || name.trim() === "") return undefined;
  const authDir = path.join(sourceLingDir, "auth");
  const source = path.resolve(authDir, name.endsWith(".json") ? name : `${name}.json`);
  const relative = path.relative(authDir, source);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new LingProvisionerError(
      `Browser login ${JSON.stringify(name)} is outside ling's auth directory.`,
      "invalid_request",
    );
  }
  return relative;
}

async function copyFileIfPresent(source: string, destination: string): Promise<void> {
  if (!existsSync(source)) return;
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

/**
 * Copy that login into the child's auth/. One that is not there is left for
 * the child to report, as it would have from a copied auth/.
 */
async function copyStorageState(
  sourceLingDir: string,
  runtimeDir: string,
  relative: string | undefined,
): Promise<void> {
  if (relative === undefined) return;
  await copyFileIfPresent(
    path.join(sourceLingDir, "auth", relative),
    path.join(runtimeDir, "auth", relative),
  );
}

/**
 * Give the child, of Pi's credential store in agent/auth.json, the entry of
 * the one provider it runs, as its own agent/auth.json.
 *
 * Pi's session looks there before the environment, so a key or login kept
 * only there reaches the child this way or not at all; the other providers'
 * entries are no more the child's than their keys in the environment are.
 * Nothing is written when the store has no entry for the provider, or when a
 * runtime directory factory has already put a store of its own there. A login
 * the child refreshes is written to its own copy, which goes with the lease,
 * so a provider that rotates refresh tokens can leave the source's stale, as
 * a copy of the whole store could. A store that cannot be read as Pi reads it
 * fails the summon, as it would have failed the child.
 */
async function copyProviderCredential(
  sourceLingDir: string,
  runtimeDir: string,
  provider: string,
): Promise<void> {
  const source = path.join(sourceLingDir, "agent", "auth.json");
  const destination = path.join(runtimeDir, "agent", "auth.json");
  if (existsSync(destination)) return;
  const unreadable = `Cannot take provider ${provider}'s entry from ${source}`;
  let stored: unknown;
  try {
    const text = await readFile(source, "utf8");
    // Without a leading byte-order mark, as Pi reads it.
    stored = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(`${unreadable}: ${errorMessage(error)}`, { cause: error });
  }
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
    throw new Error(`${unreadable}: it is not a JSON object.`);
  }
  if (!Object.hasOwn(stored, provider)) return;
  const entry = { [provider]: (stored as Record<string, unknown>)[provider] };
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });
}

export function defaultRuntimeDirectoryFactory(
  runtimeRootDir: string,
): LocalRuntimeDirectoryFactory {
  return async (request, workerId, sourceLingDir) => {
    const login = storageStatePath(sourceLingDir, request.profile.storageState);
    await mkdir(runtimeRootDir, { recursive: true });
    const runtimeDir = await mkdtemp(path.join(runtimeRootDir, `${workerId}-`));
    try {
      // A task can read what is copied here, through its shell if nothing
      // else, so only what the child needs is. Of agent/, the reviewed skills
      // and Pi's settings (settings.json); createLease adds the one provider's
      // entry of Pi's credential store (copyProviderCredential). Not the rest
      // of that store, the model cache (models-store.json) or custom models
      // (models.json), whose providers can carry keys of their own: ling
      // resolves a task's model through Pi's agent directory, its default or
      // the provisioner's piAgentDir, not this one, so a model defined only
      // there never reached a task. Of auth/, which holds every saved browser
      // login, only the one the task opens its browser with, if any.
      //
      // This narrows what every child is handed, not what a task can reach.
      // With SANDBOX_MODE=none, ling's default, the shell runs as the
      // overlord's user and can read the source checkout's agent/ and auth/ by
      // absolute path (node_modules below links into it), and on Windows,
      // where USERPROFILE crosses, Pi's default directory under it. Separate
      // OS users would close that; under SANDBOX_MODE=docker only the
      // workspace is mounted, and none of this was reachable from the shell.
      await Promise.all([
        copyDirectoryIfPresent(
          path.join(sourceLingDir, "agent", "skills"),
          path.join(runtimeDir, "agent", "skills"),
        ),
        copyFileIfPresent(
          path.join(sourceLingDir, "agent", "settings.json"),
          path.join(runtimeDir, "agent", "settings.json"),
        ),
        copyDirectoryIfPresent(path.join(sourceLingDir, "recipes"), path.join(runtimeDir, "recipes")),
        copyStorageState(sourceLingDir, runtimeDir, login),
      ]);
      // Keep task state isolated without copying the dependency tree. The
      // junction also preserves Ling's default agent-browser binary lookup.
      await linkDirectoryIfPresent(
        path.join(sourceLingDir, "node_modules"),
        path.join(runtimeDir, "node_modules"),
      );
      await linkDirectoryIfPresent(
        path.join(sourceLingDir, "browsers"),
        path.join(runtimeDir, "browsers"),
      );
      // No .env: ling loads one from its working directory, and the source
      // checkout's holds every provider key. What the child needs from it is
      // passed by name in its environment instead.
      return {
        path: runtimeDir,
        dispose: async () => {
          await rm(runtimeDir, {
            recursive: true,
            force: true,
            maxRetries: 3,
            retryDelay: 100,
          });
        },
      };
    } catch (error) {
      await rm(runtimeDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  };
}

interface LocalLeaseSandbox {
  runtime: LocalContainerRuntime;
  env: NodeJS.ProcessEnv;
  remove: LocalContainerRemover;
}

class LocalProvisionedWorkerLease implements ProvisionedWorkerLease {
  /**
   * A tree kill confirmed the root gone: terminate()'s, or the one release()
   * follows its graceful stop with. Nothing stops the root without one.
   */
  private killed = false;
  private disposed = false;
  /** What release()'s kill could not confirm about the tree. */
  private releaseNotes: string[] = [];
  /**
   * release()'s kill confirmed the root gone but not the rest of the tree, so
   * a termination is to kill once more.
   */
  private killAgain = false;
  private releaseInFlight: Promise<void> | undefined;
  private terminateInFlight: Promise<void> | undefined;
  private disposeInFlight: Promise<void> | undefined;
  private terminationRecord: ProvisionedLeaseTermination | undefined;
  /** Containers removed after the worker was confirmed dead; never retried. */
  private readonly removedContainers = new Set<string>();
  /**
   * Containers rootless podman could no longer have found, because release()
   * had removed its state with the runtime directory; never retried.
   */
  private readonly unreachableContainers = new Set<string>();
  /** What the confirmed kill could not confirm about the rest of the tree. */
  private treeUnconfirmed: string[] = [];

  constructor(
    readonly requestKey: string,
    readonly workerId: string,
    readonly profile: ResolvedWorkerProfileInput,
    readonly client: ProvisionedWorkerClient,
    readonly createdAt: string,
    readonly expiresAt: string,
    readonly runtimePaths: Readonly<ProvisionedWorkerRuntimePaths>,
    private readonly runtime: LocalLingRuntime,
    private readonly runtimeDirectory: LocalWorkerRuntimeDirectory,
    private readonly sandbox: LocalLeaseSandbox | undefined,
  ) {}

  get released(): boolean {
    return this.killed && this.disposed;
  }

  get releaseCaveats(): readonly string[] {
    return [...this.releaseNotes];
  }

  get termination(): ProvisionedLeaseTermination | undefined {
    return this.terminationRecord === undefined
      ? undefined
      : structuredClone(this.terminationRecord);
  }

  async release(_reason: ProvisionedLeaseReleaseReason): Promise<void> {
    if (this.released) return;
    if (this.releaseInFlight !== undefined) return this.releaseInFlight;
    this.releaseInFlight = this.releaseOnce();
    try {
      await this.releaseInFlight;
    } finally {
      this.releaseInFlight = undefined;
    }
  }

  async terminate(
    reason: ProvisionedLeaseTerminateReason,
    options: ProvisionedLeaseTerminateOptions = {},
  ): Promise<ProvisionedLeaseTermination> {
    // Recorded before anything is attempted, and never overwritten: the first
    // reason is why the worker died even if a retry is what finished the job.
    this.terminationRecord ??= {
      reason,
      requestedAt: new Date().toISOString(),
      containers: [],
      errors: [],
    };
    if (this.terminationRecord.completedAt === undefined) {
      this.terminateInFlight ??= this.terminateOnce(options.taskIds ?? []).finally(() => {
        this.terminateInFlight = undefined;
      });
      await this.terminateInFlight;
    }
    return structuredClone(this.terminationRecord);
  }

  private async terminateOnce(taskIds: readonly string[]): Promise<void> {
    const record = this.terminationRecord!;
    const errors: string[] = [];
    const sandbox = this.sandbox;
    if (sandbox !== undefined) {
      record.containers = [
        ...new Set([...record.containers, ...taskIds.map((id) => `pi-task-${id}`)]),
      ];
    }
    // After a release() whose sweep came back clean, not killed again: that
    // sweep looked for the tree before the root was gone, and a second kill
    // could only look without the root. One whose sweep could not confirm the
    // tree is killed once more, since on POSIX the root's group and, on Linux,
    // the marker still reach what it left. What both say stays on record.
    const retry = this.killed && this.killAgain;
    if (!this.killed || retry) {
      try {
        const notes = (await this.runtime.kill()).map(
          (detail) => `kill worker ${this.workerId}: ${detail}`,
        );
        this.treeUnconfirmed = retry ? [...this.treeUnconfirmed, ...notes] : notes;
        this.killed = true;
        this.killAgain = false;
      } catch (error) {
        errors.push(`kill worker ${this.workerId}: ${errorMessage(error)}`);
      }
    }
    // The containers go after the kill, so a dying service cannot start one
    // behind the removal, and a removal counts only once the service is
    // confirmed dead. Each runs detached as `sleep infinity`, so it does not
    // die with the service, and what the task started in it runs on until it
    // is removed: a failed removal keeps the termination open.
    if (sandbox !== undefined) {
      // Rootless podman keeps its containers under the runtime directory. Once
      // a release() has removed that, podman cannot find them, and asking it
      // would only recreate its state there, empty. A removal of the directory
      // already under way is let finish, so that it is known which this is.
      await this.disposeInFlight?.catch(() => undefined);
      const stateGone = sandbox.runtime === "podman" && this.disposed;
      await Promise.all(
        record.containers
          .filter((name) => !this.containerSettled(name))
          .map(async (name) => {
            if (stateGone) {
              if (this.killed) this.unreachableContainers.add(name);
              return;
            }
            try {
              await sandbox.remove(sandbox.runtime, name, sandbox.env);
              if (this.killed) this.removedContainers.add(name);
            } catch (error) {
              errors.push(`remove container ${name}: ${errorMessage(error)}`);
            }
          }),
      );
    }
    const containersRemoved = record.containers.every((name) => this.containerSettled(name));
    // The directory goes only once nothing can still be running in it, and
    // only once every container is gone, because rootless podman keeps its
    // state under it and a retried removal needs that to find the container.
    if (this.killed && containersRemoved && !this.disposed) {
      try {
        await this.dispose();
      } catch (error) {
        errors.push(`remove runtime directory: ${errorMessage(error)}`);
      }
    }
    // Caveats no retry can resolve, so they do not hold the termination open.
    const caveats: string[] = [];
    if (sandbox !== undefined && record.containers.length === 0) {
      // A container is named for its task and carries nothing of the lease's,
      // so without a task id there is nothing to find it by.
      caveats.push(
        "remove containers: the sandbox is on and no task ids were given, so none was " +
          "removed; one the worker started may still be running",
      );
    }
    for (const name of this.unreachableContainers) {
      caveats.push(
        `remove container ${name}: not attempted, because release() had already removed ` +
          "the runtime directory and rootless podman's state in it; it may still be running",
      );
    }
    record.errors = [...this.treeUnconfirmed, ...caveats, ...errors];
    if (this.killed && this.released && containersRemoved) {
      record.completedAt = new Date().toISOString();
    }
  }

  private async releaseOnce(): Promise<void> {
    // A termination owns the lease from the moment it is asked for, because it
    // decides when the directory may go: a container it has yet to remove may
    // need the podman state kept there. A release then finishes the
    // termination instead of stopping and disposing beside it, and fails while
    // the termination cannot finish.
    if (this.terminationRecord === undefined && !this.killed) {
      // A stop ends the root, and ling's own shutdown what it knows of; what a
      // finished task backgrounded, a server it started and left running, say,
      // would outlive both, and on Windows hold the directory open. So the
      // tree is swept after the stop.
      const notes = (await this.runtime.stopTree()).map(
        (detail) => `release worker ${this.workerId}: ${detail}`,
      );
      this.releaseNotes = notes;
      // A terminate() beside this release may have killed first; its record stands.
      if (!this.killed) {
        this.treeUnconfirmed = notes;
        this.killed = true;
        this.killAgain = notes.length > 0;
      }
    }
    if (this.terminationRecord !== undefined) {
      const termination = await this.terminate(this.terminationRecord.reason);
      if (termination.completedAt === undefined) {
        throw new Error(
          `Worker ${this.workerId} cannot be released while its termination is open: ` +
            termination.errors.join("; "),
        );
      }
      return;
    }
    if (!this.disposed) await this.dispose();
  }

  private containerSettled(name: string): boolean {
    return this.removedContainers.has(name) || this.unreachableContainers.has(name);
  }

  private dispose(): Promise<void> {
    this.disposeInFlight ??= this.runtimeDirectory.dispose().then(
      () => {
        this.disposed = true;
      },
      (error: unknown) => {
        this.disposeInFlight = undefined;
        throw error;
      },
    );
    return this.disposeInFlight;
  }
}

/**
 * Development/host-local implementation of one Ling process per task.
 *
 * Every summon gets an isolated cwd (and therefore data/tasks.db and
 * workspaces), bearer token, worker id, loopback port, an environment built by
 * name rather than inherited, budget ceilings equal to its one task's own
 * limits, and of ling's local state only the reviewed skills, Pi's settings,
 * its one provider's entry in Pi's credential store, the recipes and the one
 * browser login its task names. Each child leads its own process group
 * on POSIX so its lease can kill the whole tree, on release() as well as
 * terminate(). That also puts it out of reach of a terminal's Ctrl+C and
 * hangup, so what ends a child nobody stopped is the child's own watch: it is
 * given this process's pid as LING_PARENT_PID and, about a second after that
 * process is gone, cancels its tasks and exits. A worker shutdown() retains
 * therefore runs only as long as this process does, and a crashed overlord's
 * workers stop spending on their own. On Windows, where children are not
 * detached, libuv's job object ends them with this process as well. The watch
 * tests whether the pid exists, so a pid the host reuses within one poll keeps
 * a child running. Factories and the bootstrap/process boundaries are
 * injectable for deterministic tests.
 *
 * A child's HOME and temp directory are inside its cwd as well, so what its
 * task leaves in either goes with the lease. Where it ran is on the lease as
 * runtimePaths, and beforePost sees each worker before anything is posted to it.
 */
export class LocalTaskProvisioner implements LingProvisioner {
  private readonly sourceLingDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly startupTimeoutMs: number | undefined;
  private readonly terminateGraceMs: number | undefined;
  private readonly removeContainer: LocalContainerRemover;
  private readonly command: string;
  private readonly args: readonly string[];
  private readonly bootstrap: LingBootstrapFactory;
  private readonly startProcess: LingProcessStarter | undefined;
  private readonly portFactory: LocalPortFactory;
  private readonly tokenFactory: LocalTokenFactory;
  private readonly workerIdFactory: LocalWorkerIdFactory;
  private readonly runtimeDirectoryFactory: LocalRuntimeDirectoryFactory;
  private readonly piAgentDir: string | undefined;
  private readonly beforePost: LocalBeforePostHook | undefined;
  private readonly byRequestKey = new Map<string, RequestEntry>();
  private readonly byWorkerId = new Map<string, LocalProvisionedWorkerLease>();
  private readonly usedPorts = new Set<number>();
  private readonly usedTokens = new Set<string>();
  private readonly usedWorkerIds = new Set<string>();

  constructor(options: LocalTaskProvisionerOptions = {}) {
    this.sourceLingDir = path.resolve(options.sourceLingDir ?? DEFAULT_SOURCE_LING_DIR);
    this.env = { ...(options.env ?? process.env) };
    this.startupTimeoutMs =
      options.startupTimeoutMs ?? envPositiveInt(this.env, "LING_STARTUP_TIMEOUT_MS");
    this.terminateGraceMs = options.terminateGraceMs;
    this.removeContainer = options.removeContainer ?? removeSandboxContainer;
    this.command = options.command ?? process.execPath;
    this.args =
      options.args ??
      [
        path.join(this.sourceLingDir, "node_modules", "tsx", "dist", "cli.mjs"),
        path.join(this.sourceLingDir, "src", "server.ts"),
      ];
    this.bootstrap = options.bootstrap ?? bootstrapLing;
    this.startProcess = options.startProcess;
    this.portFactory = options.portFactory ?? availableLoopbackPort;
    this.tokenFactory =
      options.tokenFactory ?? (() => randomBytes(32).toString("base64url"));
    this.workerIdFactory =
      options.workerIdFactory ?? (() => `local-${randomUUID()}`);
    this.runtimeDirectoryFactory =
      options.runtimeDirectoryFactory ??
      defaultRuntimeDirectoryFactory(
        path.resolve(options.runtimeRootDir ?? path.join(tmpdir(), "ling-overlord-workers")),
      );
    // A relative directory would be resolved against each child's own cwd.
    if (options.piAgentDir !== undefined && !path.isAbsolute(options.piAgentDir)) {
      throw new LingProvisionerError(
        `piAgentDir must be an absolute path, not ${JSON.stringify(options.piAgentDir)}.`,
        "invalid_request",
      );
    }
    this.piAgentDir =
      options.piAgentDir === undefined ? undefined : path.normalize(options.piAgentDir);
    this.beforePost = options.beforePost;
  }

  /**
   * Local children are a development-only lifecycle proof and are not
   * reconstructed after an overlord restart. Cloud implementations must
   * override this behavior by enumerating tagged provider resources.
   */
  async recover(): Promise<void> {}

  async summon(request: LingProvisionRequest): Promise<ProvisionedWorkerLease> {
    validRequest(request);
    const profile = normalizeResolvedWorkerProfile(request.profile);
    const profileSignature = canonicalJson(profile);
    const existing = this.byRequestKey.get(request.requestKey);
    if (existing !== undefined) {
      if (existing.profileSignature !== profileSignature) {
        throw new LingProvisionerError(
          `Local summon requestKey ${request.requestKey} was reused with a different profile.`,
          "request_key_conflict",
        );
      }
      return existing.promise;
    }

    const normalizedRequest = { ...request, profile };
    const promise = this.createLease(normalizedRequest);
    this.byRequestKey.set(request.requestKey, { profileSignature, promise });
    try {
      return await promise;
    } catch (error) {
      if (this.byRequestKey.get(request.requestKey)?.promise === promise) {
        this.byRequestKey.delete(request.requestKey);
      }
      throw error;
    }
  }

  lease(workerId: string): ProvisionedWorkerLease | undefined {
    return this.byWorkerId.get(workerId);
  }

  leases(): readonly ProvisionedWorkerLease[] {
    return [...this.byWorkerId.values()];
  }

  /**
   * Stop only leases with no successful or active work left on them. A
   * completed, uncollected task is deliberately not released: its directory,
   * with the task's workspace and result, outlives the overlord process for
   * operator recovery. Its service does not, since the child exits once this
   * process has (LING_PARENT_PID), and an active task is cancelled then.
   */
  async shutdown(): Promise<{ retainedWorkerIds: string[] }> {
    const retainedWorkerIds: string[] = [];
    for (const lease of this.byWorkerId.values()) {
      if (lease.released) continue;
      try {
        const tasks = await lease.client.list();
        if (
          tasks.some(
            (task) =>
              task.status === "completed" ||
              task.status === "queued" ||
              task.status === "running",
          )
        ) {
          retainedWorkerIds.push(lease.workerId);
          continue;
        }
        await lease.release("shutdown");
      } catch {
        retainedWorkerIds.push(lease.workerId);
      }
    }
    return { retainedWorkerIds };
  }

  /**
   * Release every lease at once, whatever its tasks are doing: the operator's
   * stop-everything path. To end one worker, use that lease's terminate().
   */
  async forceShutdown(): Promise<void> {
    await Promise.allSettled(
      [...this.byWorkerId.values()]
        .filter((lease) => !lease.released)
        .map((lease) => lease.release("shutdown")),
    );
  }

  private async createLease(request: LingProvisionRequest): Promise<LocalProvisionedWorkerLease> {
    const workerId = await this.uniqueWorkerId(request);
    const token = await this.uniqueToken(request);
    const port = await this.uniquePort(request);
    const runtimeDirectory = await this.runtimeDirectoryFactory(
      request,
      workerId,
      this.sourceLingDir,
    );
    let runtime: LocalLingRuntime | undefined;
    try {
      const runtimeHome = path.join(runtimeDirectory.path, "runtime-home");
      // The child's temp directory, for Node's os.tmpdir() and for the shells
      // its task runs. Pi's bash tool writes the whole of any output past 50 KB
      // or 2 000 lines to a file there and never deletes it; here such files
      // go with the lease at release, not stay in the host's temp directory.
      // On POSIX tsx's CLI puts its IPC socket there too, and a socket path is
      // limited to 107 bytes on Linux and 103 on macOS. Under the default root
      // Linux has a few to spare, but under a root longer than about 31 bytes,
      // or on macOS, a child started through the CLI exits before its API is
      // ready (see runtimeRootDir). This has been run on Windows only.
      const childTmp = path.join(runtimeDirectory.path, "tmp");
      await Promise.all([
        mkdir(runtimeHome, { recursive: true }),
        mkdir(childTmp, { recursive: true }),
      ]);
      const env = localChildEnvironment(
        this.env,
        await readSourceDotEnv(this.sourceLingDir),
        request.profile.provider,
        {
          AGENT_TOKEN: token,
          AGENT_TOKENS_JSON: JSON.stringify({ overlord: token }),
          HOME: runtimeHome,
          TEMP: childTmp,
          TMP: childTmp,
          TMPDIR: childTmp,
          ...(this.piAgentDir === undefined ? {} : { PI_CODING_AGENT_DIR: this.piAgentDir }),
          PLAYWRIGHT_BROWSERS_PATH: path.join(runtimeDirectory.path, "browsers"),
          WORKER_ID: workerId,
          // The child cancels its tasks and exits once this process is gone, so
          // a crashed or killed overlord does not leave its lings spending.
          LING_PARENT_PID: String(process.pid),
          MAX_CONCURRENCY: "1",
          ALLOW_INLINE_SKILLS:
            (request.profile.inlineSkills?.length ?? 0) > 0 ? "true" : "false",
        },
      );
      for (const [name, value] of Object.entries(leaseSettings(request.profile, env))) {
        setEnv(env, name, value);
      }
      await copyProviderCredential(
        this.sourceLingDir,
        runtimeDirectory.path,
        envSetting(env, "AGENT_PROVIDER") ?? DEFAULT_LING_PROVIDER,
      );
      const userProfile = envSetting(env, "USERPROFILE");
      const runtimePaths: Readonly<ProvisionedWorkerRuntimePaths> = Object.freeze({
        runtimeDir: runtimeDirectory.path,
        workspacesDir: path.join(runtimeDirectory.path, "workspaces"),
        home: runtimeHome,
        tmp: childTmp,
        ...(this.piAgentDir === undefined ? {} : { piAgentDir: this.piAgentDir }),
        ...(userProfile === undefined ? {} : { userProfile }),
      });
      const shutdownTimeoutMs = envPositiveInt(this.env, "LING_SHUTDOWN_TIMEOUT_MS");
      runtime = await this.bootstrap({
        baseUrl: `http://127.0.0.1:${port}`,
        token,
        workspacesDir: runtimePaths.workspacesDir,
        lingDir: runtimeDirectory.path,
        autoStart: true,
        ...(this.startupTimeoutMs === undefined
          ? {}
          : { startupTimeoutMs: this.startupTimeoutMs }),
        ...(shutdownTimeoutMs === undefined ? {} : { shutdownTimeoutMs }),
        env,
        command: this.command,
        args: this.args,
        ...(this.startProcess === undefined ? {} : { startProcess: this.startProcess }),
        ownProcessGroup: true,
        // The default WORKER_ID is a fresh UUID per lease, and every descendant
        // inherits it unless it clears its environment.
        processMarker: `WORKER_ID=${workerId}`,
        ...(this.terminateGraceMs === undefined ? {} : { killGraceMs: this.terminateGraceMs }),
      });
      const health = await runtime.client.health();
      if (health.workerId !== workerId) {
        throw new LingProvisionerError(
          `Summoned local worker reported id ${health.workerId ?? "(missing)"}, expected ${workerId}.`,
          "invalid_request",
        );
      }
      // Before the lease exists for anyone to post to. A throw is this summon's
      // failure, and the worker is torn down below like any other. Bounded,
      // because until the lease exists forceShutdown() cannot reach the worker.
      const beforePost = this.beforePost;
      if (beforePost !== undefined) {
        const timeoutMs = this.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            (async () =>
              beforePost({
                requestKey: request.requestKey,
                workerId,
                profile: request.profile,
                runtimePaths,
                health,
              }))(),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new LingProvisionerError(
                      `beforePost did not settle within ${timeoutMs}ms for worker ${workerId}.`,
                      "invalid_request",
                    ),
                  ),
                timeoutMs,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }
      const containerRuntime = sandboxRuntime(env);
      const lease = new LocalProvisionedWorkerLease(
        request.requestKey,
        workerId,
        request.profile,
        runtime.client,
        request.createdAt,
        request.expiresAt,
        runtimePaths,
        runtime,
        runtimeDirectory,
        containerRuntime === undefined
          ? undefined
          : {
              runtime: containerRuntime,
              env: containerRemoverEnvironment(env),
              remove: this.removeContainer,
            },
      );
      this.byWorkerId.set(workerId, lease);
      return lease;
    } catch (error) {
      // Torn down as a release is. No task has been posted, so nothing in the
      // child's tree should outlive a stop of its root; the sweep is for
      // whatever did start, detached or through a shell. The caller gets only
      // the summon's own error and no lease to finish the job with, so what
      // the teardown could not do or confirm, a root it could not kill among
      // them, is reported in the form ProvisionedLingClient reports a release's.
      const caveats: string[] = [];
      let released = true;
      try {
        caveats.push(
          ...((await runtime?.stopTree()) ?? []).map(
            (detail) => `release worker ${workerId}: ${detail}`,
          ),
        );
      } catch (stopError) {
        released = false;
        caveats.push(`release worker ${workerId}: ${errorMessage(stopError)}`);
      }
      try {
        await runtimeDirectory.dispose();
      } catch (disposeError) {
        released = false;
        caveats.push(`remove runtime directory: ${errorMessage(disposeError)}`);
      }
      if (caveats.length > 0) {
        console.error(
          `PROVISIONER_RELEASE_CAVEATS ${JSON.stringify({
            workerId,
            taskId: null,
            requestKey: request.requestKey,
            reason: "spawn-failed",
            released,
            caveats,
          } satisfies ProvisionedReleaseCaveats)}`,
        );
      }
      throw error;
    }
  }

  private async uniquePort(request: LingProvisionRequest): Promise<number> {
    for (let attempt = 0; attempt < UNIQUE_FACTORY_ATTEMPTS; attempt += 1) {
      const port = await this.portFactory(request);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new LingProvisionerError(
          `Local port factory returned invalid port ${String(port)}.`,
          "invalid_request",
        );
      }
      if (this.usedPorts.has(port)) continue;
      this.usedPorts.add(port);
      return port;
    }
    throw new LingProvisionerError(
      "Local port factory did not produce a unique port.",
      "invalid_request",
    );
  }

  private async uniqueToken(request: LingProvisionRequest): Promise<string> {
    for (let attempt = 0; attempt < UNIQUE_FACTORY_ATTEMPTS; attempt += 1) {
      const token = await this.tokenFactory(request);
      if (token.trim() === "") {
        throw new LingProvisionerError(
          "Local token factory returned an empty token.",
          "invalid_request",
        );
      }
      if (this.usedTokens.has(token)) continue;
      this.usedTokens.add(token);
      return token;
    }
    throw new LingProvisionerError(
      "Local token factory did not produce a unique token.",
      "invalid_request",
    );
  }

  private async uniqueWorkerId(request: LingProvisionRequest): Promise<string> {
    for (let attempt = 0; attempt < UNIQUE_FACTORY_ATTEMPTS; attempt += 1) {
      const workerId = await this.workerIdFactory(request);
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(workerId)) {
        throw new LingProvisionerError(
          "Local worker id must use 1-64 letters, digits, dots, underscores or dashes.",
          "invalid_request",
        );
      }
      if (this.usedWorkerIds.has(workerId)) continue;
      this.usedWorkerIds.add(workerId);
      return workerId;
    }
    throw new LingProvisionerError(
      "Local worker id factory did not produce a unique id.",
      "invalid_request",
    );
  }
}
