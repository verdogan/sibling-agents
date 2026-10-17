/**
 * Open-ended capability evaluation with a hidden scorecard. The agent sees the
 * research goal and output contract, but not how planning, adaptation,
 * evidence, verification, reuse, time, and cost will be scored.
 */
import { randomBytes } from "node:crypto";
import { readdir } from "node:fs/promises";
import { config } from "../config.js";

interface Evidence {
  platform?: unknown;
  author?: unknown;
  text?: unknown;
  createdAt?: unknown;
  url?: unknown;
  canonicalUrl?: unknown;
  "canonical url"?: unknown;
}

interface ScoreLine {
  criterion: string;
  earned: number;
  possible: number;
  detail: string;
}

const base = `http://${config.bindAddress === "0.0.0.0" ? "127.0.0.1" : config.bindAddress}:${config.port}`;
const auth = { authorization: `Bearer ${config.token}` };
const marker = `agentic-${randomBytes(6).toString("hex")}`;

const task = [
  "Investigate whether reports of an OpenAI agent hacking Hugging Face are receiving genuine",
  "attention across the public social web right now.",
  "",
  "Use a real browser as your primary research method. Work independently, choose useful sources,",
  "and adapt if a site or route blocks you. Other available tools may support the investigation.",
  "Do not ask questions. Leave any reusable research or extraction code you create in ./scripts.",
  "",
  "Build an evidence pack another person can verify. In result.json, put an array at",
  "data.evidence. Each record must contain platform, author, text, createdAt, and the canonical",
  "URL under the exact JSON key url.",
  "Also include data.conclusion, data.limitations, and data.blockedAttempts. Separate social posts",
  "from news articles: articles can support context but do not count as social evidence.",
  `Include this exact marker in data.marker: ${marker}`,
].join("\n");

const started = Date.now();
const createdResponse = await fetch(`${base}/tasks`, {
  method: "POST",
  headers: { ...auth, "content-type": "application/json" },
  body: JSON.stringify({
    task,
    tools: ["read", "write", "bash", "http_request", "agent_browser"],
    thinking: "medium",
    maxTurns: Math.min(35, config.maxTurns),
    maxCostUsd: Math.min(1, config.maxCostUsd),
    maxWallClockMs: Math.min(600_000, config.maxWallClockMs),
    instructions:
      "This is an open-ended agentic evaluation. Pursue the goal rather than following a predetermined route. Public alternatives are allowed when a site blocks one route; do not bypass a CAPTCHA or use login credentials.",
  }),
});
const created = (await createdResponse.json()) as { id?: string; error?: string };
if (createdResponse.status !== 202 || created.id === undefined) {
  throw new Error(`Could not queue test: ${created.error ?? createdResponse.status}`);
}

console.log(`task:   ${created.id}`);
console.log(`marker: ${marker}`);

const toolCommands: string[] = [];
const toolsUsed = new Set<string>();
const eventTypes: string[] = [];
const stream = await fetch(`${base}/tasks/${created.id}/events`, { headers: auth });
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
    const event = JSON.parse(line.slice(6)) as {
      type: string;
      data?: {
        tool?: unknown;
        args?: { command?: unknown; args?: unknown; url?: unknown };
        text?: unknown;
      };
    };
    eventTypes.push(event.type);
    if (event.type === "tool_start" && typeof event.data?.tool === "string") {
      toolsUsed.add(event.data.tool);
      // Every invocation is flattened to one string so the host and keyword
      // checks below do not care which tool produced it.
      const args = event.data.args;
      if (typeof args?.command === "string") {
        toolCommands.push(args.command);
      } else if (Array.isArray(args?.args)) {
        toolCommands.push(args.args.filter((part) => typeof part === "string").join(" "));
      } else if (typeof args?.url === "string") {
        toolCommands.push(args.url);
      }
    }
    if (event.type === "assistant_text" || event.type === "budget_stop") {
      console.log(`[${event.type}] ${JSON.stringify(event.data ?? {}).slice(0, 400)}`);
    }
  }
}

const finalResponse = await fetch(`${base}/tasks/${created.id}`, { headers: auth });
const record = (await finalResponse.json()) as Record<string, unknown>;
const result =
  typeof record["result"] === "object" && record["result"] !== null
    ? (record["result"] as Record<string, unknown>)
    : {};
const data =
  typeof result["data"] === "object" && result["data"] !== null
    ? (result["data"] as Record<string, unknown>)
    : {};
const evidence = Array.isArray(data["evidence"]) ? (data["evidence"] as Evidence[]) : [];

const validEvidence = evidence.flatMap((item) => {
  const candidateUrl = item.url ?? item.canonicalUrl ?? item["canonical url"];
  if (
    typeof item.platform !== "string" ||
    item.platform.trim() === "" ||
    typeof candidateUrl !== "string" ||
    !/^https?:\/\//.test(candidateUrl)
  ) {
    return [];
  }
  return [{ ...item, platform: item.platform, url: candidateUrl }];
});
const uniqueUrls = [...new Set(validEvidence.map((item) => item.url))];
const platforms = new Set(validEvidence.map((item) => item.platform.trim().toLowerCase()));
const now = Date.now();
const recent = validEvidence.filter(
  (item) =>
    typeof item.createdAt === "string" &&
    !Number.isNaN(Date.parse(item.createdAt)) &&
    now - Date.parse(item.createdAt) >= 0 &&
    now - Date.parse(item.createdAt) <= 72 * 60 * 60 * 1000,
);

async function verifyUrl(url: string): Promise<{ url: string; status?: number; error?: string }> {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": "ling-agentic-test/1.0" },
      signal: AbortSignal.timeout(15_000),
    });
    await response.body?.cancel();
    return { url, status: response.status };
  } catch (error) {
    return { url, error: error instanceof Error ? error.message : String(error) };
  }
}

const verified = await Promise.all(uniqueUrls.slice(0, 15).map(verifyUrl));
const reachable = verified.filter((entry) => entry.status !== undefined && entry.status < 400);

const browserUsed = toolsUsed.has("agent_browser");
const commandHosts = new Set<string>();
for (const command of toolCommands) {
  for (const match of command.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
    if (match[1] !== undefined) commandHosts.add(match[1].toLowerCase());
  }
}
const limitations = JSON.stringify(data["limitations"] ?? "");
const blockedAttempts = JSON.stringify(data["blockedAttempts"] ?? "");
const steps = JSON.stringify(result["steps"] ?? "");
const elapsedSeconds = Math.round((Date.now() - started) / 100) / 10;
const stats =
  typeof record["stats"] === "object" && record["stats"] !== null
    ? (record["stats"] as { turns?: number; cost?: number })
    : {};

let scriptCount = 0;
if (typeof record["workspaceDir"] === "string") {
  scriptCount = await readdir(`${record["workspaceDir"]}/scripts`).then((files) => files.length).catch(() => 0);
}

const scores: ScoreLine[] = [];
const add = (criterion: string, passed: boolean, detail: string) => {
  scores.push({ criterion, earned: passed ? 1 : 0, possible: 1, detail });
};
add(
  "Completed with this run's marker",
  record["status"] === "completed" && data["marker"] === marker,
  `status=${String(record["status"])} marker=${String(data["marker"])}`,
);
add("Used a real browser", browserUsed, `${toolCommands.length} bash calls`);
add("Found cross-platform evidence", platforms.size >= 2, [...platforms].join(", ") || "none");
add("Collected enough distinct evidence", uniqueUrls.length >= 6, `${uniqueUrls.length} unique URLs`);
add(
  "Evidence URLs independently reachable",
  verified.length >= 4 && reachable.length / verified.length >= 0.7,
  `${reachable.length}/${verified.length} returned below 400`,
);
add(
  "Evidence is current",
  validEvidence.length >= 4 && recent.length / validEvidence.length >= 0.5,
  `${recent.length}/${validEvidence.length} within 72 hours`,
);
add(
  "Adapted across routes or sites",
  commandHosts.size >= 2 && (blockedAttempts !== '""' || commandHosts.size >= 3),
  `${commandHosts.size} browser hosts; blockedAttempts=${blockedAttempts.slice(0, 120)}`,
);
add("Left reusable code", scriptCount > 0, `${scriptCount} file(s) in scripts/`);
add(
  "Reported limits and verification",
  limitations !== '""' && /verif|check|confirm/i.test(steps),
  `limitations=${limitations.slice(0, 100)}`,
);
add(
  "Stayed within practical budgets",
  elapsedSeconds <= 600 && (stats.cost ?? Infinity) <= 0.5 && (stats.turns ?? Infinity) <= 35,
  `${elapsedSeconds}s, ${stats.turns ?? "?"} turns, $${(stats.cost ?? 0).toFixed(4)}`,
);

const total = scores.reduce((sum, line) => sum + line.earned, 0);
console.log("\n=== independent score ===");
for (const line of scores) {
  console.log(`${line.earned === 1 ? "PASS" : "FAIL"}  ${line.criterion} -- ${line.detail}`);
}
console.log(`\nSCORE ${total}/10`);
console.log("\n=== outcome ===");
console.log(
  JSON.stringify(
    {
      status: record["status"],
      stoppedBy: record["stoppedBy"],
      elapsedSeconds,
      stats,
      evidence: evidence.length,
      platforms: [...platforms],
      verified,
      result,
    },
    null,
    2,
  ),
);
