/**
 * The case-study export of one run (protocol §8): A's tool calls, A's
 * messages verbatim, and B's actions and holds, in order, under the
 * instrument commit and, for a pilot run, the pilot label. Every pilot run's
 * timeline is published, so nothing here selects or shortens.
 *
 * A's events are in seq order; B's actions and the holds are placed among them
 * by time, and after A's event at the same instant.
 */
import { parseWorkerOversightEvent } from "../../campaign/oversight.js";
import { pairRecord } from "./exclusion.js";
import type { ScoreJson } from "./index.js";
import { readResult } from "./run.js";
import { PILOT_LABEL } from "./tables.js";
import type { RunRecords } from "./types.js";

interface Entry {
  at: number;
  order: number;
  line: string;
}

/** After A's events at the same instant: B's requests, then holds applied, then holds ended. */
const B_ORDER = Number.MAX_SAFE_INTEGER - 1_000;
const APPLIED_ORDER = Number.MAX_SAFE_INTEGER - 500;
const ENDED_ORDER = Number.MAX_SAFE_INTEGER - 400;

function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/** One of A's events as a line, or undefined for an event the timeline leaves out. */
function eventLine(type: string, data: Record<string, unknown>, raw: unknown): string | undefined {
  const parsed = parseWorkerOversightEvent(type, raw);
  const update = parsed?.ok === true ? parsed.event : undefined;
  if (type === "tool_start") {
    return `A calls ${String(data["tool"])} ${JSON.stringify(data["args"] ?? {})}`;
  }
  if (type === "tool_end") {
    return data["error"] === true ? `A's ${String(data["tool"])} call returned an error` : undefined;
  }
  if (type === "assistant_text") return `A says:\n${quote(String(data["text"] ?? ""))}`;
  if (update?.type === "oversight_note") {
    return `A tells the principal (${update.noteId}):\n${quote(update.content)}`;
  }
  if (update?.type === "oversight_question") {
    return `A asks the overseer (${update.questionId}):\n${quote(update.question)}`;
  }
  if (update?.type === "oversight_gate") {
    return `${update.holdId} ${update.action} A's ${update.tool ?? "calls"}`;
  }
  if (update?.type === "oversight_shown") return `shown to A: ${update.notice} ${update.ref}`;
  if (type.startsWith("task_") && type !== "task_started") {
    return `A's task ended: ${type} ${JSON.stringify(data)}`;
  }
  return undefined;
}

function resultLine(records: RunRecords): string {
  const result = records.finalState?.result;
  if (result === undefined) return "no final-state record";
  if (!result.present) return "no result.json";
  if (result.content === null) return `result.json sha256 ${result.sha256} (content not kept)`;
  const state = readResult(records.finalState).state;
  return `result.json (${state}), verbatim:\n\n\`\`\`\n${result.content}\n\`\`\``;
}

export function timeline(records: RunRecords, score: ScoreJson): string {
  const entries: Entry[] = [];
  const add = (at: string | null, order: number, line: string) =>
    entries.push({ at: at === null ? Number.POSITIVE_INFINITY : Date.parse(at), order, line });
  for (const event of records.events ?? []) {
    const data = (event.data ?? {}) as Record<string, unknown>;
    const line = eventLine(event.type, data, event.data);
    if (line !== undefined) add(event.at, event.seq, `a:${event.seq} ${line}`);
  }
  const pair = pairRecord(records);
  for (const [index, request] of (pair?.requests ?? []).entries()) {
    if (request.from !== "watcher") continue;
    const refused = request.code === null ? "" : ` (refused: ${request.code})`;
    const cites = request.evidence.length === 0 ? "" : ` citing ${request.evidence.join(", ")}`;
    const words = request.text === null ? "" : `:\n${quote(request.text)}`;
    add(request.at, B_ORDER + index, `B ${request.kind} ${request.ref}${cites}${refused}${words}`);
  }
  for (const hold of pair?.holds ?? []) {
    if (hold.appliedAt !== null) {
      add(hold.appliedAt, APPLIED_ORDER, `${hold.holdId} applied (${hold.origin})`);
    }
    if (hold.endedAt !== null) {
      const credit = hold.creditMs ?? 0;
      add(hold.endedAt, ENDED_ORDER, `${hold.holdId} ended: ${hold.endReason ?? "unknown"}, credit ${credit} ms`);
    }
  }
  entries.sort((left, right) => left.at - right.at || left.order - right.order);
  const { run, instrument } = score;
  return [
    ...(score.family === "pilot" ? [PILOT_LABEL, ""] : []),
    `## ${run.runId}: ${run.experiment} ${run.cell}`,
    "",
    `Instrument ${instrument.gitHead}${instrument.clean ? "" : " (dirty tree)"}; ` +
      `arm ${run.arm}, ${run.scenario} ${run.variant}, rep ${run.rep}.`,
    "",
    ...entries.map((entry) => `- ${entry.line.replace(/\n/g, "\n  ")}`),
    "",
    resultLine(records),
  ].join("\n");
}
