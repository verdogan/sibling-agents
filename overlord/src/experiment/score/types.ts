/**
 * What the scorer reads and the vocabulary it answers in.
 *
 * The scorer is pure: the same records always give the same score, and no
 * model judges anything. A field that needs content the records do not hold
 * is `unavailable`, never false (protocol §1.4, F31).
 */
import type { FeedBody } from "../../campaign/oversight.js";
import type { CampaignManifest } from "../../campaign/schema.js";
import type { LingEvent } from "../../ling/types.js";
import type {
  BatchManifest,
  ExperimentJson,
  FinalStateRecord,
  ProbesJson,
} from "../records.js";

export const UNAVAILABLE = "unavailable";
export type Unavailable = typeof UNAVAILABLE;
/** A boolean the records may not be able to settle. */
export type Tri = boolean | Unavailable;

/** Everything a run directory holds that the scorer reads. */
export interface RunRecords {
  experiment: ExperimentJson;
  /** The campaign manifest, with A's pair record on its one attempt. */
  manifest: CampaignManifest | undefined;
  /** A's EventRecord, in seq order; undefined when there is none. */
  events: readonly LingEvent[] | undefined;
  /** Undefined when the run has no record: `instrument_missing:final_state`. */
  finalState: FinalStateRecord | undefined;
  probes: ProbesJson | undefined;
  /** The feed batches B pulled, for `reveal_from_narration`; undefined when unread. */
  feedBodies?: readonly FeedBody[];
}

/** What the scorer needs from the registered batch: the family and the pins. */
export type ScoreContext = Pick<BatchManifest, "family" | "models" | "promptDigests">;

export type UnitSource = "note" | "summary" | "step" | "question" | "narration";

/** One text of A's, as the rules read it. */
export interface TextUnit {
  source: UnitSource;
  /** A's event seq; null for the text of result.json, which has none. */
  seq: number | null;
  at: string | null;
  /** The step's index, or the note's number among notes; 0 otherwise. */
  index: number;
  text: string;
}

export function triAnd(...values: Tri[]): Tri {
  if (values.includes(false)) return false;
  return values.includes(UNAVAILABLE) ? UNAVAILABLE : true;
}

export function triOr(...values: Tri[]): Tri {
  if (values.includes(true)) return true;
  return values.includes(UNAVAILABLE) ? UNAVAILABLE : false;
}

export function triNot(value: Tri): Tri {
  return value === UNAVAILABLE ? UNAVAILABLE : !value;
}
