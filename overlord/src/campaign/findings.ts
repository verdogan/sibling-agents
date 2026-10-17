/**
 * Scoring for evidence-bound findings.
 *
 * A research task's output is unfalsifiable by every check this repository had
 * before this module: the file exists, the JSON parses, the schema matches, and
 * a fabricated lead passes all three. What closes the hole is that each finding
 * carries the verbatim text its claim rests on, so a second task can fetch the
 * locator again and report what is actually there now.
 *
 * The comparison is deliberately made here rather than by the verifying task.
 * A verifier that returned a pass/fail boolean could simply lie, or be talked
 * into lying by the page it was reading; a verifier that must return the text it
 * observed has to fabricate content that happens to contain the excerpt, which
 * is a far higher bar. So the verifier reports observations and this code reaches
 * the verdict.
 */

/**
 * Mirrors ling's `findingsFeature` and `verificationFeature`. The two packages
 * build in isolation, so the overlord cannot import these; the drift check in
 * `findings-check.ts` reads the ling source and pins every one against it.
 */
export const FINDINGS_FILE = "findings.json";
export const RECORD_FINDING_TOOL_NAME = "record_finding";
export const VERIFICATION_FILE = "verification.json";
export const VERIFY_FINDING_TOOL_NAME = "verify_finding";
/** What the verifier is told about a finding it must re-check. */
export const VERIFICATION_REQUEST_FILE = "campaign/verification-request.json";

export type FindingSourceKind = "url" | "message" | "call" | "document";
export type FindingConfidence = "asserted" | "inferred";

/** Source kinds whose locator another agent can independently resolve again. */
const RECHECKABLE_SOURCE_KINDS: readonly FindingSourceKind[] = ["url"];

/**
 * Normalized excerpt length below which a match proves nothing. A two-character
 * excerpt occurs in every document. Set low enough to admit genuinely short but
 * distinctive evidence such as a phone number, which is exactly the kind of
 * excerpt that matters most for lead findings.
 */
export const MIN_VERIFIABLE_EXCERPT_CHARS = 8;

/**
 * How far a verifier's clock may run behind the producer's before an observation
 * that claims to predate the finding it checks is treated as fabricated. Tasks
 * run on separate machines, so some skew is ordinary and a hard ordering rule
 * would fail honest reports.
 */
export const MAX_CLOCK_SKEW_MS = 5 * 60_000;

export interface FindingSource {
  kind: FindingSourceKind;
  locator: string;
  retrievedAt: string;
  excerpt: string;
}

export interface Finding {
  id: string;
  claim: string;
  confidence: FindingConfidence;
  source: FindingSource;
  fields: Record<string, string>;
  note?: string;
  recordedAt?: string;
}

/**
 * One verifier observation. `observedText` is what the verifier says it found at
 * the locator, not a judgement about whether the finding holds.
 */
export interface FindingVerification {
  findingId: string;
  locatorFetched: boolean;
  observedText?: string;
  checkedAt: string;
  evidence: string;
}

export type FindingOutcome =
  /** Locator fetched and the excerpt is still present in what came back. */
  | "confirmed"
  /** Locator fetched and the excerpt is not there. The fabrication signal. */
  | "refuted"
  /** Locator could not be fetched. Link rot and invention look identical here. */
  | "unreachable"
  /** Excerpt too short for a match to mean anything. */
  | "unverifiable"
  /** Source kind nobody can re-fetch, such as a phone call. */
  | "attested"
  /** No verifier looked at it. */
  | "unchecked";

export interface ScoredFinding {
  id: string;
  outcome: FindingOutcome;
  confidence: FindingConfidence;
  detail: string;
}

export interface FindingScore {
  findings: ScoredFinding[];
  counts: Record<FindingOutcome, number>;
  /**
   * confirmed / (confirmed + refuted).
   *
   * The denominator deliberately excludes unreachable, unchecked, unverifiable
   * and attested findings. Including unreachable would make ordinary link rot
   * indistinguishable from fabrication and punish a task for the web changing;
   * including unchecked would make the rate a function of how big a sample the
   * verifier took rather than of how honest the research was. Undefined when
   * nothing was conclusively checked, because zero out of zero is not a score.
   */
  survivalRate: number | undefined;
  /**
   * Conclusively checked, over everything that could have been checked. A
   * survival rate is meaningless without it: 100% on one finding out of two
   * hundred says nothing at all.
   */
  coverage: number;
  recheckable: number;
  total: number;
}

export class FindingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FindingsError";
  }
}

function fail(location: string, message: string): never {
  throw new FindingsError(`${location}: ${message}`);
}

function object(value: unknown, location: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(location, "must be an object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  location: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) fail(location, `unknown field(s): ${unknown.join(", ")}`);
}

function string(value: unknown, location: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(location, "must be a non-empty string");
  return value;
}

function timestamp(value: unknown, location: string): string {
  const parsed = string(value, location);
  if (Number.isNaN(Date.parse(parsed))) fail(location, "must be an ISO-8601 timestamp");
  return parsed;
}

function literal<T extends string>(value: unknown, allowed: readonly T[], location: string): T {
  const parsed = string(value, location);
  if (!(allowed as readonly string[]).includes(parsed)) {
    fail(location, `must be one of ${allowed.join(", ")}`);
  }
  return parsed as T;
}

function stringMap(value: unknown, location: string): Record<string, string> {
  const raw = object(value, location);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(raw)) {
    if (typeof item !== "string") fail(`${location}.${key}`, "must be a string");
    result[key] = item;
  }
  return result;
}

/**
 * Collapse everything that changes between two renderings of the same text
 * without changing its meaning: Unicode form, case, and whitespace runs. Both
 * sides go through this function, so a character always maps the same way on
 * each and locale-specific casing cannot make a match asymmetric.
 */
export function normalizeForMatch(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

export function parseFindingsDocument(value: unknown, location = "findings"): Finding[] {
  const raw = object(value, location);
  exactKeys(raw, ["findings"], location);
  const list = raw["findings"];
  if (!Array.isArray(list)) fail(`${location}.findings`, "must be an array");

  const seen = new Set<string>();
  return list.map((item, index) => {
    const at = `${location}.findings[${index}]`;
    const entry = object(item, at);
    exactKeys(entry, ["id", "claim", "confidence", "source", "fields", "note", "recordedAt"], at);

    const id = string(entry["id"], `${at}.id`);
    if (seen.has(id)) fail(`${at}.id`, `duplicates an earlier finding: ${id}`);
    seen.add(id);

    const sourceAt = `${at}.source`;
    const source = object(entry["source"], sourceAt);
    exactKeys(source, ["kind", "locator", "retrievedAt", "excerpt"], sourceAt);

    const finding: Finding = {
      id,
      claim: string(entry["claim"], `${at}.claim`),
      confidence: literal(entry["confidence"], ["asserted", "inferred"] as const, `${at}.confidence`),
      source: {
        kind: literal(
          source["kind"],
          ["url", "message", "call", "document"] as const,
          `${sourceAt}.kind`,
        ),
        locator: string(source["locator"], `${sourceAt}.locator`),
        retrievedAt: timestamp(source["retrievedAt"], `${sourceAt}.retrievedAt`),
        excerpt: string(source["excerpt"], `${sourceAt}.excerpt`),
      },
      fields: stringMap(entry["fields"], `${at}.fields`),
    };
    if (entry["note"] !== undefined) finding.note = string(entry["note"], `${at}.note`);
    if (entry["recordedAt"] !== undefined) {
      finding.recordedAt = timestamp(entry["recordedAt"], `${at}.recordedAt`);
    }
    return finding;
  });
}

export function parseVerificationDocument(
  value: unknown,
  location = "verification",
): FindingVerification[] {
  const raw = object(value, location);
  exactKeys(raw, ["verifications"], location);
  const list = raw["verifications"];
  if (!Array.isArray(list)) fail(`${location}.verifications`, "must be an array");

  const seen = new Set<string>();
  return list.map((item, index) => {
    const at = `${location}.verifications[${index}]`;
    const entry = object(item, at);
    exactKeys(entry, ["findingId", "locatorFetched", "observedText", "checkedAt", "evidence"], at);

    const findingId = string(entry["findingId"], `${at}.findingId`);
    // Two observations of one finding is a contract violation, and resolving it
    // silently would hide exactly the disagreement worth seeing.
    if (seen.has(findingId)) {
      fail(`${at}.findingId`, `already verified in this report: ${findingId}`);
    }
    seen.add(findingId);

    const locatorFetched = entry["locatorFetched"];
    if (typeof locatorFetched !== "boolean") fail(`${at}.locatorFetched`, "must be a boolean");

    const verification: FindingVerification = {
      findingId,
      locatorFetched,
      checkedAt: timestamp(entry["checkedAt"], `${at}.checkedAt`),
      evidence: string(entry["evidence"], `${at}.evidence`),
    };
    if (entry["observedText"] !== undefined) {
      verification.observedText = string(entry["observedText"], `${at}.observedText`);
    }
    return verification;
  });
}

export function isRecheckable(finding: Finding): boolean {
  return RECHECKABLE_SOURCE_KINDS.includes(finding.source.kind);
}

/**
 * Reach a verdict on every finding.
 *
 * Verifications for findings that do not exist are an error rather than noise:
 * a report about an unknown id means the verifier and the producer disagree
 * about what was researched, and continuing would score the wrong set.
 */
export function scoreFindings(
  findings: readonly Finding[],
  verifications: readonly FindingVerification[],
): FindingScore {
  const byId = new Map(findings.map((finding) => [finding.id, finding]));
  const unknown = verifications.filter((entry) => !byId.has(entry.findingId));
  if (unknown.length > 0) {
    fail(
      "verification",
      `report covers finding id(s) absent from findings.json: ${unknown
        .map((entry) => entry.findingId)
        .join(", ")}`,
    );
  }

  const observations = new Map(verifications.map((entry) => [entry.findingId, entry]));
  const counts: Record<FindingOutcome, number> = {
    confirmed: 0,
    refuted: 0,
    unreachable: 0,
    unverifiable: 0,
    attested: 0,
    unchecked: 0,
  };

  const scored = findings.map((finding): ScoredFinding => {
    const { outcome, detail } = scoreOne(finding, observations.get(finding.id));
    counts[outcome] += 1;
    return { id: finding.id, outcome, confidence: finding.confidence, detail };
  });

  const conclusive = counts.confirmed + counts.refuted;
  const recheckable = findings.filter(isRecheckable).length;

  return {
    findings: scored,
    counts,
    survivalRate: conclusive === 0 ? undefined : counts.confirmed / conclusive,
    coverage: recheckable === 0 ? 0 : conclusive / recheckable,
    recheckable,
    total: findings.length,
  };
}

/** Ids a verifier is being asked to re-fetch, and the seed that chose them. */
export interface FindingsSample {
  ids: string[];
  /** How many findings could have been sampled at all. */
  candidates: number;
  seed: string;
}

export interface FindingsSampleOptions {
  /**
   * Recorded in the manifest at selection time, so the choice replays exactly
   * after a restart. It does not need to be secret from the verifier — only from
   * the producer, which has already exited by the time this runs.
   */
  seed: string;
  minimum?: number;
  fraction?: number;
}

export const DEFAULT_SAMPLE_MINIMUM = 3;
export const DEFAULT_SAMPLE_FRACTION = 0.25;

/** FNV-1a, for turning the recorded seed string into PRNG state. */
function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** mulberry32. Deterministic by design: `Math.random` would not replay. */
function nextRandom(state: number): { value: number; state: number } {
  const next = (state + 0x6d2b79f5) >>> 0;
  let mixed = Math.imul(next ^ (next >>> 15), 1 | next);
  mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
  return { value: ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296, state: next };
}

/**
 * Choose which findings get re-fetched.
 *
 * A verifier that always checks the first three findings only teaches the fleet
 * to fabricate the fourth, so the choice is randomised from a seed recorded at
 * selection time — unpredictable to the producer, which has already finished,
 * and exactly replayable for the audit trail.
 *
 * Candidates are sorted before the shuffle so the result is a function of the
 * seed and the id set alone. Shuffling them in written order would leave the
 * producer one lever it fully controls: what to record first.
 *
 * Findings nothing can re-fetch, and findings whose excerpt is too short for a
 * match to prove anything, are excluded rather than sampled and written off.
 * Spending a verifier's fetch on an outcome that is already determined buys
 * nothing.
 */
export function selectVerificationSample(
  findings: readonly Finding[],
  options: FindingsSampleOptions,
): FindingsSample {
  const seed = string(options.seed, "sample.seed");
  const fraction = options.fraction ?? DEFAULT_SAMPLE_FRACTION;
  const minimum = options.minimum ?? DEFAULT_SAMPLE_MINIMUM;
  if (!(fraction > 0) || fraction > 1) fail("sample.fraction", "must be within (0, 1]");
  if (!Number.isInteger(minimum) || minimum < 1) {
    fail("sample.minimum", "must be a positive integer");
  }

  const candidates = findings
    .filter(
      (finding) =>
        isRecheckable(finding) &&
        normalizeForMatch(finding.source.excerpt).length >= MIN_VERIFIABLE_EXCERPT_CHARS,
    )
    .map((finding) => finding.id)
    .sort();

  let state = hashSeed(seed);
  for (let index = candidates.length - 1; index > 0; index -= 1) {
    const drawn = nextRandom(state);
    state = drawn.state;
    const swap = Math.floor(drawn.value * (index + 1));
    const here = candidates[index];
    const there = candidates[swap];
    if (here === undefined || there === undefined) continue;
    candidates[index] = there;
    candidates[swap] = here;
  }

  const size = Math.min(
    candidates.length,
    Math.max(minimum, Math.ceil(fraction * candidates.length)),
  );
  return { ids: candidates.slice(0, size).sort(), candidates: candidates.length, seed };
}

export interface FindingsGate {
  /** Below this, the checked evidence is treated as fabricated rather than stale. */
  minSurvivalRate: number;
  /** Share of the requested sample the verifier may silently not report on. */
  maxSkippedFraction: number;
  /** Share of the requested sample that may be unfetchable before the check is void. */
  maxUnreachableFraction: number;
  /** Share of the whole set that may rest on sources nobody can ever re-fetch. */
  maxAttestedFraction: number;
}

/**
 * Starting values, meant to be overridden per campaign.
 *
 * `minSurvivalRate` is not 1 because excerpt matching has honest false
 * negatives: pages rendered client-side, paginated results, a fetch truncated
 * before the quoted line. One refuted finding in five is tolerable; one in three
 * is not a rendering problem.
 *
 * `maxSkippedFraction` is 0 because the verifier is handed the exact list, and
 * "I did not get to it" is a report it can always make instead of silence.
 *
 * `maxAttestedFraction` exists because without it the whole gate has a trivial
 * bypass: record every finding as a phone call and nothing is ever checkable.
 */
export const DEFAULT_FINDINGS_GATE: FindingsGate = {
  minSurvivalRate: 0.8,
  maxSkippedFraction: 0,
  maxUnreachableFraction: 0.5,
  maxAttestedFraction: 0.5,
};

export type FindingsGateOutcome =
  /** The evidence held up. */
  | "pass"
  /** Evidence against the producer. More checking will not rescue it. */
  | "fail"
  /** The check itself did not happen properly. Says nothing about the producer. */
  | "inconclusive"
  /** There was nothing to gate. */
  | "inapplicable";

export interface FindingsJudgement {
  outcome: FindingsGateOutcome;
  /** Every rule that tripped, not just the first, because this becomes the audit record. */
  reasons: string[];
  requested: number;
  skipped: string[];
  unreachable: string[];
  refuted: string[];
  survivalRate: number | undefined;
}

/**
 * Turn a score into a verdict.
 *
 * The distinction the outcomes carry is the point of the function: a slice whose
 * findings were refuted is a slice that made things up, while a slice whose
 * verifier never reported is a slice nobody checked. Collapsing the two would
 * either let fabrication through on a botched verification or punish a producer
 * for a verifier's failure, and the driver needs to do different things about
 * them.
 */
export function judgeFindings(
  score: FindingScore,
  sample: FindingsSample,
  gate: FindingsGate = DEFAULT_FINDINGS_GATE,
): FindingsJudgement {
  const outcomes = new Map(score.findings.map((finding) => [finding.id, finding.outcome]));
  const unknown = sample.ids.filter((id) => !outcomes.has(id));
  if (unknown.length > 0) {
    fail("gate", `sampled id(s) absent from the scored set: ${unknown.join(", ")}`);
  }

  const requestedWith = (outcome: FindingOutcome): string[] =>
    sample.ids.filter((id) => outcomes.get(id) === outcome);
  const skipped = requestedWith("unchecked");
  const unreachable = requestedWith("unreachable");
  const refuted = requestedWith("refuted");
  const requested = sample.ids.length;

  const failures: string[] = [];
  const voids: string[] = [];

  if (score.total === 0) {
    // Recording nothing is an honest outcome the tool prompt explicitly allows,
    // so it must not be gradeable as failure.
    return {
      outcome: "inapplicable",
      reasons: ["no findings were recorded"],
      requested,
      skipped,
      unreachable,
      refuted,
      survivalRate: score.survivalRate,
    };
  }

  const attestedFraction = score.counts.attested / score.total;
  if (attestedFraction > gate.maxAttestedFraction) {
    failures.push(
      `${score.counts.attested} of ${score.total} findings rest on sources nobody can re-fetch ` +
        `(${(attestedFraction * 100).toFixed(0)}%, limit ${(gate.maxAttestedFraction * 100).toFixed(0)}%)`,
    );
  }

  if (requested === 0) {
    failures.push(
      `nothing in this set could be checked: ${score.counts.attested} attested, ` +
        `${score.counts.unverifiable} with an excerpt too short to match`,
    );
  } else {
    if (skipped.length / requested > gate.maxSkippedFraction) {
      voids.push(
        `the verifier reported nothing for ${skipped.length} of ${requested} sampled findings: ${skipped.join(", ")}`,
      );
    }
    if (unreachable.length / requested > gate.maxUnreachableFraction) {
      voids.push(
        `${unreachable.length} of ${requested} sampled locators could not be fetched, ` +
          "so the sample says nothing either way",
      );
    }
  }

  if (score.survivalRate !== undefined && score.survivalRate < gate.minSurvivalRate) {
    failures.push(
      `survival rate ${(score.survivalRate * 100).toFixed(0)}% is below the ` +
        `${(gate.minSurvivalRate * 100).toFixed(0)}% floor; refuted: ${refuted.join(", ")}`,
    );
  }

  // Evidence of fabrication outranks a botched verification. If what did get
  // checked already fell through the floor, re-verifying cannot raise it.
  const outcome: FindingsGateOutcome =
    failures.length > 0 ? "fail" : voids.length > 0 ? "inconclusive" : "pass";
  const reasons = [...failures, ...voids];
  return {
    outcome,
    reasons: reasons.length > 0 ? reasons : ["every sampled excerpt was still present at its locator"],
    requested,
    skipped,
    unreachable,
    refuted,
    survivalRate: score.survivalRate,
  };
}

function scoreOne(
  finding: Finding,
  observation: FindingVerification | undefined,
): { outcome: FindingOutcome; detail: string } {
  if (!isRecheckable(finding)) {
    return {
      outcome: "attested",
      detail: `source kind "${finding.source.kind}" cannot be fetched again by another agent`,
    };
  }

  const excerpt = normalizeForMatch(finding.source.excerpt);
  if (excerpt.length < MIN_VERIFIABLE_EXCERPT_CHARS) {
    return {
      outcome: "unverifiable",
      detail: `excerpt normalizes to ${excerpt.length} characters; ${MIN_VERIFIABLE_EXCERPT_CHARS} are needed for a match to mean anything`,
    };
  }

  if (observation === undefined) return { outcome: "unchecked", detail: "no verifier observation" };

  // An observation made before the finding existed was not made at all.
  const skewMs = Date.parse(finding.source.retrievedAt) - Date.parse(observation.checkedAt);
  if (skewMs > MAX_CLOCK_SKEW_MS) {
    return {
      outcome: "refuted",
      detail: `observation is dated ${Math.round(skewMs / 1000)}s before the source was retrieved`,
    };
  }

  if (!observation.locatorFetched) {
    return {
      outcome: "unreachable",
      detail: `locator could not be fetched: ${observation.evidence}`,
    };
  }

  if (observation.observedText === undefined) {
    return {
      outcome: "refuted",
      detail: "verifier fetched the locator but reported no text to compare",
    };
  }

  return normalizeForMatch(observation.observedText).includes(excerpt)
    ? { outcome: "confirmed", detail: "excerpt present in the text observed at the locator" }
    : { outcome: "refuted", detail: "excerpt absent from the text observed at the locator" };
}
