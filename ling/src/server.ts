import { timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { openRegularFile } from "./guards.js";
import type { AgentHarness } from "./harness/index.js";
import { createPiHarness, describeModel } from "./harness/pi.js";
import {
  listTaskArtifacts,
  readTaskArtifact,
  readTaskFinalState,
  TaskArtifactError,
} from "./artifacts.js";
import {
  CAMPAIGN_SEND_TOOL_NAME,
  CampaignMessageValidationError,
  MAX_CAMPAIGN_MESSAGE_BODY_BYTES,
  parseCampaignPeerMessage,
} from "./campaign.js";
import {
  config as serviceConfig,
  type AgentCredential,
  type Config,
  ROUTING_PROVIDER,
  type ThinkingLevel,
  thinkingLevels,
} from "./config.js";
import {
  draftVariantRefusal,
  oversightTimings,
  variantTakesOversight,
  WORKER_VARIANTS,
  workerVariantRefusal,
  type WorkerVariant,
} from "./features/oversight.js";
import {
  acceptedOversightKinds,
  MIN_OVERSIGHT_TOOL_RESULT_CHARS,
  OVERSIGHT_VERSION,
  OversightValidationError,
  oversightToolSetRefusal,
  parseOversightMessage,
} from "./oversight.js";
import { watchParent } from "./parent-watch.js";
import {
  SQLiteTaskStore,
  TaskQueue,
  TaskQueueShuttingDownError,
  type TaskOptions,
  type TaskRecord,
} from "./queue.js";
import { allToolNames, createTaskRunner, defaultToolNames, recordEventLog, resolveModel } from "./runner.js";
import { MonitorStore } from "./monitor/store.js";
import { TokenBucketRateLimiter } from "./rate-limit.js";
import { eventLogFile, pruneExpiredTasks } from "./retention.js";
import {
  discoverNamedSkills,
  isSafeSkillName,
  type InlineSkill,
  type NamedSkillCatalog,
  validateInlineSkillDocumentName,
} from "./skills.js";

const MAX_BODY_BYTES = 512 * 1024;
const SSE_HEARTBEAT_MS = 15_000;
const MAX_SEED_FILES = 20;
const MAX_SEED_FILE_BYTES = 256 * 1024;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendJsonLines(res: ServerResponse, rows: unknown[]): void {
  const body = rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length === 0 ? "" : "\n");
  res.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendBytes(
  res: ServerResponse,
  status: number,
  bytes: Uint8Array,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    "content-type": "application/octet-stream",
    "content-length": bytes.byteLength,
    ...headers,
  });
  res.end(bytes);
}

interface AuthenticatedCaller {
  id: string;
}

function authenticate(
  req: IncomingMessage,
  credentials: readonly AgentCredential[],
): AuthenticatedCaller | undefined {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return undefined;
  const provided = Buffer.from(header.slice("Bearer ".length).trim(), "utf8");
  let matched: AuthenticatedCaller | undefined;
  for (const credential of credentials) {
    const expected = Buffer.from(credential.token, "utf8");
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) {
      matched = { id: credential.id };
    }
  }
  return matched;
}

async function readJsonBody(
  req: IncomingMessage,
  maxBytes = MAX_BODY_BYTES,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > maxBytes) throw new HttpError(413, "Request body too large");
    chunks.push(buffer);
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
}

const MAX_INSTRUCTIONS_CHARS = 4000;

const OPTION_KEYS = [
  "provider",
  "model",
  "thinking",
  "maxTurns",
  "maxWallClockMs",
  "maxCostUsd",
  "tools",
  "skills",
  "inlineSkills",
  "instructions",
  "variant",
] as const;

/** A budget override is accepted only when it is at or below the server's own ceiling. */
function readBounded(body: Record<string, unknown>, key: string, ceiling: number): number | undefined {
  const raw = body[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    throw new HttpError(400, `"${key}" must be a positive number.`);
  }
  if (raw > ceiling) {
    throw new HttpError(
      400,
      `"${key}" of ${raw} exceeds this server's limit of ${ceiling}. A task may lower a budget but never raise it.`,
    );
  }
  return raw;
}

/**
 * Validate the per-task overrides in a request body. Rejects rather than
 * silently ignoring, so a typo in a parameter name is visible immediately.
 */
function parseTaskOptions(
  body: Record<string, unknown>,
  config: Config,
  models: ModelCatalog,
  namedSkills: NamedSkillCatalog,
): TaskOptions {
  const reserved = new Set([
    "task",
    "prompt",
    "requestKey",
    "storageState",
    "files",
    ...OPTION_KEYS,
  ]);
  for (const key of Object.keys(body)) {
    if (!reserved.has(key)) {
      throw new HttpError(400, `Unknown option "${key}". Accepted: ${[...reserved].join(", ")}.`);
    }
  }

  const options: TaskOptions = {};

  const provider = body["provider"];
  if (provider !== undefined) {
    if (typeof provider !== "string" || provider.trim() === "") {
      throw new HttpError(400, '"provider" must be a provider id string.');
    }
    if (provider.trim() !== config.provider) {
      throw new HttpError(
        400,
        `Provider "${provider.trim()}" does not match this worker's configured provider "${config.provider}". Provider selection happens when the worker is provisioned.`,
      );
    }
    options.provider = provider.trim();
  }

  const model = body["model"];
  if (model !== undefined) {
    if (typeof model !== "string" || model.trim() === "") {
      throw new HttpError(400, '"model" must be a model id string.');
    }
    if (!models.isKnown(model.trim())) {
      throw new HttpError(
        400,
        `Model "${model.trim()}" is not available for provider ${config.provider}. Known ids include: ${models.ids().slice(0, 15).join(", ")}.`,
      );
    }
    options.model = model.trim();
  }

  const thinking = body["thinking"];
  if (thinking !== undefined) {
    if (typeof thinking !== "string" || !thinkingLevels.includes(thinking as ThinkingLevel)) {
      throw new HttpError(400, `"thinking" must be one of: ${thinkingLevels.join(", ")}.`);
    }
    options.thinking = thinking as ThinkingLevel;
  }

  const maxTurns = readBounded(body, "maxTurns", config.maxTurns);
  if (maxTurns !== undefined) options.maxTurns = Math.floor(maxTurns);

  const maxWallClockMs = readBounded(body, "maxWallClockMs", config.maxWallClockMs);
  if (maxWallClockMs !== undefined) options.maxWallClockMs = Math.floor(maxWallClockMs);

  const maxCostUsd = readBounded(body, "maxCostUsd", config.maxCostUsd);
  if (maxCostUsd !== undefined) options.maxCostUsd = maxCostUsd;

  const tools = body["tools"];
  if (tools !== undefined) {
    if (!Array.isArray(tools) || tools.length === 0) {
      throw new HttpError(400, '"tools" must be a non-empty array of tool names.');
    }
    const unknown = tools.filter((name) => typeof name !== "string" || !allToolNames.includes(name));
    if (unknown.length > 0) {
      throw new HttpError(
        400,
        `Unknown tool(s): ${unknown.map((name) => JSON.stringify(name)).join(", ")}. Available: ${allToolNames.join(", ")}.`,
      );
    }
    options.tools = tools as string[];
  }

  const skills = body["skills"];
  if (skills !== undefined) {
    if (!Array.isArray(skills) || skills.length === 0) {
      throw new HttpError(400, '"skills" must be a non-empty array of named skill ids.');
    }
    const invalid = skills.filter(
      (name) => typeof name !== "string" || !isSafeSkillName(name),
    );
    if (invalid.length > 0) {
      throw new HttpError(
        400,
        `Invalid skill id(s): ${invalid.map((name) => JSON.stringify(name)).join(", ")}.`,
      );
    }
    const names = skills as string[];
    if (new Set(names).size !== names.length) {
      throw new HttpError(400, '"skills" must not contain duplicate ids.');
    }
    const unknown = names.filter((name) => !namedSkills.has(name));
    if (unknown.length > 0) {
      throw new HttpError(
        400,
        `Unknown skill(s): ${unknown.map((name) => JSON.stringify(name)).join(", ")}. Available: ${[...namedSkills.keys()].join(", ") || "(none)"}.`,
      );
    }
    options.skills = names;
  }

  const inlineSkills = body["inlineSkills"];
  if (inlineSkills !== undefined) {
    if (!config.allowInlineSkills) {
      throw new HttpError(400, '"inlineSkills" are disabled by this worker policy.');
    }
    if (!Array.isArray(inlineSkills) || inlineSkills.length === 0) {
      throw new HttpError(400, '"inlineSkills" must be a non-empty array.');
    }
    if (inlineSkills.length > config.maxInlineSkillsPerTask) {
      throw new HttpError(
        400,
        `"inlineSkills" may contain at most ${config.maxInlineSkillsPerTask} entries.`,
      );
    }

    const parsed: InlineSkill[] = [];
    const seen = new Set(options.skills ?? []);
    let totalBytes = 0;
    for (const [index, raw] of inlineSkills.entries()) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new HttpError(400, `"inlineSkills"[${index}] must be an object.`);
      }
      const entry = raw as Record<string, unknown>;
      const unknownKeys = Object.keys(entry).filter(
        (key) => key !== "name" && key !== "content",
      );
      if (unknownKeys.length > 0) {
        throw new HttpError(
          400,
          `"inlineSkills"[${index}] has unknown field(s): ${unknownKeys.join(", ")}.`,
        );
      }
      const name = entry["name"];
      const content = entry["content"];
      if (typeof name !== "string" || !isSafeSkillName(name)) {
        throw new HttpError(
          400,
          `"inlineSkills"[${index}].name must use 1-64 lowercase letters, digits, and single hyphens.`,
        );
      }
      if (seen.has(name)) {
        throw new HttpError(400, `Skill name ${JSON.stringify(name)} is selected more than once.`);
      }
      if (namedSkills.has(name)) {
        throw new HttpError(
          400,
          `Inline skill ${JSON.stringify(name)} may not shadow an image-provided skill.`,
        );
      }
      if (typeof content !== "string" || content.trim() === "") {
        throw new HttpError(
          400,
          `"inlineSkills"[${index}].content must be a non-empty SKILL.md string.`,
        );
      }
      const documentNameError = validateInlineSkillDocumentName(name, content);
      if (documentNameError !== undefined) {
        throw new HttpError(
          400,
          `"inlineSkills"[${index}].content is invalid: ${documentNameError}`,
        );
      }
      const contentBytes = Buffer.byteLength(content);
      if (contentBytes > config.maxInlineSkillBytes) {
        throw new HttpError(
          400,
          `Inline skill ${JSON.stringify(name)} exceeds the ${config.maxInlineSkillBytes}-byte content limit.`,
        );
      }
      totalBytes += contentBytes;
      if (totalBytes > config.maxInlineSkillsTotalBytes) {
        throw new HttpError(
          400,
          `"inlineSkills" exceed the ${config.maxInlineSkillsTotalBytes}-byte total content limit.`,
        );
      }
      seen.add(name);
      parsed.push({ name, content });
    }
    options.inlineSkills = parsed;
  }

  const skillCount = (options.skills?.length ?? 0) + (options.inlineSkills?.length ?? 0);
  if (skillCount > config.maxSkillsPerTask) {
    throw new HttpError(
      400,
      `A task may select at most ${config.maxSkillsPerTask} named and inline skills in total.`,
    );
  }

  const instructions = body["instructions"];
  if (instructions !== undefined) {
    if (typeof instructions !== "string") {
      throw new HttpError(400, '"instructions" must be a string.');
    }
    if (instructions.length > MAX_INSTRUCTIONS_CHARS) {
      throw new HttpError(400, `"instructions" must be at most ${MAX_INSTRUCTIONS_CHARS} characters.`);
    }
    options.instructions = instructions;
  }

  const variant = body["variant"];
  if (variant !== undefined) {
    if (typeof variant !== "string" || !WORKER_VARIANTS.includes(variant as WorkerVariant)) {
      throw new HttpError(400, `"variant" must be one of: ${WORKER_VARIANTS.join(", ")}.`);
    }
    options.variant = variant as WorkerVariant;
  }

  // Last, after every other option: the oversight tool sets this ling refuses
  // to give a task, in the contract's order. The overlord cannot read a
  // local lease's /healthz before posting its task, so this is where a ling
  // that cannot carry oversight says so.
  const oversightRefusal = oversightToolSetRefusal(options.tools ?? [], {
    maxToolResultChars: config.maxToolResultChars,
    campaignToolName: CAMPAIGN_SEND_TOOL_NAME,
    watcherModel: () => {
      const model = options.model ?? config.model;
      return { provider: config.provider, model, contextWindow: models.contextWindow(model) };
    },
  });
  if (oversightRefusal !== undefined) throw new HttpError(400, oversightRefusal);

  // After the oversight rules, so a tool set they refuse gets their text: a
  // variant's tool rules (pilot plan §2.4), then the draft rule, which keeps a
  // draft text to a scripted model and so to $0 runs.
  if (options.variant !== undefined) {
    const refusal =
      workerVariantRefusal(options.variant, options.tools ?? defaultToolNames) ??
      draftVariantRefusal(options.variant, config.scriptedModelFile !== undefined);
    if (refusal !== undefined) throw new HttpError(400, refusal);
  }

  return options;
}

function parseSeedFiles(body: Record<string, unknown>): Record<string, string> | undefined {
  const raw = body["files"];
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new HttpError(400, '"files" must be an object mapping relative paths to text content.');
  }

  const entries = Object.entries(raw);
  if (entries.length === 0 || entries.length > MAX_SEED_FILES) {
    throw new HttpError(400, `"files" must contain between 1 and ${MAX_SEED_FILES} entries.`);
  }

  let totalBytes = 0;
  const files: Record<string, string> = {};
  for (const [name, content] of entries) {
    if (name.trim() === "" || name.length > 240) {
      throw new HttpError(400, "Each seeded file needs a non-empty relative path under 240 characters.");
    }
    const normalized = path.normalize(name);
    if (path.isAbsolute(name) || normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
      throw new HttpError(400, `Seeded file ${JSON.stringify(name)} must stay inside the task workspace.`);
    }
    if (typeof content !== "string") {
      throw new HttpError(400, `Seeded file ${JSON.stringify(name)} must contain text.`);
    }
    totalBytes += Buffer.byteLength(content);
    if (totalBytes > MAX_SEED_FILE_BYTES) {
      throw new HttpError(400, `"files" may contain at most ${MAX_SEED_FILE_BYTES} bytes in total.`);
    }
    files[name] = content;
  }
  return files;
}

/** Task representation for API responses: everything except the event backlog. */
function publicTask(task: TaskRecord) {
  return {
    id: task.id,
    requestKey: task.requestKey,
    createdBy: task.createdBy,
    status: task.status,
    prompt: task.prompt,
    options: task.options,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    stoppedBy: task.stoppedBy,
    result: task.result,
    error: task.error,
    stats: task.stats,
    artifacts: task.artifacts,
    workspaceDir: task.workspaceDir,
    seededFiles: Object.keys(task.seedFiles ?? {}),
  };
}

function streamEvents(req: IncomingMessage, res: ServerResponse, queue: TaskQueue, id: string): void {
  const task = queue.get(id);
  if (!task) {
    sendJson(res, 404, { error: "No such task" });
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  const write = (event: { seq: number; type: string; at: string; data?: unknown }) => {
    res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  };

  for (const event of task.events) {
    write(event);
  }

  const terminal = new Set(["completed", "failed", "cancelled", "interrupted"]);
  if (terminal.has(task.status)) {
    res.end();
    return;
  }

  const terminalEvents = new Set([
    "task_finished",
    "task_failed",
    "task_cancelled",
    "task_interrupted",
  ]);

  const unsubscribe = queue.subscribe(id, (event) => {
    write(event);
    if (terminalEvents.has(event.type)) {
      cleanup();
      res.end();
    }
  });

  const heartbeat = setInterval(() => res.write(": keepalive\n\n"), SSE_HEARTBEAT_MS);

  function cleanup(): void {
    clearInterval(heartbeat);
    unsubscribe();
  }

  req.on("close", cleanup);
}

/**
 * Serve a task's operator event log as recorded: NDJSON, one `{ seq, at, type,
 * data? }` line per event — the records the SSE route streams, without its
 * bounded tail. The log is outside the workspace, so this is the task's history
 * as the service recorded it rather than as the task left it.
 *
 * The response is a snapshot of the file at open time, so a running task's log
 * can end in a line the service was still appending; readers must allow for an
 * unterminated last line. A log that is not a regular file is refused rather
 * than followed, since a task on an unsandboxed host can reach this directory.
 * Such a task can also rewrite its log in place, seqs and all, and nothing here
 * would notice (see `recordEventLog`).
 */
async function sendEventLog(res: ServerResponse, eventLogDir: string, id: string): Promise<void> {
  let handle;
  try {
    handle = await openRegularFile(eventLogFile(eventLogDir, id), fsConstants.O_RDONLY);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new HttpError(404, `No event log is recorded for task ${id}.`);
    }
    throw new HttpError(
      409,
      `The event log for task ${id} was not served: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    const { size } = await handle.stat();
    res.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "content-length": size,
    });
    if (size === 0) {
      res.end();
      return;
    }
    await pipeline(handle.createReadStream({ start: 0, end: size - 1, autoClose: false }), res);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export interface ModelCatalog {
  isKnown(id: string): boolean;
  ids(): string[];
  /** The model's context window in tokens, for the watcher rule of POST /tasks. */
  contextWindow(id: string): number | undefined;
}

/**
 * The configured model as this ling resolved it, after LING_MODEL_ROUTING,
 * with the thinking level a task runs at unless it names one: /healthz
 * `model`, printed at startup too. A caller that pinned a model compares this
 * with its pin before it posts anything. It shows the catalogue's base URL:
 * the ling's `agent/auth.json` or `agent/models.json` can still give a
 * request another base URL or key at request time, and the environment
 * another key, and none of that shows here (`HarnessModelRecord`).
 */
export type ResolvedModel = ReturnType<typeof describeModel> & { thinking: ThinkingLevel };

/** Everything the HTTP API reads, so the checks can mount it on a queue of their own. */
export interface ApiDeps {
  config: Config;
  queue: TaskQueue;
  models: ModelCatalog;
  monitor: Pick<MonitorStore, "listItems" | "listRuns">;
  rateLimiter: TokenBucketRateLimiter;
  namedSkills: NamedSkillCatalog;
  /** Null, or left out, when the configured model did not resolve. */
  resolvedModel?: ResolvedModel | null;
}

const TERMINAL_STATUSES: ReadonlySet<TaskRecord["status"]> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

/**
 * What LING_MODEL_ROUTING does on this ling, as the lines startup prints: the
 * routing in force for each model it names, or why an entry, or the whole
 * setting, is ignored here.
 */
function describeRouting(config: Config, harness: AgentHarness): string[] {
  const setting = config.modelRoutingSetting;
  if (setting === undefined) return ["routing: none (LING_MODEL_ROUTING is unset)"];
  if (config.provider !== ROUTING_PROVIDER) return [`routing: ignored (provider ${config.provider})`];
  const lines = Object.entries(setting).map(([id, routing]) => {
    const model = harness.resolveModel(config.provider, id);
    if (model === undefined) return `routing: ignored for ${id} (not a model this ling serves)`;
    if (describeModel(model).compat?.["openRouterRouting"] === undefined) {
      return `routing: ignored for ${id} (its api, ${model.api}, carries no OpenRouter routing)`;
    }
    return `routing: ${id} ${JSON.stringify(routing)}`;
  });
  const ceilings =
    config.modelMaxTokensSetting === undefined || config.provider !== ROUTING_PROVIDER
      ? []
      : Object.entries(config.modelMaxTokensSetting).map(([id, limit]) => {
          const model = harness.resolveModel(config.provider, id);
          return model === undefined
            ? `max tokens: ignored for ${id} (not a model this ling serves)`
            : `max tokens: ${id} ${String(describeModel(model).maxTokens)} (LING_MODEL_MAX_TOKENS ${limit})`;
        });
  return [...(lines.length > 0 ? lines : ["routing: none (LING_MODEL_ROUTING names no model)"]), ...ceilings];
}

function sendOversightError(res: ServerResponse, status: number, code: string, error: string): void {
  sendJson(res, status, { error, code });
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: ApiDeps): Promise<void> {
  const { config, queue, models, monitor, rateLimiter, namedSkills } = deps;
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  const method = req.method ?? "GET";

  if (method === "GET" && url.pathname === "/healthz") {
    const counts = queue.counts();
    sendJson(res, 200, {
      ok: true,
      workerId: config.workerId,
      queued: counts.queued,
      running: counts.running,
      maxConcurrency: config.maxConcurrency,
      provider: config.provider,
      models: models.ids(),
      model: deps.resolvedModel ?? null,
      skills: [...namedSkills.keys()],
      capabilities: {
        inlineSkills: {
          enabled: config.allowInlineSkills,
          maxSkillsPerTask: config.maxSkillsPerTask,
          maxInlineSkillsPerTask: config.maxInlineSkillsPerTask,
          maxInlineSkillBytes: config.maxInlineSkillBytes,
          maxInlineSkillsTotalBytes: config.maxInlineSkillsTotalBytes,
        },
        // Advertised only when a feed batch fits a tool result whole; below
        // that POST /tasks refuses every oversight tool.
        ...(config.maxToolResultChars >= MIN_OVERSIGHT_TOOL_RESULT_CHARS
          ? { oversight: { version: OVERSIGHT_VERSION, ...oversightTimings(config) } }
          : {}),
      },
    });
    return;
  }

  const caller = authenticate(req, config.credentials);
  if (caller === undefined) {
    res.setHeader("www-authenticate", "Bearer");
    sendJson(res, 401, { error: "Missing or invalid bearer token" });
    return;
  }

  if (segments[0] === "monitor" && method === "GET") {
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw === null ? 100 : Number.parseInt(limitRaw, 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new HttpError(400, '"limit" must be an integer between 1 and 1000.');
    }

    if (segments[1] === "items" || segments[1] === "items.jsonl") {
      const since = url.searchParams.get("since") ?? undefined;
      if (since !== undefined && Number.isNaN(Date.parse(since))) {
        throw new HttpError(400, '"since" must be an ISO date.');
      }
      const items = monitor.listItems({
        ...(since === undefined ? {} : { since: new Date(since).toISOString() }),
        ...(url.searchParams.has("platform")
          ? { platform: url.searchParams.get("platform") ?? "" }
          : {}),
        ...(url.searchParams.has("query") ? { query: url.searchParams.get("query") ?? "" } : {}),
        limit,
      });
      if (segments[1] === "items.jsonl") {
        sendJsonLines(res, items);
      } else {
        sendJson(res, 200, { items });
      }
      return;
    }

    if (segments[1] === "runs") {
      sendJson(res, 200, {
        runs: monitor.listRuns(url.searchParams.get("recipe") ?? undefined, limit),
      });
      return;
    }
  }

  if (segments[0] !== "tasks") {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  // POST /tasks
  if (method === "POST" && segments.length === 1) {
    const rate = rateLimiter.take(caller.id);
    if (!rate.allowed) {
      res.setHeader("retry-after", String(rate.retryAfterSeconds));
      sendJson(res, 429, { error: "Task creation rate limit exceeded." });
      return;
    }
    const body = (await readJsonBody(req)) as Record<string, unknown> | undefined;
    const prompt = body?.["task"] ?? body?.["prompt"];
    if (typeof prompt !== "string" || prompt.trim() === "") {
      throw new HttpError(400, 'Provide a non-empty "task" string describing what to do.');
    }
    const storageState = body?.["storageState"];
    if (storageState !== undefined && typeof storageState !== "string") {
      throw new HttpError(400, '"storageState" must be a string naming a file in auth/.');
    }
    const requestKey = body?.["requestKey"];
    if (
      requestKey !== undefined &&
      (typeof requestKey !== "string" ||
        requestKey.trim() === "" ||
        requestKey.length > 240)
    ) {
      throw new HttpError(400, '"requestKey" must be a non-empty string of at most 240 characters.');
    }

    const options = parseTaskOptions(body ?? {}, config, models, namedSkills);
    const seedFiles = parseSeedFiles(body ?? {});

    const task = queue.enqueue({
      createdBy: caller.id,
      prompt: prompt.trim(),
      ...(typeof requestKey === "string" ? { requestKey } : {}),
      ...(typeof storageState === "string" ? { storageState } : {}),
      ...(seedFiles !== undefined ? { seedFiles } : {}),
      options,
    });
    sendJson(res, 202, {
      id: task.id,
      requestKey: task.requestKey,
      status: task.status,
      options: task.options,
      seededFiles: Object.keys(task.seedFiles ?? {}),
    });
    return;
  }

  // GET /tasks
  if (method === "GET" && segments.length === 1) {
    sendJson(res, 200, {
      tasks: queue
        .list()
        .filter((task) => task.createdBy === caller.id)
        .map(publicTask),
    });
    return;
  }

  const id = segments[1];
  if (id === undefined) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  // GET /tasks/:id
  if (method === "GET" && segments.length === 2) {
    const task = queue.get(id);
    if (!task || task.createdBy !== caller.id) {
      sendJson(res, 404, { error: "No such task" });
      return;
    }
    sendJson(res, 200, publicTask(task));
    return;
  }

  // GET /tasks/:id/artifacts
  if (method === "GET" && segments.length === 3 && segments[2] === "artifacts") {
    const task = queue.get(id);
    if (!task || task.createdBy !== caller.id) {
      sendJson(res, 404, { error: "No such task" });
      return;
    }
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw === null ? undefined : Number.parseInt(limitRaw, 10);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 20)) {
      throw new HttpError(400, '"limit" must be an integer between 1 and 20.');
    }
    const listing = await listTaskArtifacts(task, {
      ...(url.searchParams.has("cursor")
        ? { cursor: url.searchParams.get("cursor") ?? "" }
        : {}),
      ...(limit === undefined ? {} : { limit }),
    });
    sendJson(res, 200, listing);
    return;
  }

  // GET /tasks/:id/artifacts/file?path=relative/path
  if (
    method === "GET" &&
    segments.length === 4 &&
    segments[2] === "artifacts" &&
    segments[3] === "file"
  ) {
    const task = queue.get(id);
    if (!task || task.createdBy !== caller.id) {
      sendJson(res, 404, { error: "No such task" });
      return;
    }
    const requestedPath = url.searchParams.get("path");
    if (requestedPath === null) throw new HttpError(400, 'Provide an artifact "path".');
    const artifact = await readTaskArtifact(task, requestedPath);
    sendBytes(res, 200, artifact.bytes, {
      "x-artifact-path": artifact.file.path,
      "x-artifact-sha256": artifact.file.sha256,
    });
    return;
  }

  // GET /tasks/:id/final-state
  //
  // The workspace as the task left it (readTaskFinalState): the seeds, every
  // other file, and result.json's raw bytes. Only for a task that has ended:
  // a running task's workspace is not a final state. With them, the digest of
  // the system prompt its model was sent, null if it was never sent one.
  if (method === "GET" && segments.length === 3 && segments[2] === "final-state") {
    const task = queue.get(id);
    if (!task || task.createdBy !== caller.id) {
      sendJson(res, 404, { error: "No such task" });
      return;
    }
    if (!TERMINAL_STATUSES.has(task.status)) {
      sendJson(res, 409, {
        error: `Task ${id} is ${task.status}; its final state is recorded once it has ended.`,
        code: "task_active",
      });
      return;
    }
    sendJson(res, 200, { ...(await readTaskFinalState(task)), promptDigest: task.promptDigest ?? null });
    return;
  }

  // GET /tasks/:id/events
  if (method === "GET" && segments.length === 3 && segments[2] === "events") {
    const task = queue.get(id);
    if (!task || task.createdBy !== caller.id) {
      sendJson(res, 404, { error: "No such task" });
      return;
    }
    streamEvents(req, res, queue, id);
    return;
  }

  // GET /tasks/:id/log
  if (method === "GET" && segments.length === 3 && segments[2] === "log") {
    const task = queue.get(id);
    if (!task || task.createdBy !== caller.id) {
      sendJson(res, 404, { error: "No such task" });
      return;
    }
    await sendEventLog(res, config.eventLogDir, id);
    return;
  }

  // POST /tasks/:id/oversight
  if (method === "POST" && segments.length === 3 && segments[2] === "oversight") {
    const owned = queue.get(id);
    if (!owned || owned.createdBy !== caller.id) {
      sendJson(res, 404, { error: "No such task" });
      return;
    }

    let message;
    try {
      message = parseOversightMessage(await readJsonBody(req, MAX_CAMPAIGN_MESSAGE_BODY_BYTES));
    } catch (error) {
      if (error instanceof OversightValidationError || (error instanceof HttpError && error.status === 400)) {
        sendOversightError(res, 400, "invalid_message", error.message);
        return;
      }
      throw error;
    }

    // Stateless: the role comes from the task's tools, and everything that
    // depends on the run's state is reported as the effect of the message's
    // oversight_delivered event instead.
    const tools = owned.options.tools ?? [];
    const accepted = acceptedOversightKinds(tools);
    if (accepted.length === 0) {
      sendOversightError(res, 409, "feature_not_enabled", `Task ${id} was not created with any oversight tool.`);
      return;
    }
    // A no-watcher variant has no overseer to send anything, and a hold would
    // make its texts untrue (`variantTakesOversight`).
    const variant = owned.options.variant;
    if (!variantTakesOversight(variant)) {
      sendOversightError(
        res,
        400,
        "kind_not_accepted",
        `Task ${id} accepts no oversight messages: it runs as variant ${variant ?? ""}, which has no overseer.`,
      );
      return;
    }
    if (!accepted.includes(message.kind)) {
      sendOversightError(
        res,
        400,
        "kind_not_accepted",
        `Task ${id} accepts only ${accepted.join(", ")} oversight messages, not ${message.kind}.`,
      );
      return;
    }

    const result = queue.injectOversightMessage(id, message);
    switch (result.status) {
      case "accepted":
      case "duplicate":
        sendJson(res, result.status === "accepted" ? 202 : 200, {
          id,
          messageId: message.id,
          kind: message.kind,
          accepted: true,
          duplicate: result.status === "duplicate",
        });
        return;
      case "feature_not_enabled":
        sendOversightError(res, 409, "feature_not_enabled", `Task ${id} was not created with any oversight tool.`);
        return;
      case "not_running":
        sendOversightError(
          res,
          409,
          "not_running",
          `Task ${id} is ${result.taskStatus}; oversight messages are accepted only while it is running.`,
        );
        return;
      case "subscriber_unavailable":
        sendOversightError(res, 409, "subscriber_unavailable", `Task ${id}'s message inbox is closed.`);
        return;
      case "id_conflict":
        sendOversightError(
          res,
          409,
          "id_conflict",
          `Task ${id} already received message id ${message.id} with different content.`,
        );
        return;
      case "inbox_full":
        sendOversightError(
          res,
          409,
          "inbox_full",
          `Task ${id}'s message inbox has reached its ${result.limit}-message limit.`,
        );
        return;
      case "not_found":
        sendJson(res, 404, { error: "No such task" });
        return;
    }
  }

  // POST /tasks/:id/messages
  if (method === "POST" && segments.length === 3 && segments[2] === "messages") {
    const owned = queue.get(id);
    if (!owned || owned.createdBy !== caller.id) {
      sendJson(res, 404, { error: "No such task" });
      return;
    }

    let message;
    try {
      message = parseCampaignPeerMessage(
        await readJsonBody(req, MAX_CAMPAIGN_MESSAGE_BODY_BYTES),
      );
    } catch (error) {
      if (error instanceof CampaignMessageValidationError) {
        throw new HttpError(400, error.message);
      }
      throw error;
    }

    const result = queue.injectCampaignMessage(id, message);
    switch (result.status) {
      case "accepted":
        sendJson(res, 202, {
          id,
          messageId: message.id,
          accepted: true,
          duplicate: false,
        });
        return;
      case "duplicate":
        sendJson(res, 200, {
          id,
          messageId: message.id,
          accepted: true,
          duplicate: true,
        });
        return;
      case "feature_not_enabled":
        sendJson(res, 409, {
          error: `Task ${id} was not created with the campaign_send feature.`,
        });
        return;
      case "not_running":
        sendJson(res, 409, {
          error: `Task ${id} is ${result.taskStatus}; messages are accepted only while it is running.`,
        });
        return;
      case "subscriber_unavailable":
        sendJson(res, 409, {
          error: `Task ${id}'s campaign message subscriber is unavailable.`,
        });
        return;
      case "id_conflict":
        sendJson(res, 409, {
          error: `Task ${id} already received message id ${message.id} with different content.`,
        });
        return;
      case "inbox_full":
        sendJson(res, 409, {
          error: `Task ${id}'s campaign inbox has reached its ${result.limit}-message limit.`,
        });
        return;
      case "not_found":
        sendJson(res, 404, { error: "No such task" });
        return;
    }
  }

  // POST /tasks/:id/cancel
  if (method === "POST" && segments.length === 3 && segments[2] === "cancel") {
    const owned = queue.get(id);
    if (!owned || owned.createdBy !== caller.id) {
      sendJson(res, 404, { error: "No such task" });
      return;
    }
    const cancelled = queue.cancel(id);
    if (!cancelled) {
      const task = queue.get(id);
      sendJson(res, task ? 409 : 404, {
        error: task ? `Task is already ${task.status}` : "No such task",
      });
      return;
    }
    sendJson(res, 202, { id, cancelling: true });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

/**
 * The HTTP API as a request listener. main() mounts it on the service's port;
 * the offline oversight check mounts it on a queue of its own.
 */
export function createRequestListener(
  deps: ApiDeps,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    handle(req, res, deps).catch((error: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.message });
        return;
      }
      if (error instanceof TaskArtifactError) {
        sendJson(res, error.status, { error: error.message });
        return;
      }
      if (error instanceof TaskQueueShuttingDownError) {
        sendJson(res, 503, { error: error.message });
        return;
      }
      console.error("unhandled request error:", error);
      sendJson(res, 500, { error: "Internal error" });
    });
  };
}

/** How long an orphaned ling waits for its cancelled tasks before it exits anyway. */
const ORPHAN_CANCEL_WAIT_MS = 3_000;

async function main(): Promise<void> {
  const config = serviceConfig;
  if (
    config.credentials.length === 0 ||
    config.credentials.some(
      (credential) => credential.token.trim() === "" || credential.token === "change-me",
    )
  ) {
    console.error(
      "No valid worker credential is configured. Set AGENT_TOKENS_JSON (preferred) or AGENT_TOKEN. This API executes shell commands and refuses placeholder credentials.",
    );
    process.exit(1);
  }

  await mkdir(config.workspacesDir, { recursive: true });
  await mkdir(config.authDir, { recursive: true });
  await mkdir(config.dataDir, { recursive: true });
  await mkdir(config.eventLogDir, { recursive: true });
  await mkdir(config.recipesDir, { recursive: true });
  await mkdir(config.agentDir, { recursive: true });
  // No task survives a process restart as running; remove task-private inline
  // skill material left behind by an unclean shutdown before restoring queue state.
  await rm(config.taskRuntimeDir, { recursive: true, force: true });
  await mkdir(config.taskRuntimeDir, { recursive: true });

  const harness = await createPiHarness();
  const namedSkills = discoverNamedSkills(config.skillsDir);

  let resolvedModel: ResolvedModel | null = null;
  try {
    const model = resolveModel({ config, harness });
    console.log(`model: ${config.provider}/${model.id} (thinking: ${config.thinking})`);
    resolvedModel = { ...describeModel(model), thinking: config.thinking };
    console.log(`resolved model: ${JSON.stringify(resolvedModel)}`);
  } catch (error) {
    console.warn(`warning: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const line of describeRouting(config, harness)) console.log(line);

  if (!harness.hasCredentials(config.provider)) {
    console.warn(
      `warning: no credentials found for provider "${config.provider}". Set the provider API key in .env before posting tasks.`,
    );
  }

  const isLoopback =
    config.bindAddress === "127.0.0.1" || config.bindAddress === "::1" || config.bindAddress === "localhost";
  if (!isLoopback) {
    console.warn(
      `warning: bound to ${config.bindAddress}, not loopback. Anyone who can reach this port and holds the token can run shell commands on this host.`,
    );
  }

  const store = new SQLiteTaskStore(path.join(config.dataDir, "tasks.db"));
  const prunedAtStartup = await pruneExpiredTasks(
    store,
    config.workspacesDir,
    config.retentionDays,
    Date.now(),
    config.eventLogDir,
  );
  if (prunedAtStartup > 0) {
    console.log(`retention: pruned ${prunedAtStartup} expired task(s)`);
  }
  const monitor = new MonitorStore();
  const queue = new TaskQueue({
    // The queue appends through the log wrapper; retention and shutdown keep
    // the bare store, since neither appends events. Wrapping first copies into
    // each log what the store appended without it, such as recovery's
    // task_interrupted.
    store: recordEventLog(store, config.eventLogDir),
    concurrency: config.maxConcurrency,
    runner: createTaskRunner({ config, harness, namedSkills }),
    workspaceDirFor: (taskId) => path.join(config.workspacesDir, taskId),
    restoreMaxTasks: config.queueRestoreMaxTasks,
    restoreMaxAgeMs: config.queueRestoreMaxAgeMs,
  });

  const models: ModelCatalog = {
    isKnown: (id) => harness.resolveModel(config.provider, id) !== undefined,
    ids: () => harness.listModelIds(config.provider),
    contextWindow: (id) => harness.resolveModel(config.provider, id)?.contextWindow,
  };
  const rateLimiter = new TokenBucketRateLimiter(
    config.taskRateLimitPerMinute,
    config.taskRateLimitBurst,
    config.rateLimitMaxBuckets,
    config.rateLimitIdleMs,
  );

  const server = createServer(
    createRequestListener({ config, queue, models, monitor, rateLimiter, namedSkills, resolvedModel }),
  );

  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(
        `${config.bindAddress}:${config.port} is already in use. Stop the other instance, or set PORT in .env.`,
      );
      process.exit(1);
    }
    throw error;
  });

  server.listen(config.port, config.bindAddress, () => {
    console.log(`autonomous-pi-agent listening on http://${config.bindAddress}:${config.port}`);
    console.log(
      `budgets per task: ${config.maxTurns} turns, ${Math.round(config.maxWallClockMs / 1000)}s, $${config.maxCostUsd.toFixed(2)} | concurrency ${config.maxConcurrency}`,
    );
  });

  const retentionTimer = setInterval(() => {
    void pruneExpiredTasks(
      store,
      config.workspacesDir,
      config.retentionDays,
      Date.now(),
      config.eventLogDir,
    )
      .then((count) => {
        if (count > 0) console.log(`retention: pruned ${count} expired task(s)`);
      })
      .catch((error: unknown) => {
        console.error("retention failed:", error);
      });
  }, config.retentionIntervalMs);
  retentionTimer.unref();

  const settlesWithin = async (promise: Promise<unknown>, timeoutMs: number): Promise<boolean> => {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref();
    });
    const settled = await Promise.race([promise.then(() => true), timedOut]);
    if (timer !== undefined) clearTimeout(timer);
    return settled;
  };

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => {
    if (shutdownPromise !== undefined) {
      console.warn("second shutdown signal: cancelling remaining tasks");
      queue.cancelAll();
      return;
    }
    shutdownPromise = (async () => {
      console.log("shutting down: draining queued and running tasks");
      const listenerClosed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      const drain = queue.drain();
      const drained = await settlesWithin(drain, config.shutdownGraceMs);
      let forced = false;
      if (!drained) {
        console.warn(
          `shutdown grace of ${config.shutdownGraceMs}ms expired; cancelling remaining tasks`,
        );
        queue.cancelAll();
        if (!(await settlesWithin(drain, config.shutdownCancelWaitMs))) {
          forced = true;
          queue.interruptRemaining(
            `Ling shutdown cancellation did not settle within ${config.shutdownCancelWaitMs}ms.`,
          );
        }
      }
      if (!(await settlesWithin(listenerClosed, config.shutdownHttpCloseMs))) {
        forced = true;
        server.closeAllConnections();
        await settlesWithin(listenerClosed, 1_000);
      }
      clearInterval(retentionTimer);
      monitor.close();
      store.close();
      console.log("shutdown complete");
      if (forced) {
        process.exitCode = 1;
        setImmediate(() => process.exit(1));
      }
    })().catch((error: unknown) => {
      console.error("shutdown failed:", error);
      process.exitCode = 1;
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // The process that started this ling is gone, so nothing will read what its
  // tasks produce, and a running task would keep spending until its own budget
  // stopped it. Unlike a signalled shutdown this does not drain: every task is
  // cancelled at once, given a few seconds to stop, and the ling exits.
  if (config.parentPid !== undefined) {
    const parentPid = config.parentPid;
    watchParent({
      pid: parentPid,
      onGone: () => {
        console.warn(`parent process ${parentPid} is gone: cancelling every task and exiting`);
        void (async () => {
          server.close(() => undefined);
          server.closeAllConnections();
          const drain = queue.drain();
          queue.cancelAll();
          const drained = await settlesWithin(drain, ORPHAN_CANCEL_WAIT_MS);
          if (!drained) {
            queue.interruptRemaining(
              `Ling's parent process ${parentPid} exited and its tasks did not stop within ${ORPHAN_CANCEL_WAIT_MS}ms.`,
            );
          }
          clearInterval(retentionTimer);
          monitor.close();
          store.close();
          process.exit(drained ? 0 : 1);
        })().catch((error: unknown) => {
          console.error("orphan shutdown failed:", error);
          process.exit(1);
        });
      },
    });
    console.log(`watching parent process ${parentPid}`);
  }
}

// The offline oversight check imports this module to mount the API on a queue
// of its own, and sets this so that importing it does not start the service.
if (process.env["LING_SERVER_IMPORT_ONLY"] !== "1") {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
