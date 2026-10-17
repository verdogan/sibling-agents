/**
 * The Pi adapter. This is the only file outside a check script that imports the
 * SDK, and `npm run check` fails if that stops being true.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type AgentSession,
  createAgentSession,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentHarness,
  HarnessCatalog,
  HarnessExtension,
  HarnessHookName,
  HarnessModel,
  HarnessModelRecord,
  HarnessSession,
  HarnessSessionInspection,
  HarnessSessionSpec,
  HarnessSessionStats,
  HarnessTool,
  ModelResponseData,
  NormalizedEvent,
  ScriptedModel,
  WorkspaceToolOptions,
} from "./types.js";
import { declaredTools } from "./declared-tools.js";
import { config, type ModelMaxTokens, type ModelRouting, type OpenRouterRouting, ROUTING_PROVIDER } from "../config.js";
import { loadModelScript, scriptedModelFrom, traceScriptedModel } from "../scripted-model.js";

const ASSISTANT_TEXT_LIMIT = 2000;

/**
 * Say where a provider's credentials came from, in one line an operator can read.
 *
 * The harness contract is a string, and the SDK's answer is a record. Coercing it
 * with String() compiles against any shape and quietly printed "[object Object]"
 * the moment the SDK grew one, so the mapping is spelled out here instead.
 */
function describeAuthStatus(status: {
  configured: boolean;
  source?: string;
  label?: string;
}): string {
  if (!status.configured) return "not configured";
  return status.label ?? status.source ?? "configured";
}

function extractText(message: Record<string, unknown> | undefined): string {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const entry of content) {
    if (entry && typeof entry === "object") {
      const part = entry as Record<string, unknown>;
      if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
    }
  }
  return parts.join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Which call an assistant message was, and what it cost, from the fields Pi
 * sets on it: `responseId` from the first chunk's id, and `responseModel` only
 * when a chunk named a model other than the one asked for. The served
 * provider is not one of them; `servedProvider` looks it up by response id.
 * Nothing the model said is copied, the error message included.
 */
/**
 * A failed call's error, as the provider or Pi gave it: what was wrong with the request, never what the
 * model said. A token-shaped run of characters is redacted, and it is cut to 500 characters.
 */
function providerError(value: unknown): string | null {
  const text = stringOrNull(value);
  if (text === null) return null;
  const redacted = text.replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, "[redacted]").replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  return redacted.length > 500 ? `${redacted.slice(0, 499)}…` : redacted;
}

function modelResponse(
  message: Record<string, unknown>,
  servedProvider: (responseId: string) => string | undefined,
): ModelResponseData {
  const usage = isRecord(message.usage) ? message.usage : {};
  const cost = isRecord(usage.cost) ? usage.cost : {};
  const responseId = stringOrNull(message.responseId);
  return {
    responseId,
    responseModel: stringOrNull(message.responseModel),
    servedProvider: (responseId === null ? undefined : servedProvider(responseId)) ?? null,
    provider: stringOrNull(message.provider),
    model: stringOrNull(message.model),
    stopReason: stringOrNull(message.stopReason),
    errorMessage: message.stopReason === "error" ? providerError(message.errorMessage) : null,
    usage: {
      input: numberOrNull(usage.input),
      output: numberOrNull(usage.output),
      cacheRead: numberOrNull(usage.cacheRead),
      cacheWrite: numberOrNull(usage.cacheWrite),
      totalTokens: numberOrNull(usage.totalTokens),
      costUsd: numberOrNull(cost.total),
    },
  };
}

/**
 * Project a verbose Pi event onto this project's own event vocabulary.
 *
 * Anything not named here is dropped, which is what keeps streaming deltas out
 * of the durable log. A replacement adapter owes the same names, because the
 * overlord's replay and deduplication read them.
 *
 * Every assistant message ends in a `model_response`, a failed call's
 * included, and then in an `assistant_text` if it said anything. The first is
 * the record a paid run's cost and served provider are reconciled from, call
 * by call; `servedProvider` answers for a response id with what the session's
 * chunk tap saw (`servedProviderTap`), and is never asked otherwise. It covers
 * the agent loop's calls only. A compaction's summary calls end in no
 * assistant message, so they have no `model_response`, and `compaction_end`
 * is all a run's log shows of them. A reconciliation that finds one must take
 * the run's model_response total as short of what was spent; the task's
 * stats, Pi's session totals, do count those calls.
 */
export function normalizePiEvent(
  event: unknown,
  servedProvider: (responseId: string) => string | undefined = () => undefined,
): NormalizedEvent[] {
  const raw = event as Record<string, unknown>;
  const type = typeof raw.type === "string" ? raw.type : "unknown";

  switch (type) {
    case "agent_start":
    case "agent_end":
    case "turn_start":
    case "turn_end":
    case "compaction_start":
    case "compaction_end":
    case "auto_retry_start":
    case "auto_retry_end":
      return [{ type }];
    case "tool_execution_start":
      return [{ type: "tool_start", data: { tool: raw.toolName, args: raw.args } }];
    case "tool_execution_end":
      return [{ type: "tool_end", data: { tool: raw.toolName, error: raw.isError === true } }];
    case "message_end": {
      const message = raw.message as Record<string, unknown> | undefined;
      if (message?.role !== "assistant") return [];
      const events: NormalizedEvent[] = [
        { type: "model_response", data: modelResponse(message, servedProvider) },
      ];
      const text = extractText(message).trim();
      if (text !== "") {
        events.push({ type: "assistant_text", data: { text: text.slice(0, ASSISTANT_TEXT_LIMIT) } });
      }
      return events;
    }
    default:
      return [];
  }
}

/**
 * Pi gives a response no field for the upstream provider a router sent it
 * to, but hands each raw chunk to `provider_stream_event` before it parses
 * it, and OpenRouter's chunks are expected to name that provider in a
 * `provider` field. This keeps the first non-empty one seen for each chunk id,
 * which is the response's id, so the response's `model_response` can say who
 * served it. The field is an assumption until a real OpenRouter response has
 * shown it; a response whose chunks name no provider reads null, which a
 * caller must treat as unknown, not as a match. Installed for openrouter
 * models only: no other provider's chunks are read.
 */
function servedProviderTap(served: Map<string, string>): HarnessExtension {
  return {
    name: "served-provider",
    factory: (pi) => {
      pi.on("provider_stream_event", (event) => {
        const chunk = event.data;
        if (!isRecord(chunk) || typeof chunk.id !== "string" || chunk.id === "") return;
        const provider = chunk.provider;
        if (typeof provider !== "string" || provider.trim() === "" || served.has(chunk.id)) return;
        served.set(chunk.id, provider);
      });
    },
  };
}

/**
 * The model a session calls: `model`, or for an openrouter chat model that
 * LING_MODEL_ROUTING names, a copy whose compat also carries the routing,
 * which pi-ai's chat-completions request copies into the body's `provider`.
 *
 * A copy, so the catalogue's own entry is never changed, and a spread, so
 * every other compat field survives: DeepSeek's
 * `requiresReasoningContentOnAssistantMessages` and `thinkingFormat`, terra's
 * `supportsMidConvoSystemMessages`. Only the chat-completions API reads the
 * routing, so a model on any other API is returned as it is, and its /healthz
 * `model` shows no routing.
 */
export function routeModel(model: HarnessModel, routing: ModelRouting, maxTokens: ModelMaxTokens = {}): HarnessModel {
  if (model.provider !== ROUTING_PROVIDER || model.api !== "openai-completions") return model;
  const routed = Object.hasOwn(routing, model.id);
  const capped = Object.hasOwn(maxTokens, model.id);
  if (!routed && !capped) return model;
  let result = model;
  if (routed) {
    const openRouterRouting = structuredClone(routing[model.id]!) as OpenRouterRouting;
    result = { ...result, compat: { ...result.compat, openRouterRouting } } as HarnessModel;
  }
  // Pi asks for the model's maxTokens; the one endpoint the routing allows may give fewer, and
  // OpenRouter then drops it and finds none (LING_MODEL_MAX_TOKENS).
  if (capped) {
    const ceiling = maxTokens[model.id]!;
    const current = typeof result.maxTokens === "number" && result.maxTokens > 0 ? result.maxTokens : ceiling;
    result = { ...result, maxTokens: Math.min(current, ceiling) } as HarnessModel;
  }
  return result;
}

/** A JSON object's plain copy, or null for anything else. */
function plainRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? (JSON.parse(JSON.stringify(value)) as Record<string, unknown>) : null;
}

/** A resolved model as /healthz reports it (`HarnessModelRecord`). */
export function describeModel(model: HarnessModel): HarnessModelRecord {
  return {
    provider: model.provider,
    id: model.id,
    api: model.api,
    baseUrl: stringOrNull(model.baseUrl),
    cost: plainRecord(model.cost),
    compat: plainRecord(model.compat),
    thinkingLevelMap: plainRecord(model.thinkingLevelMap),
    contextWindow: numberOrNull(model.contextWindow),
    maxTokens: numberOrNull(model.maxTokens),
  };
}

interface LooseAgent {
  state: { tools: HarnessTool[] };
  beforeToolCall?: (
    input: { toolCall: { id: string; name: string }; args: Record<string, unknown> },
    signal?: AbortSignal,
  ) => Promise<{ block?: boolean; reason?: string } | undefined>;
}

/** Pi's loader keeps the settings it was built with in a private field. */
interface LooseLoader {
  settingsManager?: SettingsManager;
}

/**
 * What a session's settings would have Pi install or load, one entry per
 * source. It reads Pi's getters, not PACKAGE_SETTINGS, so a key that list
 * loses still shows.
 */
function packageSources(settings: SettingsManager): string[] {
  const npmCommand = settings.getNpmCommand();
  return [
    ...settings.getPackages().map((source) => `packages: ${typeof source === "string" ? source : source.source}`),
    ...(npmCommand === undefined ? [] : [`npmCommand: ${npmCommand.join(" ")}`]),
    ...settings.getExtensionPaths().map((entry) => `extensions: ${entry}`),
    ...settings.getSkillPaths().map((entry) => `skills: ${entry}`),
    ...settings.getPromptTemplatePaths().map((entry) => `prompts: ${entry}`),
    ...settings.getThemePaths().map((entry) => `themes: ${entry}`),
  ];
}

class PiSession implements HarnessSession {
  constructor(
    private readonly session: AgentSession,
    private readonly loader: DefaultResourceLoader,
    /** Served provider by response id, as the chunk tap saw it; empty off openrouter. */
    private readonly servedProviders: ReadonlyMap<string, string>,
  ) {}

  get isStreaming(): boolean {
    return this.session.isStreaming;
  }

  subscribe(listener: (event: NormalizedEvent) => void): () => void {
    const servedProvider = (responseId: string) => this.servedProviders.get(responseId);
    return this.session.subscribe((event) => {
      for (const normalized of normalizePiEvent(event, servedProvider)) listener(normalized);
    });
  }

  async prompt(text: string): Promise<void> {
    await this.session.prompt(text);
  }

  async abort(): Promise<void> {
    await this.session.abort();
  }

  clearQueue(): void {
    this.session.clearQueue();
  }

  dispose(): void {
    this.session.dispose();
  }

  getStats(): HarnessSessionStats {
    const stats = this.session.getSessionStats();
    return { cost: stats.cost, tokens: stats.tokens };
  }

  hasToolCallInterception(): boolean {
    return this.session.hasExtensionHandlers("tool_call");
  }

  /**
   * Pi raises `session_shutdown` only on reload or session replacement, and a
   * one-shot task is neither, so the event has to be raised here or feature
   * teardown never runs. Features register through `onShutdownOnce`, so a
   * future Pi that also fires it from `dispose()` stays harmless.
   */
  async shutdown(): Promise<string | undefined> {
    if (!this.session.hasExtensionHandlers("session_shutdown")) return undefined;
    try {
      await this.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  inspect(): HarnessSessionInspection {
    const session = this.session;
    const loader = this.loader;
    const agent = session.agent as unknown as LooseAgent;
    const settings = session.settingsManager;
    const cacheWarming = settings.getCacheWarmingMode();
    // The loader installs and loads packages with the settings it was built
    // with, and those must be the session's own.
    const loaderSettings = (loader as unknown as LooseLoader).settingsManager;
    return {
      tools: [...agent.state.tools],
      skillNames: loader
        .getSkills()
        .skills.map((skill) => skill.name)
        .sort(),
      extensionLoadErrors: loader
        .getExtensions()
        .errors.map((entry) => `${entry.path}: ${entry.error}`),
      toolCallInterceptionInstalled: agent.beforeToolCall !== undefined,
      backgroundProviderCalls: cacheWarming === "off" ? "off" : `prompt-cache warming (${cacheWarming})`,
      packageSettings: [
        ...packageSources(settings),
        ...(loaderSettings === settings
          ? []
          : [
              "the resource loader's settings are not the session's",
              ...(loaderSettings === undefined ? [] : packageSources(loaderSettings).map((entry) => `loader ${entry}`)),
            ]),
      ],
      hasHandler: (hook: HarnessHookName) => session.hasExtensionHandlers(hook),
      interceptToolCall: async (name, args) => {
        const intercept = agent.beforeToolCall;
        if (intercept === undefined) {
          throw new Error("Tool-call interception is not installed on this session.");
        }
        return intercept({ toolCall: { id: `inspect-${name}`, name }, args });
      },
      emitShutdown: async () => {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      },
      emitExtensionEvent: async (event) => {
        await session.extensionRunner.emit(event as Parameters<typeof session.extensionRunner.emit>[0]);
      },
    };
  }
}

export interface PiHarnessOptions {
  /** Let the model catalogue refresh over the network. Operator commands only. */
  allowModelNetwork?: boolean;
}

/**
 * The harness every ling process builds, the service's included.
 *
 * When the operator has opted in to a scripted model (LING_SCRIPTED_MODEL with
 * LING_ALLOW_SCRIPTED_MODEL=1, read by config.ts), this is the scripted
 * harness instead, registered under the configured provider and model, which
 * config.ts has made the script's: a task may name only that provider, so it
 * cannot reach a real one. It is decided here because this is the one call
 * every composition root makes, and it is said on stderr each time, because a
 * ling that only pretends to call a model must never be mistaken for one that
 * does. With LING_SCRIPTED_MODEL_TRACE set too, every request the script
 * answers has its system prompt appended to that file (`traceScriptedModel`).
 *
 * Otherwise the model resolves from Pi's catalogue, and LING_MODEL_ROUTING,
 * as config.ts has applied it to this ling's provider, is put on the resolved
 * model's copy (`routeModel`).
 */
export async function createPiHarness(
  options: PiHarnessOptions = {},
): Promise<AgentHarness> {
  if (config.scriptedModelFile !== undefined) {
    const file = config.scriptedModelFile;
    const trace = config.scriptedModelTrace;
    const script = scriptedModelFrom(await loadModelScript(file));
    const scripted = await createScriptedPiHarness(
      trace === undefined ? script : traceScriptedModel(script, trace),
      { provider: config.provider, model: config.model },
    );
    console.warn(
      [
        "warning: SCRIPTED MODEL. LING_SCRIPTED_MODEL and LING_ALLOW_SCRIPTED_MODEL=1 are set, so every",
        `provider call this ling makes is answered by the script ${file}, as ${scripted.provider}/${scripted.model}.`,
        "No model runs and nothing is spent: a task here does what the script says, not what a model would.",
        ...(trace === undefined ? [] : [`Every request's system prompt is appended to ${trace}.`]),
        "For offline checks only.",
      ].join("\n"),
    );
    return scripted.harness;
  }
  const runtime = await ModelRuntime.create(
    options.allowModelNetwork === true ? { allowModelNetwork: true } : {},
  );
  return piHarness(runtime, undefined, { routing: config.modelRouting, maxTokens: config.modelMaxTokens });
}

/** What the scripted harness's checks are given to post tasks with. */
export interface ScriptedPiHarness {
  harness: AgentHarness;
  provider: string;
  model: string;
}

/** The parts of pi-ai's faux provider the scripted harness uses. */
interface FauxModule {
  fauxProvider(options: {
    provider?: string;
    models?: { id: string; contextWindow?: number; maxTokens?: number; input?: ("text" | "image")[] }[];
  }): { provider: unknown; setResponses(responses: unknown[]): void };
  fauxAssistantMessage(content: unknown[], options?: { stopReason?: string; errorMessage?: string }): unknown;
  fauxText(text: string): unknown;
  fauxToolCall(name: string, args: Record<string, unknown>): unknown;
}

/** The part of pi-ai's transcript helpers the scripted harness uses. */
interface TranscriptModule {
  getCurrentSystemPrompt(messages: unknown[]): string;
}

/** Where the SDK is installed, and the two places pi-ai can be beside it: nested, then hoisted. */
function piAiCandidates(): { sdkRoot: string; candidates: string[] } {
  const sdkRoot = path.dirname(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
  return {
    sdkRoot,
    candidates: [path.join(sdkRoot, "node_modules", "@earendil-works", "pi-ai"), path.join(sdkRoot, "..", "pi-ai")],
  };
}

/**
 * Pi's faux provider is in pi-ai, which the SDK depends on and this package
 * does not, so it is loaded from beside the SDK, nested or hoisted, with the
 * transcript helper that reads a request's system prompt back out.
 */
async function loadFaux(): Promise<{ faux: FauxModule; transcript: TranscriptModule }> {
  const { sdkRoot, candidates } = piAiCandidates();
  for (const piAi of candidates) {
    const faux = path.join(piAi, "dist", "providers", "faux.js");
    const transcript = path.join(piAi, "dist", "utils", "transcript.js");
    if (existsSync(faux) && existsSync(transcript)) {
      return {
        faux: (await import(pathToFileURL(faux).href)) as FauxModule,
        transcript: (await import(pathToFileURL(transcript).href)) as TranscriptModule,
      };
    }
  }
  throw new Error(`Pi's faux provider was not found beside ${sdkRoot}.`);
}

/**
 * A model's entry in the registry pi-ai ships (`dist/providers/data/<provider>.json`,
 * found as `loadFaux` finds pi-ai), read from the file and not through Pi, so
 * it is the vendored entry whatever an agent directory's `models.json` or
 * catalogue cache would make of it. For checks that compare what a ling
 * resolved with what was installed.
 */
export async function readVendoredModelEntry(
  provider: string,
  modelId: string,
): Promise<Record<string, unknown> | undefined> {
  const { sdkRoot, candidates } = piAiCandidates();
  for (const piAi of candidates) {
    const file = path.join(piAi, "dist", "providers", "data", `${provider}.json`);
    if (!existsSync(file)) continue;
    // Grouped by API, each group keyed by `<type>:<id>`.
    const data = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    for (const group of Object.values(data)) {
      for (const entry of isRecord(group) ? Object.values(group) : []) {
        if (isRecord(entry) && entry.id === modelId && (entry.type ?? "chat") === "chat") return entry;
      }
    }
    return undefined;
  }
  throw new Error(`Pi's ${provider} registry was not found beside ${sdkRoot}.`);
}

const SCRIPTED_PROVIDER = "scripted";
const SCRIPTED_MODEL = "scripted-model";
/** More provider calls than any check makes; each is answered by the script. */
const SCRIPTED_CALLS = 1_000;

/**
 * A Pi harness whose one model is a script: every provider call is answered by
 * `script`, through Pi's own faux provider, so a check runs the real agent loop
 * (tool preparation, the hooks, sequential and parallel batches, steering,
 * retries) with no provider and no cost. Sessions use the runtime the faux
 * provider is registered on, which a normal session does not: it builds its own
 * from the agent directory. The checks construct one directly; the service
 * gets one only through createPiHarness, when its operator has opted in.
 */
export async function createScriptedPiHarness(
  script: ScriptedModel,
  options: { contextWindow?: number; provider?: string; model?: string } = {},
): Promise<ScriptedPiHarness> {
  const { faux, transcript } = await loadFaux();
  const runtime = await ModelRuntime.create({ modelsPath: null });
  const providerId = options.provider ?? SCRIPTED_PROVIDER;
  const modelId = options.model ?? SCRIPTED_MODEL;
  const provider = faux.fauxProvider({
    provider: providerId,
    models: [{ id: modelId, contextWindow: options.contextWindow ?? 128_000, maxTokens: 16_384, input: ["text"] }],
  });
  let index = 0;
  // A provider is not handed the prompt and the tool declarations beside the
  // messages. They are system messages in the transcript, one at its head and
  // a patch wherever either changes, with the prompt split into named
  // sections. A script is asked as before: the prompt as one string, and the
  // conversation without them, and is told the tools they declare.
  const respond = async (context: { messages: { role?: unknown }[] }) => {
    const reply = await script({
      index: index++,
      systemPrompt: transcript.getCurrentSystemPrompt(context.messages),
      tools: declaredTools(context.messages),
      messages: JSON.parse(
        JSON.stringify(context.messages.filter((message) => message.role !== "system")),
      ) as unknown[],
    });
    if (reply.error !== undefined) {
      return faux.fauxAssistantMessage([], { stopReason: "error", errorMessage: reply.error });
    }
    const calls = reply.toolCalls ?? [];
    return faux.fauxAssistantMessage(
      [
        ...(reply.text === undefined ? [] : [faux.fauxText(reply.text)]),
        ...calls.map((call) => faux.fauxToolCall(call.name, call.args)),
      ],
      { stopReason: calls.length > 0 ? "toolUse" : "stop" },
    );
  };
  provider.setResponses(Array.from({ length: SCRIPTED_CALLS }, () => respond));
  runtime.registerNativeProvider(provider.provider as Parameters<ModelRuntime["registerNativeProvider"]>[0]);
  return { harness: piHarness(runtime, runtime, { scriptedProvider: providerId }), provider: providerId, model: modelId };
}

/**
 * Every key of Pi 1.0.3's settings that makes it install or load something a
 * session was not given: `packages`, whose npm and git sources it installs as
 * the session's resources load and whose paths it reads in place;
 * `npmCommand`, the host command it installs them with; and `extensions`,
 * `skills`, `prompts` and `themes`, whose paths it adds, `extensions` also
 * switching its built-in extensions on and off. A git source is a `packages`
 * entry, with no list of its own. `npm run check` plants each of them.
 */
const PACKAGE_SETTINGS = [
  "packages",
  "npmCommand",
  "extensions",
  "skills",
  "prompts",
  "themes",
] as const satisfies readonly (keyof ReturnType<SettingsManager["getGlobalSettings"]>)[];

/**
 * The settings a session runs with: the service's own, from the agent
 * directory, and nothing from the task's workspace.
 *
 * Left to itself Pi also reads `<cwd>/.pi/settings.json`, trusting the project
 * unless told otherwise, and cwd here is a workspace a task's caller seeds
 * (`seedFiles`). A settings file there could name packages, which Pi installs
 * on the host as the session is created, with an `npmCommand` of its choosing:
 * a host command outside any sandbox. It could also change steering, retries
 * or compaction, and a `.pi/APPEND_SYSTEM.md` beside it would be appended to
 * the prompt. So the project is untrusted, and the agent directory's settings
 * are read once into memory, which also keeps anything a session changes from
 * being written back.
 *
 * `agent/settings.json` is operator config: the service's own file, which the
 * overlord copies into every local child it starts. Its retry, compaction and
 * steering settings apply as written, but its PACKAGE_SETTINGS are
 * deliberately ignored. Ling needs no Pi package, and as a session is created
 * Pi installs on the host any npm or git package the file names that is not
 * installed yet, with the file's `npmCommand`, whatever the loader is told
 * about extensions. Its shell settings, `shellPath` and `shellCommandPrefix`,
 * reach nothing: Pi gives them only to its own bash tool, and a session runs
 * ling's (`createWorkspaceTools`) in its place.
 *
 * Prompt-cache warming is off whatever that file says, the override coming
 * after the file's settings. Pi re-sends a session's last request with a
 * one-token limit shortly before its prompt cache would expire, while a run
 * is active: during a long tool call, a parked hold or a blocked
 * ask_overseer. That is a paid provider call with no model turn and no event
 * behind it, made while the oversight contract says nothing runs.
 */
function sessionSettings(workspaceDir: string, agentDir: string): SettingsManager {
  const service = SettingsManager.create(workspaceDir, agentDir, { projectTrusted: false });
  const settings = service.getGlobalSettings();
  for (const key of PACKAGE_SETTINGS) delete settings[key];
  return SettingsManager.inMemory({ ...settings, cacheWarming: "off" }, { projectTrusted: false });
}

/**
 * `scriptedProvider` needs no credentials, so it is never reported as missing
 * them. `routing` is put on every model this harness resolves (`routeModel`).
 */
function piHarness(
  runtime: ModelRuntime,
  sessionRuntime: ModelRuntime | undefined,
  options: { scriptedProvider?: string; routing?: ModelRouting; maxTokens?: ModelMaxTokens } = {},
): AgentHarness {
  const { scriptedProvider, routing = {}, maxTokens = {} } = options;
  return {
    name: "pi",

    resolveModel: (provider, modelId) => {
      const model = runtime.getModel(provider, modelId);
      return model === undefined ? undefined : routeModel(model, routing, maxTokens);
    },

    listModelIds: (provider) => runtime.getModels(provider).map((model) => model.id),

    anyModel: () => runtime.getModels()[0],

    hasCredentials: (provider) => provider === scriptedProvider || runtime.hasConfiguredAuth(provider),

    async describeCatalog(provider: string): Promise<HarnessCatalog> {
      const available = await runtime.getAvailable();
      return {
        configuredProviders: runtime
          .getProviders()
          .filter((candidate) => runtime.hasConfiguredAuth(candidate.id))
          .map((candidate) => ({
            id: candidate.id,
            authStatus: describeAuthStatus(runtime.getProviderAuthStatus(candidate.id)),
          })),
        availableModels: available.map((model) => ({
          provider: model.provider,
          id: model.id,
        })),
        providerModelIds: runtime.getModels(provider).map((model) => model.id),
      };
    },

    createWorkspaceTools(
      workspaceDir: string,
      toolOptions: WorkspaceToolOptions = {},
    ): HarnessTool[] {
      const wrap = toolOptions.wrap ?? ((tool: HarnessTool) => tool);
      return [
        createReadToolDefinition(workspaceDir),
        createWriteToolDefinition(workspaceDir),
        createEditToolDefinition(workspaceDir),
        createGrepToolDefinition(workspaceDir),
        createFindToolDefinition(workspaceDir),
        createLsToolDefinition(workspaceDir),
        createBashToolDefinition(
          workspaceDir,
          toolOptions.spawnHook !== undefined ? { spawnHook: toolOptions.spawnHook } : {},
        ),
      ].map(wrap);
    },

    async createSession(spec: HarnessSessionSpec): Promise<HarnessSession> {
      // Nothing is picked up from disk. The task carries exactly the extensions
      // and skills its features declared, and the prompt is ling's alone. The
      // one extension added here only reads chunks, for model_response.
      const servedProviders = new Map<string, string>();
      const extensions =
        spec.model.provider === ROUTING_PROVIDER
          ? [...spec.extensions, servedProviderTap(servedProviders)]
          : [...spec.extensions];
      const settingsManager = sessionSettings(spec.workspaceDir, spec.agentDir);
      const loader = new DefaultResourceLoader({
        cwd: spec.workspaceDir,
        agentDir: spec.agentDir,
        settingsManager,
        noContextFiles: true,
        noPromptTemplates: true,
        noExtensions: true,
        noSkills: true,
        noThemes: true,
        additionalSkillPaths: [...spec.skillPaths],
        extensionFactories: extensions,
        systemPromptOverride: () => spec.buildSystemPrompt(),
        appendSystemPromptOverride: () => [],
      });
      await loader.reload();

      const { session } = await createAgentSession({
        cwd: spec.workspaceDir,
        agentDir: spec.agentDir,
        settingsManager,
        model: spec.model,
        thinkingLevel: spec.thinkingLevel,
        noTools: "builtin",
        tools: [...spec.toolNames],
        customTools: [...spec.tools],
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(spec.workspaceDir),
        ...(sessionRuntime !== undefined ? { modelRuntime: sessionRuntime } : {}),
      });

      // Handlers stay inert until they are bound, and the guards are one of
      // them. Binding belongs to the adapter; whether the guards actually
      // arrived is a policy question the caller asks afterwards.
      await session.bindExtensions({ mode: "print" });

      return new PiSession(session, loader, servedProviders);
    },
  };
}
