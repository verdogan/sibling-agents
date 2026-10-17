import { existsSync } from "node:fs";
import path from "node:path";

const envFile = path.resolve(process.cwd(), ".env");
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type SandboxMode = "none" | "docker";
export type ContainerRuntime = "podman" | "docker";

export const thinkingLevels: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function readString(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === "" ? fallback : raw.trim();
}

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function readThinking(): ThinkingLevel {
  const raw = readString("AGENT_THINKING", "medium");
  return thinkingLevels.includes(raw as ThinkingLevel) ? (raw as ThinkingLevel) : "medium";
}

export interface AgentCredential {
  id: string;
  token: string;
}

function readCredentials(): AgentCredential[] {
  const raw = process.env["AGENT_TOKENS_JSON"]?.trim();
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error("AGENT_TOKENS_JSON must be valid JSON.", { cause: error });
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("AGENT_TOKENS_JSON must map verified caller ids to bearer tokens.");
    }
    const credentials = Object.entries(parsed).map(([id, token]) => {
      if (!/^[A-Za-z0-9._:@/-]{1,128}$/.test(id)) {
        throw new Error(`Invalid credential identity ${JSON.stringify(id)}.`);
      }
      if (typeof token !== "string" || token.length < 16 || token === "change-me") {
        throw new Error(`Credential ${JSON.stringify(id)} needs a non-placeholder token.`);
      }
      return { id, token };
    });
    if (credentials.length === 0) throw new Error("AGENT_TOKENS_JSON must not be empty.");
    if (new Set(credentials.map((credential) => credential.token)).size !== credentials.length) {
      throw new Error("AGENT_TOKENS_JSON must not assign the same token to multiple identities.");
    }
    return credentials;
  }
  return [
    {
      id: readString("AGENT_CALLER_ID", "overlord"),
      token: process.env.AGENT_TOKEN ?? "",
    },
  ];
}

/** How a scripted ling's provider and model must be spelled. */
const SCRIPTED_NAME = /^scripted(?:-[a-z0-9]+)*$/;

/**
 * The scripted model this process answers every provider call with, if the
 * operator asked for one (see scripted-model.ts). Off unless both
 * LING_SCRIPTED_MODEL, the script file, and LING_ALLOW_SCRIPTED_MODEL=1 are
 * set. Either alone refuses to start: a script path left in an environment
 * must not quietly make a ling a fake, and an allow flag without a script must
 * not leave someone expecting a $0 run with a real model behind it.
 *
 * The provider and model are then the script's names, `scripted` or
 * `scripted-<name>`, and nothing else is accepted, so nothing that reads this
 * ling, /healthz and the startup lines included, takes it for a real one. A
 * task cannot reach the script on a normal ling: it may name only the
 * configured provider, and no other ling registers one by these names.
 *
 * LING_SCRIPTED_MODEL_TRACE names a file the scripted model appends every
 * request's system prompt and declared tools to (`traceScriptedModel`). A check reads it to
 * assert what a task was shown. Set on a ling with no scripted model it
 * refuses to start too: only a scripted request is traced, so a trace there
 * would stay empty, and a check that searches an empty trace for what must
 * not be in it passes for the wrong reason.
 */
function readScriptedModel():
  | { file: string; provider: string; model: string; trace: string | undefined }
  | undefined {
  const file = process.env["LING_SCRIPTED_MODEL"]?.trim() ?? "";
  const allow = process.env["LING_ALLOW_SCRIPTED_MODEL"]?.trim() ?? "";
  const trace = process.env["LING_SCRIPTED_MODEL_TRACE"]?.trim() ?? "";
  if (file === "" && allow === "") {
    if (trace !== "") {
      throw new Error(
        "LING_SCRIPTED_MODEL_TRACE records the system prompts a scripted model is sent, and this ling has no " +
          "scripted model (LING_SCRIPTED_MODEL with LING_ALLOW_SCRIPTED_MODEL=1); refusing to start with a trace " +
          "that would stay empty.",
      );
    }
    return undefined;
  }
  if (file === "" || allow !== "1") {
    throw new Error(
      "A scripted model needs both LING_SCRIPTED_MODEL (the script file) and LING_ALLOW_SCRIPTED_MODEL=1; " +
        "refusing to start with only one of them set.",
    );
  }
  const provider = readString("AGENT_PROVIDER", "scripted");
  const model = readString("AGENT_MODEL", "scripted-model");
  for (const [name, value] of [
    ["AGENT_PROVIDER", provider],
    ["AGENT_MODEL", model],
  ] as const) {
    if (!SCRIPTED_NAME.test(value)) {
      throw new Error(
        `LING_SCRIPTED_MODEL is set, so ${name} must be "scripted" or "scripted-<name>", ` +
          `not ${JSON.stringify(value)}: a scripted ling must not read as a real one.`,
      );
    }
  }
  return { file: path.resolve(file), provider, model, trace: trace === "" ? undefined : path.resolve(trace) };
}

/**
 * OpenRouter's provider-routing preferences for one model, as
 * LING_MODEL_ROUTING gives them: the one upstream provider allowed to serve
 * it, by OpenRouter's slug, with no fallback to any other.
 */
export interface OpenRouterRouting {
  order: [string];
  allow_fallbacks: false;
  data_collection?: "deny";
}

/** LING_MODEL_ROUTING: routing preferences by model id. */
export type ModelRouting = Readonly<Record<string, Readonly<OpenRouterRouting>>>;

/** The only provider whose requests carry OpenRouter's routing preferences. */
export const ROUTING_PROVIDER = "openrouter";

const ROUTING_KEYS = new Set(["order", "allow_fallbacks", "data_collection"]);
/**
 * An OpenRouter provider slug, such as `deepseek` or `deepinfra/fp8`. Lower
 * case only: the display name OpenRouter reports for a served call, such as
 * `DeepSeek`, is not a slug, and taking one for the other is the likeliest
 * mistake in this setting.
 */
const ROUTING_SLUG = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?$/;

/**
 * LING_MODEL_ROUTING, a JSON object such as
 * `{"deepseek/deepseek-v4.1-flash":{"order":["deepseek"],"allow_fallbacks":false}}`,
 * optionally with `"data_collection":"deny"` beside them.
 *
 * It is checked on every ling, whatever its provider, and a value that is not
 * that shape refuses startup: a typo must not pass on the lings that happen
 * to ignore it and then stop the one that does not. A valid value is ignored
 * by a ling whose provider is not openrouter, and an entry for a model id a
 * ling does not serve is never applied, because every local child of one
 * overlord is given the same value: the scripted reviewer and integration
 * lings start beside the paid ones, and refusing there would fail a run after
 * its builder had been paid for.
 *
 * Exported for the records check; the service reads it once, below.
 */
export function parseModelRouting(value: string | undefined): ModelRouting | undefined {
  const raw = value?.trim() ?? "";
  if (raw === "") return undefined;
  const shape =
    'a JSON object mapping model ids to {"order":["<OpenRouter provider slug>"],"allow_fallbacks":false}, ' +
    'optionally with "data_collection":"deny"';
  const refuse = (why: string) =>
    new Error(`LING_MODEL_ROUTING ${why}. It must be ${shape}; refusing to start.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`LING_MODEL_ROUTING is not valid JSON. It must be ${shape}; refusing to start.`, {
      cause: error,
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw refuse("is not a JSON object");
  }
  // No prototype, so a model id such as "__proto__" stays a key.
  const routing = Object.create(null) as Record<string, OpenRouterRouting>;
  for (const [id, entry] of Object.entries(parsed)) {
    const at = `entry ${JSON.stringify(id)}`;
    if (id === "" || /\s/.test(id)) throw refuse(`has ${at}, which is not a model id`);
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw refuse(`has ${at}, which is not an object`);
    }
    const record = entry as Record<string, unknown>;
    const unknown = Object.keys(record).filter((key) => !ROUTING_KEYS.has(key));
    if (unknown.length > 0) throw refuse(`has ${at} with unknown key(s) ${unknown.join(", ")}`);
    const order = record["order"];
    if (
      !Array.isArray(order) ||
      order.length !== 1 ||
      typeof order[0] !== "string" ||
      !ROUTING_SLUG.test(order[0])
    ) {
      throw refuse(`has ${at} whose order is not exactly one lower-case provider slug`);
    }
    if (record["allow_fallbacks"] !== false) {
      throw refuse(`has ${at} whose allow_fallbacks is not false`);
    }
    const dataCollection = record["data_collection"];
    if (dataCollection !== undefined && dataCollection !== "deny") {
      throw refuse(`has ${at} whose data_collection is not "deny"`);
    }
    routing[id] = Object.freeze({
      order: [order[0]] as [string],
      allow_fallbacks: false as const,
      ...(dataCollection === "deny" ? { data_collection: "deny" as const } : {}),
    });
  }
  return Object.freeze(routing);
}

/** LING_MODEL_MAX_TOKENS: an output ceiling by model id, for the one endpoint its routing allows. */
export type ModelMaxTokens = Readonly<Record<string, number>>;

/**
 * LING_MODEL_MAX_TOKENS, a JSON object such as `{"z-ai/glm-5.3-flash":131072}`: the most output tokens a
 * request for that model may ask for. Pi asks for the catalogue's maxTokens, and OpenRouter drops every
 * endpoint that cannot give that many, so a model routed to one provider whose endpoint gives fewer
 * would find no endpoint at all. Like LING_MODEL_ROUTING, a value that is not that shape refuses
 * startup, and an entry is applied only to an openrouter chat model of that id.
 *
 * Exported for the records check; the service reads it once, below.
 */
export function parseModelMaxTokens(value: string | undefined): ModelMaxTokens | undefined {
  const raw = value?.trim() ?? "";
  if (raw === "") return undefined;
  const refuse = (why: string) =>
    new Error(
      `LING_MODEL_MAX_TOKENS ${why}. It must be a JSON object mapping model ids to positive integers; refusing to start.`,
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw Object.assign(refuse("is not valid JSON"), { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw refuse("is not a JSON object");
  const limits = Object.create(null) as Record<string, number>;
  for (const [id, limit] of Object.entries(parsed)) {
    const at = `entry ${JSON.stringify(id)}`;
    if (id === "" || /\s/.test(id)) throw refuse(`has ${at}, which is not a model id`);
    if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1) {
      throw refuse(`has ${at}, which is not a positive integer`);
    }
    limits[id] = limit;
  }
  return Object.freeze(limits);
}

const rootDir = process.cwd();
const scriptedModel = readScriptedModel();
const modelRouting = parseModelRouting(process.env["LING_MODEL_ROUTING"]);
const modelMaxTokens = parseModelMaxTokens(process.env["LING_MODEL_MAX_TOKENS"]);
const provider = scriptedModel?.provider ?? readString("AGENT_PROVIDER", "openai");
const nativePlatform =
  process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
const nativeArch = process.arch === "arm64" ? "arm64" : "x64";
const nativeExtension = process.platform === "win32" ? ".exe" : "";
const localAgentBrowserBinary = path.join(
  rootDir,
  "node_modules",
  "agent-browser",
  "bin",
  `agent-browser-${nativePlatform}-${nativeArch}${nativeExtension}`,
);
const credentials = readCredentials();
const agentDir = path.join(rootDir, "agent");
const maxSkillsPerTask = Math.max(1, readInt("MAX_SKILLS_PER_TASK", 16));
const maxInlineSkillsPerTask = Math.min(
  maxSkillsPerTask,
  Math.max(1, readInt("MAX_INLINE_SKILLS_PER_TASK", 8)),
);
const maxInlineSkillBytes = Math.max(1_024, readInt("MAX_INLINE_SKILL_BYTES", 16 * 1_024));
const maxInlineSkillsTotalBytes = Math.max(
  maxInlineSkillBytes,
  readInt("MAX_INLINE_SKILLS_TOTAL_BYTES", 64 * 1_024),
);

export const config = {
  rootDir,
  workspacesDir: path.join(rootDir, "workspaces"),
  authDir: path.join(rootDir, "auth"),
  dataDir: path.join(rootDir, "data"),
  recipesDir: path.join(rootDir, "recipes"),
  agentDir,
  skillsDir: path.join(agentDir, "skills"),
  taskRuntimeDir: path.join(rootDir, "data", "task-runtime"),
  // The operator's event log, one `<task-id>.jsonl` per task. Kept out of the
  // workspace because the workspace belongs to the task: a log the task can
  // edit is not a record of what it did. Never mounted into a sandbox.
  eventLogDir: path.join(rootDir, "data", "events"),

  provider,
  model: scriptedModel?.model ?? readString("AGENT_MODEL", "gpt-5.6-terra"),
  thinking: readThinking(),
  // Set only when a script answers every provider call (readScriptedModel).
  // The harness reads it once, at startup, and says so loudly.
  scriptedModelFile: scriptedModel?.file,
  // Where that script's requests' system prompts are appended, if anywhere.
  scriptedModelTrace: scriptedModel?.trace,

  // LING_MODEL_ROUTING as given, undefined when unset (parseModelRouting).
  modelRoutingSetting: modelRouting,
  // The routing this ling applies: the setting on an openrouter ling, none on
  // any other. The harness applies an entry to the model of that id.
  modelRouting: (provider === ROUTING_PROVIDER ? (modelRouting ?? {}) : {}) as ModelRouting,
  // LING_MODEL_MAX_TOKENS as given, undefined when unset, and the ceilings this ling applies: the
  // setting on an openrouter ling, none on any other.
  modelMaxTokensSetting: modelMaxTokens,
  modelMaxTokens: (provider === ROUTING_PROVIDER ? (modelMaxTokens ?? {}) : {}) as ModelMaxTokens,

  credentials,
  // Local scripts use the first configured credential to call this worker.
  token: credentials[0]?.token ?? "",
  callerId: credentials[0]?.id ?? "overlord",
  workerId: readString("WORKER_ID", "local"),
  bindAddress: readString("BIND_ADDRESS", "127.0.0.1"),
  port: readInt("PORT", 8787),

  maxTurns: readInt("MAX_TURNS", 40),
  maxWallClockMs: readInt("MAX_WALL_CLOCK_MS", 900_000),
  maxCostUsd: readFloat("MAX_COST_USD", 2),
  maxConcurrency: Math.max(1, readInt("MAX_CONCURRENCY", 1)),
  allowInlineSkills: readBool("ALLOW_INLINE_SKILLS", false),
  maxSkillsPerTask,
  maxInlineSkillsPerTask,
  maxInlineSkillBytes,
  maxInlineSkillsTotalBytes,
  taskRateLimitPerMinute: Math.max(1, readInt("TASK_RATE_LIMIT_PER_MINUTE", 30)),
  taskRateLimitBurst: Math.max(1, readInt("TASK_RATE_LIMIT_BURST", 30)),
  shutdownGraceMs: Math.max(1_000, readInt("SHUTDOWN_GRACE_MS", 960_000)),
  shutdownCancelWaitMs: Math.max(
    1_000,
    readInt("SHUTDOWN_CANCEL_WAIT_MS", 30_000),
  ),
  shutdownHttpCloseMs: Math.max(
    1_000,
    readInt("SHUTDOWN_HTTP_CLOSE_MS", 5_000),
  ),
  retentionDays: Math.max(1, readInt("WORKSPACE_RETENTION_DAYS", 30)),
  retentionIntervalMs: Math.max(
    60_000,
    readInt("RETENTION_INTERVAL_MS", 24 * 60 * 60 * 1000),
  ),
  queueRestoreMaxTasks: Math.max(0, readInt("QUEUE_RESTORE_MAX_TASKS", 100)),
  queueRestoreMaxAgeMs: Math.max(
    60_000,
    readInt("QUEUE_RESTORE_MAX_AGE_MS", 24 * 60 * 60 * 1000),
  ),
  rateLimitMaxBuckets: Math.max(10, readInt("RATE_LIMIT_MAX_BUCKETS", 10_000)),
  rateLimitIdleMs: Math.max(60_000, readInt("RATE_LIMIT_IDLE_MS", 60 * 60 * 1000)),

  browserHeadless: readBool("BROWSER_HEADLESS", true),
  browserTrace: readBool("BROWSER_TRACE", false),

  agentBrowserBinary: readString(
    "AGENT_BROWSER_BIN",
    localAgentBrowserBinary,
  ),
  agentBrowserMaxOutput: Math.max(1000, readInt("AGENT_BROWSER_MAX_OUTPUT", 12_000)),
  agentBrowserSessionPrefix: readString("AGENT_BROWSER_SESSION_PREFIX", "ling"),
  agentBrowserIdleTimeoutMs: Math.max(10_000, readInt("AGENT_BROWSER_IDLE_TIMEOUT_MS", 300_000)),
  agentBrowserRepairCooldownMs: Math.max(
    60_000,
    readInt("AGENT_BROWSER_REPAIR_COOLDOWN_MS", 86_400_000),
  ),

  httpMaxBodyChars: Math.max(1_000, readInt("HTTP_MAX_BODY_CHARS", 12_000)),
  maxToolResultChars: Math.max(1_000, readInt("MAX_TOOL_RESULT_CHARS", 12_000)),
  maxToolResultCharsPerTurn: Math.max(
    1_000,
    readInt("MAX_TOOL_RESULT_CHARS_PER_TURN", 36_000),
  ),

  // How long ask_overseer waits for an answer, and how long watch_next waits
  // before it returns a heartbeat. Clamped to the ranges the overlord's pacing
  // was sized for; /healthz advertises the values in force.
  oversightAdviceWaitMs: clamp(readInt("OVERSIGHT_ADVICE_WAIT_MS", 120_000), 10_000, 300_000),
  oversightWatchIdleMs: clamp(readInt("OVERSIGHT_WATCH_IDLE_MS", 60_000), 30_000, 120_000),

  // The process that started this ling, when it asked to be watched. If it
  // disappears the ling cancels its tasks and exits, so an orphaned pair of
  // lings stops spending once the overlord that owned it is gone. Unset means
  // no watch. The overlord's local provisioner sets it to its own pid for every
  // child; a ling started by hand, or as a static-fleet worker, has none.
  parentPid: readInt("LING_PARENT_PID", 0) > 0 ? readInt("LING_PARENT_PID", 0) : undefined,

  // On by default for a local child ling (WORKER_ID local-*), which shares
  // loopback with the overlord and the other lings. An explicit setting wins.
  blockPrivateNetwork: readBool(
    "BLOCK_PRIVATE_NETWORK",
    readString("WORKER_ID", "local").startsWith("local-"),
  ),

  sandboxMode: (readString("SANDBOX_MODE", "none") === "docker" ? "docker" : "none") as SandboxMode,
  containerRuntime: (readString("CONTAINER_RUNTIME", "podman") === "docker"
    ? "docker"
    : "podman") as ContainerRuntime,
  sandboxImage: readString("SANDBOX_IMAGE", "node:24-bookworm-slim"),
  sandboxNetwork: readString("SANDBOX_NETWORK", "bridge"),
  sandboxMemory: readString("SANDBOX_MEMORY", "2g"),
  sandboxCpus: readString("SANDBOX_CPUS", "2"),
  sandboxPidsLimit: readInt("SANDBOX_PIDS_LIMIT", 512),
} as const;

export type Config = typeof config;
