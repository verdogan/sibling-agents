// The reader (design spec §3.2): the state walk over the AST, the tested
// words (§2.3) and their notes (§2.5), and the reading the measures get (§4a).
import type { ChildContext } from "../paths.js";
import { normalizePath, resolveAgainst } from "../paths.js";
import { basename, dataArguments, DECLARERS, declaredAssignment, isAssignment, knowsOptions, NAME, parseOptions, splitAssignment, stripPrefixes } from "./calls.js";
import { braceSequence, commandEffects, heredocRuns, seqSource, stderrRedirected, stdinFed, symlinkTargets } from "./commands.js";
import { CAPS, literalText, parseTop } from "./parse.js";
import { programFlag } from "./programs.js";
import { truncated, type ReasonCode, type UnresolvedNote } from "./reasons.js";
import { assign, forgetAll, isUnknown, join, joinAll, lookup, lost, never, readCd, sameState, start, OLDPWD_UNSET, commandsOf, effectsOf, widen } from "./state.js";
import { CANDIDATES, LOOP_DEPTH, LOOP_WORK, WORK_CAP } from "./state.js";
import type { CdReader, Effects, Flow, State, VarValue } from "./state.js";
import type { BashReading, Command, List, Part, Pipeline, ReadArgument, ReadSegment, Redirection, TestedPath, Word } from "./syntax.js";
import { childVariable, tableCall } from "./table.js";
import { inherited } from "./environment.js";
import { afterEquals, assignedValue, assignmentOperand, pathInside, arithmeticRunsCode, pureArithmetic, resolveWord, singleValue } from "./words.js";
import { optionReading, toolConfig, valueRunsCode, unresolved, verdictOf, type Judgement, type Resolution } from "./words.js";

type Role = TestedPath["role"];

interface WordReading {
  written: string;
  resolution: Resolution;
  /** The tested verdict; null when the word was not tested. */
  judgement: Judgement | null;
}

class Reader {
  readonly segments: ReadSegment[] = [];
  readonly tested: TestedPath[] = [];
  readonly notes: UnresolvedNote[] = [];
  private readonly seen = new Set<string>();
  /** argument()'s readings at one state; a tested word is recorded on its first reading only, as record() would dedupe it. */
  private memo: { state: State | null; readings: Map<string, WordReading> } = { state: null, readings: new Map() };
  private readonly loopEffects = new WeakMap<object, Effects>();
  /** Inside a loop's second pass: words are tested again, segments are not recorded twice. */
  private replay = 0;
  /** Inside a compound whose stderr is redirected away (§0b.1 item 5). */
  private stderrAway = 0;
  /** stdin is a pipe, a heredoc or a here-string here (§0a A2). */
  private fed = false;
  private current: number | null = null;
  /** Commands read so far, loop passes included: past WORK_CAP the reading stops (D10). */
  private work = 0;
  private loops = 0;

  constructor(
    private readonly child: ChildContext,
    private readonly text: string,
  ) {}

  note(reason: ReasonCode, written: string, scope: "word" | "call" = "word"): void {
    const note: UnresolvedNote = { scope, reason, written: truncated(written), segment: this.current };
    const key = `n|${scope}|${reason}|${note.written}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.notes.push(note);
  }

  /** Work read so far (D10): past WORK_CAP the reading stops. */
  private charge(units: number): void {
    this.work += units;
    if (this.work > WORK_CAP) throw new WorkCapExceeded();
  }

  callNote(reason: ReasonCode): void {
    this.note(reason, this.text, "call");
  }

  private record(written: string, role: Role, judgement: Judgement): void {
    const key = `t|${role}|${written}|${judgement.verdict}|${judgement.resolved.join("|")}|${judgement.reason}`;
    if (!this.seen.has(key)) {
      this.seen.add(key);
      this.tested.push({ written, role, verdict: judgement.verdict, resolved: judgement.resolved, reason: judgement.reason });
    }
    if (judgement.reason !== null) this.note(judgement.reason, written);
  }

  // Words

  /**
   * The side effects a word has wherever it is (§3.3, data words included): its substitutions run
   * (nested lists at the word's state, effects discarded), `${NAME:=…}` assigns, and an arithmetic
   * context that may assign makes every variable unknown.
   */
  effects(word: Word, state: State): State {
    let next = state;
    const walk = (parts: readonly Part[]) => {
      for (const part of parts) {
        if (part.kind === "sub") this.readList(part.list, next);
        else if (part.kind === "var") {
          if (part.inner !== null) walk(part.inner.parts);
          // `${!name}` and a subscript evaluate a value; a code-holding one runs a hidden `$( )` (D6).
          if (part.op === "!" && valueRunsCode(lookup(next, part.name))) this.callNote("nested_interpreter");
          const subscript = /^\[([^\]]*)\]/.exec(part.op ?? "")?.[1];
          if (subscript !== undefined && !/^(?:[0-9]+|[@*])$/.test(subscript)) {
            if ([...subscript.matchAll(/[A-Za-z_]\w*/g)].some((m) => valueRunsCode(lookup(next, m[0])))) this.callNote("nested_interpreter");
            next = forgetAll(next, "unknown_variable");
          }
          if (part.assigns) next = assign(next, part.name, { unknown: "unknown_variable" });
        } else if (part.kind === "arith") {
          walk(part.inner.parts);
          if (arithmeticRunsCode(part.inner, next)) this.callNote("nested_interpreter");
          if (!pureArithmetic(part.inner, next)) next = forgetAll(next, "unknown_variable");
        } else if (part.kind === "opaque") walk(part.inner);
        else if (part.kind === "array") for (const inner of part.words) walk(inner.parts);
      }
    };
    walk(word.parts);
    return next;
  }

  /** A word that is data: its effects only, and its value when it has one. */
  private data(word: Word, state: State): { reading: WordReading; state: State } {
    const after = this.effects(word, state);
    return {
      reading: { written: literalText(word), resolution: resolveWord(word, { child: this.child, state }), judgement: null },
      state: after,
    };
  }

  /**
   * An argument word (§2.3): an option word only after its `=` (or attached value), a `KEY=VALUE`
   * operand by R2, any other word by rules 1-2 and 5-9. Records the tested word and its note.
   */
  argument(word: Word, state: State, command: string, option: boolean): WordReading {
    // D10: equal words at one state read once (a call of 4,000 `$PWD/x` under 8 candidates).
    if (this.memo.state !== state) this.memo = { state, readings: new Map() };
    const key = `${command}\u0000${option}\u0000${JSON.stringify(word.parts)}`;
    let reading = this.memo.readings.get(key);
    if (reading === undefined) this.memo.readings.set(key, (reading = this.readWord(word, state, command, option)));
    return reading;
  }

  private readWord(word: Word, state: State, command: string, option: boolean): WordReading {
    const context = { child: this.child, state };
    const written = literalText(word);
    const first = word.parts[0];
    const unquotedHead = first?.kind === "lit" && first.quote === "none" ? first.text : "";
    if (option) {
      const { resolution, judgement } = optionReading(this.child, word, state, command);
      if (judgement !== null) this.record(written, "argument", judgement);
      return { written, resolution, judgement };
    }
    // R2 (§0b) and §2.3 rule 10: `KEY=VALUE` operands; `dd`'s if= and of= name files.
    const key = /^([A-Za-z0-9_.-]+)=/.exec(unquotedHead);
    if (key !== null && !/=@/.test(unquotedHead)) {
      const value = afterEquals(word)!;
      // Bash expands a tilde after the `=` of a word whose key is a NAME (F8).
      const whole = resolveWord(word, context, { equalsTilde: NAME.test(key[1]!) });
      const afterValue = whole.ok
        ? { ...whole, values: whole.values.map((text) => text.slice(text.indexOf("=") + 1)) }
        : whole;
      let judgement = verdictOf(this.child, literalText(value), afterValue, state, false);
      const file = command === "dd" && (key[1] === "if" || key[1] === "of");
      if (judgement !== null && !file && judgement.verdict !== "inside") judgement = unresolved("assignment_operand");
      if (judgement !== null) this.record(written, "argument", judgement);
      return { written, resolution: whole, judgement };
    }
    const resolution = resolveWord(word, context);
    // §2.3 rule 4: a word not written as an option whose value starts with `-` is an option the reader did not parse.
    if (resolution.ok && resolution.values.some((value) => value.startsWith("-")) && !written.startsWith("-")) {
      const judgement = unresolved("unknown_variable");
      this.record(written, "argument", judgement);
      return { written, resolution, judgement };
    }
    const judgement = verdictOf(this.child, written, resolution, state, false);
    if (resolution.ok && resolution.values.some(toolConfig)) this.note("tool_config", written);
    if (judgement !== null) this.record(written, "argument", judgement);
    return { written, resolution, judgement };
  }

  /** A word tested whatever its shape: a cd target, a redirection target. */
  target(word: Word, state: State, role: Role): WordReading {
    const written = literalText(word);
    const resolution = resolveWord(word, { child: this.child, state });
    let judgement: Judgement | null;
    if (resolution.ok && resolution.values.some((value) => value.startsWith("-")) && !written.startsWith("-")) {
      judgement = unresolved("unknown_variable");
    } else judgement = verdictOf(this.child, written, resolution, state, true);
    if (judgement !== null) this.record(written, role, judgement);
    return { written, resolution, judgement };
  }

  /** A ReadArgument: its value and the one path it names, when it names one. */
  readArgument(reading: WordReading, state: State, data: boolean): ReadArgument {
    const { resolution, judgement } = reading;
    const value = resolution.ok && resolution.values.length === 1 ? resolution.values[0]! : null;
    let resolved: string | null = null;
    if (judgement !== null) {
      if (judgement.verdict !== "unresolved" && judgement.resolved.length === 1) resolved = judgement.resolved[0]!;
    } else if (value !== null && !data && !isUnknown(state.cwd)) {
      const paths = new Set(state.cwd.map((dir) => resolveAgainst(value, dir, this.child)));
      if (paths.size === 1) resolved = [...paths][0]!;
    }
    return {
      written: reading.written,
      value,
      resolved,
      verdict: judgement?.verdict ?? null,
      reason: judgement?.reason ?? null,
      data,
    };
  }

  // The walk (§3.2): (T, F) are the states where `$?` is 0 and where it is not.

  readList(list: List, state: State): Flow {
    let flow: Flow = { t: state, f: state };
    let at = state;
    for (let index = 0; index < list.length; ) {
      const chain: List = [list[index++]!];
      while (index < list.length && (chain.at(-1)!.separator === "&&" || chain.at(-1)!.separator === "||")) {
        chain.push(list[index++]!);
      }
      const result = this.readChain(chain, at);
      // A background chain's effects stay inside it.
      flow = chain.at(-1)!.separator === "&" ? { t: at, f: at } : result;
      at = join(flow.t, flow.f);
    }
    return flow;
  }

  /** And-or lists group from the left (§0a A1): `a || b && c` is `(a || b) && c`. */
  private readChain(chain: List, state: State): Flow {
    let flow = this.readPipeline(chain[0]!.pipeline, state);
    for (let index = 1; index < chain.length; index += 1) {
      const pipeline = chain[index]!.pipeline;
      if (chain[index - 1]!.separator === "&&") {
        const next = this.readPipeline(pipeline, flow.t);
        flow = { t: next.t, f: join(flow.f, next.f) };
      } else {
        const next = this.readPipeline(pipeline, flow.f);
        flow = { t: join(flow.t, next.t), f: next.f };
      }
    }
    return flow;
  }

  private readPipeline(pipeline: Pipeline, state: State): Flow {
    let flow: Flow;
    if (pipeline.commands.length > 1) {
      // Each element is a subshell (lastpipe is off in bash -c): its effects are discarded.
      const fed = this.fed;
      try {
        pipeline.commands.forEach((command, index) => {
          this.fed = index > 0 || fed;
          this.readCommand(command, state);
        });
      } finally {
        this.fed = fed;
      }
      flow = { t: state, f: state };
    } else flow = this.readCommand(pipeline.commands[0]!, state);
    if (pipeline.negated) flow = { t: flow.f, f: flow.t };
    // Read at Never(S): every word was tested at S, and nothing it produces reaches a join.
    return state.never ? { t: never(flow.t), f: never(flow.f) } : flow;
  }

  private withRedirections<T>(redirections: readonly Redirection[], state: State, body: () => T): T {
    this.redirections(redirections, state, null);
    const away = stderrRedirected(redirections);
    const fed = this.fed;
    if (away) this.stderrAway += 1;
    this.fed = stdinFed(redirections, this.fed);
    try {
      return body();
    } finally {
      if (away) this.stderrAway -= 1;
      this.fed = fed;
    }
  }

  readCommand(command: Command, state: State): Flow {
    // A command read costs about the size of the variable map it copies (D10): cap variables-times-commands.
    this.charge(1 + state.vars.size);
    const end = (flow: Flow) => join(flow.t, flow.f);
    switch (command.kind) {
      case "simple":
        return this.readSimple(command.words, command.redirections, state);
      case "subshell":
        this.withRedirections(command.redirections, state, () => this.readList(command.list, state));
        return { t: state, f: state };
      case "group":
        return this.withRedirections(command.redirections, state, () => this.readList(command.list, state));
      case "arith": {
        let next = this.effects(command.inner, state);
        if (arithmeticRunsCode(command.inner, next)) this.callNote("nested_interpreter");
        if (!pureArithmetic(command.inner, next)) next = forgetAll(next, "unknown_variable");
        this.redirections(command.redirections, state, null);
        return { t: next, f: next };
      }
      case "if":
        return this.withRedirections(command.redirections, state, () => {
          const ends: State[] = [];
          let otherwise = state;
          for (const clause of command.clauses) {
            const cond = this.readList(clause.cond, otherwise);
            ends.push(end(this.readList(clause.body, cond.t)));
            otherwise = cond.f;
          }
          ends.push(command.otherwise === null ? otherwise : end(this.readList(command.otherwise, otherwise)));
          const joined = joinAll(ends);
          return { t: joined, f: joined };
        });
      case "case":
        return this.withRedirections(command.redirections, state, () => {
          let entry = this.effects(command.subject, state);
          const ends: State[] = [];
          let fallthrough = false;
          for (const arm of command.arms) {
            for (const pattern of arm.patterns) entry = this.effects(pattern, entry);
            // After `;;&` or `;&` a later arm may run after an earlier arm's effects (cwd F7).
            ends.push(end(this.readList(arm.body, fallthrough ? joinAll([entry, ...ends]) : entry)));
            if (arm.terminator !== ";;") fallthrough = true;
          }
          const joined = joinAll([entry, ...ends]);
          return { t: joined, f: joined };
        });
      case "loop":
        return this.withRedirections(command.redirections, state, () => this.readLoop(command, state));
      case "funcdef": {
        this.callNote("shell_definition");
        // Read once, as a loop's later iterations are: it may run anywhere, any number of times.
        this.readCommand(command.body, widen(state, effectsOf([command.body]), state));
        return { t: state, f: state };
      }
    }
  }

  private readLoop(command: Extract<Command, { kind: "loop" }>, state: State): Flow {
    // A loop read copies, widens and joins the variable map several times over (D10): charge it so.
    this.charge(LOOP_WORK * state.vars.size);
    if (++this.loops > LOOP_DEPTH) throw new WorkCapExceeded();
    let entry = state;
    if (command.arith !== null) {
      entry = this.effects(command.arith, entry);
      if (arithmeticRunsCode(command.arith, entry)) this.callNote("nested_interpreter");
      if (!pureArithmetic(command.arith, entry)) entry = forgetAll(entry, "unknown_variable");
    }
    const name = command.name;
    if (name !== null) {
      const list = this.forValue(command.words, entry);
      entry = assign(list.state, name, list.value);
    }
    const pass = (at: State): State => {
      if (command.cond === null) {
        const body = this.readList(command.body, at);
        return join(body.t, body.f);
      }
      const cond = this.readList(command.cond, at);
      const body = this.readList(command.body, cond.t);
      return joinAll([cond.t, cond.f, body.t, body.f]);
    };
    // Once per loop: nested loops re-read in later passes would otherwise walk their bodies again (D10).
    const effects = this.loopEffects.get(command) ?? effectsOf([...(command.cond === null ? [] : commandsOf(command.cond)), ...commandsOf(command.body)]);
    this.loopEffects.set(command, effects);
    if (this.replay > 0) {
      // Inside an outer loop's later pass: one read at the widened state covers every iteration (§4.3).
      const widened = widen(entry, effects, entry);
      const once = pass(widened);
      let after = joinAll([state, widened, once]);
      if (name !== null) after = assign(after, name, { unknown: "unknown_variable" });
      this.loops -= 1;
      return { t: after, f: after };
    }
    const first = pass(entry);
    const later = widen(entry, effects, first);
    let second = first;
    if (!sameState(later, entry)) {
      this.replay += 1;
      try {
        second = pass(later);
      } finally {
        this.replay -= 1;
      }
    }
    let after = joinAll([state, first, second]);
    if (name !== null) after = assign(after, name, { unknown: "unknown_variable" });
    this.loops -= 1;
    return { t: after, f: after };
  }

  /**
   * A `for` list's value (§3.3 refinement, §0b R1, §0b.1 items 1 and 4): the set of its words'
   * values; R1-safe for `$(seq …)` and `{A..B}` with non-negative integer literals and safe words.
   */
  private forValue(words: readonly Word[] | null, state: State): { value: VarValue; state: State } {
    if (words === null) return { value: { unknown: "unknown_variable" }, state };
    let next = state;
    const values = new Set<string>();
    let safe: { int: boolean; lead: boolean } | null = null;
    let failed: ReasonCode | null = null;
    for (const word of words) {
      const sequence = seqSource(word) ?? braceSequence(word);
      if (sequence !== null) {
        next = this.effects(word, next);
        if (sequence === "seq" && state.pathOverride) failed ??= "path_override";
        safe = { int: true, lead: true };
        continue;
      }
      const reading = this.argument(word, next, "for", false);
      next = this.effects(word, next);
      if (!reading.resolution.ok) failed ??= reading.resolution.reason;
      else for (const value of reading.resolution.values) values.add(value);
    }
    if (failed !== null) return { value: { unknown: failed }, state: next };
    const literal = [...values];
    if (safe !== null) {
      if (!literal.every((value) => /^[A-Za-z0-9_-]+$/.test(value))) return { value: { unknown: "unknown_variable" }, state: next };
      return {
        value: {
          safe: {
            int: safe.int && literal.every((value) => /^[0-9]+$/.test(value)),
            lead: literal.every((value) => /^[A-Za-z0-9_]/.test(value)),
          },
        },
        state: next,
      };
    }
    if (literal.length === 0 || literal.length > CANDIDATES) return { value: { unknown: "unknown_variable" }, state: next };
    return { value: { values: literal }, state: next };
  }

  /** Redirection targets, tested (§2.3 rule 3); heredoc bodies and here-strings are data. */
  redirections(redirections: readonly Redirection[], state: State, into: ReadSegment | null): void {
    for (const redirection of redirections) {
      if (redirection.heredoc !== null) {
        // The body is data (protocol item 3, D2); an unquoted one that runs a substitution makes the call unresolved (§0b.1 item 8).
        into?.heredocs.push(redirection.heredoc.body);
        if (!redirection.heredoc.quoted && heredocRuns(redirection.heredoc.body)) {
          this.callNote("heredoc_substitution");
          if (into !== null) into.callReason ??= "heredoc_substitution";
        }
        continue;
      }
      if (redirection.target === null) continue;
      if (redirection.op === "<<<") {
        this.effects(redirection.target, state);
        continue;
      }
      this.effects(redirection.target, state);
      const reading = this.target(redirection.target, state, "redirect");
      const argument = this.readArgument(reading, state, false);
      into?.redirects.push({
        op: redirection.op,
        written: reading.written,
        resolved: argument.resolved,
        verdict: reading.judgement?.verdict ?? "inside",
        reason: reading.judgement?.reason ?? null,
      });
    }
  }

  // Simple commands

  private readSimple(words: readonly Word[], redirections: readonly Redirection[], state: State): Flow {
    const segment: ReadSegment = {
      command: null,
      name: null,
      commandReason: null,
      args: [],
      redirects: [],
      heredocs: [],
      cwd: isUnknown(state.cwd) || state.cwd.length !== 1 ? null : state.cwd[0]!,
      callReason: null,
    };
    this.current = this.replay === 0 ? this.segments.length : null;
    const current = this.current;
    // The table's code comes after the call's more specific notes (its words', its effects').
    let pending: ReasonCode | null = null;
    const finish = (flow: Flow): Flow => {
      this.current = current;
      if (pending !== null) this.callReason(pending, segment);
      if (this.replay === 0) this.segments.push(segment);
      return flow;
    };
    let at = 0;
    let next = state;
    while (at < words.length && isAssignment(words[at]!)) at += 1;
    if (at === words.length) {
      for (const word of words) next = this.assignment(word, next);
      this.redirections(redirections, next, segment);
      return finish({ t: next, f: next });
    }
    // Prefix assignments set the command's environment only (§3.3); R2 tests a value read as a path.
    const prefix = new Map<string, VarValue>();
    for (const word of words.slice(0, at)) {
      next = this.effects(word, next);
      const { name, value } = splitAssignment(word);
      prefix.set(name, assignedValue(this.child, value, state));
      const judgement = assignmentOperand(this.child, word, name, state, NAME.test(name));
      if (judgement !== null) this.record(literalText(word), "argument", judgement);
    }
    const call = words.slice(at);
    let name = this.commandWord(call[0]!, next, prefix, segment);
    next = this.effects(call[0]!, next);
    let from = 1;
    let chdir = false;
    let callState: State | null = null;
    let callValues: (string | null)[] = [];
    if (name !== null) {
      // §4.1: prefix commands are stripped to the command they run; their own operands are data.
      callState = next;
      callValues = [segment.command, ...call.slice(1).map((word) => singleValue(word, { child: this.child, state: next }))];
      const stripped = stripPrefixes(callValues);
      const end = stripped.command ?? stripped.end;
      // Sets, not arrays: a call of thousands of env words is read in linear time (D10).
      const assignments = new Set(stripped.assignments);
      const data = new Set(stripped.data);
      const dirs = new Map(stripped.dirs.map((entry) => [entry.index, entry]));
      for (let index = 1; index < end; index += 1) {
        const word = call[index]!;
        const dir = dirs.get(index);
        if (assignments.has(index)) {
          next = this.effects(word, next);
          const { name: variable, value } = splitAssignment(word);
          prefix.set(variable, assignedValue(this.child, value, next));
          const judgement = assignmentOperand(this.child, word, variable, next, NAME.test(variable));
          if (judgement !== null) this.record(literalText(word), "argument", judgement);
        } else if (dir !== undefined) {
          this.target(dir.attached ? afterEquals(word)! : word, next, "argument");
          next = this.effects(word, next);
          chdir = true;
        } else if (data.has(index)) next = this.data(word, next).state;
        else {
          this.commandWord(word, next, prefix, segment);
          next = this.effects(word, next);
        }
      }
      if (stripped.reason !== null) this.callReason(stripped.reason, segment);
      if (stripped.command === null) {
        // Nothing runs (`command -v`, a bare `exec`), or a refused prefix: its other words are data then.
        if (stripped.reason !== null) {
          for (const word of call.slice(end)) next = this.data(word, next).state;
          this.redirections(redirections, next, segment);
          return finish({ t: next, f: next });
        }
        from = end;
      } else if (stripped.command > 0) {
        name = this.commandWord(call[stripped.command]!, next, prefix, segment);
        next = this.effects(call[stripped.command]!, next);
        from = stripped.command + 1;
      }
    }
    const args = call.slice(from);
    // The values the strip read, again only if a stripped word changed the state (D10).
    const values = callState === next ? callValues.slice(from) : args.map((word) => singleValue(word, { child: this.child, state: next }));
    // §0b.1 item 9: a command outside the table, an option outside its entry, code (`-c`, `-e`, stdin).
    const table = name === null ? null : this.table(name, segment.command ?? "", args, values, next, stdinFed(redirections, this.fed), [...prefix.keys()]);
    pending = table?.reason ?? null;
    if (name === "cd" || name === "pushd" || name === "popd" || name === "dirs") {
      const reader: CdReader = {
        effects: (word, at) => this.effects(word, at),
        target: (word, at, role) => this.target(word, at, role),
        argument: (reading, at) => this.readArgument(reading, at, false),
        redirections: (at, into) => this.redirections(redirections, at, into),
        note: (reason, written) => this.note(reason, written),
      };
      const away = this.stderrAway > 0 || stderrRedirected(redirections);
      return finish(readCd(reader, name, args, next, segment, away, prefix));
    }
    if (name === "source" || name === ".") return finish(this.readSource(args, next, segment, redirections));
    const dirs = new Set(table?.dirs ?? []);
    const cwd = next.cwd;
    // `env -C DIR`, `git -C DIR`: the command's relative words name paths under DIR (§4.1).
    if (chdir || dirs.size > 0) {
      for (const index of dirs) if (args[index] !== undefined) this.target(args[index]!, next, "argument");
      next = { ...next, cwd: { unknown: "cd_option" } };
    }
    next = this.readArguments(name ?? "", args, next, segment, new Set([...(table?.data ?? []), ...dirs]));
    // §4.2, D7: a sed or awk program that may open a file; the note's word is the program.
    const program = programFlag(name ?? "", values, args.map(literalText));
    if (program !== null) {
      this.note("program_io", program, "call");
      segment.callReason ??= "program_io";
    }
    next = commandEffects(name ?? "", args, next, segment, {
      call: (reason) => this.callNote(reason),
      assignment: (word, at) => this.assignment(word, at),
    });
    if (chdir || dirs.size > 0) next = { ...next, cwd };
    this.redirections(redirections, next, segment);
    return finish({ t: next, f: next });
  }

  /** The table's reading (table.ts); an unresolved or many-valued word may be an option where it is data or starts with `-`. */
  private table(name: string, command: string, args: readonly Word[], values: readonly (string | null)[], state: State, fed: boolean, assigned: string[]) {
    const data = dataArguments(name, values.map((value, index) => value ?? literalText(args[index]!)));
    const maybeOption = (index: number) => {
      if (data.has(index)) return true;
      const resolution = resolveWord(args[index]!, { child: this.child, state });
      return resolution.ok && resolution.values.some((value) => value.startsWith("-"));
    };
    return tableCall(name, command, values, fed, maybeOption, assigned);
  }

  /** A whole-call code (§2.5 scope `call`): one note, and the segment's callReason. */
  private callReason(reason: ReasonCode, segment: ReadSegment): void {
    this.callNote(reason);
    segment.callReason ??= reason;
  }

  /** `source`/`.` (§4.1): an inside path is a script on file, then all unknown (`sourced`); a bare name or unresolved one is code. */
  private readSource(args: readonly Word[], state: State, segment: ReadSegment, redirections: readonly Redirection[]): Flow {
    let next = state;
    let at = 0;
    if (args[0] !== undefined && literalText(args[0]) === "--") at = 1;
    const operand = args[at];
    if (operand !== undefined) {
      const value = singleValue(operand, { child: this.child, state: next });
      const reading = value === null || /^-./.test(value) || !/[\\/]/.test(value) ? null : this.target(operand, next, "argument");
      if (reading === null || reading.judgement === null || reading.judgement.verdict === "unresolved") {
        this.callReason("nested_interpreter", segment);
      }
      if (reading !== null) segment.args.push(this.readArgument(reading, next, false));
      next = this.effects(operand, next);
      for (const word of args.slice(at + 1)) next = this.data(word, next).state;
    }
    this.redirections(redirections, next, segment);
    const after = forgetAll(lost(next, "sourced"), "sourced");
    return { t: after, f: after };
  }

  /** The command word (§2.3 rule 3, §3.1): its name after quote removal, tested when path-like. */
  private commandWord(word: Word, state: State, prefix: ReadonlyMap<string, VarValue>, segment: ReadSegment): string | null {
    const written = literalText(word);
    const resolution = resolveWord(word, { child: this.child, state });
    if (!resolution.ok || resolution.values.length !== 1) {
      const judgement = resolution.ok ? unresolved("unknown_variable") : unresolved(resolution.reason);
      this.record(written, "command", judgement);
      segment.commandReason = judgement.reason;
      segment.command = null;
      segment.name = null;
      return null;
    }
    const value = resolution.values[0]!;
    // `\cd` and `c''d` are `cd` (cwd F15): the parser removed the escape and the quotes.
    segment.command = value;
    segment.name = basename(segment.command);
    const judgement = verdictOf(this.child, written, resolution, state, false);
    if (judgement !== null) {
      this.record(written, "command", judgement);
      if (judgement.verdict === "unresolved") segment.commandReason = judgement.reason;
    }
    // §3.3: after a PATH assignment with an entry not certainly inside, a bare command word may run anything.
    const path = prefix.get("PATH");
    if (!/[\\/]/.test(segment.command) && (state.pathOverride || (path !== undefined && !pathInside(this.child, path, state)))) {
      this.record(written, "command", unresolved("path_override"));
      segment.commandReason = "path_override";
    }
    return segment.name;
  }

  private readArguments(name: string, args: readonly Word[], state: State, segment: ReadSegment, extra: ReadonlySet<number> = new Set()): State {
    let next = state;
    const context = { child: this.child, state };
    const memo = new Map<string, string>();
    const values = args.map((word) => {
      const key = JSON.stringify(word.parts);
      const known = memo.get(key);
      if (known !== undefined) return known;
      const resolution = resolveWord(word, context);
      const value = resolution.ok && resolution.values.length === 1 ? resolution.values[0]! : literalText(word);
      memo.set(key, value);
      return value;
    });
    const data = dataArguments(name, values);
    for (const index of extra) data.add(index);
    const known = knowsOptions(name);
    const end = known ? parseOptions(values, name).end : null;
    const targets = symlinkTargets(name, args.map(literalText));
    args.forEach((word, index) => {
      const written = literalText(word);
      if (data.has(index)) {
        const read = this.data(word, next);
        next = read.state;
        segment.args.push(this.readArgument(read.reading, next, true));
        return;
      }
      const before = next;
      let reading: WordReading;
      if (DECLARERS.has(name) && declaredAssignment(word)) {
        // A declaration's NAME=value is an assignment (§3.3); export/declare also R2-test its value (§0b).
        const resolution = resolveWord(word, { child: this.child, state: before }, { equalsTilde: true });
        const exports = name === "export" || name === "declare" || name === "typeset";
        const judgement = exports ? assignmentOperand(this.child, word, splitAssignment(word).name, before, true) : null;
        if (judgement !== null) this.record(written, "argument", judgement);
        reading = { written, resolution, judgement };
      } else if (targets.has(index)) reading = this.symlinkTarget(word, before);
      else {
        const option = written.startsWith("-") && written !== "-" && (end === null || index < end);
        reading = this.argument(word, before, name, option);
      }
      next = this.effects(word, next);
      segment.args.push(this.readArgument(reading, before, false));
    });
    return next;
  }

  /** A symlink's target resolves against the link's directory (§3.4): a relative one with `..`, or unresolved, is `symlink`. */
  private symlinkTarget(word: Word, state: State): WordReading {
    const written = literalText(word);
    const resolution = resolveWord(word, { child: this.child, state });
    let judgement: Judgement | null;
    if (!resolution.ok) judgement = unresolved("symlink");
    else if (resolution.values.every((value) => /^(?:[\\/]|[A-Za-z]:[\\/])/.test(value))) {
      judgement = verdictOf(this.child, written, resolution, state, true);
    } else if (resolution.values.some((value) => value.split(/[\\/]/).includes(".."))) judgement = unresolved("symlink");
    else judgement = null;
    if (judgement !== null) this.record(written, "argument", judgement);
    return { written, resolution, judgement };
  }

  /** A bare or declared `NAME=value` (§3.3), applied to the state. */
  private assignment(word: Word, state: State): State {
    let next = this.effects(word, state);
    const { name, subscript, append, value } = splitAssignment(word);
    // A subscript is an arithmetic context; after `declare -i` so is every value (code values run, D6).
    const index = /^[A-Za-z_][A-Za-z0-9_]*\[([^\]]*)\]/.exec(literalText(word))?.[1];
    if (next.intDeclared && arithmeticRunsCode(value, next)) this.callNote("nested_interpreter");
    // §0b.1 item 9: only plain assignments; a computed subscript is arithmetic that may run a value's `$( )`.
    if (index !== undefined && !/^[0-9]+$/.test(index)) this.note("arithmetic", literalText(word));
    if ((index !== undefined && !/^[0-9]+$/.test(index)) || next.intDeclared) next = forgetAll(next, "unknown_variable");
    const assigned: VarValue = subscript || append ? { unknown: "unknown_variable" } : assignedValue(this.child, value, state);
    next = assign(next, name, name === "PWD" ? { unknown: "unknown_variable" } : assigned);
    if (name === "PATH" && !pathInside(this.child, assigned, state)) next = { ...next, pathOverride: true };
    if (name === "PS4") this.callNote("nested_interpreter"); // `set -x` expands it before each command (r2)
    // §0b.1 item 12: a name the child inherited is exported, so the value follows export's rules (R2, CHILD_VARIABLES).
    if (inherited(name, this.child.windows)) {
      const judgement = assignmentOperand(this.child, word, name, state, true);
      if (judgement !== null) this.record(literalText(word), "argument", judgement);
      if (!childVariable(name)) this.callNote("unknown_option");
    }
    return next;
  }
}

class WorkCapExceeded extends Error {}

export function readBash(command: string, child: ChildContext): BashReading {
  const reader = new Reader(child, command);
  if (command.length > CAPS.text) {
    reader.callNote("cap_exceeded");
    return { segments: reader.segments, tested: reader.tested, notes: reader.notes };
  }
  const workspace = child.workspaces[0] ?? normalizePath(".", child.windows);
  const { list, failure } = parseTop(command);
  try {
    reader.readList(list, start(workspace, child.windows ? OLDPWD_UNSET.windows : OLDPWD_UNSET.posix));
  } catch (error) {
    // Nesting past the stack while reading: the rest is unread.
    if (!(error instanceof RangeError) && !(error instanceof WorkCapExceeded)) throw error;
    reader.callNote("cap_exceeded");
  }
  if (failure !== null) reader.callNote(failure);
  return { segments: reader.segments, tested: reader.tested, notes: reader.notes };
}
