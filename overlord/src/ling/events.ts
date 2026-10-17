import type { LingEvent, LingLogEvent, LingTaskStatus } from "./types.js";

export const TERMINAL_EVENT_TYPES = new Set([
  "task_finished",
  "task_failed",
  "task_cancelled",
  "task_interrupted",
]);

export function isTerminalEvent(event: LingEvent): boolean {
  return TERMINAL_EVENT_TYPES.has(event.type);
}

export function isTerminalStatus(status: LingTaskStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}

export class LingProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LingProtocolError";
  }
}

export function isLingLogEvent(value: unknown): value is LingLogEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return typeof event["at"] === "string" && typeof event["type"] === "string";
}

export function isLingEvent(value: unknown): value is LingEvent {
  if (!isLingLogEvent(value)) return false;
  const seq = (value as LingEvent).seq;
  return typeof seq === "number" && Number.isInteger(seq) && seq > 0;
}

/** Stable identity for comparing SSE and disk events. `at` is not used: ling stamps the two streams separately. */
export function eventFingerprint(event: Pick<LingLogEvent, "type" | "data">): string {
  return `${event.type}:${JSON.stringify(event.data ?? null)}`;
}

/** Parse ling's on-disk JSONL. Lines without `seq` are valid; malformed trailing lines are skipped. */
export function parseJsonlLog(contents: string): LingLogEvent[] {
  const events: LingLogEvent[] = [];
  for (const line of contents.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      const value: unknown = JSON.parse(line);
      if (!isLingLogEvent(value)) continue;
      const event: LingLogEvent = { at: value.at, type: value.type };
      if (value.data !== undefined) event.data = value.data;
      events.push(event);
    } catch {
      // The file can be read while the runner is still appending the last line.
    }
  }
  return events;
}

export interface ParseSseOptions {
  seenSeqs?: Set<number>;
  sinceSeq?: number;
}

interface SseFrame {
  id?: string;
  event?: string;
  data: string[];
}

function decodeFrame(frame: SseFrame): LingEvent | undefined {
  if (frame.data.length === 0) return undefined;

  let value: unknown;
  try {
    value = JSON.parse(frame.data.join("\n"));
  } catch (error) {
    throw new LingProtocolError(
      `Ling SSE data was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!isLingEvent(value)) {
    throw new LingProtocolError("Ling SSE data did not match the LingEvent wire shape.");
  }
  if (frame.id !== undefined && frame.id !== String(value.seq)) {
    throw new LingProtocolError(`Ling SSE id ${frame.id} disagreed with data seq ${value.seq}.`);
  }
  if (frame.event !== undefined && frame.event !== value.type) {
    throw new LingProtocolError(
      `Ling SSE event ${frame.event} disagreed with data type ${value.type}.`,
    );
  }
  return value;
}

/**
 * Parse ling's SSE framing. Reuse seenSeqs across calls to dedupe a reconnect.
 * The generator stops as soon as a terminal event is delivered.
 */
export async function* parseSseEvents(
  chunks: AsyncIterable<string | Uint8Array>,
  options: ParseSseOptions = {},
): AsyncGenerator<LingEvent> {
  const decoder = new TextDecoder();
  const seen = options.seenSeqs ?? new Set<number>();
  const sinceSeq = options.sinceSeq ?? 0;
  let buffer = "";
  let frame: SseFrame = { data: [] };

  const consumeLine = (line: string): LingEvent | undefined => {
    if (line === "") {
      const event = decodeFrame(frame);
      frame = { data: [] };
      return event;
    }
    if (line.startsWith(":")) return undefined;

    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "id") frame.id = value;
    if (field === "event") frame.event = value;
    if (field === "data") frame.data.push(value);
    return undefined;
  };

  const shouldYield = (event: LingEvent): boolean => {
    if (event.seq <= sinceSeq || seen.has(event.seq)) return false;
    seen.add(event.seq);
    return true;
  };

  for await (const chunk of chunks) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const rawLine = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const event = consumeLine(rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine);
      if (event !== undefined && shouldYield(event)) {
        yield event;
        if (isTerminalEvent(event)) return;
      }
      newline = buffer.indexOf("\n");
    }
  }

  buffer += decoder.decode();
  if (buffer !== "") {
    const event = consumeLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
    if (event !== undefined && shouldYield(event)) {
      yield event;
      if (isTerminalEvent(event)) return;
    }
  }

  const finalEvent = decodeFrame(frame);
  if (finalEvent !== undefined && shouldYield(finalEvent)) {
    yield finalEvent;
  }
}
