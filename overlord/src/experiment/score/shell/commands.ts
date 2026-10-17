// Command-level readings (design spec §3.3, §3.4, §2.5 call codes): what a
// simple command does to the state beyond its words, and the command shapes
// the walk recognises (symlinks, R1's `seq`, a redirected stderr).
import { DECLARERS, NAME, declaredAssignment, splitAssignment } from "./calls.js";
import { literalText } from "./parse.js";
import type { ReasonCode } from "./reasons.js";
import { assign, forgetAll, lookup, type State } from "./state.js";
import type { ReadSegment, Redirection, Word } from "./syntax.js";
import { arithmeticRunsCode, pureArithmetic, valueRunsCode } from "./words.js";

const ARITHMETIC_TESTS = new Set(["-eq", "-ne", "-lt", "-le", "-gt", "-ge"]);
/** `shopt` options that change how words are read: the call is unresolved (§2.5 `parse_option`). */
const PARSE_SHOPTS = new Set(["extglob", "expand_aliases"]);

/** What commandEffects needs from the reader: a call note, and an assignment applied as the reader applies one. */
export interface CommandHooks {
  call(reason: ReasonCode): void;
  assignment(word: Word, state: State): State;
}

/** What a command does to the state beyond its words (§3.3, §3.4 `shopt`, §2.5 call codes). */
export function commandEffects(name: string, args: readonly Word[], state: State, segment: ReadSegment, hooks: CommandHooks): State {
  let next = state;
  const written = args.map(literalText);
  const literal = (word: Word) => word.parts.every((part) => part.kind === "lit");
  // A computed operand (`"$n"`) a builtin reads as a NAME: if n holds code, bash evaluates it (D6).
  const operandRunsCode = (word: Word) =>
    word.parts.length === 1 && word.parts[0]!.kind === "var" && word.parts[0]!.op === null && valueRunsCode(lookup(next, word.parts[0]!.name));
  const unknown = (variable: string) => {
    next = assign(next, variable.replace(/\[.*$/, ""), { unknown: "unknown_variable" });
  };
  const call = (reason: ReasonCode) => {
    hooks.call(reason);
    segment.callReason ??= reason;
  };
  if (DECLARERS.has(name)) {
    const flags = written.filter((word) => /^[-+][A-Za-z]+$/.test(word)).join("");
    if (flags.includes("n")) {
      call("nameref");
      return forgetAll(next, "unknown_variable");
    }
    if (flags.includes("i")) next = { ...next, intDeclared: true };
    const typed = /[aAilu]/.test(flags);
    args.forEach((word, index) => {
      if (declaredAssignment(word)) {
        next = hooks.assignment(word, next);
        if (typed) unknown(splitAssignment(word).name);
      } else if (typed && NAME.test(written[index]!)) unknown(written[index]!);
      // A computed operand (`declare "$X=v"`) may write any variable: PATH, IFS, CDPATH, OLDPWD, DIRSTACK.
      else if (!literal(word) && !written[index]!.startsWith("-")) next = { ...forgetAll(next, "unknown_variable"), pathOverride: true };
    });
    return next;
  }
  switch (name) {
    case "read":
    case "mapfile":
    case "readarray":
    case "getopts":
    case "unset":
      if (name === "unset" && written.includes("-f")) return next;
      ["REPLY", "MAPFILE", "OPTARG", "OPTIND"].forEach(unknown);
      args.forEach((word, index) => {
        if (operandRunsCode(word)) call("nested_interpreter");
        if (!literal(word)) next = forgetAll(next, "unknown_variable");
        else if (/^[A-Za-z_][A-Za-z0-9_]*(?:\[.*\])?$/.test(written[index]!)) unknown(written[index]!);
      });
      return next;
    case "printf":
      args.forEach((word, index) => {
        const target = written[index] === "-v" ? args[index + 1] : written[index]!.startsWith("-v") ? word : undefined;
        if (target === undefined) return;
        if (operandRunsCode(target)) call("nested_interpreter");
        const text = literalText(target).replace(/^-v/, "");
        if (literal(target) && /^[A-Za-z_][A-Za-z0-9_]*(?:\[.*\])?$/.test(text)) unknown(text);
        else next = forgetAll(next, "unknown_variable");
      });
      return next;
    case "let":
      if (args.some((word) => arithmeticRunsCode(word, next))) call("nested_interpreter");
      if (!args.every((word) => pureArithmetic(word, next))) next = forgetAll(next, "unknown_variable");
      return next;
    case "[[":
      // §0b.1 item 10: `=~` only with a pattern that has no unquoted expansion.
      if (args.some((word, index) => written[index - 1] === "=~" && word.parts.some((part) => part.kind !== "lit" && "quote" in part && part.quote === "none"))) {
        call("unknown_option");
      }
      if (written.some((word) => ARITHMETIC_TESTS.has(word))) {
        const operands = args.filter((_, index) => !/^(?:-[a-z]{2}|&&|\|\||[()!<>]|\]\]|==?|!=)$/.test(written[index]!));
        if (operands.some((word) => arithmeticRunsCode(word, next))) call("nested_interpreter");
        if (!operands.every((word) => pureArithmetic(word, next))) next = forgetAll(next, "unknown_variable");
      }
      if (written.includes("-v")) {
        const target = args[written.indexOf("-v") + 1];
        if (target !== undefined && operandRunsCode(target)) call("nested_interpreter");
      }
      return next;
    case "shopt": {
      const setting = written.some((word) => /^-[a-z]*[suo]/.test(word));
      const names = written.filter((word) => !word.startsWith("-"));
      if (!setting || names.length === 0) return next;
      if (names.some((option) => PARSE_SHOPTS.has(option))) call("parse_option");
      return { ...next, cwd: { unknown: "shell_option" } };
    }
    case "set":
      for (let index = 0; index < written.length; index += 1) {
        const word = written[index]!;
        if (word === "--" || word === "-") break;
        if ((word === "-o" || word === "+o") && index + 1 < written.length) {
          const option = written[(index += 1)]!;
          if (["braceexpand", "noglob", "posix"].includes(option)) call("parse_option");
          if (option === "physical") next = { ...next, cwd: { unknown: "shell_option" } };
        } else if (/^-[A-Za-z]+$/.test(word)) {
          if (/[fk]/.test(word)) call("parse_option");
          if (word.includes("P")) next = { ...next, cwd: { unknown: "shell_option" } };
        } else if (/^\+[A-Za-z]+$/.test(word) && word.includes("B")) call("parse_option");
        else break;
      }
      return next;
    case "hash":
      if (written.some((word) => /^-[a-z]*p/.test(word))) call("shell_definition");
      return next;
    case "alias":
      if (written.some((word) => word.includes("="))) call("shell_definition");
      return next;
    case "trap":
      if (written.length >= 2 && written[0] !== "-" && written[0] !== "-p" && written[0] !== "-l") call("shell_definition");
      return next;
    case "enable":
      call("shell_definition");
      return next;
    default:
      return next;
  }
}


/** The argument indices of a symbolic link's targets: `ln -s`, `cp -s`, `mklink` (§3.4). */
export function symlinkTargets(name: string, written: readonly string[]): Set<number> {
  const operands = written.flatMap((word, index) => (word.startsWith("-") || /^\/[DHJ]$/i.test(word) ? [] : [index]));
  if (name === "mklink") return new Set(operands.slice(-1));
  const symbolic = written.some((word) => /^-[a-zA-Z]*s/.test(word) || word === "--symbolic");
  if ((name !== "ln" && name !== "cp") || !symbolic) return new Set();
  return new Set(operands.length === 1 ? operands : operands.slice(0, -1));
}

/** `$(seq A)`, `$(seq A B)`, `$(seq A B C)` with non-negative integer literals and nothing else (§0b R1). */
export function seqSource(word: Word): "seq" | null {
  const part = word.parts[0];
  if (word.parts.length !== 1 || part?.kind !== "sub" || part.form !== "command" || part.quote !== "none") return null;
  if (part.list.length !== 1 || part.list[0]!.pipeline.commands.length !== 1 || part.list[0]!.pipeline.negated) return null;
  const command = part.list[0]!.pipeline.commands[0]!;
  if (command.kind !== "simple" || command.redirections.length > 0) return null;
  const words = command.words.map((inner) => (inner.parts.length === 1 && inner.parts[0]!.kind === "lit" && inner.parts[0]!.quote === "none" ? inner.parts[0]!.text : null));
  if (words[0] !== "seq" || words.length < 2 || words.length > 4) return null;
  return words.slice(1).every((text) => text !== null && /^[0-9]+$/.test(text)) ? "seq" : null;
}

/** `{A..B}` or `{A..B..C}` with non-negative integer literals (§0b.1 item 4). */
export function braceSequence(word: Word): "brace" | null {
  const part = word.parts[0];
  if (word.parts.length !== 1 || part?.kind !== "lit" || part.quote !== "none") return null;
  return /^\{[0-9]+\.\.[0-9]+(?:\.\.[0-9]+)?\}$/.test(part.text) ? "brace" : null;
}

/** Whether a command's redirections send its stderr away (§0b.1 item 5). */
export function stderrRedirected(redirections: readonly Redirection[]): boolean {
  return redirections.some(
    (redirection) =>
      redirection.op.startsWith("&>") ||
      (redirection.op === ">&" && redirection.fd === "" && redirection.target !== null) ||
      // Any fd-2 redirection (`2>`, `2<&-`, `2<file`): a failing cd then writes no `cd:` line.
      redirection.fd === "2",
  );
}

/** Whether stdin is a pipe, a heredoc or a here-string (§0a A2): inherited, unless a redirection sets it (`<` a file: no). */
export function stdinFed(redirections: readonly Redirection[], inherited: boolean): boolean {
  let fed = inherited;
  for (const redirection of redirections) {
    if ((redirection.fd !== "" && redirection.fd !== "0") || !redirection.op.startsWith("<")) continue;
    fed = redirection.heredoc !== null || redirection.op === "<<<" || redirection.op.startsWith("<&");
  }
  return fed;
}

/**
 * Whether an unquoted heredoc body runs something (§0b.1 item 8): bash runs
 * every unescaped `$( … )`, `$(( … ))`, `$[ … ]` and backquote in it, and a
 * `${…}` other than `${NAME}` may assign or evaluate. Plain `$NAME` and
 * `${NAME}` are output text. A backslash escapes `$`, a backquote, a
 * backslash and a newline (`\` newline joins the lines first, so `$\` newline
 * `(` is `$(`). One left-to-right pass (D10).
 */
export function heredocRuns(body: string): boolean {
  const n = body.length;
  /** The next index at or after `at` that is not a `\` newline pair. */
  const skipJoins = (at: number): number => {
    while (body[at] === "\\" && body[at + 1] === "\n") at += 2;
    return at;
  };
  for (let at = 0; at < n; ) {
    const c = body[at]!;
    if (c === "\\") {
      at = body[at + 1] === "\n" ? at + 2 : skipJoins(at + 1) + 1;
      continue;
    }
    if (c === "`") return true;
    if (c !== "$") {
      at += 1;
      continue;
    }
    let next = skipJoins(at + 1);
    const opener = body[next];
    if (opener === "(" || opener === "[") return true;
    if (opener !== "{") {
      at = next;
      continue;
    }
    // `${NAME}`, `${N}` or `${?}`-style specials only; anything else, or no `}`, runs or may assign.
    next = skipJoins(next + 1);
    const head = body[next];
    if (head !== undefined && "?#$!@*-".includes(head)) next = skipJoins(next + 1);
    else if (head !== undefined && /[A-Za-z_]/.test(head)) {
      do next = skipJoins(next + 1);
      while (next < n && /[A-Za-z0-9_]/.test(body[next]!));
    } else if (head !== undefined && /[0-9]/.test(head)) {
      do next = skipJoins(next + 1);
      while (next < n && /[0-9]/.test(body[next]!));
    } else return true;
    if (body[next] !== "}") return true;
    at = next + 1;
  }
  return false;
}
