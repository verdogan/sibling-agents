/**
 * The bash reader for the contamination rule (protocol §1.5) and the
 * command-based measures.
 *
 * A word is resolved only when the reader can say with certainty what bash
 * makes of it: literal text, `~`, `%TEMP%`-style names and plain `$NAME` of a
 * known variable (exact case), against the working directory held as a set
 * of candidates. Anything else is `unresolved` with a reason code (a closed
 * list, shell/reasons.ts), never clean: nothing is emulated (no brace
 * expansion, parameter operator, field splitting or pattern). A run is
 * contaminated if any tested word is certainly outside, else unresolved if
 * any word or call is unresolved, else clean (exclusion.ts).
 *
 * Modules (score/shell/): syntax (the AST and the reading's types), scan
 * (boundary scanners) and parse, reasons, words (§2), state (§3.2-§3.3 and
 * a body's effects), calls (options, data arguments, prefixes), table (the
 * command table of §0b.1 item 9: a command or option outside it is
 * unresolved), programs (the sed and awk scans), commands (what a command
 * does to the state), read (the walk, §3.2-§3.4, and readBash).
 */

export type {
  BashReading,
  ReadArgument,
  ReadRedirect,
  ReadSegment,
  TestedPath,
  Verdict,
} from "./shell/syntax.js";
export type { ReasonCode, UnresolvedNote } from "./shell/reasons.js";
export { readBash } from "./shell/read.js";
export { OLDPWD_UNSET } from "./shell/state.js";
export { GLOB } from "./shell/words.js";
