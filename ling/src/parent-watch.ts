/**
 * Watch the process that started this ling, and say when it is gone.
 *
 * The overlord starts a local ling per task and is the only party that would
 * ever stop it. If the overlord dies without stopping its lings, a running pair
 * keeps calling its model until its own budgets run out, with nobody left to
 * read the result. `LING_PARENT_PID` names the parent; the server stops itself
 * once that process no longer exists.
 *
 * The watch is off unless that variable is set. The overlord's local
 * provisioner sets it to its own pid for every local child it starts. A ling
 * started any other way, by hand or for a fleet, has no watch, and if whatever
 * started it goes away it runs on to its own budgets.
 *
 * Existence is tested with signal 0, which delivers nothing. `EPERM` means the
 * process exists but belongs to another user, so it counts as alive. The test
 * cannot tell a dead parent from a new process that reused its pid; on a host
 * busy enough to recycle a pid within one poll the ling would outlive its
 * parent, so this bounds an orphan's spend in the common case only.
 */

export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface ParentWatch {
  stop(): void;
}

/**
 * Call `onGone` once, at the first poll that finds `pid` gone. The timer is
 * unreferenced, so the watch never keeps the process alive by itself.
 */
export function watchParent(options: {
  pid: number;
  onGone: () => void;
  intervalMs?: number;
  exists?: (pid: number) => boolean;
}): ParentWatch {
  const exists = options.exists ?? processExists;
  const timer = setInterval(() => {
    if (exists(options.pid)) return;
    clearInterval(timer);
    options.onGone();
  }, options.intervalMs ?? 1_000);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
