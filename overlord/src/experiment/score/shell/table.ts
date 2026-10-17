// The command table (design spec §0b.1 item 9): the reader resolves only the
// commands listed here. Any other command name, after prefix stripping, makes
// the call unresolved (`unknown_command`); so does a command path (`./x.sh`,
// `/usr/bin/cat`) other than a script operand of a table runtime, and a
// subcommand an entry does not list. For a listed command, an option its entry
// does not list (an abbreviation, an unknown long option, a cluster with an
// unknown letter) is `unknown_option`, and an option whose value is code, or a
// stdin read as code, is `nested_interpreter`.
//
// Each entry states, for every option, whether it is a flag or takes a value,
// and the value's role: a path, data, or code. Code makes the call unresolved;
// path and data are stated for review, and which words are tested stays the
// rule of §2.3 (D3) and the data arguments of §4.2 (calls.ts), so a stated
// role can only over-flag, never clean a word. The operand role and the stdin
// role are stated per entry; no listed command reads stdin as paths.
//
// Option words, as each entry's `--help` or man page has them:
// - getopt entries: `-abc` is a cluster of letters; a letter that takes a
//   value takes the rest of the cluster (`-n5`, `-F,`), else the next word; an
//   optional value (`sed -i[SUFFIX]`) is only ever the rest of the cluster, so
//   `-in` is `-i` with suffix `n`. `--name=value` or `--name value` for a
//   required value, only `--name=value` for an optional one; `--name=` on a flag
//   is unknown. Options may follow operands (GNU permutation) until `--`.
// - word entries (`find`, `test`, `[`, `xxd`): every option is one whole word.
// - `numeric`: `-NUM` is an option (`head -50`, `git log -5`).
// - `script`: the first operand is the script (or format, or package); the
//   words after it are its own and are not read as options.
//
// Spec tokens: `-x` flag, `-x:` value, `-x:p` path value, `-x:c` code value,
// `-x?` optional attached value, `-x!` a flag that runs code (`find -exec`),
// `--name:2` and `--name:2p` two value words (`jq --arg NAME VALUE`).
//
// Adding an entry is a protocol change, made before data is seen (§0b.1 item 9).
import type { ReasonCode } from "./reasons.js";

export type Role = "path" | "data" | "code";

interface Option {
  /** How many value words it takes: 0 for a flag. */
  takes: 0 | 1 | 2;
  optional: boolean;
  role: Role;
}

export interface Entry {
  /** The man page or `--help` its option list comes from. */
  source: string;
  options: ReadonlyMap<string, Option>;
  /** Operands' role, as stated (D3 decides which are tested). */
  operands: string;
  words?: true;
  numeric?: true;
  /** `+x` before the first operand is an option too (bash). */
  plus?: true;
  script?: true;
  /** With no script operand (or `-`) and stdin fed, it runs stdin as code. */
  stdin?: "code";
  /** Options after which no stdin code is read (`node --test`, `bash --version`). */
  noStdin?: readonly string[];
  /** Read by its own grammar elsewhere (cd, pushd, popd: §3.4). */
  own?: true;
  /** A builtin: prefix assignments set nothing for a child. */
  builtin?: true;
  /** Every word is an operand (echo, true, false: options they do not know are printed or ignored). */
  lenient?: true;
  /** The first operand names a subcommand; any other is `unknown_command`. */
  sub?: Readonly<Record<string, Entry>>;
  /** The first operand names a table command run with the rest (npx). */
  program?: true;
  check?: (values: readonly (string | null)[], walk: Walk) => ReasonCode | null;
}

/** One option found, by word index. */
export interface Found {
  key: string;
  wordIndex: number;
  /** The value's word, when separate; the second one for a two-value option. */
  valueIndex: number | null;
  /** The value attached in the option's word (`-n5`, `--x=v`, `-i.bak`); null when separate or none. */
  attached: string | null;
}

export interface Walk {
  reason: ReasonCode | null;
  /** Code operands: data, never tested (the call is unresolved). */
  data: number[];
  /** `git -C DIR`: tested as cd targets, no cwd change after. */
  dirs: number[];
  options: Found[];
  operands: number[];
}

function spec(text: string): Map<string, Option> {
  const map = new Map<string, Option>();
  for (const token of text.split(/\s+/).filter(Boolean)) {
    const match = /^([-+]-?[^:?!]+)([:?!]?)(2?)([pc]?)$/.exec(token);
    if (match === null) throw new Error(`bad option spec ${token}`);
    const [, key, kind, two, role] = match;
    const named: Role = role === "p" ? "path" : role === "c" ? "code" : "data";
    if (kind === "!") map.set(key!, { takes: 0, optional: false, role: "code" });
    else if (kind === "?") map.set(key!, { takes: 1, optional: true, role: named });
    else if (kind === ":") map.set(key!, { takes: two === "2" ? 2 : 1, optional: false, role: named });
    else map.set(key!, { takes: 0, optional: false, role: "data" });
  }
  return map;
}

const entry = (source: string, options: string, operands: string, rest: Omit<Entry, "source" | "options" | "operands"> = {}): Entry => ({
  source,
  options: spec(options),
  operands,
  ...rest,
});

/** A package spec a runner fetches rather than finds on file (§0b.1 item 7): a URL, `github:`, `user/repo`. */
export function remoteSpec(spec: string): boolean {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(spec)) return true;
  return spec.includes("/") && !spec.startsWith("@") && !spec.startsWith(".") && !spec.startsWith("/") && !spec.startsWith("~");
}

/**
 * Walk `values` (null: a word with no one value) from `from` by `table`'s
 * grammar. `maybeOption(index)`: an unresolved or many-valued word there may
 * be an option (a data word, or a value that starts with `-`): unknown.
 */
export function walk(table: Entry, values: readonly (string | null)[], from = 0, fed = false, maybeOption: (index: number) => boolean = () => false): Walk {
  const result: Walk = { reason: null, data: [], dirs: [], options: [], operands: [] };
  const fail = (reason: ReasonCode, data: number[] = []): Walk => ({ ...result, reason, data: [...result.data, ...data] });
  if (table.own) return result;
  let ended = false;
  let quiet = false;
  for (let index = from; index < values.length; index += 1) {
    const value = values[index];
    if (table.lenient) {
      result.operands.push(index);
      continue;
    }
    if (value === null || value === undefined) {
      if (!ended && maybeOption(index)) return fail("unknown_option");
      result.operands.push(index);
      if (table.script || table.sub || table.program) return result;
      continue;
    }
    const optionLike = !ended && value !== "-" && (value.startsWith("-") || (table.plus === true && value.startsWith("+") && value.length > 1));
    if (!optionLike) {
      result.operands.push(index);
      if (table.sub && result.operands.length === 1) {
        const sub = Object.hasOwn(table.sub, value) ? table.sub[value] : undefined;
        if (sub === undefined) return fail("unknown_command");
        const inner = walk(sub, values, index + 1, fed, maybeOption);
        return { ...inner, data: [...result.data, ...inner.data], dirs: [...result.dirs, ...inner.dirs], options: [...result.options, ...inner.options] };
      }
      if (table.program) {
        const reason = table.check?.(values, result) ?? null;
        return reason === null ? runProgram(result, values, index) : fail(reason);
      }
      if (table.script) {
        if (value === "-" && table.stdin === "code" && fed) return fail("nested_interpreter");
        break;
      }
      continue;
    }
    if (value === "--" && !table.words) {
      ended = true;
      continue;
    }
    if (table.numeric && /^-[0-9]+$/.test(value)) continue;
    const step = option(table, values, index, result);
    if (step.reason !== null) {
      // A code value: it and, for a runtime, every word after it are the code's (data).
      const code = step.reason === "nested_interpreter" && step.at !== null ? [step.at, ...(table.script ? rest(values, step.at + 1) : [])] : [];
      return fail(step.reason, code);
    }
    if (table.noStdin?.includes(result.options.at(-1)?.key ?? "")) quiet = true;
    index = step.next;
  }
  if (table.check !== undefined) {
    const reason = table.check(values, result);
    if (reason !== null) return fail(reason);
  }
  // No script operand: a runtime reads its code from stdin.
  if (table.script && table.stdin === "code" && fed && !quiet && result.operands.length === 0) return fail("nested_interpreter");
  return result;
}

const rest = (values: readonly unknown[], from: number) => values.map((_, index) => index).filter((index) => index >= from);

/** One option word at `index`: what it found, the last index it used, and a reason when it is unknown or code. */
function option(table: Entry, values: readonly (string | null)[], index: number, result: Walk): { reason: ReasonCode | null; next: number; at: number | null } {
  const word = values[index]!;
  const unknown = { reason: "unknown_option" as const, next: index, at: null };
  const take = (key: string, found: Option, attached: string | null): { reason: ReasonCode | null; next: number; at: number | null } => {
    let next = index;
    let valueIndex: number | null = null;
    if (attached === null && !found.optional) {
      next = index + found.takes;
      valueIndex = found.takes === 0 ? null : Math.min(next, values.length - 1);
    }
    result.options.push({ key, wordIndex: index, valueIndex, attached });
    if (found.role !== "code") return { reason: null, next, at: null };
    return { reason: "nested_interpreter", next, at: found.takes === 0 ? null : valueIndex ?? index };
  };
  if (table.words) {
    const found = table.options.get(word);
    return found === undefined ? unknown : take(word, found, null);
  }
  if (word.startsWith("--")) {
    const equals = word.indexOf("=");
    const key = equals === -1 ? word : word.slice(0, equals);
    const found = table.options.get(key);
    if (found === undefined || (found.takes === 0 && equals !== -1)) return unknown;
    return take(key, found, equals === -1 ? null : word.slice(equals + 1));
  }
  const sign = word[0]!;
  for (let at = 1; at < word.length; at += 1) {
    const key = `${sign}${word[at]}`;
    const found = table.options.get(key);
    if (found === undefined) return unknown;
    if (found.takes === 0) {
      const step = take(key, found, null);
      if (step.reason !== null) return step;
      continue;
    }
    const attached = at < word.length - 1 ? word.slice(at + 1) : found.optional ? "" : null;
    return take(key, found, attached);
  }
  return { reason: null, next: index, at: null };
}

/**
 * npx's package operand: a remote spec is code (§0b.1 item 7). Any other is
 * `unknown_command`: the reader cannot know a local bin exists, and with none
 * npx fetches the registry package of that name and runs it, without a prompt
 * when stdin is no TTY (`npx --offline ls` asks the registry for `ls`).
 */
function runProgram(result: Walk, values: readonly (string | null)[], index: number): Walk {
  return { ...result, reason: remoteSpec(values[index]!) ? "nested_interpreter" : "unknown_command" };
}

/** Variables a prefix assignment, `env NAME=…` or `export` may pass to a child: none of them carries code or a path a tool reads. */
const CHILD_VARIABLES = new Set([
  "PATH", "NODE_ENV", "CI", "FORCE_COLOR", "NO_COLOR", "TZ", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "LC_MESSAGES",
  "LC_COLLATE", "LC_NUMERIC", "LC_TIME", "TERM", "COLUMNS", "LINES", "NODE_NO_WARNINGS", "PYTHONUNBUFFERED",
  "PYTHONDONTWRITEBYTECODE", "PYTHONHASHSEED", "PYTHONIOENCODING", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_AUTHOR_DATE", "GIT_COMMITTER_DATE", "DEBUG", "PORT",
]);

/** Whether a variable set for a child (`NAME=v cmd`, `env NAME=v`, `export NAME`) is one the table knows; `PATH` is §3.3's. */
export function childVariable(name: string): boolean {
  return CHILD_VARIABLES.has(name);
}

/**
 * The table's reading of a command after prefix stripping: `name` the
 * basename, `command` the command word's value, `assigned` the variables
 * the call sets for it (prefix assignments and env's).
 */
export function tableCall(
  name: string,
  command: string,
  values: readonly (string | null)[],
  fed: boolean,
  maybeOption: (index: number) => boolean,
  assigned: readonly string[],
): Walk {
  const none: Walk = { reason: null, data: [], dirs: [], options: [], operands: [] };
  const table = Object.hasOwn(TABLE, name) ? TABLE[name] : undefined;
  if (table === undefined || /[\\/]/.test(command)) return { ...none, reason: "unknown_command" };
  if (!table.builtin && assigned.some((variable) => !childVariable(variable))) return { ...none, reason: "unknown_option" };
  return walk(table, values, 0, fed, maybeOption);
}

/** The table's grammar for one command's arguments (sed and awk, for the program scans). */
export function parsedBy(name: string, values: readonly (string | null)[]): Walk {
  const table = Object.hasOwn(TABLE, name) ? TABLE[name]! : entry("", "", "");
  return walk(table, values);
}

// ---------------------------------------------------------------------------
// Checks beyond the option lists

const ARITHMETIC = new Set(["-eq", "-ne", "-lt", "-le", "-gt", "-ge"]);
const TEST_OPS = new Set([
  "-a", "-b", "-c", "-d", "-e", "-f", "-g", "-h", "-k", "-p", "-r", "-s", "-t", "-u", "-w", "-x",
  "-G", "-L", "-N", "-O", "-S", "-z", "-n", "-o", "-eq", "-ne", "-lt", "-le", "-gt", "-ge", "-nt", "-ot", "-ef",
]);
const BRACKET_OPS = new Set([...TEST_OPS, "==", "=", "!=", "=~", "<", ">"]);

/** test and `[`: an arithmetic operator's operands only as integer literals (§0b.1 item 9). */
function integerOperands(values: readonly (string | null)[]): ReasonCode | null {
  for (let index = 0; index < values.length; index += 1) {
    if (!ARITHMETIC.has(values[index] ?? "")) continue;
    const sides = [values[index - 1], values[index + 1]];
    if (!sides.every((side) => side !== null && side !== undefined && /^-?[0-9]+$/.test(side))) return "unknown_option";
  }
  return null;
}

/** `[[`: operators and operands; string comparison operators are not in the options list (r2). */
function bracketOperands(values: readonly (string | null)[]): ReasonCode | null {
  const intCheck = integerOperands(values);
  if (intCheck !== null) return intCheck;
  // Accept listed operators and string literals (not starting with -).
  for (const value of values) {
    if (value === null || value === undefined) continue;
    if (BRACKET_OPS.has(value)) continue;
    if (!value.startsWith("-")) continue;
    return "unknown_option";
  }
  return null;
}

/** export: only variables a child may get (§3.3, CHILD_VARIABLES). */
function exported(values: readonly (string | null)[], walked: Walk): ReasonCode | null {
  for (const at of walked.operands) {
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(values[at] ?? "")?.[0];
    if (name === undefined || !childVariable(name)) return "unknown_option";
  }
  return null;
}

/** jq's filter: `import` and `include` read module files from a search path (`~/.jq`). */
function jqFilter(values: readonly (string | null)[], walked: Walk): ReasonCode | null {
  const filter = walked.operands[0];
  if (filter === undefined) return null;
  const text = values[filter];
  return text === null || text === undefined || /\b(?:import|include)\b/.test(text) ? "program_io" : null;
}

/** `git checkout -- <paths>` only. */
function checkoutPaths(values: readonly (string | null)[], walked: Walk): ReasonCode | null {
  const first = walked.operands[0] ?? walked.options[0]?.wordIndex;
  const dashes = values.indexOf("--");
  return dashes !== -1 && (first === undefined || dashes < first) && walked.options.length === 0 ? null : "unknown_option";
}

/** `git branch` to list: operands only as `--list` patterns. */
function branchList(_values: readonly (string | null)[], walked: Walk): ReasonCode | null {
  if (walked.operands.length === 0) return null;
  return walked.options.some((found) => found.key === "--list" || found.key === "-l") ? null : "unknown_option";
}

/**
 * npm install: a spec that is not a path (a registry name, `@scope/pkg`, a
 * remote one) is fetched code whose lifecycle scripts run (§0b.1 item 7). With
 * no spec it installs package.json's, which a call may have added: only with
 * --ignore-scripts is that no code.
 */
function localPackages(values: readonly (string | null)[], walked: Walk): ReasonCode | null {
  if (walked.operands.length === 0) return scriptsIgnored(values, walked);
  const path = (spec: string | null | undefined) => typeof spec === "string" && !remoteSpec(spec) && /^(?:\.\.?(?:[\\/]|$)|[\\/~]|[A-Za-z]:[\\/])/.test(spec);
  return walked.operands.every((at) => path(values[at])) ? null : "nested_interpreter";
}

/** npm ci, and install with no spec: the lockfile's packages are fetched, and their scripts run unless --ignore-scripts. */
function scriptsIgnored(values: readonly (string | null)[], _walked: Walk): ReasonCode | null {
  return values.includes("--ignore-scripts") ? null : "nested_interpreter";
}

/** bash and sh: a script operand with no slash may be found on PATH when cwd has none (bash(1) ARGUMENTS). */
function scriptOnFile(values: readonly (string | null)[], walked: Walk): ReasonCode | null {
  const script = walked.operands[0] === undefined ? undefined : values[walked.operands[0]];
  return typeof script === "string" && script !== "-" && !/[\\/]/.test(script) ? "unknown_command" : null;
}

/**
 * node --test-reporter: a name other than a built-in reporter is a module node resolves and loads.
 * Node 24 expands a --test operand as a glob itself, braces included (`'{..,src}/*.test.js'`, r2).
 */
function builtinReporters(values: readonly (string | null)[], walked: Walk): ReasonCode | null {
  const test = walked.options.some((found) => found.key === "--test");
  if (test && walked.operands.some((at) => /[*?[\]{}!]/.test(values[at] ?? ""))) return "glob";
  for (const found of walked.options) {
    if (found.key !== "--test-reporter") continue;
    const name = found.attached ?? (found.valueIndex === null ? null : values[found.valueIndex]);
    if (!["spec", "tap", "dot", "junit", "lcov"].includes(name ?? "")) return "nested_interpreter";
  }
  return null;
}

/** set: only -e, -u, -x and -o with pipefail, errexit, nounset or xtrace (§0b.1 item 10); no positional parameters. */
function shellOptions(values: readonly (string | null)[], walked: Walk): ReasonCode | null {
  if (walked.operands.length > 0) return "unknown_option";
  const names = ["pipefail", "errexit", "nounset", "xtrace"];
  for (const found of walked.options) {
    if (found.key !== "-o" && found.key !== "+o") continue;
    const name = found.attached ?? (found.valueIndex === null ? null : values[found.valueIndex]);
    if (!names.includes(name ?? "")) return "unknown_option";
  }
  return null;
}

/** dirs: no operand (`+N` and `-N` are not listed). */
function noOperands(_values: readonly (string | null)[], walked: Walk): ReasonCode | null {
  return walked.operands.length === 0 ? null : "unknown_option";
}

/** `command` only to look a name up: `-v` or `-V`. */
function lookupOnly(_values: readonly (string | null)[], walked: Walk): ReasonCode | null {
  return walked.options.some((found) => found.key === "-v" || found.key === "-V") ? null : "unknown_option";
}

/** npx's `-p`/`--package` specs: a remote one is code. */
function localSpecs(values: readonly (string | null)[], walked: Walk): ReasonCode | null {
  for (const found of walked.options) {
    if (found.key !== "-p" && found.key !== "--package") continue;
    const spec = found.attached ?? (found.valueIndex === null ? null : values[found.valueIndex]);
    if (spec === null || spec === undefined || remoteSpec(spec)) return "nested_interpreter";
  }
  return null;
}

// ---------------------------------------------------------------------------
// The entries (§0b.1 item 9's initial table). tsc is not one (r2): the tsconfig it finds by
// walking up, or one the run wrote, decides what it reads and writes.

const GREP = entry(
  "GNU grep 3 `grep --help`",
  "-E -F -G -P -i -y -w -x -z -s -v -V -c -l -L -o -q -b -H -h -n -T -Z -r -R -a -I -U " +
    "-e: -f:p -m: -A: -B: -C: -d: -D: " +
    "--extended-regexp --fixed-strings --basic-regexp --perl-regexp --ignore-case --no-ignore-case --word-regexp " +
    "--line-regexp --null-data --no-messages --invert-match --version --help --count --files-with-matches " +
    "--files-without-match --only-matching --quiet --silent --byte-offset --with-filename --no-filename --line-number " +
    "--initial-tab --null --recursive --dereference-recursive --text --line-buffered --no-group-separator " +
    "--regexp: --file:p --max-count: --context: --after-context: --before-context: --label: --binary-files: " +
    "--devices: --directories: --include: --exclude: --exclude-dir: --exclude-from:p --group-separator: --color? --colour?",
  "the first is the pattern (data) unless -e or -f gives one; then paths",
  { numeric: true },
);

const NPM_GLOBAL = "-s -q -d --silent --quiet --loglevel: --no-color --color: --yes -y --no-audit --no-fund --no-update-notifier --prefer-offline --offline --ignore-scripts";
const npm = (options: string, operands: string, rest: Omit<Entry, "source" | "options" | "operands"> = {}) =>
  entry("npm 10 `npm help <command>`", `${NPM_GLOBAL} ${options}`, operands, rest);
const NPM_TEST = npm("--if-present", "words after `--` go to the script (a script on file, D8)");
const NPM_RUN = npm("--if-present", "the script's name (data), then its arguments");
const NPM_INSTALL = npm(
  "-D -E -O -P -S -B --save --save-dev --save-exact --save-optional --save-prod --save-bundle --no-save --legacy-peer-deps --no-package-lock --package-lock-only --omit:",
  "package specs (a remote one is code, §0b.1 item 7)",
  { check: localPackages },
);
const NPM_CI = npm("--omit: --legacy-peer-deps", "none", { check: scriptsIgnored });
const NPM_LS = npm("-a -l -p --all --long --parseable --json --depth:", "package names (data)");

const GIT_LOG =
  "-p -u -s -i -E -F -U? -M? --oneline --graph --all --decorate? --no-decorate --stat? --shortstat --numstat --patch --no-patch " +
  "--name-only --name-status --reverse --no-merges --merges --first-parent --follow --abbrev-commit --abbrev? --left-right " +
  "--topo-order --date-order --source --no-color --color? --regexp-ignore-case --summary --raw -n: --max-count: --skip: " +
  "--format: --pretty? --since: --until: --after: --before: --author: --committer: --grep: --date: -S: -G: --unified:";
const GIT_DIFF =
  "-p -u -s -z -w -b -a -R -U? -M? -C? --cached --staged --stat? --shortstat --numstat --summary --patch --no-patch --raw " +
  "--name-only --name-status --no-color --color? --word-diff? --color-words? --exit-code --quiet --check --minimal --patience " +
  "--histogram --no-renames --text --ignore-all-space --ignore-space-change --ignore-blank-lines --ignore-cr-at-eol " +
  "--no-prefix --merge-base --relative? --unified: --diff-filter: --src-prefix: --dst-prefix:";
const git = (options: string, operands: string, rest: Omit<Entry, "source" | "options" | "operands"> = {}) =>
  entry("git 2.4x git-<command>(1)", options, operands, rest);

const SHELL = entry(
  "GNU bash 5.2 bash(1) OPTIONS",
  "-e -u -x -v -n -f -c:c -s! -o: -O: +e +u +x +v +f +o: +O: --norc --noprofile --posix --version --help",
  "the script (a path, D8), then its arguments",
  { script: true, plus: true, stdin: "code", noStdin: ["-n", "--version", "--help"], check: scriptOnFile },
);
const PYTHON = entry(
  "CPython 3.12 `python3 --help`",
  "-c:c -u -B -E -s -S -I -O -q -b -V -h -W: -X: --version --help",
  "the script (a path, D8), then its arguments; `-` is stdin",
  { script: true, stdin: "code", noStdin: ["-V", "-h", "--version", "--help"] },
);
const TEST = entry(
  "GNU bash 5.2 `help test`",
  "-a -b -c -d -e -f -g -h -k -p -r -s -t -u -w -x -G -L -N -O -S -z -n -o " +
    "-eq -ne -lt -le -gt -ge -nt -ot -ef",
  "strings and paths; an arithmetic operator's operands only as integer literals",
  { words: true, builtin: true, check: integerOperands },
);
const BRACKET_BRACKET = entry(
  "GNU bash 5.2 `help [[` (the operators of `help test`)",
  "",
  "strings and paths; operators and operands (data marked by calls.ts); an arithmetic operator's operands only as integer literals",
  { lenient: true, builtin: true, check: bracketOperands },
);

export const TABLE: Readonly<Record<string, Entry>> = {
  // Shell builtins
  cd: entry("GNU bash 5.2 `help cd`", "", "the target (§3.4)", { own: true, builtin: true }),
  pushd: entry("GNU bash 5.2 `help pushd`", "", "the target (§3.4)", { own: true, builtin: true }),
  popd: entry("GNU bash 5.2 `help popd`", "", "none (§3.4)", { own: true, builtin: true }),
  pwd: entry("GNU bash 5.2 `help pwd`", "-L -P", "none", { builtin: true }),
  true: entry("GNU bash 5.2 `help true`", "", "ignored", { lenient: true, builtin: true }),
  false: entry("GNU bash 5.2 `help false`", "", "ignored", { lenient: true, builtin: true }),
  exit: entry("GNU bash 5.2 `help exit`", "", "a status (data)", { numeric: true, builtin: true }),
  echo: entry("GNU bash 5.2 `help echo`", "", "data (an unknown -x is printed)", { lenient: true, builtin: true }),
  printf: entry("GNU bash 5.2 `help printf`", "", "the format, then its arguments (data); -v is not listed", { script: true, builtin: true }),
  test: TEST,
  "[": TEST,
  "[[": BRACKET_BRACKET,
  set: entry("GNU bash 5.2 `help set`", "-e -u -x -o: +e +u +x +o:", "none (positional parameters are not listed)", {
    plus: true,
    builtin: true,
    check: shellOptions,
  }),
  ":": entry("GNU bash 5.2 `help :`", "", "ignored (read as words)", { lenient: true, builtin: true }),
  dirs: entry("GNU bash 5.2 `help dirs`", "-v -p -l", "none", { builtin: true, check: noOperands }),
  export: entry("GNU bash 5.2 `help export`", "-n -p", "NAME or NAME=VALUE of a child variable (§3.3)", { builtin: true, check: exported }),
  command: entry("GNU bash 5.2 `help command`", "-p -v -V", "names to look up (data); only with -v or -V", { builtin: true, check: lookupOnly }),
  type: entry("GNU bash 5.2 `help type`", "-a -f -p -P -t", "names (data)", { builtin: true }),

  // File tools
  ls: entry(
    "GNU coreutils 9 `ls --help`",
    "-a -A -b -B -c -C -d -f -F -g -G -h -H -i -k -l -L -m -n -N -o -p -q -Q -r -R -s -S -t -u -U -v -x -X -Z -1 " +
      "-w: -T: -I: --all --almost-all --escape --ignore-backups --directory --classify? --file-type --human-readable --si " +
      "--inode --dereference --dereference-command-line --numeric-uid-gid --literal --hide-control-chars --show-control-chars " +
      "--quote-name --reverse --recursive --size --group-directories-first --no-group --full-time --help --version --color? " +
      "--hyperlink? --sort: --time: --time-style: --format: --width: --tabsize: --indicator-style: --quoting-style: " +
      "--block-size: --hide: --ignore:",
    "paths",
  ),
  cat: entry(
    "GNU coreutils 9 `cat --help`",
    "-A -b -e -E -n -s -t -T -u -v --show-all --number-nonblank --number --squeeze-blank --show-ends --show-tabs --show-nonprinting --help --version",
    "paths",
  ),
  head: entry(
    "GNU coreutils 9 `head --help`",
    "-c: -n: -q -v -z --bytes: --lines: --quiet --silent --verbose --zero-terminated --help --version",
    "paths",
    { numeric: true },
  ),
  tail: entry(
    "GNU coreutils 9 `tail --help`",
    "-c: -n: -f -F -q -v -z -s: --bytes: --lines: --follow? --pid: --quiet --silent --retry --sleep-interval: --verbose --zero-terminated --help --version",
    "paths",
    { numeric: true },
  ),
  wc: entry("GNU coreutils 9 `wc --help`", "-c -m -l -L -w --bytes --chars --lines --max-line-length --words --total: --help --version", "paths"),
  grep: GREP,
  egrep: GREP,
  fgrep: GREP,
  rg: entry(
    "ripgrep 14 `rg --help`",
    "-i -s -S -w -x -v -c -l -n -N -F -U -u -L -H -I -o -q -z -a -0 -p -b " +
      "-e: -f:p -g: -t: -T: -m: -A: -B: -C: -d: -r: -j: -M: -E: " +
      "--ignore-case --case-sensitive --smart-case --word-regexp --line-regexp --invert-match --count --count-matches " +
      "--files-with-matches --files-without-match --line-number --no-line-number --fixed-strings --multiline --unrestricted " +
      "--follow --with-filename --no-filename --only-matching --quiet --search-zip --text --null --pretty --byte-offset " +
      "--hidden --no-ignore --no-ignore-vcs --no-ignore-dot --no-ignore-parent --files --json --vimgrep --heading --no-heading " +
      "--stats --trim --passthru --column --no-column --sort-files --glob-case-insensitive --no-messages --no-config --help --version " +
      "--regexp: --file:p --glob: --iglob: --type: --type-not: --max-count: --after-context: --before-context: --context: " +
      "--max-depth: --replace: --threads: --max-columns: --max-filesize: --encoding: --engine: --sort: --sortr: --color: " +
      "--colors: --context-separator: --path-separator: --pre:c --pre-glob:",
    "the first is the pattern (data) unless -e or -f gives one; then paths",
  ),
  find: entry(
    "GNU findutils 4.9 find(1) TESTS, OPERATORS and -print/-print0/-delete",
    "-H -L -P -name: -iname: -path: -ipath: -wholename: -iwholename: -regex: -iregex: -lname: -ilname: -regextype: " +
      "-type: -xtype: -maxdepth: -mindepth: -size: -mtime: -mmin: -atime: -amin: -ctime: -cmin: -newer:p -anewer:p " +
      "-cnewer:p -samefile:p -newermt: -perm: -user: -group: -uid: -gid: -links: -inum: -used: -empty -prune -print " +
      "-print0 -delete -quit -true -false -readable -writable -executable -nouser -nogroup -depth -mount -xdev -noleaf " +
      "-follow -daystart -ignore_readdir_race -nowarn -warn -a -o -and -or -not -exec! -execdir! -ok! -okdir!",
    "the starting paths, then the expression; match patterns are data (§4.2)",
    { words: true },
  ),
  sed: entry(
    "GNU sed 4.9 `sed --help`",
    "-n -E -r -s -z -u -b -i? -e: -l: --quiet --silent --regexp-extended --separate --null-data --unbuffered --binary " +
      "--posix --debug --sandbox --follow-symlinks --in-place? --expression: --line-length: --help --version",
    "the script (data by §4.2, -e values else the first operand), then paths; -f is not listed",
  ),
  awk: entry("POSIX awk; gawk 5 `awk --help` (§0b.1 item 9: -F and -v only)", "-F: -v:", "the program (data by §4.2), then paths"),
  cut: entry(
    "GNU coreutils 9 `cut --help`",
    "-b: -c: -d: -f: -n -s -z --bytes: --characters: --delimiter: --fields: --complement --only-delimited --output-delimiter: --zero-terminated --help --version",
    "paths",
  ),
  sort: entry(
    "GNU coreutils 9 `sort --help`",
    "-b -d -f -g -h -i -M -n -R -r -s -u -V -z -c -C -m -k: -t: -o:p -S: -T:p " +
      "--ignore-leading-blanks --dictionary-order --ignore-case --general-numeric-sort --human-numeric-sort --ignore-nonprinting " +
      "--month-sort --numeric-sort --random-sort --reverse --version-sort --stable --unique --zero-terminated --merge --debug " +
      "--check? --key: --field-separator: --output:p --buffer-size: --temporary-directory:p --parallel: --sort: --help --version",
    "paths",
  ),
  uniq: entry(
    "GNU coreutils 9 `uniq --help`",
    "-c -d -D -u -i -z -f: -s: -w: --count --repeated --unique --ignore-case --zero-terminated --all-repeated? --group? " +
      "--skip-fields: --skip-chars: --check-chars: --help --version",
    "input, then output path",
  ),
  diff: entry(
    "GNU diffutils 3 `diff --help`",
    "-q -s -c -u -e -n -y -t -T -p -i -E -Z -b -w -B -a -r -N -d -C: -U: -W: -I: -x: -X:p -S: -F: -L: " +
      "--brief --report-identical-files --context? --unified? --ed --rcs --side-by-side --expand-tabs --initial-tab " +
      "--show-c-function --ignore-case --ignore-tab-expansion --ignore-trailing-space --ignore-space-change --ignore-all-space " +
      "--ignore-blank-lines --text --recursive --new-file --unidirectional-new-file --minimal --speed-large-files --normal " +
      "--strip-trailing-cr --suppress-common-lines --no-dereference --color? --width: --ignore-matching-lines: --exclude: " +
      "--exclude-from:p --starting-file: --show-function-line: --label: --from-file:p --to-file:p --help --version",
    "paths",
  ),
  cmp: entry(
    "GNU diffutils 3 `cmp --help`",
    "-b -l -s -i: -n: --print-bytes --verbose --silent --quiet --ignore-initial: --bytes: --help --version",
    "paths",
  ),
  cp: entry(
    "GNU coreutils 9 `cp --help`",
    "-a -b -d -f -i -H -l -L -n -P -p -R -r -s -T -u -v -x -S: -t:p " +
      "--archive --backup? --force --interactive --link --dereference --no-clobber --no-dereference --preserve? --no-preserve: " +
      "--parents --recursive --remove-destination --sparse: --strip-trailing-slashes --symbolic-link --suffix: " +
      "--target-directory:p --no-target-directory --update? --verbose --one-file-system --reflink? --help --version",
    "paths",
  ),
  mv: entry(
    "GNU coreutils 9 `mv --help`",
    "-b -f -i -n -T -u -v -S: -t:p --backup? --force --interactive --no-clobber --strip-trailing-slashes --suffix: " +
      "--target-directory:p --no-target-directory --update? --verbose --help --version",
    "paths",
  ),
  rm: entry(
    "GNU coreutils 9 `rm --help`",
    "-f -i -I -r -R -d -v --force --interactive? --one-file-system --recursive --dir --verbose --help --version",
    "paths",
  ),
  mkdir: entry("GNU coreutils 9 `mkdir --help`", "-m: -p -v --mode: --parents --verbose --help --version", "paths"),
  rmdir: entry("GNU coreutils 9 `rmdir --help`", "-p -v --ignore-fail-on-non-empty --parents --verbose --help --version", "paths"),
  touch: entry(
    "GNU coreutils 9 `touch --help`",
    "-a -c -f -h -m -d: -r:p -t: --no-create --no-dereference --date: --reference:p --time: --help --version",
    "paths",
  ),
  chmod: entry(
    "GNU coreutils 9 `chmod --help`",
    "-c -f -v -R -r -w -x -X -s -t --changes --silent --quiet --verbose --recursive --preserve-root --reference:p --help --version",
    "a mode (data; `-x` is one), then paths",
  ),
  tee: entry("GNU coreutils 9 `tee --help`", "-a -i -p --append --ignore-interrupts --output-error? --help --version", "paths written"),
  tr: entry(
    "GNU coreutils 9 `tr --help`",
    "-c -C -d -s -t --complement --delete --squeeze-repeats --truncate-set1 --help --version",
    "sets (data, §0b.1 item 3)",
  ),
  basename: entry("GNU coreutils 9 `basename --help`", "-a -z -s: --multiple --zero --suffix: --help --version", "names"),
  dirname: entry("GNU coreutils 9 `dirname --help`", "-z --zero --help --version", "names"),
  stat: entry(
    "GNU coreutils 9 `stat --help`",
    "-L -f -t -c: --dereference --file-system --terse --format: --printf: --cached: --help --version",
    "paths",
  ),
  du: entry(
    "GNU coreutils 9 `du --help`",
    "-a -b -c -h -H -k -L -l -m -P -s -S -x -0 -d: -B: -t: -X:p --all --apparent-size --bytes --total --human-readable --si " +
      "--dereference --count-links --no-dereference --summarize --separate-dirs --one-file-system --null --inodes " +
      "--max-depth: --block-size: --threshold: --time? --time-style: --exclude: --exclude-from:p --help --version",
    "paths",
  ),
  file: entry(
    "file 5.4x file(1)",
    "-b -c -E -h -i -k -L -N -n -p -r -s -z -Z -0 -e: -F: -P: -m:p --brief --mime --mime-type --mime-encoding --dereference " +
      "--no-dereference --keep-going --raw --special-files --uncompress --uncompress-noreport --print0 --no-pad --no-buffer " +
      "--preserve-date --extension --apple --exclude: --separator: --parameter: --magic-file:p --help --version",
    "paths",
  ),
  od: entry(
    "GNU coreutils 9 `od --help`",
    "-a -b -c -d -f -i -l -o -s -x -v -S? -w? -A: -j: -N: -t: --address-radix: --skip-bytes: --read-bytes: --format: " +
      "--strings? --width? --output-duplicates --endian: --traditional --help --version",
    "paths",
  ),
  xxd: entry(
    "xxd (vim 9) xxd(1)",
    "-a -autoskip -b -bits -C -capitalize -d -e -E -EBCDIC -h -help -i -include -p -ps -postscript -plain -r -revert -u -v -version " +
      "-c: -cols: -g: -groupsize: -l: -len: -n: -name: -o: -offset: -s: -seek: -R:",
    "input path, then output path",
    { words: true },
  ),
  jq: entry(
    "jq 1.7 manual, Invoking jq",
    "-r -j -c -n -e -s -S -C -M -a -R --raw-output --raw-output0 --join-output --compact-output --null-input --exit-status " +
      "--slurp --sort-keys --color-output --monochrome-output --ascii-output --raw-input --tab --seq --stream --args --jsonargs " +
      "--indent: --arg:2 --argjson:2 --slurpfile:2p --rawfile:2p --help --version",
    "the filter (data; import and include read modules), then paths",
    { check: jqFilter },
  ),
  sleep: entry("GNU coreutils 9 `sleep --help`", "--help --version", "durations (data)"),
  date: entry(
    "GNU coreutils 9 `date --help`",
    "-u -R -I? -d: -r:p --utc --universal --rfc-email --debug --iso-8601? --rfc-3339: --date: --reference:p --help --version",
    "+FORMAT (data)",
  ),
  seq: entry("GNU coreutils 9 `seq --help`", "-w -f: -s: --equal-width --format: --separator: --help --version", "numbers (data)", { numeric: true }),
  which: entry("GNU which 2 `which --help`", "-a -s", "names (data)"),

  // Runtimes on a script file (D8)
  node: entry(
    "Node.js 24 `node --help`",
    "-e:c -p:c -c -v -h --eval:c --print:c --test --check --test-only --test-force-exit --experimental-test-coverage " +
      "--no-warnings --enable-source-maps --trace-warnings --trace-uncaught --experimental-strip-types --no-experimental-strip-types " +
      "--experimental-vm-modules --version --help --test-reporter: --test-reporter-destination:p --test-name-pattern: " +
      "--test-skip-pattern: --test-concurrency: --test-timeout: --max-old-space-size? --stack-trace-limit?",
    "the script (a path, D8), then its arguments; with --test, test files",
    { script: true, stdin: "code", noStdin: ["--test", "--check", "-c", "-v", "--version", "-h", "--help"], check: builtinReporters },
  ),
  npm: entry("npm 10 `npm help`", `${NPM_GLOBAL} -v -h --version --help`, "the subcommand", {
    sub: {
      test: NPM_TEST, t: NPM_TEST, tst: NPM_TEST, run: NPM_RUN, "run-script": NPM_RUN,
      install: NPM_INSTALL, i: NPM_INSTALL, add: NPM_INSTALL, ci: NPM_CI, "clean-install": NPM_CI,
      ls: NPM_LS, list: NPM_LS, ll: NPM_LS, la: NPM_LS,
    },
  }),
  npx: entry(
    "npm 10 npx(1)",
    "-y -q --yes --no --quiet -p: --package: -c:c --call:c",
    "a package: fetched when no local bin has its name, so every one is unresolved (runProgram)",
    { program: true, check: localSpecs },
  ),
  sh: SHELL,
  bash: SHELL,
  python: PYTHON,
  python3: PYTHON,

  // git (§0b.1 item 9: -C takes a tested path; -c, --git-dir, --work-tree and config are not listed)
  git: entry("git 2.4x git(1)", "-C:p -P --no-pager --no-optional-locks --version --help", "the subcommand", {
    sub: {
      status: git(
        "-s -b -v -z -u? --short --branch --porcelain? --untracked-files? --ignored? --verbose --long --show-stash --no-renames --ahead-behind --no-ahead-behind",
        "pathspecs",
      ),
      diff: git(GIT_DIFF, "revisions and pathspecs"),
      log: git(GIT_LOG, "revisions and pathspecs", { numeric: true }),
      show: git(`${GIT_LOG} -q --quiet`, "objects (REV:path is data) and pathspecs"),
      add: git(
        "-A -u -N -f -n -v -p --all --update --intent-to-add --force --dry-run --verbose --ignore-errors --renormalize --patch",
        "pathspecs",
      ),
      commit: git(
        "-a -q -v -n -s -o -m: -F:p --all --amend --no-edit --allow-empty --allow-empty-message --quiet --verbose --no-verify --signoff --only " +
          "--message: --file:p --author: --date: --fixup: --cleanup:",
        "pathspecs; -m values are data (§0b.1 item 3)",
      ),
      restore: git(
        "-S -W -q -p -s: --staged --worktree --quiet --ours --theirs --patch --overlay --no-overlay --source:",
        "pathspecs",
      ),
      checkout: git("", "pathspecs, after `--` only", { check: checkoutPaths }),
      init: git("-q -b: --quiet --bare --initial-branch:", "a directory"),
      "rev-parse": git(
        "-q --show-toplevel --abbrev-ref? --short? --verify --quiet --git-dir --git-common-dir --absolute-git-dir --is-inside-work-tree " +
          "--is-inside-git-dir --is-bare-repository --show-prefix --show-cdup --symbolic-full-name --all",
        "revisions (data)",
      ),
      "ls-files": git(
        "-c -d -m -o -i -s -u -k -z -t -v -f -x: --cached --deleted --modified --others --ignored --stage --unmerged --killed " +
          "--directory --no-empty-directory --exclude-standard --full-name --error-unmatch --deduplicate --eol --exclude:",
        "pathspecs",
      ),
      branch: git(
        "-a -r -v -l -q --all --remotes --verbose --list --show-current --no-color --color? --column? --merged? --no-merged? --contains? --no-contains? --sort: --format:",
        "patterns, with --list only",
        { check: branchList },
      ),
    },
  }),
};

/** How many commands and options the table lists, entries shared by aliases counted once. */
export function tableSize(): { commands: number; options: number } {
  const seen = new Set<Entry>();
  let options = 0;
  const count = (table: Entry) => {
    if (seen.has(table)) return;
    seen.add(table);
    options += table.options.size;
    for (const sub of Object.values(table.sub ?? {})) count(sub);
  };
  Object.values(TABLE).forEach(count);
  return { commands: Object.keys(TABLE).length, options };
}
