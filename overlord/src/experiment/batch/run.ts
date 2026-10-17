/**
 * Run command (§5.3): the only command that can spend. Per-run loop with
 * runPlannedRun integration, cost metering (measured and reconciled), OpenRouter
 * generation lookup, served-provider checking, instrument exclusions, resume logic,
 * and leftover directory detection. Outcome-blind: never writes score fields.
 */
import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BatchManifest, BatchRun } from "./manifest.js";
import {
  ledgerPath,
  readLedger,
  appendLine,
  appendWithFsync,
  familySpend,
  type LedgerLine,
} from "./ledger.js";
import { preflight, DEFAULT_DEPS, type PreflightDeps } from "./preflight.js";
import { coverageReasons, runPlannedRun, finalizeRun, type PlannedRunInput } from "../run.js";
import type { ArmId, ExperimentJson } from "../records.js";
import { instrumentRecord } from "../instrument.js";
import { modelMaxTokensFor, modelRoutingFor } from "./pins.js";
import { ARM_DEFINITIONS } from "../scenarios/arms.js";
import { loadRunRecords } from "../score/index.js";
import { computeExclusion, BATCH_STOPPING, servedReading, type ExclusionReason } from "../score/exclusion.js";
import type { ScoreContext } from "../score/types.js";

/** The repository root and ling's directory, from this file's place (overlord/src/experiment/batch). */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const LING_DIR = path.join(REPO_ROOT, "ling");

export interface RunOptions {
  approve: string;
  runsDir: string;
  registryPath: string;
  protocolFile: string;
}

export interface RunDeps {
  preflight: PreflightDeps;
  runPlannedRun: (input: PlannedRunInput) => Promise<{ experiment: ExperimentJson; runDir: string }>;
  lookupGeneration: (responseId: string, apiKey: string) => Promise<{ totalCost: number; provider: string } | null>;
  checkLeftoverDirs: (runDir: string) => Promise<string[]>;
  env: (key: string) => string | undefined;
  timestamp: () => string;
  /**
   * Every exclusion reason of a finished run, read from the run's own records
   * on disk (events, final state, manifest), as finalizeRun reads them.
   */
  exclusionReasons: (runDir: string, experiment: ExperimentJson, context: ScoreContext) => Promise<ExclusionReason[]>;
  /** What experiment.json's instrument records: git provenance, Pi versions, the agent settings digest. */
  instrument: () => Promise<PlannedRunInput["instrument"]>;
}

export const DEFAULT_RUN_DEPS: RunDeps = {
  preflight: DEFAULT_DEPS,
  runPlannedRun: async (input: PlannedRunInput) => {
    const result = await runPlannedRun(input);
    return { experiment: result.experiment, runDir: result.runDir };
  },
  lookupGeneration: async (responseId: string, apiKey: string) => {
    return await lookupOpenRouterGeneration(responseId, apiKey);
  },
  checkLeftoverDirs: async (runDir: string) => {
    return await findLeftoverDirs(runDir);
  },
  env: (key: string) => process.env[key],
  timestamp: () => new Date().toISOString(),
  exclusionReasons: async (runDir, experiment, context) => {
    const records = await loadRunRecords(runDir);
    const scored = computeExclusion({ ...records, experiment }, context).reasons.map((r) => r.reason);
    const coverage = (await coverageReasons(runDir, experiment)).map((r) => r.reason);
    return [...new Set([...scored, ...coverage])];
  },
  instrument: () => instrumentRecord(REPO_ROOT, LING_DIR),
};

/** Whether an arm's B is a model that spends (L3), not a script or no B at all. */
function hasModelB(arm: string): boolean {
  return ARM_DEFINITIONS[arm as ArmId]?.b === "model";
}

interface RunState {
  batchSpent: number;
  familySpent: number;
  stopped: boolean;
  stoppedReason: string | null;
}

/**
 * Lookup an OpenRouter generation by responseId, with retries and backoff.
 * Returns { totalCost, provider } or null if not found after all retries.
 */
export async function lookupOpenRouterGeneration(
  responseId: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxRetries = 5,
): Promise<{ totalCost: number; provider: string } | null> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // A generation is often not yet known for a few seconds after its call, so a 404 is retried like
    // any other failure: 1, 2, 4, 8 and 16 s apart, then given up (the run is then charged its cap).
    if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1));
    try {
      const response = await fetchImpl(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(responseId)}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!response.ok) continue;
      const data = (await response.json()) as { data?: { total_cost?: number; provider_name?: string; provider?: string } };
      const totalCost = data.data?.total_cost;
      const provider = data.data?.provider_name ?? data.data?.provider;
      if (typeof totalCost !== "number" || typeof provider !== "string") continue;
      return { totalCost, provider };
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Find leftover runtime or agent directories in the run directory. Returns
 * the list of leftover directory names (not deleted).
 */
async function findLeftoverDirs(runDir: string): Promise<string[]> {
  const leftovers: string[] = [];
  try {
    const entries = await readdir(runDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const name = entry.name;
        if (name.startsWith("ling-") || name.startsWith("runtime-") || name.startsWith("agent-")) {
          leftovers.push(name);
        }
      }
    }
  } catch {
    // Run directory may not exist yet
  }
  return leftovers;
}

function timestamp(): string {
  return new Date().toISOString();
}

export async function runBatch(
  manifest: BatchManifest,
  manifestSha256: string,
  options: RunOptions,
  deps: RunDeps = DEFAULT_RUN_DEPS,
): Promise<void> {
  // Approval comes first (§5.2 item 1): without the batch's own id nothing else is even looked at.
  if (options.approve !== manifest.id) {
    throw new Error(`--approve must equal manifest id ${manifest.id}, got ${options.approve}; nothing was run`);
  }

  // Preflight checks
  const preflightResult = preflight(
    manifest,
    manifestSha256,
    options.registryPath,
    options.runsDir,
    options.protocolFile,
    deps.preflight,
  );
  if (!preflightResult.ok) {
    throw new Error(`Preflight failed: ${preflightResult.reason}${preflightResult.details ? `: ${preflightResult.details}` : ""}`);
  }

  const ledger = ledgerPath(options.runsDir, manifest.id);
  const existingLines = readLedger(ledger);

  // Check if batch already started
  if (existingLines.length === 0) {
    appendLine(ledger, {
      event: "batch_started",
      batchId: manifest.id,
      manifestSha256,
      timestamp: deps.timestamp(),
    });
  }

  // Resume: determine which runs are terminal
  const terminalRuns = new Set<string>();
  const interruptedRuns = new Set<string>();
  const startedRuns = new Map<string, LedgerLine & { event: "run_started" }>();

  for (const line of existingLines) {
    if (line.event === "run_started") {
      startedRuns.set(line.runId, line);
    } else if (
      line.event === "run_finished" ||
      line.event === "run_failed" ||
      line.event === "run_not_started" ||
      line.event === "run_interrupted"
    ) {
      terminalRuns.add(line.runId);
      startedRuns.delete(line.runId);
    } else if (line.event === "batch_stopped") {
      // Batch already stopped, exit
      return;
    }
  }

  // Mark dangling run_started as interrupted
  for (const [runId, startLine] of startedRuns) {
    appendLine(ledger, {
      event: "run_interrupted",
      runId,
      costUsd: startLine.cap,
      timestamp: deps.timestamp(),
    });
    terminalRuns.add(runId);
    interruptedRuns.add(runId);
  }

  const state: RunState = {
    batchSpent: 0,
    // The family's other batches, counted once; this batch's own spend is batchSpent, kept current below.
    familySpent: familySpend(options.runsDir, manifest.family, manifest.id),
    stopped: false,
    stoppedReason: null,
  };

  // Recalculate batch spent from ledger
  for (const line of readLedger(ledger)) {
    if (line.event === "run_finished" || line.event === "run_failed" || line.event === "run_interrupted") {
      state.batchSpent += line.costUsd;
    }
  }

  // Track all-unknown runs for second-run stopping rule
  const allUnknownRuns = new Set<number>();

  // The instrument every run records: read once, and it must be the registered commit.
  const instrument = await deps.instrument();
  if (instrument.gitHead !== manifest.gitHead || !instrument.clean) {
    throw new Error(
      `The instrument is not the registered one: HEAD ${instrument.gitHead}${instrument.clean ? "" : " (dirty)"}, manifest ${manifest.gitHead}`,
    );
  }

  // Per-run loop
  for (let i = 0; i < manifest.runs.length; i++) {
    const run = manifest.runs[i]!;

    // Skip terminal runs (resume)
    if (terminalRuns.has(run.runId)) {
      continue;
    }

    // Check cap vs remaining
    const batchRemaining = manifest.ceilingUsd - state.batchSpent;
    const familyRemaining = manifest.familyCeilingUsd - (state.familySpent + state.batchSpent);
    const remaining = Math.min(batchRemaining, familyRemaining);

    if (run.capUsd > remaining) {
      // Cap exceeds remaining, skip this run and all later
      appendLine(ledger, {
        event: "run_not_started",
        runId: run.runId,
        reason: "cap_exceeds_remaining",
        timestamp: deps.timestamp(),
      });
      // Skip all remaining runs
      for (let j = i + 1; j < manifest.runs.length; j++) {
        appendLine(ledger, {
          event: "run_not_started",
          runId: manifest.runs[j]!.runId,
          reason: "cap_exceeds_remaining",
          timestamp: deps.timestamp(),
        });
      }
      appendLine(ledger, {
        event: "batch_stopped",
        reason: "cap_exceeds_remaining",
        timestamp: deps.timestamp(),
      });
      return;
    }

    // Append run_started with fsync
    const startLine: LedgerLine & { event: "run_started" } = {
      event: "run_started",
      runId: run.runId,
      cap: run.capUsd,
      estimate: run.estimateUsd,
      spentBefore: state.batchSpent,
      timestamp: deps.timestamp(),
    };
    appendWithFsync(ledger, startLine);

    // Execute run
    let experiment: ExperimentJson;
    let runDir: string;
    let harnessFailed = false;
    let harnessError = "";

    try {
      // Check for leftover dirs before running
      const leftoversBefore = await deps.checkLeftoverDirs(`${options.runsDir}/${manifest.id}/${run.runId}`);

      // Build the planned run input
      const input: PlannedRunInput = {
        run: {
          runId: run.runId,
          experiment: run.experiment,
          cell: run.cell,
          arm: run.arm,
          scenario: run.scenario,
          variant: run.variant,
          prompted: run.prompted,
          rep: run.rep,
          slot: "planned",
          estimateUsd: run.estimateUsd,
          capUsd: run.capUsd,
        },
        batchId: manifest.id,
        runsDir: options.runsDir,
        mode: "paid",
        models: {
          a: {
            provider: manifest.models.a.provider,
            model: manifest.models.a.model,
            thinking: manifest.models.a.thinking as "low",
          },
          // Only an arm whose B is a model (L3) spends on B; scripted-B arms and A-only arms get none.
          b: hasModelB(run.arm)
            ? {
                provider: manifest.models.b.provider,
                model: manifest.models.b.model,
                thinking: manifest.models.b.thinking as "low",
              }
            : null,
        },
        expectedModels: {
          a: manifest.models.a,
          b: hasModelB(run.arm) ? manifest.models.b : null,
        },
        sourceLingDir: LING_DIR,
        // Every child gets the manifest's routing (and nothing else may set it: the preflight refuses a
        // LING_MODEL_ROUTING in the environment), so each paid call goes to its pinned provider only.
        env: {
          ...process.env,
          LING_MODEL_ROUTING: JSON.stringify(modelRoutingFor(manifest.models)),
          LING_MODEL_MAX_TOKENS: JSON.stringify(modelMaxTokensFor(manifest.models)),
        },
        instrument,
        manifestSha256,
        approval: {
          approvedAt: deps.timestamp(),
          estimateUsd: run.estimateUsd,
          capUsd: run.capUsd,
          spentBeforeUsd: state.batchSpent,
          remainingBeforeUsd: remaining,
          confirmedEach: false,
        },
      };

      const result = await deps.runPlannedRun(input);
      experiment = result.experiment;
      runDir = result.runDir;

      // Check for leftover dirs after running
      const leftoversAfter = await deps.checkLeftoverDirs(runDir);
      if (leftoversBefore.length > 0 || leftoversAfter.length > 0) {
        console.error(`Warning: leftover directories found for ${run.runId}: ${[...leftoversBefore, ...leftoversAfter].join(", ")}`);
      }
    } catch (error: unknown) {
      harnessFailed = true;
      harnessError = error instanceof Error ? error.message : String(error);

      // run_failed + batch_stopped
      appendLine(ledger, {
        event: "run_failed",
        runId: run.runId,
        error: harnessError,
        costUsd: run.capUsd,
        timestamp: deps.timestamp(),
      });
      appendLine(ledger, {
        event: "batch_stopped",
        reason: "harness_error",
        timestamp: deps.timestamp(),
      });

      console.log(`run ${i + 1}/${manifest.runs.length}: excluded (run_failed), $${run.capUsd.toFixed(2)}; spent $${(state.batchSpent + run.capUsd).toFixed(2)} of $${manifest.ceilingUsd.toFixed(2)}`);
      return;
    }

    // Meter: measured cost
    let measured = 0;
    for (const call of experiment.served) {
      if (call.costUsd !== null) {
        measured += call.costUsd;
      }
    }

    // Reconcile with OpenRouter lookup
    let reconciled = measured;
    let lookupFailed = false;
    const apiKey = deps.env("OPENROUTER_API_KEY") ?? "";
    const unknownCostCalls: number[] = [];

    for (const call of experiment.served) {
      if (call.responseId === null || call.responseId === "") continue;

      const lookup = await deps.lookupGeneration(call.responseId, apiKey);
      if (lookup === null) {
        lookupFailed = true;
        continue;
      }

      // Update lookupProvider in experiment.served
      call.lookupProvider = lookup.provider;
      call.attempts = 1;

      // Reconcile: max of measured and lookup
      const callMeasured = call.costUsd ?? 0;
      const callReconciled = Math.max(callMeasured, lookup.totalCost);
      reconciled += callReconciled - callMeasured;
    }

    // Conservative charging: if ANY call's cost is unknown, charge the cap
    // A call has unknown cost if it has no measured cost AND no lookup result
    for (let i = 0; i < experiment.served.length; i++) {
      const call = experiment.served[i]!;
      const hasMeasuredCost = call.costUsd !== null;
      const hasLookupResult = call.lookupProvider !== null;
      if (!hasMeasuredCost && !hasLookupResult) {
        unknownCostCalls.push(i);
      }
    }

    if (unknownCostCalls.length > 0) {
      reconciled = run.capUsd;
    }

    // Update experiment cost
    experiment.cost.reconciled = reconciled;

    // Check cap overrun
    if (reconciled > run.capUsd) {
      appendLine(ledger, {
        event: "run_finished",
        runId: run.runId,
        status: "capped",
        stoppedBy: "max_cost",
        outcome: "excluded",
        reason: "cap_overrun",
        costUsd: reconciled,
        reconciled: true,
        lookupFailed,
        timestamp: deps.timestamp(),
      });
      appendLine(ledger, {
        event: "batch_stopped",
        reason: "cap_overrun",
        timestamp: deps.timestamp(),
      });

      console.log(`run ${i + 1}/${manifest.runs.length}: excluded (cap_overrun), $${reconciled.toFixed(2)}; spent $${(state.batchSpent + reconciled).toFixed(2)} of $${manifest.ceilingUsd.toFixed(2)}`);
      return;
    }

    const context: ScoreContext = {
      family: manifest.family,
      models: manifest.models,
      promptDigests: manifest.promptDigests,
    };

    // finalizeRun writes experiment.json, the reconciled cost and lookups included, and the run is
    // then judged from its own records on disk: never from an empty set, which would read every
    // record as missing.
    const finalized = await finalizeRun(runDir, experiment, context);
    const reasons: string[] = [...(await deps.exclusionReasons(runDir, finalized, context))];
    const servedCheck = servedReading(
      { experiment: finalized, events: [], manifest: undefined, finalState: undefined, probes: undefined },
      context,
    );
    if (servedCheck.mismatch && !reasons.includes("served_provider")) reasons.push("served_provider");

    // Every run that executed ends in run_finished with its cost, whatever stops the batch after it.
    const finish = (outcome: "included" | "excluded", reason: string | null): void => {
      appendLine(ledger, {
        event: "run_finished",
        runId: run.runId,
        status: outcome === "included" ? "success" : "excluded",
        stoppedBy: null,
        outcome,
        reason,
        costUsd: reconciled,
        reconciled: true,
        lookupFailed,
        timestamp: deps.timestamp(),
      });
      state.batchSpent += reconciled;
      const shown = outcome === "excluded" ? ` (${reasons.length > 0 ? reasons.join(", ") : reason})` : "";
      console.log(`run ${i + 1}/${manifest.runs.length}: ${outcome}${shown}, $${reconciled.toFixed(2)}; spent $${state.batchSpent.toFixed(2)} of $${manifest.ceilingUsd.toFixed(2)}`);
    };
    const stop = (reason: string): void => {
      appendLine(ledger, { event: "batch_stopped", reason, timestamp: deps.timestamp() });
    };

    // First run: any call with a null responseId or no provider stops the batch (PILOT-1's first contact).
    if (i === 0) {
      const hasUnverifiable = finalized.served.some(
        (call) => call.responseId === null || (call.inBandProvider === null && call.lookupProvider === null),
      );
      if (hasUnverifiable) {
        finish("excluded", "served_unverifiable");
        stop("served_unverifiable");
        return;
      }
    }

    // The second run whose calls are all unknown stops the batch.
    const allUnknown = finalized.served.every(
      (call) => call.inBandProvider === null && call.lookupProvider === null,
    );
    if (allUnknown && servedCheck.unknown === finalized.served.length) {
      allUnknownRuns.add(i);
      if (allUnknownRuns.size >= 2) {
        finish("excluded", "served_unverifiable");
        stop("served_unverifiable");
        return;
      }
    }

    // An instrument exclusion (builder_count, instrument_drift, …) stops the batch: the instrument is
    // then not the registered one.
    const stopping = reasons.find((reason) => BATCH_STOPPING.has(reason as ExclusionReason));
    if (stopping !== undefined) {
      finish("excluded", stopping);
      stop(stopping);
      return;
    }

    // Any other exclusion (served_provider, contamination, …) is recorded and the batch goes on.
    finish(reasons.length > 0 ? "excluded" : "included", reasons[0] ?? null);
  }

  // Batch finished
  appendLine(ledger, {
    event: "batch_finished",
    timestamp: deps.timestamp(),
  });
}
