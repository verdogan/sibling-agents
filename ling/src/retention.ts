import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { TaskStore } from "./queue.js";

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    !path.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`)
  );
}

const EVENT_LOG_SUFFIX = ".jsonl";

/** Where a task's operator event log lives. One name, shared by writer, route and pruning. */
export function eventLogFile(eventLogDir: string, taskId: string): string {
  return path.join(eventLogDir, `${taskId}${EVENT_LOG_SUFFIX}`);
}

/**
 * Remove terminal tasks past retention, with their workspaces and event logs.
 *
 * `eventLogDir` is optional only so a caller that predates the moved log still
 * compiles; without it logs are left for the next pass that has it. Orphaned
 * logs — no task row, older than the cutoff — are swept the same way orphaned
 * workspaces are, which is also what catches a log whose task row an earlier
 * pass removed without knowing where the log was.
 */
export async function pruneExpiredTasks(
  store: TaskStore,
  workspacesDir: string,
  retentionDays: number,
  now = Date.now(),
  eventLogDir?: string,
): Promise<number> {
  const cutoff = new Date(now - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  for (const task of store.list()) {
    if (task.status === "queued" && task.createdAt < cutoff) {
      store.update(task.id, {
        status: "interrupted",
        stoppedBy: "interrupted",
        finishedAt: task.createdAt,
        error: "Queued task expired under the workspace retention policy.",
      });
    }
  }
  const removed = store.deleteTerminalBefore(cutoff);
  const root = path.resolve(workspacesDir);
  const logRoot = eventLogDir === undefined ? undefined : path.resolve(eventLogDir);
  for (const task of removed) {
    if (logRoot !== undefined) {
      const log = eventLogFile(logRoot, task.id);
      // Never recursive: if the entry is not the regular file this service
      // wrote, removing the name is all that is wanted, and a failure to do so
      // must not stop the workspaces behind it from being pruned.
      if (inside(logRoot, log)) {
        await rm(log, { force: true }).catch((error: unknown) => {
          console.warn(`unable to prune event log ${log}: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    }
    const workspace = path.resolve(task.workspaceDir);
    if (!inside(root, workspace)) {
      console.warn(`refusing to prune task workspace outside ${root}: ${workspace}`);
      continue;
    }
    await rm(workspace, { recursive: true, force: true });
  }
  const known = new Set(store.list().map((task) => task.id));
  let orphaned = 0;
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || known.has(entry.name)) continue;
    const workspace = path.resolve(root, entry.name);
    if (!inside(root, workspace)) continue;
    const workspaceStats = await stat(workspace).catch(() => undefined);
    if (workspaceStats === undefined || workspaceStats.mtimeMs >= Date.parse(cutoff)) continue;
    await rm(workspace, { recursive: true, force: true });
    orphaned += 1;
  }
  if (logRoot !== undefined) {
    const logs = await readdir(logRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of logs) {
      if (!entry.isFile() || !entry.name.endsWith(EVENT_LOG_SUFFIX)) continue;
      if (known.has(entry.name.slice(0, -EVENT_LOG_SUFFIX.length))) continue;
      const log = path.resolve(logRoot, entry.name);
      if (!inside(logRoot, log)) continue;
      const logStats = await stat(log).catch(() => undefined);
      if (logStats === undefined || logStats.mtimeMs >= Date.parse(cutoff)) continue;
      await rm(log, { force: true }).catch(() => undefined);
    }
  }
  return removed.length + orphaned;
}
