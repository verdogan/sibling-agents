/**
 * The public face of the harness seam. Everything outside `src/harness/`
 * imports from here instead of reaching for the SDK, and `npm run check`
 * fails the build if that stops being true.
 *
 * The adapter itself is deliberately not re-exported. Choosing one is a
 * composition-root decision that belongs to `server.ts` and the operator
 * scripts, so nothing in the runner, the features or the tools can quietly
 * acquire a dependency on which SDK is in use.
 */
export type {
  AgentHarness,
  HarnessCatalog,
  HarnessContextModel,
  HarnessExtension,
  HarnessExtensionApi,
  HarnessExtensionContext,
  HarnessHookName,
  HarnessModel,
  HarnessSession,
  HarnessSessionInspection,
  HarnessSessionSpec,
  HarnessSessionStats,
  HarnessSpawnHook,
  HarnessTokenUsage,
  HarnessTool,
  HarnessToolResultEvent,
  NormalizedEvent,
  ScriptedModel,
  ScriptedReply,
  ScriptedRequest,
  WorkspaceToolOptions,
} from "./types.js";

/**
 * Two utilities that necessarily know the SDK's own shapes: the tool builder
 * every feature registers through, and the token estimate the context budget
 * prices a call with. A second adapter points these at its own equivalents.
 */
export { defineTool, estimateTokens } from "@earendil-works/pi-coding-agent";
/** The tools a provider request declares, read from its transcript (no SDK import). */
export { declaredTools } from "./declared-tools.js";
