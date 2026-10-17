/**
 * Stage two of browser monitoring: replay a proven recipe without a model.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  agentBrowserSessionName,
  closeAgentBrowserSession,
  runAgentBrowser,
} from "../agent-browser.js";
import { config } from "../config.js";
import { loadRecipe, renderSearchUrl, validateExtractedItems, type MonitorRecipe } from "./recipe.js";
import { maybeRepairRecipe, type RepairResult } from "./repair.js";
import { MonitorStore } from "./store.js";
import type { MonitorRun } from "./types.js";

interface MonitorConfig {
  watches: Array<{ recipe: string; query: string }>;
}

function waitCommand(recipe: MonitorRecipe): string[] {
  switch (recipe.wait.kind) {
    case "load":
      return ["wait", "--load", recipe.wait.value];
    case "text":
      return ["wait", "--text", recipe.wait.value];
    case "selector":
      return ["wait", recipe.wait.value];
    case "milliseconds":
      return ["wait", String(recipe.wait.value)];
  }
}

function parseBatchExtraction(stdout: string): unknown {
  const batch = JSON.parse(stdout) as Array<{
    command?: string[];
    success?: boolean;
    error?: unknown;
    result?: { result?: unknown };
  }>;
  if (!Array.isArray(batch)) throw new Error("agent-browser batch output was not an array");
  const failed = batch.find((entry) => entry.success === false);
  if (failed) throw new Error(`agent-browser batch step failed: ${JSON.stringify(failed.error)}`);
  const evaluated = batch.find((entry) => entry.command?.[0] === "eval");
  if (!evaluated) throw new Error("agent-browser batch did not return an eval step");
  let value = evaluated.result?.result;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      // An extractor is allowed to return a primitive string only so the shape
      // validator can produce the clearer "must return an array" error.
    }
  }
  return value;
}

export async function replayRecipe(options: {
  recipe: MonitorRecipe;
  query: string;
  store: MonitorStore;
  signal?: AbortSignal;
}): Promise<MonitorRun> {
  const { recipe, query, store } = options;
  const runId = randomUUID();
  const session = agentBrowserSessionName(config, `replay-${runId}`);
  const startedAt = new Date().toISOString();
  const searchUrl = renderSearchUrl(recipe, query);
  let seenCount = 0;
  let insertedCount = 0;
  let browserElapsedMs = 0;
  let error: string | null = null;
  let status: MonitorRun["status"] = "failed";

  const commands = [
    ["open", searchUrl],
    waitCommand(recipe),
    ["eval", "-b", Buffer.from(recipe.extractor, "utf8").toString("base64")],
    ["close"],
  ];

  try {
    const browser = await runAgentBrowser(
      config,
      [
        "--session",
        session,
        "--allowed-domains",
        recipe.allowedDomains.join(","),
        "--content-boundaries",
        "--max-output",
        String(config.agentBrowserMaxOutput),
        "batch",
        "--bail",
        "--json",
      ],
      {
        session,
        cwd: config.rootDir,
        input: JSON.stringify(commands),
        timeoutMs: Math.min(config.maxWallClockMs, 180_000),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    browserElapsedMs = browser.elapsedMs;
    const items = validateExtractedItems(parseBatchExtraction(browser.stdout), recipe, query);
    seenCount = items.length;
    insertedCount = store.insertItems(recipe.id, items, new Date().toISOString());
    status = seenCount === 0 ? "empty" : "success";
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    await closeAgentBrowserSession(config, session);
  }

  const run: MonitorRun = {
    id: runId,
    recipeId: recipe.id,
    query,
    startedAt,
    finishedAt: new Date().toISOString(),
    status,
    seenCount,
    insertedCount,
    error,
    browserElapsedMs,
    agentUsed: false,
    agentCostUsd: 0,
  };
  store.recordRun(run);
  return run;
}

async function readMonitorConfig(): Promise<MonitorConfig> {
  const raw = JSON.parse(await readFile(path.join(config.rootDir, "monitor.config.json"), "utf8")) as unknown;
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as MonitorConfig).watches)) {
    throw new Error("monitor.config.json must contain a watches array");
  }
  const watches = (raw as MonitorConfig).watches;
  for (const [index, watch] of watches.entries()) {
    if (
      typeof watch !== "object" ||
      watch === null ||
      typeof watch.recipe !== "string" ||
      watch.recipe.trim() === "" ||
      typeof watch.query !== "string" ||
      watch.query.trim() === ""
    ) {
      throw new Error(`monitor.config.json watches[${index}] needs recipe and query strings`);
    }
  }
  return { watches };
}

async function main(): Promise<void> {
  const store = new MonitorStore();
  try {
    const recipeArg = process.argv[2];
    const queryArg = process.argv[3];
    const watches =
      recipeArg !== undefined
        ? [{ recipe: recipeArg, query: queryArg ?? "openai" }]
        : (await readMonitorConfig()).watches;

    const results: MonitorRun[] = [];
    const repairs: RepairResult[] = [];
    for (const watch of watches) {
      const recipe = await loadRecipe(watch.recipe);
      results.push(
        await replayRecipe({
          recipe,
          query: watch.query,
          store,
        }),
      );
      repairs.push(await maybeRepairRecipe({ recipe, query: watch.query, store }));
    }
    console.log(JSON.stringify({ runs: results, repairs }, null, 2));
    if (results.some((run) => run.status === "failed" || run.status === "blocked")) {
      process.exitCode = 1;
    }
  } finally {
    store.close();
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && path.resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  await main();
}
