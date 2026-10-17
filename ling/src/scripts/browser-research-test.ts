/**
 * Live capability probe for browser-first research. It intentionally forbids
 * HTTP APIs and the older Playwright tools so the run proves the installed
 * agent-browser CLI and repository-local skill are doing the work.
 */
import { randomBytes } from "node:crypto";
import { config } from "../config.js";

const base = `http://${config.bindAddress === "0.0.0.0" ? "127.0.0.1" : config.bindAddress}:${config.port}`;
const headers = {
  authorization: `Bearer ${config.token}`,
  "content-type": "application/json",
};
const marker = `browser-${randomBytes(6).toString("hex")}`;
const requestedTarget = process.argv[2];
const target =
  requestedTarget === "hn" || requestedTarget === "reddit" || requestedTarget === "mastodon"
    ? requestedTarget
    : "reddit";
const keywordArgs =
  requestedTarget === "hn" || requestedTarget === "reddit" || requestedTarget === "mastodon"
    ? process.argv.slice(3)
    : process.argv.slice(2);
const keyword = keywordArgs.join(" ").trim() || "open source AI agents";
const destination =
  target === "hn"
    ? [
        "Research public Hacker News stories in a real browser using the installed agent-browser CLI.",
        "Use the public Algolia-powered Hacker News search page at hn.algolia.com, sorted newest first.",
      ]
    : target === "mastodon"
      ? [
          "Research public Mastodon posts in a real browser using the installed agent-browser CLI.",
          "Use mastodon.social's public hashtag page. Treat the keyword as a hashtag without spaces.",
        ]
      : [
        "Research public Reddit posts in a real browser using the installed agent-browser CLI.",
        "Use Reddit's public search page, sorted newest first.",
      ];

const task = [
  ...destination,
  `Search for this exact phrase and sort newest first: ${keyword}`,
  "Do not use http_request, curl, fetch, platform APIs, or the browser_* Playwright tools.",
  "Do not log in, create an account, import cookies, attach to a profile, or try to evade a block.",
  "Collect up to 10 visible recent results. For each return sourceId or permalink, title/text,",
  "author if visible, canonical URL, and time if visible.",
  "Use the agent-browser and browsing-rules skills. Apply the required domain restriction,",
  "content boundaries, output cap, and JSON output. Verify that the result URLs are real.",
  `Include this marker in result.json: ${marker}`,
  "If the site blocks public browser access, report the exact page title, URL, and visible block",
  "message instead of claiming success.",
].join("\n");

const started = Date.now();
const response = await fetch(`${base}/tasks`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    task,
    tools: ["read", "write", "bash", "agent_browser"],
    thinking: "medium",
    maxTurns: Math.min(20, config.maxTurns),
    maxCostUsd: Math.min(1, config.maxCostUsd),
    maxWallClockMs: Math.min(600_000, config.maxWallClockMs),
    instructions:
      "This is a browser-first research measurement. Follow the task's requested browser method even though the general prompt normally prefers APIs.",
  }),
});

const created = (await response.json()) as { id?: string; error?: string };
if (response.status !== 202 || created.id === undefined) {
  throw new Error(`Could not queue browser test (${response.status}): ${created.error ?? "unknown error"}`);
}

console.log(`task:    ${created.id}`);
console.log(`target:  ${target}`);
console.log(`keyword: ${keyword}`);
console.log(`marker:  ${marker}`);

const stream = await fetch(`${base}/tasks/${created.id}/events`, {
  headers: { authorization: headers.authorization },
});
const reader = stream.body?.getReader();
const decoder = new TextDecoder();
let buffer = "";
while (reader) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const event = JSON.parse(line.slice(6)) as { type: string; data?: unknown };
    if (event.type === "tool_start" || event.type === "assistant_text" || event.type === "budget_stop") {
      const detail = JSON.stringify(event.data ?? {});
      console.log(`[${event.type}] ${detail.length > 500 ? `${detail.slice(0, 500)}...` : detail}`);
    }
  }
}

const finalResponse = await fetch(`${base}/tasks/${created.id}`, {
  headers: { authorization: headers.authorization },
});
const record = (await finalResponse.json()) as Record<string, unknown>;
console.log(
  JSON.stringify(
    {
      elapsedSeconds: Math.round((Date.now() - started) / 100) / 10,
      status: record.status,
      stoppedBy: record.stoppedBy,
      stats: record.stats,
      result: record.result,
    },
    null,
    2,
  ),
);

process.exit(record.status === "completed" ? 0 : 1);
