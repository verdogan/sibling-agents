import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { recipeRepairReason } from "../monitor/repair.js";
import { loadRecipe, renderSearchUrl, validateRecipe } from "../monitor/recipe.js";
import { replayRecipe } from "../monitor/replay.js";
import { MonitorStore } from "../monitor/store.js";
import type { MonitorRun } from "../monitor/types.js";

let failures = 0;
function report(label: string, passed: boolean, detail = ""): void {
  console.log(`${passed ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!passed) failures += 1;
}

const tempDir = await mkdtemp(path.join(os.tmpdir(), "ling-monitor-check-"));
const store = new MonitorStore(path.join(tempDir, "monitor.db"));
try {
  const recipe = validateRecipe({
    version: 1,
    id: "test-public-search",
    platform: "test",
    requiresAuth: false,
    searchUrlTemplate: "https://example.com/search?q={{query}}",
    allowedDomains: ["example.com"],
    wait: { kind: "load", value: "domcontentloaded" },
    extractor:
      "Array.from(document.querySelectorAll('article')).map(x => ({sourceId:x.id,url:location.href,author:null,text:x.innerText,createdAt:null}))",
    maxItems: 10,
    createdAt: new Date().toISOString(),
    agentBrowserVersion: "0.33.2",
    sample: [
      {
        sourceId: "one",
        url: "https://example.com/one",
        author: null,
        text: "first",
        createdAt: null,
      },
    ],
  });
  report(
    "recipe renders and URL-encodes the query",
    renderSearchUrl(recipe, "two words").includes("q=two%20words"),
  );

  for (const [label, mutation] of [
    ["authenticated recipes", { requiresAuth: true }],
    ["extractors that make network requests", { extractor: "fetch('/api')" }],
    ["search URLs outside the allowlist", { searchUrlTemplate: "https://evil.example/{{query}}" }],
  ] as Array<[string, Record<string, unknown>]>) {
    let refused = false;
    try {
      const candidate = validateRecipe({ ...recipe, ...mutation });
      if (label.includes("outside")) renderSearchUrl(candidate, "test");
    } catch {
      refused = true;
    }
    report(`recipe validation rejects ${label}`, refused);
  }

  const capturedAt = new Date().toISOString();
  const items = [
    {
      platform: "test",
      sourceId: "one",
      url: "https://example.com/one",
      author: "A",
      text: "first",
      createdAt: null,
      query: "topic",
    },
    {
      platform: "test",
      sourceId: "two",
      url: "https://example.com/two",
      author: "B",
      text: "second",
      createdAt: null,
      query: "topic",
    },
  ];
  report("first insert stores both items", store.insertItems(recipe.id, items, capturedAt) === 2);
  report("second insert stores no duplicates", store.insertItems(recipe.id, items, capturedAt) === 0);
  report("feed query returns the two stored items", store.listItems({ platform: "test" }).length === 2);

  const makeRun = (status: MonitorRun["status"]): MonitorRun => ({
    id: randomUUID(),
    recipeId: recipe.id,
    query: "topic",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    status,
    seenCount: status === "success" ? 2 : 0,
    insertedCount: 0,
    error: status === "failed" ? "test failure" : null,
    browserElapsedMs: 10,
    agentUsed: false,
    agentCostUsd: 0,
  });
  store.recordRun(makeRun("success"));
  store.recordRun(makeRun("empty"));
  store.recordRun(makeRun("empty"));
  store.recordRun(makeRun("empty"));
  const health = store.getHealth(recipe.id);
  report(
    "three empty runs are retained for repair decisions",
    health.consecutiveEmpty === 3 && health.consecutiveFailures === 0,
    JSON.stringify(health),
  );
  report(
    "three empty runs trigger one repair attempt",
    recipeRepairReason(health) === "3 consecutive empty replays",
  );
  const repairAt = new Date().toISOString();
  store.markRepair(recipe.id, repairAt);
  report("repair timestamp is persisted", store.getHealth(recipe.id).lastRepairAt === repairAt);
  report(
    "repair cooldown suppresses another paid attempt",
    recipeRepairReason(store.getHealth(recipe.id)) === undefined,
  );

  if (process.argv.includes("--live")) {
    const live = await replayRecipe({
      recipe: await loadRecipe("mastodon-public-hashtag"),
      query: "openai",
      store,
    });
    report(
      "live replay returns items without using the model",
      live.status === "success" && live.seenCount > 0 && !live.agentUsed && live.agentCostUsd === 0,
      JSON.stringify(live),
    );
  }

  if (process.argv.includes("--api")) {
    const base = `http://${config.bindAddress === "0.0.0.0" ? "127.0.0.1" : config.bindAddress}:${config.port}`;
    const noAuth = await fetch(`${base}/monitor/items?limit=1`);
    report("monitor feed requires the bearer token", noAuth.status === 401, `status ${noAuth.status}`);
    const response = await fetch(`${base}/monitor/items?limit=1`, {
      headers: { authorization: `Bearer ${config.token}` },
    });
    const body = (await response.json()) as { items?: unknown[] };
    report(
      "monitor feed endpoint returns JSON",
      response.status === 200 && Array.isArray(body.items),
      `status ${response.status}`,
    );
    const jsonl = await fetch(`${base}/monitor/items.jsonl?limit=1`, {
      headers: { authorization: `Bearer ${config.token}` },
    });
    const jsonlBody = await jsonl.text();
    report(
      "monitor feed offers JSONL for streaming consumers",
      jsonl.status === 200 &&
        jsonl.headers.get("content-type")?.startsWith("application/x-ndjson") === true &&
        (jsonlBody.trim() === "" || JSON.parse(jsonlBody.trim()) !== undefined),
      `status ${jsonl.status}`,
    );
  }
} finally {
  store.close();
  await rm(tempDir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nall monitor checks passed" : `\n${failures} monitor check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
