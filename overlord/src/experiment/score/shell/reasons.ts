/**
 * Reason codes for an unresolved word or call (design spec §2.5, a closed
 * list). Scope `word`: the tested word is unresolved. Scope `cwd`: the working
 * directory becomes unknown carrying the code, and it surfaces as the reason
 * of the first relative tested word read under it. Scope `call`: the whole
 * call is unresolved, one note with the call's first 80 characters.
 */
export const REASON_SCOPES = {
  unknown_variable: "word",
  parameter_operator: "word",
  command_substitution: "word",
  process_substitution: "word",
  arithmetic: "word",
  dollar_quote: "word",
  brace_expansion: "word",
  field_split: "word",
  glob: "word",
  tilde_form: "word",
  attached_option: "word",
  prefixed_path: "word",
  colon_form: "word",
  drive_relative: "word",
  short_name: "word",
  backslash: "word",
  symlink: "word",
  path_override: "word",
  assignment_operand: "word",
  cwd_mixed: "word",
  cwd_unknown: "word",
  cd_option: "cwd",
  cd_target: "cwd",
  cd_loop: "cwd",
  cd_cap: "cwd",
  cdpath: "cwd",
  shell_option: "cwd",
  sourced: "cwd",
  nested_interpreter: "call",
  shell_definition: "call",
  nameref: "call",
  parse_option: "call",
  env_split: "call",
  program_io: "call",
  heredoc_substitution: "call",
  /** A path into .git, or a .gitattributes, .gitmodules or .npmrc: what git and npm read there, the run may have written (r2). */
  tool_config: "call",
  unknown_command: "call",
  unknown_option: "call",
  parse_error: "call",
  cap_exceeded: "call",
  /** The record lacks a child path the rule resolves against: a capture that observed none. */
  child_path_missing: "call",
} as const;

export type ReasonCode = keyof typeof REASON_SCOPES;

export type ReasonScope = (typeof REASON_SCOPES)[ReasonCode];

/** A word or call the reader could not resolve, in reading order. */
export interface UnresolvedNote {
  /** Cwd-scope codes surface on a word (§2.5), so they are word notes. */
  scope: "word" | "call";
  reason: ReasonCode;
  /** The word, or the call text, truncated to 80 characters. */
  written: string;
  /** Index into the reading's segments; null for a call note before any. */
  segment: number | null;
}

/** Text as a note records it: at most 80 characters, an ellipsis marking a cut. */
export function truncated(text: string): string {
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}
