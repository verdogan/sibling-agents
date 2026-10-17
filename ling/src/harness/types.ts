/**
 * The seam between this service and the agent SDK that actually runs a task.
 *
 * Everything outside `src/harness/` programs against these declarations, so
 * replacing the SDK means writing one more adapter rather than editing the
 * runner, the features, the tools and the operator scripts. `npm run check`
 * enforces that boundary rather than trusting it.
 *
 * Be honest about what this buys. The aliases below are structurally whatever
 * the current adapter's SDK uses; naming them here does not make them portable,
 * it makes them single-pointed. A second adapter either satisfies the same
 * shapes or changes them in one file instead of twenty.
 */
import type {
  BashSpawnHook,
  ExtensionAPI,
  ExtensionContext,
  InlineExtension,
  ModelRuntime,
  ToolDefinition,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "../config.js";
import type { ToolDeclaration } from "../prompt-digest.js";

/** An inline capability: the tools, hooks and teardown a feature contributes. */
export type HarnessExtension = InlineExtension;
/** The registration surface handed to an extension when it is bound. */
export type HarnessExtensionApi = ExtensionAPI;
/** Per-call context an extension hook receives. */
export type HarnessExtensionContext = ExtensionContext;
/** A tool result on its way back to the model, before context budgeting. */
export type HarnessToolResultEvent = ToolResultEvent;
/** Rewrites a shell command, cwd or env immediately before execution. */
export type HarnessSpawnHook = BashSpawnHook;
// The SDK's tool definition is generic over its own schema plumbing, which
// nothing here needs to name.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type HarnessTool = ToolDefinition<any, any, any>;
/** A model resolved from the catalogue, ready to run a session against. */
export type HarnessModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;
/** The model as a hook sees it. This is the one that carries cost metadata. */
export type HarnessContextModel = NonNullable<ExtensionContext["model"]>;

/**
 * A resolved model as plain data, routing applied: what /healthz reports as
 * `model`, beside the thinking level in force, so a caller can compare the
 * model a ling resolved with the one it meant. A field the model does not
 * carry is null.
 *
 * It is the model as the catalogue resolved it, which is not all a request is
 * built from. A session builds a model runtime of its own from the ling's
 * `agent/` directory, and that runtime can still give each request another
 * base URL, other headers or another key: from `agent/auth.json` or
 * `agent/models.json`, and the key from the environment. None of that shows
 * here, so this record cannot catch it. Nothing checks for those two files
 * yet; a preflight that requires them absent would be the guard.
 */
export interface HarnessModelRecord {
  provider: string;
  id: string;
  api: string;
  baseUrl: string | null;
  cost: Record<string, unknown> | null;
  compat: Record<string, unknown> | null;
  thinkingLevelMap: Record<string, unknown> | null;
  contextWindow: number | null;
  maxTokens: number | null;
}

/** Cross-cutting hooks this project depends on being present. */
export type HarnessHookName =
  | "tool_call"
  | "tool_result"
  | "context"
  | "before_provider_request"
  | "session_shutdown";

export interface HarnessTokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface HarnessSessionStats {
  cost: number;
  tokens: HarnessTokenUsage;
}

/**
 * One projected agent event.
 *
 * The vocabulary is this project's rather than the SDK's: an adapter maps its
 * own stream onto these names, so `events.jsonl`, the SSE stream and every
 * overlord replaying them are unaffected by a swap. Streaming deltas are
 * dropped on the way through; they would dominate the log without adding
 * anything the final message does not already carry.
 */
export interface NormalizedEvent {
  type: string;
  data?: unknown;
}

/**
 * The data of a `model_response` event: one per assistant message, failed
 * ones included, saying which call it was and what it cost, and never what it
 * said. A field the response does not carry is null.
 *
 * Not every paid call is an assistant message. Pi's compaction summarises a
 * long session with model calls of its own, outside the agent loop, and they
 * leave no `model_response`, only the bare `compaction_end` event: no
 * response id and no served provider. A run whose log has one spent more than
 * its `model_response` events add up to. The task's `stats`, which are Pi's
 * session totals, count those calls too, so the difference shows there, but
 * not call by call.
 */
export interface ModelResponseData {
  /** The provider's id for the response, which its billing records are kept under. */
  responseId: string | null;
  /** The model the provider says answered, set only when it is not the id asked for. */
  responseModel: string | null;
  /**
   * The upstream provider a router says served the call: the first non-empty
   * `provider` in the response's raw chunks. Read for openrouter models only.
   */
  servedProvider: string | null;
  provider: string | null;
  model: string | null;
  stopReason: string | null;
  /**
   * For a failed call (`stopReason` "error"), the provider's or Pi's error, keys redacted and at most
   * 500 characters: what was wrong with the request, never what the model said. Null otherwise.
   */
  errorMessage: string | null;
  usage: {
    input: number | null;
    output: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
    totalTokens: number | null;
    costUsd: number | null;
  };
}

export interface HarnessSessionSpec {
  workspaceDir: string;
  agentDir: string;
  model: HarnessModel;
  thinkingLevel: ThinkingLevel;
  /** Tool names this task may use. Nothing outside this list is enabled. */
  toolNames: readonly string[];
  /** Fully constructed tools, already scoped and wrapped by the caller. */
  tools: readonly HarnessTool[];
  extensions: readonly HarnessExtension[];
  /** The only directories readable outside the workspace. */
  skillPaths: readonly string[];
  buildSystemPrompt(): string;
}

/**
 * Introspection for the offline wiring check.
 *
 * Kept separate from the operating surface because it exists to let a check
 * assert that an adapter wired the session correctly, which is exactly the
 * thing a replacement adapter has to re-prove.
 */
export interface HarnessSessionInspection {
  /**
   * Every tool actually registered on the session, including those a feature
   * extension added after construction. Not the same set the caller passed in,
   * which is the point: this is what the model will really be offered.
   */
  tools: HarnessTool[];
  skillNames: string[];
  extensionLoadErrors: string[];
  /** Whether cross-cutting tool-call interception is installed at all. */
  toolCallInterceptionInstalled: boolean;
  /**
   * Whether the SDK calls the provider on its own, with no model turn behind
   * the call. Pi does when its prompt-cache warming is on. "off" is the only
   * answer this service accepts; anything else names what is on.
   */
  backgroundProviderCalls: string;
  /**
   * What the session's settings would have the SDK install or load beyond
   * what the session was given, one entry per source. Pi installs a package
   * on the host as a session's resources load, and adds the extensions,
   * skills, prompts and themes its settings list. The settings its resources
   * are loaded with count too, and an entry says so if they are not the
   * session's own. Empty is the only answer this service accepts.
   */
  packageSettings: string[];
  hasHandler(hook: HarnessHookName): boolean;
  /** Drive interception exactly as a real tool call would. */
  interceptToolCall(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ block?: boolean; reason?: string } | undefined>;
  /** Raise teardown directly, including more than once, to prove idempotence. */
  emitShutdown(): Promise<void>;
  /**
   * Raise one extension event, such as `turn_start`, with no agent run behind
   * it, so a check can reach a hook that only a run would otherwise drive.
   */
  emitExtensionEvent(event: { type: string } & Record<string, unknown>): Promise<void>;
}

/** What a scripted model is asked, in this project's terms rather than the SDK's. */
export interface ScriptedRequest {
  /** 0 for the harness's first provider call, then 1, 2 and so on. */
  index: number;
  systemPrompt: string;
  /** The tools the request declares to the model, in its order (`declaredTools`). */
  tools: ToolDeclaration[];
  /** The messages the provider would have been sent, as plain JSON. */
  messages: unknown[];
}

/** One reply of a scripted model: text, tool calls, or a provider error. */
export interface ScriptedReply {
  text?: string;
  /** Called in order, as one assistant message. */
  toolCalls?: { name: string; args: Record<string, unknown> }[];
  /** Reply with a provider error carrying this message instead, such as "503 overloaded", which is retried. */
  error?: string;
}

/**
 * Answers every provider call of a scripted session. The checks build one in
 * process; the service runs one only when its operator opts in with
 * LING_SCRIPTED_MODEL and LING_ALLOW_SCRIPTED_MODEL=1 (scripted-model.ts).
 */
export type ScriptedModel = (request: ScriptedRequest) => ScriptedReply | Promise<ScriptedReply>;

export interface HarnessSession {
  /** Receives projected events only; the adapter drops what is not worth keeping. */
  subscribe(listener: (event: NormalizedEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  clearQueue(): void;
  dispose(): void;
  getStats(): HarnessSessionStats;
  readonly isStreaming: boolean;
  /**
   * Whether cross-cutting tool-call interception is live. The runner refuses to
   * start a task when it is not, so this is a policy question the caller asks
   * rather than something the adapter decides.
   */
  hasToolCallInterception(): boolean;
  /**
   * Run feature teardown at most once. Returns a message instead of throwing:
   * the caller runs this after the task has already earned its result, and
   * raising here would discard it.
   */
  shutdown(): Promise<string | undefined>;
  inspect(): HarnessSessionInspection;
}

export interface WorkspaceToolOptions {
  spawnHook?: HarnessSpawnHook;
  /**
   * Applied to every constructed tool, for structural policy the SDK cannot
   * know about. A wrapped tool cannot execute unwrapped, which is why this is
   * stacked under the interception hook rather than replaced by it.
   */
  wrap?(tool: HarnessTool): HarnessTool;
}

export interface HarnessCatalog {
  configuredProviders: { id: string; authStatus: string }[];
  availableModels: { provider: string; id: string }[];
  providerModelIds: string[];
}

export interface AgentHarness {
  readonly name: string;
  resolveModel(provider: string, modelId: string): HarnessModel | undefined;
  listModelIds(provider: string): string[];
  /**
   * Any model in the catalogue, from any provider. Only for offline checks that
   * need a session object but never reach a provider.
   */
  anyModel(): HarnessModel | undefined;
  hasCredentials(provider: string): boolean;
  /** Operator-facing catalogue view for `npm run models`. */
  describeCatalog(provider: string): Promise<HarnessCatalog>;
  /**
   * The workspace-scoped file and shell tools, in the order they are advertised.
   *
   * Scoping happens at construction, so one of these cannot be built without a
   * root. That is the structural half of path confinement; the interception
   * hook is the wider half, and neither is meant to be load-bearing alone.
   */
  createWorkspaceTools(
    workspaceDir: string,
    options?: WorkspaceToolOptions,
  ): HarnessTool[];
  createSession(spec: HarnessSessionSpec): Promise<HarnessSession>;
}
