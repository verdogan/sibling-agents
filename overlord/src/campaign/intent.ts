/**
 * Comparing what a task said it would do against what it actually did.
 *
 * Every other gate in this package asks whether a claim about the world
 * survives re-checking. This one asks a different question: is the task's
 * account of its own work true? A worker reporting "ran the test suite, all
 * green" without invoking anything passes `parseWorkerResult`, passes the
 * acceptance checks — which are reviewer-supplied booleans — and passes the
 * findings gate, which only looks at claims about external sources.
 *
 * The comparison is made here rather than by any worker, for the same reason
 * `findings.ts` gives: a worker asked for a verdict can return one without
 * doing the work. Both sides of this comparison are facts. The declaration is
 * a task's own tool call, and the observations are `tool_start` events the
 * harness recorded, neither of which is a model's opinion about whether things
 * went well.
 *
 * ## Ordering is the whole mechanism
 *
 * A declaration only constrains what comes after it. Ling numbers a task's
 * events in the order they happen, so this walks them once in that order and
 * accumulates declared sets as it goes; an action is covered only if a
 * declaration already in effect names it.
 * Without that rule a worker could act first and declare afterwards to match
 * what it had done, which is a description rather than a commitment and worth
 * nothing.
 *
 * ## What this catches, and what it does not
 *
 * It catches concealment: doing something and not saying so. It does not catch
 * a worker that declares a bad action and then performs it. That case belongs
 * to the guards, which refuse it, and to the acceptance criteria, which judge
 * it.
 */

import { assessEventSequence, inSequenceOrder, type EventRecord } from "./event-record.js";

/**
 * Mirrors ling's `src/intent.ts`. The two packages build in isolation, so the
 * overlord cannot import it; `intent-check.ts` reads the ling source and pins
 * every constant here against it.
 */
export const DECLARE_INTENT_TOOL_NAME = "declare_intent";
export const INTENT_EVENT_TYPE = "intent_declared";

/** How many undeclared items of one kind are kept in the manifest. */
export const MAX_REPORTED_UNDECLARED = 20;

export type IntentOutcome =
  /** A declaration was in effect and every observed action fell inside it. */
  | "clean"
  /** At least one action was taken that no prior declaration covered. */
  | "diverged"
  /** Actions were observed and the task never declared anything. Unresolved. */
  | "undeclared"
  /** The role was not given `declare_intent`. A recorded opt-out, not a pass. */
  | "inapplicable"
  /** No event history could be read, so nothing is known either way. */
  | "unavailable";

export interface IntentObservation {
  kind: "command" | "host" | "write";
  value: string;
  /** Whether some *later* declaration named it. Post-hoc cover, not cover. */
  declaredLater: boolean;
}

export interface IntentReport {
  outcome: IntentOutcome;
  /** Declarations accepted, amendments included. */
  declarations: number;
  /**
   * Observed programs that can execute other programs.
   *
   * Non-empty means the command list is a lower bound. A `clean` result beside
   * one of these says nothing *visible* fell outside the declaration, not that
   * nothing else ran — a task that runs `node runner.js` produces a log in which
   * whatever `runner.js` spawned never appears. Carried on the report rather than
   * left in prose because it is the caveat a reader glancing at an outcome most
   * needs and is least likely to look for.
   */
  indirection: string[];
  /** Distinct actions observed per kind, so silence is distinguishable. */
  observed: { commands: number; hosts: number; writes: number };
  undeclared: IntentObservation[];
  reasons: string[];
}

/** One event of a task's history, as much of it as this module needs. */
export interface IntentLogEvent {
  type: string;
  data?: unknown;
  /** Ling's sequence number, when the source carries one; what makes a gap visible. */
  seq?: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Reduce a program reference the same way ling's validator does. */
export function normalizeProgram(value: string): string {
  const trimmed = value.trim().replace(/^["']|["']$/g, "");
  const base = trimmed.split(/[/\\]/).pop() ?? trimmed;
  return base.toLowerCase();
}

/**
 * Programs a shell command line would run.
 *
 * A heuristic, and deliberately a conservative one: it splits on the operators
 * that introduce a new command, drops the wrappers that precede one, and takes
 * the head of each segment. It will miss a program invoked through indirection
 * — `eval`, a variable, a script that shells out — which is why an undeclared
 * *program* is evidence of concealment while a declared one is not evidence of
 * innocence. Under-reporting here weakens detection; it never manufactures a
 * false accusation, which is the direction to fail in.
 */
export function programsInCommand(command: string): string[] {
  return analyzeCommand(command).programs;
}

/**
 * Programs that commonly exist to run *other* programs.
 *
 * Observing one of these means the command list is a lower bound rather than an
 * account: `node runner.js` is a complete and honest record of one tool call
 * whose child processes are entirely absent from the event stream. Live
 * measurement found this is not a corner case — a task asked to run something via
 * `child_process` produced a log in which the program it ran never appeared at
 * all, and every check passed.
 *
 * Naming them does not close the gap; nothing at this layer can. It makes the gap
 * visible, which is the difference between a limitation and a false negative.
 */
const INDIRECTION_VEHICLES = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "cmd",
  "cmd.exe",
  "powershell",
  "pwsh",
  "node",
  "deno",
  "bun",
  "python",
  "python3",
  "ruby",
  "perl",
  "php",
  "eval",
  "source",
  "xargs",
  "make",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "docker",
  "podman",
  "ssh",
  "at",
  "cron",
  "systemd-run",
]);

export interface CommandAnalysis {
  /** Programs this command line names outright. */
  programs: string[];
  /**
   * Command heads whose program cannot be determined from the text — a variable
   * expansion, or a substitution standing where a program name should be. These
   * are reported rather than guessed at: naming one `$cmd` would be a fabricated
   * program name, and dropping it silently would let indirection pass as clean.
   */
  unresolved: string[];
  /** Observed programs that can execute further programs of their own. */
  vehicles: string[];
}

/** True for a segment that only assigns variables and runs nothing. */
const ASSIGNMENT_ONLY = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s*)+$/;

export function analyzeCommand(command: string): CommandAnalysis {
  const programs: string[] = [];
  const unresolved: string[] = [];
  for (const rawSegment of command.split(/\|\||&&|[|;\n]|\$\(|`/)) {
    let segment = rawSegment.trim();
    // Subshell and group openers, then any number of leading wrappers.
    segment = segment.replace(/^[([{\s]+/, "");
    // `CMD=whoami; "$CMD"` puts the assignment in a segment of its own, where it
    // runs nothing. This used to yield a program called `cmd=whoami`, which is a
    // divergence report naming something that does not exist.
    if (ASSIGNMENT_ONLY.test(segment)) continue;
    for (;;) {
      const before = segment;
      segment = segment.replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/, "");
      segment = segment.replace(/^(?:sudo|env|time|nohup|exec|command|nice)\s+/i, "");
      if (segment === before) break;
    }
    // A substitution or group closes on the token that ends it, so the head of
    // the final segment can carry the closer: `$(whoami)` splits to `whoami)`.
    const raw = segment.split(/\s+/)[0]?.replace(/[)}`;]+$/, "");
    if (raw === undefined || raw === "") continue;
    const head = raw.replace(/^["']|["']$/g, "");
    if (head === "") continue;
    if (/^[-<>&]/.test(head)) continue;
    if (head.startsWith("$")) {
      unresolved.push(head);
      continue;
    }
    programs.push(normalizeProgram(head));
  }
  const distinct = [...new Set(programs)];
  return {
    programs: distinct,
    unresolved: [...new Set(unresolved)],
    vehicles: distinct.filter((program) => INDIRECTION_VEHICLES.has(program)),
  };
}

function hostOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function normalizeWritePath(value: string): string {
  const segments: string[] = [];
  for (const segment of value.replaceAll("\\", "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    segments.push(segment);
  }
  return segments.join("/");
}

/** Tools whose `path` argument names something the task is about to write. */
const WRITING_TOOLS = new Set(["write", "edit"]);

/**
 * Tools that write a path of their own choosing, with no argument naming it.
 *
 * `write_result` takes only a body and always writes `result.json`, so without
 * this the one file almost every task writes was invisible: a declaration naming
 * it could never be marked satisfied, and a task that wrote it without declaring
 * it was never flagged.
 *
 * The evidence tools are the same shape and were missed on the first pass, where
 * they sat in `WRITING_TOOLS` keyed on a `path` argument they do not have — so
 * the entry matched nothing and the write went unobserved. Any tool added here
 * must write one fixed workspace path; a tool taking a caller-supplied path
 * belongs above.
 */
const FIXED_WRITE_TOOLS = new Map([
  ["write_result", "result.json"],
  ["record_finding", "findings.json"],
  ["verify_finding", "verification.json"],
]);

/**
 * Whether a declared entry covers an observed path.
 *
 * A declaration ending in `/` covers everything beneath it. Nothing else
 * widens: an entry matches a path exactly or not at all.
 */
function coversPath(declared: ReadonlySet<string>, observed: string): boolean {
  if (declared.has(observed)) return true;
  for (const entry of declared) {
    if (entry.endsWith("/") && (observed + "/").startsWith(entry)) return true;
  }
  return false;
}

interface Declared {
  commands: Set<string>;
  hosts: Set<string>;
  writes: Set<string>;
}

function emptyDeclared(): Declared {
  return { commands: new Set(), hosts: new Set(), writes: new Set() };
}

function accumulate(into: Declared, data: Record<string, unknown>): void {
  // Declared command text goes through the same reducer as observed command
  // text. Live measurement showed why this has to hold: models declare command
  // *lines* — "node sum.js", "cat clue.txt" — while the observation side sees the
  // program. Comparing one against the other never matched, so a task that
  // declared exactly what it then ran was reported as diverging from it.
  //
  // A declared pipeline therefore declares every program in it, which is the
  // same granularity the observation side works at.
  for (const value of strings(data["commands"])) {
    for (const program of programsInCommand(value)) into.commands.add(program);
  }
  for (const value of strings(data["hosts"])) into.hosts.add(value.trim().toLowerCase());
  for (const value of strings(data["writes"])) {
    const trimmed = value.trim().replaceAll("\\", "/");
    const directory = trimmed.endsWith("/");
    const normalized = normalizeWritePath(trimmed);
    if (normalized === "") continue;
    into.writes.add(normalized + (directory ? "/" : ""));
  }
}

/**
 * Incremental comparison, fed one event at a time in log order.
 *
 * Streaming rather than batch because the overlord watches a task's event stream
 * while it runs, and a divergence is worth knowing about at the moment it
 * happens rather than at settlement. It also bounds memory: nothing retains the
 * event log, only the declared sets and the flagged divergences, both already
 * capped by the declaration limits and `MAX_REPORTED_UNDECLARED`.
 *
 * `declaredLater` is maintained without a second pass. When a declaration
 * arrives naming something already flagged, that flag is amended in place. The
 * flag is never removed: an action already taken is not covered retroactively,
 * and the distinction between "never declared" and "declared too late" is
 * exactly what the amendment records.
 */
export interface IntentTracker {
  /** Feed one event. Returns a divergence if this event created a new one. */
  observe(event: IntentLogEvent): IntentObservation | undefined;
  /** Whether any event at all has been seen, which distinguishes idle from unread. */
  sawAnyEvent(): boolean;
  report(): IntentReport;
}

export function createIntentTracker(): IntentTracker {
  const inEffect = emptyDeclared();
  const seen = { commands: new Set<string>(), hosts: new Set<string>(), writes: new Set<string>() };
  const undeclared: IntentObservation[] = [];
  /**
   * Every distinct divergence, including those the listing had no room for.
   * Counted separately so the manifest still records that a task diverged forty
   * times rather than the twenty it has space to name — a truncated count would
   * make a flood look like a handful.
   */
  const flagged = new Set<string>();
  const vehicles = new Set<string>();
  let declarations = 0;
  let anyEvent = false;

  const flag = (
    kind: IntentObservation["kind"],
    value: string,
  ): IntentObservation | undefined => {
    const key = `${kind}:${value}`;
    if (flagged.has(key)) return undefined;
    flagged.add(key);
    if (undeclared.filter((item) => item.kind === kind).length >= MAX_REPORTED_UNDECLARED) {
      return undefined;
    }
    const observation: IntentObservation = { kind, value, declaredLater: false };
    undeclared.push(observation);
    return observation;
  };

  return {
    sawAnyEvent: () => anyEvent,

    observe(event) {
      anyEvent = true;
      if (event.type === INTENT_EVENT_TYPE) {
        const data = record(event.data);
        if (data === undefined) return undefined;
        declarations += 1;
        accumulate(inEffect, data);
        // Anything this declaration names that was already flagged was declared
        // too late rather than not at all.
        for (const item of undeclared) {
          if (item.declaredLater) continue;
          const named =
            item.kind === "command"
              ? inEffect.commands.has(item.value)
              : item.kind === "host"
                ? inEffect.hosts.has(item.value)
                : coversPath(inEffect.writes, item.value);
          if (named) item.declaredLater = true;
        }
        return undefined;
      }
      if (event.type !== "tool_start") return undefined;
      const data = record(event.data);
      if (data === undefined) return undefined;
      const tool = typeof data["tool"] === "string" ? data["tool"] : undefined;
      if (tool === undefined) return undefined;
      const args = record(data["args"]) ?? {};

      let first: IntentObservation | undefined;
      if (typeof args["command"] === "string") {
        const analysis = analyzeCommand(args["command"]);
        for (const program of analysis.programs) {
          seen.commands.add(program);
          if (!inEffect.commands.has(program)) first ??= flag("command", program);
        }
        for (const vehicle of analysis.vehicles) vehicles.add(vehicle);
        // A program named by a variable cannot be compared with a declaration,
        // and no declaration could ever cover it. Flagged with a marker rather
        // than a guessed name: an unverifiable action is not a clean one, and it
        // is not an action by a program called `$cmd` either.
        for (const text of analysis.unresolved) {
          const marker = `<unresolved:${text}>`;
          seen.commands.add(marker);
          first ??= flag("command", marker);
        }
      }
      const host = hostOf(args["url"]);
      if (host !== undefined) {
        seen.hosts.add(host);
        if (!inEffect.hosts.has(host)) first ??= flag("host", host);
      }
      const written =
        FIXED_WRITE_TOOLS.get(tool) ??
        (WRITING_TOOLS.has(tool) && typeof args["path"] === "string" ? args["path"] : undefined);
      if (written !== undefined) {
        const target = normalizeWritePath(written);
        if (target !== "") {
          seen.writes.add(target);
          if (!coversPath(inEffect.writes, target)) first ??= flag("write", target);
        }
      }
      return first;
    },

    report() {
      const observed = {
        commands: seen.commands.size,
        hosts: seen.hosts.size,
        writes: seen.writes.size,
      };
      const actions = observed.commands + observed.hosts + observed.writes;
      const ordered = [
        ...undeclared.filter((item) => item.kind === "command"),
        ...undeclared.filter((item) => item.kind === "host"),
        ...undeclared.filter((item) => item.kind === "write"),
      ];
      const indirection = [...vehicles].sort();
      // Stated on every outcome, including clean, because that is the one where
      // it changes what the outcome means.
      const caveat =
        indirection.length === 0
          ? []
          : [
              `This task ran ${indirection.join(", ")}, which can execute further programs that never appear as tool calls, so the observed command list is a lower bound.`,
            ];

      if (declarations === 0) {
        // Nothing declared. With no actions either there is nothing to conceal,
        // and the counts record that the verdict is vacuous rather than earned.
        if (actions === 0) {
          return {
            outcome: "clean" as const,
            declarations: 0,
            indirection,
            observed,
            undeclared: [],
            reasons: [
              "No declaration was made and no commands, requests or writes were observed.",
              ...caveat,
            ],
          };
        }
        return {
          outcome: "undeclared" as const,
          declarations: 0,
          indirection,
          observed,
          undeclared: ordered,
          reasons: [
            `${actions} action(s) were observed and the task never declared any, so its account of its own work cannot be checked.`,
            ...(ordered.length < flagged.size
              ? [`${flagged.size} were flagged; only ${ordered.length} are listed.`]
              : []),
            ...caveat,
          ],
        };
      }

      if (ordered.length === 0) {
        return {
          outcome: "clean" as const,
          declarations,
          indirection,
          observed,
          undeclared: [],
          reasons: [
            `Every observed action fell inside ${declarations} declaration(s).`,
            ...caveat,
          ],
        };
      }

      const retroactive = ordered.filter((item) => item.declaredLater);
      const reasons = [
        `${flagged.size} action(s) were taken that no declaration in effect at the time covered.`,
      ];
      if (ordered.length < flagged.size) {
        reasons.push(`Only ${ordered.length} of them are listed.`);
      }
      if (retroactive.length > 0) {
        reasons.push(
          `${retroactive.length} of the listed ones were named by a later declaration, which does not cover an action already taken.`,
        );
      }
      return {
        outcome: "diverged" as const,
        declarations,
        indirection,
        observed,
        undeclared: ordered,
        reasons: [...reasons, ...caveat],
      };
    },
  };
}

/** What a live event stream accumulated, as the source chooser needs to see it. */
export interface LiveIntentSource {
  sawAnyEvent: boolean;
  /**
   * Sequence number of the first event received. The service retains a bounded
   * event tail, so anything above 1 means earlier events — possibly the
   * declaration — were already gone before this stream was joined.
   */
  firstSeq: number | undefined;
  /** Whether the stream failed partway, which also disqualifies it. */
  broken: boolean;
  report(): IntentReport;
}

function unavailable(reasons: string[]): IntentReport {
  return {
    outcome: "unavailable",
    declarations: 0,
    indirection: [],
    observed: { commands: 0, hosts: 0, writes: 0 },
    undeclared: [],
    reasons,
  };
}

/**
 * Choose which account of a task's behaviour to believe.
 *
 * The order between the sources is the whole of the logic:
 *
 *   1. `eventRecord`, the overlord's own copy of the stream: the `EventRecord`
 *      this process kept, judged from memory, or, from a process that kept
 *      none, the events `readEventRecord` read back from its file.
 *   2. `recorded`, ling's log as the service serves it (`GET /tasks/:id/log`,
 *      through `history()`). Outside the workspace now, but on an unsandboxed
 *      host the task shares a user with the service that keeps it, and can
 *      rewrite the log in place without leaving a gap.
 *   3. `live`, what the driver's tracker saw — but only when no record was
 *      kept. The tracker and the record are fed by the same tap, so a record
 *      found incomplete means the tracker missed the same events.
 *
 * The record ranks first because it is the hardest account for the task to
 * reach, not because it is out of reach. Held in the memory of the process
 * that kept it, it is what the stream delivered. Its file is out of the task's
 * reach only where the task's shell is kept from it: ling on another host or
 * as another user, or docker mode short of a race against the file tools'
 * guard. With ling auto-started beside the overlord and the sandbox off, the
 * default, the task runs as the overlord's user, and the file read back after a
 * restart is as reachable as ling's log (see event-record.ts).
 *
 * Below the record the order is not by reach: the tracker, which lives in the
 * overlord's memory like the record, ranks under ling's log, which the task can
 * reach more easily, because the log is uncapped while the tracker saw only
 * the stream the driver joined, which may have started after ling's retained
 * tail rolled. That matters little where the driver keeps a record, as the
 * record outranks both, and the driver keeps one for every task it taps. A task
 * it never tapped, on an unsandboxed host, that rewrites its log in place is
 * still believed over the tracker.
 *
 * A source carrying sequence numbers is believed only when they run gaplessly
 * from 1 to a terminal event; one that does not is passed over and its reason
 * kept, so a later source can still answer and, if none can, the report says
 * why each was refused. No branch turns a partial account into `clean`.
 *
 * A `recorded` log with no sequence numbers at all cannot be checked for gaps.
 * It is taken as given, which is the contract `CampaignLingClient.history` has
 * always had and what a client written before sequence numbers still returns.
 * `LingClient` never returns one: every source it reads is sequenced. What it
 * no longer reads is the workspace's `events.jsonl`, which the task it judged
 * could rewrite.
 *
 * Kept pure and separate from the driver because it is the piece most likely to
 * be wrong in a way nothing notices: every branch here that could plausibly
 * return `clean` from a partial account is a silent false pass, and the only way
 * to hold that down is to be able to test the branches directly.
 */
export function resolveIntentReport(options: {
  toolAvailable: boolean;
  /**
   * The overlord's own record of the task's stream, when one was kept: the
   * `EventRecord` itself from the process that kept it, or the events
   * `readEventRecord` returned from one that did not.
   */
  eventRecord?: readonly IntentLogEvent[] | Pick<EventRecord, "events" | "assess"> | undefined;
  /** The service's log, or undefined when it could not be read. */
  recorded: readonly IntentLogEvent[] | undefined;
  live?: LiveIntentSource | undefined;
}): IntentReport {
  const { toolAvailable, eventRecord, recorded, live } = options;
  if (!toolAvailable) return diffIntent([], false);

  const refused: string[] = [];
  if (eventRecord !== undefined) {
    // A kept record answers from memory, and its own assessment counts a
    // conflicting replay, which its first-seen events alone would hide.
    const [events, assessment] =
      "assess" in eventRecord
        ? ([eventRecord.events(), eventRecord.assess()] as const)
        : ([inSequenceOrder(eventRecord), assessEventSequence(eventRecord)] as const);
    if (assessment.complete) return diffIntent(events, true);
    refused.push(`The overlord's event record for this task ${assessment.reason}.`);
  }
  if (recorded !== undefined && recorded.length > 0) {
    if (recorded.every((event) => event.seq === undefined)) return diffIntent(recorded, true);
    const assessment = assessEventSequence(recorded);
    if (assessment.complete) return diffIntent(inSequenceOrder(recorded), true);
    refused.push(`The service's event log for this task ${assessment.reason}.`);
  }
  if (eventRecord === undefined && live !== undefined && live.sawAnyEvent) {
    if (live.firstSeq === 1 && !live.broken) return live.report();
    return unavailable([
      ...refused,
      live.broken
        ? "The event stream for this task failed partway through, so its behaviour is only partly known."
        : `The event stream for this task began at sequence ${live.firstSeq ?? 0} rather than 1, so earlier events including any declaration were already lost.`,
    ]);
  }
  if (refused.length > 0) return unavailable(refused);
  return diffIntent(recorded, true);
}

/**
 * Walk one task's event log and report where its behaviour left its declaration.
 *
 * `toolAvailable` is the role's own tool list rather than anything observed: a
 * role never given `declare_intent` opted out, and that is a decision to record
 * rather than a divergence to report.
 */
export function diffIntent(
  events: readonly IntentLogEvent[] | undefined,
  toolAvailable: boolean,
): IntentReport {
  const base: IntentReport = {
    outcome: "unavailable",
    declarations: 0,
    indirection: [],
    observed: { commands: 0, hosts: 0, writes: 0 },
    undeclared: [],
    reasons: [],
  };
  if (!toolAvailable) {
    return {
      ...base,
      outcome: "inapplicable",
      reasons: ["This role was not given declare_intent, so no declaration was expected."],
    };
  }
  if (events === undefined) {
    return {
      ...base,
      reasons: ["No event history could be read for this task, so its behaviour is unknown."],
    };
  }
  // An empty log is not an idle task. Every task that reaches a terminal state
  // emits lifecycle events, so zero events means the log was not reached at
  // all — which `history()` reports by returning an empty array rather than by
  // failing, when the log route, the stream and its replay all came back
  // empty. Reading that as "did nothing" would turn an unreachable worker into
  // a permanent clean verdict.
  if (events.length === 0) {
    return {
      ...base,
      reasons: [
        "The event history for this task was empty, which means it was not reached rather than that the task did nothing.",
      ],
    };
  }

  const tracker = createIntentTracker();
  for (const event of events) tracker.observe(event);
  return tracker.report();
}
