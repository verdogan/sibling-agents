// Reuses a running ling or starts a local one; LING_TOKEN must match the service token.
import { assessEventSequence } from "../campaign/event-record.js";
import { bootstrapLing, type LingRuntime } from "../ling/bootstrap.js";
import { LingClientError } from "../ling/client.js";
import { eventFingerprint, isTerminalStatus } from "../ling/events.js";
import type { LingEvent, LingTask, SpawnResponse } from "../ling/types.js";
import { FleetLedger } from "../ledger.js";
import { applySpawnPolicy, spawnPolicyFromEnv } from "../policy.js";

let failures = 0;

function report(label: string, passed: boolean, detail = ""): void {
  console.log(`${passed ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!passed) failures += 1;
}

let runtime: LingRuntime;
try {
  runtime = await bootstrapLing();
  report(
    runtime.startedByOverlord ? "local ling was started automatically" : "existing ling is reachable",
    true,
    runtime.pid === undefined ? "" : `pid ${runtime.pid}`,
  );
} catch (error) {
  report(
    "ling bootstrap completed",
    false,
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
}

const client = runtime.client;
const policy = spawnPolicyFromEnv();
const ledger = new FleetLedger({
  maxTasksPerRun: Math.max(policy.maxTasksPerRun, 5),
  // The wait-any race posts three tasks at once; that is more than the default
  // FLEET_MAX_CONCURRENT of 2, so the check raises the ceiling rather than
  // skipping the race.
  maxConcurrentTasks: Math.max(policy.maxConcurrentTasks, 3),
  maxTotalCostUsd: policy.maxTotalCostUsd,
});
const effective = applySpawnPolicy(
  {
    tools: ["write"],
    max_cost_usd: 0.01,
    max_turns: 2,
    max_wall_clock_ms: 60_000,
  },
  policy,
);

function spawnInput(task: string) {
  return {
    task,
    tools: effective.tools,
    maxCostUsd: effective.maxCostUsd,
    maxTurns: effective.maxTurns,
    maxWallClockMs: effective.maxWallClockMs,
  };
}

async function collectEvents(id: string, timeoutMs = 90_000): Promise<LingEvent[]> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`Timed out after ${timeoutMs}ms waiting for ${id}.`)),
    timeoutMs,
  );
  const events: LingEvent[] = [];
  try {
    for await (const event of client.events(id, { signal: controller.signal })) {
      events.push(event);
    }
  } finally {
    clearTimeout(timer);
  }
  const settled = await client.get(id);
  if (!isTerminalStatus(settled.status)) {
    throw controller.signal.reason ?? new Error(`Task ${id} event stream ended before settlement.`);
  }
  return events;
}

async function waitForTerminal(id: string, timeoutMs = 90_000): Promise<LingTask> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = await client.get(id);
    if (isTerminalStatus(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${id}.`);
}

async function spawnTracked(prompt: string): Promise<SpawnResponse> {
  if (!ledger.canSpawn(effective.maxCostUsd)) {
    throw new Error("Fleet policy or ledger refused a fixed check task.");
  }
  const spawned = await client.spawn(spawnInput(prompt));
  ledger.record(await client.get(spawned.id));
  return spawned;
}

async function observeTerminal(id: string, controller: AbortController): Promise<LingTask> {
  const timer = setTimeout(
    () => controller.abort(new Error(`Timed out waiting for race task ${id}.`)),
    90_000,
  );
  try {
    for await (const _event of client.events(id, { signal: controller.signal })) {
      // The client ends the iterable on a terminal event or terminal task status.
    }
    if (controller.signal.aborted) throw controller.signal.reason;
    const task = await client.get(id);
    if (!isTerminalStatus(task.status)) {
      throw new Error(`Race observer for ${id} ended at non-terminal status ${task.status}.`);
    }
    return task;
  } finally {
    clearTimeout(timer);
  }
}

try {
  const first = await spawnTracked('Write exactly {"ok":true} to result.json, then stop.');
  const liveEvents = await collectEvents(first.id);
  const firstTask = await client.get(first.id);
  ledger.record(firstTask);
  report(
    "first task reached a terminal state through SSE",
    isTerminalStatus(firstTask.status) && liveEvents.length > 0,
    `${first.id} ${firstTask.status}, ${liveEvents.length} event(s)`,
  );

  // The service's log and the SSE stream come from one store append, so they
  // should agree event for event: same seq, type and data. The log is fetched
  // directly as well as through history(), because history() falls back to the
  // stream when the route is missing and would then only compare it with itself.
  let served: LingEvent[] | undefined;
  try {
    served = await client.fetchLog(firstTask.id);
  } catch (error) {
    report(
      "the service's event log is served",
      false,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (served !== undefined) {
    const logged = served;
    const history = await client.history(firstTask);
    const assessment = assessEventSequence(logged);
    const bySeq = new Map(logged.map((event) => [event.seq, eventFingerprint(event)]));
    const mismatched = liveEvents.filter((event) => bySeq.get(event.seq) !== eventFingerprint(event));
    report(
      "the service's event log is whole and matches the SSE stream event for event",
      assessment.complete &&
        mismatched.length === 0 &&
        history.length === logged.length &&
        history.every((event, index) => event.seq === logged[index]?.seq),
      assessment.complete
        ? `${logged.length} logged, ${liveEvents.length} streamed, ${mismatched.length} mismatched`
        : `log ${assessment.reason}`,
    );
  }

  if (!ledger.canSpawn(effective.maxCostUsd)) {
    throw new Error("Ledger refused the cancellation check task.");
  }
  const second = await client.spawn(
    spawnInput(
      "Keep working until cancelled; repeatedly update progress.json with a short progress note.",
    ),
  );
  let firstCancelAccepted = true;
  try {
    await client.cancel(second.id);
  } catch (error) {
    firstCancelAccepted = false;
    report(
      "first cancellation is accepted",
      false,
      error instanceof Error ? error.message : String(error),
    );
  }
  const cancelledTask = await waitForTerminal(second.id);
  ledger.record(cancelledTask);
  if (firstCancelAccepted) {
    report(
      "first cancellation is accepted",
      cancelledTask.status === "cancelled",
      `${second.id} ${cancelledTask.status}`,
    );
  }

  try {
    await client.cancel(second.id);
    report("cancelling the settled task again returns 409", false, "request unexpectedly succeeded");
  } catch (error) {
    report(
      "cancelling the settled task again returns 409",
      error instanceof LingClientError && error.status === 409 && !error.retryable,
      error instanceof Error ? error.message : String(error),
    );
  }

  const race: SpawnResponse[] = [];
  for (let index = 1; index <= 3; index += 1) {
    race.push(
      await spawnTracked(
        `Write exactly {"ok":true,"race":${index}} to result.json, then stop.`,
      ),
    );
  }

  const controllers = new Map(
    race.map((spawned) => [spawned.id, new AbortController()] as const),
  );
  const winner = await Promise.race(
    race.map((spawned) => observeTerminal(spawned.id, controllers.get(spawned.id)!)),
  );
  for (const controller of controllers.values()) controller.abort();

  for (const spawned of race) {
    if (spawned.id === winner.id) continue;
    try {
      await client.cancel(spawned.id);
    } catch (error) {
      if (!(error instanceof LingClientError && error.status === 409)) throw error;
    }
  }

  const raceTasks = await Promise.all(race.map((spawned) => waitForTerminal(spawned.id)));
  for (const task of raceTasks) ledger.record(task);
  const losers = raceTasks.filter((task) => task.id !== winner.id);
  report(
    "wait-any keeps a winner and cancels the rest",
    isTerminalStatus(winner.status) &&
      losers.length === 2 &&
      losers.every((task) => task.status === "cancelled"),
    `winner ${winner.id} ${winner.status}; losers ${losers.map((task) => task.status).join(",")}`,
  );

  console.log("\nrace results:");
  for (const task of raceTasks) {
    console.log(`  ${task.id}  ${task.status}  stats.cost=$${(task.stats?.cost ?? 0).toFixed(6)}`);
  }
  const trackedTasks = [firstTask, cancelledTask, ...raceTasks];
  const taskCostSum = trackedTasks.reduce((sum, task) => sum + (task.stats?.cost ?? 0), 0);
  console.log(
    `  ledger spent=$${ledger.spentUsd().toFixed(6)}  sum(stats.cost)=$${taskCostSum.toFixed(6)}`,
  );
  report(
    "ledger spend reconciles with task stats",
    Math.abs(ledger.spentUsd() - taskCostSum) < 1e-9,
  );
} catch (error) {
  report("fleet check completed", false, error instanceof Error ? error.message : String(error));
} finally {
  try {
    await runtime.stop();
  } catch (error) {
    report(
      "overlord-owned ling stopped",
      false,
      error instanceof Error ? error.message : String(error),
    );
  }
}

console.log(failures === 0 ? "\nall fleet checks passed" : `\n${failures} fleet check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
