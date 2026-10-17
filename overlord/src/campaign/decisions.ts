import { createHash } from "node:crypto";
import type { LingTaskStatus } from "../ling/types.js";
import type {
  CampaignBrainChoice,
  CampaignBrainLegalAction,
  CampaignBrainRequest,
} from "./brain.js";
import { dependencyCycle } from "./graph.js";
import { campaignRequestKey } from "./request-key.js";
import type { CampaignRole, CampaignStatus, SliceStatus } from "./schema.js";

/**
 * The questions the campaign brain is asked, one builder per phase.
 *
 * Each builder returns the request a model sees, the deterministic choice taken
 * when no model answers, and the validator every choice must pass before the
 * driver acts on it -- a model's, a replayed one's, and the fallback's. They take
 * plain values the driver derives from its manifest rather than the manifest
 * itself, so the compliance harness can put the production question to a model
 * and judge the answer with the production validator without building a
 * campaign.
 *
 * Everything here is deterministic: the request key and the recorded state hash
 * are digests of what the builder returns, and a resumed campaign replays a
 * recorded decision only when both still match. Reordering a field, rewording a
 * description or moving a bound therefore changes keys that running campaigns
 * have already recorded, which is why `decisions-check` pins them.
 */
export interface BrainDecision {
  request: CampaignBrainRequest;
  fallback: CampaignBrainChoice;
  /** Throws, with a reason, unless the driver could apply this choice as given. */
  validate: (choice: CampaignBrainChoice) => void;
}

/**
 * How long the brain may park a halted campaign before reconciling it.
 *
 * The ceiling is enforced twice on purpose: once when the decision is taken, and
 * again when `notBefore` comes back off disk. A manifest is a file, and a file
 * that has been edited or truncated must not be able to park the run loop for
 * longer than a decision ever could.
 */
export const MAX_RECOVERY_DELAY_MS = 60_000;

/** SHA-256 of the JSON encoding, the digest decision keys and summon intents use. */
export function hashState(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** The digest a recorded decision must match before it is replayed. */
export function decisionStateHash(request: CampaignBrainRequest): string {
  return hashState({
    phase: request.phase,
    goal: request.goal,
    state: request.state,
    legalActions: request.legalActions,
  });
}

export interface SchedulingSlice {
  id: string;
  status: SliceStatus;
  dependsOn: readonly string[];
  attemptsUsed: number;
  attemptsRemaining: number;
  /** Gaps from the slice's latest attempt, empty when it has none. */
  lastGaps: readonly string[];
}

export interface SchedulingInput {
  goal: string;
  acceptedSliceIds: readonly string[];
  /** Incomplete slices whose dependencies are all accepted, in manifest order. */
  readySlices: readonly SchedulingSlice[];
  maxBatch: number;
}

/** Which dependency-ready slices to run next. */
export function schedulingDecision(input: SchedulingInput): BrainDecision {
  const { maxBatch } = input;
  const state = {
    acceptedSliceIds: [...input.acceptedSliceIds],
    maxBatch,
    readySlices: input.readySlices.map((slice) => ({
      id: slice.id,
      status: slice.status,
      dependsOn: [...slice.dependsOn],
      attemptsUsed: slice.attemptsUsed,
      attemptsRemaining: slice.attemptsRemaining,
      lastGaps: [...slice.lastGaps],
    })),
  };
  const legalActions: CampaignBrainLegalAction[] = [
    {
      action: "schedule_slices",
      description:
        "Run a non-empty subset of dependency-ready slices, up to maxBatch. Prefer work that unblocks dependencies or resolves the most important gap.",
      argumentsSchema: {
        sliceIds: ["one or more ids from state.readySlices, unique, at most maxBatch"],
      },
    },
    {
      action: "halt_campaign",
      description:
        "Stop because none of the ready work should be attempted safely or usefully.",
      argumentsSchema: {},
    },
  ];
  const readyIds = new Set(state.readySlices.map((slice) => slice.id));
  return {
    request: {
      key: `scheduling:${hashState(state)}`,
      phase: "scheduling",
      goal: input.goal,
      state,
      legalActions,
    },
    fallback: {
      action: "schedule_slices",
      rationale: "The model was unavailable or invalid; use deterministic dependency order.",
      arguments: { sliceIds: state.readySlices.slice(0, maxBatch).map((slice) => slice.id) },
    },
    validate: (choice) => {
      requireLegalAction(choice, legalActions);
      if (choice.action === "halt_campaign") {
        requireArgumentKeys(choice.arguments, []);
        return;
      }
      requireArgumentKeys(choice.arguments, ["sliceIds"]);
      const ids = requireStringArray(choice.arguments["sliceIds"], "sliceIds");
      if (ids.length === 0 || ids.length > maxBatch) {
        throw new Error(`schedule_slices must choose between 1 and ${maxBatch} slices.`);
      }
      if (new Set(ids).size !== ids.length) {
        throw new Error("schedule_slices sliceIds must be unique.");
      }
      const unknown = ids.filter((id) => !readyIds.has(id));
      if (unknown.length > 0) {
        throw new Error(`schedule_slices chose non-ready slice(s): ${unknown.join(", ")}.`);
      }
    },
  };
}

export interface ReviewingInput {
  goal: string;
  sliceId: string;
  round: number;
  gaps: readonly string[];
  evidence: readonly string[];
  attemptsRemaining: number;
}

/** Whether a slice the reviewer sent back gets another attempt. */
export function reviewingDecision(input: ReviewingInput): BrainDecision {
  const state = {
    sliceId: input.sliceId,
    round: input.round,
    gaps: [...input.gaps],
    evidence: [...input.evidence],
    attemptsRemaining: input.attemptsRemaining,
  };
  const legalActions: CampaignBrainLegalAction[] = [
    {
      action: "retry_slice",
      description: "Run another bounded builder/reviewer attempt for this slice.",
      argumentsSchema: {},
    },
    {
      action: "halt_campaign",
      description:
        "Stop because the review gaps appear permanent, unsafe, or not usefully repairable within the remaining attempts.",
      argumentsSchema: {},
    },
  ];
  return {
    request: {
      key: `reviewing:${input.sliceId}:${input.round}:${hashState(state)}`,
      phase: "reviewing",
      goal: input.goal,
      state,
      legalActions,
    },
    fallback: {
      action: "retry_slice",
      rationale: "The model was unavailable or invalid; preserve the historical bounded retry.",
      arguments: {},
    },
    validate: (choice) => {
      requireLegalAction(choice, legalActions);
      requireArgumentKeys(choice.arguments, []);
    },
  };
}

export interface IntegrationSlice {
  id: string;
  status: SliceStatus;
  dependsOn: readonly string[];
  createdInRound: number;
  attemptsUsed: number;
  attemptsRemaining: number;
  /** The slice's full specification; the request carries its first 4000 characters. */
  specification: string;
}

/** What a replan proposal is checked against. */
export interface ReplanContext {
  campaignId: string;
  maxRounds: number;
  integrationRound: number;
  /** Tagged slices that are accepted and still have an attempt left. */
  retryableSliceIds: readonly string[];
  slices: readonly { id: string; dependsOn: readonly string[] }[];
}

export interface IntegrationInput extends ReplanContext {
  goal: string;
  replansUsed: number;
  gaps: readonly string[];
  evidence: readonly string[];
  slices: readonly IntegrationSlice[];
}

const MAX_CAMPAIGN_SLICES = 20;
const MAX_REPLAN_SLICES = 4;
const MAX_REPLAN_SPEC_CHARS = 16_000;
const MAX_REQUEST_SPEC_CHARS = 4_000;

/** How an integration revision is repaired: retry tagged slices, replan, or halt. */
export function integrationDecision(input: IntegrationInput): BrainDecision {
  const retryableIds = [...input.retryableSliceIds];
  const mayReplan =
    input.integrationRound < input.maxRounds &&
    input.replansUsed < input.maxRounds - 1 &&
    input.slices.length < MAX_CAMPAIGN_SLICES;
  const state = {
    integrationRound: input.integrationRound,
    maxRounds: input.maxRounds,
    replansUsed: input.replansUsed,
    gaps: [...input.gaps],
    evidence: [...input.evidence],
    taggedRetryableSliceIds: retryableIds,
    maxNewSlices: Math.min(MAX_REPLAN_SLICES, MAX_CAMPAIGN_SLICES - input.slices.length),
    slices: input.slices.map((slice) => ({
      id: slice.id,
      status: slice.status,
      dependsOn: [...slice.dependsOn],
      createdInRound: slice.createdInRound,
      attemptsUsed: slice.attemptsUsed,
      attemptsRemaining: slice.attemptsRemaining,
      specification: slice.specification.slice(0, MAX_REQUEST_SPEC_CHARS),
    })),
  };
  const legalActions: CampaignBrainLegalAction[] = [];
  if (retryableIds.length > 0) {
    legalActions.push({
      action: "retry_slices",
      description:
        "Reopen one or more tagged existing slices whose attempt allowance is not exhausted.",
      argumentsSchema: {
        sliceIds: ["one or more ids from state.taggedRetryableSliceIds, unique"],
      },
    });
  }
  if (mayReplan) {
    legalActions.push({
      action: "replan",
      description:
        "Add up to maxNewSlices bounded slices, optionally reopening tagged existing slices. Use this only when the integration gap needs work not represented by the current slices. New slices receive only maxRounds-integrationRound attempts.",
      argumentsSchema: {
        retrySliceIds: ["zero or more ids from state.taggedRetryableSliceIds, unique"],
        slices: [
          {
            id: "new unique slice id, at most 64 UTF-8 bytes",
            spec: "complete Markdown work specification, at most 16000 characters",
            dependsOn: ["known existing or simultaneously added slice ids, unique"],
          },
        ],
      },
    });
  }
  legalActions.push({
    action: "halt_campaign",
    description:
      "Stop because the integration gap is permanent, unsafe, or cannot be resolved within legal round/task/budget limits.",
    argumentsSchema: {},
  });
  const fallback: CampaignBrainChoice =
    retryableIds.length > 0
      ? {
          action: "retry_slices",
          rationale:
            "The model was unavailable or invalid; preserve the historical tagged-slice retry.",
          arguments: { sliceIds: retryableIds },
        }
      : {
          action: "halt_campaign",
          rationale:
            "The model was unavailable or invalid and no bounded existing-slice retry is legal.",
          arguments: {},
        };
  return {
    request: {
      key: `integration:${input.integrationRound}:${hashState(state)}`,
      phase: "integration",
      goal: input.goal,
      state,
      legalActions,
    },
    fallback,
    validate: (choice) => {
      requireLegalAction(choice, legalActions);
      if (choice.action === "halt_campaign") {
        requireArgumentKeys(choice.arguments, []);
        return;
      }
      if (choice.action === "retry_slices") {
        requireArgumentKeys(choice.arguments, ["sliceIds"]);
        const ids = requireStringArray(choice.arguments["sliceIds"], "sliceIds");
        validateRetrySliceIds(ids, retryableIds);
        return;
      }
      parseReplanProposal(choice.arguments, input);
    },
  };
}

export interface ReplanSliceProposal {
  id: string;
  spec: string;
  dependsOn: string[];
}

export interface ReplanProposal {
  retrySliceIds: string[];
  slices: ReplanSliceProposal[];
}

/**
 * Parse the arguments of a `replan` choice, or throw saying why the driver may
 * not apply them. The driver calls this twice: once as validation, and again to
 * read the proposal it is about to persist.
 */
export function parseReplanProposal(
  args: Record<string, unknown>,
  context: ReplanContext,
): ReplanProposal {
  requireArgumentKeys(args, ["retrySliceIds", "slices"]);
  const retrySliceIds = requireStringArray(args["retrySliceIds"], "retrySliceIds");
  validateRetrySliceIds(retrySliceIds, context.retryableSliceIds, true);
  if (!Array.isArray(args["slices"])) throw new Error("replan slices must be an array.");
  const maxNewSlices = Math.min(MAX_REPLAN_SLICES, MAX_CAMPAIGN_SLICES - context.slices.length);
  if (args["slices"].length === 0 || args["slices"].length > maxNewSlices) {
    throw new Error(`replan must add between 1 and ${maxNewSlices} slices.`);
  }
  if (context.integrationRound >= context.maxRounds) {
    throw new Error("replan cannot add slices after the campaign round cap.");
  }
  const knownIds = new Set(context.slices.map((slice) => slice.id));
  const additions = args["slices"].map((value, index): ReplanSliceProposal => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`replan slices[${index}] must be an object.`);
    }
    const raw = value as Record<string, unknown>;
    requireArgumentKeys(raw, ["id", "spec", "dependsOn"]);
    const id = raw["id"];
    if (
      typeof id !== "string" ||
      id.trim() === "" ||
      id !== id.trim() ||
      Buffer.byteLength(id, "utf8") > 64
    ) {
      throw new Error(`replan slices[${index}].id must be 1-64 trimmed UTF-8 bytes.`);
    }
    campaignRequestKey(context.campaignId, "builder", id, context.maxRounds);
    const spec = raw["spec"];
    if (typeof spec !== "string" || spec.trim() === "" || spec.length > MAX_REPLAN_SPEC_CHARS) {
      throw new Error(
        `replan slices[${index}].spec must be non-empty text of at most ${MAX_REPLAN_SPEC_CHARS} characters.`,
      );
    }
    const dependsOn = requireStringArray(raw["dependsOn"], `slices[${index}].dependsOn`);
    if (new Set(dependsOn).size !== dependsOn.length) {
      throw new Error(`replan slices[${index}].dependsOn must be unique.`);
    }
    return { id, spec, dependsOn };
  });
  const newIds = additions.map((slice) => slice.id);
  if (new Set(newIds).size !== newIds.length) throw new Error("replan slice ids must be unique.");
  const colliding = newIds.filter((id) => knownIds.has(id));
  if (colliding.length > 0) {
    throw new Error(`replan slice id(s) already exist: ${colliding.join(", ")}.`);
  }
  const allIds = new Set([...knownIds, ...newIds]);
  for (const slice of additions) {
    const unknown = slice.dependsOn.filter((id) => !allIds.has(id));
    if (unknown.length > 0) {
      throw new Error(`replan slice ${slice.id} has unknown dependencies: ${unknown.join(", ")}.`);
    }
    if (slice.dependsOn.includes(slice.id)) {
      throw new Error(`replan slice ${slice.id} cannot depend on itself.`);
    }
  }
  const cycle = dependencyCycle([...context.slices, ...additions]);
  if (cycle !== undefined) throw new Error(`replan dependency graph contains a cycle at ${cycle}.`);
  return { retrySliceIds, slices: additions };
}

export interface RecoverySlice {
  id: string;
  status: SliceStatus;
  attemptsUsed: number;
  attemptsRemaining: number;
  latestGaps: readonly string[];
}

export interface RecoveryTask {
  id: string;
  role: CampaignRole;
  sliceId: string | null;
  status: LingTaskStatus;
  round: number;
}

export interface RecoveryInput {
  goal: string;
  status: CampaignStatus;
  haltReopensUsed: number;
  maxHaltReopens: number;
  /** Every campaign-level gap; the request carries the latest eight. */
  latestGaps: readonly string[];
  slices: readonly RecoverySlice[];
  /** Every task, oldest first; the request carries the latest sixteen. */
  tasks: readonly RecoveryTask[];
  budget: {
    maxTasks: number;
    tasksUsed: number;
    maxTotalCostUsd: number;
    spentUsd: number;
    maxTotalTokens: number | null;
    spentTokens: number;
  };
}

/** Whether a halted campaign is reopened once, after a bounded delay. */
export function recoveryDecision(input: RecoveryInput): BrainDecision {
  const state = {
    status: input.status,
    haltReopensUsed: input.haltReopensUsed,
    maxHaltReopens: input.maxHaltReopens,
    latestGaps: input.latestGaps.slice(-8),
    slices: input.slices.map((slice) => ({
      id: slice.id,
      status: slice.status,
      attemptsUsed: slice.attemptsUsed,
      attemptsRemaining: slice.attemptsRemaining,
      latestGaps: [...slice.latestGaps],
    })),
    tasks: input.tasks.slice(-16).map((task) => ({
      id: task.id,
      role: task.role,
      sliceId: task.sliceId,
      status: task.status,
      round: task.round,
    })),
    budget: {
      maxTasks: input.budget.maxTasks,
      tasksUsed: input.budget.tasksUsed,
      maxTotalCostUsd: input.budget.maxTotalCostUsd,
      spentUsd: input.budget.spentUsd,
      maxTotalTokens: input.budget.maxTotalTokens,
      spentTokens: input.budget.spentTokens,
    },
  };
  const legalActions: CampaignBrainLegalAction[] = [
    {
      action: "reopen_campaign",
      description:
        "Reconcile and resume because the halt is plausibly transient and another bounded attempt can make progress.",
      argumentsSchema: {
        delayMs: `integer from 0 through ${MAX_RECOVERY_DELAY_MS} before reconciliation`,
      },
    },
    {
      action: "leave_halted",
      description:
        "Keep the campaign halted because the cause is permanent, repeated, unsafe, or still budget-bound.",
      argumentsSchema: {},
    },
  ];
  return {
    request: {
      key: `recovery:${input.haltReopensUsed + 1}:${input.status}:${hashState(state)}`,
      phase: "recovery",
      goal: input.goal,
      state,
      legalActions,
    },
    fallback: {
      action: "leave_halted",
      rationale: "The model was unavailable or invalid; do not spend against an undiagnosed halt.",
      arguments: {},
    },
    validate: (choice) => {
      requireLegalAction(choice, legalActions);
      if (choice.action === "leave_halted") {
        requireArgumentKeys(choice.arguments, []);
        return;
      }
      requireArgumentKeys(choice.arguments, ["delayMs"]);
      const delay = choice.arguments["delayMs"];
      if (
        !Number.isSafeInteger(delay) ||
        (delay as number) < 0 ||
        (delay as number) > MAX_RECOVERY_DELAY_MS
      ) {
        throw new Error(
          `reopen_campaign delayMs must be an integer from 0 through ${MAX_RECOVERY_DELAY_MS}.`,
        );
      }
    },
  };
}

/**
 * The driver refuses an illegal action before validating, so in a campaign this
 * never fires. It is here so a validator that passes means the driver would act,
 * which is the claim the compliance harness makes about a model's answer.
 */
function requireLegalAction(
  choice: CampaignBrainChoice,
  legalActions: readonly CampaignBrainLegalAction[],
): void {
  if (!legalActions.some((candidate) => candidate.action === choice.action)) {
    const legal = legalActions.map((candidate) => candidate.action).join(", ");
    throw new Error(
      `Decision action ${JSON.stringify(choice.action)} is not legal here; legal actions: ${legal}.`,
    );
  }
}

function validateRetrySliceIds(
  ids: readonly string[],
  retryableIds: readonly string[],
  allowEmpty = false,
): void {
  if (!allowEmpty && ids.length === 0) throw new Error("At least one retry slice is required.");
  if (new Set(ids).size !== ids.length) throw new Error("Retry slice ids must be unique.");
  const allowed = new Set(retryableIds);
  const illegal = ids.filter((id) => !allowed.has(id));
  if (illegal.length > 0) {
    throw new Error(`Slice(s) are not legal retries: ${illegal.join(", ")}.`);
  }
}

function requireArgumentKeys(args: Record<string, unknown>, expected: readonly string[]): void {
  const allowed = new Set(expected);
  const unknown = Object.keys(args).filter((key) => !allowed.has(key));
  const missing = expected.filter((key) => !Object.hasOwn(args, key));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(
      `Decision arguments require exactly [${expected.join(", ")}]` +
        `${unknown.length > 0 ? `; unknown: ${unknown.join(", ")}` : ""}` +
        `${missing.length > 0 ? `; missing: ${missing.join(", ")}` : ""}.`,
    );
  }
}

function requireStringArray(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.trim() === "")
  ) {
    throw new Error(`${label} must be an array of non-empty strings.`);
  }
  return value as string[];
}
