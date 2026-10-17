import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { analyzeCampaignCoordination } from "../campaign/analysis.js";
import { CampaignArtifactStore } from "../campaign/artifacts.js";
import { campaignBrainFromEnv } from "../campaign/brain.js";
import {
  CampaignDriver,
  type CampaignLingClient,
} from "../campaign/driver.js";
import { initializeCampaign } from "../campaign/initialize.js";
import { acquireCampaignLock, type CampaignLock } from "../campaign/lock.js";
import { CampaignManifestStore } from "../campaign/manifest.js";
import {
  progressReporterFromEnv,
  type CampaignProgressReporter,
} from "../campaign/progress.js";
import {
  bootstrapLingFleet,
} from "../ling/bootstrap.js";
import { LocalTaskProvisioner } from "../ling/local-provisioner.js";
import {
  ProvisionedLingClient,
  resolvedWorkerProfileFromSpawnInput,
} from "../ling/provisioner.js";
import { isTerminalStatus } from "../ling/events.js";
import {
  FleetLedgerStore,
  fleetLedgerPathFromEnv,
  type FleetRateLimits,
} from "../ledger.js";
import { profileLibraryFromEnv } from "../profiles/index.js";
import type { TaskArtifactTransport } from "../campaign/artifacts.js";
import { spawnPolicyFromEnv } from "../policy.js";

function usage(): never {
  console.error(`Usage:
  npm run campaign -- init <definition.json> <campaign-directory>
  npm run campaign -- run <manifest.json> [--resume]
  npm run campaign -- status <manifest.json>
  npm run campaign -- inspect <manifest.json>`);
  process.exit(1);
}

function workspacesDir(): string {
  const configured = process.env["LING_WORKSPACES_DIR"]?.trim();
  if (configured) return path.resolve(configured);
  const lingDir = process.env["LING_DIR"]?.trim();
  return path.resolve(lingDir || path.join("..", "ling"), "workspaces");
}

function artifactStoreFor(
  manifestPath: string,
  transport?: TaskArtifactTransport,
): CampaignArtifactStore {
  return new CampaignArtifactStore(
    path.dirname(manifestPath),
    workspacesDir(),
    transport,
  );
}

function positiveEnvNumber(name: string, fallback: number): number {
  const parsed = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalPositiveEnvNumber(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return undefined;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number when set, got ${JSON.stringify(raw)}.`);
  }
  return parsed;
}

/**
 * Rolling-window limits, or nothing at all.
 *
 * Opt-in rather than defaulted, and deliberately: a default ceiling on pace would
 * silently change every campaign that runs today, including the paid live suite, and
 * a limit an operator did not choose is a limit nobody can size. The objective loop is
 * where these stop being optional — its charter already carries a window and a
 * per-window campaign cap, and it will pass them down.
 *
 * An unset individual limit is unlimited, so metering spend per hour does not force a
 * task ceiling to be invented alongside it.
 */
function fleetRateLimitsFromEnv(): FleetRateLimits | undefined {
  const maxTasks = optionalPositiveEnvNumber("FLEET_RATE_MAX_TASKS");
  const maxSpendUsd = optionalPositiveEnvNumber("FLEET_RATE_MAX_SPEND_USD");
  const maxDecisions = optionalPositiveEnvNumber("FLEET_RATE_MAX_DECISIONS");
  if (maxTasks === undefined && maxSpendUsd === undefined && maxDecisions === undefined) {
    return undefined;
  }
  return {
    windowMs: positiveEnvNumber("FLEET_RATE_WINDOW_MS", 60 * 60 * 1000),
    ...(maxTasks === undefined ? {} : { maxTasks }),
    ...(maxSpendUsd === undefined ? {} : { maxSpendUsd }),
    ...(maxDecisions === undefined ? {} : { maxDecisions }),
  };
}

interface CampaignLingRuntime {
  client: CampaignLingClient & TaskArtifactTransport;
  stop(): Promise<void>;
}

async function campaignLingRuntime(): Promise<CampaignLingRuntime> {
  if (process.env["LING_PROVISIONER"]?.trim().toLowerCase() !== "local-task") {
    return bootstrapLingFleet();
  }
  const provisioner = new LocalTaskProvisioner({
    ...(process.env["LING_DIR"]?.trim()
      ? { sourceLingDir: process.env["LING_DIR"]?.trim() }
      : {}),
    ...(process.env["LING_LOCAL_WORKER_ROOT"]?.trim()
      ? { runtimeRootDir: process.env["LING_LOCAL_WORKER_ROOT"]?.trim() }
      : {}),
  });
  const client = new ProvisionedLingClient({
    provisioner,
    resolveProfile: resolvedWorkerProfileFromSpawnInput,
    defaultLeaseTtlMs: Math.floor(
      positiveEnvNumber("LING_LOCAL_WORKER_TTL_MS", 60 * 60 * 1000),
    ),
  });
  return {
    client,
    stop: async () => {
      const { retainedWorkerIds } = await provisioner.shutdown();
      if (retainedWorkerIds.length > 0) {
        console.error(
          `retained local worker(s) with active or uncollected work: ${retainedWorkerIds.join(", ")}`,
        );
      }
    },
  };
}

const [, , command, ...args] = process.argv;
if (command === undefined) usage();

if (command === "init") {
  const [definitionFile, campaignDirectory, ...extra] = args;
  if (definitionFile === undefined || campaignDirectory === undefined || extra.length > 0) usage();
  const manifestPath = path.resolve(campaignDirectory, "manifest.json");
  let definition: unknown;
  try {
    definition = JSON.parse(await readFile(path.resolve(definitionFile), "utf8"));
  } catch (error) {
    throw new Error(`Unable to read campaign definition ${definitionFile}.`, { cause: error });
  }
  const manifest = await initializeCampaign(
    new CampaignManifestStore(manifestPath),
    artifactStoreFor(manifestPath),
    definition,
    { profileLibrary: await profileLibraryFromEnv() },
  );
  console.log(`${manifest.status}  ${manifest.id}`);
  console.log(manifestPath);
} else if (command === "status") {
  const [filename, ...extra] = args;
  if (filename === undefined || extra.length > 0) usage();
  const manifest = await new CampaignManifestStore(path.resolve(filename)).load();
  const coordinationAnalysis = analyzeCampaignCoordination(manifest);
  console.log(
    JSON.stringify(
      {
        id: manifest.id,
        status: manifest.status,
        slices: manifest.slices.map((slice) => ({
          id: slice.id,
          status: slice.status,
          attempts: slice.attempts.length,
        })),
        integration: manifest.integration.verdict,
        tasks: manifest.tasks.length,
        spentUsd: manifest.spentUsdSnapshot,
        spentTokens: manifest.spentTokensSnapshot,
        coordination: {
          enabled: manifest.coordination.enabled,
          planningCandidates: manifest.coordination.planningCandidates,
          parallelSlices: manifest.coordination.parallelSlices,
          passiveMessaging: manifest.coordination.passiveMessaging,
          decisions: manifest.coordination.decisions.length,
          messages: manifest.coordination.messages.length,
          metrics: coordinationAnalysis.metrics,
        },
        brain: {
          enabled: manifest.brain.enabled,
          decisions: manifest.brain.decisions.length,
          replansUsed: manifest.brain.replansUsed,
          haltReopensUsed: manifest.brain.haltReopensUsed,
        },
        updatedAt: manifest.updatedAt,
      },
      null,
      2,
    ),
  );
} else if (command === "inspect") {
  const [filename, ...extra] = args;
  if (filename === undefined || extra.length > 0) usage();
  const manifest = await new CampaignManifestStore(path.resolve(filename)).load();
  console.log(JSON.stringify(analyzeCampaignCoordination(manifest), null, 2));
} else if (command === "run") {
  const [filename, ...flags] = args;
  if (
    filename === undefined ||
    flags.some((flag) => flag !== "--resume") ||
    flags.filter((flag) => flag === "--resume").length > 1
  ) {
    usage();
  }
  const manifestPath = path.resolve(filename);
  const manifestStore = new CampaignManifestStore(manifestPath);

  // A completed or fully settled capped campaign contacts no worker. A capped
  // manifest with active task records must still acquire the lock and reconcile
  // them, otherwise a stale sibling can keep spending indefinitely.
  const existing = await manifestStore.load();
  const cappedAndSettled =
    existing.status === "capped" &&
    existing.tasks.every((task) => isTerminalStatus(task.status));
  if (existing.status === "completed" || cappedAndSettled) {
    await new Promise<void>((resolve) => {
      process.stdout.write(
        `${existing.status}  ${existing.id}  already finished; nothing to run\n`,
        () => resolve(),
      );
    });
    process.exit(existing.status === "completed" ? 0 : 2);
  }

  let runtime: CampaignLingRuntime | undefined;
  let lock: CampaignLock | undefined;
  let fleetStore: FleetLedgerStore | undefined;
  let driver: CampaignDriver | undefined;
  let reporter: CampaignProgressReporter | undefined;
  let interruptedBy: NodeJS.Signals | undefined;
  let notifySignal: ((signal: NodeJS.Signals) => void) | undefined;
  const signalReceived = new Promise<NodeJS.Signals>((resolve) => {
    notifySignal = resolve;
  });
  const onSignal = (signal: NodeJS.Signals) => {
    interruptedBy ??= signal;
    notifySignal?.(signal);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    lock = await acquireCampaignLock(path.dirname(manifestPath));
    runtime = await campaignLingRuntime();
    const rateLimits = fleetRateLimitsFromEnv();
    fleetStore = new FleetLedgerStore(fleetLedgerPathFromEnv(), {
      retentionMs:
        positiveEnvNumber("FLEET_LEDGER_RETENTION_DAYS", 30) * 24 * 60 * 60 * 1000,
      inFlightStaleMs: positiveEnvNumber(
        "FLEET_LEDGER_INFLIGHT_STALE_MS",
        2 * 60 * 60 * 1000,
      ),
      // So a prune cannot empty a window the operator asked to be counted.
      ...(rateLimits === undefined ? {} : { rateWindowMs: rateLimits.windowMs }),
    });
    reporter = progressReporterFromEnv(path.dirname(manifestPath));
    reporter.startStallDetection(() => manifestStore.load());
    driver = new CampaignDriver({
      client: runtime.client,
      store: manifestStore,
      artifacts: artifactStoreFor(manifestPath, runtime.client),
      policy: spawnPolicyFromEnv(),
      brain: existing.brain.enabled ? campaignBrainFromEnv() : undefined,
      fleetStore,
      ...(rateLimits === undefined ? {} : { rateLimits }),
      onProgress: async (manifest) => {
        await lock!.assertOwned();
        await reporter!.report(manifest);
      },
    });
    const runPromise = driver.run({ resumeBlocked: flags.includes("--resume") });
    const outcome = await Promise.race([
      runPromise.then((manifest) => ({ kind: "completed" as const, manifest })),
      signalReceived.then((signal) => ({ kind: "signal" as const, signal })),
    ]);
    let manifest;
    if (outcome.kind === "signal") {
      await driver.shutdown();
      // Bounded, for the same reason `shutdown` cancels before it waits: a wedged run
      // loop must not be able to hold the process open until systemd resorts to
      // SIGKILL. By here the workers have already been told to stop, so what is left
      // to wait for is bookkeeping, and the manifest on disk is the truth either way.
      const settled = await Promise.race([
        runPromise.then((value) => ({ manifest: value })),
        new Promise<undefined>((resolve) =>
          setTimeout(() => resolve(undefined), positiveEnvNumber("CAMPAIGN_STOP_TIMEOUT_MS", 45_000)),
        ),
      ]);
      if (settled === undefined) {
        // Nothing is going to observe this promise now; keep the process from dying of
        // an unhandled rejection on the way out.
        void runPromise.catch(() => undefined);
        console.error(
          `${existing.id}  run loop did not stop after cancellation; remote work is cancelled and accounting is deferred to the next run`,
        );
        manifest = await manifestStore.load();
      } else {
        manifest = settled.manifest;
      }
      process.exitCode = outcome.signal === "SIGINT" ? 130 : 143;
    } else {
      manifest = outcome.manifest;
    }
    console.log(
      `${manifest.status}  ${manifest.id}  ${manifest.tasks.length} task(s)  $${manifest.spentUsdSnapshot.toFixed(6)}`,
    );
    if (interruptedBy === undefined && manifest.status !== "completed") process.exitCode = 2;
  } catch (error) {
    if (reporter !== undefined) {
      try {
        await reporter.failure(
          await manifestStore.load(),
          error,
        );
      } catch {
        // Preserve the original campaign failure.
      }
    }
    throw error;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    reporter?.stopStallDetection();
    if (interruptedBy !== undefined) await driver?.shutdown();
    await reporter?.flush();
    await runtime?.stop();
    fleetStore?.close();
    await lock?.release();
  }
} else {
  usage();
}
