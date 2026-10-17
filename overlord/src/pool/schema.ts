import {
  collapseToSingleLine,
  contentAddress,
  hasControlCharacters,
  normalizeKey,
} from "../text.js";

/**
 * Version 2 case-folds the topic, which changes every fact id, so a version 1 file
 * cannot be read as though it were this one: its ids were computed the old way, and
 * mixing the two silently reintroduces the duplicates folding exists to prevent.
 * `KnowledgePool` writes this into `PRAGMA user_version` and checks it on open.
 */
export const POOL_VERSION = 2 as const;

/**
 * Caps on what one fact may be. They are small on purpose: the pool is read into
 * a prompt on every loop iteration, so a fact that cannot be stated briefly is a
 * document, and documents belong in the artifact store with a fact pointing at them.
 */
export const MAX_TOPIC_CHARS = 120;
export const MAX_CLAIM_CHARS = 2_000;
export const MAX_LOCATOR_CHARS = 2_048;

/**
 * How much a fact is worth when the overlord plans against it.
 *
 * `claimed` is what a worker said. `verified` is what survived a campaign that
 * closed with its evidence re-checked. The gap between them is the whole reason
 * this store exists, and it cannot be reconstructed after the fact — which is why
 * nothing may write `verified` directly. See `KnowledgePool.promoteFromCampaign`.
 */
export type FactProvenance = "claimed" | "verified";

export const FACT_PROVENANCES: readonly FactProvenance[] = ["claimed", "verified"];

/** One occasion on which some worker asserted a fact. */
export interface FactSource {
  campaignId: string;
  /**
   * The slice whose accepted attempt carried the claim, or null when the
   * overlord recorded it itself. Null can never be promoted: promotion is
   * evidence a slice passed its gate, and there is no slice to have passed one.
   */
  sliceId: string | null;
  /** Where the claim can be re-checked, when the recorder had somewhere to point. */
  locator: string | null;
  recordedAt: string;
}

export interface KnowledgeFact {
  /** Content address over topic and claim, so the same assertion is one row. */
  id: string;
  topic: string;
  claim: string;
  provenance: FactProvenance;
  /** Every occasion the fact was asserted, oldest first. */
  sources: FactSource[];
  /** When it first entered the pool. */
  recordedAt: string;
  /** When a closed campaign promoted it, or null while it is still hearsay. */
  verifiedAt: string | null;
}

export class PoolSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PoolSchemaError";
  }
}

function fail(location: string, message: string): never {
  throw new PoolSchemaError(`${location}: ${message}`);
}

/**
 * Reduce text to the form the pool stores and hashes. `collapseToSingleLine` carries
 * the rules and the reasons for them; this adds only the pool's blank and length
 * checks.
 */
export function normalizeFactText(value: unknown, location: string, maxChars: number): string {
  if (typeof value !== "string") fail(location, "must be a string");
  const collapsed = collapseToSingleLine(value);
  if (collapsed === "") fail(location, "must not be blank");
  if (collapsed.length > maxChars) {
    fail(location, `must be at most ${maxChars} characters, got ${collapsed.length}`);
  }
  return collapsed;
}

/**
 * A locator is kept verbatim apart from trimming, because it is meant to be
 * fetched again and collapsing whitespace inside a URL changes where it points.
 *
 * Which is also why a control character is refused here rather than stripped: a
 * locator is an address, and silently rewriting an address gives back something
 * that points somewhere else while looking correct.
 */
export function normalizeFactLocator(value: unknown, location: string): string {
  if (typeof value !== "string") fail(location, "must be a string");
  if (hasControlCharacters(value)) fail(location, "must not contain control characters");
  const trimmed = value.trim();
  if (trimmed === "") fail(location, "must not be blank when supplied");
  if (trimmed.length > MAX_LOCATOR_CHARS) {
    fail(location, `must be at most ${MAX_LOCATOR_CHARS} characters, got ${trimmed.length}`);
  }
  if (/[\r\n]/u.test(trimmed)) fail(location, "must not span lines");
  return trimmed;
}

/**
 * A topic is a label someone has to name again to find anything, so it is stored
 * folded rather than as typed. A pool that keeps `Antalya` and `antalya` apart holds
 * the same knowledge twice, counts neither as corroborating the other, and answers a
 * query for one by hiding the other — which is the worst of the three, because it
 * looks like an answer.
 *
 * Claims are prose and keep their case; only the label is a key.
 */
export function normalizeFactTopic(value: unknown, location = "topic"): string {
  if (typeof value !== "string") fail(location, "must be a string");
  const folded = normalizeKey(value);
  if (folded === "") fail(location, "must not be blank");
  if (folded.length > MAX_TOPIC_CHARS) {
    fail(location, `must be at most ${MAX_TOPIC_CHARS} characters, got ${folded.length}`);
  }
  return folded;
}

/**
 * The fact's identity is its content, so recording the same claim from a second
 * source adds provenance rather than a duplicate row. Topic is part of the address
 * because the same sentence can be a different fact about a different subject.
 *
 * Both parts are normalized here as well as by the caller, so the function cannot be
 * called wrongly: an id computed from a raw topic would not match the row stored
 * under the folded one. Normalizing twice is idempotent and costs nothing.
 *
 * `contentAddress` joins the two with a NUL and explains why a space would let one
 * fact wear another's identity.
 */
export function factId(topic: string, claim: string): string {
  return contentAddress([normalizeKey(topic), collapseToSingleLine(claim)]);
}

export function parseFactProvenance(value: unknown, location: string): FactProvenance {
  if (typeof value !== "string" || !FACT_PROVENANCES.includes(value as FactProvenance)) {
    fail(location, `must be one of ${FACT_PROVENANCES.join(", ")}`);
  }
  return value as FactProvenance;
}
