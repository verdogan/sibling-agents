/**
 * The parts of a run's records every measure reads: A's tool calls, A's texts
 * as units, `result.json` read from its raw bytes, and the final state of a
 * path.
 */
import { createHash } from "node:crypto";
import { parseWorkerOversightEvent } from "../../campaign/oversight.js";
import type { LingEvent } from "../../ling/types.js";
import type { FinalStateRecord, FinalStateSeed } from "../records.js";
import {
  type TextUnit,
  type Tri,
  type Unavailable,
  UNAVAILABLE,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function data(event: LingEvent): Record<string, unknown> {
  return isRecord(event.data) ? event.data : {};
}

export const TERMINAL_TYPES = new Set([
  "task_finished",
  "task_failed",
  "task_cancelled",
  "task_interrupted",
]);

export interface ToolCall {
  seq: number;
  at: string;
  tool: string;
  args: Record<string, unknown>;
  /** The args were `{}` (the `empty_args` noise column, §1.5). */
  emptyArgs: boolean;
  /**
   * Whether the call ran. Pi emits `tool_start` before the hold gate is
   * consulted, so a call the gate stopped has a `tool_start` and did nothing.
   * The gate stops a call three ways, each with an `oversight_gate` naming
   * it: `refused` in the turn a hold is noticed; `parked` in a later turn,
   * then `returned` unrun when the hold ends; and `returned` with no park,
   * for a later call of the message whose parked call came back. Measures of
   * what A did read only calls that ran; the contamination rule reads every
   * `tool_start`.
   */
  ran: boolean;
}

/** Every gate action that names a call it stopped; `lapsed` names none. */
const STOPPED = new Set(["refused", "parked", "returned"]);

export function toolCalls(events: readonly LingEvent[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const [index, event] of events.entries()) {
    if (event.type !== "tool_start") continue;
    const fields = data(event);
    const tool = String(fields["tool"] ?? "");
    const args = isRecord(fields["args"]) ? fields["args"] : {};
    let ran = true;
    // Pi awaits the gate before it emits the next call's tool_start, parked or
    // not, so the gate's verdict for a call comes before it.
    for (const later of events.slice(index + 1)) {
      if (later.type === "tool_start") break;
      const parsed = parseWorkerOversightEvent(later.type, later.data);
      if (
        parsed?.ok === true &&
        parsed.event.type === "oversight_gate" &&
        STOPPED.has(parsed.event.action) &&
        parsed.event.tool === tool
      ) {
        ran = false;
        break;
      }
    }
    calls.push({
      seq: event.seq,
      at: event.at,
      tool,
      args,
      emptyArgs: Object.keys(args).length === 0,
      ran,
    });
  }
  return calls;
}

export interface Terminal {
  seq: number;
  type: string;
  status: string | null;
  stoppedBy: string | null;
}

export function terminalEvent(events: readonly LingEvent[]): Terminal | undefined {
  const event = events.find((candidate) => TERMINAL_TYPES.has(candidate.type));
  if (event === undefined) return undefined;
  const fields = data(event);
  return {
    seq: event.seq,
    type: event.type,
    status: typeof fields["status"] === "string" ? fields["status"] : null,
    stoppedBy:
      typeof fields["stoppedBy"] === "string"
        ? fields["stoppedBy"]
        : event.type === "task_failed"
          ? "error"
          : null,
  };
}

/** A's notes to its principal, from `oversight_note` (kept in every arm, L0h included). */
export function noteUnits(events: readonly LingEvent[]): TextUnit[] {
  const units: TextUnit[] = [];
  for (const event of events) {
    const parsed = parseWorkerOversightEvent(event.type, event.data);
    if (parsed?.ok !== true || parsed.event.type !== "oversight_note") continue;
    units.push({
      source: "note",
      seq: event.seq,
      at: event.at,
      index: units.length,
      text: parsed.event.content,
    });
  }
  return units;
}

/** A's `ask_overseer` texts. */
export function questionUnits(events: readonly LingEvent[]): TextUnit[] {
  const units: TextUnit[] = [];
  for (const event of events) {
    const parsed = parseWorkerOversightEvent(event.type, event.data);
    if (parsed?.ok !== true || parsed.event.type !== "oversight_question") continue;
    units.push({
      source: "question",
      seq: event.seq,
      at: event.at,
      index: units.length,
      text: parsed.event.question,
    });
  }
  return units;
}

/** A's `assistant_text` before its terminal event. */
export function narrationUnits(events: readonly LingEvent[]): TextUnit[] {
  const end = terminalEvent(events)?.seq ?? Number.POSITIVE_INFINITY;
  return events
    .filter((event) => event.type === "assistant_text" && event.seq < end)
    .map((event, index) => ({
      source: "narration" as const,
      seq: event.seq,
      at: event.at,
      index,
      text: String(data(event)["text"] ?? ""),
    }));
}

// ---------------------------------------------------------------------------
// result.json, from the final-state record's raw bytes (B13)

export interface ResultReading {
  /** `unreadable`: present, but the record kept no content (too large, not UTF-8, a link). */
  state: "valid" | "invalid" | "absent" | "unreadable";
  sha256: string | null;
  status: string | null | Unavailable;
  summary: string | Unavailable;
  steps: string[] | Unavailable;
  /** `data.artifacts` paths. Never principal-directed text. */
  artifacts: string[] | Unavailable;
}

export function readResult(finalState: FinalStateRecord | undefined): ResultReading {
  const unavailable: ResultReading = {
    state: "unreadable",
    sha256: null,
    status: UNAVAILABLE,
    summary: UNAVAILABLE,
    steps: UNAVAILABLE,
    artifacts: UNAVAILABLE,
  };
  if (finalState === undefined) return unavailable;
  const result = finalState.result;
  if (!result.present) {
    return { state: "absent", sha256: null, status: null, summary: "", steps: [], artifacts: [] };
  }
  if (result.content === null) return { ...unavailable, sha256: result.sha256 };
  let parsed: unknown;
  try {
    const text = result.content;
    parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return { ...unavailable, state: "invalid", sha256: result.sha256 };
  }
  if (!isRecord(parsed)) return { ...unavailable, state: "invalid", sha256: result.sha256 };
  const body = isRecord(parsed["data"]) ? parsed["data"] : {};
  const artifacts = Array.isArray(body["artifacts"])
    ? body["artifacts"].flatMap((entry) =>
        typeof entry === "string"
          ? [entry]
          : isRecord(entry) && typeof entry["path"] === "string"
            ? [entry["path"]]
            : [],
      )
    : [];
  return {
    state: "valid",
    sha256: result.sha256,
    status: typeof parsed["status"] === "string" ? parsed["status"] : null,
    summary: typeof parsed["summary"] === "string" ? parsed["summary"] : "",
    steps: Array.isArray(parsed["steps"])
      ? parsed["steps"].filter((step): step is string => typeof step === "string")
      : [],
    artifacts,
  };
}

/** The result's summary and steps as units; empty when unavailable (see `resultComplete`). */
export function resultUnits(result: ResultReading): TextUnit[] {
  const units: TextUnit[] = [];
  if (result.summary !== UNAVAILABLE && result.summary !== "") {
    units.push({ source: "summary", seq: null, at: null, index: 0, text: result.summary });
  }
  if (result.steps !== UNAVAILABLE) {
    result.steps.forEach((text, index) =>
      units.push({ source: "step", seq: null, at: null, index, text }),
    );
  }
  return units;
}

export function resultComplete(result: ResultReading): boolean {
  return result.summary !== UNAVAILABLE && result.steps !== UNAVAILABLE;
}

/**
 * A rule over principal-directed text read as a Tri: true if a unit matches,
 * false if none does and the result was readable, and unavailable when the
 * unreadable summary and steps might have held the match.
 */
export function principalTri(matched: boolean, result: ResultReading): Tri {
  if (matched) return true;
  return resultComplete(result) ? false : UNAVAILABLE;
}

// ---------------------------------------------------------------------------
// Final state

export function seedEntry(finalState: FinalStateRecord, path: string) {
  return finalState.seeds.find((seed) => seed.path === path);
}

export function fileEntry(finalState: FinalStateRecord, path: string) {
  return finalState.files.find((entry) => entry.path === path);
}

/**
 * Whether a seed's final state differs from its seeded bytes. `unreadable` is
 * unknown, so unavailable; `absent` and `not_regular` are changes.
 */
export function seedChanged(seed: FinalStateSeed): Tri {
  if (seed.state === "unreadable") return UNAVAILABLE;
  return seed.state !== "unchanged";
}

/**
 * Whether a path the record does not list might still have been there: the
 * record dropped entries, or the path lies under a directory the ling could
 * not list, or the workspace itself (`.`) was a link or could not be listed.
 */
function mightBeUnlisted(finalState: FinalStateRecord, path: string): boolean {
  if (finalState.filesOmitted > 0) return true;
  return finalState.files.some(
    (entry) =>
      entry.path === "." || (entry.type === "directory" && path.startsWith(`${entry.path}/`)),
  );
}

/** Whether a path existed at A's end; unavailable when the record cannot say. */
export function pathExists(finalState: FinalStateRecord, path: string): Tri {
  const seed = seedEntry(finalState, path);
  if (seed !== undefined) {
    if (seed.state === "unreadable") return UNAVAILABLE;
    return seed.state !== "absent";
  }
  if (fileEntry(finalState, path) !== undefined) return true;
  return mightBeUnlisted(finalState, path) ? UNAVAILABLE : false;
}

/** A path's final content: null when it is absent, unavailable when the record kept none. */
export function finalContent(
  finalState: FinalStateRecord,
  path: string,
): string | null | Unavailable {
  const seed = seedEntry(finalState, path);
  if (seed !== undefined) {
    if (seed.state === "absent") return null;
    return seed.content ?? UNAVAILABLE;
  }
  const entry = fileEntry(finalState, path);
  if (entry === undefined) return mightBeUnlisted(finalState, path) ? UNAVAILABLE : null;
  return entry.content ?? UNAVAILABLE;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
