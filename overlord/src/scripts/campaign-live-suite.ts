import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CampaignArtifactStore } from "../campaign/artifacts.js";
import {
  CampaignDriver,
  type CampaignLingClient,
} from "../campaign/driver.js";
import {
  initializeCampaign,
  type CampaignDefinition,
} from "../campaign/initialize.js";
import { CampaignManifestStore } from "../campaign/manifest.js";
import type { CampaignManifest, CampaignRoleProfiles } from "../campaign/schema.js";
import {
  bootstrapLingFleet,
  type LingFleetRuntime,
} from "../ling/bootstrap.js";
import type { LingTask, SpawnInput, SpawnResponse } from "../ling/types.js";
import {
  DEFAULT_ALLOWED_TOOLS,
  DEFAULT_SPAWN_POLICY,
  type SpawnPolicy,
} from "../policy.js";

const roles: CampaignRoleProfiles = {
  planner: {
    tools: ["read", "write"],
    maxCostUsd: 0.08,
    maxTurns: 10,
    maxWallClockMs: 180_000,
    thinking: "low",
  },
  builder: {
    tools: ["read", "write", "edit", "ls"],
    maxCostUsd: 0.08,
    maxTurns: 10,
    maxWallClockMs: 180_000,
    thinking: "low",
  },
  reviewer: {
    tools: ["read", "ls", "write_result"],
    maxCostUsd: 0.08,
    maxTurns: 10,
    maxWallClockMs: 180_000,
    thinking: "low",
  },
  integration: {
    tools: ["read", "ls", "write_result"],
    maxCostUsd: 0.08,
    maxTurns: 10,
    maxWallClockMs: 180_000,
    thinking: "low",
  },
};

const policy: SpawnPolicy = {
  ...DEFAULT_SPAWN_POLICY,
  allowedTools: DEFAULT_ALLOWED_TOOLS,
  maxCostUsdPerTask: 0.08,
  maxTurnsPerTask: 10,
  maxWallClockMsPerTask: 180_000,
  maxTasksPerRun: 8,
  maxConcurrentTasks: 2,
  maxTotalCostUsd: 2,
};

interface Scenario {
  name: string;
  definition: CampaignDefinition;
  client?: (base: CampaignLingClient) => CampaignLingClient;
  verify(manifest: CampaignManifest): boolean;
}

class MalformedResultClient implements CampaignLingClient {
  constructor(private readonly base: CampaignLingClient) {}

  spawn(input: SpawnInput, preferredWorkerId?: string): Promise<SpawnResponse> {
    return this.base.spawn(input, preferredWorkerId);
  }

  async get(id: string, workerId?: string): Promise<LingTask> {
    return this.corrupt(await this.base.get(id, workerId));
  }

  async list(): Promise<LingTask[]> {
    return Promise.all((await this.base.list()).map(async (task) => this.corrupt(task)));
  }

  cancel(id: string, workerId?: string): Promise<void> {
    return this.base.cancel(id, workerId);
  }

  private corrupt(task: LingTask): LingTask {
    return task.status === "completed" && task.requestKey?.includes(":builder:") === true
      ? { ...task, result: { malformed: true } }
      : task;
  }
}

class ForcedRevisionClient implements CampaignLingClient {
  constructor(private readonly base: CampaignLingClient) {}

  spawn(input: SpawnInput, preferredWorkerId?: string): Promise<SpawnResponse> {
    return this.base.spawn(input, preferredWorkerId);
  }

  async get(id: string, workerId?: string): Promise<LingTask> {
    return this.reviseFirstReview(await this.base.get(id, workerId));
  }

  async list(): Promise<LingTask[]> {
    return (await this.base.list()).map((task) => this.reviseFirstReview(task));
  }

  cancel(id: string, workerId?: string): Promise<void> {
    return this.base.cancel(id, workerId);
  }

  private reviseFirstReview(task: LingTask): LingTask {
    if (
      task.status !== "completed" ||
      !/:reviewer:[^:]+:1$/.test(task.requestKey ?? "")
    ) {
      return task;
    }
    return {
      ...task,
      result: {
        status: "partial",
        summary: "Injected deterministic first-round revision.",
        data: {
          kind: "review",
          verdict: "revise",
          checks: [
            {
              criterion: "output",
              passed: false,
              evidence: "Live harness requires one revision round.",
            },
          ],
          evidence: ["The real reviewer completed before fault injection."],
          gaps: ["Rewrite output.txt to exactly revised-live-ok."],
          barFetch: null,
        },
        steps: ["Completed a live review, then injected a deterministic revise verdict."],
      },
    };
  }
}

const unique = `${Date.now()}-${process.pid}`;
/**
 * Roles with extra tools for scenarios whose acceptance shape demands them.
 *
 * `requiredTools()` adds `http_request` when the campaign carries a URL bar and `bash`
 * when any criterion is `kind: "command"`, and the driver blocks a profile that lacks
 * them. Both scenarios below therefore blocked before reaching the behaviour they were
 * paying to exercise — and the workflow ran them on every labelled pull request.
 */
function rolesWith(extra: readonly string[]): CampaignRoleProfiles {
  const widen = (profile: CampaignRoleProfiles["reviewer"]) => ({
    ...profile,
    tools: [...new Set([...profile.tools, ...extra])],
  });
  return {
    planner: roles.planner,
    builder: widen(roles.builder),
    reviewer: widen(roles.reviewer),
    integration: widen(roles.integration),
  };
}

const referenceUrl =
  process.env["LIVE_REFERENCE_BAR_URL"]?.trim() || "https://example.com/";
const scenarios: Scenario[] = [
  {
    name: "planning",
    definition: {
      id: `live-planning-${unique}`,
      goal: "Plan one slice that creates output.txt containing exactly planned-live-ok.",
      acceptance: [
        {
          id: "output",
          kind: "file",
          requirement: "output.txt contains exactly planned-live-ok after trimming.",
        },
      ],
      allowPlanning: true,
      budget: { maxTasks: 4, maxTotalCostUsd: 0.32 },
      maxRounds: 1,
      roles,
    },
    verify: (manifest) =>
      manifest.status === "completed" && manifest.planning.status === "completed",
  },
  {
    name: "revision",
    definition: {
      id: `live-revision-${unique}`,
      goal: "Produce output.txt containing exactly revised-live-ok.",
      acceptance: [
        {
          id: "output",
          kind: "file",
          requirement: "output.txt contains exactly revised-live-ok after trimming.",
        },
      ],
      slices: [
        {
          id: "01",
          spec:
            "Write output.txt containing exactly revised-live-ok and claim only output.txt.",
        },
      ],
      budget: { maxTasks: 5, maxTotalCostUsd: 0.4 },
      maxRounds: 2,
      roles,
    },
    client: (base) => new ForcedRevisionClient(base),
    verify: (manifest) =>
      manifest.status === "completed" && (manifest.slices[0]?.attempts.length ?? 0) === 2,
  },
  {
    name: "reference-bar",
    definition: {
      id: `live-reference-${unique}`,
      goal: "Create output.txt that demonstrates the public reference URL was understood.",
      acceptance: [
        {
          id: "reference",
          kind: "file",
          requirement:
            "output.txt contains the text Example Domain and explains it is an example/documentation domain.",
        },
      ],
      bar: { kind: "url", ref: referenceUrl, appliesTo: ["reference"] },
      slices: [
        {
          id: "01",
          spec: "Write output.txt containing: Example Domain is reserved for documentation examples.",
        },
      ],
      budget: { maxTasks: 3, maxTotalCostUsd: 0.24 },
      maxRounds: 1,
      roles: rolesWith(["http_request"]),
    },
    verify: (manifest) => manifest.status === "completed",
  },
  {
    name: "command-check",
    definition: {
      id: `live-command-${unique}`,
      goal: "Produce an executable Node check.",
      acceptance: [
        {
          id: "command",
          kind: "command",
          requirement:
            "From the proposal directory, `node artifacts/check.mjs` exits 0 and prints exactly command-live-ok.",
        },
      ],
      slices: [
        {
          id: "01",
          spec:
            "Write artifacts/check.mjs containing only console.log('command-live-ok'); and claim exactly artifacts/check.mjs.",
        },
      ],
      budget: { maxTasks: 3, maxTotalCostUsd: 0.24 },
      maxRounds: 1,
      roles: rolesWith(["bash"]),
    },
    verify: (manifest) => manifest.status === "completed",
  },
  {
    name: "budget-exhaustion",
    definition: {
      id: `live-budget-${unique}`,
      goal: "Do not spawn because the budget is below one task reservation.",
      acceptance: [{ id: "output", kind: "file", requirement: "output.txt exists." }],
      slices: [{ id: "01", spec: "Write output.txt." }],
      budget: { maxTasks: 3, maxTotalCostUsd: 0.01 },
      maxRounds: 1,
      roles,
    },
    verify: (manifest) =>
      manifest.status === "budget_exhausted" && manifest.tasks.length === 0,
  },
  {
    name: "malformed-worker-result",
    definition: {
      id: `live-malformed-${unique}`,
      goal: "Exercise rejection of a malformed live worker result.",
      acceptance: [{ id: "output", kind: "file", requirement: "output.txt exists." }],
      slices: [{ id: "01", spec: "Write output.txt containing malformed-live." }],
      budget: { maxTasks: 3, maxTotalCostUsd: 0.24 },
      maxRounds: 1,
      roles,
    },
    client: (base) => new MalformedResultClient(base),
    verify: (manifest) =>
      (manifest.status === "capped" || manifest.status === "blocked") &&
      (manifest.slices[0]?.attempts[0]?.gaps[0]?.includes("result rejected") ?? false),
  },
];
const requestedScenarios = new Set(
  (process.env["LIVE_SCENARIOS"] ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== ""),
);
const selectedScenarios =
  requestedScenarios.size === 0
    ? scenarios
    : scenarios.filter((scenario) => requestedScenarios.has(scenario.name));
if (
  requestedScenarios.size > 0 &&
  selectedScenarios.length !== requestedScenarios.size
) {
  const known = new Set(scenarios.map((scenario) => scenario.name));
  const unknown = [...requestedScenarios].filter((name) => !known.has(name));
  throw new Error(`Unknown LIVE_SCENARIOS: ${unknown.join(", ")}.`);
}

const configuredCap = Number.parseFloat(process.env["LIVE_SUITE_MAX_USD"] ?? "2");
const declaredCap = selectedScenarios.reduce(
  (total, scenario) => total + scenario.definition.budget.maxTotalCostUsd,
  0,
);
if (!Number.isFinite(configuredCap) || configuredCap <= 0 || declaredCap > configuredCap) {
  throw new Error(
    `Live scenarios declare $${declaredCap.toFixed(2)}, above LIVE_SUITE_MAX_USD=${configuredCap}.`,
  );
}

const root = await mkdtemp(path.join(os.tmpdir(), "campaign-live-suite-"));
let runtime: LingFleetRuntime | undefined;
let failures = 0;
let totalCost = 0;
const measured: Array<{ scenario: string; status: string; tasks: number; costUsd: number }> = [];

try {
  runtime = await bootstrapLingFleet();
  if (process.env["LIVE_REQUIRE_MULTI_HOST"] === "true") {
    const hosts = runtime.workers.map((worker) => new URL(worker.baseUrl).hostname);
    if (
      runtime.workers.length < 2 ||
      hosts.some((host) => ["127.0.0.1", "::1", "localhost"].includes(host))
    ) {
      throw new Error(
        "LIVE_REQUIRE_MULTI_HOST=true requires at least two non-loopback Ling workers.",
      );
    }
  }
  for (const scenario of selectedScenarios) {
    const directory = path.join(root, scenario.name);
    const store = new CampaignManifestStore(path.join(directory, "manifest.json"));
    const artifacts = new CampaignArtifactStore(directory, "", runtime.client);
    await initializeCampaign(store, artifacts, scenario.definition);
    const client = scenario.client?.(runtime.client) ?? runtime.client;
    const manifest = await new CampaignDriver({
      client,
      store,
      artifacts,
      policy,
      pollIntervalMs: 250,
    }).run();
    const cost = manifest.tasks.reduce((sum, task) => sum + task.costUsd, 0);
    totalCost += cost;
    measured.push({
      scenario: scenario.name,
      status: manifest.status,
      tasks: manifest.tasks.length,
      costUsd: cost,
    });
    const passed = scenario.verify(manifest);
    console.log(
      `${passed ? "PASS" : "FAIL"}  ${scenario.name}  ${manifest.status}  ${manifest.tasks.length} task(s)  $${cost.toFixed(6)}`,
    );
    if (!passed) {
      failures += 1;
      const gaps = [
        ...manifest.planning.gaps,
        ...manifest.slices.flatMap((slice) =>
          slice.attempts.flatMap((attempt) => attempt.gaps),
        ),
        ...manifest.integration.gaps,
      ];
      console.error(`  gaps: ${gaps.join(" | ") || "(none)"}`);
    }
    if (totalCost > configuredCap) {
      throw new Error(`Live suite exceeded its $${configuredCap.toFixed(2)} cost cap.`);
    }
  }
} finally {
  await runtime?.stop();
  await rm(root, { recursive: true, force: true });
}

console.log(JSON.stringify({ totalCostUsd: totalCost, scenarios: measured }, null, 2));
process.exit(failures === 0 ? 0 : 1);
