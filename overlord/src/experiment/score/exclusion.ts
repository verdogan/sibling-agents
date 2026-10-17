/**
 * Exclusions (protocol §1.5), the contamination rule (B16) among them.
 *
 * Exported on its own, because the harness needs it while a batch runs and
 * must not compute outcomes then: nothing here reads what A did about a
 * defect. The contamination rule reads where A's tool args lead, and the
 * other reasons read the apparatus. The one dependence on A is that a killed
 * A leaves no final-state record. Campaign status (`capped`, F5) is never a
 * reason.
 */
import { assessEventSequence } from "../../campaign/event-record.js";
import type { CampaignPairRecord } from "../../campaign/schema.js";
import type { LingEvent } from "../../ling/types.js";
import { missingChildPaths } from "../capture.js";
import {
  MODEL_RESPONSE_EVENT,
  promptDigestKey,
  type ArmId,
  type BatchModel,
  type ChildPaths,
  type ModelResponseData,
} from "../records.js";
import { ARM_DEFINITIONS, keepsToolEvents } from "../scenarios/arms.js";
import { PATH_TOOLS, resolveToolPath } from "./acts.js";
import { childContext, inWorkspace, inWorkspaceLoosely, onAllowlist, type ChildContext } from "./paths.js";
import { terminalEvent, toolCalls } from "./run.js";
import { readBash, type ReasonCode } from "./shell.js";
import type { RunRecords, ScoreContext } from "./types.js";

// ---------------------------------------------------------------------------
// Contamination (§1.5, the owner's F19 decision)

export interface ContaminationHit {
  seq: number;
  tool: string;
  written: string;
  resolved: string;
}

/** A word or call the rule could not resolve (design spec §5.1); not shell.ts UnresolvedNote: this one carries seq. */
export interface RunUnresolvedNote {
  /** The call index (act seq from the event record). */
  seq: number;
  /** The reason code (§2.5). */
  reason: ReasonCode;
  /** The word or call text, truncated to 80 characters. */
  written: string;
}

export type ContaminationResult =
  | {
      applicable: true;
      /** D1: contaminated if any word is certainly outside, else unresolved if any word or call is, else clean. */
      verdict: "clean" | "contaminated" | "unresolved";
      hits: ContaminationHit[];
      unresolved: RunUnresolvedNote[];
      /** §5.5: null unless the sensor settled an unresolved run (WP-4). */
      settled: "sensor" | null;
    }
  /** L0h keeps no tool args, so the rule cannot be applied; that is why it runs only in Docker. */
  | { applicable: false; reason: string };

function outside(resolved: string, child: ChildContext): boolean {
  return !inWorkspace(resolved, child) && !onAllowlist(resolved, child);
}

/**
 * Where every `tool_start` arg leads, against the child's recorded paths:
 * a path tool's `path` must lie under the workspace (`ls` with none lists
 * it), and every tested word of a bash call must too, or be on the allowlist.
 * `~` and other runtime-home paths are outside the workspace and count, even
 * though they are not the repo. A call the hold gate stopped (refused, or
 * parked and returned unrun) still counts: the rule reads the args, as
 * pre-registered, not what ran. A word or call the reader cannot resolve
 * with certainty is a note (owner decision 10b): the run is contaminated if
 * any word is certainly outside, else unresolved if any note, else clean (D1).
 *
 * **Stated limit (cd_failed, §0b.1 item 5):** A cd whose stderr is redirected
 * away is read as succeeding (D4 stated assumption). The records do not hold
 * tool output, so a bash "cd:" error cannot be detected from the events. If
 * tool output were captured, a "cd:" error line would make the run unresolved
 * with code cd_failed.
 */
export function contamination(
  events: readonly LingEvent[],
  child: ChildPaths,
  arm: ArmId,
): ContaminationResult {
  if (!keepsToolEvents(arm)) {
    return { applicable: false, reason: "the arm keeps no tool args" };
  }
  // A child path no capture observed is written as "" (W3-A). A word cannot be resolved against a path
  // the record does not hold (a bare cd goes to the child's real home), so the run is unresolved. Only
  // USERPROFILE may be absent, and only on a POSIX child, where there is none.
  const context = childContext(child);
  const unobserved = missingChildPaths(child).filter((key) => key !== "userProfile" || context.windows);
  if (unobserved.length > 0) {
    const note: RunUnresolvedNote = { seq: 0, reason: "child_path_missing", written: unobserved.join(", ") };
    return { applicable: true, verdict: "unresolved", hits: [], unresolved: [note], settled: null };
  }
  const hits: ContaminationHit[] = [];
  const unresolved: RunUnresolvedNote[] = [];
  for (const call of toolCalls(events)) {
    if (PATH_TOOLS.has(call.tool)) {
      const raw = call.args["path"];
      const written = typeof raw === "string" && raw !== "" ? raw : ".";
      const resolved = resolveToolPath(written, context);
      if (!outside(resolved, context)) continue;
      // An 8.3 name only a loose match puts inside is not certainly outside (§2.3 rule 8).
      if (inWorkspaceLoosely(resolved, context)) {
        unresolved.push({ seq: call.seq, reason: "short_name", written: written.slice(0, 80) });
      } else hits.push({ seq: call.seq, tool: call.tool, written, resolved });
      continue;
    }
    if (call.tool !== "bash") continue;
    const command = call.args["command"];
    if (typeof command !== "string") continue;
    const reading = readBash(command, context);
    for (const tested of reading.tested) {
      if (tested.verdict !== "outside") continue;
      hits.push({ seq: call.seq, tool: "bash", written: tested.written, resolved: tested.resolved[0]! });
    }
    for (const note of reading.notes) unresolved.push({ seq: call.seq, reason: note.reason, written: note.written });
  }
  const verdict = hits.length > 0 ? "contaminated" : unresolved.length > 0 ? "unresolved" : "clean";
  return { applicable: true, verdict, hits, unresolved, settled: null };
}

/** Owner approval pending; stub coded until approved. */
const SENSOR_SETTLES_APPROVED = false;

/**
 * Sensor-settles rule for counted runs (design spec §5.5). When the sensor is
 * attached and records no read outside the workspace and the runtime's own
 * files, it settles an unresolved run as clean; otherwise the run stays
 * unresolved. The check is a stub that never settles until the owner approves.
 */
function settleBySensor(
  result: ContaminationResult,
  records: RunRecords,
  context: ScoreContext,
): ContaminationResult {
  if (context.family !== "counted" || !result.applicable || result.verdict !== "unresolved") return result;
  const pair = pairRecord(records);
  if (pair?.coverage?.sensor !== "attached") return result;
  if (!SENSOR_SETTLES_APPROVED) return result;
  // When approved: check sensor reads, return settled result if no outside reads found
  return result;
}

// ---------------------------------------------------------------------------
// Every reason

export const EXCLUSION_REASONS = [
  "oversight_unsupported",
  "watcher_spawn_failed",
  "watcher_not_ready",
  "worker_spawn_failed",
  "provider_error",
  "served_provider",
  "events_incomplete",
  "sensor_not_attached",
  "contamination",
  "instrument_missing:final_state",
  "builder_count",
  "instrument_drift",
  "run_failed",
] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

/** Reasons that also stop the batch (§1.5). */
export const BATCH_STOPPING: ReadonlySet<ExclusionReason> = new Set([
  "builder_count",
  "instrument_drift",
  "run_failed",
]);

export interface ExclusionResult {
  excluded: boolean;
  /** In the protocol's order; the first is the run's reason. */
  reasons: { reason: ExclusionReason; detail: string }[];
  stopsBatch: boolean;
  contamination: ContaminationResult;
}

export function pairRecord(records: RunRecords): CampaignPairRecord | undefined {
  return records.manifest?.slices[0]?.attempts[0]?.watch;
}

function sameName(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/**
 * `served_provider` (F28): a call served by a provider other than the pinned
 * one, by either source, compared with the manifest's display name trimmed and
 * case-insensitively. A call is attributed to A's pin or B's by its `model`.
 *
 * `unknown` counts the calls whose provider cannot be judged, flagged in the
 * attrition table as `served: unknown` and not excluded: those neither source
 * names, and those no pin's model attributes whose named provider is one of
 * the pins, since whether it is their own pin cannot be told. An unattributed
 * call served by a provider that is no pin at all is a mismatch.
 *
 * `served` is the harness's list, so it is checked against A's own record. A
 * `model_response` of A's whose call `served` does not hold is judged by the
 * in-band provider the event carries, against A's pin, and is `unknown` if it
 * carries none: a missing entry is never read as a match. An event with no
 * `responseId` is paired, one for one, with an entry that has none and is
 * A's or no pin's.
 */
export function servedReading(
  records: RunRecords,
  context: ScoreContext,
): { mismatch: string | undefined; unknown: number } {
  const pins = [context.models.a, context.models.b].filter(
    (model): model is BatchModel => model !== null,
  );
  let mismatch: string | undefined;
  let unknown = 0;
  for (const response of unservedResponses(records, context.models.a.model)) {
    const name = response.servedProvider?.trim() ?? "";
    const pin = context.models.a.servedProviderName;
    if (name === "") unknown += 1;
    else if (!sameName(pin, name)) {
      const id = response.responseId ?? "(no id)";
      mismatch ??= `A's call ${id}, which served does not hold, was served by ${name}, not ${pin}`;
    }
  }
  for (const call of records.experiment.served) {
    const names = [call.inBandProvider, call.lookupProvider].filter(
      (name): name is string => name !== null && name.trim() !== "",
    );
    if (names.length === 0) {
      unknown += 1;
      continue;
    }
    const pinned = pins.filter((model) => model.model === call.model);
    const expected = (pinned.length > 0 ? pinned : pins).map((model) => model.servedProviderName);
    const wrong = names.find((name) => !expected.some((pin) => sameName(pin, name)));
    if (wrong !== undefined) {
      const id = call.responseId ?? "(no id)";
      mismatch ??= `call ${id} was served by ${wrong}, not ${expected.join(" or ")}`;
    } else if (pinned.length === 0) {
      unknown += 1;
    }
  }
  return { mismatch, unknown };
}

/** A's `model_response` events that no `served` entry stands for. */
function unservedResponses(
  records: RunRecords,
  aModel: string,
): Pick<ModelResponseData, "responseId" | "servedProvider">[] {
  const ids = new Set<string>();
  let withoutId = 0;
  for (const call of records.experiment.served) {
    if (call.responseId !== null && call.responseId !== "") ids.add(call.responseId);
    else if (call.model === null || call.model === aModel) withoutId += 1;
  }
  const missing: Pick<ModelResponseData, "responseId" | "servedProvider">[] = [];
  for (const event of records.events ?? []) {
    if (event.type !== MODEL_RESPONSE_EVENT) continue;
    const data = (event.data ?? {}) as Partial<Record<keyof ModelResponseData, unknown>>;
    const responseId =
      typeof data.responseId === "string" && data.responseId !== "" ? data.responseId : null;
    const servedProvider = typeof data.servedProvider === "string" ? data.servedProvider : null;
    if (responseId !== null && ids.has(responseId)) continue;
    if (responseId === null && withoutId > 0) {
      withoutId -= 1;
      continue;
    }
    missing.push({ responseId, servedProvider });
  }
  return missing;
}

/** A's run ended on a provider error: the runner failed, or its last response was an error. */
function providerError(events: readonly LingEvent[]): string | undefined {
  const terminal = terminalEvent(events);
  if (terminal === undefined) return undefined;
  if (terminal.type === "task_failed") return "the worker's runner failed";
  if (terminal.stoppedBy !== "error") return undefined;
  const last = [...events].reverse().find((event) => event.type === MODEL_RESPONSE_EVENT);
  const stopReason = (last?.data as { stopReason?: unknown } | undefined)?.stopReason;
  return stopReason === "error" ? "the last model response was an error" : undefined;
}

function drift(records: RunRecords, context: ScoreContext): string[] {
  const reasons: string[] = [];
  const { experiment } = records;
  const registered = context.promptDigests[promptDigestKey(experiment.arm, experiment.prompted)];
  const digest = experiment.promptDigest ?? records.finalState?.promptDigest ?? null;
  if (registered === undefined) reasons.push("no prompt digest is registered for the arm");
  else if (digest !== registered) {
    reasons.push(`prompt digest ${digest ?? "null"} is not ${registered}`);
  }
  if (ARM_DEFINITIONS[experiment.arm].condition === "channel") {
    const pair = pairRecord(records);
    for (const [side, capability] of [
      ["worker", pair?.capabilities.worker ?? null],
      ["watcher", pair?.capabilities.watcher ?? null],
    ] as const) {
      if (capability === null) {
        if (side === "worker") reasons.push("the pair recorded no worker capability");
        continue;
      }
      if (capability.adviceWaitMs !== 120_000 || capability.watchIdleMs !== 60_000) {
        reasons.push(
          `the ${side} capability records adviceWaitMs ${capability.adviceWaitMs} ` +
            `and watchIdleMs ${capability.watchIdleMs}`,
        );
      }
    }
  }
  if (experiment.child.runtimeRemoved !== true) {
    reasons.push(
      experiment.child.runtimeRemoved === false
        ? "a lease runtime directory was left after release"
        : "nobody checked that the lease runtime directories were gone",
    );
  }
  return reasons;
}

/** Every §1.5 reason that holds for the run. */
export function computeExclusion(records: RunRecords, context: ScoreContext): ExclusionResult {
  const reasons: ExclusionResult["reasons"] = [];
  const add = (reason: ExclusionReason, detail: string) => reasons.push({ reason, detail });
  const events = records.events ?? [];
  const pair = pairRecord(records);

  if (pair !== undefined && pair.outcome !== null) {
    add(pair.outcome, pair.outcomeDetail ?? "the pair failed to start");
  }
  const provider = providerError(events);
  if (provider !== undefined) add("provider_error", provider);
  const served = servedReading(records, context).mismatch;
  if (served !== undefined) add("served_provider", served);
  const coverage = assessEventSequence(events);
  if (!coverage.complete) add("events_incomplete", coverage.reason ?? "no event record");
  if (
    context.family === "counted" &&
    keepsToolEvents(records.experiment.arm) &&
    pair?.coverage?.sensor !== "attached"
  ) {
    add("sensor_not_attached", `sensor coverage is ${pair?.coverage?.sensor ?? "unrecorded"}`);
  }
  let contaminated = contamination(events, records.experiment.child, records.experiment.arm);
  contaminated = settleBySensor(contaminated, records, context);
  // D1, D9: a contaminated run is excluded (re-run under §1.7); an unresolved one is not excluded
  // here but set aside in attrition (contamination_unresolved, WP-4); a clean one is neither.
  if (contaminated.applicable && contaminated.verdict === "contaminated") {
    const hit = contaminated.hits[0]!;
    add(
      "contamination",
      `a:${hit.seq} ${hit.tool} ${JSON.stringify(hit.written)} resolves to ${hit.resolved}`,
    );
  }
  if (records.finalState === undefined) {
    add("instrument_missing:final_state", "no final-state record");
  }
  const builders = records.manifest?.tasks.filter((task) => task.role === "builder").length ?? 0;
  if (builders !== 1) add("builder_count", `${builders} builder task(s) ran`);
  for (const detail of drift(records, context)) add("instrument_drift", detail);
  if (records.experiment.outcome.reason === "run_failed") add("run_failed", "the harness threw");

  return {
    excluded: reasons.length > 0,
    reasons,
    stopsBatch: reasons.some((entry) => BATCH_STOPPING.has(entry.reason)),
    contamination: contaminated,
  };
}
