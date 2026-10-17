import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  isLingEvent,
  isTerminalEvent,
  isTerminalStatus,
  LingProtocolError,
  parseSseEvents,
} from "./events.js";
import type {
  LingEvent,
  LingArtifactList,
  LingFinalState,
  LingHealth,
  LingOversightMessage,
  LingOversightResponse,
  LingPeerMessage,
  LingPeerMessageResponse,
  LingTask,
  LingTaskList,
  LingTaskOptions,
  LingWorkerVariant,
  SpawnInput,
  SpawnResponse,
} from "./types.js";

const envFile = path.resolve(process.cwd(), ".env");
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

export type LingFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface LingClientOptions {
  baseUrl?: string;
  token?: string;
  /**
   * Accepted and ignored. `history()` used to read `events.jsonl` from a task's
   * workspace under here; it no longer reads anything a task can write. Kept so
   * callers that still pass it compile.
   */
  workspacesDir?: string;
  fetch?: LingFetch;
  maxAttempts?: number;
  retryDelayMs?: number;
  /** Deadline for one non-streaming request attempt. Zero disables it. */
  requestTimeoutMs?: number;
}

export interface LingEventOptions {
  signal?: AbortSignal;
  sinceSeq?: number;
}

export class LingClientError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly retryable: boolean,
    options?: ErrorOptions,
    /** The response body's `code`, for routes that name their refusals; null otherwise. */
    readonly code: string | null = null,
  ) {
    super(message, options);
    this.name = "LingClientError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const taskStatuses = new Set([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const workerVariants: ReadonlySet<string> = new Set<LingWorkerVariant>([
  "tools_unrecorded",
  "salience_matched",
  "channel_unprompted",
]);
const taskOptionKeys = new Set([
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
]);
const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Ceiling on a replayed SSE history. The service retains a bounded event tail
 * per task, so this only guards against a pathological stream; it is not the
 * reason a replay can be short.
 */
const MAX_REPLAYED_EVENTS = 5_000;

/**
 * Ceiling on a served event log. Far above any real task's, so it guards the
 * overlord's memory against a pathological response rather than budgeting one.
 */
const MAX_EVENT_LOG_BYTES = 32 * 1024 * 1024;

/**
 * Ceilings on a final-state record. Ling lists at most 20 000 files and keeps
 * at most 1 MiB of their content and 256 KiB of result.json, so the record of
 * a working tree is a few megabytes. Nothing bounds the paths it lists, though.
 * A tree of 20 000 files whose paths come to more than about 1.5 KB each as
 * JSON writes them, by deep nesting or long names, or by names of control
 * characters, which JSON writes in six bytes each, makes an honest record past
 * the byte ceiling. It is refused all the same, since the ceiling, as the
 * log's, guards the overlord's memory. That is the one refusal here a task can
 * cause, so it has an error of its own, LingFinalStateTooLargeError.
 */
const MAX_FINAL_STATE_BYTES = 32 * 1024 * 1024;
const MAX_FINAL_STATE_FILES = 20_000;

/**
 * A final-state record longer than this client reads. Unlike any other
 * refusal of a record, an honest ling sends one, for a pathological tree its
 * task made (see MAX_FINAL_STATE_BYTES). So a caller that excludes a run for a
 * missing record can say that this is why, rather than count it as a record
 * the ling could not give.
 */
export class LingFinalStateTooLargeError extends LingProtocolError {
  constructor(
    readonly taskId: string,
    readonly maxBytes: number,
  ) {
    super(`Ling final-state record for ${taskId} exceeded ${maxBytes} bytes.`);
    this.name = "LingFinalStateTooLargeError";
  }
}

/**
 * Parse `GET /tasks/:id/log`: one sequenced event per line.
 *
 * Strict, unlike the old disk reader, because the service is the only writer and
 * its lines all have one shape: a line that is not a sequenced event is a broken
 * or tampered log, and silently skipping it would hide exactly the event a
 * reader needed. The one allowance is an unterminated last line, which is what a
 * snapshot of a running task's log looks like mid-append.
 */
function parseEventLog(text: string): LingEvent[] {
  const lines = text.split("\n");
  // Everything after the final newline is either empty or a line still being written.
  lines.pop();
  return lines.map((line, index) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new LingProtocolError(`Ling event log line ${index + 1} was not valid JSON.`);
    }
    if (!isLingEvent(value)) {
      throw new LingProtocolError(`Ling event log line ${index + 1} was not a sequenced event.`);
    }
    return value;
  });
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveInteger(value: unknown): value is number {
  return isPositiveNumber(value) && Number.isInteger(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function validStringList(
  value: unknown,
  validate: (entry: string) => boolean = (entry) => entry.length > 0,
): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string" && validate(entry)) &&
    new Set(value).size === value.length
  );
}

function validOptionalIdentity(value: unknown, maxLength: number): boolean {
  return (
    value === undefined ||
    (typeof value === "string" && value.length > 0 && value.length <= maxLength)
  );
}

function envMilliseconds(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseTaskOptions(value: unknown): LingTaskOptions {
  if (!isObject(value) || !hasOnlyKeys(value, taskOptionKeys)) {
    throw new LingProtocolError("Ling task options contained unknown fields or were not an object.");
  }

  for (const key of ["provider", "model"] as const) {
    const entry = value[key];
    if (entry !== undefined && (typeof entry !== "string" || entry.trim() === "")) {
      throw new LingProtocolError(`Ling task option ${key} was not a non-empty string.`);
    }
  }
  if (value["instructions"] !== undefined && typeof value["instructions"] !== "string") {
    throw new LingProtocolError("Ling task option instructions was not a string.");
  }
  if (
    value["thinking"] !== undefined &&
    (typeof value["thinking"] !== "string" || !thinkingLevels.has(value["thinking"]))
  ) {
    throw new LingProtocolError("Ling task option thinking was invalid.");
  }
  // Ling echoes a variant only for a task posted with one, so an overlord
  // that predates the key still reads every other task.
  if (
    value["variant"] !== undefined &&
    (typeof value["variant"] !== "string" || !workerVariants.has(value["variant"]))
  ) {
    throw new LingProtocolError("Ling task option variant was not a known worker prompt variant.");
  }
  for (const key of ["maxTurns", "maxWallClockMs", "maxCostUsd"] as const) {
    if (value[key] !== undefined && !isFiniteNumber(value[key])) {
      throw new LingProtocolError(`Ling task option ${key} was not a finite number.`);
    }
  }
  if (
    value["tools"] !== undefined &&
    (!Array.isArray(value["tools"]) ||
      value["tools"].length === 0 ||
      !value["tools"].every((tool) => typeof tool === "string"))
  ) {
    throw new LingProtocolError("Ling task option tools was not a non-empty string array.");
  }
  if (
    value["skills"] !== undefined &&
    (!validStringList(
      value["skills"],
      (name) => name.length <= 64 && skillNamePattern.test(name),
    ) ||
      value["skills"].length === 0)
  ) {
    throw new LingProtocolError("Ling task option skills contained invalid or duplicate ids.");
  }

  const selectedSkills = new Set(
    Array.isArray(value["skills"]) ? (value["skills"] as string[]) : [],
  );
  const inlineSkills = value["inlineSkills"];
  if (inlineSkills !== undefined) {
    if (!Array.isArray(inlineSkills) || inlineSkills.length === 0) {
      throw new LingProtocolError("Ling task option inlineSkills was not a non-empty array.");
    }
    for (const skill of inlineSkills) {
      if (
        !isObject(skill) ||
        !hasOnlyKeys(skill, new Set(["name", "content"])) ||
        typeof skill["name"] !== "string" ||
        skill["name"].length > 64 ||
        !skillNamePattern.test(skill["name"]) ||
        typeof skill["content"] !== "string" ||
        skill["content"].length === 0 ||
        selectedSkills.has(skill["name"])
      ) {
        throw new LingProtocolError("Ling task option inlineSkills contained an invalid entry.");
      }
      selectedSkills.add(skill["name"]);
    }
  }

  return value as unknown as LingTaskOptions;
}

const resolvedModelKeys = new Set([
  "provider",
  "id",
  "api",
  "baseUrl",
  "cost",
  "compat",
  "thinkingLevelMap",
  "contextWindow",
  "maxTokens",
  "thinking",
]);

/**
 * `/healthz`'s `model`, the configured model as the ling resolved it. Its
 * fields are checked by type, not by value: what Pi's registry says is passed
 * through as it says it, and comparing it with what a caller pinned is the
 * caller's. So a price may be negative, which is how the registry marks a
 * variable one (openrouter/auto's is -1000000), and a field the model does
 * not carry is null, as ling reports it. `compat` and the cost's extras are
 * Pi's, and only have to be objects, so a Pi upgrade that adds a compat field
 * does not make every worker unhealthy.
 */
function validResolvedModel(value: unknown): boolean {
  if (!isObject(value) || !hasOnlyKeys(value, resolvedModelKeys)) return false;
  const cost = value["cost"];
  const compat = value["compat"];
  const levels = value["thinkingLevelMap"];
  const numberOrNull = (field: unknown) => field === null || isFiniteNumber(field);
  return (
    ["provider", "id", "api"].every(
      (key) => typeof value[key] === "string" && (value[key] as string).trim() !== "",
    ) &&
    (value["baseUrl"] === null || typeof value["baseUrl"] === "string") &&
    (cost === null ||
      (isObject(cost) &&
        ["input", "output", "cacheRead", "cacheWrite"].every((key) => isFiniteNumber(cost[key])))) &&
    (compat === undefined || compat === null || isObject(compat)) &&
    (levels === undefined ||
      levels === null ||
      (isObject(levels) &&
        Object.values(levels).every((level) => level === null || typeof level === "string"))) &&
    numberOrNull(value["contextWindow"]) &&
    numberOrNull(value["maxTokens"]) &&
    typeof value["thinking"] === "string" &&
    thinkingLevels.has(value["thinking"])
  );
}

function parseHealth(value: unknown): LingHealth {
  const healthKeys = new Set([
    "ok",
    "workerId",
    "queued",
    "running",
    "maxConcurrency",
    "provider",
    "models",
    "skills",
    "model",
    "capabilities",
  ]);
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, healthKeys) ||
    value["ok"] !== true ||
    !isNonNegativeInteger(value["queued"]) ||
    !validOptionalIdentity(value["workerId"], 64) ||
    (value["running"] !== undefined && !isNonNegativeInteger(value["running"])) ||
    (value["maxConcurrency"] !== undefined &&
      !isPositiveInteger(value["maxConcurrency"])) ||
    (value["provider"] !== undefined &&
      (typeof value["provider"] !== "string" || value["provider"].trim() === "")) ||
    (value["models"] !== undefined && !validStringList(value["models"])) ||
    (value["skills"] !== undefined &&
      !validStringList(
        value["skills"],
        (name) => name.length <= 64 && skillNamePattern.test(name),
      ))
  ) {
    throw new LingProtocolError("GET /healthz did not match the LingHealth wire shape.");
  }
  if (
    value["model"] !== undefined &&
    value["model"] !== null &&
    !validResolvedModel(value["model"])
  ) {
    throw new LingProtocolError("GET /healthz contained an invalid resolved model.");
  }

  const capabilities = value["capabilities"];
  if (capabilities !== undefined) {
    if (
      !isObject(capabilities) ||
      !hasOnlyKeys(capabilities, new Set(["inlineSkills", "oversight"]))
    ) {
      throw new LingProtocolError("GET /healthz contained invalid Ling capabilities.");
    }
    // Exactly these four, all positive integers. Whether the version is one this
    // overlord can pair with is the pair's decision, not the parser's: a ling
    // advertising version 2 is well formed, and is refused as unsupported later.
    const oversight = capabilities["oversight"];
    if (oversight !== undefined) {
      const oversightKeys = ["version", "adviceWaitMs", "watchIdleMs", "maxHoldMs"];
      if (
        !isObject(oversight) ||
        Object.keys(oversight).length !== oversightKeys.length ||
        !oversightKeys.every((key) => isPositiveInteger(oversight[key]))
      ) {
        throw new LingProtocolError("GET /healthz contained invalid oversight capabilities.");
      }
    }
    const inlineSkills = capabilities["inlineSkills"];
    if (inlineSkills !== undefined) {
      const limitKeys = new Set([
        "enabled",
        "maxSkillsPerTask",
        "maxInlineSkillsPerTask",
        "maxInlineSkillBytes",
        "maxInlineSkillsTotalBytes",
      ]);
      if (
        !isObject(inlineSkills) ||
        !hasOnlyKeys(inlineSkills, limitKeys) ||
        typeof inlineSkills["enabled"] !== "boolean" ||
        !isPositiveInteger(inlineSkills["maxSkillsPerTask"]) ||
        !isPositiveInteger(inlineSkills["maxInlineSkillsPerTask"]) ||
        !isPositiveInteger(inlineSkills["maxInlineSkillBytes"]) ||
        !isPositiveInteger(inlineSkills["maxInlineSkillsTotalBytes"])
      ) {
        throw new LingProtocolError("GET /healthz contained invalid inline skill capabilities.");
      }
    }
  }
  return value as unknown as LingHealth;
}

function parseArtifactList(value: unknown): LingArtifactList {
  if (
    !isObject(value) ||
    !Array.isArray(value["files"]) ||
    typeof value["totalBytes"] !== "number"
  ) {
    throw new LingProtocolError(
      "GET /tasks/:id/artifacts did not match the LingArtifactList wire shape.",
    );
  }
  for (const file of value["files"]) {
    if (
      !isObject(file) ||
      typeof file["path"] !== "string" ||
      typeof file["size"] !== "number" ||
      typeof file["sha256"] !== "string"
    ) {
      throw new LingProtocolError("Ling artifact listing contained an invalid file.");
    }
  }
  return value as unknown as LingArtifactList;
}

const finalStateKeys = [
  "version",
  "taskId",
  "workspaceDir",
  "workspaceDirReal",
  "capturedAt",
  "promptDigest",
  "seeds",
  "files",
  "filesOmitted",
  "result",
];
const finalStateSeedKeys = [
  "path",
  "seededSha256",
  "state",
  "sha256",
  "size",
  "content",
  "contentOmitted",
];
const finalStateFileKeys = ["path", "type", "sha256", "size", "content", "contentOmitted"];
const finalStateResultKeys = ["present", "sha256", "size", "content"];
const seedStates = new Set(["unchanged", "changed", "absent", "not_regular", "unreadable"]);
const seedOmissions = new Set(["none", "too_large", "binary", "budget"]);
const fileTypes = new Set(["file", "symlink", "directory"]);
const fileOmissions = new Set(["none", "too_large", "binary", "symlink", "budget", "unreadable"]);

/**
 * Whether kept content is the file its entry describes: its UTF-8 bytes have
 * the entry's size and sha256. Content ling did not keep is null and passes.
 */
function contentMatches(entry: Record<string, unknown>): boolean {
  if (entry["content"] === null) return true;
  const bytes = Buffer.from(entry["content"] as string, "utf8");
  return (
    bytes.byteLength === entry["size"] &&
    createHash("sha256").update(bytes).digest("hex") === entry["sha256"]
  );
}

/**
 * The fields every seed, file and result entry shares, by type alone. A size
 * is null only where nothing was read: an entry with a hash has one.
 */
function validFinalStateEntry(entry: Record<string, unknown>): boolean {
  return (
    (entry["sha256"] === null || isSha256(entry["sha256"])) &&
    (entry["size"] === null ? entry["sha256"] === null : isNonNegativeInteger(entry["size"])) &&
    (entry["content"] === null || typeof entry["content"] === "string")
  );
}

/**
 * A path no ling can list on any platform: absolute, or with an empty, `.` or
 * `..` segment, or a NUL. Ling joins the names it reads with `/`, and no file
 * name holds a `/` or a NUL or is `.` or `..`. A backslash or a drive letter is
 * not refused, because a POSIX file name may hold either: what a name means
 * on the platform a caller writes it out on is that caller's to check. The
 * workspace's own entry, `.`, is a files entry's alone, and checked there.
 */
function validRecordPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !value.includes("\0") &&
    value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

/**
 * Parse `GET /tasks/:id/final-state`, version 1.
 *
 * Strict, because the record is measurement data: a scorer reads a seed's
 * state and a file's content from it, so an entry whose fields contradict each
 * other, or whose content does not hash to its own sha256, would be read as
 * something the task did. Refused here, it is a missing record instead, which
 * a caller can tell apart. So it refuses only what an honest ling cannot send,
 * whatever the task left: a refusal must not turn on what the task did. What
 * ling could not read, a file, a seed or a directory, it lists as unread, and
 * that passes. A later version is refused as one this overlord cannot read.
 * The one refusal a task can cause comes before this, at the byte ceiling
 * finalState() reads within (MAX_FINAL_STATE_BYTES).
 */
function parseFinalState(value: unknown, id: string): LingFinalState {
  const malformed = (detail: string) =>
    new LingProtocolError(`Ling final-state record for task ${id} ${detail}.`);
  if (!isObject(value)) throw malformed("was not an object");
  if (value["version"] !== 1) {
    throw malformed(`has version ${JSON.stringify(value["version"])}; this overlord reads version 1`);
  }
  if (!hasExactKeys(value, finalStateKeys)) {
    throw malformed("did not have exactly the version 1 fields");
  }
  if (value["taskId"] !== id) {
    throw malformed(`names task ${JSON.stringify(value["taskId"])}`);
  }
  if (
    typeof value["workspaceDir"] !== "string" ||
    value["workspaceDir"] === "" ||
    typeof value["workspaceDirReal"] !== "string" ||
    value["workspaceDirReal"] === "" ||
    typeof value["capturedAt"] !== "string" ||
    !Number.isFinite(Date.parse(value["capturedAt"])) ||
    (value["promptDigest"] !== null && !isSha256(value["promptDigest"])) ||
    !isNonNegativeInteger(value["filesOmitted"]) ||
    !Array.isArray(value["seeds"]) ||
    !Array.isArray(value["files"])
  ) {
    throw malformed("did not match the LingFinalState wire shape");
  }

  const seedPaths = new Set<string>();
  for (const seed of value["seeds"] as unknown[]) {
    if (
      !isObject(seed) ||
      !hasExactKeys(seed, finalStateSeedKeys) ||
      !validRecordPath(seed["path"]) ||
      seedPaths.has(seed["path"]) ||
      !isSha256(seed["seededSha256"]) ||
      typeof seed["state"] !== "string" ||
      !seedStates.has(seed["state"]) ||
      typeof seed["contentOmitted"] !== "string" ||
      !seedOmissions.has(seed["contentOmitted"]) ||
      !validFinalStateEntry(seed)
    ) {
      throw malformed("contained an invalid seed entry");
    }
    seedPaths.add(seed["path"]);
    const regular = seed["state"] === "unchanged" || seed["state"] === "changed";
    if (
      // A regular file has a hash and either its content or a reason for none;
      // anything else has neither, whatever reason it gives, and an absent one
      // a size of null or 0.
      (regular ? seed["sha256"] === null : seed["sha256"] !== null || seed["content"] !== null) ||
      (regular && (seed["contentOmitted"] === "none") !== (seed["content"] !== null)) ||
      (seed["state"] === "absent" && seed["size"] !== null && seed["size"] !== 0) ||
      (seed["state"] === "unchanged") !== (regular && seed["sha256"] === seed["seededSha256"]) ||
      !contentMatches(seed)
    ) {
      throw malformed(`described seed ${JSON.stringify(seed["path"])} inconsistently`);
    }
  }

  const files = value["files"] as unknown[];
  if (files.length > MAX_FINAL_STATE_FILES) {
    throw malformed(`listed more than ${MAX_FINAL_STATE_FILES} files`);
  }
  const filePaths = new Set<string>();
  for (const file of files) {
    if (
      !isObject(file) ||
      !hasExactKeys(file, finalStateFileKeys) ||
      typeof file["type"] !== "string" ||
      !fileTypes.has(file["type"]) ||
      // `.` is the workspace itself, listed when it is a link or could not be
      // listed, and so never as a file.
      !(validRecordPath(file["path"]) || (file["path"] === "." && file["type"] !== "file")) ||
      typeof file["contentOmitted"] !== "string" ||
      !fileOmissions.has(file["contentOmitted"]) ||
      !validFinalStateEntry(file) ||
      // Listed because it was seen, so it always has a size, a link's its own.
      file["size"] === null
    ) {
      throw malformed("contained an invalid file entry");
    }
    // result.json is only ever `result`, and a seed only ever in `seeds`.
    if (file["path"] === "result.json" || seedPaths.has(file["path"]) || filePaths.has(file["path"])) {
      throw malformed(`listed ${JSON.stringify(file["path"])} twice`);
    }
    filePaths.add(file["path"]);
    // What was not read has no hash and no content, and says why: a link is
    // never read; a file that could not be read is `unreadable`, and so is a
    // directory, which is listed only when it could not itself be listed. A
    // file that was read has its hash, and either its content or a reason for
    // none.
    if (
      (file["sha256"] === null
        ? file["content"] !== null ||
          file["contentOmitted"] !== (file["type"] === "symlink" ? "symlink" : "unreadable")
        : file["type"] !== "file" ||
          file["contentOmitted"] === "symlink" ||
          file["contentOmitted"] === "unreadable" ||
          (file["contentOmitted"] === "none") !== (file["content"] !== null)) ||
      !contentMatches(file)
    ) {
      throw malformed(`described file ${JSON.stringify(file["path"])} inconsistently`);
    }
  }

  // Something at result.json that is not a regular file is present with no
  // hash, and so with no content, as a seed that is not regular is. When
  // nothing is there it has neither, and a size of null or 0.
  const result = value["result"];
  if (
    !isObject(result) ||
    !hasExactKeys(result, finalStateResultKeys) ||
    typeof result["present"] !== "boolean" ||
    !validFinalStateEntry(result) ||
    (!result["present"] &&
      (result["sha256"] !== null || (result["size"] !== null && result["size"] !== 0))) ||
    !contentMatches(result)
  ) {
    throw malformed("contained an invalid result entry");
  }
  return value as unknown as LingFinalState;
}

function parsePeerMessageResponse(value: unknown): LingPeerMessageResponse {
  if (
    !isObject(value) ||
    value["accepted"] !== true ||
    typeof value["duplicate"] !== "boolean"
  ) {
    throw new LingProtocolError(
      "POST /tasks/:id/messages did not match the LingPeerMessageResponse wire shape.",
    );
  }
  return value as unknown as LingPeerMessageResponse;
}

function parseOversightResponse(
  value: unknown,
  message: LingOversightMessage,
): LingOversightResponse {
  if (
    !isObject(value) ||
    value["accepted"] !== true ||
    typeof value["duplicate"] !== "boolean" ||
    value["kind"] !== message.kind ||
    (value["messageId"] !== undefined && value["messageId"] !== message.id)
  ) {
    throw new LingProtocolError(
      "POST /tasks/:id/oversight did not acknowledge the message it was sent.",
    );
  }
  return { accepted: true, duplicate: value["duplicate"], kind: message.kind };
}

function parseTask(value: unknown): LingTask {
  if (
    !isObject(value) ||
    typeof value["id"] !== "string" ||
    typeof value["status"] !== "string" ||
    !taskStatuses.has(value["status"]) ||
    !validOptionalIdentity(value["requestKey"], 240) ||
    !validOptionalIdentity(value["workerId"], 64) ||
    !validOptionalIdentity(value["createdBy"], 128) ||
    typeof value["prompt"] !== "string" ||
    !isObject(value["options"]) ||
    typeof value["createdAt"] !== "string" ||
    typeof value["workspaceDir"] !== "string" ||
    !Array.isArray(value["seededFiles"])
  ) {
    throw new LingProtocolError("GET /tasks/:id did not match the LingTask wire shape.");
  }
  parseTaskOptions(value["options"]);
  if (!validStringList(value["seededFiles"])) {
    throw new LingProtocolError("GET /tasks/:id contained invalid seeded file names.");
  }
  return value as unknown as LingTask;
}

function parseSpawn(value: unknown): SpawnResponse {
  if (
    !isObject(value) ||
    typeof value["id"] !== "string" ||
    typeof value["status"] !== "string" ||
    !taskStatuses.has(value["status"]) ||
    !validOptionalIdentity(value["requestKey"], 240) ||
    !validOptionalIdentity(value["workerId"], 64) ||
    !isObject(value["options"]) ||
    !Array.isArray(value["seededFiles"])
  ) {
    throw new LingProtocolError("POST /tasks did not match the SpawnResponse wire shape.");
  }
  parseTaskOptions(value["options"]);
  if (!validStringList(value["seededFiles"])) {
    throw new LingProtocolError("POST /tasks contained invalid seeded file names.");
  }
  return value as unknown as SpawnResponse;
}

function parseList(value: unknown): LingTask[] {
  if (!isObject(value) || !Array.isArray(value["tasks"])) {
    throw new LingProtocolError("GET /tasks did not return a tasks array.");
  }
  return (value as unknown as LingTaskList).tasks.map(parseTask);
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function combineSignals(
  caller: AbortSignal | null | undefined,
  timeout: AbortSignal | undefined,
): AbortSignal | undefined {
  if (timeout === undefined) return caller ?? undefined;
  return caller === undefined || caller === null ? timeout : AbortSignal.any([caller, timeout]);
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(abortError(signal));

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal === undefined || signal === null ? undefined : abortError(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function readError(response: Response): Promise<{ message: string; code: string | null }> {
  try {
    const payload: unknown = await response.json();
    if (isObject(payload) && typeof payload["error"] === "string") {
      const code = payload["code"];
      return {
        message: payload["error"],
        code: typeof code === "string" && /^[a-z_]{1,64}$/.test(code) ? code : null,
      };
    }
  } catch {
    // An HTTP status is still actionable when the error body is absent or malformed.
  }
  return { message: response.statusText || `HTTP ${response.status}`, code: null };
}

function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get("retry-after")?.trim();
  if (!raw) return undefined;
  const seconds = Number.parseFloat(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(60_000, Math.ceil(seconds * 1000));
  }
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;
  return Math.min(60_000, Math.max(0, at - Date.now()));
}

async function* responseChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * A response body as text, refused once it passes `maxBytes`, declared or
 * read, with `tooLarge`'s error where one is given.
 */
async function readBoundedText(
  response: Response,
  maxBytes: number,
  what: string,
  tooLarge: () => Error = () => new LingProtocolError(`${what} exceeded ${maxBytes} bytes.`),
): Promise<string> {
  const length = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(length) && length > maxBytes) throw tooLarge();
  if (response.body === null) return "";
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for await (const chunk of responseChunks(response.body)) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw tooLarge();
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

export class LingClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: LingFetch;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly requestTimeoutMs: number;
  private readonly eventCache = new Map<string, Map<number, LingEvent>>();

  constructor(options: LingClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env["LING_BASE_URL"] ?? "http://127.0.0.1:8787").replace(
      /\/+$/,
      "",
    );
    this.token = options.token ?? process.env["LING_TOKEN"] ?? "";
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 50);
    this.requestTimeoutMs = Math.max(
      0,
      options.requestTimeoutMs ?? envMilliseconds("LING_REQUEST_TIMEOUT_MS", 30_000),
    );
  }

  async health(): Promise<LingHealth> {
    const response = await this.request("/healthz", { method: "GET" }, 200, false);
    return parseHealth(await response.json());
  }

  async spawn(input: SpawnInput): Promise<SpawnResponse> {
    const response = await this.request(
      "/tasks",
      { method: "POST", body: JSON.stringify(input) },
      202,
      true,
      input.requestKey === undefined ? 1 : this.maxAttempts,
    );
    return parseSpawn(await response.json());
  }

  async get(id: string): Promise<LingTask> {
    const response = await this.request(`/tasks/${encodeURIComponent(id)}`, { method: "GET" }, 200);
    return parseTask(await response.json());
  }

  async list(): Promise<LingTask[]> {
    const response = await this.request("/tasks", { method: "GET" }, 200);
    return parseList(await response.json());
  }

  async cancel(id: string): Promise<void> {
    await this.request(`/tasks/${encodeURIComponent(id)}/cancel`, { method: "POST" }, 202);
  }

  async sendPeerMessage(
    id: string,
    message: LingPeerMessage,
  ): Promise<LingPeerMessageResponse> {
    const response = await this.request(
      `/tasks/${encodeURIComponent(id)}/messages`,
      { method: "POST", body: JSON.stringify(message) },
      [200, 202],
    );
    return parsePeerMessageResponse(await response.json());
  }

  /**
   * Deliver one oversight message (`POST /tasks/:id/oversight`). The ling is
   * idempotent by message id, so a retry of the same body after an ambiguous
   * outcome comes back as a 200 duplicate rather than a second application. A
   * refusal's `code` is on the thrown `LingClientError`.
   */
  async sendOversight(id: string, message: LingOversightMessage): Promise<LingOversightResponse> {
    const response = await this.request(
      `/tasks/${encodeURIComponent(id)}/oversight`,
      { method: "POST", body: JSON.stringify(message) },
      [200, 202],
    );
    return parseOversightResponse(await response.json(), message);
  }

  async listArtifacts(id: string): Promise<LingArtifactList> {
    const response = await this.request(
      `/tasks/${encodeURIComponent(id)}/artifacts`,
      { method: "GET" },
      200,
    );
    return parseArtifactList(await response.json());
  }

  async readArtifact(id: string, artifactPath: string): Promise<Uint8Array> {
    const query = new URLSearchParams({ path: artifactPath });
    const response = await this.request(
      `/tasks/${encodeURIComponent(id)}/artifacts/file?${query}`,
      { method: "GET" },
      200,
    );
    const length = Number.parseInt(response.headers.get("content-length") ?? "", 10);
    if (Number.isFinite(length) && length > 256 * 1024) {
      throw new LingProtocolError("Ling artifact response exceeded 256 KiB.");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 256 * 1024) {
      throw new LingProtocolError("Ling artifact response exceeded 256 KiB.");
    }
    const expected = response.headers.get("x-artifact-sha256");
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (expected === null || !/^[a-f0-9]{64}$/.test(expected) || expected !== actual) {
      throw new LingProtocolError("Ling artifact response failed its SHA-256 check.");
    }
    return bytes;
  }

  async *events(id: string, options: LingEventOptions = {}): AsyncIterable<LingEvent> {
    const seenSeqs = new Set<number>();
    const signal = options.signal;
    let reconnects = 0;
    let terminalReplayAttempts = 0;

    while (!signal?.aborted) {
      let response: Response;
      try {
        response = await this.request(
          `/tasks/${encodeURIComponent(id)}/events`,
          { method: "GET", signal },
          200,
          true,
          this.maxAttempts,
          // An SSE body is deliberately long-lived, and the deadline stays
          // armed through it. Liveness here comes from the caller's signal and
          // the reconnect loop below.
          0,
        );
      } catch (error) {
        if (signal?.aborted) return;
        throw error;
      }

      if (response.body === null) {
        throw new LingProtocolError("Ling SSE response had no body.");
      }

      let terminalSeen = false;
      try {
        for await (const event of parseSseEvents(responseChunks(response.body), {
          seenSeqs,
          sinceSeq: options.sinceSeq,
        })) {
          this.rememberEvent(id, event);
          yield event;
          if (isTerminalEvent(event)) {
            terminalSeen = true;
            break;
          }
        }
      } catch (error) {
        if (signal?.aborted) return;
        if (error instanceof LingProtocolError) throw error;
        // A broken event connection is reconciled through task status below.
      }

      if (terminalSeen || signal?.aborted) return;

      const task = await this.get(id);
      if (isTerminalStatus(task.status)) {
        terminalReplayAttempts += 1;
        if (terminalReplayAttempts > this.maxAttempts) {
          throw new LingClientError(
            `Ling reported task ${id} as terminal but its terminal SSE event could not be replayed.`,
            undefined,
            true,
          );
        }
      } else {
        terminalReplayAttempts = 0;
      }

      reconnects += 1;
      const delay = Math.min(this.retryDelayMs * 2 ** Math.min(reconnects - 1, 3), 1000);
      try {
        await sleep(delay, signal);
      } catch {
        if (signal?.aborted) return;
        throw new LingClientError("Interrupted while reconnecting to Ling SSE.", undefined, true);
      }
    }
  }

  /**
   * Ling's own log for a task, from `GET /tasks/:id/log`: every event the
   * service recorded, with the same `seq` the SSE stream carries, and without
   * the stream's bounded replay tail. Rejects when the route is absent (a worker
   * that predates it), the task is unknown to this caller, or the log is
   * malformed.
   */
  async fetchLog(id: string): Promise<LingEvent[]> {
    const response = await this.request(`/tasks/${encodeURIComponent(id)}/log`, { method: "GET" }, 200);
    return parseEventLog(
      await readBoundedText(response, MAX_EVENT_LOG_BYTES, `Ling event log for ${id}`),
    );
  }

  /**
   * A terminal task's workspace as ling recorded it, from
   * `GET /tasks/:id/final-state`: the state of every seeded file, every other
   * file with its hash and, within the record's budget, its content, and
   * result.json's raw bytes. A task still running is refused with a 409 whose
   * `code` is `task_active`; a ling that predates the route answers 404. The
   * record is read from the workspace, so it goes with the worker: read it
   * before the release. One past 32 MiB is refused with a
   * LingFinalStateTooLargeError, and any other that does not parse with a
   * LingProtocolError.
   */
  async finalState(id: string): Promise<LingFinalState> {
    const response = await this.request(
      `/tasks/${encodeURIComponent(id)}/final-state`,
      { method: "GET" },
      200,
    );
    const text = await readBoundedText(
      response,
      MAX_FINAL_STATE_BYTES,
      `Ling final-state record for ${id}`,
      () => new LingFinalStateTooLargeError(id, MAX_FINAL_STATE_BYTES),
    );
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new LingProtocolError(`Ling final-state record for task ${id} was not valid JSON.`);
    }
    return parseFinalState(value, id);
  }

  /**
   * A settled task's history, from the first source that answers:
   *
   *   1. `GET /tasks/:id/log`, the service's own log, uncapped;
   *   2. the SSE events this client has already seen for the task;
   *   3. a fresh replay of the SSE route's retained tail.
   *
   * Every source carries `seq`, so a consumer can tell a whole account from a
   * partial one, and `resolveIntentReport` does exactly that. What this never
   * reads is a file in the task's workspace. It used to prefer `events.jsonl`
   * there, which made the task the author of the log it was judged against.
   *
   * The overlord's own `EventRecord`, which ranks above all three, is not a
   * source here: this client has no campaign directory, and the record is kept
   * by whoever taps the stream. That caller passes it to `resolveIntentReport`
   * as `eventRecord`, beside this history as `recorded`, and the order between
   * them is applied there.
   */
  async history(task: LingTask): Promise<LingEvent[]> {
    try {
      const logged = await this.fetchLog(task.id);
      if (logged.length > 0) return logged;
    } catch {
      // A worker that predates the route, or one that cannot be reached. The
      // stream sources below are independent of it and may still answer.
    }

    const cached = [...(this.eventCache.get(task.id)?.values() ?? [])].sort(
      (left, right) => left.seq - right.seq,
    );
    if (cached.length > 0) return cached;

    // Nothing logged and nothing streamed. An empty array would be
    // indistinguishable from a task that did nothing, so ask the SSE route for
    // its retained tail rather than reporting silence. The tail is bounded, so
    // this can be incomplete; it is returned as-is with its `seq`s, and the
    // caller decides.
    try {
      return await this.replayEvents(task);
    } catch {
      return [];
    }
  }

  /** Collect the whole retained SSE replay for a task, then stop. */
  private async replayEvents(task: LingTask): Promise<LingEvent[]> {
    const controller = new AbortController();
    const collected: LingEvent[] = [];
    try {
      for await (const event of this.events(task.id, { signal: controller.signal })) {
        collected.push(event);
        if (collected.length >= MAX_REPLAYED_EVENTS) break;
      }
    } finally {
      controller.abort();
    }
    return collected.sort((left, right) => left.seq - right.seq);
  }

  private rememberEvent(id: string, event: LingEvent): void {
    const events = this.eventCache.get(id) ?? new Map<number, LingEvent>();
    events.set(event.seq, event);
    this.eventCache.set(id, events);
  }

  private async request(
    pathname: string,
    init: RequestInit,
    expectedStatus: number | readonly number[],
    authenticated = true,
    maxAttempts = this.maxAttempts,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    if (authenticated) headers.set("authorization", `Bearer ${this.token}`);
    if (init.body !== undefined && init.body !== null) {
      headers.set("content-type", "application/json");
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      // The deadline stays armed through the body read, so a stalled response
      // cannot outlive it. Each attempt gets its own.
      const timeout = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
      const signal = combineSignals(init.signal, timeout);
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
          ...init,
          headers,
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (error) {
        if (init.signal?.aborted) throw abortError(init.signal);
        if (attempt === maxAttempts) {
          throw new LingClientError(
            timeout?.aborted === true
              ? `Ling did not respond within ${timeoutMs}ms.`
              : "Ling request failed at the transport boundary.",
            undefined,
            true,
            { cause: error },
          );
        }
        await sleep(this.backoff(attempt), init.signal);
        continue;
      }

      const expected = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
      if (expected.includes(response.status)) return response;

      const { message, code } = await readError(response);
      const retryable =
        response.status === 429 || (response.status >= 500 && response.status <= 599);
      const translated = new LingClientError(
        `Ling returned ${response.status}: ${message}`,
        response.status,
        retryable,
        undefined,
        code,
      );
      if (!retryable || attempt === maxAttempts) throw translated;
      await sleep(
        response.status === 429
          ? (retryAfterMs(response) ?? this.backoff(attempt))
          : this.backoff(attempt),
        init.signal,
      );
    }

    throw new LingClientError("Ling request exhausted its retry budget.", undefined, true);
  }

  private backoff(attempt: number): number {
    return Math.min(this.retryDelayMs * 2 ** (attempt - 1), 1000);
  }
}
