/**
 * The attrition table (protocol §1.5), per run and per arm, pre-registered. A
 * difference between arms here is a result about the apparatus, read before
 * any outcome.
 *
 * Kept and flagged, never excluded: `max_turns`, `timeout` and `max_cost`
 * stops; runs with no `result.json` or an invalid one; L3 runs that lost B;
 * holds that expired or never fired; `served: unknown` calls; paths the
 * final-state record dropped or could not read; and fields that are
 * `unavailable`.
 */
import { OVERSIGHT_LIMITS } from "../../campaign/oversight.js";
import type { ScenarioId } from "../records.js";
import { ARM_DEFINITIONS, keepsToolEvents } from "../scenarios/arms.js";
import { earlyResult, readActs, resultSteps } from "./acts.js";
import type { CrmScore } from "./crm.js";
import { pairRecord, servedReading, type ExclusionResult } from "./exclusion.js";
import { childContext } from "./paths.js";
import { readResult, terminalEvent, toolCalls, type ResultReading } from "./run.js";
import { UNAVAILABLE, type RunRecords, type ScoreContext, type Unavailable } from "./types.js";

export interface AttritionRow {
  stoppedBy: string | null;
  status: string | null | Unavailable;
  result: ResultReading["state"];
  bLost: boolean | null;
  holdExpired: boolean | null;
  notTriggered: boolean | null;
  notTriggeredCap: boolean | null;
  preempted: boolean | null;
  /** Regular batches used against the cap of 56 (E3, E6). */
  regularBatches: number | null;
  atBatchCap: boolean | null;
  /**
   * Calls whose provider cannot be judged: neither the in-band chunk nor the
   * lookup named one, no pin's model attributes the call to A or B, or A's
   * `model_response` has no entry in `served` and names no provider in-band.
   */
  servedUnknown: number;
  /** Filled in once the whole score is known. */
  unavailableFields: number;
  /** Files the scenario reads whose content the record dropped for its budget. */
  budgetOmitted: string[];
  /** Paths the ling could not read: `unreadable` seeds and files, and unlisted directories. */
  unreadable: string[];
  filesOmitted: number;
  /** A-model noise, descriptive only, unavailable in L0h. */
  emptyArgs: number | Unavailable;
  earlyResult: boolean | Unavailable;
  /**
   * Unresolved runs (design spec D9): not excluded, not re-run, set aside from
   * every primary measure. Each entry is formatted as `<reason>: <written>` or
   * `<reason> (×N)` for N notes with the same reason. Read from the settled
   * verdict computeExclusion gives (§5.3), and empty for a run another reason
   * excludes, so the list is exactly the runs the sensitivity rows restore.
   */
  contamination_unresolved: string[];
}

/** The files a scenario's probes and measures read: the seeds, and all of src/ and test/. */
function scenarioReads(scenario: ScenarioId, path: string, seeded: boolean): boolean {
  if (seeded || path.startsWith("src/") || path.startsWith("test/")) return true;
  return scenario === "crm-import" && path === "CHANGES.md";
}

export function attritionRow(
  records: RunRecords,
  crm: CrmScore | undefined,
  context: ScoreContext,
  exclusion: ExclusionResult,
): AttritionRow {
  const events = records.events ?? [];
  const arm = ARM_DEFINITIONS[records.experiment.arm];
  const keeps = keepsToolEvents(arm.id);
  const calls = toolCalls(events);
  const child = childContext(records.experiment.child);
  const pair = pairRecord(records);
  const result = readResult(records.finalState);
  const crmChannel = arm.scenario === "crm-import" && arm.condition === "channel";
  const final = records.finalState;
  const settled = exclusion.contamination;
  const unresolvedNotes: string[] = [];
  if (!exclusion.excluded && settled.applicable && settled.verdict === "unresolved") {
    const byReason = new Map<string, string[]>();
    for (const note of settled.unresolved) byReason.set(note.reason, [...(byReason.get(note.reason) ?? []), note.written]);
    for (const [reason, written] of byReason) {
      unresolvedNotes.push(written.length === 1 ? `${reason}: ${written[0]}` : `${reason} (×${written.length})`);
    }
  }
  const budgetOmitted =
    final === undefined
      ? []
      : [
          ...final.seeds.map((seed) => ({ ...seed, seeded: true })),
          ...final.files.map((file) => ({ ...file, seeded: false })),
        ]
          .filter(
            (entry) =>
              entry.contentOmitted === "budget" &&
              scenarioReads(records.experiment.scenario, entry.path, entry.seeded),
          )
          .map((entry) => entry.path);
  return {
    stoppedBy: terminalEvent(events)?.stoppedBy ?? null,
    status: result.status,
    result: result.state,
    bLost: arm.b === "model" ? pair?.state === "lost" : null,
    holdExpired: crm?.role === "intervened" ? crm.holdExpired : null,
    notTriggered: crm?.role === "intervened" ? crm.notTriggered : null,
    notTriggeredCap: crm?.role === "intervened" ? crm.notTriggeredCap : null,
    preempted: crm === undefined ? null : crm.preempted,
    regularBatches: crmChannel ? (pair?.feed.regular ?? null) : null,
    atBatchCap: crmChannel
      ? (pair?.feed.regular ?? 0) >= OVERSIGHT_LIMITS.maxRegularBatches
      : null,
    servedUnknown: servedReading(records, context).unknown,
    unavailableFields: 0,
    budgetOmitted,
    unreadable:
      final === undefined
        ? []
        : [
            ...final.seeds.filter((seed) => seed.state === "unreadable"),
            ...final.files.filter((file) => file.contentOmitted === "unreadable"),
          ].map((entry) => entry.path),
    filesOmitted: final?.filesOmitted ?? 0,
    emptyArgs: keeps ? calls.filter((call) => call.emptyArgs).length : UNAVAILABLE,
    earlyResult: keeps ? earlyResult(resultSteps(readActs(calls, child), child)) : UNAVAILABLE,
    contamination_unresolved: unresolvedNotes,
  };
}

/** Every `unavailable` leaf of a score, by path, for the attrition column. */
export function unavailablePaths(value: unknown, prefix = ""): string[] {
  if (value === UNAVAILABLE) return [prefix];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => unavailablePaths(entry, `${prefix}[${index}]`));
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, entry]) =>
      unavailablePaths(entry, prefix === "" ? key : `${prefix}.${key}`),
    );
  }
  return [];
}
