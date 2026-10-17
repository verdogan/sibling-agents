/**
 * Offline check that a declaration sent in one message with the actions it
 * covers is recorded before them.
 *
 * Pi runs the tool calls of one assistant message in parallel unless one of
 * them is sequential: each call's tool_start comes first, and only then do
 * they execute (oversight contract V28). intent_declared is emitted from
 * inside declare_intent's execute, and the overlord's IntentTracker covers an
 * action only with a declaration recorded before its tool_start, so in a
 * parallel batch an action sent beside its declaration read as undeclared, or
 * as declared too late. deepseek-v4.1-flash sent exactly that message, a
 * declaration and the write it named, on its first turn of `npm run smoke`.
 * declare_intent is sequential so that this cannot happen.
 *
 * The check sends that message, and the same two calls the other way round,
 * through the real runner and Pi's real agent loop with a scripted model, and
 * reads the order back from the task's recorded events. A control sends two
 * writes, neither sequential, and requires them to run as a parallel batch,
 * so the order above is declare_intent's doing and the checks can fail.
 *
 * Needs no API key and makes no model call.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config, type Config } from "../config.js";
import type { HarnessSessionInspection, ScriptedReply } from "../harness/index.js";
import { createScriptedPiHarness } from "../harness/pi.js";
import { DECLARE_INTENT_TOOL_NAME, INTENT_EVENT_TYPE } from "../intent.js";
import { SQLiteTaskStore, TaskQueue, type TaskEvent, type TaskRecord } from "../queue.js";
import { createTaskRunner } from "../runner.js";

type ToolCall = NonNullable<ScriptedReply["toolCalls"]>[number];

const root = await mkdtemp(path.join(os.tmpdir(), "ling-intent-order-check-"));
let failures = 0;

async function check(label: string, run: () => void | Promise<void>): Promise<void> {
  try {
    await run();
    console.log(`PASS  ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${label} -- ${error instanceof Error ? error.message : String(error)}`);
  }
}

const SCRIPT_PATH = "scripts/hello.mjs";
const SCRIPT = "console.log(new Date().toISOString());\n";
const declare: ToolCall = {
  name: DECLARE_INTENT_TOOL_NAME,
  args: { commands: [], hosts: [], writes: [SCRIPT_PATH] },
};
const write = (file: string): ToolCall => ({ name: "write", args: { path: file, content: SCRIPT } });

interface Run {
  record: TaskRecord | undefined;
  workspace: string;
  inspection: HarnessSessionInspection | undefined;
  /** The tool and intent events of the first turn, the one that sent `calls`, as "type tool". */
  firstTurn: string[];
}

/** One task whose first assistant message is `calls`, then write_result, then text. */
async function runMessage(name: string, calls: ToolCall[]): Promise<Run> {
  const scripted = await createScriptedPiHarness((request) => {
    if (request.index === 0) return { toolCalls: calls };
    if (request.index === 1) {
      const args = { status: "success", summary: "Wrote the script.", data: {}, steps: [] };
      return { toolCalls: [{ name: "write_result", args }] };
    }
    return { text: "Done." };
  });
  const dir = path.join(root, name);
  const workspace = path.join(dir, "workspace");
  let inspection: HarnessSessionInspection | undefined;
  const store = new SQLiteTaskStore(path.join(dir, "tasks.db"));
  const queue = new TaskQueue({
    store,
    concurrency: 1,
    runner: createTaskRunner({
      config: {
        ...config,
        provider: scripted.provider,
        model: scripted.model,
        sandboxMode: "none",
        taskRuntimeDir: path.join(dir, "runtime"),
      } as Config,
      harness: {
        ...scripted.harness,
        createSession: async (spec) => {
          const created = await scripted.harness.createSession(spec);
          inspection = created.inspect();
          return created;
        },
      },
      namedSkills: new Map(),
    }),
    workspaceDirFor: () => workspace,
  });
  const task = queue.enqueue({
    createdBy: "intent-order-check",
    prompt: "Do the scripted task.",
    options: { tools: [DECLARE_INTENT_TOOL_NAME, "write", "write_result"] },
  });
  const deadline = Date.now() + 60_000;
  let record = store.get(task.id);
  while ((record === undefined || ["queued", "running"].includes(record.status)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    record = store.get(task.id);
  }
  await queue.drain();
  store.close();
  return { record, workspace, inspection, firstTurn: firstTurn(record?.events ?? []) };
}

function firstTurn(events: readonly TaskEvent[]): string[] {
  const start = events.findIndex((event) => event.type === "turn_start");
  const end = events.findIndex((event, index) => index > start && event.type === "turn_end");
  return events
    .slice(start + 1, end === -1 ? undefined : end)
    .flatMap((event) => {
      const tool = (event.data as { tool?: unknown } | undefined)?.tool;
      if (event.type === "tool_start" || event.type === "tool_end") return [`${event.type} ${String(tool)}`];
      return event.type === INTENT_EVENT_TYPE ? [INTENT_EVENT_TYPE] : [];
    });
}

/** The recorded tool_ends of a run, with whether each was an error. */
function toolEnds(run: Run): string[] {
  return (run.record?.events ?? [])
    .filter((event) => event.type === "tool_end")
    .map((event) => {
      const data = event.data as { tool?: unknown; error?: unknown };
      return `${String(data.tool)}${data.error === true ? " (error)" : ""}`;
    });
}

try {
  const declareFirst = await runMessage("declare-first", [declare, write(SCRIPT_PATH)]);
  const writeFirst = await runMessage("write-first", [write(SCRIPT_PATH), declare]);
  const control = await runMessage("two-writes", [write("a.mjs"), write("b.mjs")]);

  await check("declare_intent is registered sequential on a real session, and write is not", () => {
    const modes = new Map(
      ((declareFirst.inspection?.tools ?? []) as unknown as { name: string; executionMode?: string }[]).map(
        (tool) => [tool.name, tool.executionMode],
      ),
    );
    assert.equal(modes.get(DECLARE_INTENT_TOOL_NAME), "sequential");
    assert.ok(modes.has("write"), "the session has no write tool");
    assert.equal(modes.get("write"), undefined);
  });

  await check("each scripted task completes, and every call in it succeeds", () => {
    for (const run of [declareFirst, writeFirst, control]) {
      assert.equal(run.record?.status, "completed", run.record?.error ?? "no record");
      assert.ok(toolEnds(run).every((end) => !end.endsWith("(error)")), toolEnds(run).join(", "));
    }
  });

  await check("a declaration sent before a write in one message runs first, alone, and is recorded before the write starts", async () => {
    assert.deepEqual(declareFirst.firstTurn, [
      `tool_start ${DECLARE_INTENT_TOOL_NAME}`,
      INTENT_EVENT_TYPE,
      `tool_end ${DECLARE_INTENT_TOOL_NAME}`,
      "tool_start write",
      "tool_end write",
    ]);
    assert.equal(await readFile(path.join(declareFirst.workspace, ...SCRIPT_PATH.split("/")), "utf8"), SCRIPT);
  });

  await check("a write sent before a declaration in one message runs first, and ends before the declaration starts", () => {
    assert.deepEqual(writeFirst.firstTurn, [
      "tool_start write",
      "tool_end write",
      `tool_start ${DECLARE_INTENT_TOOL_NAME}`,
      INTENT_EVENT_TYPE,
      `tool_end ${DECLARE_INTENT_TOOL_NAME}`,
    ]);
  });

  await check("control: two writes in one message, neither sequential, both start before either ends, so the order above is declare_intent's", () => {
    const firstEnd = control.firstTurn.findIndex((entry) => entry.startsWith("tool_end"));
    assert.deepEqual(control.firstTurn.slice(0, 2), ["tool_start write", "tool_start write"], control.firstTurn.join(", "));
    assert.equal(firstEnd, 2, control.firstTurn.join(", "));
  });
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nintent order checks passed" : `\n${failures} intent order check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
