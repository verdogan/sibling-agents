// The syntax the bash reader parses, and the reading it gives the measures (design spec §3.1, §4a).
import type { ReasonCode, UnresolvedNote } from "./reasons.js";

export type Quote = "none" | "single" | "double";

export type Part =
  | { kind: "lit"; text: string; quote: Quote }
  | VarPart
  /** `$( … )` and backquotes (`command`), `<( … )` and `>( … )` (`process`). */
  | { kind: "sub"; list: List; quote: Quote; form: "command" | "process" }
  /** `$(( … ))` and `$[ … ]`: the expression, its own expansions parsed. */
  | { kind: "arith"; inner: Word; text: string; quote: Quote }
  /** `$'…'` and `$"…"`: a form the reader does not read; its expansions are still parsed. */
  | { kind: "opaque"; form: ReasonCode; text: string; inner: Part[]; quote: Quote }
  /** `NAME=( … )`: an array's words. */
  | { kind: "array"; words: Word[] };

/**
 * `$NAME` or `${…}`. Only the boundary and "a plain name or not" are read:
 * `op` is null for `$NAME`/`${NAME}`, else the text after the name (or the
 * leading `#`/`!`), and `inner` holds the operands, parsed so that a
 * substitution in them is still read.
 */
export interface VarPart {
  kind: "var";
  /** The parameter: a NAME, digits, or one of `@*#?$!-`; "" when the body names none. */
  name: string;
  op: string | null;
  inner: Word | null;
  /** `${NAME=…}` or `${NAME:=…}`: assigns NAME wherever it is expanded. */
  assigns: boolean;
  /** The expansion as written. */
  text: string;
  quote: Quote;
}

export interface Word {
  parts: Part[];
}

export interface Redirection {
  op: string;
  /** The descriptor written before the operator, if any (`2>`). */
  fd: string;
  /** Null when the operator duplicates a descriptor and names no path. */
  target: Word | null;
  /** `quoted`: the delimiter had a quote or escape, so bash expands nothing in the body. */
  heredoc: { delimiter: string; strip: boolean; body: string; quoted: boolean } | null;
}

export type Command =
  | { kind: "simple"; words: Word[]; redirections: Redirection[] }
  | { kind: "subshell"; list: List; redirections: Redirection[] }
  | { kind: "group"; list: List; redirections: Redirection[] }
  | { kind: "if"; clauses: { cond: List; body: List }[]; otherwise: List | null; redirections: Redirection[] }
  | { kind: "case"; subject: Word; arms: CaseArm[]; redirections: Redirection[] }
  | {
      kind: "loop";
      keyword: "for" | "select" | "while" | "until";
      /** The variable of `for`/`select`; null for `while`/`until` and C-style `for`. */
      name: string | null;
      /** The list of `for NAME in …`; null when absent (the positional parameters). */
      words: Word[] | null;
      /** `while`/`until`'s condition. */
      cond: List | null;
      /** C-style `for (( … ))`: its expressions. */
      arith: Word | null;
      body: List;
      redirections: Redirection[];
    }
  | { kind: "funcdef"; name: string; body: Command; redirections: Redirection[] }
  /** `(( … ))`. */
  | { kind: "arith"; inner: Word; redirections: Redirection[] };

export interface CaseArm {
  patterns: Word[];
  body: List;
  terminator: ";;" | ";&" | ";;&";
}

export interface Pipeline {
  commands: Command[];
  negated: boolean;
}

export interface ListItem {
  pipeline: Pipeline;
  /** What ended the pipeline: `;`, `&`, `&&`, `||`, a newline, or nothing. */
  separator: string;
}

export type List = ListItem[];

/** A word's text with quotes removed and nothing expanded, as the protocol says it is "written". */
export function literalText(word: Word): string {
  return word.parts.map(partText).join("");
}

function partText(part: Part): string {
  switch (part.kind) {
    case "lit":
      return part.text;
    case "var":
    case "arith":
    case "opaque":
      return part.text;
    case "sub":
      return part.form === "process" ? "<(…)" : "$(…)";
    case "array":
      return `(${part.words.map(literalText).join(" ")})`;
  }
}

// ---------------------------------------------------------------------------
// The reading the measures get (§4a)

export type Verdict = "inside" | "outside" | "unresolved";

/** One tested word. */
export interface TestedPath {
  /** The word as written, quotes removed. */
  written: string;
  role: "cd" | "command" | "argument" | "redirect";
  verdict: Verdict;
  /** The normalised path per cwd candidate; [] when unresolved. */
  resolved: string[];
  /** Set iff the verdict is "unresolved". */
  reason: ReasonCode | null;
}

export interface ReadArgument {
  written: string;
  /** The expanded text when it is one string; null if unresolved. */
  value: string | null;
  /** The path when every candidate gives the same one (tested or not); null otherwise. */
  resolved: string | null;
  /** Null: not tested (a bare name, or data). */
  verdict: Verdict | null;
  reason: ReasonCode | null;
  data: boolean;
}

export interface ReadRedirect {
  op: string;
  written: string;
  resolved: string | null;
  verdict: Verdict;
  reason: ReasonCode | null;
}

/** One simple command of the call, as the measures need it. */
export interface ReadSegment {
  /** The command word's expanded text; null for assignments only, or when it is unresolved. */
  command: string | null;
  /** Its basename, lower-cased, `.exe` dropped. */
  name: string | null;
  /** Set when the command word itself is unresolved. */
  commandReason: ReasonCode | null;
  args: ReadArgument[];
  redirects: ReadRedirect[];
  heredocs: string[];
  /** The single cwd candidate; null when there are several or it is unknown. */
  cwd: string | null;
  /** The call code, if this segment made the call unresolved. */
  callReason: ReasonCode | null;
}

export interface BashReading {
  segments: ReadSegment[];
  tested: TestedPath[];
  /** Every word and call note, in reading order. */
  notes: UnresolvedNote[];
}
