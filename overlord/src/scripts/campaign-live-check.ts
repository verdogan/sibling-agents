import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CampaignArtifactStore } from "../campaign/artifacts.js";
import { CampaignDriver } from "../campaign/driver.js";
import { initializeCampaign } from "../campaign/initialize.js";
import { CampaignManifestStore } from "../campaign/manifest.js";
import type { CampaignRoleProfiles } from "../campaign/schema.js";
import {
  bootstrapLingFleet,
  type LingFleetRuntime,
} from "../ling/bootstrap.js";
import { spawnPolicyFromEnv } from "../policy.js";

function workspacesDir(): string {
  const configured = process.env["LING_WORKSPACES_DIR"]?.trim();
  if (configured) return path.resolve(configured);
  return path.resolve(process.env["LING_DIR"]?.trim() || path.join("..", "ling"), "workspaces");
}

const roles: CampaignRoleProfiles = {
  planner: {
    tools: ["read", "write"],
    maxCostUsd: 0.1,
    maxTurns: 10,
    maxWallClockMs: 180_000,
    thinking: "low",
  },
  builder: {
    tools: ["read", "write", "ls"],
    maxCostUsd: 0.1,
    maxTurns: 10,
    maxWallClockMs: 180_000,
    thinking: "low",
  },
  reviewer: {
    tools: ["read", "ls", "write_result"],
    maxCostUsd: 0.1,
    maxTurns: 10,
    maxWallClockMs: 180_000,
    thinking: "low",
  },
  integration: {
    tools: ["read", "ls", "write_result"],
    maxCostUsd: 0.1,
    maxTurns: 10,
    maxWallClockMs: 180_000,
    thinking: "low",
  },
};

const campaignRoot = await mkdtemp(path.join(os.tmpdir(), "campaign-live-check-"));
const store = new CampaignManifestStore(path.join(campaignRoot, "manifest.json"));
let runtime: LingFleetRuntime | undefined;
let failed = false;

try {
  runtime = await bootstrapLingFleet();
  const artifacts = new CampaignArtifactStore(
    campaignRoot,
    workspacesDir(),
    runtime.client,
  );
  await initializeCampaign(store, artifacts, {
    id: `live-${Date.now()}`,
    goal: "Produce one text file whose content proves the complete campaign loop ran.",
    acceptance: [
      {
        id: "exact-output",
        kind: "file",
        requirement:
          "The delivered artifacts contain exactly one output.txt file, and its UTF-8 content after trimming is exactly campaign-live-ok.",
      },
    ],
    budget: { maxTasks: 3, maxTotalCostUsd: 0.3 },
    maxRounds: 1,
    slices: [
      {
        id: "01",
        spec: [
          "Create one proposed deliverable named output.txt.",
          "Its entire content must be exactly: campaign-live-ok",
          "Do not create or claim any other deliverable.",
        ].join("\n"),
      },
    ],
    roles,
  });

  const manifest = await new CampaignDriver({
    client: runtime.client,
    store,
    artifacts,
    policy: spawnPolicyFromEnv(),
  }).run();

  console.log(
    `${manifest.status}  ${manifest.id}  ${manifest.tasks.length} task(s)  $${manifest.spentUsdSnapshot.toFixed(6)}`,
  );
  for (const record of manifest.tasks) {
    console.log(
      `  ${record.role.padEnd(11)} ${record.id}  ${record.status}  $${record.costUsd.toFixed(6)}`,
    );
  }

  const accepted = manifest.slices[0]?.attempts.at(-1)?.artifacts;
  const output = accepted?.find((ref) => ref.path.endsWith("/output.txt"));
  if (
    manifest.status !== "completed" ||
    manifest.integration.verdict !== "accept" ||
    manifest.tasks.length !== 3 ||
    output === undefined ||
    (await artifacts.readText(output)).trim() !== "campaign-live-ok"
  ) {
    failed = true;
    console.error(
      `Live campaign did not pass: ${manifest.integration.gaps.join("; ") || manifest.slices[0]?.attempts.at(-1)?.gaps.join("; ") || "unknown gap"}`,
    );
  } else {
    console.log("PASS  live builder, reviewer, artifact copy, and integration");
  }
} catch (error) {
  failed = true;
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  await runtime?.stop().catch((error: unknown) => {
    failed = true;
    console.error(`Ling shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  await rm(campaignRoot, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
