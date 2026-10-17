import {
  closeSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  mkdirSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { CAMPAIGN_SEND_TOOL_NAME } from "./campaign.js";
import type { Config } from "./config.js";
import { composeFeatures, featureToolNames, type FeatureContext } from "./features/index.js";
import { HoldGate, oversightTimings, workerVariantRefusal } from "./features/oversight.js";
import { MAX_RESULT_BYTES } from "./features/write-result.js";
import {
  guardCommands,
  openRegularFile,
  openRegularFileSync,
  resolveInsideWorkspace,
} from "./guards.js";
import { INTENT_EVENT_TYPE } from "./intent.js";
import { declaredTools, type AgentHarness, type HarnessExtension, type HarnessSession } from "./harness/index.js";
import {
  HOLD_LAPSE_GRACE_MS,
  isOversightTool,
  MAX_CREDITED_HOLDS,
  MAX_HOLD_CREDIT_MS,
  oversightRole,
  systemClock,
  type Clock,
} from "./oversight.js";
import { buildSystemPrompt } from "./prompt.js";
import { promptDigest } from "./prompt-digest.js";
import type {
  StopReason,
  TaskEmitter,
  TaskEvent,
  TaskOutcome,
  TaskRecord,
  TaskRunner,
  TaskStats,
  TaskStore,
} from "./queue.js";
import { eventLogFile } from "./retention.js";
import { createSandbox } from "./sandbox.js";
import { createHttpTool } from "./tools/http.js";
import type { AnyToolDefinition } from "./tools/types.js";
import {
  cleanupTaskSkills,
  discoverNamedSkills,
  materializeInlineSkills,
  resolveNamedSkillPaths,
  type NamedSkillCatalog,
} from "./skills.js";

const EMPTY_STATS: TaskStats = {
  turns: 0,
  cost: 0,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export interface RunnerDeps {
  config: Config;
  harness: AgentHarness;
  namedSkills?: NamedSkillCatalog;
  /** The wall clock and the oversight waits read this; the checks inject one. */
  clock?: Clock;
}

/** Every tool a task may enable, in the order they are advertised to the model. */
export const allToolNames: readonly string[] = [
  "read",
  "write",
  "edit",
  "grep",
  "find",
  "ls",
  "bash",
  "http_request",
  ...featureToolNames,
];

/**
 * The default tool set. Two capabilities are opt-in rather than default:
 * campaign messaging, because it only means something inside a campaign, and
 * the oversight tools, which give a task a role. A default that included them
 * would make every task both a worker and a watcher.
 */
export const defaultToolNames: readonly string[] = allToolNames.filter(
  (name) => name !== CAMPAIGN_SEND_TOOL_NAME && !isOversightTool(name),
);

/**
 * The harness events a tools_unrecorded task keeps: all but `tool_start`
 * and `tool_end`, which carry its calls' tools and arguments. Named rather
 * than excepted, so that an event a later adapter adds is kept from such a
 * task only once someone has decided it may be. They are dropped before
 * `emit`, so no seq is spent on them and the stream stays gapless, and the
 * store, the event log, the SSE tail and an overlord reading any of them
 * never see a call. Tool output is in no event at all: `tool_end` carries
 * only the tool and whether it failed.
 */
const UNRECORDED_KEPT_EVENTS: ReadonlySet<string> = new Set([
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "compaction_start",
  "compaction_end",
  "auto_retry_start",
  "auto_retry_end",
  "model_response",
  "assistant_text",
]);

/**
 * The digest of what a task's model is shown (pilot plan §2.1, §2.4): its
 * system prompt and the tools its first request declares, in the canonical
 * form `prompt-digest.ts` documents.
 */
export { promptDigest };

/**
 * Hears what the provider is sent on the task's first model call, and digests
 * it (`promptDigest`). The system prompt is the one Pi renders when the run
 * starts: this ling's prompt and Pi's own sections after it, such as `<cwd>`.
 * A task prompts its session once, so the first is the task's. The tools are
 * those the first request's transcript declares (`declaredTools`), heard in
 * `context_with_system`: after every extension's context hooks, whatever
 * registered the tools. Pi 1.0.3 then applies two projections of its own
 * (agent-session.js `_installHiddenDeclarationsProjection`, which drops tools
 * a `prepareLoadout` hook hides, and `_installAgentForcedPromptProjection`,
 * for a forced system prompt). Ling uses neither, so what is heard here is
 * what the model is sent; the scripted trace, taken in `streamFn` after both,
 * is checked against this digest in the overlord's dry runs. Placed last, the
 * tap sees both after every other handler, and changes neither. A run whose
 * model is never called, including one that started but ended before its
 * first request, has no digest.
 */
function promptDigestTap(workspaceDir: string, record: (digest: string) => void): HarnessExtension {
  return {
    name: "prompt-digest",
    factory: (pi) => {
      let systemPrompt: string | undefined;
      let recorded = false;
      pi.on("before_agent_start", (event) => {
        systemPrompt ??= event.systemPrompt;
      });
      pi.on("context_with_system", (event) => {
        if (recorded || systemPrompt === undefined) return;
        recorded = true;
        record(promptDigest(systemPrompt, declaredTools(event.messages), workspaceDir));
      });
    },
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Append events to a log that must be a regular file. Never follows a link; throws on failure. */
function appendEventLines(file: string, events: readonly TaskEvent[], prefix = ""): void {
  const fd = openRegularFileSync(
    file,
    fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT,
  );
  try {
    writeFileSync(fd, prefix + events.map((event) => `${JSON.stringify(event)}\n`).join(""));
  } finally {
    closeSync(fd);
  }
}

function appendEventLine(file: string, event: TaskEvent): void {
  try {
    appendEventLines(file, [event]);
  } catch (error) {
    console.error(`event log append failed for ${file}: ${describeError(error)}`);
  }
}

const LOG_TAIL_CHUNK_BYTES = 64 * 1024;

/** The seq a log line carries, or undefined for a line that is not an event. */
function loggedSeq(line: Buffer): number | undefined {
  try {
    const seq = (JSON.parse(line.toString("utf8")) as { seq?: unknown } | null)?.seq;
    return typeof seq === "number" && Number.isInteger(seq) && seq > 0 ? seq : undefined;
  } catch {
    return undefined;
  }
}

/** Split at newline bytes, which never occur inside a multi-byte UTF-8 character. */
function splitLines(bytes: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  let from = 0;
  for (let at = bytes.indexOf(0x0a); at !== -1; at = bytes.indexOf(0x0a, from)) {
    lines.push(bytes.subarray(from, at));
    from = at + 1;
  }
  lines.push(bytes.subarray(from));
  return lines;
}

/**
 * Where a log ends: the seq of its last event, 0 when it has none yet, and
 * whether its last line was finished. Read backwards a chunk at a time, since a
 * log is uncapped and only its end is wanted. Undefined for a file that holds
 * bytes but no event, which is not a log this service can extend.
 */
function loggedEnd(file: string): { seq: number; terminated: boolean } | undefined {
  let fd: number;
  try {
    fd = openRegularFileSync(file, fsConstants.O_RDONLY);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { seq: 0, terminated: true };
    throw error;
  }
  try {
    let end = fstatSync(fd).size;
    if (end === 0) return { seq: 0, terminated: true };
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, end - 1);
    const terminated = last[0] === 0x0a;
    // Bytes not judged yet. Until the read reaches the start of the file, the
    // first line among them may be the end of a longer one, so it waits.
    let pending: Buffer = Buffer.alloc(0);
    while (end > 0) {
      const start = Math.max(0, end - LOG_TAIL_CHUNK_BYTES);
      const chunk = Buffer.alloc(end - start);
      readSync(fd, chunk, 0, chunk.length, start);
      pending = Buffer.concat([chunk, pending]);
      end = start;
      const lines = splitLines(pending);
      const head = end > 0 ? lines.shift() : undefined;
      for (const line of lines.reverse()) {
        const seq = loggedSeq(line);
        if (seq !== undefined) return { seq, terminated };
      }
      pending = head ?? Buffer.alloc(0);
    }
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/**
 * Copy into each task's log the retained events it lacks.
 *
 * The store can append without passing through the wrapper. Recovery marks a
 * task that was running when ling stopped as interrupted inside the store's
 * constructor, before anything can wrap it, and a crash can fall between the
 * store's commit and the log's append. Either leaves a log short of its newest
 * events — for an interrupted task, short of its terminal event, so the log
 * would read as incomplete for good. The newest events are the ones the store
 * still retains, so they are copied from there. One that has already rolled out
 * of the retained tail cannot be, and stays a gap. A task with no log yet, such
 * as one older than the log's move out of the workspace, gets one written from
 * the tail, which is what the SSE route would replay for it.
 *
 * A last line a crash left unfinished is closed off with a newline before
 * anything follows it, so the event after it is not swallowed. The torn line is
 * left as found, and a strict reader refuses the log because of it.
 */
function reconcileEventLogs(store: TaskStore, eventLogDir: string): void {
  for (const task of store.list()) {
    if (task.events.length === 0) continue;
    const file = eventLogFile(eventLogDir, task.id);
    try {
      const end = loggedEnd(file);
      if (end === undefined) {
        console.error(`event log ${file} holds no event this service wrote, so it was not extended`);
        continue;
      }
      const missing = task.events.filter((event) => event.seq > end.seq);
      if (missing.length === 0 && end.terminated) continue;
      appendEventLines(file, missing, end.terminated ? "" : "\n");
    } catch (error) {
      console.error(`event log reconcile failed for ${file}: ${describeError(error)}`);
    }
  }
}

/**
 * The operator's event log: every event the queue appends, one JSON line per
 * event in `<eventLogDir>/<task-id>.jsonl`.
 *
 * Kept at the store seam rather than in the runner for two reasons. A line then
 * carries the same `seq` the SSE stream does and the lifecycle events the queue
 * emits around a run, so a reader can tell a log that runs gaplessly from 1 to a
 * terminal event from one with a hole in it — which a seq-less log never let
 * anyone do. And it sits outside the workspace: it used to be `events.jsonl`
 * beside the task's own files, editable by the task it describes.
 *
 * Appends never follow a link, so a log replaced by one is refused rather than
 * written through. That stops a swapped-in link and nothing more: with the
 * sandbox off the task runs as this service's user, can rewrite this file in
 * place with its sequence numbers kept, and the log still reads as whole. The
 * overlord's own event record is out of the task's reach only where the task's
 * shell is kept from it too: in docker mode, short of a race against the file
 * tools' guard (`resolveInsideWorkspaceReal`), or with the overlord on another
 * host or as another user. A ling the overlord auto-started with the sandbox
 * off runs the task as the overlord's own user, and that user can rewrite the
 * record's file as easily as this one.
 *
 * A failed append is reported and not retried while the service runs, so the
 * log has a gap, which reads as incomplete — the failure that cannot pass for a
 * clean record. Wrapping a store first copies into each log the retained events
 * it lacks (`reconcileEventLogs`), which fills that gap at the next start if the
 * event is still retained, and the one recovery leaves when it marks a task
 * interrupted before the wrapper exists.
 */
export function recordEventLog(store: TaskStore, eventLogDir: string): TaskStore {
  mkdirSync(eventLogDir, { recursive: true });
  reconcileEventLogs(store, eventLogDir);
  return {
    create: (input, workspaceDir) => store.create(input, workspaceDir),
    get: (id) => store.get(id),
    getByRequestKey: (createdBy, requestKey) => store.getByRequestKey(createdBy, requestKey),
    list: () => store.list(),
    counts: () => store.counts(),
    update: (id, patch) => store.update(id, patch),
    deleteTerminalBefore: (cutoffIso) => store.deleteTerminalBefore(cutoffIso),
    close: () => store.close(),
    appendEvent(id, type, data) {
      const event = store.appendEvent(id, type, data);
      if (event !== undefined) appendEventLine(eventLogFile(eventLogDir, id), event);
      return event;
    },
  };
}

export function resolveModel(deps: RunnerDeps, modelId?: string) {
  const { config, harness } = deps;
  const wanted = modelId ?? config.model;
  const model = harness.resolveModel(config.provider, wanted);
  if (!model) {
    const known = harness.listModelIds(config.provider).slice(0, 20);
    throw new Error(
      `Model ${config.provider}/${wanted} not found. Known ${config.provider} models include: ${known.join(", ") || "(none)"}. Run \`npm run models\` for the full list.`,
    );
  }
  return model;
}

/** Resolve a caller-supplied storageState name to a file inside auth/. */
function resolveStorageState(config: Config, name: string | undefined): string | undefined {
  if (name === undefined || name.trim() === "") return undefined;
  const fileName = name.endsWith(".json") ? name : `${name}.json`;
  const resolved = resolveInsideWorkspace(config.authDir, fileName, "the auth directory");
  if (!existsSync(resolved)) {
    throw new Error(
      `Browser auth state "${name}" not found at ${resolved}. Create it with \`npm run browser-login\`.`,
    );
  }
  return resolved;
}

export function createTaskRunner(deps: RunnerDeps): TaskRunner {
  const { config, harness } = deps;
  const namedSkills = deps.namedSkills ?? discoverNamedSkills(config.skillsDir);

  return async function runTask(
    task: TaskRecord,
    signal: AbortSignal,
    emit: TaskEmitter,
    messages,
  ): Promise<TaskOutcome> {
    const workspaceDir = task.workspaceDir;
    // Per-task overrides, already validated and clamped by the HTTP layer.
    const limits = {
      maxTurns: task.options.maxTurns ?? config.maxTurns,
      maxWallClockMs: task.options.maxWallClockMs ?? config.maxWallClockMs,
      maxCostUsd: task.options.maxCostUsd ?? config.maxCostUsd,
    };
    const thinking = task.options.thinking ?? config.thinking;
    const toolNames = task.options.tools ?? defaultToolNames;
    const variant = task.options.variant;
    const unrecorded = variant === "tools_unrecorded";
    const taskRuntimeDir = path.join(config.taskRuntimeDir, task.id);

    await mkdir(path.join(workspaceDir, "scripts"), { recursive: true });
    await mkdir(path.join(workspaceDir, "artifacts"), { recursive: true });
    for (const [name, content] of Object.entries(task.seedFiles ?? {})) {
      const target = resolveInsideWorkspace(workspaceDir, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    }

    // Everything emitted here reaches the operator's event log through the store
    // (`recordEventLog`), outside the workspace, so the runner keeps no log of
    // its own for the task to edit.
    let turns = 0;
    // Cast keeps the union wide: every assignment happens inside stop(), which
    // control flow analysis cannot see, so a narrowed literal type would make
    // the outcome checks below look unreachable.
    let stoppedBy = "finished" as StopReason;
    let budgetNote: string | undefined;
    let session: HarnessSession | undefined;
    let abortPromise: Promise<void> | undefined;
    let unsubscribe: (() => void) | undefined;
    let promptError: string | undefined;
    let stats: TaskStats = EMPTY_STATS;
    let taskPromptDigest: string | undefined;
    const artifacts: string[] = [];
    const clock = deps.clock ?? systemClock;
    const runStarted = clock.now();
    const role = oversightRole(toolNames);
    // Aborted first on every stop, so a call parked on a hold or a blocked
    // oversight wait settles even when the stop lands before Pi's own signal
    // fires; session.abort() waits for idle and would otherwise hang on it.
    const stopController = new AbortController();
    const holdGate = new HoldGate({ clock, emit });

    // Budgets are armed before setup so a cancel or timeout during model and
    // session construction still takes effect. session may not exist yet; the
    // pre-prompt check below covers that window.
    const stop = (reason: StopReason, note?: string) => {
      if (stoppedBy !== "finished") return;
      stoppedBy = reason;
      budgetNote = note;
      stopController.abort();
      messages.close();
      session?.clearQueue();
      emit("budget_stop", { reason, note });
      if (session !== undefined) {
        abortPromise ??= session.abort().catch((error: unknown) => {
          promptError ??= error instanceof Error ? error.message : String(error);
        });
      }
    };

    // A watcher's hold must not spend A's own time: two back-to-back holds of
    // 300 s would use up a 600 s budget and let the watcher force a timeout.
    // So the limit grows by the time the first two watcher holds were actually
    // in place, each counted to at most its lapse. A self-hold earns nothing,
    // since A chose it, and nor does a third watcher hold, which a correct
    // overlord never applies; the cap keeps a faulty one from extending A
    // without bound. The timeout waits while a credit-earning hold is in place,
    // which its lapse bounds.
    //
    // Counted in whole milliseconds: the real clock reads fractions of one
    // (performance.now()), oversight_clock must carry integers, and the credit
    // the timer applies is then exactly the credit the overlord is told of.
    const credited: { holdId: string; engagedAt: number; maxMs: number; endedAt?: number }[] = [];
    let timeoutDeferred = false;
    const heldMs = (hold: (typeof credited)[number]) =>
      Math.max(0, Math.round((hold.endedAt ?? clock.now()) - hold.engagedAt));
    const holdCreditMs = () =>
      Math.min(
        MAX_HOLD_CREDIT_MS,
        credited.reduce((total, hold) => total + Math.min(heldMs(hold), hold.maxMs + HOLD_LAPSE_GRACE_MS), 0),
      );
    const creditRunning = () => credited.some((hold) => hold.endedAt === undefined);
    let cancelWallClock: () => void = () => undefined;
    const checkWallClock = () => {
      if (creditRunning()) {
        timeoutDeferred = true;
        return;
      }
      const credit = holdCreditMs();
      const remaining = limits.maxWallClockMs + credit - (clock.now() - runStarted);
      if (remaining > 0) {
        cancelWallClock = clock.schedule(remaining, checkWallClock);
        return;
      }
      stop(
        "timeout",
        `wall clock limit of ${limits.maxWallClockMs}ms reached${credit > 0 ? ` (+${credit}ms hold credit)` : ""}`,
      );
    };
    cancelWallClock = clock.schedule(limits.maxWallClockMs, checkWallClock);
    const stopCrediting = holdGate.subscribe((change) => {
      if (change.origin !== "watcher") return;
      if (change.kind === "engaged") {
        if (credited.length < MAX_CREDITED_HOLDS) {
          credited.push({ holdId: change.holdId, engagedAt: change.at, maxMs: change.maxMs });
        }
        return;
      }
      const hold = credited.find((entry) => entry.holdId === change.holdId && entry.endedAt === undefined);
      if (hold === undefined) return;
      hold.endedAt = change.at;
      const creditMs = holdCreditMs();
      emit("oversight_clock", {
        holdId: hold.holdId,
        heldMs: heldMs(hold),
        creditMs,
        limitMs: limits.maxWallClockMs + creditMs,
      });
      if (timeoutDeferred && !creditRunning()) {
        timeoutDeferred = false;
        checkWallClock();
      }
    });
    const onExternalAbort = () => stop("cancelled", "cancelled by operator");
    if (signal.aborted) {
      stop("cancelled", "cancelled before the run started");
    } else {
      signal.addEventListener("abort", onExternalAbort, { once: true });
    }

    const sandbox = createSandbox({ config, taskId: task.id, workspaceDir });

    try {
      if (
        task.options.provider !== undefined &&
        task.options.provider !== config.provider
      ) {
        throw new Error(
          `Task requested provider ${JSON.stringify(task.options.provider)}, but this worker is configured for ${JSON.stringify(config.provider)}.`,
        );
      }
      // POST /tasks refuses these already. Checked again here, before any
      // model call, so that what a tools_unrecorded run can do never rests on
      // how its task reached the queue.
      const variantRefusal = variant === undefined ? undefined : workerVariantRefusal(variant, toolNames);
      if (variantRefusal !== undefined) throw new Error(variantRefusal);
      const model = resolveModel(deps, task.options.model);
      const storageStatePath = resolveStorageState(config, task.storageState);
      const namedSkillNames = task.options.skills ?? [];
      const inlineSkills = task.options.inlineSkills ?? [];
      if (new Set(namedSkillNames).size !== namedSkillNames.length) {
        throw new Error("Task contains duplicate named skill ids.");
      }
      if (namedSkillNames.length + inlineSkills.length > config.maxSkillsPerTask) {
        throw new Error(
          `Task selects more than this worker's ${config.maxSkillsPerTask}-skill limit.`,
        );
      }
      if (inlineSkills.length > 0 && !config.allowInlineSkills) {
        throw new Error("Task contains inline skills, but this worker policy disables them.");
      }
      const shadowed = inlineSkills.find((skill) => namedSkills.has(skill.name));
      if (shadowed !== undefined) {
        throw new Error(
          `Inline skill ${JSON.stringify(shadowed.name)} shadows an image-provided skill.`,
        );
      }
      const requestedSkillPaths = [
        ...resolveNamedSkillPaths(namedSkills, namedSkillNames),
        ...(await materializeInlineSkills(
          taskRuntimeDir,
          inlineSkills,
          {
            maxCount: config.maxInlineSkillsPerTask,
            maxBytesPerSkill: config.maxInlineSkillBytes,
            maxTotalBytes: config.maxInlineSkillsTotalBytes,
          },
        )),
      ];

      await sandbox.start();
      if (sandbox.enabled) {
        emit("sandbox_started", { mode: config.sandboxMode, image: config.sandboxImage });
      }

      const featureContext: FeatureContext = {
        config,
        taskId: task.id,
        workspaceDir,
        ...(storageStatePath !== undefined ? { storageStatePath } : {}),
        onArtifacts: (paths) => artifacts.push(...paths),
        onCampaignMessage: (message) => emit("campaign_message", message),
        onIntentDeclaration: (declaration) => emit(INTENT_EVENT_TYPE, declaration),
        subscribeCampaignMessages: (listener) => messages.subscribe(listener),
        toolNames,
        ...(variant !== undefined ? { variant } : {}),
        onOversightEvent: emit,
        subscribeOversight: (listener) => messages.subscribeOversight(listener),
        holdGate,
        stopSignal: stopController.signal,
        oversight: oversightTimings(config),
        clock,
      };
      const features = composeFeatures(
        featureContext,
        toolNames,
        {
          maxCostUsd: limits.maxCostUsd,
          maxToolResultChars: config.maxToolResultChars,
          maxToolResultCharsPerTurn: config.maxToolResultCharsPerTurn,
          getCurrentCostUsd: () => session?.getStats().cost ?? 0,
          onCostLimit: (note) => stop("max_cost", note),
        },
        requestedSkillPaths,
      );

      // guardCommands keeps the shell denylist structural. The tool_call handler
      // enforces it too, and covers far more, but only once extensions are bound.
      const tools: AnyToolDefinition[] = [
        ...harness.createWorkspaceTools(workspaceDir, {
          spawnHook: sandbox.spawnHook,
          wrap: guardCommands,
        }),
        guardCommands(createHttpTool(config)),
      ];

      session = await harness.createSession({
        workspaceDir,
        agentDir: config.agentDir,
        model,
        thinkingLevel: thinking,
        toolNames,
        tools,
        extensions: [
          ...features.extensions,
          promptDigestTap(workspaceDir, (digest) => {
            taskPromptDigest ??= digest;
          }),
        ],
        skillPaths: features.skillPaths,
        buildSystemPrompt: () =>
          buildSystemPrompt({
            workspaceDir,
            maxTurns: limits.maxTurns,
            maxWallClockMs: limits.maxWallClockMs,
            featureSections: features.promptSections,
            ...(task.options.instructions !== undefined
              ? { instructions: task.options.instructions }
              : {}),
            ...(role !== undefined ? { role } : {}),
            ...(variant !== undefined ? { variant } : {}),
          }),
      });

      // The harness binds extension handlers, but whether the guards actually
      // arrived is this layer's business: a silent miss would run the task
      // unguarded, so treat it as a setup failure rather than trusting an
      // adapter to have got it right.
      if (!session.hasToolCallInterception()) {
        throw new Error("Tool guards are not active: the guard extension failed to bind.");
      }

      unsubscribe = session.subscribe((event) => {
        if (!unrecorded || UNRECORDED_KEPT_EVENTS.has(event.type)) emit(event.type, event.data);

        if (event.type !== "turn_end" || !session) return;

        turns += 1;
        const current = session.getStats();
        if (turns >= limits.maxTurns) {
          stop("max_turns", `turn limit of ${limits.maxTurns} reached`);
        } else if (current.cost > limits.maxCostUsd) {
          stop(
            "max_cost",
            `cost limit of $${limits.maxCostUsd.toFixed(2)} exceeded at $${current.cost.toFixed(4)}`,
          );
        }
      });

      if (stoppedBy === "finished") {
        await session.prompt(task.prompt);
      }
    } catch (error) {
      promptError = error instanceof Error ? error.message : String(error);
    } finally {
      cancelWallClock();
      stopCrediting();
      // Nothing waits on the gate or an oversight wait once the prompt has
      // returned; this settles anything that somehow still does.
      stopController.abort();
      signal.removeEventListener("abort", onExternalAbort);
      unsubscribe?.();
      messages.close();
      session?.clearQueue();

      if (session) {
        if (abortPromise !== undefined || session.isStreaming) {
          try {
            await (abortPromise ?? session.abort());
          } catch (error) {
            promptError ??= error instanceof Error ? error.message : String(error);
          }
        }
        const sessionStats = session.getStats();
        stats = { turns, cost: sessionStats.cost, tokens: sessionStats.tokens };
        const teardownError = await session.shutdown();
        if (teardownError !== undefined) {
          emit("teardown_failed", { error: teardownError });
        }
      }
      holdGate.dispose();
      try {
        await sandbox.stop();
      } finally {
        session?.dispose();
        try {
          await cleanupTaskSkills(taskRuntimeDir);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          promptError ??= `Unable to clean task skill runtime: ${message}`;
          emit("skill_cleanup_failed", { error: message });
        }
      }
    }

    let result: unknown;
    let resultRefusal: string | undefined;
    try {
      result = await readResult(workspaceDir);
    } catch (error) {
      if (!(error instanceof ResultRefused)) throw error;
      resultRefusal = error.message;
    }
    // Whatever the run's end, if its model was sent a prompt.
    const digest = taskPromptDigest === undefined ? {} : { promptDigest: taskPromptDigest };

    if (stoppedBy === "cancelled") {
      return {
        status: "failed",
        stoppedBy,
        error: budgetNote ?? "cancelled",
        stats,
        artifacts,
        result,
        ...digest,
      };
    }

    // A budget stop aborts the session, which makes prompt() reject. The abort
    // message describes the symptom, so the reason that triggered it wins.
    if (stoppedBy !== "finished") {
      return {
        status: "failed",
        stoppedBy,
        error: budgetNote ?? `stopped by ${stoppedBy}`,
        stats,
        artifacts,
        result,
        ...digest,
      };
    }

    if (promptError !== undefined) {
      return { status: "failed", stoppedBy: "error", error: promptError, stats, artifacts, result, ...digest };
    }

    if (resultRefusal !== undefined) {
      return { status: "failed", stoppedBy: "error", error: resultRefusal, stats, artifacts, ...digest };
    }

    if (result === undefined) {
      return {
        status: "failed",
        stoppedBy: "error",
        error: "The agent finished without writing result.json.",
        stats,
        artifacts,
        ...digest,
      };
    }

    return { status: "completed", stoppedBy: "finished", result, stats, artifacts, ...digest };
  };
}

/** result.json exists but was not read: a link, not a regular file, unreadable, or too large. */
export class ResultRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResultRefused";
  }
}

/**
 * Read the task's result.json, if it wrote one.
 *
 * The file is task-written, so it is read the way an untrusted file should be:
 * never through a link, regular files only, and never more than write_result
 * would have written. A link here was the one route by which a sandboxed task
 * could have the service read a host file for it — the container cannot reach
 * the service's `.env`, but a `result.json` symlink to it, followed by this
 * process, could, and the contents would leave as the task's result.
 *
 * A file that is there but not read throws `ResultRefused`, and the runner
 * fails the task with it. Before the refusals existed an unreadable file failed
 * the task too; reporting `completed` with a placeholder result would say the
 * run succeeded at the one thing it had left to do. Invalid JSON is different:
 * the file was read, and what it says is kept for the caller to judge.
 */
export async function readResult(workspaceDir: string): Promise<unknown> {
  const resultPath = path.join(workspaceDir, "result.json");
  const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));
  let handle;
  try {
    handle = await openRegularFile(resultPath, fsConstants.O_RDONLY);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ResultRefused(`result.json was not read: ${describe(error)}`);
  }
  let raw: string;
  try {
    // Read one byte past the cap rather than trusting the size, which a
    // concurrent writer can change between the stat and the read.
    const buffer = Buffer.alloc(MAX_RESULT_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      let bytesRead: number;
      try {
        ({ bytesRead } = await handle.read(buffer, length, buffer.length - length, length));
      } catch (error) {
        throw new ResultRefused(`result.json was not read: ${describe(error)}`);
      }
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_RESULT_BYTES) {
      throw new ResultRefused(
        `result.json exceeds the ${MAX_RESULT_BYTES}-byte (${MAX_RESULT_BYTES / 1024} KiB) limit write_result enforces, so it was not read.`,
      );
    }
    raw = buffer.subarray(0, length).toString("utf8");
  } finally {
    await handle.close();
  }
  try {
    return JSON.parse(raw);
  } catch {
    return { status: "unknown", summary: "result.json was not valid JSON", raw: raw.slice(0, 4000) };
  }
}
