import { readFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import type { MonitorRecipe } from "./recipe.js";
import { saveRecipe, validateRecipe } from "./recipe.js";
import type { MonitorStore } from "./store.js";

export interface RepairResult {
  attempted: boolean;
  taskId?: string;
  repaired: boolean;
  reason: string;
}

function failureReason(health: ReturnType<MonitorStore["getHealth"]>): string | undefined {
  if (health.consecutiveFailures >= 2) {
    return `${health.consecutiveFailures} consecutive failed replays`;
  }
  if (health.consecutiveEmpty >= 3) {
    return `${health.consecutiveEmpty} consecutive empty replays`;
  }
  return undefined;
}

export function recipeRepairReason(
  health: ReturnType<MonitorStore["getHealth"]>,
  now = Date.now(),
): string | undefined {
  const reason = failureReason(health);
  if (reason === undefined) return undefined;
  if (
    health.lastRepairAt !== null &&
    now - Date.parse(health.lastRepairAt) < config.agentBrowserRepairCooldownMs
  ) {
    return undefined;
  }
  return reason;
}

export async function maybeRepairRecipe(options: {
  recipe: MonitorRecipe;
  query: string;
  store: MonitorStore;
}): Promise<RepairResult> {
  const { recipe, query, store } = options;
  const health = store.getHealth(recipe.id);
  const reason = recipeRepairReason(health);
  if (reason === undefined) {
    return {
      attempted: false,
      repaired: false,
      reason: failureReason(health) === undefined ? "recipe is healthy" : "repair cooldown is still active",
    };
  }

  const base = `http://${config.bindAddress === "0.0.0.0" ? "127.0.0.1" : config.bindAddress}:${config.port}`;
  const auth = { authorization: `Bearer ${config.token}` };
  const prompt = [
    `Repair the public browser-monitoring recipe in broken-recipe.json because it had ${reason}.`,
    `Use this proof query: ${query}`,
    "Keep the same recipe id, platform, search URL template, and public/no-auth policy.",
    "Use the agent-browser and browsing-rules skills. Do not use APIs, http_request, curl, fetch,",
    "Playwright browser_* tools, login state, profiles, stealth, or CAPTCHA solving.",
    "Inspect the current rendered page, change only the wait condition, extractor, allowed domains,",
    "or maxItems as needed, and write the corrected full recipe to recipe.json.",
    "Run the corrected extractor twice. The second run must return the same stable ids as the first.",
    "Put real current items into sample. If the site now blocks automation or needs login, write a",
    "failure result.json and do not write recipe.json.",
  ].join("\n");

  const response = await fetch(`${base}/tasks`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({
      task: prompt,
      files: { "broken-recipe.json": `${JSON.stringify(recipe, null, 2)}\n` },
      tools: ["read", "write", "bash", "agent_browser"],
      thinking: "medium",
      maxTurns: Math.min(30, config.maxTurns),
      maxCostUsd: Math.min(1, config.maxCostUsd),
      maxWallClockMs: Math.min(600_000, config.maxWallClockMs),
      instructions:
        "This is a bounded repair of a browser monitoring recipe. The requested browser method overrides the general preference for APIs.",
    }),
  });
  const created = (await response.json()) as { id?: string; error?: string };
  if (response.status !== 202 || created.id === undefined) {
    return {
      attempted: false,
      repaired: false,
      reason: `could not queue repair: ${created.error ?? response.status}`,
    };
  }

  const markedAt = new Date().toISOString();
  store.markRepair(recipe.id, markedAt);
  let record: Record<string, unknown>;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const statusResponse = await fetch(`${base}/tasks/${created.id}`, { headers: auth });
    record = (await statusResponse.json()) as Record<string, unknown>;
    if (
      record["status"] === "completed" ||
      record["status"] === "failed" ||
      record["status"] === "cancelled"
    ) {
      break;
    }
  }

  if (record["status"] !== "completed" || typeof record["workspaceDir"] !== "string") {
    return {
      attempted: true,
      taskId: created.id,
      repaired: false,
      reason: String(record["error"] ?? record["stoppedBy"] ?? record["status"]),
    };
  }

  try {
    const candidate = validateRecipe(
      JSON.parse(await readFile(path.join(record["workspaceDir"], "recipe.json"), "utf8")) as unknown,
    );
    if (candidate.id !== recipe.id) {
      throw new Error(`repair changed recipe id from ${recipe.id} to ${candidate.id}`);
    }
    const repaired = await saveRecipe(candidate);
    return {
      attempted: true,
      taskId: created.id,
      repaired: true,
      reason,
    };
  } catch (error) {
    return {
      attempted: true,
      taskId: created.id,
      repaired: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
