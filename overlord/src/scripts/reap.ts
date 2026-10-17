/**
 * Cancel fleet work whose overlord can no longer do it itself.
 *
 * This is the out-of-process half of the kill path, and its whole value is that it
 * never talks to the overlord. `systemctl stop` bounds how long an overlord lives;
 * nothing bounded what its workers went on spending, because the only thing that knew
 * about those tasks was the process that had just been killed. This reads the fleet
 * ledger — durable, shared, written before each task starts — and cancels what it finds
 * still running.
 *
 * Three rules it follows, each the difference between a kill path and a hope:
 *
 * It never starts a worker. `bootstrapLingFleet` would helpfully launch a local Ling if
 * none were configured, which for a reaper means creating the thing it exists to stop.
 * With no worker registry in the environment it refuses and says so.
 *
 * It never assumes the overlord is dead. Cancelling a task that is still supervised is
 * harmless — the overlord sees the cancelled status through its ordinary polling — so
 * an operator may run this before, during, or after a stop without reasoning about
 * races.
 *
 * It reports what it could not do, and exits non-zero for it. A reaper that swallows a
 * failed cancellation tells an operator the spending stopped when it did not.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { campaignRequestKeyPrefix } from "../campaign/request-key.js";
import { isTerminalStatus } from "../ling/events.js";
import { FleetLingClient, workersFromEnv } from "../ling/fleet.js";
import { FleetLedgerStore, fleetLedgerPathFromEnv } from "../ledger.js";

function usage(): never {
  console.error(`Usage:
  npm run reap -- [--campaign <campaign-id> | --manifest <manifest.json>] [--dry-run]

Cancels every task the fleet ledger still lists as queued or running. Requires a
worker registry in LING_WORKERS_JSON; it will never start a worker of its own.`);
  process.exit(1);
}

const args = process.argv.slice(2);
let campaignId: string | undefined;
let manifestPath: string | undefined;
let dryRun = false;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--dry-run") {
    dryRun = true;
  } else if (arg === "--campaign") {
    campaignId = args[index + 1];
    if (campaignId === undefined || campaignId.startsWith("--")) usage();
    index += 1;
  } else if (arg === "--manifest") {
    manifestPath = args[index + 1];
    if (manifestPath === undefined || manifestPath.startsWith("--")) usage();
    index += 1;
  } else {
    usage();
  }
}
if (campaignId !== undefined && manifestPath !== undefined) usage();

/**
 * A supervisor knows where its campaign's manifest is, not what the campaign calls
 * itself, and the ledger is keyed by the latter. Read the id rather than assuming the
 * directory name matches it.
 *
 * A manifest that cannot be read is a hard failure rather than a silent widening to the
 * whole fleet: several campaigns share one ledger, and cancelling a sibling's work
 * because this one's file was unreadable would be its own incident.
 */
if (manifestPath !== undefined) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path.resolve(manifestPath), "utf8"));
  } catch (error) {
    console.error(
      `unable to read campaign id from ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
  const id = (parsed as { id?: unknown }).id;
  if (typeof id !== "string" || id.trim() === "") {
    console.error(`${manifestPath} has no usable campaign id.`);
    process.exit(1);
  }
  campaignId = id;
}

const ledgerPath = fleetLedgerPathFromEnv();
const store = new FleetLedgerStore(ledgerPath);
try {
  const scope = campaignId === undefined ? "the fleet" : `campaign ${campaignId}`;
  const fromLedger = store.inFlightTasks(campaignId);
  if (dryRun) {
    // The dry run reports only what the ledger knows, because asking the workers means
    // holding a token, and a preview should not need credentials.
    if (fromLedger.length === 0) {
      console.log(`nothing in flight for ${scope} in ${ledgerPath}`);
      process.exit(0);
    }
    console.log(`${fromLedger.length} task(s) in flight for ${scope} in ${ledgerPath}`);
    for (const task of fromLedger) {
      console.log(`would cancel  ${task.id}  ${task.campaignId}  ${task.status}  ${task.updatedAt}`);
    }
    process.exit(0);
  }

  const workers = workersFromEnv();
  if (workers === undefined || workers.length === 0) {
    console.error(
      "refusing to reap without a configured worker registry: set LING_WORKERS_JSON to the fleet's array of { id, baseUrl, token }. Starting a worker here would create the thing this command exists to stop.",
    );
    process.exit(1);
  }
  const client = new FleetLingClient({ workers });

  /**
   * Ask the workers as well as the ledger, because the ledger has a blind spot the
   * kill path cannot afford: a spawn is reserved under a request key that carries no
   * task id, and the task's row only appears once the overlord records it. An overlord
   * that dies in between leaves a task running that the ledger cannot name. The worker
   * always knows, so it is the source of truth here and the ledger is a hint.
   */
  const active = [...fromLedger];
  const known = new Set(active.map((task) => task.id));
  let listingFailed = false;
  try {
    // The prefix every key the driver spawns under carries, so a worker's tasks can
    // be attributed to a campaign without the ledger's help.
    const prefix = campaignId === undefined ? undefined : campaignRequestKeyPrefix(campaignId);
    // Per worker, not flattened. `list()` returns whatever succeeded and throws only if
    // every worker fails, so a single unreachable worker holding an orphan used to look
    // exactly like an empty fleet — and this command would print "nothing in flight" and
    // exit zero, which is the one answer it must never give wrongly.
    const listing = await client.listByWorker();
    for (const failure of listing.failures) {
      listingFailed = true;
      console.error(
        `FAILED     worker ${failure.workerId} could not be listed: ${failure.error}`,
      );
    }
    for (const task of listing.tasks) {
      if (known.has(task.id) || isTerminalStatus(task.status)) continue;
      // Unfiltered, a bare `reap` takes everything the fleet is running. Filtered, only
      // tasks whose request key belongs to this campaign, so a sibling campaign sharing
      // the fleet is left alone.
      if (prefix !== undefined && !(task.requestKey ?? "").startsWith(prefix)) continue;
      active.push({
        id: task.id,
        campaignId: campaignId ?? "unrecorded",
        workerId: task.workerId,
        status: task.status,
        updatedAt: task.finishedAt ?? task.createdAt,
      });
      known.add(task.id);
    }
  } catch (error) {
    // Reported rather than fatal: the ledger's rows are still worth cancelling, and a
    // reaper that gives up because one worker is unreachable stops less than one that
    // does what it can and says what it could not.
    listingFailed = true;
    console.error(
      `FAILED     could not list worker tasks: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (active.length === 0) {
    // Never a bare "nothing in flight" when a worker could not be inspected: the
    // difference between "stopped" and "not looked at" is the whole value here.
    if (listingFailed) {
      console.error(
        `no in-flight work found for ${scope}, but at least one worker could not be listed; the fleet may still be spending`,
      );
      process.exit(1);
    }
    console.log(`nothing in flight for ${scope} in ${ledgerPath}`);
    process.exit(0);
  }
  console.log(`${active.length} task(s) in flight for ${scope} (ledger and workers)`);

  // Concurrent, because this runs inside a supervisor's stop sequence: sequential
  // cancellation would make the time to stop the fleet grow with the number of tasks,
  // and whatever bounds the stop — TimeoutStopSec, or an operator's patience — would
  // then have to be raised every time concurrency is.
  const confirmMs = Number(process.env["REAP_CONFIRM_TIMEOUT_MS"] ?? 20_000);
  const results = await Promise.all(
    active.map(async (task) => {
      try {
        await client.cancel(task.id, task.workerId);
      } catch (error) {
        return { task, error: error instanceof Error ? error.message : String(error) };
      }
      // `POST /tasks/:id/cancel` answers 202 `cancelling: true`. It means the request
      // was accepted, not that the work stopped: abort is cooperative, so a task
      // mid-turn keeps running and keeps spending for a while yet. Treating the 202 as
      // confirmation would write `cancelled` into the ledger while the worker was still
      // billing, which is worse than not reaping at all — it converts live spend into a
      // record that says there is none.
      const deadline = Date.now() + Math.max(0, confirmMs);
      let last = task.status;
      while (Date.now() < deadline) {
        try {
          const current = await client.get(task.id, task.workerId);
          last = current.status;
          if (isTerminalStatus(current.status)) {
            store.markTaskStatus(task.id, current.status);
            return { task, error: undefined };
          }
        } catch (error) {
          return { task, error: `cancelled but unreadable: ${error instanceof Error ? error.message : String(error)}` };
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      // Left in flight in the ledger on purpose. It is still running as far as anyone
      // knows, and the row saying so is what a later sweep needs.
      return { task, error: `cancellation requested but not confirmed; last status ${last}` };
    }),
  );
  for (const result of results) {
    if (result.error === undefined) {
      console.log(`cancelled  ${result.task.id}  ${result.task.campaignId}`);
    } else {
      console.error(`FAILED     ${result.task.id}  ${result.task.campaignId}  ${result.error}`);
    }
  }
  const failed = results.filter((result) => result.error !== undefined).length;
  console.log(`${results.length - failed} cancelled, ${failed} unconfirmed`);
  if (failed > 0 || listingFailed) process.exitCode = 1;
} finally {
  store.close();
}
