import { execFile, spawn, type SpawnOptions } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { LingClient, LingClientError } from "./client.js";
import {
  FleetLingClient,
  workersFromEnv,
  type LingWorkerConfig,
} from "./fleet.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:8787";
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_LING_DIR = fileURLToPath(new URL("../../../ling", import.meta.url));
const DEFAULT_KILL_GRACE_MS = 5_000;
/** How long a hard-killed process may take to be reported gone. */
const KILL_CONFIRM_MS = 10_000;
/** How long the tree gets after SIGKILL before a survivor is reported. */
const KILL_SETTLE_MS = 2_000;
const execFileAsync = promisify(execFile);

export interface ManagedLingProcess {
  readonly pid?: number;
  readonly exitCode: number | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "error", listener: (error: Error) => void): this;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
}

export type LingProcessStarter = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ManagedLingProcess;

export interface LingBootstrapOptions {
  baseUrl?: string;
  token?: string;
  workspacesDir?: string;
  lingDir?: string;
  autoStart?: boolean;
  startupTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  client?: LingClient;
  command?: string;
  args?: readonly string[];
  startProcess?: LingProcessStarter;
  /**
   * Start the child as the leader of its own process group on POSIX, so kill()
   * can signal the group. Ignored on Windows, where kill() walks the process
   * tree instead. Off by default: a child in the overlord's group also receives
   * a terminal's Ctrl+C, which the single local worker relies on.
   */
  ownProcessGroup?: boolean;
  /**
   * An exact `NAME=value` entry in the child's environment that nothing else on
   * the host carries. On Linux, kill() also targets every same-user process
   * whose environment contains it, which is how it reaches a process whose
   * parent exited before the kill.
   */
  processMarker?: string;
  /** POSIX only: how long kill() waits between SIGTERM and SIGKILL. Default 5 s. */
  killGraceMs?: number;
  /** How long stop() waits after SIGTERM. Default LING_SHUTDOWN_TIMEOUT_MS, else 30 s. */
  shutdownTimeoutMs?: number;
}

export interface LingRuntime {
  client: LingClient;
  startedByOverlord: boolean;
  pid?: number;
  stop(): Promise<void>;
  /**
   * Hard-kill the owned process and everything it started, without asking any
   * of it to stop first. Resolves once the owned process is gone, with what
   * could not be confirmed about the rest of the tree, and rejects if the owned
   * process itself could not be confirmed gone. An owned process that had
   * already exited, after a crash or a stop(), is one such caveat: the tree is
   * then looked for without it. Empty means nothing was found surviving. On
   * Windows a root that outlives taskkill, which could not run, say, is
   * terminated through its own handle, which does not reach what was started
   * detached or through a shell (see stopTree()), and that is another. A
   * reused service is not the overlord's to kill, so this kills nothing for
   * one, and says so.
   */
  kill(): Promise<string[]>;
  /**
   * Stop the owned process as stop() does, then hard-kill whatever it started
   * that outlived it: what a finished task backgrounded, which a stop of the
   * root leaves running. The tree is looked at before the stop, while the root
   * is still there to walk from. On Windows stop() is already TerminateProcess
   * of the root. For a Node root, the default, that also ends the children
   * Node started undetached, which libuv keeps in a job object that dies with
   * its owner, and theirs in turn while they are Node too: the ling server,
   * and the shell Pi runs each command in. What was started detached, or by
   * anything other than Node, such as a command the shell ran, breaks away
   * from those jobs, and only taskkill /T from the live root reaches it. So
   * there the tree is killed from the live root instead. Resolves and rejects
   * as kill() does. A reused service is neither stopped nor killed.
   */
  stopTree(): Promise<string[]>;
}

export interface LingFleetRuntime {
  client: FleetLingClient;
  workers: readonly LingWorkerConfig[];
  startedByOverlord: boolean;
  pid?: number;
  stop(): Promise<void>;
}

export class LingBootstrapError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LingBootstrapError";
  }
}

function envBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function envPositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isTransportUnavailable(error: unknown): boolean {
  return error instanceof LingClientError && error.status === undefined && error.retryable;
}

async function probe(client: LingClient): Promise<void> {
  await client.health();
  await client.list();
}

function localAddress(baseUrl: string): { bindAddress: string; port: string } {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch (error) {
    throw new LingBootstrapError(`LING_BASE_URL is invalid: ${baseUrl}`, { cause: error });
  }

  const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1");
  const loopback = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  if (
    url.protocol !== "http:" ||
    !loopback ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new LingBootstrapError(
      `Cannot auto-start ling for non-local URL ${baseUrl}; start that service externally.`,
    );
  }
  return { bindAddress: hostname, port: url.port || "80" };
}

function defaultStarter(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): ManagedLingProcess {
  return spawn(command, [...args], options);
}

async function stopProcess(
  child: ManagedLingProcess,
  timeoutMs: number,
  exited: () => boolean,
): Promise<void> {
  if (exited()) return;
  child.kill("SIGTERM");
  if (exited()) return;

  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref();
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  if (!exited()) child.kill("SIGKILL");
}

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

/** One row of the host's process table, as far as a tree kill needs it. */
export interface ProcessTableRow {
  pid: number;
  ppid: number;
  pgid: number;
  /**
   * When the process started, as the table reports it. With the pid it names
   * one process, so a pid reused between two reads is not taken for the same
   * process. Absent where the table gives none.
   */
  started?: string;
  /** The process's environment carries the kill marker. Only Linux can tell. */
  marked: boolean;
}

/** Add every descendant of `set` to it, never passing through `barrier`. */
function addDescendants(set: Set<number>, rows: readonly ProcessTableRow[], barrier: number): void {
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (row.pid !== barrier && !set.has(row.pid) && set.has(row.ppid)) {
        set.add(row.pid);
        grew = true;
      }
    }
  }
}

/** The process a tree kill starts from, as its handle describes it. */
export interface ProcessTreeRoot {
  pid: number;
  /** It has exited and been reaped, so its pid may already be someone else's. */
  exited: boolean;
  /** It was started as the leader of its own process group. */
  groupLeader: boolean;
}

/**
 * Choose what a POSIX tree kill signals: the root, every process descended from
 * it or carrying the marker, and every process group one of those leads.
 *
 * Parent links alone are not enough because Pi runs each bash command detached,
 * as the leader of its own session and group, so the ling's group does not
 * contain what its tasks start; and a command that backgrounds a process and
 * exits leaves that process parented to init, which is what the marker is for.
 * A group is signalled only when one of the targets leads it, so the overlord's
 * own group never is.
 *
 * A root started as a group leader keeps its group after it exits: whatever is
 * left in the group, and what that started, is still a target, because a
 * group id in use is never handed out as a pid. A process holding the root's
 * pid means the group emptied and the pid went to someone else, so the group
 * is then left alone. That trusts that, since the root exited, the group has
 * not emptied, had its id taken by a stranger who formed a group under it, and
 * lost that stranger: the pid would have to be handed out again in between.
 *
 * The overlord is never a target, and neither is anything else it started
 * besides the root, marked or not: a process it runs on the lease's behalf,
 * such as a container removal, is its own tool and not the task's. An
 * overlord running as pid 1 is the exception, because orphans are reparented
 * to it and its children are then what the marker is there to find.
 */
export function processTreeTargets(
  rows: readonly ProcessTableRow[],
  root: ProcessTreeRoot | undefined,
  selfPid: number = process.pid,
): { pids: number[]; groups: number[] } {
  const livePid = root !== undefined && !root.exited ? root.pid : undefined;
  const rootGroup =
    root === undefined || !root.groupLeader
      ? undefined
      : livePid !== undefined || !rows.some((row) => row.pid === root.pid)
        ? root.pid
        : undefined;
  const spared = new Set<number>();
  if (selfPid !== 1) {
    for (const row of rows) {
      if (row.ppid === selfPid && row.pid !== livePid) spared.add(row.pid);
    }
    addDescendants(spared, rows, selfPid);
  }
  const targets = new Set<number>();
  if (livePid !== undefined) targets.add(livePid);
  for (const row of rows) {
    if (row.pid === selfPid || spared.has(row.pid)) continue;
    if (row.marked || (rootGroup !== undefined && row.pgid === rootGroup)) targets.add(row.pid);
  }
  addDescendants(targets, rows, selfPid);
  targets.delete(selfPid);
  const groups = new Set(
    rows.filter((row) => targets.has(row.pid) && row.pgid === row.pid).map((row) => row.pid),
  );
  // A live root's group is signalled even when the table could not show it;
  // an exited root's only while the table shows something left in it.
  if (
    rootGroup !== undefined &&
    (livePid !== undefined || rows.some((row) => row.pgid === rootGroup && targets.has(row.pid)))
  ) {
    groups.add(rootGroup);
  }
  return { pids: [...targets], groups: [...groups] };
}

function linuxStatFields(pid: string): string[] {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  // The command name is parenthesised and may itself contain spaces or ")".
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
}

/** The host's process table, or undefined when it could not be read. */
async function readProcessTable(
  marker: string | undefined,
): Promise<ProcessTableRow[] | undefined> {
  if (process.platform === "linux" && existsSync("/proc/self/stat")) {
    const rows: ProcessTableRow[] = [];
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const fields = linuxStatFields(entry);
        let marked = false;
        if (marker !== undefined) {
          try {
            marked = readFileSync(`/proc/${entry}/environ`, "utf8").split("\0").includes(marker);
          } catch {
            // Another user's process; it cannot be one of ours.
          }
        }
        rows.push({
          pid: Number(entry),
          ppid: Number(fields[1]),
          pgid: Number(fields[2]),
          // Field 22, starttime, in clock ticks since boot.
          ...(fields[19] === undefined ? {} : { started: fields[19] }),
          marked,
        });
      } catch {
        // Exited while the table was being read.
      }
    }
    return rows;
  }
  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-A", "-o", "pid=", "-o", "ppid=", "-o", "pgid=", "-o", "lstart="],
      { timeout: 5_000 },
    );
    const rows: ProcessTableRow[] = [];
    for (const line of stdout.split("\n")) {
      const fields = line.trim().split(/\s+/);
      const [pid, ppid, pgid] = fields.slice(0, 3).map(Number);
      if (![pid, ppid, pgid].every(Number.isSafeInteger)) continue;
      // lstart is a date with spaces in it; to the second, which is enough
      // alongside the pid and group.
      const started = fields.slice(3).join(" ");
      rows.push({
        pid: pid!,
        ppid: ppid!,
        pgid: pgid!,
        ...(started === "" ? {} : { started }),
        marked: false,
      });
    }
    return rows;
  } catch {
    return undefined;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    // ESRCH is gone; EPERM is a reused pid that belongs to someone else.
    return false;
  }
  if (process.platform !== "linux") return true;
  try {
    return linuxStatFields(String(pid))[0] !== "Z";
  } catch {
    return false;
  }
}

function signalTargets(
  targets: { pids: readonly number[]; groups: readonly number[] },
  signal: NodeJS.Signals,
): void {
  for (const group of targets.groups) {
    try {
      process.kill(-group, signal);
    } catch {
      // Already gone.
    }
  }
  for (const pid of targets.pids) {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

/** `taskkill /T /F`; resolves with what it could not confirm, if anything. */
async function killWindowsTree(pid: number): Promise<string | undefined> {
  // The System32 path, so the kill does not depend on what PATH resolves.
  const taskkill = path.join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "taskkill.exe");
  return new Promise<string | undefined>((resolve) => {
    const child = spawn(taskkill, ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve(`taskkill did not finish within ${KILL_CONFIRM_MS} ms`);
    }, KILL_CONFIRM_MS);
    timer.unref();
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve(`taskkill could not run: ${error.message}`);
    });
    // The root's own fate is checked by the caller; the exit code is the only
    // word on the rest of the tree.
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(undefined);
      else if (code === 128) {
        resolve(`process ${pid} was gone before taskkill ran, so its tree was not walked`);
      } else {
        resolve(
          `taskkill /T exited ${code ?? "on a signal"}; part of the tree may not have been killed`,
        );
      }
    });
  });
}

/** One look at the process table: what it targets and, if it could read them, the rows. */
export interface ProcessTreeLook {
  pids: number[];
  groups: number[];
  rows: ReadonlyMap<number, ProcessTableRow> | undefined;
}

/**
 * What a POSIX tree kill sends SIGKILL to, from its look before SIGTERM and
 * its look after the grace: everything the second look targets, and of the
 * first look's targets only what is provably the same process. A target that
 * exited on SIGTERM may have handed its pid to someone else meanwhile.
 *
 * Reparenting changes ppid, so a process is the same when its pid, group and
 * start time are; the root is the same while its handle says it has not
 * exited, so `rootPid` is given only for a root the first look found live.
 * A group stays a target while it has members and its leader's pid is
 * not someone else's: a pid in use as a group id is never reused, so a group
 * whose leader died with members left is still the one the first look saw.
 * Without both tables this falls back to whatever still answers, reused pids
 * included.
 */
export function sigkillTargets(
  first: ProcessTreeLook,
  second: ProcessTreeLook,
  rootPid: number | undefined,
  rootExited: () => boolean,
  alive: (pid: number) => boolean = processAlive,
): { pids: number[]; groups: number[] } {
  let pids: number[];
  let groups: number[];
  if (first.rows !== undefined && second.rows !== undefined) {
    const before = first.rows;
    const after = second.rows;
    const same = (pid: number): boolean => {
      if (pid === rootPid) return !rootExited();
      const then = before.get(pid);
      const now = after.get(pid);
      return (
        then !== undefined &&
        now !== undefined &&
        then.pgid === now.pgid &&
        then.started === now.started
      );
    };
    const members = new Set([...after.values()].map((row) => row.pgid));
    pids = first.pids.filter(same);
    groups = first.groups.filter(
      (group) => members.has(group) && (!after.has(group) || same(group)),
    );
  } else {
    pids = first.pids.filter((pid) => (pid === rootPid ? !rootExited() : alive(pid)));
    groups = first.groups;
  }
  return {
    pids: [...new Set([...pids, ...second.pids])],
    groups: [...new Set([...groups, ...second.groups])],
  };
}

export interface ProcessTreeKillOptions {
  /** The root was started as its own process-group leader (POSIX). */
  groupLeader?: boolean;
  /** See LingBootstrapOptions.processMarker. Linux only. */
  marker?: string;
  /** POSIX only: time between SIGTERM and SIGKILL. */
  graceMs?: number;
  /**
   * Whether the root has exited, from whoever holds its handle. Once it has,
   * its pid may already be someone else's, so the kill trusts this rather than
   * the pid. Default: the pid no longer answers, which a reused pid does.
   */
  rootExited?: () => boolean;
  /**
   * POSIX only: stop the root gracefully, and wait for it, before anything else
   * is signalled. The process table is read first, so what the root leaves
   * behind is still found through it, and then only what outlived the stop is
   * killed. Not called for a root that had already exited. Windows has no
   * graceful stop to wait for, since Node's kill() of a Windows process is
   * TerminateProcess, so there the tree is killed from the live root and this
   * is never called.
   */
  stopRoot?: () => Promise<void>;
}

/**
 * What a kill whose root had already exited could still look for. Windows has
 * only the parent links taskkill walks from the root, so nothing.
 */
function exitedRootNote(options: ProcessTreeKillOptions): string {
  const ways = [
    ...(process.platform !== "win32" && options.groupLeader === true ? ["its group"] : []),
    ...(process.platform === "linux" && options.marker !== undefined ? ["the marker"] : []),
  ];
  const exited = "the root had exited before the kill, so its tree";
  return ways.length === 0
    ? `${exited} could not be walked`
    : `${exited} was looked for only through ${ways.join(" and ")}`;
}

/**
 * Kill a process and everything it started, asking none of it.
 *
 * Windows has no process groups to signal, so this is `taskkill /T /F`, which
 * walks parent links from the root. POSIX snapshots the process table first,
 * because the parent links it walks are lost the moment the root dies, sends
 * SIGTERM, waits, looks again for anything forked meanwhile, and sends SIGKILL
 * to whatever is provably still the process it first saw. Given `stopRoot`,
 * POSIX lets the root stop gracefully between the first look and the signals,
 * and then signals only what outlived it.
 *
 * Neither reaches everything. On Windows, and on POSIX outside Linux, a process
 * whose parent exited before the kill (a backgrounded job whose shell
 * returned) is out of reach; on Linux the marker catches it unless it cleared
 * its environment. A process that leaves the tree on purpose escapes, which is
 * why the sensor watches the host rather than trusting this to have worked.
 * A root that has already exited is the same gap at the top of the tree: its
 * pid may be someone else's by now, so nothing is walked from it. On Windows
 * nothing is signalled at all, and on POSIX only what is left in its group and
 * what carries the marker are; either way the kill says so.
 *
 * Resolves with what it could not confirm: a root that had already exited, a
 * tree taskkill reported only partly killed, a process table it could not
 * read, a process still present after SIGKILL. An empty list means nothing was
 * found surviving, not that nothing did. It never rejects.
 */
export async function killProcessTree(
  rootPid: number | undefined,
  options: ProcessTreeKillOptions = {},
): Promise<string[]> {
  const unconfirmed: string[] = [];
  const rootExited =
    options.rootExited ?? (() => rootPid === undefined || !processAlive(rootPid));
  const rootLive = rootPid !== undefined && !rootExited();
  if (!rootLive) unconfirmed.push(exitedRootNote(options));
  if (process.platform === "win32") {
    const problem = rootLive ? await killWindowsTree(rootPid) : undefined;
    if (problem !== undefined) unconfirmed.push(problem);
    return unconfirmed;
  }
  // The handle speaks for the root's pid only while that pid is the root's. A
  // root gone before the kill may have handed it on, perhaps to a descendant
  // carrying the marker, which is then a target like any other.
  const watched = rootLive ? rootPid : undefined;
  const gone = (pid: number) => (pid === watched ? rootExited() : !processAlive(pid));
  const look = async (live: boolean): Promise<ProcessTreeLook> => {
    const table = await readProcessTable(options.marker);
    const found = processTreeTargets(
      table ?? [],
      rootPid === undefined
        ? undefined
        : { pid: rootPid, exited: !live, groupLeader: options.groupLeader === true },
    );
    const rows = table === undefined ? undefined : new Map(table.map((row) => [row.pid, row]));
    return { ...found, rows };
  };
  const first = await look(rootLive);
  let targets: ProcessTreeLook = first;
  if (options.stopRoot !== undefined && rootLive) {
    try {
      await options.stopRoot();
    } catch (error) {
      unconfirmed.push(
        `the root's graceful stop failed (${error instanceof Error ? error.message : String(error)}), ` +
          "so it was killed with the rest",
      );
    }
    // What the first look found that is provably still the process it saw,
    // since the stop gave pids time to be reused, and what is found now.
    const after = await look(!rootExited());
    if (first.rows === undefined || after.rows === undefined) {
      unconfirmed.push(
        first.rows === undefined && after.rows === undefined
          ? "the process table could not be read, so only the root was stopped"
          : first.rows === undefined
            ? "the process table could not be read before the root was stopped, so its tree " +
              "was looked for only once it had"
            : "the process table could not be read again after the root stopped",
      );
    }
    targets = { ...sigkillTargets(first, after, watched, rootExited), rows: after.rows };
  } else if (first.rows === undefined) {
    unconfirmed.push(
      !rootLive
        ? "the process table could not be read, so nothing was signalled"
        : options.groupLeader === true
          ? "the process table could not be read; only the root and its own group were signalled"
          : "the process table could not be read; only the root was signalled",
    );
  }
  if (targets.pids.length === 0) return unconfirmed;
  signalTargets(targets, "SIGTERM");
  await waitUntil(() => targets.pids.every(gone), options.graceMs ?? DEFAULT_KILL_GRACE_MS);
  const second = await look(rootLive && !rootExited());
  if (targets.rows !== undefined && second.rows === undefined) {
    unconfirmed.push("the process table could not be read again before SIGKILL");
  }
  const last = sigkillTargets(targets, second, watched, rootExited);
  signalTargets(last, "SIGKILL");
  await waitUntil(() => last.pids.every(gone), KILL_SETTLE_MS);
  const left = last.pids.filter((pid) => !gone(pid));
  if (left.length > 0) {
    unconfirmed.push(`still present ${KILL_SETTLE_MS} ms after SIGKILL: ${left.join(", ")}`);
  }
  return unconfirmed;
}

/**
 * Reuse an authenticated ling service when one is available. If the local
 * endpoint is absent, start ling as an owned child and wait for API readiness.
 */
export async function bootstrapLing(options: LingBootstrapOptions = {}): Promise<LingRuntime> {
  const env = options.env ?? process.env;
  const baseUrl = options.baseUrl ?? env["LING_BASE_URL"] ?? DEFAULT_BASE_URL;
  const token = options.token ?? env["LING_TOKEN"] ?? "";
  const client =
    options.client ??
    new LingClient({
      baseUrl,
      token,
      workspacesDir: options.workspacesDir ?? env["LING_WORKSPACES_DIR"],
    });

  try {
    await probe(client);
    const notOurs = `the service at ${baseUrl} was already running, so nothing was killed`;
    return {
      client,
      startedByOverlord: false,
      stop: async () => undefined,
      kill: async () => [notOurs],
      stopTree: async () => [notOurs],
    };
  } catch (error) {
    if (!isTransportUnavailable(error)) throw error;
    if (!(options.autoStart ?? envBoolean(env["LING_AUTO_START"], true))) {
      throw new LingBootstrapError(
        `Ling is unavailable at ${baseUrl} and LING_AUTO_START is disabled.`,
        { cause: error },
      );
    }
  }

  if (token.trim() === "") {
    throw new LingBootstrapError(
      "LING_TOKEN is required to auto-start ling; it becomes the child service's AGENT_TOKEN.",
    );
  }

  const address = localAddress(baseUrl);
  const lingDir = path.resolve(options.lingDir ?? env["LING_DIR"] ?? DEFAULT_LING_DIR);
  const defaultCli = path.join(lingDir, "node_modules", "tsx", "dist", "cli.mjs");
  const command = options.command ?? process.execPath;
  const args = options.args ?? [defaultCli, "src/server.ts"];
  if (options.command === undefined && !existsSync(defaultCli)) {
    throw new LingBootstrapError(
      `Cannot auto-start ling because ${defaultCli} is missing; run npm install in ${lingDir}.`,
    );
  }

  const startProcess = options.startProcess ?? defaultStarter;
  const ownProcessGroup = options.ownProcessGroup === true && process.platform !== "win32";
  const child = startProcess(command, args, {
    cwd: lingDir,
    env: {
      ...env,
      AGENT_TOKEN: token,
      BIND_ADDRESS: address.bindAddress,
      PORT: address.port,
    },
    stdio: "inherit",
    ...(ownProcessGroup ? { detached: true } : {}),
  });
  let processError: Error | undefined;
  child.on("error", (error) => {
    processError = error;
  });
  // exitCode stays null for a process that died of a signal, so it cannot say
  // on its own whether the child is gone.
  let exitSeen = false;
  child.once("exit", () => {
    exitSeen = true;
  });
  const exited = () => exitSeen || child.exitCode !== null;

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await stopProcess(
      child,
      options.shutdownTimeoutMs ?? envPositiveInt(env["LING_SHUTDOWN_TIMEOUT_MS"], 30_000),
      exited,
    );
  };
  /** kill(), or with `stopRoot` stopTree(): the root stops gracefully first. */
  const killTree = async (stopRoot?: () => Promise<void>): Promise<string[]> => {
    let unconfirmed: string[] = [];
    if (options.startProcess !== undefined) {
      // An injected process handle need not have a real pid behind it, so it
      // is asked to stop or kill itself rather than having a tree signalled for it.
      if (stopRoot !== undefined) await stopRoot();
      if (!exited()) child.kill("SIGKILL");
    } else {
      // The pid even when the child has exited: its group may outlive it,
      // and the handle, not the pid, says whether it is still the child.
      unconfirmed = await killProcessTree(child.pid, {
        groupLeader: ownProcessGroup,
        ...(options.processMarker === undefined ? {} : { marker: options.processMarker }),
        graceMs: options.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
        rootExited: exited,
        ...(stopRoot === undefined ? {} : { stopRoot }),
      });
      // A Windows tree kill is taskkill alone, which may not have run or
      // finished. Node's own kill of the root is TerminateProcess, which needs
      // no helper. With a Node root it ends what dies with libuv's job
      // objects, but not what was started detached or by anything other than
      // Node, a shell's commands among them (see stopTree()).
      if (process.platform === "win32" && !(await waitUntil(exited, KILL_SETTLE_MS))) {
        child.kill("SIGKILL");
        unconfirmed.push(
          "the root outlived taskkill and was terminated through its own handle, so what " +
            "its tree started detached, or through a shell, may still be running",
        );
      }
    }
    if (!(await waitUntil(exited, KILL_CONFIRM_MS))) {
      throw new LingBootstrapError(
        `Ling process ${child.pid ?? "(no pid)"} was still running after a hard kill.`,
      );
    }
    stopped = true;
    return unconfirmed;
  };
  const runtime: LingRuntime = {
    client,
    startedByOverlord: true,
    ...(child.pid === undefined ? {} : { pid: child.pid }),
    stop,
    kill: () => killTree(),
    stopTree: () => killTree(stop),
  };

  const startupTimeoutMs =
    options.startupTimeoutMs ??
    envPositiveInt(env["LING_STARTUP_TIMEOUT_MS"], DEFAULT_STARTUP_TIMEOUT_MS);
  const deadline = Date.now() + startupTimeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (processError !== undefined) {
      await runtime.stop();
      throw new LingBootstrapError("Failed to start the ling process.", { cause: processError });
    }
    if (child.exitCode !== null) {
      throw new LingBootstrapError(
        `Ling exited with code ${child.exitCode} before its API became ready.`,
      );
    }

    try {
      await probe(client);
      return runtime;
    } catch (error) {
      if (!isTransportUnavailable(error)) {
        await runtime.stop();
        throw error;
      }
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  await runtime.stop();
  throw new LingBootstrapError(
    `Ling did not become ready at ${baseUrl} within ${startupTimeoutMs}ms.`,
    { cause: lastError },
  );
}

/**
 * Bootstrap the backward-compatible single local worker, or connect to every
 * worker in LING_WORKERS_JSON. Explicit worker lists are externally managed.
 */
export async function bootstrapLingFleet(
  options: LingBootstrapOptions = {},
): Promise<LingFleetRuntime> {
  const env = options.env ?? process.env;
  const configured = workersFromEnv(env);
  if (configured === undefined) {
    const runtime = await bootstrapLing(options);
    const worker: LingWorkerConfig = {
      id: env["LING_WORKER_ID"]?.trim() || "local",
      baseUrl: options.baseUrl ?? env["LING_BASE_URL"] ?? DEFAULT_BASE_URL,
      token: options.token ?? env["LING_TOKEN"] ?? "",
      ...(options.workspacesDir ?? env["LING_WORKSPACES_DIR"]
        ? { workspacesDir: options.workspacesDir ?? env["LING_WORKSPACES_DIR"] }
        : {}),
    };
    const client = new FleetLingClient({
      workers: [worker],
      clientFactory: () => runtime.client,
    });
    return {
      client,
      workers: [worker],
      startedByOverlord: runtime.startedByOverlord,
      ...(runtime.pid === undefined ? {} : { pid: runtime.pid }),
      stop: runtime.stop,
    };
  }

  const client = new FleetLingClient({ workers: configured });
  await client.health();
  await client.list();
  return {
    client,
    workers: configured,
    startedByOverlord: false,
    stop: async () => undefined,
  };
}
