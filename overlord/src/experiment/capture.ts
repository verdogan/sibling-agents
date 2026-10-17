/**
 * What the scorer needs from a run's tasks, taken before their leases go
 * (pilot build plan B9, B13): a client decorator that, when the driver
 * releases a builder or a model B, first reads the task and, for a builder,
 * its final-state record, and records where the child ran. A builder the
 * driver never releases (F5: it keeps one whose result it rejected) is taken
 * after `driver.run()` by `captureUnreleased`. A run with no record is
 * excluded as `instrument_missing:final_state`, so a capture that fails is
 * recorded with its error and never breaks the driver's release path.
 *
 * The decorator defines an optional client method only where the inner
 * client has it: the driver reads the presence of `release` and `terminate`
 * as "this client has leases" (LEASE_ONLY_VARIANTS). It goes inside
 * `withScriptedWatcher`, so a scripted watcher's release never reaches it.
 *
 * Also here: the `served` list built from the `model_response` events (one
 * entry per call, A's and a model B's), and the files a run directory gets
 * from the captures.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { CampaignLingClient } from "../campaign/driver.js";
import type {
  LingProvisioner,
  ProvisionedLingClient,
  ProvisionedWorkerRuntimePaths,
} from "../ling/provisioner.js";
import type { LingEvent, LingFinalState, LingTask, SpawnInput } from "../ling/types.js";
import { MODEL_RESPONSE_EVENT, type ChildPaths, type ServedCall } from "./records.js";

export type CapturedRole = "builder" | "watcher";

export interface CapturedTask {
  taskId: string;
  workerId: string | undefined;
  role: CapturedRole;
  requestKey: string;
  /** The `get()` snapshot: prompt, parsed result, stats. Null when it could not be read. */
  task: LingTask | null;
  /** Builders only; null for a watcher, a killed builder, or a read that failed. */
  finalState: LingFinalState | null;
  /** Why there is no final state or task snapshot, when a read failed. */
  finalStateError: string | null;
  runtimePaths: ProvisionedWorkerRuntimePaths | null;
  via: "release" | "after_run" | "terminated";
  capturedAt: string;
}

export interface CaptureHooks {
  /** Called with each capture before the lease is released, while its files are still there. */
  beforeRelease?(captured: CapturedTask): Promise<void>;
}

export type CapturingClient = CampaignLingClient & {
  captures(): readonly CapturedTask[];
  /** The F5 path: every builder spawned and not yet captured. Call after `driver.run()`. */
  captureUnreleased(): Promise<void>;
};

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);
/** A killed worker may not answer; its snapshot is not waited on past this. */
const TERMINATED_READ_MS = 5_000;
const ROLE_IN_KEY = /^campaign:[A-Za-z0-9_-]+:(builder|watcher|reviewer|integration|planner):/;

/** The role a campaign request key names, or undefined for a key no campaign wrote. */
export function requestKeyRole(requestKey: string): string | undefined {
  return ROLE_IN_KEY.exec(requestKey)?.[1];
}

interface Spawned {
  taskId: string;
  workerId: string | undefined;
  role: CapturedRole;
  requestKey: string;
}

function message(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** `inner` with every builder's and model B's state captured before its release. */
export function withCapture(
  inner: ProvisionedLingClient,
  provisioner: Pick<LingProvisioner, "lease">,
  hooks: CaptureHooks = {},
): CapturingClient {
  const spawned = new Map<string, Spawned>();
  const captured = new Map<string, CapturedTask>();
  /** The capture of a task now under way: a second one waits for it, never runs beside it. */
  const inflight = new Map<string, Promise<CapturedTask | null>>();

  const runtimePaths = (workerId: string | undefined) => {
    const paths = workerId === undefined ? undefined : provisioner.lease(workerId)?.runtimePaths;
    return paths === undefined ? null : { ...paths };
  };

  /**
   * One capture of a task at a time. Two that overlap (the driver's release
   * during its shutdown and `captureUnreleased`, or a terminate and a release)
   * would both read, and the later, perhaps of a lease already gone, would
   * replace the earlier record. The second waits, and takes nothing if the
   * first recorded one.
   */
  async function capture(entry: Spawned, via: CapturedTask["via"]): Promise<CapturedTask | null> {
    for (let pending = inflight.get(entry.taskId); pending !== undefined; pending = inflight.get(entry.taskId)) {
      await pending.catch(() => null);
    }
    if (captured.has(entry.taskId)) return null;
    const taking = take(entry, via);
    inflight.set(entry.taskId, taking);
    try {
      return await taking;
    } finally {
      if (inflight.get(entry.taskId) === taking) inflight.delete(entry.taskId);
    }
  }

  /** Reads the task, and a terminal builder's final state; records, never throws. */
  async function take(entry: Spawned, via: CapturedTask["via"]): Promise<CapturedTask | null> {
    const errors: string[] = [];
    let task: LingTask | null = null;
    try {
      const read = inner.get(entry.taskId, entry.workerId);
      task = via === "terminated" ? await within(read, TERMINATED_READ_MS, "get") : await read;
    } catch (error) {
      errors.push(`get: ${message(error)}`);
    }
    // A release of an active task is refused, and the driver tries again later.
    if (via === "release" && task !== null && !TERMINAL.has(task.status)) return null;
    let finalState: LingFinalState | null = null;
    if (entry.role === "builder" && via !== "terminated") {
      try {
        finalState = await inner.finalState(entry.taskId, entry.workerId);
      } catch (error) {
        errors.push(`finalState: ${message(error)}`);
      }
    } else if (entry.role === "builder") {
      errors.push("the worker was killed, so no final state could be read");
    }
    const record: CapturedTask = {
      ...entry,
      task,
      finalState,
      finalStateError: errors.length === 0 ? null : errors.join("; "),
      runtimePaths: runtimePaths(entry.workerId),
      via,
      capturedAt: new Date().toISOString(),
    };
    captured.set(entry.taskId, record);
    if (hooks.beforeRelease !== undefined) {
      try {
        await hooks.beforeRelease(record);
      } catch (error) {
        record.finalStateError = [record.finalStateError, `beforeRelease: ${message(error)}`]
          .filter((part) => part !== null)
          .join("; ");
      }
    }
    return record;
  }

  const client: CapturingClient = {
    async spawn(input: SpawnInput, preferredWorkerId?: string) {
      const response = await inner.spawn(input, preferredWorkerId);
      const requestKey = input.requestKey ?? response.requestKey ?? "";
      const role = requestKeyRole(requestKey);
      if (role === "builder" || role === "watcher") {
        spawned.set(response.id, { taskId: response.id, workerId: response.workerId, role, requestKey });
      }
      return response;
    },
    get: (id, workerId) => inner.get(id, workerId),
    list: () => inner.list(),
    cancel: (id, workerId) => inner.cancel(id, workerId),
    captures: () => [...captured.values()],
    async captureUnreleased() {
      for (const entry of spawned.values()) {
        if (entry.role === "builder") await capture(entry, "after_run");
      }
    },
  };
  // Each optional method only where the inner client has it.
  const source = inner as unknown as Required<CampaignLingClient>;
  const has = (name: keyof CampaignLingClient) =>
    typeof (inner as unknown as Record<string, unknown>)[name] === "function";
  if (has("events")) client.events = (id, workerId, options) => source.events(id, workerId, options);
  if (has("sendPeerMessage")) {
    client.sendPeerMessage = (id, peer, workerId) => source.sendPeerMessage(id, peer, workerId);
  }
  if (has("history")) client.history = (task) => source.history(task);
  if (has("collectComplete")) {
    client.collectComplete = (id, workerId) => source.collectComplete(id, workerId);
  }
  if (has("sendOversight")) {
    client.sendOversight = (id, oversight, workerId) => source.sendOversight(id, oversight, workerId);
  }
  if (has("health")) client.health = () => source.health();
  if (has("fetchLog")) client.fetchLog = (id, workerId) => source.fetchLog(id, workerId);
  if (has("release")) {
    client.release = async (id, workerId) => {
      const entry = spawned.get(id);
      if (entry !== undefined) await capture(entry, "release");
      await source.release(id, workerId);
    };
  }
  if (has("terminate")) {
    client.terminate = async (id, reason, workerId) => {
      const entry = spawned.get(id);
      if (entry !== undefined) await capture(entry, "terminated");
      return source.terminate(id, reason, workerId);
    };
  }
  return client;
}

// ---------------------------------------------------------------------------
// served

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * One entry per `model_response` event of A, and of B when B is a model, in
 * seq order, de-duplicated by a non-null `responseId`. The in-band provider
 * is the event's; the lookup is W4-A's, so it is null here, with no attempts.
 */
export function servedCalls(records: {
  a: readonly LingEvent[];
  b?: readonly LingEvent[];
}): ServedCall[] {
  const seen = new Set<string>();
  const calls: ServedCall[] = [];
  for (const events of [records.a, records.b ?? []]) {
    for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
      if (event.type !== MODEL_RESPONSE_EVENT) continue;
      const data = (event.data ?? {}) as Record<string, unknown>;
      const responseId = text(data["responseId"]);
      if (responseId !== null) {
        if (seen.has(responseId)) continue;
        seen.add(responseId);
      }
      const usage = (data["usage"] ?? {}) as Record<string, unknown>;
      calls.push({
        responseId,
        inBandProvider: text(data["servedProvider"]),
        lookupProvider: null,
        model: text(data["model"]),
        costUsd: typeof usage["costUsd"] === "number" ? usage["costUsd"] : null,
        attempts: 0,
      });
    }
  }
  return calls;
}

// ---------------------------------------------------------------------------
// The run directory's files

/** JSON with LF and no BOM, as W1-D's readers take it. */
function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** The captured builder: the one with a final state, else the first. */
export function capturedBuilder(captures: readonly CapturedTask[]): CapturedTask | undefined {
  const builders = captures.filter((entry) => entry.role === "builder");
  return builders.find((entry) => entry.finalState !== null) ?? builders[0];
}

/**
 * `final-state.json` (the builder's record), `result.raw` (its result's
 * bytes, when the record holds them), `builder-task.json` and, for a model B,
 * `watcher-task.json` (the `get()` snapshots), and `captures.json`, how each
 * was taken.
 */
export async function writeCaptures(
  runDir: string,
  captures: readonly CapturedTask[],
): Promise<void> {
  const builder = capturedBuilder(captures);
  if (builder?.finalState != null) {
    await writeFile(path.join(runDir, "final-state.json"), json(builder.finalState));
    const content = builder.finalState.result.content;
    if (content !== null) await writeFile(path.join(runDir, "result.raw"), content, "utf8");
  }
  if (builder?.task != null) await writeFile(path.join(runDir, "builder-task.json"), json(builder.task));
  const watcher = captures.find((entry) => entry.role === "watcher");
  if (watcher?.task != null) await writeFile(path.join(runDir, "watcher-task.json"), json(watcher.task));
  await writeFile(
    path.join(runDir, "captures.json"),
    json(
      captures.map(({ task: _task, finalState, ...rest }) => ({
        ...rest,
        finalState: finalState === null ? null : "final-state.json",
      })),
    ),
  );
}

/**
 * Where A's child ran: its workspace from the record (else the task's), its
 * real workspace from the record only, its HOME, TEMP and USERPROFILE from
 * the lease. A path nobody observed is "" (W1-D's ChildPaths holds no null),
 * and `missingChildPaths` names it, so the contamination verdict on such a
 * run is `unresolved`, not a verdict on "". `runtimeRemoved` is whether
 * every lease runtime directory was gone after release; the run never writes
 * null for it, which would make every run `instrument_drift`.
 */
export function childPathsFrom(
  builder: CapturedTask | undefined,
  runtimeRemoved: boolean,
): ChildPaths {
  const workspaceDir = builder?.finalState?.workspaceDir ?? builder?.task?.workspaceDir ?? "";
  return {
    workspaceDir,
    // Only what the record observed: the task's workspace is no real path.
    workspaceDirReal: builder?.finalState?.workspaceDirReal ?? "",
    home: builder?.runtimePaths?.home ?? "",
    tmp: builder?.runtimePaths?.tmp ?? "",
    userProfile: builder?.runtimePaths?.userProfile ?? "",
    runtimeRemoved,
  };
}

/** The child paths no capture observed (each written as ""). */
export function missingChildPaths(child: ChildPaths): string[] {
  return (["workspaceDir", "workspaceDirReal", "home", "tmp", "userProfile"] as const).filter(
    (key) => child[key] === "",
  );
}
