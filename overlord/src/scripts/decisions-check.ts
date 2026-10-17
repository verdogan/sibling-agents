/**
 * Offline checks for the brain's decision builders in `campaign/decisions.ts`.
 *
 * The golden values below were captured from the driver at fdb9b12, before the
 * builders were extracted from it, by running the driver scenarios defined below
 * against that commit with a throwaway harness. A decision key is how a resumed
 * campaign finds the decision it recorded, and the state hash is what that
 * decision must still match before it is replayed. Drift in a key makes a
 * resumed campaign ask again and perhaps decide differently; drift in a hash
 * alone makes it refuse to go on. Both are asserted twice: from the builders fed
 * literal inputs, and from the real driver running the scenarios.
 *
 * The rest is what the compliance harness relies on: adversarial answers are
 * refused with a reason, every fallback passes its own validator, and the
 * harness's fixtures are requests the production client would send. Last, an
 * integration retry reopens all of its slices in one save or none of them, on
 * both the brain and the deterministic path.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CampaignArtifactStore } from "../campaign/artifacts.js";
import {
  OpenAICompatibleBrain,
  type CampaignBrain,
  type CampaignBrainChoice,
  type CampaignBrainPhase,
  type CampaignBrainRequest,
} from "../campaign/brain.js";
import {
  MAX_RECOVERY_DELAY_MS,
  decisionStateHash,
  integrationDecision,
  parseReplanProposal,
  recoveryDecision,
  reviewingDecision,
  schedulingDecision,
  type BrainDecision,
  type IntegrationInput,
  type IntegrationSlice,
} from "../campaign/decisions.js";
import { CampaignDriver, type CampaignLingClient } from "../campaign/driver.js";
import { dependencyCycle } from "../campaign/graph.js";
import { initializeCampaign } from "../campaign/initialize.js";
import { CampaignManifestStore } from "../campaign/manifest.js";
import {
  MAX_CAMPAIGN_REQUEST_KEY_CHARS,
  campaignRequestKey,
  campaignRequestKeyPrefix,
  parseCampaignRequestKey,
} from "../campaign/request-key.js";
import { CampaignSchemaError, type CampaignManifest } from "../campaign/schema.js";
import { LingClientError } from "../ling/client.js";
import type { LingTask, SpawnInput, SpawnResponse } from "../ling/types.js";
import { DEFAULT_ALLOWED_TOOLS, type SpawnPolicy } from "../policy.js";
import {
  COMPLIANCE_GOAL,
  complianceDecisions,
  compliantAnswers,
  invalidAnswers,
} from "./campaign/fixtures-decisions.js";

let failures = 0;

async function check(label: string, run: () => void | Promise<void>): Promise<void> {
  try {
    await run();
    console.log(`PASS  ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${label} -- ${error instanceof Error ? error.message : String(error)}`);
  }
}

interface Golden {
  key: string;
  stateHash: string;
  legalActions: string[];
}

function assertGolden(decision: BrainDecision, golden: Golden): void {
  assert.equal(decision.request.key, golden.key);
  assert.equal(decisionStateHash(decision.request), golden.stateHash);
  assert.deepEqual(
    decision.request.legalActions.map((candidate) => candidate.action),
    golden.legalActions,
  );
}

/** Longer than the 4000 characters a request carries, so the bound is pinned too. */
const LONG_SPEC = `${"Specification line for the parser core.\n".repeat(120)}Tail that must be cut.`;

const GOLDEN = {
  scheduling: {
    key: "scheduling:f3b96039f6dd54d62d894f357437b9ea6b21461ce324db8cc9b75fe5c611aeee",
    stateHash: "d4f1478a623db529687ca4aad27fbfcc0d92b26f55040e23750b0ed6eb2d6488",
    legalActions: ["schedule_slices", "halt_campaign"],
  },
  schedulingRecovery: {
    key: "recovery:1:blocked:8ff7c1b55d42f08b1d79ae922e84d0ea5059af57992659800350e659e67b578e",
    stateHash: "154edbe60b9f629f39ad432e7b64754057c3bcbe6e16d9dddb360aea2e06a1ec",
    legalActions: ["reopen_campaign", "leave_halted"],
  },
  reviewing: {
    key: "reviewing:01:1:821b79c5238a02421fb25e91c513109217160c447322fed6c3ef1a61ece26f13",
    stateHash: "25cfdf77634f6e35d5fd1ea0eae56ccde507052e689af5247d7a2206383cb62e",
    legalActions: ["retry_slice", "halt_campaign"],
  },
  reviewingRecovery: {
    key: "recovery:1:blocked:44f3b203ab12d9471de23989461404ae4899f2ed42e3b6d22747b0b99611b2b3",
    stateHash: "17669db62ceb7bb231415996cda664d0af581307a7ec426d22c3c987fb072d41",
    legalActions: ["reopen_campaign", "leave_halted"],
  },
  integrationRetryReplan: {
    key: "integration:1:d183f60a77817d46627aecaa9935dfd363904046c57513722ed225d6b7a46ac6",
    stateHash: "f433028c5576259d0896dc5663d7c46900183cf0a7799a9c5c3459d62bc4ed7f",
    legalActions: ["retry_slices", "replan", "halt_campaign"],
  },
  integrationReplan: {
    key: "integration:1:d38de4187dae2ed782a086e4622be4d123273a9198e1ea57264f6b7ac5e11bb4",
    stateHash: "e2d4427a18b7f5a3b27084adbf165a90e23917ba2ed9b6012632557628580651",
    legalActions: ["replan", "halt_campaign"],
  },
  integrationRetry: {
    key: "integration:1:749e5d7cf74c7910dfc0446240689197c53873ad0642f9881807a8202d3c2a77",
    stateHash: "211dcee90bebcfeff6c4dfbdf14688256d56431e4d2e153d829be7e7af17b152",
    legalActions: ["retry_slices", "halt_campaign"],
  },
  integrationHalt: {
    key: "integration:1:2567b6282917bf3e9743a344dc8ee1a529eebb212813c4a693c5b4aca42ba847",
    stateHash: "2f61f5aeaf2c37ce10b81aca3bfffc9f89b89cb4356676664ef48c9a69a52408",
    legalActions: ["halt_campaign"],
  },
  integrationFallback: {
    key: "integration:1:f6c2bad297fb2b1243d591c1a3721b6a7b34c21788bd4eae19894dbc659c2d1d",
    stateHash: "2a24fc5f32edf1701efc77efaeb29c51c3de1d221d39d001080ea0a6c41d3c94",
    legalActions: ["retry_slices", "replan", "halt_campaign"],
  },
} satisfies Record<string, Golden>;

const FALLBACK_RATIONALE = {
  scheduling: "The model was unavailable or invalid; use deterministic dependency order.",
  reviewing: "The model was unavailable or invalid; preserve the historical bounded retry.",
  integrationRetry:
    "The model was unavailable or invalid; preserve the historical tagged-slice retry.",
  integrationHalt:
    "The model was unavailable or invalid and no bounded existing-slice retry is legal.",
  recovery: "The model was unavailable or invalid; do not spend against an undiagnosed halt.",
};

function integrationSlices(options: { capped?: string } = {}): IntegrationSlice[] {
  return [
    { id: "01", specification: LONG_SPEC, dependsOn: [] },
    { id: "02", specification: "Reference data.", dependsOn: [] },
    { id: "03", specification: "HTTP service.", dependsOn: ["01", "02"] },
  ].map((slice) => ({
    id: slice.id,
    status: "accepted",
    dependsOn: slice.dependsOn,
    createdInRound: 0,
    attemptsUsed: slice.id === options.capped ? 3 : 1,
    attemptsRemaining: slice.id === options.capped ? 0 : 2,
    specification: slice.specification,
  }));
}

function integrationInput(
  name: string,
  goal: string,
  overrides: Pick<IntegrationInput, "gaps" | "retryableSliceIds"> &
    Partial<IntegrationInput>,
): IntegrationInput {
  return {
    goal,
    campaignId: name,
    maxRounds: 3,
    integrationRound: 1,
    replansUsed: 0,
    evidence: ["The service starts but the contract disagrees."],
    slices: integrationSlices(),
    ...overrides,
  };
}

const goldenBuilders = {
  scheduling: () =>
    schedulingDecision({
      goal: "Schedule dependency-ready work.",
      acceptedSliceIds: ["01"],
      maxBatch: 2,
      readySlices: [
        {
          id: "02",
          status: "pending",
          dependsOn: [],
          attemptsUsed: 0,
          attemptsRemaining: 3,
          lastGaps: [],
        },
        {
          id: "03",
          status: "building",
          dependsOn: ["01"],
          attemptsUsed: 1,
          attemptsRemaining: 2,
          lastGaps: ["Errors are not surfaced.", "No 400 status."],
        },
      ],
    }),
  schedulingRecovery: () =>
    recoveryDecision({
      goal: "Schedule dependency-ready work.",
      status: "blocked",
      haltReopensUsed: 0,
      maxHaltReopens: 1,
      latestGaps: ["Overlord brain halted scheduling: Golden scheduling halt."],
      slices: [
        { id: "01", status: "accepted", attemptsUsed: 1, attemptsRemaining: 2, latestGaps: [] },
        { id: "02", status: "pending", attemptsUsed: 0, attemptsRemaining: 3, latestGaps: [] },
        {
          id: "03",
          status: "building",
          attemptsUsed: 1,
          attemptsRemaining: 2,
          latestGaps: ["Errors are not surfaced.", "No 400 status."],
        },
      ],
      tasks: [],
      budget: {
        maxTasks: 30,
        tasksUsed: 0,
        maxTotalCostUsd: 8,
        spentUsd: 0,
        maxTotalTokens: null,
        spentTokens: 0,
      },
    }),
  reviewing: () =>
    reviewingDecision({
      goal: "Review and retry a slice.",
      sliceId: "01",
      round: 1,
      gaps: ["write good output"],
      evidence: ["found mismatch"],
      attemptsRemaining: 2,
    }),
  reviewingRecovery: () =>
    recoveryDecision({
      goal: "Review and retry a slice.",
      status: "blocked",
      haltReopensUsed: 0,
      maxHaltReopens: 1,
      latestGaps: [],
      slices: [
        {
          id: "01",
          status: "blocked",
          attemptsUsed: 2,
          attemptsRemaining: 1,
          latestGaps: [
            "write good output",
            "Overlord brain stopped retries: Golden review halt.",
          ],
        },
      ],
      tasks: [
        { id: "task-01", role: "builder", sliceId: "01", status: "completed", round: 1 },
        { id: "task-02", role: "reviewer", sliceId: "01", status: "completed", round: 1 },
        { id: "task-03", role: "builder", sliceId: "01", status: "completed", round: 2 },
        { id: "task-04", role: "reviewer", sliceId: "01", status: "completed", round: 2 },
      ],
      budget: {
        maxTasks: 30,
        tasksUsed: 4,
        maxTotalCostUsd: 8,
        spentUsd: 0.04,
        maxTotalTokens: null,
        spentTokens: 8,
      },
    }),
  integrationRetryReplan: () =>
    integrationDecision(
      integrationInput("golden-integration-retry-replan", "Integrate with retry and replan.", {
        gaps: ["[slice:01] openapi.yaml disagrees.", "[slice:02] stale data."],
        retryableSliceIds: ["01"],
        slices: integrationSlices({ capped: "02" }),
      }),
    ),
  integrationReplan: () =>
    integrationDecision(
      integrationInput("golden-integration-replan", "Integrate with replan only.", {
        gaps: ["The contract needs a new client."],
        retryableSliceIds: [],
      }),
    ),
  integrationRetry: () =>
    integrationDecision(
      integrationInput("golden-integration-retry", "Integrate with retry only.", {
        gaps: ["[slice:03] wiring is wrong."],
        retryableSliceIds: ["03"],
        replansUsed: 2,
      }),
    ),
  integrationHalt: () =>
    integrationDecision(
      integrationInput("golden-integration-halt", "Integrate with nothing legal but halting.", {
        gaps: ["Unfixable."],
        retryableSliceIds: [],
        replansUsed: 2,
      }),
    ),
  integrationFallback: () =>
    integrationDecision(
      integrationInput("golden-integration-fallback", "Integrate through the fallback.", {
        gaps: ["[slice:03] [slice:01] both."],
        retryableSliceIds: ["03", "01"],
      }),
    ),
} satisfies Record<keyof typeof GOLDEN, () => BrainDecision>;

// --- The driver scenarios the golden values were captured from. ---------------

const policy: SpawnPolicy = {
  allowedTools: DEFAULT_ALLOWED_TOOLS,
  maxCostUsdPerTask: 2,
  maxTurnsPerTask: 40,
  maxWallClockMsPerTask: 900_000,
  maxTasksPerRun: 40,
  maxConcurrentTasks: 2,
  maxTotalCostUsd: 10,
};
const criterion = { id: "output", kind: "file" as const, requirement: "output.txt says good" };

type Verdict = "accept" | "revise" | "blocked";

function reviewResult(kind: "review" | "integration", verdict: Verdict, gaps: string[]) {
  const accepted = verdict === "accept";
  return {
    status: accepted ? "success" : "partial",
    summary: `${kind} ${verdict}.`,
    data: {
      kind,
      verdict,
      checks: [{ criterion: "output", passed: accepted, evidence: accepted ? "good" : "bad" }],
      evidence: [accepted ? "verified output" : "found mismatch"],
      gaps: accepted ? [] : gaps,
      barFetch: null,
    },
    steps: ["checked output"],
  };
}

/** Builders write output.txt; reviewers and integration answer as scripted. */
class ScriptedLing implements CampaignLingClient {
  private readonly tasks = new Map<string, LingTask>();
  private count = 0;

  constructor(
    private readonly workspacesDir: string,
    private readonly review: Verdict,
  ) {}

  async spawn(input: SpawnInput): Promise<SpawnResponse> {
    this.count += 1;
    const id = `task-${String(this.count).padStart(2, "0")}`;
    const workspaceDir = path.join(this.workspacesDir, id);
    await mkdir(workspaceDir, { recursive: true });
    let result: unknown;
    if (input.task.startsWith("Build only")) {
      await writeFile(path.join(workspaceDir, "output.txt"), "good", "utf8");
      result = {
        status: "success",
        summary: "Built output.",
        data: { kind: "build", artifacts: [{ path: "output.txt" }] },
        steps: ["wrote output"],
      };
    } else if (input.task.startsWith("Review the disposable")) {
      result = reviewResult("review", this.review, ["write good output"]);
    } else {
      result = reviewResult("integration", "accept", []);
    }
    const task: LingTask = {
      id,
      ...(input.requestKey === undefined ? {} : { requestKey: input.requestKey }),
      workerId: "local",
      status: "completed",
      prompt: input.task,
      options: { tools: input.tools },
      createdAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      workspaceDir,
      seededFiles: [],
      result,
      stats: {
        turns: 1,
        cost: 0.01,
        tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
      },
    };
    this.tasks.set(id, task);
    return {
      id,
      ...(input.requestKey === undefined ? {} : { requestKey: input.requestKey }),
      workerId: "local",
      status: "completed",
      options: task.options,
      seededFiles: [],
    };
  }

  async get(id: string): Promise<LingTask> {
    const task = this.tasks.get(id);
    if (task === undefined) throw new LingClientError("No such task", 404, false);
    return task;
  }

  async list(): Promise<LingTask[]> {
    return [...this.tasks.values()];
  }

  async cancel(): Promise<void> {}
}

type Script = (request: CampaignBrainRequest) => CampaignBrainChoice | "fail";

class ScriptedBrain implements CampaignBrain {
  readonly model = "golden-model";
  readonly maxAttempts = 1;
  constructor(private readonly script: Script) {}
  async decide(request: CampaignBrainRequest): Promise<CampaignBrainChoice> {
    const choice = this.script(request);
    if (choice === "fail") throw new Error("golden brain unavailable");
    return choice;
  }
}

const halt = (rationale: string): CampaignBrainChoice => ({
  action: "halt_campaign",
  rationale,
  arguments: {},
});
const leave: CampaignBrainChoice = {
  action: "leave_halted",
  rationale: "Golden leave halted.",
  arguments: {},
};

interface RecordedDecision extends Golden {
  source: "model" | "fallback";
  action: string;
  arguments: Record<string, unknown>;
  rationale: string;
}

async function runScenario(
  root: string,
  name: string,
  definition: Record<string, unknown>,
  script: Script,
  options: {
    edit?: (manifest: CampaignManifest, artifacts: CampaignArtifactStore) => Promise<void>;
    review?: Verdict;
  } = {},
): Promise<{ status: string; decisions: RecordedDecision[] }> {
  const dir = path.join(root, name);
  const workspaces = path.join(dir, "workspaces");
  const store = new CampaignManifestStore(path.join(dir, "manifest.json"));
  const artifacts = new CampaignArtifactStore(dir, workspaces);
  await initializeCampaign(store, artifacts, { id: name, ...definition });
  if (options.edit !== undefined) {
    const current = await store.load();
    await options.edit(current, artifacts);
    await store.save(current);
  }
  const manifest = await new CampaignDriver({
    client: new ScriptedLing(workspaces, options.review ?? "accept"),
    store,
    artifacts,
    policy,
    brain: new ScriptedBrain(script),
    pollIntervalMs: 2,
  }).run();
  return {
    status: manifest.status,
    decisions: manifest.brain.decisions.map((decision) => ({
      key: decision.key,
      stateHash: decision.stateHash,
      legalActions: decision.legalActions,
      source: decision.source,
      action: decision.action,
      arguments: decision.arguments,
      rationale: decision.rationale,
    })),
  };
}

async function acceptedAttempt(artifacts: CampaignArtifactStore, sliceId: string, round: number) {
  return {
    round,
    builderId: null,
    reviewerId: null,
    artifacts: [await artifacts.storeText(`golden/${sliceId}/${round}`, "output.txt", "good")],
    verdict: "accept" as const,
    evidence: [`Slice ${sliceId} round ${round} verified.`],
    gaps: [],
    costUsd: 0,
  };
}

function reviseAttempt(round: number, gaps: string[]) {
  return {
    round,
    builderId: null,
    reviewerId: null,
    artifacts: [],
    verdict: "revise" as const,
    evidence: ["found mismatch"],
    gaps,
    costUsd: 0,
  };
}

/** Every slice accepted, and an integration revision waiting on its brain decision. */
function integrationEdit(options: {
  affected: string[];
  gaps: string[];
  replansUsed?: number;
  capped?: string;
}) {
  return async (manifest: CampaignManifest, artifacts: CampaignArtifactStore) => {
    for (const slice of manifest.slices) {
      const rounds = slice.id === options.capped ? manifest.maxRounds - slice.createdInRound : 1;
      slice.attempts = [];
      for (let round = 1; round < rounds; round += 1) {
        slice.attempts.push(reviseAttempt(round, [`Round ${round} of ${slice.id} fell short.`]));
      }
      slice.attempts.push(await acceptedAttempt(artifacts, slice.id, rounds));
      slice.status = "accepted";
    }
    manifest.currentSliceId = null;
    manifest.brain.replansUsed = options.replansUsed ?? 0;
    manifest.integration.attempts.push({
      round: 1,
      reviewerId: null,
      verdict: "revise",
      evidence: ["The service starts but the contract disagrees."],
      gaps: options.gaps,
      affectedSliceIds: options.affected,
      retriesScheduled: false,
      costUsd: 0,
    });
    manifest.integration.reviewerId = null;
    manifest.integration.verdict = "revise";
    manifest.integration.evidence = ["The service starts but the contract disagrees."];
    manifest.integration.gaps = options.gaps;
  };
}

const base = {
  acceptance: [criterion],
  budget: { maxTasks: 30, maxTotalCostUsd: 8 },
  maxRounds: 3,
};
const threeSlices = [
  { id: "01", spec: "Parser core.", dependsOn: [] },
  { id: "02", spec: "Reference data.", dependsOn: [] },
  { id: "03", spec: "HTTP service.", dependsOn: ["01"] },
];
const integrationDefinition = (goal: string) => ({
  ...base,
  goal,
  slices: [
    { id: "01", spec: LONG_SPEC, dependsOn: [] },
    { id: "02", spec: "Reference data.", dependsOn: [] },
    { id: "03", spec: "HTTP service.", dependsOn: ["01", "02"] },
  ],
  coordination: { enabled: true, parallelSlices: true },
  brain: { enabled: true, maxDecisions: 12 },
});
const haltIntegration: Script = (request) =>
  request.phase === "recovery" ? leave : halt("Golden integration halt.");
const failed = (rationale: string) => `${rationale} Failure: golden brain unavailable`;

const model = (
  golden: Golden,
  action: string,
  rationale: string,
  args: Record<string, unknown> = {},
): RecordedDecision => ({
  ...golden,
  source: "model" as const,
  action,
  arguments: args,
  rationale,
});
const fallback = (
  golden: Golden,
  action: string,
  rationale: string,
  args: Record<string, unknown> = {},
): RecordedDecision => ({
  ...golden,
  source: "fallback" as const,
  action,
  arguments: args,
  rationale: failed(rationale),
});

const scheduledByFallback = (golden: Golden, sliceIds: string[]) =>
  fallback(golden, "schedule_slices", FALLBACK_RATIONALE.scheduling, { sliceIds });

/** Decisions recorded only by the driver scenarios, with no builder fixture of their own. */
const DRIVER_ONLY = {
  schedulingFallbackFirst: {
    key: "scheduling:58848da60065afc69455f9c5b8fb8dbbf5984eed8c0dc6998d39b2ed9bbaa3ff",
    stateHash: "3cee2fd6ef24137663f7cb8567c230d4f391b8f6261d71f7914da216b2110f9c",
    legalActions: ["schedule_slices", "halt_campaign"],
  },
  schedulingFallbackSecond: {
    key: "scheduling:db385dfcd771de0441d170e62285335598a0f24bdad8981c54c02b01036f36ca",
    stateHash: "332c938ec0eb9868ccf5335ccceb8b33e73feb7c31f9d09075772e341cb11d95",
    legalActions: ["schedule_slices", "halt_campaign"],
  },
  reviewingScheduling: {
    key: "scheduling:93386818bf3d2ec69c2571187f7ead50cf099baa01539d075b03e4c74b5ce0c7",
    stateHash: "ca1a8d3b98ff5cf732a409d4e94b3f2c6dd9f9fdc70317b1cdbe0aaafa75308e",
    legalActions: ["schedule_slices", "halt_campaign"],
  },
  reviewingSecondRound: {
    key: "reviewing:01:2:91f841e9fb70168ed0814b0319a1a2f5f9f7f34165f6173572db625802511b67",
    stateHash: "83a5b01150b470eef663cff97853c05e2438080c09f6b5ae276b1f5121933cf9",
    legalActions: ["retry_slice", "halt_campaign"],
  },
  fallbackRescheduleFirst: {
    key: "scheduling:7afa1471900ad6729bfec5617774b7722e43bb1f337d658bf253434ba2b14e14",
    stateHash: "356fd11853e8d5a66f600ad3d30a3be58e9c285ec24fadee0f338b2b38dc1982",
    legalActions: ["schedule_slices", "halt_campaign"],
  },
  fallbackRescheduleSecond: {
    key: "scheduling:30e015840635365ff8869ffe3bdc409c70e1d27de177eac7bcf928237a849a1e",
    stateHash: "a55cc2d1de1a50559ef85127129018f3248b7454d5b815febfd99fae244fbf4e",
    legalActions: ["schedule_slices", "halt_campaign"],
  },
} satisfies Record<string, Golden>;

const scenarios: Array<{
  name: string;
  run: (root: string) => ReturnType<typeof runScenario>;
  status: string;
  decisions: RecordedDecision[];
}> = [
  {
    name: "golden-scheduling",
    run: (root) =>
      runScenario(
        root,
        "golden-scheduling",
        {
          ...base,
          goal: "Schedule dependency-ready work.",
          slices: threeSlices,
          coordination: { enabled: true, parallelSlices: true },
          brain: { enabled: true, maxDecisions: 12 },
        },
        (request) => (request.phase === "recovery" ? leave : halt("Golden scheduling halt.")),
        {
          edit: async (manifest, artifacts) => {
            const first = manifest.slices[0]!;
            first.attempts = [await acceptedAttempt(artifacts, "01", 1)];
            first.status = "accepted";
            const third = manifest.slices[2]!;
            third.attempts = [reviseAttempt(1, ["Errors are not surfaced.", "No 400 status."])];
            third.status = "building";
            manifest.currentSliceId = "03";
          },
        },
      ),
    status: "blocked",
    decisions: [
      model(GOLDEN.scheduling, "halt_campaign", "Golden scheduling halt."),
      model(GOLDEN.schedulingRecovery, "leave_halted", "Golden leave halted."),
    ],
  },
  {
    name: "golden-scheduling-fallback",
    run: (root) =>
      runScenario(
        root,
        "golden-scheduling-fallback",
        {
          ...base,
          goal: "Schedule dependency-ready work.",
          slices: threeSlices,
          coordination: { enabled: true, parallelSlices: true },
          brain: { enabled: true, maxDecisions: 12 },
        },
        () => "fail",
      ),
    status: "completed",
    decisions: [
      scheduledByFallback(DRIVER_ONLY.schedulingFallbackFirst, ["01", "02"]),
      scheduledByFallback(DRIVER_ONLY.schedulingFallbackSecond, ["03"]),
    ],
  },
  {
    name: "golden-reviewing",
    run: (root) =>
      runScenario(
        root,
        "golden-reviewing",
        {
          ...base,
          goal: "Review and retry a slice.",
          slices: [{ id: "01", spec: "Write output.txt." }],
          brain: { enabled: true, maxDecisions: 12 },
        },
        (request) => {
          if (request.phase === "scheduling") {
            return {
              action: "schedule_slices",
              rationale: "Run it.",
              arguments: { sliceIds: ["01"] },
            };
          }
          if (request.phase === "reviewing") {
            return request.state["round"] === 1 ? "fail" : halt("Golden review halt.");
          }
          return "fail";
        },
        { review: "revise" },
      ),
    status: "blocked",
    decisions: [
      model(DRIVER_ONLY.reviewingScheduling, "schedule_slices", "Run it.", { sliceIds: ["01"] }),
      fallback(GOLDEN.reviewing, "retry_slice", FALLBACK_RATIONALE.reviewing),
      model(DRIVER_ONLY.reviewingSecondRound, "halt_campaign", "Golden review halt."),
      fallback(GOLDEN.reviewingRecovery, "leave_halted", FALLBACK_RATIONALE.recovery),
    ],
  },
  {
    name: "golden-integration-retry-replan",
    run: (root) =>
      runScenario(
        root,
        "golden-integration-retry-replan",
        integrationDefinition("Integrate with retry and replan."),
        haltIntegration,
        {
          edit: integrationEdit({
            affected: ["01", "02"],
            gaps: ["[slice:01] openapi.yaml disagrees.", "[slice:02] stale data."],
            capped: "02",
          }),
        },
      ),
    status: "blocked",
    decisions: [model(GOLDEN.integrationRetryReplan, "halt_campaign", "Golden integration halt.")],
  },
  {
    name: "golden-integration-replan",
    run: (root) =>
      runScenario(
        root,
        "golden-integration-replan",
        integrationDefinition("Integrate with replan only."),
        haltIntegration,
        { edit: integrationEdit({ affected: [], gaps: ["The contract needs a new client."] }) },
      ),
    status: "blocked",
    decisions: [model(GOLDEN.integrationReplan, "halt_campaign", "Golden integration halt.")],
  },
  {
    name: "golden-integration-retry",
    run: (root) =>
      runScenario(
        root,
        "golden-integration-retry",
        integrationDefinition("Integrate with retry only."),
        haltIntegration,
        {
          edit: integrationEdit({
            affected: ["03"],
            gaps: ["[slice:03] wiring is wrong."],
            replansUsed: 2,
          }),
        },
      ),
    status: "blocked",
    decisions: [model(GOLDEN.integrationRetry, "halt_campaign", "Golden integration halt.")],
  },
  {
    name: "golden-integration-halt",
    run: (root) =>
      runScenario(
        root,
        "golden-integration-halt",
        integrationDefinition("Integrate with nothing legal but halting."),
        () => "fail",
        { edit: integrationEdit({ affected: [], gaps: ["Unfixable."], replansUsed: 2 }) },
      ),
    status: "blocked",
    decisions: [
      fallback(GOLDEN.integrationHalt, "halt_campaign", FALLBACK_RATIONALE.integrationHalt),
    ],
  },
  {
    name: "golden-integration-fallback",
    run: (root) =>
      runScenario(
        root,
        "golden-integration-fallback",
        integrationDefinition("Integrate through the fallback."),
        () => "fail",
        {
          edit: integrationEdit({ affected: ["03", "01"], gaps: ["[slice:03] [slice:01] both."] }),
        },
      ),
    status: "completed",
    decisions: [
      fallback(GOLDEN.integrationFallback, "retry_slices", FALLBACK_RATIONALE.integrationRetry, {
        sliceIds: ["03", "01"],
      }),
      scheduledByFallback(DRIVER_ONLY.fallbackRescheduleFirst, ["01"]),
      scheduledByFallback(DRIVER_ONLY.fallbackRescheduleSecond, ["03"]),
    ],
  },
];

/** A fleet with nothing on it: listing is empty and nothing can be spawned. */
const workerless: CampaignLingClient = {
  async spawn() {
    throw new Error("This check has no workers.");
  },
  async get() {
    throw new LingClientError("No such task", 404, false);
  },
  async list() {
    return [];
  },
  async cancel() {},
};

/**
 * Two accepted slices and an integration revision tagging both, run to wherever
 * the driver stops, with every save the driver made along the way.
 */
async function integrationRetry(
  root: string,
  name: string,
  options: { maxRounds: number; capped?: string; brain?: CampaignBrain },
): Promise<{ manifest: CampaignManifest; saves: CampaignManifest[] }> {
  const dir = path.join(root, name);
  const store = new CampaignManifestStore(path.join(dir, "manifest.json"));
  const artifacts = new CampaignArtifactStore(dir, path.join(dir, "workspaces"));
  await initializeCampaign(store, artifacts, {
    id: name,
    goal: "Repair two slices after integration.",
    acceptance: [criterion],
    budget: { maxTasks: 8, maxTotalCostUsd: 5 },
    maxRounds: options.maxRounds,
    slices: [
      { id: "01", spec: "First." },
      { id: "02", spec: "Second." },
    ],
    ...(options.brain === undefined ? {} : { brain: { enabled: true, maxDecisions: 8 } }),
  });
  const current = await store.load();
  await integrationEdit({
    affected: ["01", "02"],
    gaps: ["[slice:01] and [slice:02] disagree."],
    ...(options.capped === undefined ? {} : { capped: options.capped }),
  })(current, artifacts);
  await store.save(current);
  const saves: CampaignManifest[] = [];
  const manifest = await new CampaignDriver({
    client: workerless,
    store,
    artifacts,
    policy,
    ...(options.brain === undefined ? {} : { brain: options.brain }),
    pollIntervalMs: 2,
    onProgress: (saved) => {
      saves.push(structuredClone(saved));
    },
  }).run();
  return { manifest, saves };
}

const statuses = (manifest: CampaignManifest) => manifest.slices.map((slice) => slice.status);

const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "decisions-check-"));

try {
  // (a) Golden values, from the builders and then from the driver.

  for (const [name, build] of Object.entries(goldenBuilders)) {
    await check(`builder golden ${name} matches the pre-extraction driver`, () => {
      assertGolden(build(), GOLDEN[name as keyof typeof GOLDEN]);
    });
  }

  for (const scenario of scenarios) {
    await check(`driver golden ${scenario.name} records the pre-extraction decisions`, async () => {
      const result = await scenario.run(tmpRoot);
      assert.equal(result.status, scenario.status);
      assert.deepEqual(result.decisions, scenario.decisions);
    });
  }

  await check("request keys keep their persisted format", () => {
    assert.equal(
      campaignRequestKey("golden", "builder", "01", 1),
      "campaign:Z29sZGVu:builder:MDE:1",
    );
    assert.equal(campaignRequestKey("golden", "planner", null, 3), "campaign:Z29sZGVu:planner:-:3");
    assert.equal(
      campaignRequestKey("kampanya-ğüş", "integration", null, 2),
      "campaign:a2FtcGFueWEtxJ_DvMWf:integration:-:2",
    );
    assert.equal(
      campaignRequestKey("golden", "reviewer", "dilim/ç:1", 12),
      "campaign:Z29sZGVu:reviewer:ZGlsaW0vw6c6MQ:12",
    );
    assert.equal(campaignRequestKeyPrefix("golden"), "campaign:Z29sZGVu:");
    assert.equal(MAX_CAMPAIGN_REQUEST_KEY_CHARS, 240);
    assert.throws(
      () => campaignRequestKey("c".repeat(64), "builder", "s".repeat(120), 3),
      /^Error: Campaign request key is 266 characters; Ling accepts at most 240\.$/,
    );
    const key = campaignRequestKey("golden", "reviewer", "dilim/ç:1", 12);
    assert.deepEqual(parseCampaignRequestKey("golden", key), {
      role: "reviewer",
      sliceId: "dilim/ç:1",
      round: 12,
    });
    assert.equal(parseCampaignRequestKey("other", key), undefined);
    assert.equal(parseCampaignRequestKey("golden", "campaign:Z29sZGVu:builder:MDE:01"), undefined);
    assert.equal(parseCampaignRequestKey("golden", "campaign:Z29sZGVu:owner:MDE:1"), undefined);
    assert.equal(parseCampaignRequestKey("golden", "campaign:Z29sZGVu:builder:MDE:1:x"), undefined);
  });

  await check("dependency cycles are found in order, and unknown ids are leaves", async () => {
    assert.equal(dependencyCycle([]), undefined);
    assert.equal(
      dependencyCycle([
        { id: "a" },
        { id: "b", dependsOn: ["a"] },
        { id: "c", dependsOn: ["a", "b", "elsewhere"] },
      ]),
      undefined,
    );
    assert.equal(
      dependencyCycle([
        { id: "a", dependsOn: [] },
        { id: "b", dependsOn: ["c"] },
        { id: "c", dependsOn: ["b"] },
      ]),
      "b",
    );
    assert.equal(
      dependencyCycle([
        { id: "c", dependsOn: ["b"] },
        { id: "b", dependsOn: ["c"] },
      ]),
      "c",
    );
    assert.equal(dependencyCycle([{ id: "self", dependsOn: ["self"] }]), "self");
    // The schema reports the same id, JSON-quoted, and only for parallel campaigns.
    const root = path.join(tmpRoot, "schema-cycle");
    await assert.rejects(
      initializeCampaign(
        new CampaignManifestStore(path.join(root, "manifest.json")),
        new CampaignArtifactStore(root, path.join(root, "workspaces")),
        {
          id: "schema-cycle",
          goal: "Refuse a cycle.",
          acceptance: [criterion],
          budget: { maxTasks: 4, maxTotalCostUsd: 5 },
          slices: [
            { id: "01", spec: "First.", dependsOn: ["02"] },
            { id: "02", spec: "Second.", dependsOn: ["01"] },
          ],
          coordination: { enabled: true, parallelSlices: true },
        },
      ),
      (error: unknown) =>
        error instanceof CampaignSchemaError &&
        error.message === 'manifest.slices: dependency graph contains a cycle at "01"',
    );
  });

  // (b) Adversarial answers, per phase.

  const compliance = complianceDecisions();
  for (const phase of Object.keys(invalidAnswers) as CampaignBrainPhase[]) {
    await check(`${phase} refuses malformed arguments a key check would pass`, () => {
      for (const { label, choice, reason } of invalidAnswers[phase]) {
        assert.throws(() => compliance[phase].validate(choice), reason, label);
      }
    });
  }

  await check("validators bind to the state they were built from", () => {
    // maxBatch is per decision: a non-parallel campaign may schedule one slice.
    const pending = (id: string) => ({
      id,
      status: "pending" as const,
      dependsOn: [],
      attemptsUsed: 0,
      attemptsRemaining: 2,
      lastGaps: [],
    });
    const single = schedulingDecision({
      goal: "One at a time.",
      acceptedSliceIds: [],
      maxBatch: 1,
      readySlices: [pending("a"), pending("b")],
    });
    single.validate({ action: "schedule_slices", rationale: "x", arguments: { sliceIds: ["b"] } });
    assert.throws(
      () =>
        single.validate({
          action: "schedule_slices",
          rationale: "x",
          arguments: { sliceIds: ["a", "b"] },
        }),
      /between 1 and 1/,
    );
    // Replan is refused where it was not offered, even with well-formed slices.
    const retryOnly = goldenBuilders.integrationRetry();
    assert.throws(
      () =>
        retryOnly.validate({
          action: "replan",
          rationale: "x",
          arguments: {
            retrySliceIds: [],
            slices: [{ id: "new", spec: "New work.", dependsOn: [] }],
          },
        }),
      /not legal here/,
    );
    // A replanned slice id that would overflow Ling's request key is refused. Only a
    // campaign id past today's 64-byte creation limit can get there.
    const longCampaign = integrationDecision(
      integrationInput("c".repeat(120), "Long campaign id.", {
        gaps: [],
        retryableSliceIds: [],
      }),
    );
    assert.throws(
      () =>
        longCampaign.validate({
          action: "replan",
          rationale: "x",
          arguments: {
            retrySliceIds: [],
            slices: [{ id: "s".repeat(64), spec: "New work.", dependsOn: [] }],
          },
        }),
      /Campaign request key is \d+ characters/,
    );
    // A twentieth slice leaves room for exactly one more.
    const crowded = integrationDecision(
      integrationInput("crowded", "Nearly full.", {
        gaps: [],
        retryableSliceIds: [],
        slices: Array.from({ length: 19 }, (_, index) => ({
          id: `s${index}`,
          status: "accepted" as const,
          dependsOn: [],
          createdInRound: 0,
          attemptsUsed: 1,
          attemptsRemaining: 2,
          specification: "Work.",
        })),
      }),
    );
    assert.equal(crowded.request.state["maxNewSlices"], 1);
    assert.throws(
      () =>
        crowded.validate({
          action: "replan",
          rationale: "x",
          arguments: {
            retrySliceIds: [],
            slices: [
              { id: "x", spec: "One.", dependsOn: [] },
              { id: "y", spec: "Two.", dependsOn: [] },
            ],
          },
        }),
      /between 1 and 1 slices/,
    );
    // The request carries a bounded specification and the recovery tail only.
    const specification = (
      goldenBuilders.integrationReplan().request.state["slices"] as Array<{ specification: string }>
    )[0]?.specification;
    assert.equal(specification, LONG_SPEC.slice(0, 4_000));
    const busy = recoveryDecision({
      goal: "Many tasks.",
      status: "budget_exhausted",
      haltReopensUsed: 1,
      maxHaltReopens: 2,
      latestGaps: Array.from({ length: 12 }, (_, index) => `gap ${index}`),
      slices: [],
      tasks: Array.from({ length: 20 }, (_, index) => ({
        id: `t${index}`,
        role: "builder" as const,
        sliceId: "01",
        status: "completed" as const,
        round: 1,
      })),
      budget: {
        maxTasks: 20,
        tasksUsed: 20,
        maxTotalCostUsd: 5,
        spentUsd: 5,
        maxTotalTokens: 1_000,
        spentTokens: 1_000,
      },
    });
    assert.match(busy.request.key, /^recovery:2:budget_exhausted:[a-f0-9]{64}$/);
    assert.deepEqual(busy.request.state["latestGaps"], [
      "gap 4",
      "gap 5",
      "gap 6",
      "gap 7",
      "gap 8",
      "gap 9",
      "gap 10",
      "gap 11",
    ]);
    const tasks = busy.request.state["tasks"] as Array<{ id: string }>;
    assert.equal(tasks.length, 16);
    assert.equal(tasks[0]?.id, "t4");
    assert.equal(MAX_RECOVERY_DELAY_MS, 60_000);
  });

  await check("a replan proposal parses to exactly what the driver persists", () => {
    const input = integrationInput("parse", "Parse.", {
      gaps: [],
      retryableSliceIds: ["03"],
    });
    assert.deepEqual(
      parseReplanProposal(
        {
          retrySliceIds: ["03"],
          slices: [{ id: "client", spec: "Client.", dependsOn: ["03"] }],
        },
        input,
      ),
      {
        retrySliceIds: ["03"],
        slices: [{ id: "client", spec: "Client.", dependsOn: ["03"] }],
      },
    );
  });

  // (c) Every fallback passes its own validator.

  await check("every fallback passes its own validator", () => {
    const decisions: Array<[string, BrainDecision]> = [
      ...Object.entries(goldenBuilders).map(([name, build]): [string, BrainDecision] => [
        name,
        build(),
      ]),
      ...Object.entries(compliance).map(([phase, decision]): [string, BrainDecision] => [
        `compliance ${phase}`,
        decision,
      ]),
    ];
    for (const [name, decision] of decisions) {
      assert.doesNotThrow(() => decision.validate(structuredClone(decision.fallback)), name);
      const offered = decision.request.legalActions.map((candidate) => candidate.action);
      assert.ok(
        offered.includes(decision.fallback.action),
        `${name} falls back to an action it does not offer`,
      );
    }
    assert.equal(goldenBuilders.scheduling().fallback.rationale, FALLBACK_RATIONALE.scheduling);
    assert.deepEqual(goldenBuilders.scheduling().fallback.arguments, { sliceIds: ["02", "03"] });
    assert.equal(goldenBuilders.reviewing().fallback.rationale, FALLBACK_RATIONALE.reviewing);
    assert.equal(
      goldenBuilders.integrationFallback().fallback.rationale,
      FALLBACK_RATIONALE.integrationRetry,
    );
    assert.deepEqual(goldenBuilders.integrationFallback().fallback.arguments, {
      sliceIds: ["03", "01"],
    });
    assert.equal(
      goldenBuilders.integrationReplan().fallback.rationale,
      FALLBACK_RATIONALE.integrationHalt,
    );
    assert.equal(
      goldenBuilders.schedulingRecovery().fallback.rationale,
      FALLBACK_RATIONALE.recovery,
    );
  });

  // (d) The compliance harness's fixtures.

  await check("compliance fixtures accept a well-formed answer to every legal action", () => {
    for (const phase of Object.keys(compliantAnswers) as CampaignBrainPhase[]) {
      const decision = compliance[phase];
      assert.equal(decision.request.phase, phase);
      assert.equal(decision.request.goal, COMPLIANCE_GOAL);
      assert.ok(decision.request.key.startsWith(`${phase}:`));
      const offered = decision.request.legalActions.map((candidate) => candidate.action);
      assert.equal(new Set(offered).size, offered.length, `${phase} offers an action twice`);
      const answered = new Set(compliantAnswers[phase].map((choice) => choice.action));
      assert.deepEqual([...answered].sort(), [...offered].sort(), `${phase} answers every action`);
      for (const choice of compliantAnswers[phase]) {
        assert.doesNotThrow(() => decision.validate(choice), `${phase} ${choice.action}`);
      }
    }
  });

  await check("compliance requests go out through the production brain client intact", async () => {
    for (const phase of Object.keys(compliance) as CampaignBrainPhase[]) {
      const decision = compliance[phase];
      const reply = compliantAnswers[phase][0]!;
      let sent: unknown;
      const brain = new OpenAICompatibleBrain({
        baseUrl: "http://127.0.0.1:9/v1",
        model: "fixture",
        maxAttempts: 1,
        fetch: async (_input, init) => {
          sent = JSON.parse(String(init?.body));
          return new Response(
            JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      });
      const choice = await brain.decide(decision.request);
      decision.validate(choice);
      assert.deepEqual(choice, reply);
      const messages = (sent as { messages: Array<{ content: string }> }).messages;
      assert.deepEqual(JSON.parse(messages[1]!.content), {
        decisionKey: decision.request.key,
        phase: decision.request.phase,
        goal: decision.request.goal,
        state: decision.request.state,
        legalActions: decision.request.legalActions,
      });
    }
  });

  // Integration retries reopen all of their slices in one save, or none.

  await check("a capped second slice caps the campaign without reopening the first", async () => {
    const { manifest, saves } = await integrationRetry(tmpRoot, "retry-second-capped", {
      maxRounds: 2,
      capped: "02",
    });
    assert.equal(manifest.status, "capped");
    assert.deepEqual(statuses(manifest), ["accepted", "accepted"]);
    assert.equal(manifest.integration.attempts[0]?.retriesScheduled, false);
    assert.match(
      manifest.integration.gaps.at(-1) ?? "",
      /another round for slice 02, but it already reached maxRounds/,
    );
    // One save after the campaign started running, and it is the cap: slice 01
    // was never written down as reopened.
    const started = saves.findIndex((saved) => saved.status === "running");
    assert.ok(started >= 0);
    assert.deepEqual(
      saves.slice(started + 1).map((saved) => saved.status),
      ["capped"],
    );
    assert.equal(
      saves.some((saved) => saved.slices.some((slice) => slice.status === "building")),
      false,
    );
  });

  await check("a multi-slice integration retry reopens every slice in one save", async () => {
    const firstScheduled = (saves: CampaignManifest[]) =>
      saves.find((saved) => saved.integration.attempts[0]?.retriesScheduled === true);
    const reopenedEarly = (saves: CampaignManifest[]) =>
      saves.some(
        (saved) =>
          saved.integration.attempts[0]?.retriesScheduled !== true &&
          saved.slices.some((slice) => slice.status === "building"),
      );

    // The deterministic path points currentSliceId at the last tagged slice.
    const deterministic = await integrationRetry(tmpRoot, "retry-both", { maxRounds: 3 });
    const reopened = firstScheduled(deterministic.saves);
    assert.deepEqual(reopened && statuses(reopened), ["building", "building"]);
    assert.equal(reopened?.currentSliceId, "02");
    assert.equal(reopenedEarly(deterministic.saves), false);

    // The brain path points it at the first slice it chose.
    const brain = new ScriptedBrain((request) => {
      if (request.phase === "integration") {
        return {
          action: "retry_slices",
          rationale: "Both disagree.",
          arguments: { sliceIds: ["01", "02"] },
        };
      }
      return request.phase === "recovery" ? leave : halt("Stop after the reopen.");
    });
    const driven = await integrationRetry(tmpRoot, "retry-both-brain", { maxRounds: 3, brain });
    const chosen = firstScheduled(driven.saves);
    assert.deepEqual(chosen && statuses(chosen), ["building", "building"]);
    assert.equal(chosen?.currentSliceId, "01");
    assert.notEqual(
      chosen?.brain.decisions.find((decision) => decision.phase === "integration")?.appliedAt,
      null,
    );
    assert.equal(reopenedEarly(driven.saves), false);
  });
} finally {
  await rm(tmpRoot, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} decision check(s) failed`);
  process.exit(1);
}
console.log("\nall decision checks passed");
