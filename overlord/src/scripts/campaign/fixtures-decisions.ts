/**
 * The decisions the brain compliance harness puts to a model.
 *
 * Built with the production builders from fixed inputs, so the paid harness
 * asks exactly what a campaign in this state would ask and judges the answer
 * with the validator that campaign would use. `decisions-check` runs the same
 * fixtures offline: each request must be one the driver could pose, each answer
 * in `compliantAnswers` must pass, and each in `invalidAnswers` must not. The
 * invalid ones include the answers a key-only check used to count as compliant.
 */
import type { CampaignBrainChoice, CampaignBrainPhase } from "../../campaign/brain.js";
import {
  integrationDecision,
  recoveryDecision,
  reviewingDecision,
  schedulingDecision,
  type BrainDecision,
} from "../../campaign/decisions.js";

export const COMPLIANCE_GOAL =
  "Produce a Node service that normalises an address string to a validated structure.";

export function complianceDecisions(): Record<CampaignBrainPhase, BrainDecision> {
  return {
    scheduling: schedulingDecision({
      goal: COMPLIANCE_GOAL,
      acceptedSliceIds: ["01"],
      maxBatch: 2,
      readySlices: [
        {
          id: "02",
          status: "pending",
          dependsOn: [],
          attemptsUsed: 0,
          attemptsRemaining: 2,
          lastGaps: [],
        },
        {
          id: "03",
          status: "building",
          dependsOn: ["01"],
          attemptsUsed: 1,
          attemptsRemaining: 1,
          lastGaps: ["The HTTP layer does not surface the parser's validation errors."],
        },
      ],
    }),
    reviewing: reviewingDecision({
      goal: COMPLIANCE_GOAL,
      sliceId: "02",
      round: 1,
      gaps: ["Postal codes for IE are rejected because the shared type marks region required."],
      evidence: ["npm test reports 41 passing and 3 failing assertions."],
      attemptsRemaining: 1,
    }),
    integration: integrationDecision({
      goal: COMPLIANCE_GOAL,
      campaignId: "address-normaliser",
      maxRounds: 3,
      integrationRound: 1,
      replansUsed: 0,
      gaps: ["openapi.yaml documents a region field the parser never emits."],
      evidence: ["The service starts and answers POST /normalise for GB and DE inputs."],
      retryableSliceIds: ["03"],
      slices: [
        {
          id: "01",
          status: "accepted",
          dependsOn: [],
          createdInRound: 0,
          attemptsUsed: 1,
          attemptsRemaining: 1,
          specification: "Implement the address parser core with a documented Address type.",
        },
        {
          id: "03",
          status: "accepted",
          dependsOn: ["01"],
          createdInRound: 0,
          attemptsUsed: 1,
          attemptsRemaining: 1,
          specification:
            "Wire the parser and reference data into an HTTP service with openapi.yaml.",
        },
      ],
    }),
    recovery: recoveryDecision({
      goal: COMPLIANCE_GOAL,
      status: "blocked",
      haltReopensUsed: 0,
      maxHaltReopens: 1,
      latestGaps: [
        "The builder task stopped reporting and was cancelled at its wall-clock ceiling.",
      ],
      slices: [
        {
          id: "02",
          status: "building",
          attemptsUsed: 1,
          attemptsRemaining: 1,
          latestGaps: [],
        },
      ],
      tasks: [
        { id: "t-90", role: "planner", sliceId: null, status: "completed", round: 1 },
        { id: "t-91", role: "builder", sliceId: "02", status: "cancelled", round: 1 },
      ],
      budget: {
        maxTasks: 8,
        tasksUsed: 2,
        maxTotalCostUsd: 5,
        spentUsd: 1.42,
        maxTotalTokens: null,
        spentTokens: 88_140,
      },
    }),
  };
}

const answer = (action: string, args: Record<string, unknown> = {}): CampaignBrainChoice => ({
  action,
  rationale: "Fixture answer.",
  arguments: args,
});

/** One well-formed answer for every legal action, which the validators must accept. */
export const compliantAnswers: Record<CampaignBrainPhase, CampaignBrainChoice[]> = {
  scheduling: [
    answer("schedule_slices", { sliceIds: ["02"] }),
    answer("schedule_slices", { sliceIds: ["03", "02"] }),
    answer("halt_campaign"),
  ],
  reviewing: [answer("retry_slice"), answer("halt_campaign")],
  integration: [
    answer("retry_slices", { sliceIds: ["03"] }),
    answer("replan", {
      retrySliceIds: [],
      slices: [
        {
          id: "contract",
          spec: "Make openapi.yaml describe exactly the fields the parser emits.",
          dependsOn: ["03"],
        },
      ],
    }),
    answer("replan", {
      retrySliceIds: ["03"],
      slices: [
        { id: "client", spec: "Add a typed client.", dependsOn: ["contract"] },
        { id: "contract", spec: "Fix the contract.", dependsOn: ["01"] },
      ],
    }),
    answer("halt_campaign"),
  ],
  recovery: [
    answer("reopen_campaign", { delayMs: 0 }),
    answer("reopen_campaign", { delayMs: 60_000 }),
    answer("leave_halted"),
  ],
};

const replanSlice = (overrides: Record<string, unknown> = {}) => ({
  id: "contract",
  spec: "Fix the contract.",
  dependsOn: ["03"],
  ...overrides,
});

/**
 * Envelopes that parse but carry arguments the driver refuses, each with the
 * reason it must be refused. A model producing one of these is not compliant,
 * whatever its keys look like.
 */
export const invalidAnswers: Record<
  CampaignBrainPhase,
  Array<{ label: string; choice: CampaignBrainChoice; reason: RegExp }>
> = {
  scheduling: [
    {
      label: "an empty selection",
      choice: answer("schedule_slices", { sliceIds: [] }),
      reason: /between 1 and 2/,
    },
    {
      label: "more slices than maxBatch",
      choice: answer("schedule_slices", { sliceIds: ["02", "03", "01"] }),
      reason: /between 1 and 2/,
    },
    {
      label: "a repeated slice",
      choice: answer("schedule_slices", { sliceIds: ["02", "02"] }),
      reason: /must be unique/,
    },
    {
      label: "an accepted, not ready, slice",
      choice: answer("schedule_slices", { sliceIds: ["01"] }),
      reason: /non-ready slice\(s\): 01/,
    },
    {
      label: "an unknown slice",
      choice: answer("schedule_slices", { sliceIds: ["99"] }),
      reason: /non-ready slice\(s\): 99/,
    },
    {
      label: "a numeric id",
      choice: answer("schedule_slices", { sliceIds: [2] }),
      reason: /array of non-empty strings/,
    },
    {
      label: "a blank id",
      choice: answer("schedule_slices", { sliceIds: [" "] }),
      reason: /array of non-empty strings/,
    },
    {
      label: "a bare string instead of an array",
      choice: answer("schedule_slices", { sliceIds: "02" }),
      reason: /array of non-empty strings/,
    },
    {
      label: "missing sliceIds",
      choice: answer("schedule_slices"),
      reason: /missing: sliceIds/,
    },
    {
      label: "an extra argument",
      choice: answer("schedule_slices", { sliceIds: ["02"], priority: "high" }),
      reason: /unknown: priority/,
    },
    {
      label: "arguments on halt",
      choice: answer("halt_campaign", { reason: "done" }),
      reason: /unknown: reason/,
    },
    {
      label: "another phase's action",
      choice: answer("retry_slice"),
      reason: /not legal here/,
    },
  ],
  reviewing: [
    {
      label: "arguments on retry",
      choice: answer("retry_slice", { sliceId: "02" }),
      reason: /unknown: sliceId/,
    },
    {
      label: "arguments on halt",
      choice: answer("halt_campaign", { reason: "permanent" }),
      reason: /unknown: reason/,
    },
    {
      label: "another phase's action",
      choice: answer("retry_slices", { sliceIds: ["02"] }),
      reason: /not legal here/,
    },
  ],
  integration: [
    {
      label: "an empty retry",
      choice: answer("retry_slices", { sliceIds: [] }),
      reason: /At least one retry slice/,
    },
    {
      label: "retrying an untagged slice",
      choice: answer("retry_slices", { sliceIds: ["01"] }),
      reason: /not legal retries: 01/,
    },
    {
      label: "a repeated retry",
      choice: answer("retry_slices", { sliceIds: ["03", "03"] }),
      reason: /must be unique/,
    },
    {
      label: "a replan with no slices",
      choice: answer("replan", { retrySliceIds: [], slices: [] }),
      reason: /between 1 and 4 slices/,
    },
    {
      label: "a replan past the four-slice bound",
      choice: answer("replan", {
        retrySliceIds: [],
        slices: ["a", "b", "c", "d", "e"].map((id) => replanSlice({ id })),
      }),
      reason: /between 1 and 4 slices/,
    },
    {
      label: "a replan reusing an existing id",
      choice: answer("replan", { retrySliceIds: [], slices: [replanSlice({ id: "01" })] }),
      reason: /already exist: 01/,
    },
    {
      label: "a replan id over 64 bytes",
      choice: answer("replan", {
        retrySliceIds: [],
        slices: [replanSlice({ id: "界".repeat(22) })],
      }),
      reason: /1-64 trimmed UTF-8 bytes/,
    },
    {
      label: "a replan id with surrounding space",
      choice: answer("replan", { retrySliceIds: [], slices: [replanSlice({ id: " contract" })] }),
      reason: /1-64 trimmed UTF-8 bytes/,
    },
    {
      label: "a replan with an empty spec",
      choice: answer("replan", { retrySliceIds: [], slices: [replanSlice({ spec: " " })] }),
      reason: /spec must be non-empty text/,
    },
    {
      label: "a replan spec over 16000 characters",
      choice: answer("replan", {
        retrySliceIds: [],
        slices: [replanSlice({ spec: "x".repeat(16_001) })],
      }),
      reason: /at most 16000 characters/,
    },
    {
      label: "a replan with an unknown dependency",
      choice: answer("replan", {
        retrySliceIds: [],
        slices: [replanSlice({ dependsOn: ["02"] })],
      }),
      reason: /unknown dependencies: 02/,
    },
    {
      label: "a replan slice depending on itself",
      choice: answer("replan", {
        retrySliceIds: [],
        slices: [replanSlice({ dependsOn: ["contract"] })],
      }),
      reason: /cannot depend on itself/,
    },
    {
      label: "a replan that closes a cycle",
      choice: answer("replan", {
        retrySliceIds: [],
        slices: [
          replanSlice({ id: "a", dependsOn: ["b"] }),
          replanSlice({ id: "b", dependsOn: ["a"] }),
        ],
      }),
      reason: /contains a cycle at a/,
    },
    {
      label: "a replan retrying an untagged slice",
      choice: answer("replan", { retrySliceIds: ["01"], slices: [replanSlice()] }),
      reason: /not legal retries: 01/,
    },
    {
      label: "a replan missing its retry list",
      choice: answer("replan", { slices: [replanSlice()] }),
      reason: /missing: retrySliceIds/,
    },
    {
      label: "a replan slice with an extra field",
      choice: answer("replan", {
        retrySliceIds: [],
        slices: [replanSlice({ owner: "builder" })],
      }),
      reason: /unknown: owner/,
    },
    {
      label: "a replan slice that is not an object",
      choice: answer("replan", { retrySliceIds: [], slices: ["contract"] }),
      reason: /slices\[0\] must be an object/,
    },
  ],
  recovery: [
    {
      label: "a negative delay",
      choice: answer("reopen_campaign", { delayMs: -1 }),
      reason: /integer from 0 through 60000/,
    },
    {
      label: "a delay past the ceiling",
      choice: answer("reopen_campaign", { delayMs: 60_001 }),
      reason: /integer from 0 through 60000/,
    },
    {
      label: "a fractional delay",
      choice: answer("reopen_campaign", { delayMs: 1.5 }),
      reason: /integer from 0 through 60000/,
    },
    {
      label: "a delay given as a string",
      choice: answer("reopen_campaign", { delayMs: "100" }),
      reason: /integer from 0 through 60000/,
    },
    {
      label: "a null delay",
      choice: answer("reopen_campaign", { delayMs: null }),
      reason: /integer from 0 through 60000/,
    },
    {
      label: "a missing delay",
      choice: answer("reopen_campaign"),
      reason: /missing: delayMs/,
    },
    {
      label: "arguments on leave_halted",
      choice: answer("leave_halted", { delayMs: 0 }),
      reason: /unknown: delayMs/,
    },
  ],
};
