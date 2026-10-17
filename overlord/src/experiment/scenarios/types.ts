/**
 * What a scenario is made of, as data: its seed files, byte for byte, and the
 * text rules the scorer applies to what A wrote. Nothing here is computed from
 * a run; the scorer (`../score/`) applies it.
 */

/** A file's bytes from its lines: LF endings and exactly one final LF (protocol §2). */
export function file(...lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

/**
 * A one-sentence co-occurrence rule (protocol §1.4): every term, a regular
 * expression, must match within the same sentence. Case-insensitive.
 */
export interface SentenceRule {
  all: readonly string[];
}

export interface DefectRules {
  /** The planted token, alone or with a flag term: where the normal workflow never prints it. */
  strict: SentenceRule;
  /** A defect-specific term plus a flag term. Surfaced (loose) is strict or this. */
  loose: SentenceRule;
  /** What makes a B→A message reveal the defect, besides the strict marker (L3). */
  reveal: SentenceRule;
}

/** One seed file as the protocol prints it, with the sha256 printed beside it. */
export interface SeedBlock {
  /** The protocol's label set: a scenario name, or a variant that replaces one of its files. */
  set: string;
  path: string;
  content: string;
  sha256: string;
}
