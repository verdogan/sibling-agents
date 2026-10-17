/**
 * The run composer (pilot build plan B2's first half): one planned run as one
 * single-slice campaign definition for the real driver, with the spawn policy
 * and the driver timings it runs under, and what `experiment.json` records of
 * it. Pure: it reads W1-D's scenario and arm tables and touches no ling, file
 * or clock, except for the campaign id's random hex.
 *
 * Every role states its provider, model, thinking and three limits, so that
 * nothing depends on what a child's ling is configured with. A runs at the
 * paid limits in every mode: the limits are rendered into A's prompt ("roughly
 * N turns and M minutes"), so a changed limit changes the prompt digest and
 * makes the run `instrument_drift`. Only offline runs may override A's wall
 * clock, for the regression that kills a hanging A. The planner, reviewer and
 * integration are scripted in every mode (protocol §1.1), and so is a
 * scripted B, which `withScriptedWatcher` serves in the overlord.
 *
 * A refusal is a ComposeError whose message is one of COMPOSE_REFUSALS' fixed
 * texts, so that a check can name it.
 */
import { randomBytes } from "node:crypto";
import { watcherLimits } from "../campaign/oversight.js";
import type { LingThinkingLevel } from "../ling/types.js";
import { DEFAULT_ALLOWED_TOOLS, type SpawnPolicy } from "../policy.js";
import {
  CAMPAIGN_ID_PATTERN,
  type BatchRun,
  type ExperimentB,
  type RoleLimits,
  type ScenarioId,
} from "./records.js";
import { ARM_DEFINITIONS, type ArmDefinition } from "./scenarios/arms.js";
import { NEUTRAL_ACCEPTANCE, NEUTRAL_GOAL } from "./scenarios/driver-files.js";
import { scenarioSeeds, sliceText, watchFor } from "./scenarios/index.js";
import { PROMPTED_SENTENCE } from "./scenarios/ledger.js";
import { watcherScriptSha256, type WatcherScriptName } from "./watcher-scripts.js";

export type RunMode = "offline" | "paid" | "rehearsal";

export interface ModelPin {
  provider: string;
  model: string;
  thinking: LingThinkingLevel;
}

export interface ComposeInput {
  run: Pick<
    BatchRun,
    "runId" | "experiment" | "cell" | "arm" | "scenario" | "variant" | "prompted" | "rep" | "capUsd"
  >;
  mode: RunMode;
  /**
   * The batch's pins. `b` is read only by a model-B arm, which refuses it null.
   * Only scripted against unscripted is checked here: that a paid pin is the
   * protocol's model and thinking is W4-A's preflight, against the batch.
   */
  models: { a: ModelPin; b: ModelPin | null };
  /** Offline only (B14's hanging A). B's wall clock derives from A's, so it has no override. */
  limitsOverride?: { aMaxWallClockMs?: number; bMaxWallClockMs?: number; settleGraceMs?: number };
  /** A dry run, the one place a draft variant is admitted. Offline only. */
  dryRun?: boolean;
  /** Tests only. */
  campaignId?: string;
}

export type ComposedRole = "builder" | "watcher" | "reviewer" | "integration" | "planner";

export interface ComposedRun {
  campaignId: string;
  /** The JSON `initializeCampaign` takes. */
  definition: unknown;
  policy: SpawnPolicy;
  driverTimings: { minBatchIntervalMs?: number };
  /** Offline override only; unset is the driver's default. */
  settleGraceMs?: number;
  arm: ArmDefinition;
  b: ExperimentB;
  watcherScript: WatcherScriptName | null;
  limits: { a: RoleLimits; b: RoleLimits | null };
  maxRounds: 1;
  maxTasks: number;
  /** Null for a role the run has no task for: the watcher of a no_watcher arm. */
  providers: Record<ComposedRole, string | null>;
}

/** A's limits in every run (protocol §1.1). */
export const A_LIMITS: RoleLimits = { maxTurns: 30, maxWallClockMs: 900_000, maxCostUsd: 0.3 };

/**
 * The smallest task budget a single-slice run fits in (F32): builder,
 * watcher (a ScriptedWatcher is recorded as a task too), reviewer and
 * integration. Pair admission needs both of the pair's slots free.
 */
export const MAX_TASKS: Readonly<Record<"no_watcher" | "channel", number>> = {
  channel: 4,
  no_watcher: 3,
};

/** What a scripted-B arm's definition names as B; `withScriptedWatcher` serves it. */
export const SCRIPTED_B_PLACEHOLDER = { provider: "scripted-overseer", model: "scripted-model" } as const;
const SCRIPTED_B_MAX_COST_USD = 0.01;
const MODEL_B_MAX_COST_USD = 1.5;

/** The scripted providers an offline run's children answer from, one script each. */
export const OFFLINE_PROVIDERS = {
  builder: "scripted-builder",
  watcher: "scripted-watcher",
  reviewer: "scripted-reviewer",
  integration: "scripted-integration",
  planner: "scripted-planner",
} as const;

/** The offline pins: scripted A keeps paid A's thinking (the prompt does not depend on it). */
export const OFFLINE_MODELS: { a: ModelPin; b: ModelPin } = {
  a: { provider: OFFLINE_PROVIDERS.builder, model: "scripted-model", thinking: "low" },
  b: { provider: OFFLINE_PROVIDERS.watcher, model: "scripted-model", thinking: "off" },
};

/** The pilot's pins (protocol §1.1), for the paid-shape checks. */
export const PILOT_MODELS: { a: ModelPin; b: ModelPin } = {
  a: { provider: "openrouter", model: "z-ai/glm-5.3-flash", thinking: "low" },
  b: { provider: "openrouter", model: "openai/gpt-5.6-terra", thinking: "low" },
};

const BUILDER_TOOLS = ["read", "write", "edit", "ls", "bash"];
const SCRIPTED_ROLE: RoleLimits = { maxTurns: 8, maxWallClockMs: 180_000, maxCostUsd: 0.01 };
const PLANNER_LIMITS: RoleLimits = { ...SCRIPTED_ROLE, maxTurns: 4 };

/**
 * How ling spells a scripted provider or model, as the schema's
 * SCRIPTED_MODEL_NAME does (`campaign/schema.ts`, not exported).
 */
const SCRIPTED_NAME = /^scripted(?:-[a-z0-9]+)*$/;

export const COMPOSE_REFUSALS = {
  mode: "The mode is not offline, paid or rehearsal.",
  arm: "The arm is not in the arm table.",
  experiment: "The experiment is not one of the arm's.",
  o3: "O3's variant is not built; no run of it is composed.",
  draft: "The arm's text is a draft, which runs only in a dry run.",
  dryRunMode: "A dry run is offline only.",
  overrideMode: "A limits override is offline only.",
  bWallClock: "B's wall clock derives from A's; no definition field sets it.",
  scenario: "The scenario is not the arm's.",
  variant: "The variant is not one of the arm's.",
  prompted: "Only L1 has a prompted cell.",
  undecided: "The arm's batch interval is not decided (F9); it runs offline only.",
  l0hMode: "L0h runs offline only here; its paid runs are counted-only, in Docker.",
  offlineUnscripted: "An offline run takes scripted pins only.",
  paidScripted: "A paid or rehearsal run takes no scripted pin for A or a model B.",
  modelBMissing: "A model-B arm needs the batch's B pin.",
  campaignId: "The campaign id is not <scenario>-<6 hex>.",
  overCap: "The role ceilings exceed the run's cap.",
} as const;
export type ComposeRefusal = keyof typeof COMPOSE_REFUSALS;

export class ComposeError extends Error {
  constructor(readonly refusal: ComposeRefusal) {
    super(COMPOSE_REFUSALS[refusal]);
    this.name = "ComposeError";
  }
}

/** `<scenario>-<6 random hex>`: request keys derive from it, so it is never reused. */
export function newCampaignId(scenario: ScenarioId): string {
  return `${scenario}-${randomBytes(3).toString("hex")}`;
}

function scripted(pin: { provider: string; model: string }): boolean {
  return SCRIPTED_NAME.test(pin.provider) && SCRIPTED_NAME.test(pin.model);
}

function role(provider: string, tools: string[], limits: RoleLimits) {
  return { tools, ...limits, provider, model: "scripted-model", thinking: "off" as const };
}

/** Dollars compared in micro-dollars, so that 0.3 + 0.01 * 4 is not over 0.34. */
const micros = (usd: number) => Math.round(usd * 1_000_000);

const MODES: readonly string[] = ["offline", "paid", "rehearsal"] satisfies RunMode[];

/** F9: an arm whose interval the owner has not decided runs offline only. */
export function assertIntervalDecided(arm: ArmDefinition, mode: RunMode): void {
  if (arm.minBatchIntervalMs !== null && arm.minBatchIntervalMs.decided !== true && mode !== "offline") {
    throw new ComposeError("undecided");
  }
}

/** One planned run as one campaign. Throws ComposeError for a run the experiment must not start. */
export function composeRun(input: ComposeInput): ComposedRun {
  const { run, mode } = input;
  // Both may come from a CLI flag or batch JSON, so neither is trusted to its type.
  if (!MODES.includes(mode)) throw new ComposeError("mode");
  if (!Object.hasOwn(ARM_DEFINITIONS, run.arm)) throw new ComposeError("arm");
  const arm = ARM_DEFINITIONS[run.arm];
  const offline = mode === "offline";
  const override = input.limitsOverride;
  if (arm.id === "O3") throw new ComposeError("o3");
  if (!arm.experiments.includes(run.experiment)) throw new ComposeError("experiment");
  if (input.dryRun === true && !offline) throw new ComposeError("dryRunMode");
  if (override !== undefined && !offline) throw new ComposeError("overrideMode");
  if (override?.bMaxWallClockMs !== undefined) throw new ComposeError("bWallClock");
  if (arm.draft && input.dryRun !== true) throw new ComposeError("draft");
  if (run.scenario !== arm.scenario) throw new ComposeError("scenario");
  if (!arm.variants.includes(run.variant)) throw new ComposeError("variant");
  if (run.prompted && arm.id !== "L1") throw new ComposeError("prompted");
  assertIntervalDecided(arm, mode);
  if (arm.id === "L0h" && !offline) throw new ComposeError("l0hMode");
  const a = input.models.a;
  const bPin = arm.b === "model" ? input.models.b : null;
  if (arm.b === "model" && bPin === null) throw new ComposeError("modelBMissing");
  const pins = bPin === null ? [a] : [a, bPin];
  if (offline && !pins.every(scripted)) throw new ComposeError("offlineUnscripted");
  if (!offline && pins.some(scripted)) throw new ComposeError("paidScripted");
  const campaignId = input.campaignId ?? newCampaignId(arm.scenario);
  if (!CAMPAIGN_ID_PATTERN.test(campaignId) || !campaignId.startsWith(`${arm.scenario}-`)) {
    throw new ComposeError("campaignId");
  }

  const aLimits: RoleLimits = {
    ...A_LIMITS,
    maxWallClockMs: override?.aMaxWallClockMs ?? A_LIMITS.maxWallClockMs,
  };
  const watcherMaxCostUsd =
    arm.b === "model" ? MODEL_B_MAX_COST_USD : arm.b === "script" ? SCRIPTED_B_MAX_COST_USD : 0;
  const ceilings =
    aLimits.maxCostUsd + watcherMaxCostUsd + PLANNER_LIMITS.maxCostUsd + SCRIPTED_ROLE.maxCostUsd * 2;
  // Over the cap, the driver would refuse the reviewer later, after A had run.
  if (micros(ceilings) > micros(run.capUsd)) throw new ComposeError("overCap");

  const slice = sliceText(arm.scenario, run.variant);
  const variant = arm.workerVariant === null ? {} : { workerVariant: arm.workerVariant };
  const dryRun = input.dryRun === true ? { dryRun: true } : {};
  const bModel =
    bPin === null ? null : { provider: bPin.provider, model: bPin.model, thinking: bPin.thinking };
  const watch =
    arm.b === "none"
      ? { required: false, condition: arm.condition, watcher: null, ...variant, ...dryRun }
      : {
          required: true,
          condition: arm.condition,
          watcher: bModel ?? { ...SCRIPTED_B_PLACEHOLDER },
          watcherMaxCostUsd,
          // A scripted B is told nothing (protocol §1.3).
          ...(bModel === null ? {} : { watchFor: watchFor(slice) }),
          ...variant,
          ...dryRun,
        };
  const maxTasks = MAX_TASKS[arm.condition === "no_watcher" ? "no_watcher" : "channel"];
  const definition = {
    id: campaignId,
    goal: NEUTRAL_GOAL,
    acceptance: NEUTRAL_ACCEPTANCE,
    budget: { maxTasks, maxTotalCostUsd: run.capUsd },
    maxRounds: 1,
    slices: [{ id: "01", spec: slice }],
    brain: { enabled: false },
    roles: {
      planner: role(OFFLINE_PROVIDERS.planner, ["read", "write"], PLANNER_LIMITS),
      builder: {
        tools: BUILDER_TOOLS,
        ...aLimits,
        provider: a.provider,
        model: a.model,
        thinking: a.thinking,
        files: scenarioSeeds(arm.scenario, run.variant),
        ...(run.prompted ? { instructions: PROMPTED_SENTENCE } : {}),
      },
      reviewer: role(OFFLINE_PROVIDERS.reviewer, ["read", "ls", "write_result"], SCRIPTED_ROLE),
      integration: role(OFFLINE_PROVIDERS.integration, ["read", "ls", "write_result"], SCRIPTED_ROLE),
    },
    coordination: { enabled: true, passiveMessaging: false, watch },
  };

  const providers: Record<ComposedRole, string | null> = {
    builder: a.provider,
    watcher: arm.b === "none" ? null : (bModel?.provider ?? SCRIPTED_B_PLACEHOLDER.provider),
    reviewer: OFFLINE_PROVIDERS.reviewer,
    integration: OFFLINE_PROVIDERS.integration,
    planner: OFFLINE_PROVIDERS.planner,
  };
  // B's turns and wall clock derive from A's and exceed them. The policy's
  // ceilings cover them, so that it trims no role: a trimmed A would render
  // other limits into its prompt, and with them another digest.
  const derived = watcherLimits(aLimits.maxWallClockMs, watcherMaxCostUsd);
  const policy: SpawnPolicy = {
    allowedTools: DEFAULT_ALLOWED_TOOLS,
    allowedProviders: [...new Set(Object.values(providers).filter((p): p is string => p !== null))],
    maxCostUsdPerTask: MODEL_B_MAX_COST_USD,
    maxTurnsPerTask: Math.max(derived.maxTurns, aLimits.maxTurns, SCRIPTED_ROLE.maxTurns),
    maxWallClockMsPerTask: Math.max(derived.maxWallClockMs, aLimits.maxWallClockMs),
    maxTasksPerRun: maxTasks,
    maxConcurrentTasks: 2,
    maxTotalCostUsd: run.capUsd,
  };
  const b: ExperimentB =
    arm.b === "none"
      ? { kind: "none" }
      : bModel === null
        ? { kind: "script", script: arm.script!, scriptSha256: watcherScriptSha256(arm.script!) }
        : { kind: "model", ...bModel, routing: null, resolved: null };
  return {
    campaignId,
    definition,
    policy,
    driverTimings:
      arm.minBatchIntervalMs === null ? {} : { minBatchIntervalMs: arm.minBatchIntervalMs.ms },
    ...(override?.settleGraceMs === undefined ? {} : { settleGraceMs: override.settleGraceMs }),
    arm,
    b,
    watcherScript: arm.script,
    limits: { a: aLimits, b: arm.b === "none" ? null : derived },
    maxRounds: 1,
    maxTasks,
    providers,
  };
}

// ---------------------------------------------------------------------------
// Cells for the checks. W4-A owns the counted cell table, with its N.

/** Protocol §5's per-run cap: A, plus B when B is a model, plus the run type's margin. */
function capUsd(arm: ArmDefinition): number {
  return arm.b === "model"
    ? A_LIMITS.maxCostUsd + MODEL_B_MAX_COST_USD + 0.5
    : A_LIMITS.maxCostUsd + 0.1;
}

function cell(
  arm: ArmDefinition,
  variant: ComposeInput["run"]["variant"],
  prompted: boolean,
  index: number,
): ComposeInput["run"] {
  return {
    runId: `run-${index.toString(16).padStart(8, "0")}`,
    experiment: arm.experiments[0]!,
    cell: `${arm.id} ${variant}${prompted ? " prompted" : ""}`,
    arm: arm.id,
    scenario: arm.scenario,
    variant,
    prompted,
    rep: 1,
    capUsd: capUsd(arm),
  };
}

/**
 * Every pilot arm with each of its variants, and L1 prompted on D2 and D3: a
 * superset of protocol §5's cells.
 */
export function pilotCells(): ComposeInput["run"][] {
  const cells: ComposeInput["run"][] = [];
  for (const arm of Object.values(ARM_DEFINITIONS)) {
    if (!arm.inPilot) continue;
    for (const variant of arm.variants) cells.push(cell(arm, variant, false, cells.length + 1));
  }
  for (const variant of ["D2", "D3"] as const) {
    cells.push(cell(ARM_DEFINITIONS.L1, variant, true, cells.length + 1));
  }
  return cells;
}

/** The arms of the dry runs (§1.2 item 2), L1 twice: unprompted and prompted. */
const DRY_RUN_ARMS = [
  "L1",
  "L1s",
  "L2",
  "L3",
  "R-control",
  "R-intervened",
  "W-control",
  "W",
  "W-unprompted",
  "P-relay",
  "P-direct",
  "L0h",
] as const;

/** One cell per dry run, each on its arm's first variant; L1 prompted on D2, as its pilot cells are. */
export function dryRunCells(): ComposeInput["run"][] {
  const cells = DRY_RUN_ARMS.map((id, index) =>
    cell(ARM_DEFINITIONS[id], ARM_DEFINITIONS[id].variants[0]!, false, index + 1),
  );
  cells.splice(1, 0, cell(ARM_DEFINITIONS.L1, "D2", true, cells.length + 1));
  return cells;
}
