/**
 * The overlord's own copy of a task's event stream.
 *
 * Every other account of what a task did is held by someone else. Ling's log is
 * the service's, and on an unsandboxed host the task runs as the same user as
 * that service. This one is kept by the overlord as the SSE stream arrives: in
 * memory, and appended to `<campaign>/events/<task-id>.jsonl` so that it
 * survives a restart.
 *
 * ## Out of the task's reach only where the task's shell is kept from it
 *
 * The file is an ordinary file of the overlord's user, in a directory no ling
 * mounts or names. Whether a task can edit it depends on where the task's shell
 * runs, not on anything here:
 *
 *   - Ling on another host, or running as another user who cannot write the
 *     campaign directory: out of reach.
 *   - Ling in `SANDBOX_MODE=docker` beside the overlord: the shell is confined
 *     to a container that mounts only the workspace. The in-process file tools
 *     still run on the host, as ling's user, behind a guard that is a check
 *     made before the open, so a shell racing it can still get a write through.
 *   - The default local setup, ling auto-started by the overlord
 *     (`LING_AUTO_START`) with `SANDBOX_MODE=none`: the task's bash runs as the
 *     overlord's own user. It can rewrite this file in place, seqs kept, and
 *     the overlord would go on appending after the rewrite. Read back from
 *     disk, the record is then no better than ling's log, and nothing else
 *     that user owns is either, the overlord's own code included.
 *
 * So the process that kept the record judges it from memory (`assess()`, or
 * `resolveIntentReport({ eventRecord: record })`): what this process received
 * from the stream, whatever has happened to the file since. That is the
 * strongest account the overlord has, but on a shared, unsandboxed host it is
 * not beyond reach either, since the task's user can signal or debug the
 * overlord's process. `readEventRecord` is the restart path, for a process that
 * did not keep the record itself, and it trusts the file. So does whatever
 * `EventRecord.open` loads from the file when it reopens a record after a
 * restart.
 *
 * ## Complete means gapless from 1 to a terminal event
 *
 * Ling numbers a task's events from 1 and the SSE route replays only a bounded
 * tail. So a record is complete only if its sequence numbers run 1, 2, 3, ...
 * with none missing, up to and ending at a terminal event. One that starts above
 * 1 joined after the tail had rolled and lost what came first — possibly the
 * declaration — and one with no terminal event cannot say the task had stopped
 * acting. Both read as incomplete. Nothing here promotes a partial account to a
 * whole one, which is the mistake every consumer of this would otherwise repeat.
 *
 * ## Reconnecting
 *
 * The record is append-only and outlives the process. `resumeSeq` is the last
 * sequence number before the first gap: pass it as `sinceSeq` when the stream is
 * joined again, and the replay refills the gap if ling still retains it, while
 * events already recorded are dropped on append. An event that comes back with
 * different content under a sequence number already held is a conflict, kept on
 * disk beside the original so the record reads as incomplete after a restart too.
 *
 * ## Wiring
 *
 * The driver's tap becomes:
 *
 *     const record = await EventRecord.open(campaignDirectory, task.id);
 *     try {
 *       for await (const event of record.tap(client.events(task.id, workerId, {
 *         signal, sinceSeq: record.resumeSeq,
 *       }))) { ...existing consumers... }
 *     } finally { await record.close(); }
 *
 * and settlement, in the same process, hands over the record itself, which is
 * still usable after `close()`: `resolveIntentReport({ eventRecord: record,
 * ... })` applies the rule above to what is held in memory, conflicts included.
 * Only a process holding no record for the task, such as one judging a task
 * that settled before a restart, passes `await readEventRecord(campaignDirectory,
 * task.id)` instead, with the trust in the file that implies.
 */
import { mkdir, open, readFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { isLingEvent, TERMINAL_EVENT_TYPES } from "../ling/events.js";
import type { LingEvent } from "../ling/types.js";

/** A task id that can name a file: no separators, no leading dot, bounded. */
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function eventRecordPath(campaignDirectory: string, taskId: string): string {
  if (!TASK_ID_PATTERN.test(taskId)) {
    throw new Error(`Task id ${JSON.stringify(taskId)} cannot name an event record.`);
  }
  return path.join(path.resolve(campaignDirectory), "events", `${taskId}.jsonl`);
}

export interface EventSequenceAssessment {
  complete: boolean;
  /** Events assessed. */
  events: number;
  firstSeq: number | undefined;
  lastSeq: number | undefined;
  /** The earliest terminal event's sequence number, if one was seen. */
  terminalSeq: number | undefined;
  /**
   * Why the sequence is not complete, phrased to follow its subject: "The event
   * record begins at sequence 7 rather than 1, ...". Absent when it is complete.
   */
  reason?: string;
}

/**
 * Whether a set of events is a whole account of one task: sequence numbers
 * gapless from 1, each held once, ending at the first terminal event.
 *
 * Pure, and order-insensitive, so the same rule judges the overlord's record,
 * ling's served log and anything a test builds by hand.
 */
export function assessEventSequence(
  events: readonly { seq?: unknown; type: string }[],
): EventSequenceAssessment {
  const seqs: number[] = [];
  let terminalSeq: number | undefined;
  for (const event of events) {
    const seq = event.seq;
    if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) {
      return {
        complete: false,
        events: events.length,
        firstSeq: undefined,
        lastSeq: undefined,
        terminalSeq: undefined,
        reason: "holds an event with no sequence number, so it cannot be checked for gaps",
      };
    }
    seqs.push(seq);
    if (TERMINAL_EVENT_TYPES.has(event.type) && (terminalSeq === undefined || seq < terminalSeq)) {
      terminalSeq = seq;
    }
  }
  const ordered = seqs.sort((left, right) => left - right);
  const base = {
    events: ordered.length,
    firstSeq: ordered[0],
    lastSeq: ordered.at(-1),
    terminalSeq,
  };
  const incomplete = (reason: string): EventSequenceAssessment => ({
    ...base,
    complete: false,
    reason,
  });
  if (ordered.length === 0) return incomplete("holds no events");
  if (base.firstSeq !== 1) {
    return incomplete(
      `begins at sequence ${base.firstSeq} rather than 1, so earlier events, possibly the declaration, were lost`,
    );
  }
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!;
    const current = ordered[index]!;
    if (current === previous) return incomplete(`holds sequence ${current} more than once`);
    if (current !== previous + 1) return incomplete(`is missing sequence ${previous + 1}`);
  }
  if (terminalSeq === undefined) {
    return incomplete("has no terminal event, so the task may still have been acting");
  }
  if (base.lastSeq !== terminalSeq) {
    return incomplete(`continues past its terminal event at sequence ${terminalSeq}`);
  }
  return { ...base, complete: true };
}

/** Events in the order ling assigned them. Stable for equal sequence numbers. */
export function inSequenceOrder<T extends { seq?: unknown }>(events: readonly T[]): T[] {
  const key = (event: T): number =>
    typeof event.seq === "number" ? event.seq : Number.POSITIVE_INFINITY;
  return [...events].sort((left, right) => key(left) - key(right));
}

/** One line per event, keys in a fixed order so a replayed event compares equal. */
function serialize(event: LingEvent): string {
  return JSON.stringify({
    seq: event.seq,
    at: event.at,
    type: event.type,
    ...(event.data === undefined ? {} : { data: event.data }),
  });
}

/**
 * Parse a record file. A line that is not an event is skipped: the only writer
 * is this module, so such a line is the tail of a write a crash interrupted, and
 * the event it held shows as a gap until a reconnect records it again.
 */
function parseRecord(contents: string): LingEvent[] {
  const events: LingEvent[] = [];
  for (const line of contents.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isLingEvent(value)) events.push(value);
    } catch {
      // See above: an interrupted write, not an event.
    }
  }
  return events;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/**
 * Every event in a task's record, duplicates and conflicts included, in sequence
 * order; undefined when no record exists. Judge it with `assessEventSequence`.
 *
 * This is the file as found, which on a host where the task's shell runs as the
 * overlord's user is the file as the task may have left it. A process that kept
 * the record judges its `EventRecord` instead; this is for one that did not.
 */
export async function readEventRecord(
  campaignDirectory: string,
  taskId: string,
): Promise<LingEvent[] | undefined> {
  let contents: string;
  try {
    contents = await readFile(eventRecordPath(campaignDirectory, taskId), "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  return inSequenceOrder(parseRecord(contents));
}

export class EventRecord {
  /** Serialized line per sequence number, as first recorded. */
  private readonly recorded = new Map<number, string>();
  private readonly firstEvents = new Map<number, LingEvent>();
  private readonly conflicts = new Set<number>();
  private writes: Promise<unknown> = Promise.resolve();
  private closed = false;

  private constructor(
    readonly filename: string,
    private readonly handle: FileHandle,
    private needsNewline: boolean,
  ) {}

  /** Open, or reopen after a restart, the record for one task of a campaign. */
  static async open(campaignDirectory: string, taskId: string): Promise<EventRecord> {
    const filename = eventRecordPath(campaignDirectory, taskId);
    await mkdir(path.dirname(filename), { recursive: true });
    let contents = "";
    try {
      contents = await readFile(filename, "utf8");
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const handle = await open(filename, "a", 0o600);
    // A crash can leave the last line unterminated; the next one must not join it.
    const record = new EventRecord(filename, handle, contents !== "" && !contents.endsWith("\n"));
    for (const event of parseRecord(contents)) record.remember(event, serialize(event));
    return record;
  }

  /** The `sinceSeq` to rejoin the stream with: the last sequence number before the first gap. */
  get resumeSeq(): number {
    let seq = 0;
    while (this.recorded.has(seq + 1)) seq += 1;
    return seq;
  }

  /**
   * Record one event. Resolves true when it was new, false when the same event
   * was already held. Appends are serialised, so concurrent callers keep order.
   */
  append(event: LingEvent): Promise<boolean> {
    if (!isLingEvent(event)) {
      return Promise.reject(new TypeError("EventRecord.append needs a sequenced ling event."));
    }
    const result = this.writes.then(async () => {
      if (this.closed) throw new Error(`Event record ${this.filename} is closed.`);
      const line = serialize(event);
      const held = this.recorded.get(event.seq);
      if (held === line) return false;
      // A conflict is written too, so the file carries the evidence after a restart.
      await this.handle.write(`${this.needsNewline ? "\n" : ""}${line}\n`);
      this.needsNewline = false;
      this.remember(event, line);
      if (TERMINAL_EVENT_TYPES.has(event.type)) await this.handle.sync();
      return held === undefined;
    });
    this.writes = result.catch(() => undefined);
    return result;
  }

  /** Pass a stream through unchanged, recording each event before it is handed on. */
  async *tap(events: AsyncIterable<LingEvent>): AsyncGenerator<LingEvent> {
    for await (const event of events) {
      await this.append(event);
      yield event;
    }
  }

  /** Recorded events in sequence order, the first content seen for each. */
  events(): LingEvent[] {
    return inSequenceOrder([...this.firstEvents.values()]);
  }

  /**
   * Whether the record is whole, judged from memory: what this process received,
   * plus what `open` loaded from the file. The file is never read again, so a
   * rewrite of it after `open` does not change the answer.
   */
  assess(): EventSequenceAssessment {
    const assessment = assessEventSequence(this.events());
    if (this.conflicts.size === 0) return assessment;
    const first = Math.min(...this.conflicts);
    return {
      ...assessment,
      complete: false,
      reason: `holds sequence ${first} twice with different content`,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.writes;
    this.closed = true;
    try {
      await this.handle.sync();
    } finally {
      await this.handle.close();
    }
  }

  private remember(event: LingEvent, line: string): void {
    const held = this.recorded.get(event.seq);
    if (held === undefined) {
      this.recorded.set(event.seq, line);
      this.firstEvents.set(event.seq, event);
    } else if (held !== line) {
      this.conflicts.add(event.seq);
    }
  }
}
