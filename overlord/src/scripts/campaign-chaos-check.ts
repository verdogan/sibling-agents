import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CampaignArtifactStore } from "../campaign/artifacts.js";
import { initializeCampaign } from "../campaign/initialize.js";
import { CampaignManifestStore } from "../campaign/manifest.js";
import type { CampaignRoleProfiles } from "../campaign/schema.js";
import {
  bootstrapLingFleet,
  type LingFleetRuntime,
} from "../ling/bootstrap.js";

if (process.env["LIVE_CHAOS_ALLOW_KILL"] !== "true") {
  throw new Error(
    "Set LIVE_CHAOS_ALLOW_KILL=true to acknowledge that this check kills a local Ling and overlord process.",
  );
}

const tsxCli = fileURLToPath(
  new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url),
);
const campaignCli = fileURLToPath(new URL("./campaign.ts", import.meta.url));
const root = await mkdtemp(path.join(os.tmpdir(), "campaign-chaos-check-"));
const fleetLedger = path.join(root, "fleet-ledger.db");
let runtime: LingFleetRuntime | undefined;

const roles: CampaignRoleProfiles = {
  planner: {
    tools: ["read", "write"],
    maxCostUsd: 0.05,
    maxTurns: 8,
    maxWallClockMs: 120_000,
    thinking: "low",
  },
  builder: {
    tools: ["read", "write", "bash"],
    maxCostUsd: 0.05,
    maxTurns: 8,
    maxWallClockMs: 120_000,
    thinking: "low",
  },
  reviewer: {
    tools: ["read", "ls", "write_result"],
    maxCostUsd: 0.05,
    maxTurns: 8,
    maxWallClockMs: 120_000,
    thinking: "low",
  },
  integration: {
    tools: ["read", "ls", "write_result"],
    maxCostUsd: 0.05,
    maxTurns: 8,
    maxWallClockMs: 120_000,
    thinking: "low",
  },
};

function childEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LING_AUTO_START: "false",
    LING_REQUEST_TIMEOUT_MS: "1000",
    FLEET_LEDGER_PATH: fleetLedger,
    FLEET_ALLOWED_TOOLS:
      "read,write,edit,ls,grep,find,bash,http_request,write_result",
    FLEET_MAX_TOTAL_COST_USD: "2",
  };
}

function startCampaign(manifestPath: string, resume: boolean) {
  const args = [tsxCli, campaignCli, "run", manifestPath, ...(resume ? ["--resume"] : [])];
  const child = spawn(process.execPath, args, {
    cwd: path.resolve(fileURLToPath(new URL("../../..", import.meta.url))),
    env: childEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  return { child, output: () => output };
}

async function waitForExit(
  running: ReturnType<typeof startCampaign>,
  timeoutMs = 240_000,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      running.child.kill("SIGKILL");
      reject(new Error(`Campaign child timed out:\n${running.output()}`));
    }, timeoutMs);
    running.child.once("error", reject);
    running.child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function waitForRunningTask(campaignId: string): Promise<void> {
  const prefix = `campaign:${Buffer.from(campaignId).toString("base64url")}:`;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const tasks = await runtime!.client.list();
    if (
      tasks.some(
        (task) =>
          task.requestKey?.startsWith(prefix) === true &&
          (task.status === "queued" || task.status === "running"),
      )
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`No active task appeared for ${campaignId}.`);
}

async function initialize(name: string): Promise<string> {
  const directory = path.join(root, name);
  const manifestPath = path.join(directory, "manifest.json");
  await initializeCampaign(
    new CampaignManifestStore(manifestPath),
    new CampaignArtifactStore(directory, ""),
    {
      id: name,
      goal: "Produce output.txt containing exactly chaos-live-ok.",
      acceptance: [
        {
          id: "output",
          kind: "file",
          requirement: "output.txt contains exactly chaos-live-ok after trimming.",
        },
      ],
      slices: [
        {
          id: "01",
          spec: [
            "Before writing output, use bash to run: node -e \"setTimeout(()=>{},10000)\"",
            "Then write output.txt containing exactly chaos-live-ok and claim only that file.",
          ].join("\n"),
        },
      ],
      budget: { maxTasks: 5, maxTotalCostUsd: 0.25 },
      maxRounds: 2,
      roles,
    },
  );
  return manifestPath;
}

try {
  runtime = await bootstrapLingFleet();
  if (!runtime.startedByOverlord || runtime.pid === undefined) {
    throw new Error(
      "Chaos check requires an auto-started single local Ling; refusing to kill an external worker.",
    );
  }

  const suffix = `${Date.now()}-${process.pid}`;
  const overlordId = `chaos-overlord-${suffix}`;
  const overlordManifest = await initialize(overlordId);
  const overlordRun = startCampaign(overlordManifest, false);
  await waitForRunningTask(overlordId);
  overlordRun.child.kill("SIGKILL");
  await waitForExit(overlordRun, 30_000);
  const overlordResume = startCampaign(overlordManifest, true);
  const overlordCode = await waitForExit(overlordResume);
  const overlordResult = await new CampaignManifestStore(overlordManifest).load();
  if (overlordCode !== 0 || overlordResult.status !== "completed") {
    throw new Error(`Overlord recovery failed:\n${overlordResume.output()}`);
  }
  console.log(
    `PASS  killed overlord resumes  $${overlordResult.spentUsdSnapshot.toFixed(6)}`,
  );

  const lingId = `chaos-ling-${suffix}`;
  const lingManifest = await initialize(lingId);
  const lingRun = startCampaign(lingManifest, false);
  await waitForRunningTask(lingId);
  process.kill(runtime.pid, "SIGKILL");
  await waitForExit(lingRun, 30_000);
  await runtime.stop().catch(() => undefined);
  runtime = await bootstrapLingFleet();
  // A durable interrupted task can be reconciled while the campaign is still
  // running, so this stronger restart check does not require --resume.
  const lingResume = startCampaign(lingManifest, false);
  const lingCode = await waitForExit(lingResume);
  const lingResult = await new CampaignManifestStore(lingManifest).load();
  if (lingCode !== 0 || lingResult.status !== "completed") {
    throw new Error(`Ling recovery failed:\n${lingResume.output()}`);
  }
  console.log(
    `PASS  killed Ling restarts without --resume  $${lingResult.spentUsdSnapshot.toFixed(6)}`,
  );
} finally {
  await runtime?.stop().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
