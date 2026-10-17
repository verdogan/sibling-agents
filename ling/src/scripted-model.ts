/**
 * A scripted model for a whole ling process, for offline end-to-end checks.
 *
 * With LING_SCRIPTED_MODEL and LING_ALLOW_SCRIPTED_MODEL=1 (config.ts), every
 * provider call the process makes is answered from a JSON script instead of a
 * model, through the faux-provider seam the oversight check already drives
 * in-process (`createScriptedPiHarness`). The HTTP API, the queue, the agent
 * loop, the tools and the hooks are all real; only the model is not. Nothing
 * is spent, and nothing is learned about any model: a run shows what its
 * script made it do, and what the rest of the system did about that.
 *
 * The format is deliberately small. A script is an ordered list of assistant
 * turns, each some text and a list of tool calls, answered in order across
 * the process's provider calls. A local child runs one task, so that is one
 * task's turns. Three additions let a script keep time with a partner it
 * cannot see, and nothing more:
 *
 * - `until`: repeat the turn until what the model was shown since its last
 *   reply (tool results and any steered message) matches a regex. This is how
 *   a script waits: a watcher calls watch_next until the batch it needs has
 *   come, a worker keeps working until a hold notice arrives.
 * - `capture` and `{{name}}`: take a value, such as an evidence id, by a
 *   regex's first group, and put it in a later turn's text or string
 *   arguments. It is the latest match in anything the model has been sent so
 *   far, since what a script waited for need not arrive alone.
 * - `hang`: a provider call that never returns, and ignores the run's abort,
 *   as a wedged model call would. No ling tool ignores its abort signal, so
 *   this is where a check puts a task that a cancel cannot stop.
 *
 * When the turns run out, the model replies with text and no tool call, and
 * the run ends as a model's would. A script that cannot go on, because an
 * `until` never matched or a capture found nothing, answers every later call
 * with a provider error naming the turn, and says so on stderr.
 *
 * With LING_SCRIPTED_MODEL_TRACE set as well, every request's system prompt
 * and the tools it declares are appended to that file before the script
 * answers it (`traceScriptedModel`), so a check can say what a task was shown.
 *
 * ```json
 * {"version":1,"turns":[
 *   {"toolCalls":[{"name":"watch_next","args":{}}],"until":"the worker asked a question",
 *    "capture":{"question":"\"id\":\"(a:\\d+)\",\"kind\":\"question\""}},
 *   {"toolCalls":[{"name":"advise","args":{"questionId":"q1","content":"Go ahead."}}]},
 *   {"hang":true}
 * ]}
 * ```
 */
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { ScriptedModel, ScriptedReply } from "./harness/index.js";
import type { ToolDeclaration } from "./prompt-digest.js";

export const MODEL_SCRIPT_VERSION = 1;
const MAX_SCRIPT_BYTES = 1024 * 1024;
const MAX_SCRIPT_TURNS = 1_000;
const MAX_CALLS_PER_TURN = 32;
const MAX_CAPTURES_PER_TURN = 16;
/** Repeats an `until` turn is allowed after its first time, unless it says otherwise. */
const DEFAULT_MAX_REPEATS = 100;
const MAX_REPEATS = 10_000;
const CAPTURE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const PLACEHOLDER = /\{\{([A-Za-z][A-Za-z0-9_]{0,63})\}\}/g;
const TURN_KEYS = new Set(["text", "toolCalls", "until", "maxRepeats", "capture", "hang"]);

export interface ScriptedToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ScriptedTurn {
  /** Assistant text, sent with the calls or alone. `{{name}}` is filled in as in args. */
  text?: string;
  /** Called as one assistant message, in order. */
  toolCalls?: ScriptedToolCall[];
  /** Repeat this turn until what the model was next shown matches this regex. */
  until?: string;
  /** How many times `until` may repeat the turn after its first time. Default 100. */
  maxRepeats?: number;
  /**
   * Values for `{{name}}` in later turns, taken once the turn is done: each
   * regex's first group, at its latest match in everything sent so far.
   */
  capture?: Record<string, string>;
  /** This provider call never returns. Nothing else may be set. */
  hang?: true;
}

export interface ModelScript {
  version: typeof MODEL_SCRIPT_VERSION;
  turns: ScriptedTurn[];
}

export class ModelScriptError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModelScriptError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compile(pattern: unknown, where: string): RegExp {
  if (typeof pattern !== "string" || pattern === "") {
    throw new ModelScriptError(`${where} must be a non-empty regular expression.`);
  }
  try {
    return new RegExp(pattern);
  } catch (error) {
    throw new ModelScriptError(`${where} is not a valid regular expression: ${messageOf(error)}`);
  }
}

/** Every `{{name}}` in a JSON value's strings, keys included. */
function placeholders(value: unknown, into: Set<string>): void {
  if (typeof value === "string") {
    for (const match of value.matchAll(PLACEHOLDER)) into.add(match[1]!);
  } else if (Array.isArray(value)) {
    for (const entry of value) placeholders(entry, into);
  } else if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      placeholders(key, into);
      placeholders(entry, into);
    }
  }
}

function substitute(value: unknown, values: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") {
    return value.replace(PLACEHOLDER, (_, name: string) => values.get(name) ?? "");
  }
  if (Array.isArray(value)) return value.map((entry) => substitute(entry, values));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        substitute(key, values) as string,
        substitute(entry, values),
      ]),
    );
  }
  return value;
}

/**
 * Check a script whole before the first call, so a typo fails at startup
 * rather than halfway through a pair: exact keys, compilable patterns, and
 * every `{{name}}` captured by an earlier turn.
 */
export function parseModelScript(value: unknown): ModelScript {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "turns,version") {
    throw new ModelScriptError("A model script is an object with exactly version and turns.");
  }
  if (value["version"] !== MODEL_SCRIPT_VERSION) {
    throw new ModelScriptError(`A model script's version must be ${MODEL_SCRIPT_VERSION}.`);
  }
  const rawTurns = value["turns"];
  if (!Array.isArray(rawTurns) || rawTurns.length === 0 || rawTurns.length > MAX_SCRIPT_TURNS) {
    throw new ModelScriptError(`A model script's turns must be 1 to ${MAX_SCRIPT_TURNS} turns.`);
  }
  const captured = new Set<string>();
  const turns = rawTurns.map((raw, index): ScriptedTurn => {
    const where = `turns[${index}]`;
    if (!isRecord(raw)) throw new ModelScriptError(`${where} must be an object.`);
    const unknown = Object.keys(raw).filter((key) => !TURN_KEYS.has(key));
    if (unknown.length > 0) {
      throw new ModelScriptError(`${where} has unknown key(s): ${unknown.join(", ")}.`);
    }
    if (raw["hang"] !== undefined) {
      if (raw["hang"] !== true || Object.keys(raw).length !== 1) {
        throw new ModelScriptError(`${where}.hang must be true, alone in its turn.`);
      }
      return { hang: true };
    }
    const turn: ScriptedTurn = {};
    const uncaptured = (value: unknown, at: string): void => {
      const used = new Set<string>();
      placeholders(value, used);
      const missing = [...used].filter((name) => !captured.has(name)).map((name) => `{{${name}}}`);
      if (missing.length > 0) {
        throw new ModelScriptError(`${at} uses ${missing.join(", ")}, which no earlier turn captures.`);
      }
    };
    if (raw["text"] !== undefined) {
      if (typeof raw["text"] !== "string" || raw["text"].trim() === "") {
        throw new ModelScriptError(`${where}.text must be non-empty text.`);
      }
      uncaptured(raw["text"], `${where}.text`);
      turn.text = raw["text"];
    }
    if (raw["toolCalls"] !== undefined) {
      const calls = raw["toolCalls"];
      if (!Array.isArray(calls) || calls.length === 0 || calls.length > MAX_CALLS_PER_TURN) {
        throw new ModelScriptError(`${where}.toolCalls must be 1 to ${MAX_CALLS_PER_TURN} calls.`);
      }
      turn.toolCalls = calls.map((call, callIndex) => {
        const at = `${where}.toolCalls[${callIndex}]`;
        if (
          !isRecord(call) ||
          Object.keys(call).sort().join(",") !== "args,name" ||
          typeof call["name"] !== "string" ||
          call["name"].trim() === "" ||
          !isRecord(call["args"])
        ) {
          throw new ModelScriptError(`${at} must be exactly a tool name and an args object.`);
        }
        uncaptured(call["args"], `${at}.args`);
        return { name: call["name"], args: structuredClone(call["args"]) };
      });
    }
    if (turn.text === undefined && turn.toolCalls === undefined) {
      throw new ModelScriptError(`${where} needs text, toolCalls or hang.`);
    }
    if (raw["until"] !== undefined) {
      compile(raw["until"], `${where}.until`);
      if (turn.toolCalls === undefined) {
        throw new ModelScriptError(`${where}.until repeats tool calls, and the turn has none.`);
      }
      turn.until = raw["until"] as string;
    }
    if (raw["maxRepeats"] !== undefined) {
      const repeats = raw["maxRepeats"];
      if (
        turn.until === undefined ||
        typeof repeats !== "number" ||
        !Number.isInteger(repeats) ||
        repeats < 1 ||
        repeats > MAX_REPEATS
      ) {
        throw new ModelScriptError(
          `${where}.maxRepeats must be an integer from 1 to ${MAX_REPEATS}, beside until.`,
        );
      }
      turn.maxRepeats = repeats;
    }
    if (raw["capture"] !== undefined) {
      const capture = raw["capture"];
      const entries = isRecord(capture) ? Object.entries(capture) : [];
      if (entries.length === 0 || entries.length > MAX_CAPTURES_PER_TURN) {
        throw new ModelScriptError(
          `${where}.capture must name 1 to ${MAX_CAPTURES_PER_TURN} values.`,
        );
      }
      turn.capture = {};
      for (const [name, pattern] of entries) {
        const at = `${where}.capture.${name}`;
        if (!CAPTURE_NAME.test(name)) {
          throw new ModelScriptError(`${where}.capture name ${JSON.stringify(name)} is not a plain identifier.`);
        }
        const regex = compile(pattern, at);
        // A pattern's group count, read off a match of the empty alternative.
        if (new RegExp(`${regex.source}|`).exec("")!.length < 2) {
          throw new ModelScriptError(`${at} has no group to take the value from.`);
        }
        turn.capture[name] = pattern as string;
        captured.add(name);
      }
    }
    return turn;
  });
  return { version: MODEL_SCRIPT_VERSION, turns };
}

export async function loadModelScript(file: string): Promise<ModelScript> {
  const refused = (what: string, error?: unknown) =>
    new ModelScriptError(
      `The model script ${file} ${what}${error === undefined ? "" : `: ${messageOf(error)}`}`,
      error === undefined ? undefined : { cause: error },
    );
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    throw refused("cannot be read", error);
  }
  if (Buffer.byteLength(text, "utf8") > MAX_SCRIPT_BYTES) {
    throw refused(`is over ${MAX_SCRIPT_BYTES} bytes.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (error) {
    throw refused("is not JSON", error);
  }
  try {
    return parseModelScript(value);
  } catch (error) {
    throw refused("is invalid", error);
  }
}

function messageText(messages: readonly unknown[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const content = message["content"];
    if (typeof content === "string") {
      parts.push(content);
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (isRecord(part) && part["type"] === "text" && typeof part["text"] === "string") {
          parts.push(part["text"]);
        }
      }
    }
  }
  return parts.join("\n");
}

/** The text of what the model was shown since its last reply: tool results and steered messages. */
export function shownSinceLastReply(messages: readonly unknown[]): string {
  const roles = messages.map((message) => (isRecord(message) ? message["role"] : undefined));
  return messageText(messages.slice(roles.lastIndexOf("assistant") + 1));
}

/** A pattern's first group at its last match in `text`, if it matches at all. */
function lastGroup(pattern: string, text: string): string | undefined {
  let value: string | undefined;
  for (const match of text.matchAll(new RegExp(pattern, "g"))) value = match[1] ?? value;
  return value;
}

/**
 * One line of a scripted model's trace: the system prompt a request carried
 * and its sha256, and the tools it declared and the sha256 of their JSON.
 */
export interface ScriptedModelTraceLine {
  index: number;
  systemPromptSha256: string;
  systemPrompt: string;
  /** The sha256 of `JSON.stringify(tools)`, as the line has it. */
  toolsSha256: string;
  /** Each tool's name, description and parameter schema, in the order declared (`declaredTools`). */
  tools: ToolDeclaration[];
}

/**
 * `model`, appending one JSON line per request to `file` before the script
 * answers it (LING_SCRIPTED_MODEL_TRACE): the request's index, its system
 * prompt and the prompt's sha256, and the tools it declared to the model and
 * their sha256. A check reads it to assert what a task was shown, and to
 * recompute its `promptDigest`, which covers both. The system prompt and the
 * tool declarations are kept, never the messages, so the trace holds no tool
 * arguments and no tool output. Each line is appended whole,
 * synchronously, so the trace is complete for every request that was
 * answered. The file is created if it is missing, and a file that cannot be
 * written refuses here, at startup, rather than at the first request.
 */
export function traceScriptedModel(model: ScriptedModel, file: string): ScriptedModel {
  try {
    appendFileSync(file, "", { mode: 0o600 });
  } catch (error) {
    throw new ModelScriptError(`The scripted model trace ${file} cannot be written: ${messageOf(error)}`, {
      cause: error,
    });
  }
  return (request) => {
    const line: ScriptedModelTraceLine = {
      index: request.index,
      systemPromptSha256: createHash("sha256").update(request.systemPrompt, "utf8").digest("hex"),
      systemPrompt: request.systemPrompt,
      toolsSha256: createHash("sha256").update(JSON.stringify(request.tools), "utf8").digest("hex"),
      tools: request.tools,
    };
    appendFileSync(file, `${JSON.stringify(line)}\n`);
    return model(request);
  };
}

/**
 * The model a script plays. Each call is one provider request; `log` hears
 * why a script stopped, and when a turn hangs.
 */
export function scriptedModelFrom(
  script: ModelScript,
  log: (line: string) => void = (line) => console.error(line),
): ScriptedModel {
  const values = new Map<string, string>();
  let next = 0;
  let current: { index: number; repeats: number } | undefined;
  let stopped: string | undefined;
  const fail = (message: string): ScriptedReply => {
    stopped = `scripted model: ${message}`;
    log(stopped);
    return { error: stopped };
  };
  const reply = (turn: ScriptedTurn): ScriptedReply => ({
    ...(turn.text === undefined ? {} : { text: substitute(turn.text, values) as string }),
    ...(turn.toolCalls === undefined
      ? {}
      : {
          toolCalls: turn.toolCalls.map((call) => ({
            name: call.name,
            args: substitute(call.args, values) as Record<string, unknown>,
          })),
        }),
  });
  return (request) => {
    if (stopped !== undefined) return { error: stopped };
    const shown = shownSinceLastReply(request.messages);
    if (current !== undefined) {
      const turn = script.turns[current.index]!;
      const label = `turn ${current.index + 1} of ${script.turns.length}`;
      if (turn.until !== undefined && !new RegExp(turn.until).test(shown)) {
        if (current.repeats >= (turn.maxRepeats ?? DEFAULT_MAX_REPEATS)) {
          return fail(
            `${label} did not see /${turn.until}/ after ${current.repeats} repeats; the script stops here.`,
          );
        }
        current.repeats += 1;
        return reply(turn);
      }
      const sent = turn.capture === undefined ? "" : messageText(request.messages);
      for (const [name, pattern] of Object.entries(turn.capture ?? {})) {
        const value = lastGroup(pattern, sent);
        if (value === undefined) {
          return fail(`${label} found no ${name} with /${pattern}/; the script stops here.`);
        }
        values.set(name, value);
      }
      current = undefined;
    }
    if (next >= script.turns.length) return { text: "The script has no more turns." };
    const index = next++;
    const turn = script.turns[index]!;
    current = { index, repeats: 0 };
    if (turn.hang === true) {
      log(
        `scripted model: turn ${index + 1} of ${script.turns.length} hangs; this provider call never returns.`,
      );
      return new Promise<ScriptedReply>(() => undefined);
    }
    return reply(turn);
  };
}
