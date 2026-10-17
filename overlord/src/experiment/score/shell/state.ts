// The reader's state (design spec §3.2, §3.3): the working directory as a set
// of candidates or unknown, OLDPWD, the pushd stack, the variables the call
// assigned, and the flags that widen later readings. Never(S) is the outcome
// that cannot happen (a cd that runs succeeds): its words are still tested at
// S, and it reaches no join.
import { DECLARERS, basename, isAssignment, splitAssignment } from "./calls.js";
import { literalText } from "./parse.js";
import type { ReasonCode } from "./reasons.js";
import type { Command, List, ReadArgument, ReadSegment, Word } from "./syntax.js";
import type { Judgement, Resolution } from "./words.js";

export interface Unknown {
  unknown: ReasonCode;
}

/** Normalised directories, 1 to CANDIDATES of them, distinct. */
export type Dirs = readonly string[];
export type Cwd = Dirs | Unknown;
export type Prev = Dirs | "unset" | Unknown;
export type Stack = readonly Dirs[] | Unknown;

/**
 * A variable the call assigned: its possible values (at most CANDIDATES), or
 * R1-safe (§0b: every value non-empty and `[A-Za-z0-9_-]+`; `int` when an
 * integer literal, `lead` when it may also start a word), or unknown.
 */
export type VarValue = { values: readonly string[] } | { safe: { int: boolean; lead: boolean } } | Unknown;

export interface State {
  never: boolean;
  cwd: Cwd;
  prev: Prev;
  stack: Stack;
  vars: ReadonlyMap<string, VarValue>;
  /** Every variable not assigned since is unknown, with this code (an arithmetic side effect, `source`). */
  everything: ReasonCode | null;
  /** An IFS assignment may have run (§3.3). */
  ifs: boolean;
  /** A write to CDPATH may have run (§3.3). */
  cdpath: boolean;
  /** A PATH assignment with an entry not certainly inside may have run (§3.3). */
  pathOverride: boolean;
  /** `declare -i` may have run: an assignment after it is arithmetic. */
  intDeclared: boolean;
}

export const CANDIDATES = 8;

/** The deepest pushd stack the reader follows (D10). */
const STACK_CAP = 64;

/** The deepest cwd the reader follows, in path components (D10). */
const DEPTH_CAP = 256;

/** The variables-times-commands work read in one call (D10): hundreds of variables under deeply nested loops ends here. */
export const WORK_CAP = 150_000;
/** What one loop read costs per variable, in WORK_CAP units (measured: about ten map passes). */
export const LOOP_WORK = 10;
/** The deepest loop nesting the reader follows (D10): each level reads the body once more (r2: 16 levels took a second). */
export const LOOP_DEPTH = 4;

export function isUnknown(value: unknown): value is Unknown {
  return typeof value === "object" && value !== null && "unknown" in value;
}

/**
 * Whether the child's bash certainly starts without OLDPWD (§3.4), so that a
 * `cd -` before any cd fails. A local child's environment is
 * local-provisioner's allowlist (SYSTEM_ENV_KEYS, LING_SETTING_KEYS, the
 * provider's credentials and what the lease assigns), and Pi's bash tool
 * passes that environment on (`getShellEnv`): none of it is OLDPWD or CDPATH
 * (checked 2026-10-09; experiment-score-check pins it). On Linux the counted
 * runs use the Docker sandbox, whose `bash -lc` gets the image's environment
 * and login profile, which no record covers: there OLDPWD may be set.
 */
export const OLDPWD_UNSET = { windows: true, posix: false } as const;

/** A call's start: a fresh `bash -c` in the workspace. */
export function start(workspace: string, oldpwdUnset: boolean): State {
  return {
    never: false,
    cwd: [workspace],
    prev: oldpwdUnset ? "unset" : { unknown: "cwd_unknown" },
    stack: [],
    vars: new Map(),
    everything: null,
    ifs: false,
    cdpath: false,
    pathOverride: false,
    intDeclared: false,
  };
}

export function never(state: State): State {
  return state.never ? state : { ...state, never: true };
}

function union(a: Dirs, b: Dirs): Dirs | Unknown {
  const all = [...new Set([...a, ...b])];
  return all.length > CANDIDATES ? { unknown: "cd_cap" } : all;
}

function joinCwd(a: Cwd, b: Cwd): Cwd {
  if (isUnknown(a)) return a;
  if (isUnknown(b)) return b;
  return union(a, b);
}

function joinPrev(a: Prev, b: Prev): Prev {
  if (isUnknown(a)) return a;
  if (isUnknown(b)) return b;
  if (a === "unset" || b === "unset") return a === b ? a : { unknown: "cd_option" };
  return union(a, b);
}

function joinStack(a: Stack, b: Stack): Stack {
  if (isUnknown(a)) return a;
  if (isUnknown(b)) return b;
  if (a.length !== b.length) return { unknown: "cd_option" };
  const levels: Dirs[] = [];
  for (let index = 0; index < a.length; index += 1) {
    const level = union(a[index]!, b[index]!);
    if (isUnknown(level)) return level;
    levels.push(level);
  }
  return levels;
}

export function sameValue(a: VarValue | undefined, b: VarValue | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (isUnknown(a) || isUnknown(b)) return isUnknown(a) && isUnknown(b) && a.unknown === b.unknown;
  if ("safe" in a || "safe" in b) {
    return "safe" in a && "safe" in b && a.safe.int === b.safe.int && a.safe.lead === b.safe.lead;
  }
  const left = [...a.values].sort();
  const right = [...b.values].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** A variable's value in the state; undefined when it holds bash's (or the record's) default. */
export function lookup(state: State, name: string): VarValue | undefined {
  const value = state.vars.get(name);
  if (value !== undefined) return value;
  return state.everything === null ? undefined : { unknown: state.everything };
}

/** The states after either of two outcomes (D4): candidates united, unequal variables unknown. */
export function join(a: State, b: State): State {
  if (a.never && !b.never) return b;
  if (b.never && !a.never) return a;
  const everything = a.everything ?? b.everything;
  // Fast path (D10): the two outcomes share one variable map (nothing wrote it between them),
  // so no variable can differ; copying and comparing 1,000 entries each join is what grew the cost.
  let vars: Map<string, VarValue>;
  if (a.vars === b.vars && a.everything === b.everything) {
    vars = a.vars as Map<string, VarValue>;
  } else {
    vars = new Map<string, VarValue>();
    for (const name of new Set([...a.vars.keys(), ...b.vars.keys()])) {
      const left = lookup(a, name);
      const right = lookup(b, name);
      if (sameValue(left, right)) {
        if (left !== undefined) vars.set(name, left);
      } else vars.set(name, { unknown: "unknown_variable" });
    }
  }
  return {
    never: a.never && b.never,
    cwd: joinCwd(a.cwd, b.cwd),
    prev: joinPrev(a.prev, b.prev),
    stack: joinStack(a.stack, b.stack),
    vars,
    everything,
    ifs: a.ifs || b.ifs,
    cdpath: a.cdpath || b.cdpath,
    pathOverride: a.pathOverride || b.pathOverride,
    intDeclared: a.intDeclared || b.intDeclared,
  };
}

function sameSlot(a: Cwd | Prev | Stack, b: Cwd | Prev | Stack): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Whether two states read every later word alike (a loop's second pass can then be skipped). */
export function sameState(a: State, b: State): boolean {
  if (!sameSlot(a.cwd, b.cwd) || !sameSlot(a.prev, b.prev) || !sameSlot(a.stack, b.stack)) return false;
  if (a.everything !== b.everything || a.ifs !== b.ifs || a.cdpath !== b.cdpath) return false;
  if (a.pathOverride !== b.pathOverride || a.intDeclared !== b.intDeclared) return false;
  if (a.vars === b.vars && a.everything === b.everything) return true;
  const names = new Set([...a.vars.keys(), ...b.vars.keys()]);
  return [...names].every((name) => sameValue(lookup(a, name), lookup(b, name)));
}

export function joinAll(states: readonly State[]): State {
  return states.reduce((joined, state) => join(joined, state));
}

/**
 * A write to a variable (§3.3), with its side effects on the slots bash
 * reads it from: OLDPWD is `cd -`'s and `~-`'s, DIRSTACK the stack's, CDPATH
 * and IFS change later readings. PWD stays as written until the next cd.
 */
export function assign(state: State, name: string, value: VarValue): State {
  const vars = new Map(state.vars);
  vars.set(name, value);
  const next: State = { ...state, vars };
  if (name === "OLDPWD") next.prev = { unknown: "cd_option" };
  if (name === "DIRSTACK") next.stack = { unknown: "cd_option" };
  if (name === "CDPATH") next.cdpath = true;
  if (name === "IFS") next.ifs = true;
  // A PATH left unknown (a `read PATH`, `printf -v PATH`, a computed name): a later bare command may run anything.
  if (name === "PATH" && isUnknown(value)) next.pathOverride = true;
  return next;
}

/** Every variable unknown from here on (§3.3: an arithmetic side effect, `source`), with the slots they feed. */
export function forgetAll(state: State, code: ReasonCode): State {
  return {
    ...state,
    vars: new Map(),
    everything: code,
    prev: { unknown: code === "sourced" ? code : "cd_option" },
    stack: { unknown: code === "sourced" ? code : "cd_option" },
    ifs: true,
    cdpath: true,
  };
}

/** The cwd moved to `target` (a cd that succeeded): the old one is OLDPWD now, and PWD follows. */
export function moveTo(state: State, target: Cwd): State {
  const vars = new Map(state.vars);
  vars.delete("PWD");
  vars.delete("OLDPWD");
  return { ...state, cwd: target, prev: state.cwd, vars };
}

/** The cwd, prev and stack unknown with `code` (§3.4). */
export function lost(state: State, code: ReasonCode): State {
  const unknown = { unknown: code };
  return { ...state, cwd: unknown, prev: unknown, stack: unknown };
}

// ---------------------------------------------------------------------------
// What a loop or function body may change (§3.2 `loopEffects`)

export function commandsOf(list: List): Command[] {
  return list.flatMap((item) => item.pipeline.commands);
}

export interface Effects {
  cd: boolean;
  names: Set<string>;
  all: boolean;
}

const WRITERS = new Set(["read", "mapfile", "readarray", "getopts", "unset", ...DECLARERS]);

/** What a loop or function body may change, read from its text (§3.2 `loopEffects`). */
export function effectsOf(commands: readonly Command[]): Effects {
  const out: Effects = { cd: false, names: new Set(), all: false };
  const parts = (word: Word) => {
    for (const part of word.parts) {
      if (part.kind === "var") {
        if (part.assigns) out.names.add(part.name);
        if (part.inner !== null) parts(part.inner);
      } else if (part.kind === "arith") {
        if (/(?:^|[^=!<>])=(?!=)|\+\+|--|[-+*/%&^|]=/.test(literalText(part.inner))) out.all = true;
      }
    }
  };
  const visit = (command: Command) => {
    switch (command.kind) {
      case "simple": {
        let index = 0;
        while (index < command.words.length && isAssignment(command.words[index]!)) {
          out.names.add(splitAssignment(command.words[index]!).name);
          index += 1;
        }
        command.words.forEach(parts);
        const name = index < command.words.length ? basename(literalText(command.words[index]!).replace(/\\/g, "")) : "";
        const rest = command.words.slice(index + 1).map(literalText);
        if (name === "cd" || name === "pushd" || name === "popd") out.cd = true;
        else if (WRITERS.has(name)) {
          out.names.add("REPLY").add("MAPFILE").add("OPTARG").add("OPTIND");
          for (const word of rest) {
            const head = word.split("=")[0]!;
            if (/^[A-Za-z_][A-Za-z0-9_]*(?:\[.*\])?$/.test(head)) out.names.add(head.replace(/\[.*$/, ""));
            else if (!word.startsWith("-") && !word.startsWith("+")) out.all = true;
            if (/^-[a-zA-Z]*n/.test(word)) out.all = true;
          }
        } else if (name === "printf") {
          rest.forEach((word, at) => {
            if (word === "-v") out.names.add((rest[at + 1] ?? "").replace(/\[.*$/, ""));
            else if (word.startsWith("-v")) out.names.add(word.slice(2).replace(/\[.*$/, ""));
          });
        } else if (name === "let" || name === "source" || name === "." || name === "eval") out.all = true;
        break;
      }
      case "subshell":
        break;
      case "group":
        commandsOf(command.list).forEach(visit);
        break;
      case "if":
        for (const clause of command.clauses) [...commandsOf(clause.cond), ...commandsOf(clause.body)].forEach(visit);
        if (command.otherwise !== null) commandsOf(command.otherwise).forEach(visit);
        break;
      case "case":
        for (const arm of command.arms) commandsOf(arm.body).forEach(visit);
        break;
      case "loop":
        if (command.name !== null) out.names.add(command.name);
        if (command.arith !== null) out.all = true;
        if (command.cond !== null) commandsOf(command.cond).forEach(visit);
        commandsOf(command.body).forEach(visit);
        break;
      case "funcdef":
        out.all = true;
        break;
      case "arith":
        parts(command.inner);
        if (/(?:^|[^=!<>])=(?!=)|\+\+|--|[-+*/%&^|]=/.test(literalText(command.inner))) out.all = true;
        break;
    }
  };
  commands.forEach(visit);
  return out;
}

/**
 * The state a later iteration (or a function body) may start in: what the
 * body may change is unknown (§3.2 pass 2), and so is anything the first pass
 * changed.
 */
export function widen(entry: State, effects: Effects, first: State): State {
  let state = effects.all ? forgetAll(entry, "unknown_variable") : entry;
  // When the first pass left the variable map untouched (same reference), only the body's own
  // writes (effects.names) can differ (D10): skip comparing every entry of a large shared map.
  const names = state.vars === first.vars ? effects.names : new Set([...effects.names, ...first.vars.keys()]);
  for (const name of names) {
    const before = lookup(state, name);
    const changed = effects.names.has(name) || !sameValue(lookup(first, name), before);
    if (changed && !(before !== undefined && isUnknown(before))) state = assign(state, name, { unknown: "unknown_variable" });
  }
  const moved = !sameSlot(first.cwd, entry.cwd);
  if (effects.cd || moved) {
    const loop = { unknown: "cd_loop" } as const;
    state = {
      ...state,
      cwd: isUnknown(state.cwd) ? state.cwd : loop,
      prev: isUnknown(state.prev) ? state.prev : loop,
      stack: isUnknown(state.stack) ? state.stack : loop,
    };
  }
  return state;
}

// ---------------------------------------------------------------------------
// cd, pushd, popd and dirs (§3.4)

export interface Flow {
  t: State;
  f: State;
}

/** A tested cd target as the reader read it. */
export interface CdReading {
  written: string;
  resolution: Resolution;
  judgement: Judgement | null;
}

/** What readCd needs from the reader: a word's effects, a tested target, its ReadArgument, the redirections. */
export interface CdReader {
  effects(word: Word, state: State): State;
  target(word: Word, state: State, role: "cd"): CdReading;
  argument(reading: CdReading, state: State): ReadArgument;
  redirections(state: State, segment: ReadSegment): void;
  /** A note on the cd itself: where it lands is unknown, and later bare names are untested. */
  note(reason: ReasonCode, written: string): void;
}

/** cd, pushd, popd and dirs (§3.4); a landing it cannot know makes the call unresolved at the cd (bare names after it are untested). */
export function readCd(
  reader: CdReader,
  name: string,
  args: readonly Word[],
  state: State,
  segment: ReadSegment,
  stderrAway: boolean,
  prefix: ReadonlyMap<string, VarValue>,
): Flow {
  const flow = cdFlow(reader, name, args, state, segment, stderrAway, prefix);
  // cd_target: the target word has its own note already.
  if (!flow.t.never && isUnknown(flow.t.cwd) && flow.t.cwd.unknown !== "cd_target") reader.note(flow.t.cwd.unknown, [name, ...args.map(literalText)].join(" "));
  return flow;
}

/** cd, pushd, popd and dirs (§3.4); a cd that runs succeeds (D4) unless its stderr goes away (§0b.1 item 5). */
function cdFlow(
  reader: CdReader,
  name: string,
  args: readonly Word[],
  state: State,
  segment: ReadSegment,
  stderrAway: boolean,
  prefix: ReadonlyMap<string, VarValue>,
): Flow {
  let ended = false;
  let option = false;
  let clear = false;
  const operands: Word[] = [];
  let next = state;
  for (const word of args) {
    const written = literalText(word);
    next = reader.effects(word, next);
    if (!ended && written === "--") {
      ended = true;
      continue;
    }
    if (!ended && /^[-+]./.test(written) && word.parts.every((part) => part.kind === "lit")) {
      if (name === "dirs") clear ||= written === "-c";
      else if (name !== "cd" || /[^L]/.test(written.slice(1)) || written.startsWith("+")) option = true;
      segment.args.push({ written, value: written, resolved: null, verdict: null, reason: null, data: false });
      continue;
    }
    // Option parsing stops at the first operand: a later `-L` or `--` is a second operand (r2).
    operands.push(word);
    ended = true;
  }
  const readings = operands.map((word) =>
    literalText(word) === "-" && word.parts.every((part) => part.kind === "lit") ? null : reader.target(word, state, "cd"),
  );
  // An expanded word is an option by its value (`X=+1; pushd $X` rotates the stack).
  if (readings.some((reading) => reading !== null && reading.resolution.ok && reading.resolution.values.some((value) => /^[-+]/.test(value)))) {
    option = true;
  }
  for (const reading of readings) {
    segment.args.push(
      reading === null
        ? { written: "-", value: "-", resolved: null, verdict: null, reason: null, data: false }
        : reader.argument(reading, state),
    );
  }
  reader.redirections(next, segment);
  const failed: State = stderrAway ? next : never(next);
  const fails: Flow = { t: never(next), f: next };
  if (name === "dirs") return clear ? { t: { ...next, stack: [] }, f: next } : { t: next, f: next };
  // The builtin reads these prefix assignments (cwd F9).
  if (["HOME", "OLDPWD", "PWD", "DIRSTACK"].some((variable) => prefix.has(variable))) {
    return { t: lost(next, "shell_option"), f: failed };
  }
  if (option || operands.length > 1) {
    const moved = moveTo(next, { unknown: "cd_option" });
    return { t: name === "cd" ? moved : { ...moved, stack: { unknown: "cd_option" } }, f: failed };
  }
  const stack = next.stack;
  if (name === "popd") {
    if (isUnknown(stack)) return { t: lost(next, "cd_option"), f: failed };
    if (stack.length === 0) return fails;
    return { t: { ...moveTo(next, stack[0]!), stack: stack.slice(1) }, f: failed };
  }
  const push = (moved: State): State => {
    if (name !== "pushd") return moved;
    if (isUnknown(stack) || isUnknown(next.cwd)) return { ...moved, stack: { unknown: "cd_option" } };
    // D10: a stack past STACK_CAP entries is unknown (a later popd lands nowhere known).
    if (stack.length >= STACK_CAP) return { ...moved, stack: { unknown: "cd_cap" } };
    return { ...moved, stack: [next.cwd, ...stack] };
  };
  if (operands.length === 0) {
    if (name === "pushd") {
      if (isUnknown(stack)) return { t: lost(next, "cd_option"), f: failed };
      if (stack.length === 0) return fails;
      const swapped = moveTo(next, stack[0]!);
      return { t: { ...swapped, stack: isUnknown(next.cwd) ? { unknown: "cd_option" } : [next.cwd, ...stack.slice(1)] }, f: failed };
    }
    const home = reader.target({ parts: [{ kind: "lit", text: "~", quote: "none" }] }, next, "cd");
    return { t: moveTo(next, landing(home, next, prefix)), f: failed };
  }
  const reading = readings[0]!;
  if (reading === null) {
    // `cd -`: OLDPWD (§3.4).
    if (next.prev === "unset") return fails;
    if (isUnknown(next.prev)) return { t: push(moveTo(next, { unknown: "cd_option" })), f: failed };
    return { t: push(moveTo(next, next.prev)), f: failed };
  }
  if (reading.resolution.ok && reading.resolution.values.every((value) => value === "")) {
    // `cd ''`: bash 5.2 stays, and sets OLDPWD.
    return { t: push(moveTo(next, next.cwd)), f: failed };
  }
  return { t: push(moveTo(next, landing(reading, next, prefix))), f: failed };
}

/** Where a cd target lands: its resolved directories, or unknown with the reason. */
function landing(reading: CdReading, state: State, prefix: ReadonlyMap<string, VarValue>): Cwd {
  const judgement = reading.judgement;
  if (!reading.resolution.ok || judgement === null || judgement.verdict === "unresolved") return { unknown: "cd_target" };
  // A glob target (words.ts GLOB) may match several directories; cd then fails and stays (r2).
  if (reading.resolution.values.some((value) => value.split(/[\\/]/).includes("<glob>"))) return { unknown: "glob" };
  // Bash skips CDPATH only for `.`, `..`, `./…`, `../…`, absolute; a `.name` target is looked up through it.
  const cdpath = state.cdpath || prefix.has("CDPATH");
  if (cdpath && reading.resolution.values.some((value) => !/^\.\.?(?:\/|$)/.test(value) && !/^(?:[\\/]|[A-Za-z]:[\\/])/.test(value))) {
    return { unknown: "cdpath" };
  }
  // D10: a directory deeper than DEPTH_CAP components is past any path bash can enter, and costs every later word.
  if (judgement.resolved.some((dir) => dir.split(/[\\/]/).length > DEPTH_CAP)) return { unknown: "cd_cap" };
  return judgement.resolved.length > CANDIDATES ? { unknown: "cd_cap" } : judgement.resolved;
}
