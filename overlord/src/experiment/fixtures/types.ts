/**
 * Scorer fixtures (protocol §4 "Scorer fixtures", plan B3): each is a scripted
 * A, a ling scripted-model v1 script, with the arm, scenario and variant it
 * runs in, the exact `result.json` bytes it writes, and the score fields it
 * must produce.
 *
 * The same fixture serves twice. Here (`experiment-score-check`) a synthetic
 * run is built from it (`synthetic.ts`) and scored. In W3-A's
 * `experiment-e2e-check` it runs as a real campaign, and the same fields must
 * come out of the real records.
 */
import type { WatcherScript } from "../../campaign/oversight-scripted.js";
import type { ArmId, ChildPaths, ProbesJson, ScenarioVariant } from "../records.js";

/** The ling's scripted-model v1 format (`ling/src/scripted-model.ts`), as data. */
export interface ScriptedToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ScriptedTurn {
  text?: string;
  toolCalls?: ScriptedToolCall[];
  until?: string;
  maxRepeats?: number;
  capture?: Record<string, string>;
  hang?: true;
}

export interface ModelScript {
  version: 1;
  turns: ScriptedTurn[];
}

export const call = (name: string, args: Record<string, unknown> = {}): ScriptedToolCall => ({
  name,
  args,
});

/** A turn of some calls, with optional narration before them. */
export const turn = (calls: ScriptedToolCall[], text?: string): ScriptedTurn => ({
  ...(text === undefined ? {} : { text }),
  toolCalls: calls,
});

export const say = (text: string): ScriptedTurn => ({ text });

export const script = (...turns: ScriptedTurn[]): ModelScript => ({ version: 1, turns });

/** A value a fixture asserts, at a dotted path into the ScoreJson. */
export type Expected = Record<string, unknown>;

export interface ScorerFixture {
  id: string;
  /** What the scripted A does, in the protocol's words. */
  title: string;
  arm: ArmId;
  variant: ScenarioVariant;
  prompted: boolean;
  script: ModelScript;
  /** The exact result.json bytes the script writes; null when it writes none. */
  resultBytes: string | null;
  /**
   * What each bash command does to the workspace, for the synthetic run: path
   * to new content, or null for a deleted file. A command not listed changes
   * nothing. The real run (W3-A) does it for real.
   */
  shell?: Record<string, Record<string, string | null>>;
  /** Files the synthetic run adds beside the seeds before scoring (the busy workspace). */
  extraFiles?: Record<string, string>;
  /** What the probes report for the synthetic run; W3-A computes them from the final files. */
  probes?: Partial<Omit<ProbesJson, "version">>;
  /** A model B's script, for a model-B arm's synthetic run. */
  watcher?: () => WatcherScript;
  /**
   * For the synthetic run only: B is sent a batch at most once per this many
   * ms of the run's clock, one second per event, as the coordinator spaces
   * batches by `minBatchIntervalMs`; what is new waits for the next. A batch
   * that carries a question is sent at once, as the coordinator sends it, and
   * so is one while a call is parked, since the interval passes while it
   * waits. Unset, B is sent a batch after every call.
   */
  batchIntervalMs?: number;
  /** Child paths other than the default ones. */
  child?: Partial<ChildPaths>;
  expected: Expected;
}
