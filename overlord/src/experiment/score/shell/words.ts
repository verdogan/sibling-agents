// Resolvable words (design spec §2.1-§2.4): a word resolves only if it is
// built from literal text, a tilde prefix, `%TEMP%`-style names, and plain
// `$NAME`/`${NAME}` of a known variable (exact case). Every other expansion
// makes it unresolved with the reason of its first offending part. Nothing is
// emulated: no brace expansion, no operator, no field splitting, no pattern.
import type { ChildContext } from "../paths.js";
import { gitBashForm, inWorkspace, inWorkspaceLoosely, isAbsolutePath, onAllowlist, resolveAgainst } from "../paths.js";
import type { ReasonCode } from "./reasons.js";
import { CAPS, literalText } from "./parse.js";
import type { Part, Verdict, Word } from "./syntax.js";
import { CANDIDATES, isUnknown, lookup, type Cwd, type Dirs, type State, type VarValue } from "./state.js";

/** The fixed name a glob component reads as (§2.4 rule 4): never `.`/`..`, no separator, no IFS or glob character. */
export const GLOB = "<glob>";

/**
 * Host paths a local child's bash holds that experiment.json does not record,
 * each a root outside every workspace (§1.5 item 6): local-provisioner's
 * SYSTEM_ENV_KEYS (and libuv's own on Windows), the ones it assigns
 * (PLAYWRIGHT_BROWSERS_PATH), LING_SETTING_KEYS' AGENT_BROWSER_BIN and the
 * credential files of a provider, Git Bash's launcher's EXEPATH, and bash's
 * own BASH and SHELL. Exact case, as Git Bash 5.2.37 holds them (checked with
 * `env` on the pilot box, 2026-10-09): it upper-cases SYSTEMROOT, WINDIR,
 * PROGRAMFILES, COMMONPROGRAMFILES, APPDATA, LOCALAPPDATA, COMSPEC, HOMEPATH
 * and keeps ProgramData, ProgramW6432 and CommonProgramW6432 as written.
 */
const HOST_PATHS = [
  "PATH",
  "BASH",
  "SHELL",
  "PLAYWRIGHT_BROWSERS_PATH",
  "AGENT_BROWSER_BIN",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
];
const HOST_DIRECTORIES = {
  windows: new Set([
    ...HOST_PATHS,
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMFILES",
    "COMMONPROGRAMFILES",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "HOMEPATH",
    "EXEPATH",
    "ProgramData",
    "ProgramW6432",
    "CommonProgramW6432",
  ]),
  posix: new Set([...HOST_PATHS, "XDG_RUNTIME_DIR"]),
};

/** §2.3's test, applied to a word as written and to its value(s). */
export function pathLike(text: string, windows: boolean): boolean {
  return (
    text.includes("/") ||
    text.includes("\\") ||
    /^[~$%]/.test(text) ||
    text === "." ||
    text === ".." ||
    (windows && /^[A-Za-z]:/.test(text))
  );
}

export interface WordContext {
  child: ChildContext;
  state: State;
}

export interface WordOptions {
  /** An assignment's value: tilde also after each `:`; no brace expansion, splitting or globbing. */
  assignment?: boolean;
  /** A word whose text before its first `=` is a NAME (`dd if=~/k`): tilde also after that `=` and each `:`. */
  equalsTilde?: boolean;
  /** No tilde prefix at all (an option value: `--x=~/a` keeps its `~`). */
  noTilde?: boolean;
}

export type Resolution =
  | {
      ok: true;
      /** One string per combination, at most CANDIDATES; glob components read as GLOB. */
      values: string[];
      /** Where several values came from: the cwd candidates, or a variable's value set. */
      multi: "cwd" | "var" | null;
      /** Whether an unquoted expansion contributed. */
      expanded: boolean;
      /** A `%NAME%` the reader does not know: unresolved if the word is tested. */
      soft: ReasonCode | null;
      /** §2.4 rules 1-3 hit in some component. */
      globBad: boolean;
      /** A3: the first component is a glob starting with a literal `.` or a bracket expression. */
      bareGlobBad: boolean;
    }
  | { ok: false; reason: ReasonCode };

interface Piece {
  alternatives: readonly string[];
  source: "cwd" | "var" | null;
}

const STAR = "\u0001";
const QUESTION = "\u0002";
const BRACKET = "\u0003";
const SENTINEL = /[\u0001-\u0003]/;

/** A directory as bash holds it in PWD and OLDPWD: on Windows Git Bash's `/c/…` form. */
function spelled(directory: string, child: ChildContext): string {
  return child.windows ? gitBashForm(directory) : directory;
}

function dirs(value: Dirs, child: ChildContext): Piece {
  return { alternatives: value.map((dir) => spelled(dir, child)), source: "cwd" };
}

function assigned(value: VarValue, atStart: boolean): Piece | ReasonCode {
  if (isUnknown(value)) return value.unknown;
  if ("safe" in value) {
    // §0b.1 item 1: a value that may start with `-` is not safe at a word's start.
    if (atStart && !value.safe.lead) return "unknown_variable";
    return { alternatives: ["0"], source: null };
  }
  return { alternatives: value.values, source: "var" };
}

/** `$NAME` / `${NAME}` (§2.1, §2.2). */
function variable(part: Extract<Part, { kind: "var" }>, context: WordContext, atStart: boolean): Piece | ReasonCode {
  const { child, state } = context;
  const name = part.name;
  if (part.op !== null || name === "") return "parameter_operator";
  // The never-a-path specials read as a digit (§0b.1 item 2: `$!` is not one).
  if (name === "?" || name === "#" || name === "$" || name === "-") return { alternatives: ["0"], source: null };
  if (name === "!" || name === "@" || name === "*" || name === "_" || /^[0-9]+$/.test(name)) return "unknown_variable";
  const value = lookup(state, name);
  if (value !== undefined) return assigned(value, atStart);
  switch (name) {
    case "HOME":
      return { alternatives: [child.shell.home], source: null };
    case "TEMP":
    case "TMP":
    case "TMPDIR":
      return { alternatives: [child.shell.tmp], source: null };
    case "USERPROFILE":
      // A recorded name the child does not hold reads as empty.
      return {
        alternatives: [isAbsolutePath(child.userProfile, child.windows) ? child.shell.userProfile : ""],
        source: null,
      };
    case "PWD":
      return isUnknown(state.cwd) ? "cwd_unknown" : dirs(state.cwd, child);
    case "OLDPWD":
      if (state.prev === "unset") return { alternatives: [""], source: null };
      return isUnknown(state.prev) ? state.prev.unknown : dirs(state.prev, child);
  }
  if ((child.windows ? HOST_DIRECTORIES.windows : HOST_DIRECTORIES.posix).has(name)) {
    // Not read: a root of its own, outside every workspace by definition.
    return { alternatives: [`/<host:${name}>`], source: null };
  }
  return "unknown_variable";
}

/** A tilde prefix (§2.1): `~`, `~+`, `~-`; any other form is `tilde_form`. */
function tilde(prefix: string, context: WordContext): Piece | ReasonCode {
  const { child, state } = context;
  if (prefix === "~") {
    const home = lookup(state, "HOME");
    return home === undefined ? { alternatives: [child.shell.home], source: null } : assigned(home, false);
  }
  if (prefix === "~+") {
    // `~+` is $PWD: an assignment to PWD in the call is what it reads then.
    const pwd = lookup(state, "PWD");
    if (pwd !== undefined) return assigned(pwd, false);
    return isUnknown(state.cwd) ? "cwd_unknown" : dirs(state.cwd, child);
  }
  if (prefix === "~-") {
    // OLDPWD unset: bash leaves `~-` as written.
    if (state.prev === "unset") return { alternatives: ["~-"], source: null };
    return isUnknown(state.prev) ? state.prev.unknown : dirs(state.prev, child);
  }
  return "tilde_form";
}

/** Whether `$(( … ))` is R1-safe: integer literals and integer-valued variables only. */
function safeArithmetic(word: Word, state: State): boolean {
  const integer = (name: string) => {
    const value = lookup(state, name);
    if (value === undefined || isUnknown(value)) return false;
    if ("safe" in value) return value.safe.int;
    return value.values.every((text) => /^-?[0-9]+$/.test(text));
  };
  return word.parts.every((part) => {
    if (part.kind === "lit") return [...part.text.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)].every((match) => integer(match[0]));
    return part.kind === "var" && part.op === null && /^[A-Za-z_]/.test(part.name) && integer(part.name);
  });
}

const ARITHMETIC_ASSIGNMENT = /(?:^|[^=!<>])=(?!=)|[-+*/%&^|]=|<<=|>>=|\+\+|--/;

/**
 * Whether an arithmetic context cannot assign (§3.3): no assignment operator,
 * and every name in it holds an integer literal (bash evaluates a value
 * recursively, so `Y='X=1'; ((Y))` assigns X).
 */
export function pureArithmetic(word: Word, state: State): boolean {
  const literal = word.parts.map((part) => (part.kind === "lit" ? part.text : " ")).join("");
  return !ARITHMETIC_ASSIGNMENT.test(literal) && safeArithmetic(word, state);
}

/** Whether a known value, used in an arithmetic or computed-name context, would run a hidden `$( )`/backquote (D6). */
export function valueRunsCode(value: VarValue | undefined): boolean {
  return value !== undefined && !isUnknown(value) && !("safe" in value) && value.values.some((text) => /[`$]/.test(text));
}

/**
 * Whether an arithmetic context names a variable whose in-call value bash would
 * evaluate as code (a subscript or value holding `$( )`): `((a))`, `$((a))`,
 * `let a`, `[[ a -eq 0 ]]`, `${b[a]}`, `declare -i n; n=a`. A sound widening:
 * a plain integer value never holds `$` or a backquote.
 */
export function arithmeticRunsCode(word: Word, state: State): boolean {
  const names: string[] = [];
  const collect = (inner: Word): void => {
    for (const part of inner.parts) {
      if (part.kind === "lit") for (const match of part.text.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) names.push(match[0]);
      else if (part.kind === "var") {
        if (part.op === null && /^[A-Za-z_]/.test(part.name)) names.push(part.name);
        if (part.inner !== null) collect(part.inner);
      } else if (part.kind === "arith") collect(part.inner);
    }
  };
  collect(word);
  return names.some((name) => valueRunsCode(lookup(state, name)));
}

/**
 * The part index of the first `{` that may open a brace expansion (§2.1: an
 * unquoted `{` with a matching unquoted `}` and an unquoted `,` or `..`
 * between), or -1. Bash's `}` closes a list only after a separator, so
 * `{a}x,..}` is one list: the scan flags any unquoted `{`, then `,` or `..`,
 * then `}`, in that order. One pass; it may over-flag, never under-flag.
 */
export function braceAt(word: Word): number {
  let open = -1;
  let separated = false;
  for (let index = 0; index < word.parts.length; index += 1) {
    const part = word.parts[index]!;
    if (part.kind !== "lit" || part.quote !== "none") continue;
    const text = part.text;
    for (let at = 0; at < text.length; at += 1) {
      const char = text[at];
      if (char === "\\") at += 1;
      else if (char === "{") open = open === -1 ? index : open;
      else if (open !== -1 && (char === "," || (char === "." && text[at + 1] === "."))) separated = true;
      else if (char === "}" && separated) return open;
    }
  }
  return -1;
}

/** Unquoted literal text with its glob characters marked (§2.4); `after` is the word's text that follows. */
function markGlobs(text: string, laterClose: boolean): string {
  // A `[` with a `]` after it anywhere later in the word is read as a bracket
  // expression: wider than bash (which needs the `]` in the same component),
  // and one scan (D10). Glob components only ever widen the reading.
  const lastClose = text.lastIndexOf("]");
  let marked = "";
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at]!;
    if (char === "\\" && at + 1 < text.length) {
      marked += text.slice(at, at + 2);
      at += 1;
    } else if (char === "*") marked += STAR;
    else if (char === "?") marked += QUESTION;
    else if (char === "[") marked += lastClose > at + 1 || laterClose ? BRACKET : "[";
    else marked += char;
  }
  return marked;
}

/** `%TEMP%`, `%TMP%`, `%USERPROFILE%` (exact upper case) read as the variable on purpose (§1.5); other `%NAME%` unknown. */
function percent(
  text: string,
  child: ChildContext,
  glob: ((literal: string, laterClose: boolean) => string) | null,
  laterClose = false,
): { text: string; soft: boolean } {
  if (!text.includes("%")) return { text: glob === null ? text : glob(text, laterClose), soft: false };
  let soft = false;
  let out = "";
  let last = 0;
  const lastClose = text.lastIndexOf("]");
  for (const match of text.matchAll(/%([A-Za-z_][A-Za-z0-9_]*)%/g)) {
    const literal = text.slice(last, match.index);
    out += glob === null ? literal : glob(literal, laterClose || lastClose >= match.index);
    const name = match[1]!;
    if (name === "TEMP" || name === "TMP") out += child.tmp;
    else if (name === "USERPROFILE") out += isAbsolutePath(child.userProfile, child.windows) ? child.userProfile : "";
    else {
      soft = true;
      out += match[0];
    }
    last = match.index + match[0].length;
  }
  const rest = text.slice(last);
  return { text: out + (glob === null ? rest : glob(rest, laterClose)), soft };
}

/** An unquoted literal part as pieces: text, tilde prefixes (§2.1), `%NAME%` names, glob marks. */
function unquoted(
  word: Word,
  index: number,
  context: WordContext,
  options: WordOptions,
  closeAfter: boolean,
): { pieces: Piece[]; soft: boolean } | ReasonCode {
  const part = word.parts[index] as Extract<Part, { kind: "lit" }>;
  const text = part.text;
  const plain = options.assignment === true;
  const colons = plain || options.equalsTilde === true;
  const equalsAt = options.equalsTilde === true && index === 0 ? text.indexOf("=") : -1;
  const lastClose = text.lastIndexOf("]");
  const pieces: Piece[] = [];
  let soft = false;
  let chunk = "";
  const flush = (laterClose: boolean) => {
    if (chunk === "") return;
    const read = percent(chunk, context.child, plain ? null : markGlobs, laterClose);
    soft ||= read.soft;
    pieces.push({ alternatives: [read.text], source: null });
    chunk = "";
  };
  for (let at = 0; at < text.length; ) {
    const char = text[at]!;
    const tildeHere =
      char === "~" &&
      options.noTilde !== true &&
      ((index === 0 && at === 0) || (colons && text[at - 1] === ":") || (equalsAt !== -1 && at === equalsAt + 1));
    if (!tildeHere) {
      chunk += char === "\\" ? text.slice(at, at + 2) : char;
      at += char === "\\" ? 2 : 1;
      continue;
    }
    flush(lastClose >= at || closeAfter);
    let end = at + 1;
    while (end < text.length && text[end] !== "/" && !(colons && text[end] === ":")) end += 1;
    // A quoted character or an expansion in the prefix: bash leaves it literal; the reader does not decide that.
    if (end === text.length && index < word.parts.length - 1) return "tilde_form";
    const prefix = text.slice(at, end);
    if (prefix.includes("\\")) return "tilde_form";
    const read = tilde(prefix, context);
    if (typeof read === "string") return read;
    pieces.push(read);
    at = end;
  }
  flush(closeAfter);
  return { pieces, soft };
}

/**
 * A word's value(s) under a state (§2.1-§2.4), or the reason it has none: the
 * first offending part, left to right. Glob components read as GLOB.
 */
export function resolveWord(word: Word, context: WordContext, options: WordOptions = {}): Resolution {
  const { state } = context;
  const plain = options.assignment === true;
  const brace = plain ? -1 : braceAt(word);
  // Whether a `]` follows each part, for a bracket expression's close (one pass from the right).
  const closeAfter: boolean[] = new Array<boolean>(word.parts.length).fill(false);
  for (let index = word.parts.length - 2; index >= 0; index -= 1) {
    const next = word.parts[index + 1]!;
    closeAfter[index] = closeAfter[index + 1]! || (next.kind === "lit" && next.text.includes("]"));
  }
  let combos: string[] = [""];
  let multi: "cwd" | "var" | null = null;
  let expanded = false;
  let soft = false;
  let onlyExpansions = true;
  const fail = (reason: ReasonCode): Resolution => ({ ok: false, reason });
  /** Appends a piece; the reason when the values grow past a cap. */
  const add = (piece: Piece): ReasonCode | null => {
    if (piece.alternatives.length > 1) multi ??= piece.source ?? "var";
    if (piece.alternatives.length === 1) {
      const only = piece.alternatives[0]!;
      combos = combos.map((combo) => combo + only);
      // A value longer than a whole call may be (tildes and variables multiply text, D10).
      return combos[0]!.length > CAPS.text ? "cap_exceeded" : null;
    }
    const next = new Set<string>();
    for (const combo of combos) for (const alternative of piece.alternatives) next.add(combo + alternative);
    combos = [...next];
    return combos.length <= CANDIDATES ? null : "unknown_variable";
  };
  for (let index = 0; index < word.parts.length; index += 1) {
    if (index === brace) return fail("brace_expansion");
    const part = word.parts[index]!;
    const atStart = combos.every((combo) => combo === "");
    let pieces: Piece[];
    if (part.kind === "lit") {
      onlyExpansions = false;
      if (part.quote === "single") pieces = [{ alternatives: [part.text], source: null }];
      else if (part.quote === "double") {
        const read = percent(part.text, context.child, null);
        soft ||= read.soft;
        pieces = [{ alternatives: [read.text], source: null }];
      } else {
        const read = unquoted(word, index, context, options, closeAfter[index]!);
        if (typeof read === "string") return fail(read);
        soft ||= read.soft;
        pieces = read.pieces;
      }
    } else if (part.kind === "var") {
      const quoted = part.quote !== "none";
      if (quoted) onlyExpansions = false;
      const read = variable(part, context, atStart);
      if (typeof read === "string") return fail(read);
      if (!quoted && !plain) {
        expanded = true;
        // Unquoted, bash splits and globs the value: the reader does not.
        if (state.ifs || read.alternatives.some((value) => /[ \t\n*?[]/.test(value))) return fail("field_split");
      }
      pieces = [read];
    } else if (part.kind === "arith") {
      // R1: integer literals and integer variables only, and never at a word's start (it may be negative).
      if (atStart || !safeArithmetic(part.inner, state)) return fail("arithmetic");
      if (part.quote === "none") {
        expanded = true;
        if (state.ifs && !plain) return fail("field_split");
      } else onlyExpansions = false;
      pieces = [{ alternatives: ["0"], source: null }];
    } else if (part.kind === "sub") return fail(part.form === "process" ? "process_substitution" : "command_substitution");
    else if (part.kind === "opaque") return fail(part.form);
    else return fail("unknown_variable");
    for (const piece of pieces) {
      const over = add(piece);
      if (over !== null) return fail(over);
    }
  }
  // An unquoted word of expansions only that may be empty or blank is removed by bash (§2.1, F6).
  if (!plain && onlyExpansions && combos.some((combo) => /^[ \t\n]*$/.test(combo))) return fail("field_split");
  let globBad = false;
  let bareGlobBad = false;
  const values = combos.map((combo) => {
    if (!SENTINEL.test(combo)) return combo;
    if (combo.includes(STAR + STAR)) globBad = true;
    return combo
      .split("/")
      .map((component, position) => {
        if (!SENTINEL.test(component)) return component;
        const leading = component.startsWith(".") || component.startsWith(BRACKET);
        if (leading || component.includes("\\")) globBad = true;
        if (leading && position === 0) bareGlobBad = true;
        return GLOB;
      })
      .join("/");
  });
  return { ok: true, values, multi, expanded, soft: soft ? "unknown_variable" : null, globBad, bareGlobBad };
}

// ---------------------------------------------------------------------------
// A tested word's verdict (§2.3, last paragraph)

export interface Judgement {
  verdict: Verdict;
  /** The normalised path per candidate; [] when unresolved. */
  resolved: string[];
  reason: ReasonCode | null;
}

export const unresolved = (reason: ReasonCode): Judgement => ({ verdict: "unresolved", resolved: [], reason });

/** Whether a normalised path is inside: a workspace, or the fixed allowlist (§1.5 item 4). */
export function insidePath(resolved: string, child: ChildContext): boolean {
  return inWorkspace(resolved, child) || onAllowlist(resolved, child);
}

/** One value against the cwd candidates. */
function judgeValue(value: string, cwd: Cwd, child: ChildContext): Judgement {
  // §2.3 rule 9: on Linux `\` is a file-name character, not a separator.
  if (!child.windows && value.includes("\\")) return unresolved("backslash");
  // /proc/self/cwd/…, /dev/fd/N and /dev/stdin are links the reader does not follow (r2).
  if (/^[\\/](?:proc|dev[\\/](?:fd|stdin))(?:[\\/]|$)/.test(value)) return unresolved("symlink");
  const first = value.split(child.windows ? /[\\/]/ : "/")[0]!;
  const drive = child.windows && /^[A-Za-z]:/.test(first);
  // §2.3 rule 7: `C:..`, `D:`, `D:x` name that drive's own current directory.
  if (drive && !/^[A-Za-z]:[\\/]/.test(value)) return unresolved("drive_relative");
  if ((drive ? first.slice(2) : first).includes(":")) return unresolved("colon_form");
  const absolute = isAbsolutePath(value, child.windows);
  if (!absolute && isUnknown(cwd)) return unresolved(cwd.unknown);
  const bases = absolute || isUnknown(cwd) ? ["/"] : cwd;
  const resolved = [...new Set(bases.map((base) => resolveAgainst(value, base, child)))];
  let inside = 0;
  for (const path of resolved) {
    if (insidePath(path, child)) inside += 1;
    // §2.3 rule 8: an 8.3 name that only a loose match puts inside is not certainly inside.
    else if (inWorkspaceLoosely(path, child)) return unresolved("short_name");
  }
  if (inside === resolved.length && resolved.some(toolConfig)) return unresolved("tool_config");
  if (inside === resolved.length) return { verdict: "inside", resolved, reason: null };
  if (inside === 0) return { verdict: "outside", resolved, reason: null };
  return unresolved("cwd_mixed");
}

/**
 * A path into `.git`, or a `.gitattributes`, `.gitmodules` or `.npmrc` (r2): a write there
 * points git or npm outside (`gitdir: ../repo/.git`, `core.worktree`, `cache=../c`), and the
 * reader does not follow the file's content. Windows drops a name's trailing dots and spaces.
 */
export function toolConfig(path: string): boolean {
  const names = path.split(/[\\/]/).map((name) => name.replace(/[. ]+$/, "").toLowerCase());
  return names.includes(".git") || [".gitattributes", ".gitmodules", ".npmrc"].includes(names.at(-1) ?? "");
}

/** Every value of a word against the candidates: all inside, all outside, else unresolved. */
export function judge(values: readonly string[], multi: "cwd" | "var" | null, cwd: Cwd, child: ChildContext): Judgement {
  const judged = values.map((value) => judgeValue(value, cwd, child));
  const open = judged.find((judgement) => judgement.verdict === "unresolved");
  if (open !== undefined) return open;
  const resolved = [...new Set(judged.flatMap((judgement) => judgement.resolved))];
  if (judged.every((judgement) => judgement.verdict === "inside")) return { verdict: "inside", resolved, reason: null };
  if (judged.every((judgement) => judgement.verdict === "outside")) return { verdict: "outside", resolved, reason: null };
  return unresolved(multi === "var" ? "unknown_variable" : "cwd_mixed");
}

// ---------------------------------------------------------------------------
// §2.3's policy for a resolved word, and assignment values (§3.3)

const NETWORK_FORM = /^(?:https?|ssh|git):\/\//i;
/** A network URL; one with a `..` component is a file path too (`http:/a` may be a directory). */
const NETWORK = { test: (value: string) => NETWORK_FORM.test(value) && !value.split(/[\\/]/).includes("..") };
/** Stands for the inherited `$PATH` while a PATH value is split on `:` (its placeholder holds a colon). */
const INHERITED = "<inherited PATH>";

/** A value judged as a path, unless it names the network (§2.3 rule 6's exception). */
function judged(child: ChildContext, values: readonly string[], multi: "cwd" | "var" | null, state: State): Judgement | null {
  if (values.every((value) => NETWORK.test(value))) return null;
  return judge(values, multi, state.cwd, child);
}

/** §2.3 rules 1-2 and 5 for a resolved word: tested, and its verdict; null when not tested. */
export function verdictOf(child: ChildContext, written: string, resolution: Resolution, state: State, always: boolean): Judgement | null {
  if (!resolution.ok) return unresolved(resolution.reason);
  const { values } = resolution;
  const tested =
    always || pathLike(written, child.windows) || values.some((value) => pathLike(value, child.windows));
  if (!tested) return resolution.bareGlobBad ? unresolved("glob") : null;
  if (NETWORK.test(written) && values.every((value) => NETWORK.test(value))) return null;
  if (resolution.globBad || resolution.bareGlobBad) return unresolved("glob");
  if (resolution.soft !== null) return unresolved(resolution.soft);
  // §2.3 rule 5: a path after a leading `@`/`+`, after `=@`, or after a field `@`/`=<`
  // (curl's `-F f=<file` and `--data-urlencode name@file`, httpie's `field@file`) is its own path.
  for (const value of values) {
    const rests = [
      /^[@+](.*)$/s.exec(value)?.[1],
      ...[...value.matchAll(/=@|=<|@/g)].map((match) => value.slice(match.index + match[0].length)),
    ];
    for (const rest of rests) {
      if (rest === undefined || rest === "" || NETWORK_FORM.test(rest)) continue;
      const inner = judged(child, [rest], resolution.multi, state);
      if (inner !== null && inner.verdict !== "inside") return unresolved("prefixed_path");
    }
  }
  return judged(child, values, resolution.multi, state);
}

/** The words after a word's first `=`, as their own word (an option's value). */
export function afterEquals(word: Word): Word | null {
  const parts: Part[] = [];
  let found = false;
  for (const part of word.parts) {
    if (found) parts.push(part);
    else if (part.kind === "lit" && part.text.includes("=")) {
      found = true;
      const rest = part.text.slice(part.text.indexOf("=") + 1);
      if (rest !== "") parts.push({ ...part, text: rest });
    }
  }
  if (!found) return null;
  return { parts: parts.length === 0 ? [{ kind: "lit", text: "", quote: "double" }] : parts };
}

/** Variables with their own cwd/PATH handling, kept out of the R2 operand test. */
const STRUCTURAL = new Set(["PATH", "IFS", "CDPATH", "OLDPWD", "HOME", "DIRSTACK", "PWD"]);

/**
 * R2 (§0b): a prefix or exported assignment value a child process reads as a path
 * (`GIT_DIR=../.git`, `BASH_ENV=../b`, `NODE_OPTIONS=--require ../x`) is tested; outside or
 * unresolvable it is `assignment_operand`, data otherwise. Null when the value is not path-like.
 */
export function assignmentOperand(child: ChildContext, word: Word, name: string, state: State, equalsTilde: boolean): Judgement | null {
  if (STRUCTURAL.has(name)) return null;
  // A child bash run with -x expands PS4, substitutions included, before each command (r2).
  if (name === "PS4") return unresolved("nested_interpreter");
  const value = afterEquals(word);
  if (value === null) return null;
  const whole = resolveWord(word, { child, state }, { equalsTilde });
  const after = whole.ok ? { ...whole, values: whole.values.map((text) => text.slice(text.indexOf("=") + 1)) } : whole;
  const judgement = verdictOf(child, literalText(value), after, state, false);
  if (judgement !== null && judgement.verdict !== "inside") return unresolved("assignment_operand");
  return judgement;
}

/** A NAME=value word's value (§3.3): assignment context, its reason when it has none. */
export function assignedValue(child: ChildContext, value: Word, state: State): VarValue {
  if (value.parts.some((part) => part.kind === "array")) return { unknown: "unknown_variable" };
  const resolution = resolveWord(value, { child: child, state }, { assignment: true });
  if (!resolution.ok) return { unknown: resolution.reason };
  if (resolution.soft !== null) return { unknown: resolution.soft };
  return { values: resolution.values };
}

/** §3.3 `PATH` assignments: every entry but the inherited `$PATH` must be certainly inside. */
export function pathInside(child: ChildContext, value: VarValue, state: State): boolean {
  if (isUnknown(value) || "safe" in value) return false;
  return value.values.every((text) =>
    text.replaceAll("/<host:PATH>", INHERITED).split(":").every((entry) => {
      if (entry === INHERITED) return true;
      // Bash looks a relative entry up from the cwd at each command, and tilde-expands one that starts with `~` (r2).
      if (!isAbsolutePath(entry, child.windows) || entry.startsWith("~")) return false;
      const judgement = judge([entry], null, state.cwd, child);
      return judgement.verdict === "inside";
    }),
  );
}

/** A word's one value, or null when it has none (unresolved, or several). */
export function singleValue(word: Word, context: WordContext): string | null {
  const resolution = resolveWord(word, context);
  return resolution.ok && resolution.values.length === 1 ? resolution.values[0]! : null;
}

/** Option letters whose attached value is data by definition (§2.3 rule 4's exceptions). */
const ATTACHED_DATA: Record<string, string> = { awk: "F", gawk: "F", mawk: "F", nawk: "F", cut: "df", sort: "tk", paste: "d", join: "t" };

/**
 * An option word (§2.3 rule 4): only `--long=value` is tested, after its `=`
 * (`-o=../x` keeps `=../x` as an attached value); an attached value that is
 * path-like or expands is `attached_option`.
 */
export function optionReading(child: ChildContext, word: Word, state: State, command: string): { resolution: Resolution; judgement: Judgement | null } {
  const context = { child, state };
  const written = literalText(word);
  const value = written.startsWith("--") ? afterEquals(word) : null;
  const resolution = resolveWord(word, context);
  // An option value keeps a literal tilde: bash does not expand it there.
  if (value !== null) return { resolution, judgement: verdictOf(child, literalText(value), resolveWord(value, context, { noTilde: true }), state, false) };
  if (written.startsWith("--")) return { resolution, judgement: resolution.ok ? null : unresolved(resolution.reason) };
  const letter = written[1] ?? "";
  const attached = written.slice(2);
  const expands = word.parts.some((part) => part.kind !== "lit");
  const exempt = (ATTACHED_DATA[command]?.includes(letter) ?? false) || (command === "sed" && /^-[a-zA-Z]*i[^/\\*]*$/.test(written) && !expands);
  // A cluster value starts later (`tar -cC..`): `..`, and on Windows a drive colon, count too.
  const pathy = /[/\\]|\.\./.test(attached) || /^[~.]/.test(attached) || (child.windows && attached.includes(":"));
  return { resolution, judgement: !exempt && (expands || pathy) ? unresolved("attached_option") : null };
}
