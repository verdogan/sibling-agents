// Command-level helpers: option parsing, data arguments (§4.2, §0b.1 item 3), the command name,
// prefix stripping and the whole-call table (§4.1, D6, §0a A2, §0b.1 item 7).
import type { ReasonCode } from "./reasons.js";
import type { Word } from "./syntax.js";
import { parsedBy } from "./table.js";

const GREP_LONG = [
  "regexp", "file", "max-count", "context", "after-context", "before-context", "exclude-from", "exclude",
  "include", "exclude-dir", "label", "binary-files", "devices", "directories", "group-separator",
];
const RG_LONG = [
  "regexp", "file", "max-count", "glob", "iglob", "type", "type-not", "type-add", "type-clear", "ignore-file",
  "pre", "pre-glob", "after-context", "before-context", "context", "threads", "max-depth", "max-filesize",
  "encoding", "engine", "replace", "sort", "sortr", "path-separator", "context-separator", "field-match-separator",
  "field-context-separator", "colors", "dfa-size-limit", "regex-size-limit", "max-columns", "hostname-bin",
  "hyperlink-format", "generate",
];
/** Long flags of grep and rg that take no value: any other long option without `=` may take the next word. */
const GREP_FLAGS = new Set([
  "recursive", "dereference-recursive", "ignore-case", "no-ignore-case", "smart-case", "case-sensitive", "line-number",
  "no-line-number", "count", "files-with-matches", "files-without-match", "invert-match", "word-regexp", "line-regexp",
  "fixed-strings", "extended-regexp", "basic-regexp", "perl-regexp", "pcre2", "only-matching", "quiet", "silent",
  "no-filename", "with-filename", "null", "null-data", "text", "binary", "hidden", "no-ignore", "no-ignore-vcs",
  "files", "json", "vimgrep", "heading", "no-heading", "multiline", "follow", "stats", "trim", "passthru",
  "unrestricted", "no-messages", "byte-offset", "initial-tab", "line-buffered", "color", "colour", "column",
  "no-column", "type-list", "debug", "version", "help", "sort-files", "max-columns-preview", "no-config", "glob-case-insensitive",
]);

/** Short options taking an argument, and long ones taking a separate one, per command. */
export const OPTION_ARGUMENTS: Record<string, { short: string; long: readonly string[] }> = {
  grep: { short: "efmABCdD", long: GREP_LONG },
  egrep: { short: "efmABCdD", long: GREP_LONG },
  fgrep: { short: "efmABCdD", long: GREP_LONG },
  rg: { short: "efmABCgtTMjErd", long: RG_LONG },
  sed: { short: "efl", long: ["expression", "file"] },
  awk: { short: "fvF", long: [] },
  gawk: { short: "fvF", long: [] },
  mawk: { short: "fvF", long: [] },
  nawk: { short: "fvF", long: [] },
  node: { short: "eprC", long: ["eval", "print", "require", "import"] },
  cut: { short: "bcdf", long: ["bytes", "characters", "delimiter", "fields"] },
  sort: { short: "kotST", long: ["key", "output", "field-separator", "temporary-directory"] },
  paste: { short: "d", long: ["delimiters"] },
  join: { short: "12aejotv", long: [] },
  tr: { short: "", long: [] },
  echo: { short: "", long: [] },
  printf: { short: "v", long: [] },
};

interface ParsedOption {
  name: string;
  /** The word the option is in. */
  wordIndex: number;
  /** A separate value word (`-e PATTERN`), if it took one. */
  valueIndex: number | null;
  /** Whether its value is attached to it (`-ePATTERN`, `--regexp=P`). */
  attached: boolean;
}

/** Options and operands, as getopt reads them, for a command in `table` (or none). */
export function parseOptions(
  values: readonly string[],
  command: string,
  table = OPTION_ARGUMENTS[command] ?? { short: "", long: [] },
): { options: ParsedOption[]; operands: number[]; end: number | null } {
  const options: ParsedOption[] = [];
  const operands: number[] = [];
  let end: number | null = null;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    if (end !== null || !value.startsWith("-") || value === "-") {
      operands.push(index);
    } else if (value === "--") {
      end = index;
    } else if (value.startsWith("--")) {
      const name = value.slice(2).split("=")[0]!;
      const attached = value.includes("=");
      const separate = !attached && table.long.includes(name) && index + 1 < values.length;
      options.push({ name, wordIndex: index, valueIndex: separate ? index + 1 : null, attached });
      if (separate) index += 1;
    } else {
      for (let at = 1; at < value.length; at += 1) {
        const letter = value[at]!;
        if (!table.short.includes(letter)) {
          options.push({ name: letter, wordIndex: index, valueIndex: null, attached: false });
          continue;
        }
        const last = at === value.length - 1;
        const separate = last && index + 1 < values.length;
        options.push({ name: letter, wordIndex: index, valueIndex: separate ? index + 1 : null, attached: !last });
        if (separate) index += 1;
        break;
      }
    }
  }
  return { options, operands, end };
}

/** Whether `--` ends a command's options for the reader: only for a command it parses options of. */
export function knowsOptions(command: string): boolean {
  return Object.hasOwn(OPTION_ARGUMENTS, command) || command === "git" || command === "gh";
}

/**
 * Which of a command's argument words are data (§1.5 item 3, §4.2, §0b.1
 * item 3), by index: never tested, though a substitution in one is still read.
 */
export function dataArguments(command: string, values: readonly string[]): Set<number> {
  const data = new Set<number>();
  if (command === "echo" || command === "printf" || command === "tr") {
    values.forEach((_, index) => data.add(index));
    return data;
  }
  // `[[` is read as `[` (r2: `[[ -f ../x ]]` stats it); only a string comparison's two sides are data.
  if (command === "[[") {
    const compares = (at: number) => ["==", "=", "!=", "=~", "<", ">"].includes(values[at] ?? "");
    values.forEach((_, index) => (compares(index - 1) || compares(index + 1)) && data.add(index));
    return data;
  }
  if (command === "git") return gitData(values);
  if (command === "gh") {
    values.forEach((value, index) => {
      if ((value === "--title" || value === "--body") && index + 1 < values.length) data.add(index + 1);
      if (value.startsWith("--title=") || value.startsWith("--body=")) data.add(index);
    });
    return data;
  }
  if (!Object.hasOwn(OPTION_ARGUMENTS, command)) return data;
  const { options, operands } = parseOptions(values, command);
  /** Mark the named options' values as data; whether any had one. */
  const mark = (names: readonly string[]): boolean => {
    let found = false;
    for (const option of options) {
      if (!names.includes(option.name)) continue;
      if (option.valueIndex !== null) data.add(option.valueIndex);
      if (option.attached) data.add(option.wordIndex);
      found ||= option.valueIndex !== null || option.attached;
    }
    return found;
  };
  if (["grep", "egrep", "fgrep", "rg"].includes(command)) {
    // A long option the table does not know may take the next word (`--ignore-file ../i`): then no operand is the pattern.
    const unknown = options.some(
      (option) => option.name.length > 1 && !option.attached && !OPTION_ARGUMENTS[command]!.long.includes(option.name) && !GREP_FLAGS.has(option.name),
    );
    // Patterns from -f/--file, or rg's --files (no pattern at all): every operand is a path (r2).
    const patternless = options.some((option) => ["f", "file", "files"].includes(option.name));
    if (!mark(["e", "regexp"]) && operands[0] !== undefined && !unknown && !patternless) data.add(operands[0]);
  } else if (command === "sed" || command === "awk") {
    // As the table reads them (`-in` is -i with suffix n): -e values, or awk's -v and -F, else the first operand.
    const walked = parsedBy(command, values);
    let found = false;
    for (const option of walked.options) {
      if (!["-e", "--expression", "-v", "-F"].includes(option.key)) continue;
      data.add(option.attached === null && option.valueIndex !== null ? option.valueIndex : option.wordIndex);
      found ||= command === "sed";
    }
    if (!found && walked.operands[0] !== undefined) data.add(walked.operands[0]);
  } else if (command === "node") {
    mark(["e", "p", "eval", "print"]);
  } else if (command === "cut") {
    mark(["d", "delimiter"]);
  } else if (command === "sort") {
    mark(["t", "field-separator"]);
  } else if (command === "paste") {
    mark(["d", "delimiters"]);
  } else if (command === "join") {
    mark(["t"]);
  } else {
    // awk: the program, unless -f names a file for it; and every -v.
    mark(["v"]);
    const programFile = options.some((option) => option.name === "f");
    if (!programFile && operands[0] !== undefined) data.add(operands[0]);
  }
  return data;
}

/** `git commit`/`git tag`: the `-m`/`--message` values (§0b.1 item 3). */
function gitData(values: readonly string[]): Set<number> {
  const data = new Set<number>();
  let index = 0;
  // Global options before the subcommand; `-C`, `-c` and the like take a value.
  while (index < values.length && values[index]!.startsWith("-")) {
    index += /^-[Cc]$|^--(?:git-dir|work-tree|namespace|exec-path|config-env)$/.test(values[index]!) ? 2 : 1;
  }
  const subcommand = values[index];
  if (subcommand === "show" || subcommand === "cat-file") {
    // `REV:path` names a git object, read from the object store (§2.3 rule 6).
    values.forEach((value, at) => {
      if (at > index && /^[^-/\\][^:]*:/.test(value)) data.add(at);
    });
    return data;
  }
  if (subcommand !== "commit" && subcommand !== "tag") return data;
  for (let at = index + 1; at < values.length; at += 1) {
    const value = values[at]!;
    if (value === "--") break;
    if (value === "--message" && at + 1 < values.length) data.add((at += 1));
    else if (value.startsWith("--message=")) data.add(at);
    else if (/^-[a-zA-Z]*m$/.test(value) && at + 1 < values.length) data.add((at += 1));
    else if (/^-[a-zA-Z]*m./.test(value) && !value.startsWith("--")) data.add(at);
  }
  return data;
}

export function basename(command: string): string {
  const name = command.replace(/\\/g, "/").split("/").at(-1) ?? command;
  return name.toLowerCase().replace(/\.exe$/, "");
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;

/** A word shaped like an assignment (`NAME=…`, `NAME+=…`, `NAME[i]=…`), as bash reads one before the command. */
export function isAssignment(word: Word): boolean {
  const first = word.parts[0];
  return first?.kind === "lit" && first.quote === "none" && ASSIGNMENT.test(first.text);
}

/**
 * A declaration builtin's operand that is an assignment after quote removal:
 * bash's export and declare assign `"PATH=x"` and `P""ATH=x` as they do `PATH=x`.
 */
export function declaredAssignment(word: Word): boolean {
  let head = "";
  for (const part of word.parts) {
    if (part.kind !== "lit") return false;
    const at = part.text.indexOf("=");
    if (at !== -1) return ASSIGNMENT.test(head + part.text.slice(0, at + 1));
    head += part.text;
  }
  return false;
}

/** The assignment's name, operator and the parts of its value (the head may be quoted in a declaration). */
export function splitAssignment(word: Word): { name: string; subscript: boolean; append: boolean; value: Word } {
  let head = "";
  let index = 0;
  for (; index < word.parts.length; index += 1) {
    const part = word.parts[index]!;
    if (part.kind === "lit" && part.text.includes("=")) break;
    if (part.kind === "lit") head += part.text;
  }
  const part = word.parts[index] as Extract<Word["parts"][number], { kind: "lit" }> | undefined;
  const at = part === undefined ? -1 : part.text.indexOf("=");
  if (part !== undefined) head += part.text.slice(0, at + 1);
  const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(head)?.[0] ?? "";
  const rest = part === undefined ? "" : part.text.slice(at + 1);
  const tail = word.parts.slice(index + 1);
  const value: Word = { parts: [...(rest === "" || part === undefined ? [] : [{ ...part, text: rest }]), ...tail] };
  return { name, subscript: head.includes("["), append: head.endsWith("+="), value };
}

export const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The declaration builtins: their `NAME=value` operands are assignments (§3.3). */
export const DECLARERS: ReadonlySet<string> = new Set(["export", "readonly", "local", "declare", "typeset"]);

// ---------------------------------------------------------------------------
// Prefix commands (design spec §4.1, §0b.1 item 9)

/** What stripping the prefix commands found, by word index (0 is the command word as written). */
export interface Stripped {
  /** The index of the command that runs, or null when none does (a bare `env`). */
  command: number | null;
  /** Where stripping stopped: the command, or the first word no prefix took (the rest are data after a refusal). */
  end: number;
  /** The prefixes' own operands: data. */
  data: number[];
  /** env's `NAME=value` words: prefix assignments (§3.3). */
  assignments: number[];
  /** env's `-C DIR` / `--chdir DIR`: tested as cd targets; the command's relative words read under Unknown. */
  dirs: { index: number; attached: boolean }[];
  reason: ReasonCode | null;
}

/** §0b.1 item 9's prefixes; `command`, `builtin`, `exec`, `stdbuf` and `sudo` are table commands or none. */
const PREFIXES = new Set(["env", "nohup", "time", "nice", "timeout"]);

/** Builtins with no program of that name: after env, nice, nohup or timeout they fail, and change no shell state. */
const SHELL_ONLY = new Set(["cd", "pushd", "popd", "dirs", "export", "set", ":", "[[", "exit", "command", "type"]);

/**
 * Strip `env`, `nohup`, `time`, `nice` and `timeout` (§4.1, §0b.1 item 9), repeated. `values` holds
 * each word's one value, null when it has none: an unresolved option word of
 * a prefix, or an option it does not list, is `unknown_option`.
 */
export function stripPrefixes(values: readonly (string | null)[]): Stripped {
  const result: Stripped = { command: 0, end: 0, data: [], assignments: [], dirs: [], reason: null };
  const stop = (reason: ReasonCode | null, command: number | null, end: number): Stripped => ({ ...result, reason, command, end });
  let at = 0;
  let external = false;
  for (;;) {
    const word = values[at];
    if (word === null || word === undefined) return { ...result, command: word === undefined ? null : at, end: at };
    // A command path is never a prefix (`./env`): the table reads it as a path (unknown_command).
    const name = /[\\/]/.test(word) ? "" : basename(word);
    // `env cd src` runs no cd: the reader cannot apply it, so the call is unresolved.
    if (external && SHELL_ONLY.has(name)) return stop("unknown_command", null, at);
    external ||= PREFIXES.has(name) && name !== "time";
    if (!PREFIXES.has(name)) return { ...result, command: at, end: at };
    let next = at + 1;
    const value = (offset = 0) => values[next + offset];
    /** Mark `count` words from `next` as the prefix's operands. */
    const take = (count: number) => {
      for (let index = 0; index < count; index += 1) result.data.push(next + index);
      next += count;
    };
    let bad = false;
    switch (name) {
      case "env":
        for (let ended = false; value() !== undefined; ) {
          const option = value();
          if (option === undefined) break;
          if (option === null) bad = true;
          else if (!ended && (option === "-i" || option === "-0" || option === "-" || option === "--ignore-environment" || option === "--null")) take(1);
          else if (!ended && (option === "-u" || option === "--unset")) take(2);
          else if (!ended && (/^-u./.test(option) || option.startsWith("--unset="))) take(1);
          else if (!ended && option === "--") {
            take(1);
            ended = true;
            continue;
          } else if (!ended && (/^-[^-]*S/.test(option) || option.startsWith("--split-string") || option === "--s" || option === "--sp")) {
            return stop("env_split", null, next);
          } else if (!ended && (option === "-C" || option === "--chdir")) {
            result.dirs.push({ index: next + 1, attached: false });
            take(2);
          } else if (!ended && option.startsWith("--chdir=")) {
            result.dirs.push({ index: next, attached: true });
            take(1);
          } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(option)) {
            result.assignments.push(next);
            next += 1;
            ended = true;
            continue;
          } else if (option.startsWith("-") && !ended) bad = true;
          else break;
          if (bad) break;
        }
        break;
      case "nohup":
        if (value() === "--") take(1);
        else if (value() === null || value()?.startsWith("-")) bad = true;
        break;
      case "time":
        while (value() === "-p" || value() === "--") take(1);
        if (value() === null || value()?.startsWith("-")) bad = true;
        break;
      case "nice":
        while (value() !== undefined && !bad) {
          const option = value();
          if (option === undefined) break;
          if (option === null) bad = true;
          else if (option === "-n" || option === "--adjustment") take(2);
          else if (/^-n-?[0-9]+$/.test(option) || /^--?[0-9]+$/.test(option) || /^--adjustment=-?[0-9]+$/.test(option)) take(1);
          else if (option === "--") {
            take(1);
            break;
          } else if (option.startsWith("-")) bad = true;
          else break;
        }
        break;
      case "timeout":
        while (value() !== undefined && !bad) {
          const option = value();
          if (option === undefined) break;
          if (option === null) bad = true;
          else if (option === "-s" || option === "-k" || option === "--signal" || option === "--kill-after") take(2);
          else if (/^-[sk].+$/.test(option) || /^--(?:signal|kill-after)=/.test(option)) take(1);
          else if (["--foreground", "--preserve-status", "-v", "--verbose", "-f", "-p"].includes(option)) take(1);
          else if (option === "--") {
            take(1);
            break;
          } else if (option.startsWith("-")) bad = true;
          else break;
        }
        if (!bad && value() !== undefined) take(1); // the duration
        break;
    }
    if (bad) return stop("unknown_option", null, next);
    if (next >= values.length) return stop(null, null, next);
    at = next;
  }
}

// The whole-call denylist of D6 (§4.1) is gone: the command table (table.ts, §0b.1 item 9) lists the
// commands the reader resolves, and every other one is `unknown_command`. These are absent on purpose,
// each because it runs code it is given, or code or paths it reads from elsewhere, which the reader cannot
// follow: eval, exec, source and `.`, builtin, coproc, mapfile/readarray (`-C`), read, declare/local/
// typeset/readonly, let, set, shopt, trap, alias, enable, hash; xargs, parallel, watch, su, sudo, script,
// stdbuf, flock; perl, ruby, php, deno, bun, powershell/pwsh, cmd, wsl, busybox, zsh/ksh/dash; gawk and
// mawk by those names; curl, wget, ln, tar, make, rsync. Inside the table, the code-running forms are code
// values (`bash -c`, `node -e`, `python3 -c`, `npx -c`, `rg --pre`, `find -exec`), a runtime fed
// stdin with no script, and every option an entry does not list (`git -c`, `git config`, `python3 -m`).
