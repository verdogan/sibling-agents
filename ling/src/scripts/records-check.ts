/**
 * The records a measurement reads from a ling, checked offline (part of
 * `npm run check`):
 *
 * - LING_MODEL_ROUTING: its shape, in process; then real lings. An invalid
 *   value refuses startup on an openrouter ling and on a scripted one, and a
 *   valid one is ignored by a scripted ling and applied by an openrouter ling,
 *   to the request bodies themselves, a retry included.
 * - The routed model is a copy that keeps every other compat field.
 * - `model_response`: one per assistant message, with the response's ids, its
 *   usage and the provider that served it, and none of its text.
 * - /healthz `model`: the vendored registry entry, the routing applied.
 * - The scripted-model trace (LING_SCRIPTED_MODEL_TRACE).
 *
 * The openrouter ling here runs no script. It calls OpenRouter's API as a
 * paid run would, except that the API is a loopback stub that speaks the
 * OpenAI-compatible streaming protocol and records every request body. The
 * ling's Pi agent directory (PI_CODING_AGENT_DIR) holds a models.json that
 * points openrouter's baseUrl at the stub, with a dummy key, and the child
 * inherits nothing from this process but what the OS needs to start it: no
 * key, no home and no agent directory of the user's. So no request can reach
 * a real provider, and nothing is spent.
 *
 * That models.json decides the model, its base URL included, but not the key
 * a request carries. A session builds a model runtime of its own from the
 * ling's `agent/` directory, and takes its credentials from there and from
 * the environment, so the child is given a second dummy key in
 * OPENROUTER_API_KEY, and the check says which of the two the stub received.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseModelMaxTokens, parseModelRouting } from "../config.js";
import type { HarnessModel, ModelResponseData } from "../harness/types.js";
import { normalizePiEvent, readVendoredModelEntry, routeModel } from "../harness/pi.js";
import { ModelScriptError, traceScriptedModel, type ScriptedModelTraceLine } from "../scripted-model.js";

const root = await mkdtemp(path.join(os.tmpdir(), "ling-records-check-"));
let failures = 0;

async function check(label: string, run: () => void | Promise<void>): Promise<void> {
  try {
    await run();
    console.log(`PASS  ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${label} -- ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  }
}

async function until<T>(probe: () => T | undefined | Promise<T | undefined>, what: string, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const DEEPSEEK = "deepseek/deepseek-v4.1-flash";
const TERRA = "openai/gpt-5.6-terra";
const ROUTING = {
  [DEEPSEEK]: { order: ["deepseek"], allow_fallbacks: false },
  // Not a model the openrouter ling below is asked for, so it is never applied there.
  "openai/no-such-model": { order: ["openai"], allow_fallbacks: false },
};
// Two dummy keys, so the check can say which one a request carries.
const DUMMY_KEY = "sk-or-records-check-environment-key";
const MODELS_JSON_KEY = "sk-or-records-check-models-json-key";

// ------------------------------------------------------------ the stub

interface StubRequest {
  model: string;
  body: Record<string, unknown>;
  authorization: string | undefined;
}

/** One planned answer: a failure with this status, or a stream of these chunks. */
type StubPlan = { status: number } | { chunks: Record<string, unknown>[] };

/**
 * OpenRouter's chat-completions endpoint, as far as Pi uses it: each request
 * is recorded and answered by the next plan queued for its model. A request
 * with nothing planned gets a 400, which Pi does not retry.
 */
class OpenRouterStub {
  readonly requests: StubRequest[] = [];
  private readonly plans = new Map<string, StubPlan[]>();
  private readonly server: Server = createServer((req, res) => void this.handle(req, res));
  baseUrl = "";

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/api/v1`;
  }

  plan(model: string, ...plans: StubPlan[]): void {
    this.plans.set(model, [...(this.plans.get(model) ?? []), ...plans]);
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(part as Buffer);
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    const body = JSON.parse(Buffer.concat(parts).toString("utf8")) as Record<string, unknown>;
    const model = String(body["model"]);
    this.requests.push({ model, body, authorization: req.headers.authorization });
    const plan = this.plans.get(model)?.shift();
    if (plan === undefined || "status" in plan) {
      const status = plan?.status ?? 400;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `stub: ${plan === undefined ? "nothing planned" : "planned failure"}`, code: status } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    for (const chunk of plan.chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.end("data: [DONE]\n\n");
  }
}

/**
 * One streamed response as OpenRouter sends it: every chunk carries the
 * response id and a model, and names the serving provider, except the first,
 * whose `provider` is empty, so the tap must take the first non-empty one.
 */
function streamed(options: {
  id: string;
  model: string;
  provider: string;
  reasoning?: string;
  text?: string;
  toolCall?: { id: string; name: string; args: Record<string, unknown> };
}): StubPlan {
  const base = { id: options.id, object: "chat.completion.chunk", created: 1_760_000_000, model: options.model };
  const named = { ...base, provider: options.provider };
  const delta = (value: Record<string, unknown>, finish: string | null = null) => ({
    choices: [{ index: 0, delta: value, finish_reason: finish }],
  });
  return {
    chunks: [
      { ...base, provider: "", ...delta({ role: "assistant", content: "" }) },
      ...(options.reasoning === undefined ? [] : [{ ...named, ...delta({ reasoning: options.reasoning }) }]),
      ...(options.text === undefined ? [] : [{ ...named, ...delta({ content: options.text }) }]),
      ...(options.toolCall === undefined
        ? []
        : [
            {
              ...named,
              ...delta({
                tool_calls: [
                  {
                    index: 0,
                    id: options.toolCall.id,
                    type: "function",
                    function: { name: options.toolCall.name, arguments: JSON.stringify(options.toolCall.args) },
                  },
                ],
              }),
            },
          ]),
      { ...named, ...delta({}, options.toolCall === undefined ? "stop" : "tool_calls") },
      { ...named, choices: [], usage: { prompt_tokens: 1_000, completion_tokens: 50, total_tokens: 1_050 } },
    ],
  };
}

// ------------------------------------------------------------ lings

const OWNER_TOKEN = randomBytes(16).toString("hex");
const SERVER = fileURLToPath(new URL("../server.ts", import.meta.url));
// Only what the OS needs to start a process: no provider key, home or agent
// directory of this process's can reach a child.
const PASS_THROUGH = new Set(["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "SYSTEMDRIVE", "TEMP", "TMP", "TMPDIR"]);
let lingCount = 0;

async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

interface Spawned {
  child: ChildProcess;
  base: string;
  output(): string;
  exitCode(): number | null | undefined;
  exited: Promise<void>;
}

/** A ling process in a directory of its own, with an empty Pi agent directory unless `piAgentDir` is given. */
async function spawnLing(env: Record<string, string>, piAgentDir?: string): Promise<Spawned> {
  lingCount += 1;
  const dir = path.join(root, `ling-${lingCount}`);
  const home = path.join(dir, "home");
  const agentDir = piAgentDir ?? path.join(dir, "pi-agent");
  await mkdir(home, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  const port = await freePort();
  const childEnv: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (PASS_THROUGH.has(name.toUpperCase())) childEnv[name] = value;
  }
  Object.assign(childEnv, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "appdata"),
    LOCALAPPDATA: path.join(home, "localappdata"),
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    AGENT_TOKENS_JSON: JSON.stringify({ owner: OWNER_TOKEN }),
    BIND_ADDRESS: "127.0.0.1",
    PORT: String(port),
    WORKER_ID: "records-check",
    SANDBOX_MODE: "none",
    ...env,
  });
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), SERVER], {
    cwd: dir,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk) => (output += String(chunk)));
  child.stderr?.on("data", (chunk) => (output += String(chunk)));
  let exitCode: number | null | undefined;
  const exited = new Promise<void>((resolve) =>
    child.once("exit", (code) => {
      exitCode = code;
      resolve();
    }),
  );
  return { child, base: `http://127.0.0.1:${port}`, output: () => output, exitCode: () => exitCode, exited };
}

async function startLing(env: Record<string, string>, piAgentDir?: string): Promise<Spawned> {
  const ling = await spawnLing(env, piAgentDir);
  await until(
    async () => {
      if (ling.exitCode() !== undefined) throw new Error(`the ling exited with ${ling.exitCode()}:\n${ling.output()}`);
      if (!ling.output().includes(" listening on ")) return undefined;
      try {
        return (await fetch(`${ling.base}/healthz`)).ok ? true : undefined;
      } catch {
        return undefined;
      }
    },
    "the ling to listen",
    90_000,
  );
  return ling;
}

async function stopLing(ling: Spawned): Promise<void> {
  if (ling.exitCode() === undefined) ling.child.kill();
  await Promise.race([ling.exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
}

async function refusedStartup(env: Record<string, string>): Promise<{ code: number | null | undefined; output: string }> {
  const ling = await spawnLing(env);
  try {
    await until(() => (ling.exitCode() !== undefined ? true : undefined), "the ling to refuse startup", 60_000);
  } finally {
    await stopLing(ling);
  }
  return { code: ling.exitCode(), output: ling.output() };
}

const owner = { authorization: `Bearer ${OWNER_TOKEN}` };

async function postTask(ling: Spawned, body: Record<string, unknown>): Promise<string> {
  const response = await fetch(`${ling.base}/tasks`, {
    method: "POST",
    headers: { ...owner, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, 202, text);
  return (JSON.parse(text) as { id: string }).id;
}

async function endedTask(ling: Spawned, id: string): Promise<Record<string, unknown>> {
  return await until(
    async () => {
      const task = (await (await fetch(`${ling.base}/tasks/${id}`, { headers: owner })).json()) as Record<string, unknown>;
      return ["completed", "failed", "cancelled", "interrupted"].includes(String(task["status"])) ? task : undefined;
    },
    `task ${id} to end`,
    90_000,
  );
}

async function taskEvents(ling: Spawned, id: string): Promise<{ type: string; data?: unknown }[]> {
  const log = await (await fetch(`${ling.base}/tasks/${id}/log`, { headers: owner })).text();
  return log
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { type: string; data?: unknown });
}

const modelResponses = (events: { type: string; data?: unknown }[]) =>
  events.filter((event) => event.type === "model_response").map((event) => event.data as ModelResponseData);

const stub = new OpenRouterStub();
await stub.start();

try {
  // ---------------------------------------------------------- in process

  await check("LING_MODEL_ROUTING: exactly its shape is accepted, and anything else refused", () => {
    assert.equal(parseModelRouting(undefined), undefined);
    assert.equal(parseModelRouting("  "), undefined);
    assert.deepEqual({ ...parseModelRouting("{}") }, {});
    assert.deepEqual({ ...parseModelRouting(JSON.stringify(ROUTING)) }, ROUTING);
    const denied = { [DEEPSEEK]: { order: ["deepseek"], allow_fallbacks: false, data_collection: "deny" } };
    assert.deepEqual({ ...parseModelRouting(JSON.stringify(denied)) }, denied);
    const proto = parseModelRouting('{"__proto__":{"order":["deepseek"],"allow_fallbacks":false}}')!;
    assert.ok(Object.hasOwn(proto, "__proto__"), "a model id is a key, whatever it spells");
    const entry = { order: ["deepseek"], allow_fallbacks: false };
    const refused: [string, unknown][] = [
      ["not JSON", "{deepseek: true"],
      ["an array", []],
      ["a string", "deepseek"],
      ["null", null],
      ["an entry that is not an object", { [DEEPSEEK]: ["deepseek"] }],
      ["an empty model id", { "": entry }],
      ["a model id with a space", { "deepseek v4": entry }],
      ["no allow_fallbacks", { [DEEPSEEK]: { order: ["deepseek"] } }],
      ["allow_fallbacks true", { [DEEPSEEK]: { ...entry, allow_fallbacks: true } }],
      ["no order", { [DEEPSEEK]: { allow_fallbacks: false } }],
      ["an empty order", { [DEEPSEEK]: { ...entry, order: [] } }],
      ["two providers in order", { [DEEPSEEK]: { ...entry, order: ["deepseek", "novita"] } }],
      ["a display name for a slug", { [DEEPSEEK]: { ...entry, order: ["DeepSeek"] } }],
      ["a slug that is not a string", { [DEEPSEEK]: { ...entry, order: [7] } }],
      ['data_collection "allow"', { [DEEPSEEK]: { ...entry, data_collection: "allow" } }],
      ["an unknown key", { [DEEPSEEK]: { ...entry, only: ["deepseek"] } }],
    ];
    for (const [label, value] of refused) {
      const raw = typeof value === "string" && label === "not JSON" ? value : JSON.stringify(value);
      assert.throws(() => parseModelRouting(raw), /LING_MODEL_ROUTING .*refusing to start/, label);
    }
  });

  await check("the routed model is a copy that keeps every other compat field, and the registry entry is untouched", async () => {
    const deepseek = (await readVendoredModelEntry("openrouter", DEEPSEEK))!;
    const terra = (await readVendoredModelEntry("openrouter", TERRA))!;
    assert.ok(deepseek && terra, "both models are in the vendored registry");
    const routing = parseModelRouting(
      JSON.stringify({
        [DEEPSEEK]: { order: ["deepseek"], allow_fallbacks: false },
        [TERRA]: { order: ["openai"], allow_fallbacks: false, data_collection: "deny" },
      }),
    )!;
    for (const [entry, expected] of [
      [deepseek, { order: ["deepseek"], allow_fallbacks: false }],
      [terra, { order: ["openai"], allow_fallbacks: false, data_collection: "deny" }],
    ] as const) {
      const before = structuredClone(entry);
      const routed = routeModel(entry as unknown as HarnessModel, routing) as unknown as Record<string, unknown>;
      assert.notEqual(routed, entry, "a copy");
      assert.deepEqual(entry, before, "the registry entry is unchanged");
      const { compat, ...rest } = routed;
      const { compat: beforeCompat, ...beforeRest } = before;
      assert.deepEqual(rest, beforeRest, "every other field is the entry's");
      assert.deepEqual(compat, { ...(beforeCompat as object), openRouterRouting: expected });
    }
    const routedDeepseek = routeModel(deepseek as unknown as HarnessModel, routing).compat as Record<string, unknown>;
    assert.equal(routedDeepseek["requiresReasoningContentOnAssistantMessages"], true);
    assert.equal(routedDeepseek["thinkingFormat"], "openrouter");
    const routedTerra = routeModel(terra as unknown as HarnessModel, routing).compat as Record<string, unknown>;
    assert.equal(routedTerra["supportsMidConvoSystemMessages"], true);
    // Returned as they are: a model the setting does not name, one on another
    // provider, and one on an API that sends no routing.
    const unmapped = (await readVendoredModelEntry("openrouter", `${DEEPSEEK}:batch`))!;
    const asModel = (value: unknown) => value as HarnessModel;
    assert.equal(routeModel(asModel(unmapped), routing), unmapped);
    const elsewhere = { ...deepseek, provider: "deepseek" };
    assert.equal(routeModel(asModel(elsewhere), routing), elsewhere);
    const otherApi = { ...deepseek, api: "anthropic-messages" };
    assert.equal(routeModel(asModel(otherApi), routing), otherApi);
  });

  await check("LING_MODEL_MAX_TOKENS caps a routed model's output request, and refuses any other shape", async () => {
    assert.equal(parseModelMaxTokens(undefined), undefined);
    assert.equal(parseModelMaxTokens(" "), undefined);
    for (const bad of ["[]", "1", '{"m":0}', '{"m":-5}', '{"m":1.5}', '{"m":"131072"}', '{"":10}', '{"a b":10}', "{"]) {
      assert.throws(() => parseModelMaxTokens(bad), /LING_MODEL_MAX_TOKENS/, bad);
    }
    const deepseek = (await readVendoredModelEntry("openrouter", DEEPSEEK))!;
    const asModel = (value: unknown) => value as HarnessModel;
    const before = structuredClone(deepseek);
    const limits = parseModelMaxTokens(JSON.stringify({ [DEEPSEEK]: 1000 }))!;
    const routing = parseModelRouting(JSON.stringify({ [DEEPSEEK]: { order: ["deepseek"], allow_fallbacks: false } }))!;
    const capped = routeModel(asModel(deepseek), routing, limits) as unknown as Record<string, unknown>;
    assert.equal(capped["maxTokens"], Math.min(1000, (deepseek as { maxTokens: number }).maxTokens));
    assert.deepEqual((capped["compat"] as Record<string, unknown>)["openRouterRouting"], { order: ["deepseek"], allow_fallbacks: false });
    assert.deepEqual(deepseek, before, "the registry entry is unchanged");
    // A ceiling above the catalogue's never raises it; a model the setting does not name is untouched.
    const high = routeModel(asModel(deepseek), {}, { [DEEPSEEK]: 10_000_000 }) as unknown as Record<string, unknown>;
    assert.equal(high["maxTokens"], (deepseek as { maxTokens: number }).maxTokens);
    assert.equal(routeModel(asModel(deepseek), {}, { other: 5 }), deepseek);
    assert.equal(routeModel(asModel({ ...deepseek, provider: "deepseek" }), {}, limits)["maxTokens"], (deepseek as { maxTokens: number }).maxTokens);
  });

  await check("model_response: one per assistant message, with its ids and usage and none of its text", () => {
    const asked: string[] = [];
    const served = (responseId: string) => {
      asked.push(responseId);
      return responseId === "gen-1" ? "DeepSeek" : undefined;
    };
    const message = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "SECRET-THINKING" },
        { type: "text", text: "SECRET-TEXT" },
        { type: "toolCall", id: "call-1", name: "ls", arguments: { path: "SECRET-ARG" } },
      ],
      provider: "openrouter",
      model: DEEPSEEK,
      responseId: "gen-1",
      responseModel: `${DEEPSEEK}-20260901`,
      stopReason: "toolUse",
      errorMessage: "SECRET-ERROR",
      usage: { input: 900, output: 50, cacheRead: 100, cacheWrite: 0, totalTokens: 1_050, cost: { total: 0.25 } },
    };
    const events = normalizePiEvent({ type: "message_end", message }, served);
    assert.deepEqual(
      events.map((event) => event.type),
      ["model_response", "assistant_text"],
    );
    assert.deepEqual(events[0]!.data, {
      responseId: "gen-1",
      responseModel: `${DEEPSEEK}-20260901`,
      servedProvider: "DeepSeek",
      provider: "openrouter",
      model: DEEPSEEK,
      stopReason: "toolUse",
      // A call that did not fail carries no error, whatever its message says.
      errorMessage: null,
      usage: { input: 900, output: 50, cacheRead: 100, cacheWrite: 0, totalTokens: 1_050, costUsd: 0.25 },
    });
    assert.ok(!JSON.stringify(events[0]).includes("SECRET"), "model_response carries no text");

    const bare = normalizePiEvent({ type: "message_end", message: { role: "assistant", content: [] } }, served);
    assert.deepEqual(bare, [
      {
        type: "model_response",
        data: {
          responseId: null,
          responseModel: null,
          servedProvider: null,
          provider: null,
          model: null,
          stopReason: null,
          errorMessage: null,
          usage: { input: null, output: null, cacheRead: null, cacheWrite: null, totalTokens: null, costUsd: null },
        },
      },
    ]);
    assert.deepEqual(asked, ["gen-1"], "the served provider is looked up only by a response id");
    assert.deepEqual(normalizePiEvent({ type: "message_end", message: { role: "user", content: "hi" } }, served), []);
  });

  await check("the scripted-model trace keeps each request's system prompt, its tools and their digests, and nothing it was sent", async () => {
    const file = path.join(root, "trace.jsonl");
    const traced = traceScriptedModel(() => ({ text: "done" }), file);
    const tools = [{ name: "read", description: "Read a file.", parameters: { type: "object", properties: {} } }];
    for (const index of [0, 1]) {
      await traced({
        index,
        systemPrompt: `You are agent ${index}.`,
        tools,
        messages: [{ role: "toolResult", content: [{ type: "text", text: "TOOL-OUTPUT-TOKEN" }] }],
      });
    }
    const text = await readFile(file, "utf8");
    assert.ok(!text.includes("TOOL-OUTPUT-TOKEN"), "a message reached the trace");
    const lines = text.trim().split("\n").map((line) => JSON.parse(line) as ScriptedModelTraceLine);
    const toolsSha256 = sha256(JSON.stringify(tools));
    assert.deepEqual(lines, [
      { index: 0, systemPromptSha256: sha256("You are agent 0."), systemPrompt: "You are agent 0.", toolsSha256, tools },
      { index: 1, systemPromptSha256: sha256("You are agent 1."), systemPrompt: "You are agent 1.", toolsSha256, tools },
    ]);
    assert.throws(
      () => traceScriptedModel(() => ({ text: "done" }), path.join(root, "no-such-directory", "trace.jsonl")),
      ModelScriptError,
    );
  });

  // ---------------------------------------------------------- startup

  await check("an invalid LING_MODEL_ROUTING refuses startup, on an openrouter ling and on a scripted ling", async () => {
    const script = path.join(root, "idle-script.json");
    await writeFile(script, JSON.stringify({ version: 1, turns: [{ text: "Nothing to do." }] }));
    const lings: Record<string, string>[] = [
      { AGENT_PROVIDER: "openrouter", AGENT_MODEL: DEEPSEEK, OPENROUTER_API_KEY: DUMMY_KEY },
      { LING_SCRIPTED_MODEL: script, LING_ALLOW_SCRIPTED_MODEL: "1" },
    ];
    for (const env of lings) {
      const refused = await refusedStartup({
        ...env,
        LING_MODEL_ROUTING: JSON.stringify({ [DEEPSEEK]: { order: ["DeepSeek"], allow_fallbacks: false } }),
      });
      assert.notEqual(refused.code, 0, `exit ${String(refused.code)}`);
      assert.match(refused.output, /LING_MODEL_ROUTING has entry .* refusing to start/);
      assert.ok(!refused.output.includes(" listening on "), refused.output);
    }
  });

  await check("LING_SCRIPTED_MODEL_TRACE refuses startup on a ling with no scripted model", async () => {
    const refused = await refusedStartup({
      AGENT_PROVIDER: "openrouter",
      AGENT_MODEL: DEEPSEEK,
      LING_SCRIPTED_MODEL_TRACE: path.join(root, "unscripted-trace.jsonl"),
    });
    assert.notEqual(refused.code, 0, `exit ${String(refused.code)}`);
    assert.match(refused.output, /LING_SCRIPTED_MODEL_TRACE .* refusing to start/);
  });

  await check("a scripted ling with a valid LING_MODEL_ROUTING starts, says it is ignored, and traces what its task was shown", async () => {
    const script = path.join(root, "reader-script.json");
    await writeFile(
      script,
      JSON.stringify({
        version: 1,
        turns: [{ toolCalls: [{ name: "read", args: { path: "notes.txt" } }] }, { text: "Read it." }],
      }),
    );
    const trace = path.join(root, "scripted-trace.jsonl");
    const requestsBefore = stub.requests.length;
    const ling = await startLing({
      LING_SCRIPTED_MODEL: script,
      LING_ALLOW_SCRIPTED_MODEL: "1",
      LING_SCRIPTED_MODEL_TRACE: trace,
      LING_MODEL_ROUTING: JSON.stringify(ROUTING),
    });
    try {
      assert.match(ling.output(), /^routing: ignored \(provider scripted\)$/m);
      const health = (await (await fetch(`${ling.base}/healthz`)).json()) as { model: Record<string, unknown> | null };
      assert.equal(health.model?.["provider"], "scripted");
      assert.equal((health.model?.["compat"] as Record<string, unknown> | null)?.["openRouterRouting"], undefined);
      const id = await postTask(ling, {
        task: "TASK-PROMPT-TOKEN: read notes.txt",
        tools: ["read"],
        files: { "notes.txt": "TOOL-OUTPUT-TOKEN\n" },
      });
      const task = await endedTask(ling, id);
      const text = await readFile(trace, "utf8");
      const lines = text.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      assert.deepEqual(
        lines.map((line) => line["index"]),
        [0, 1],
        "one line per scripted request",
      );
      for (const line of lines) {
        assert.deepEqual(Object.keys(line).sort(), ["index", "systemPrompt", "systemPromptSha256", "tools", "toolsSha256"]);
        assert.equal(line["systemPromptSha256"], sha256(String(line["systemPrompt"])));
        assert.equal(line["toolsSha256"], sha256(JSON.stringify(line["tools"])));
        // The tools the request declared: the task's read, each with its description and schema.
        const declared = line["tools"] as { name: string; description: string; parameters: unknown }[];
        const read = declared.find((tool) => tool.name === "read");
        assert.ok(read !== undefined && read.description !== "" && typeof read.parameters === "object", "read is not declared");
        assert.ok(String(line["systemPrompt"]).includes(String(task["workspaceDir"])), "the rendered prompt");
      }
      assert.ok(!text.includes("TOOL-OUTPUT-TOKEN"), "tool output reached the trace");
      assert.ok(!text.includes("TASK-PROMPT-TOKEN"), "the task's message reached the trace");
      assert.equal(stub.requests.length, requestsBefore, "a scripted ling reached the stub");
    } finally {
      await stopLing(ling);
    }
  });

  // ---------------------------------------------------------- openrouter

  const piAgentDir = path.join(root, "openrouter-pi-agent");
  await mkdir(piAgentDir, { recursive: true });
  await writeFile(
    path.join(piAgentDir, "models.json"),
    JSON.stringify({ providers: { openrouter: { baseUrl: stub.baseUrl, apiKey: MODELS_JSON_KEY } } }),
  );
  let openrouter: Spawned | undefined;
  await check("an openrouter ling prints the routing in force, and serves the vendored entry with it as /healthz model", async () => {
    openrouter = await startLing(
      {
        AGENT_PROVIDER: "openrouter",
        AGENT_MODEL: DEEPSEEK,
        AGENT_THINKING: "low",
        LING_MODEL_ROUTING: JSON.stringify(ROUTING),
        OPENROUTER_API_KEY: DUMMY_KEY,
      },
      piAgentDir,
    );
    const output = openrouter.output();
    assert.ok(output.includes(`routing: ${DEEPSEEK} ${JSON.stringify(ROUTING[DEEPSEEK])}`), output);
    assert.ok(output.includes("routing: ignored for openai/no-such-model (not a model this ling serves)"), output);
    const vendored = (await readVendoredModelEntry("openrouter", DEEPSEEK))!;
    const health = (await (await fetch(`${openrouter.base}/healthz`)).json()) as { model: unknown };
    assert.deepEqual(health.model, {
      provider: vendored["provider"],
      id: vendored["id"],
      api: vendored["api"],
      // The agent directory's models.json moves the provider to the stub.
      baseUrl: stub.baseUrl,
      cost: vendored["cost"],
      compat: { ...(vendored["compat"] as object), openRouterRouting: ROUTING[DEEPSEEK] },
      thinkingLevelMap: vendored["thinkingLevelMap"],
      contextWindow: vendored["contextWindow"],
      maxTokens: vendored["maxTokens"],
      thinking: "low",
    });
    assert.ok(output.includes(`resolved model: ${JSON.stringify(health.model)}`), "printed at startup too");
  });

  if (openrouter !== undefined) {
    const ling = openrouter;
    let mappedId = "";
    await check("every request for a mapped model carries the routing, the retry after a 500 included, and DeepSeek's reasoning is sent back", async () => {
      stub.plan(
        DEEPSEEK,
        { status: 500 },
        streamed({
          id: "gen-records-1",
          model: DEEPSEEK,
          provider: "DeepSeek",
          reasoning: "STUB-REASONING-TOKEN",
          toolCall: { id: "call-records-1", name: "ls", args: { path: "." } },
        }),
        streamed({ id: "gen-records-2", model: `${DEEPSEEK}-20260901`, provider: "DeepSeek", text: "STUB-TEXT-TOKEN" }),
      );
      const before = stub.requests.length;
      mappedId = await postTask(ling, { task: "List the workspace.", tools: ["ls"] });
      const task = await endedTask(ling, mappedId);
      const requests = stub.requests.slice(before);
      assert.equal(requests.length, 3, `the failed call, its retry, and the call after the tool: ${String(task["error"])}`);
      for (const request of requests) {
        assert.equal(request.model, DEEPSEEK);
        assert.deepEqual(request.body["provider"], { order: ["deepseek"], allow_fallbacks: false });
        assert.deepEqual(request.body["reasoning"], { effort: "low" }, "the thinking level in force");
        // The model, its base URL included, resolves through the agent
        // directory, but a session builds its own model runtime from the
        // ling's agent/ directory, so the key a request carries is the
        // environment's and never the models.json one.
        assert.equal(request.authorization, `Bearer ${DUMMY_KEY}`);
      }
      assert.deepEqual(requests[0]!.body, requests[1]!.body, "the retry is the same request");
      const messages = requests[2]!.body["messages"] as Record<string, unknown>[];
      const assistant = messages.find((message) => message["role"] === "assistant" && message["tool_calls"] !== undefined);
      assert.ok(assistant !== undefined, "the tool call is sent back");
      assert.ok("reasoning_content" in assistant, "DeepSeek's assistant turn carries reasoning_content");
      assert.equal(assistant["reasoning"], "STUB-REASONING-TOKEN");
    });

    await check("model_response: one per assistant message, with the stub's ids, the served provider from its chunks, and no text", async () => {
      const responses = modelResponses(await taskEvents(ling, mappedId));
      assert.deepEqual(
        responses.map((response) => [response.responseId, response.stopReason]),
        [
          [null, "error"],
          ["gen-records-1", "toolUse"],
          ["gen-records-2", "stop"],
        ],
      );
      const [failed, first, second] = responses as [ModelResponseData, ModelResponseData, ModelResponseData];
      assert.equal(failed.servedProvider, null);
      assert.equal(first.servedProvider, "DeepSeek");
      assert.equal(first.responseModel, null, "the requested model answered");
      assert.equal(second.servedProvider, "DeepSeek");
      assert.equal(second.responseModel, `${DEEPSEEK}-20260901`, "another model string answered");
      for (const response of [first, second]) {
        assert.equal(response.provider, "openrouter");
        assert.equal(response.model, DEEPSEEK);
        assert.deepEqual(response.usage, {
          input: 1_000,
          output: 50,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 1_050,
          // 1 000 input tokens at $0.30 and 50 output at $1.20 per million.
          costUsd: response.usage.costUsd,
        });
        assert.ok(Math.abs(response.usage.costUsd! - 0.00036) < 1e-9, `cost ${response.usage.costUsd}`);
      }
      // A failed call carries its error, so a provider's refusal can be read; what the model said never.
      assert.equal(failed.stopReason, "error");
      assert.match(failed.errorMessage ?? "", /stub: planned failure/);
      assert.equal(first.errorMessage, null);
      const text = JSON.stringify(responses);
      for (const token of ["STUB-REASONING-TOKEN", "STUB-TEXT-TOKEN"]) {
        assert.ok(!text.includes(token), `model_response carried ${token}`);
      }
    });

    await check("a request for a model the routing does not name carries none", async () => {
      stub.plan(TERRA, streamed({ id: "gen-records-3", model: TERRA, provider: "OpenAI", text: "Done." }));
      const before = stub.requests.length;
      const id = await postTask(ling, { task: "Say done.", model: TERRA, tools: ["ls"] });
      await endedTask(ling, id);
      const requests = stub.requests.slice(before);
      assert.equal(requests.length, 1);
      assert.equal(requests[0]!.model, TERRA);
      assert.ok(!("provider" in requests[0]!.body), JSON.stringify(requests[0]!.body["provider"]));
      const responses = modelResponses(await taskEvents(ling, id));
      assert.deepEqual(
        responses.map((response) => [response.responseId, response.servedProvider]),
        [["gen-records-3", "OpenAI"]],
      );
    });
    await stopLing(ling);
  }
} finally {
  await stub.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
}

console.log(failures === 0 ? "\nall records checks passed" : `\n${failures} records check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
