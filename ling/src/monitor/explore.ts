/**
 * Stage one of browser monitoring: spend model time once to turn a public
 * search page into a constrained, validated recipe that later runs without a
 * model.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { saveRecipe } from "./recipe.js";

const platform = process.argv[2] ?? "mastodon";
const searchUrlTemplate =
  process.argv[3] ?? "https://mastodon.social/tags/{{query}}";
const allowedDomains = (process.argv[4] ?? "mastodon.social")
  .split(",")
  .map((value) => value.trim())
  .filter((value) => value !== "");
const query = process.argv[5] ?? "openai";
const recipeId = process.argv[6] ?? `${platform}-public-search`;

const base = `http://${config.bindAddress === "0.0.0.0" ? "127.0.0.1" : config.bindAddress}:${config.port}`;
const auth = { authorization: `Bearer ${config.token}` };

const prompt = [
  `Create and prove a reusable public browser-monitoring recipe for platform ${platform}.`,
  `Recipe id: ${recipeId}`,
  `Search URL template: ${searchUrlTemplate}`,
  `Allowed domains: ${allowedDomains.join(", ")}`,
  `Proof query: ${query}`,
  "",
  "Use the agent-browser and browsing-rules skills. Do not use an API, http_request, curl,",
  "fetch, the Playwright browser_* tools, a login, cookies, a profile, stealth, or CAPTCHA solving.",
  "Work only from the rendered public page.",
  "",
  "Write recipe.json with exactly this shape:",
  JSON.stringify(
    {
      version: 1,
      id: recipeId,
      platform,
      requiresAuth: false,
      searchUrlTemplate,
      allowedDomains,
      wait: { kind: "load", value: "networkidle" },
      extractor:
        "JavaScript expression returning an array of {sourceId,url,author,text,createdAt}; no fetch or side effects",
      maxItems: 20,
      createdAt: "<current ISO timestamp>",
      agentBrowserVersion: "<the version actually run>",
      sample: [
        {
          sourceId: "<stable native id or canonical permalink>",
          url: "<absolute canonical URL>",
          author: "<visible author or null>",
          text: "<visible post text>",
          createdAt: "<ISO timestamp or null>",
        },
      ],
    },
    null,
    2,
  ),
  "",
  "The searchUrlTemplate in recipe.json must retain the literal {{query}} placeholder.",
  "Test the extractor twice against the rendered page. The second run must return the same stable",
  "ids as the first. Put the first run's real extracted records in sample. If the page is blocked,",
  "requires login, or returns no results, do not create a recipe; write a failure result.json.",
  "If successful, write result.json naming recipe.json, the two item counts, and whether ids matched.",
].join("\n");

const createdResponse = await fetch(`${base}/tasks`, {
  method: "POST",
  headers: { ...auth, "content-type": "application/json" },
  body: JSON.stringify({
    task: prompt,
    tools: ["read", "write", "bash", "agent_browser"],
    thinking: "medium",
    maxTurns: Math.min(30, config.maxTurns),
    maxCostUsd: Math.min(1, config.maxCostUsd),
    maxWallClockMs: Math.min(600_000, config.maxWallClockMs),
    instructions:
      "This is the one-time exploration stage of browser-first monitoring. The requested browser method overrides the general preference for APIs.",
  }),
});
const created = (await createdResponse.json()) as { id?: string; error?: string };
if (createdResponse.status !== 202 || created.id === undefined) {
  throw new Error(`Could not queue exploration: ${created.error ?? createdResponse.status}`);
}

console.log(`exploration task: ${created.id}`);
let record: Record<string, unknown>;
for (;;) {
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const response = await fetch(`${base}/tasks/${created.id}`, { headers: auth });
  record = (await response.json()) as Record<string, unknown>;
  if (record["status"] === "completed" || record["status"] === "failed" || record["status"] === "cancelled") {
    break;
  }
}

if (record["status"] !== "completed" || typeof record["workspaceDir"] !== "string") {
  throw new Error(
    `Exploration failed: ${String(record["error"] ?? record["stoppedBy"] ?? record["status"])}`,
  );
}

const recipeFile = path.join(record["workspaceDir"], "recipe.json");
const recipe = await saveRecipe(JSON.parse(await readFile(recipeFile, "utf8")) as unknown);
console.log(
  JSON.stringify(
    {
      recipe: recipe.id,
      platform: recipe.platform,
      savedTo: path.join(config.recipesDir, `${recipe.id}.json`),
      sampleItems: recipe.sample.length,
      taskStats: record["stats"],
    },
    null,
    2,
  ),
);
