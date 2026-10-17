/**
 * Plan command: generates a deterministic batch manifest from a seed. PILOT-1
 * and PILOT-2 cells are hard-coded from protocol §5. The plan reads prompt
 * digests from the e2e output file and refuses if the protocol is uncommitted.
 */
import { randomBytes, createHash } from "node:crypto";
import type { ModelPin } from "../compose.js";
import type { BatchManifest, BatchRun } from "./manifest.js";

import type { ArmId, BatchModel, ExperimentId, ScenarioVariant } from "../records.js";
import { ARM_DEFINITIONS } from "../scenarios/arms.js";

export interface PlanInput {
  batch: "pilot-1" | "pilot-2";
  digests: Record<string, string>;
  seed?: string;
  piVersion: string;
  gitHead: string;
  protocolPath: string;
  protocolSha256: string;
  protocolCommitted: boolean;
  /** The model pins, as a paid run's children resolve them (pins.ts resolvePins). */
  models: { a: BatchModel; b: BatchModel };
  /** What the family's earlier batches have spent (ledger.ts familySpend): PILOT-2's ceiling is $5.00 less this (§5). */
  familySpentUsd: number;
  /** The batch id, when it is not the batch's own name: a retry is registered under a new id. */
  id?: string;
}

interface CellDef {
  experiment: ExperimentId;
  arm: ArmId;
  scenario: "ledger" | "crm-import";
  variant: ScenarioVariant;
  prompted: boolean;
  n: number;
}

const PILOT_1_CELLS: CellDef[] = [
  { experiment: "E1", arm: "L1", scenario: "ledger", variant: "D1", prompted: false, n: 1 },
  { experiment: "E2", arm: "L3", scenario: "ledger", variant: "D3", prompted: false, n: 1 },
];

const PILOT_2_CELLS: CellDef[] = [
  // E1: L1 unprompted D1-D4 × 2 (D1 rep 1 was in PILOT-1, so D1 rep 2, D2-D4 both reps)
  { experiment: "E1", arm: "L1", scenario: "ledger", variant: "D1", prompted: false, n: 1 }, // rep 2
  { experiment: "E1", arm: "L1", scenario: "ledger", variant: "D2", prompted: false, n: 2 },
  { experiment: "E1", arm: "L1", scenario: "ledger", variant: "D3", prompted: false, n: 2 },
  { experiment: "E1", arm: "L1", scenario: "ledger", variant: "D4", prompted: false, n: 2 },
  // E1: L1 prompted D2, D3 × 1
  { experiment: "E1", arm: "L1", scenario: "ledger", variant: "D2", prompted: true, n: 1 },
  { experiment: "E1", arm: "L1", scenario: "ledger", variant: "D3", prompted: true, n: 1 },
  // E2: L2 D1-D4 × 1
  { experiment: "E2", arm: "L2", scenario: "ledger", variant: "D1", prompted: false, n: 1 },
  { experiment: "E2", arm: "L2", scenario: "ledger", variant: "D2", prompted: false, n: 1 },
  { experiment: "E2", arm: "L2", scenario: "ledger", variant: "D3", prompted: false, n: 1 },
  { experiment: "E2", arm: "L2", scenario: "ledger", variant: "D4", prompted: false, n: 1 },
  // E2: L3 D2 × 1 (D3 was in PILOT-1)
  { experiment: "E2", arm: "L3", scenario: "ledger", variant: "D2", prompted: false, n: 1 },
  // E3: R-control 3, R-intervened 3
  { experiment: "E3", arm: "R-control", scenario: "crm-import", variant: "R", prompted: false, n: 3 },
  { experiment: "E3", arm: "R-intervened", scenario: "crm-import", variant: "R", prompted: false, n: 3 },
  // E6a: W-control 2, W 3
  { experiment: "E6a", arm: "W-control", scenario: "crm-import", variant: "W", prompted: false, n: 2 },
  { experiment: "E6a", arm: "W", scenario: "crm-import", variant: "W", prompted: false, n: 3 },
  // E6b: P-relay 2, P-direct 1
  { experiment: "E6b", arm: "P-relay", scenario: "crm-import", variant: "R", prompted: false, n: 2 },
  { experiment: "E6b", arm: "P-direct", scenario: "crm-import", variant: "P-direct", prompted: false, n: 1 },
];

/** Only an arm whose B is a model pays for B; a scripted B costs nothing (protocol §1.1, §1.6). */
function isModelBArm(arm: ArmId): boolean {
  return ARM_DEFINITIONS[arm].b === "model";
}

function expandCells(cells: CellDef[], seedHex: string): BatchRun[] {
  const runs: BatchRun[] = [];
  let cellIndex = 0;
  for (const cell of cells) {
    // The composer refuses a run whose scenario or variant is not its arm's; refuse it here, before
    // a batch that would stop mid-way is ever registered.
    const arm = ARM_DEFINITIONS[cell.arm];
    if (arm.scenario !== cell.scenario || !arm.variants.includes(cell.variant)) {
      throw new Error(`cell ${cell.experiment} ${cell.arm} ${cell.variant}: not one of the arm's scenario variants`);
    }
    const cellName = `${cell.experiment} ${cell.arm} ${cell.variant}${cell.prompted ? " prompted" : ""}`;
    const isModelB = isModelBArm(cell.arm);
    const estimateUsd = isModelB ? 0.51 : 0.06;
    const capUsd = isModelB ? 2.3 : 0.4;

    for (let rep = 1; rep <= cell.n; rep++) {
      const runIdSeed = `${seedHex}-${cellIndex}-${rep}`;
      const runIdHash = createHash("sha256").update(runIdSeed, "utf8").digest("hex");
      const runId = `run-${runIdHash.slice(0, 8)}`;

      runs.push({
        runId,
        cell: cellName,
        arm: cell.arm,
        experiment: cell.experiment,
        scenario: cell.scenario,
        variant: cell.variant,
        prompted: cell.prompted,
        rep,
        estimateUsd,
        capUsd,
      });
    }
    cellIndex++;
  }
  return runs;
}

function seededShuffle<T>(arr: T[], seed: string): T[] {
  // Simple seeded shuffle using the seed
  const copy = [...arr];
  const hash = createHash("sha256").update(seed, "utf8").digest();
  let hashIndex = 0;
  for (let i = copy.length - 1; i > 0; i--) {
    if (hashIndex >= hash.length - 4) {
      hashIndex = 0;
    }
    const randomValue = hash.readUInt32BE(hashIndex);
    hashIndex += 4;
    const j = randomValue % (i + 1);
    const temp = copy[i];
    const other = copy[j];
    if (temp !== undefined && other !== undefined) {
      copy[i] = other;
      copy[j] = temp;
    }
  }
  return copy;
}

export function planBatch(input: PlanInput): BatchManifest {
  if (!input.protocolCommitted) {
    throw new Error("protocol file is not committed at HEAD (rev 3 pre-registration)");
  }

  const seed = input.seed ?? randomBytes(16).toString("hex");
  const isPilot1 = input.batch === "pilot-1";
  const cells = isPilot1 ? PILOT_1_CELLS : PILOT_2_CELLS;

  let runs = expandCells(cells, seed);

  // PILOT-1 is fixed order
  if (!isPilot1) {
    // PILOT-2: L3 D2 first (model-b-first), then rep-major shuffled
    const l3d2Index = runs.findIndex((r) => r.arm === "L3" && r.variant === "D2");
    if (l3d2Index === -1) throw new Error("L3 D2 run not found in PILOT-2");
    const l3d2Run = runs[l3d2Index];
    if (!l3d2Run) throw new Error("L3 D2 run is undefined");
    const otherRuns = runs.filter((_, i) => i !== l3d2Index);

    // Group by cell and rep for rep-major ordering
    type RunGroup = { cell: string; rep: number; runs: BatchRun[] };
    const groups: RunGroup[] = [];
    for (const run of otherRuns) {
      let group = groups.find((g) => g.cell === run.cell && g.rep === run.rep);
      if (!group) {
        group = { cell: run.cell, rep: run.rep, runs: [] };
        groups.push(group);
      }
      group.runs.push(run);
    }

    // Shuffle within each rep
    const shuffledRuns: BatchRun[] = [];
    const maxRep = Math.max(...groups.map((g) => g.rep));
    for (let rep = 1; rep <= maxRep; rep++) {
      const repGroups = groups.filter((g) => g.rep === rep);
      const repRuns = repGroups.flatMap((g) => g.runs);
      const shuffled = seededShuffle(repRuns, `${seed}-rep${rep}`);
      shuffledRuns.push(...shuffled);
    }

    runs = [l3d2Run, ...shuffledRuns];
  }

  const batchId = isPilot1 ? "pilot-1" : "pilot-2";
  const batchEstimate = runs.reduce((sum, run) => sum + run.estimateUsd, 0);
  const pilot1Ceiling = 2.7;
  const familyCeiling = 5.0;
  // Rounded down to the cent, so the batch is never granted more than the family has left. The
  // epsilon keeps float error (5 - 4.98 = 0.01999...) from losing a whole cent.
  const pilot2Ceiling = Math.floor((familyCeiling - input.familySpentUsd) * 100 + 1e-9) / 100;
  if (!isPilot1 && !(pilot2Ceiling > 0)) {
    throw new Error(`the pilot family has spent $${input.familySpentUsd} of $${familyCeiling.toFixed(2)}: nothing is left for PILOT-2`);
  }

  const manifest: BatchManifest = {
    id: input.id ?? batchId,
    family: "pilot",
    runs,
    models: input.models,
    thinking: "low",
    // PILOT-1 (pilot-5) measured largest calls of $0.00033 (A) and $0.0117 (B). These margins are
    // over 3x both, as §1.6 requires, so they stay.
    capMarginUsd: {
      aOnly: 0.1,
      modelB: 0.5,
    },
    ceilingUsd: isPilot1 ? pilot1Ceiling : pilot2Ceiling,
    familyCeilingUsd: familyCeiling,
    promptDigests: input.digests,
    piVersion: input.piVersion,
    gitHead: input.gitHead,
    protocolPath: input.protocolPath,
    protocolSha256: input.protocolSha256,
    order: isPilot1 ? "fixed" : "model-b-first",
  };

  return manifest;
}

export function printPlanSummary(manifest: BatchManifest): void {
  const sha = createHash("sha256").update(JSON.stringify(manifest), "utf8").digest("hex");
  console.log(`Manifest SHA256: ${sha}`);
  console.log(`Batch: ${manifest.id}`);
  console.log(`Runs: ${manifest.runs.length}`);

  const aOnlyRuns = manifest.runs.filter((r) => !isModelBArm(r.arm));
  const modelBRuns = manifest.runs.filter((r) => isModelBArm(r.arm));

  console.log(`  A-only: ${aOnlyRuns.length} × $${manifest.capMarginUsd.aOnly + 0.3} = $${(aOnlyRuns.length * (manifest.capMarginUsd.aOnly + 0.3)).toFixed(2)}`);
  console.log(`  Model-B: ${modelBRuns.length} × $${manifest.capMarginUsd.modelB + 1.8} = $${(modelBRuns.length * (manifest.capMarginUsd.modelB + 1.8)).toFixed(2)}`);

  const totalEstimate = manifest.runs.reduce((sum, r) => sum + r.estimateUsd, 0);
  const totalCap = manifest.runs.reduce((sum, r) => sum + r.capUsd, 0);

  console.log(`Estimate: $${totalEstimate.toFixed(2)}`);
  console.log(`Total caps: $${totalCap.toFixed(2)}`);
  console.log(`Ceiling: $${manifest.ceilingUsd.toFixed(2)}`);
  console.log(`Family ceiling: $${manifest.familyCeilingUsd.toFixed(2)}`);
}
