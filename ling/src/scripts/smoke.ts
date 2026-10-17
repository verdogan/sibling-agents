/**
 * End-to-end check against the real provider: one task, through the real runner,
 * exercising write + bash + result.json. Requires a working API key.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import type { AgentHarness, HarnessTool } from "../harness/index.js";
import { createPiHarness } from "../harness/pi.js";
import type { TaskRecord } from "../queue.js";
import { createTaskRunner } from "../runner.js";

const id = `smoke-${Date.now()}`;
const workspaceDir = path.join(config.workspacesDir, id);
await mkdir(workspaceDir, { recursive: true });

const task: TaskRecord = {
  id,
  createdBy: "smoke-check",
  prompt: [
    "Write a Node script at ./scripts/hello.mjs that prints the current UTC timestamp in ISO 8601 format.",
    "Run it with bash and capture the output.",
    'Then write ./result.json with status "success", a one sentence summary, and data.timestamp set to exactly the value the script printed.',
  ].join(" "),
  status: "running",
  createdAt: new Date().toISOString(),
  workspaceDir,
  options: {},
  events: [],
};

const piHarness = await createPiHarness();
if (!piHarness.hasCredentials(config.provider)) {
  console.error(
    `No credentials for provider "${config.provider}". Put your key in .env (see .env.example) and try again.`,
  );
  process.exit(1);
}

// What each bash call that ran the script printed, as the model was shown it.
// The event stream records that a call ran, not its output, so the bash tool
// the runner builds is wrapped to keep it.
const printed: string[] = [];
const recordScriptOutput = (tool: HarnessTool): HarnessTool => ({
  ...tool,
  execute: async (...args: Parameters<HarnessTool["execute"]>) => {
    const result = await tool.execute(...args);
    const command = (args[1] as { command?: unknown } | undefined)?.command;
    if (typeof command === "string" && command.includes("hello.mjs")) {
      for (const part of result.content) if (part.type === "text") printed.push(part.text);
    }
    return result;
  },
});
const harness: AgentHarness = {
  ...piHarness,
  createWorkspaceTools: (dir, options) =>
    piHarness
      .createWorkspaceTools(dir, options)
      .map((tool) => (tool.name === "bash" ? recordScriptOutput(tool) : tool)),
};

const runner = createTaskRunner({ config, harness });
const controller = new AbortController();

console.log(`workspace: ${workspaceDir}\n`);

const outcome = await runner(task, controller.signal, (type, data) => {
  const detail = data === undefined ? "" : ` ${JSON.stringify(data).slice(0, 240)}`;
  console.log(`[${type}]${detail}`);
}, {
  subscribe: () => () => undefined,
  subscribeOversight: () => () => undefined,
  close: () => undefined,
});

console.log("\noutcome:", JSON.stringify(outcome, null, 2));

// The runner counts turns by matching Pi's "turn_end" event by name, which the
// type checker cannot verify. If an upgrade renames or reshapes it, the turn and
// cost ceilings stop being enforced without any error, so assert the accounting
// happened rather than trusting a completed status.
const accounted = (outcome.stats?.turns ?? 0) > 0 && (outcome.stats?.cost ?? 0) > 0;
if (!accounted) {
  console.error(
    "\nFAIL: the run reported no turns or no cost, so the budget ceilings are not being enforced.\nCheck that the runner still recognizes Pi's per-turn event and its session stats shape.",
  );
}

// A completed status says result.json was written, not that it says what was
// asked. deepseek-v4.1-flash once wrote data as a JSON string, and the run
// completed with no data.timestamp at all. So data must be an object, and its
// timestamp one the script printed. It is looked for among the ISO timestamps in
// that output rather than as a whole line, because models wrap the run in their
// own echo: qwen3.8-flash printed `stdout=[2026-...Z]` and reported it exactly.
const data = (outcome.result as { data?: unknown } | undefined)?.data;
const timestamp =
  typeof data === "object" && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>)["timestamp"]
    : undefined;
const printedLines = printed.flatMap((text) => text.split(/\r?\n/).map((line) => line.trim()));
const printedTimestamps = printed.flatMap(
  (text) => text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g) ?? [],
);
const reported = typeof timestamp === "string" && printedTimestamps.includes(timestamp);
if (!reported) {
  console.error(
    `\nFAIL: result.json's data is not an object whose timestamp the script printed.\ndata: ${JSON.stringify(data)}\nprinted by the script: ${printed.length === 0 ? "nothing (no bash call ran hello.mjs)" : JSON.stringify(printedLines.filter((line) => line !== ""))}`,
  );
}

process.exit(outcome.status === "completed" && accounted && reported ? 0 : 1);
