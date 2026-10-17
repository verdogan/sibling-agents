import type { HarnessExtension } from "../harness/index.js";
import { checkToolCall } from "../guards.js";
import { WORKER_TOOL_NAMES } from "../oversight.js";
import type { FeatureContext } from "./types.js";

export interface GuardOptions {
  /** Directories the model may read from despite sitting outside the workspace. */
  trustedReadRoots: readonly string[];
  agentBrowserToolAvailable: boolean;
}

/** The two calls a hold never pauses: A's ways to answer one. */
const holdExempt = new Set(WORKER_TOOL_NAMES);

/**
 * Path confinement and command screening for every tool call in the session.
 *
 * Pi installs one `beforeToolCall` hook on the agent, so a single `tool_call`
 * handler covers built-in tools, custom tools, and anything a later feature
 * registers. That is strictly wider coverage than wrapping tool definitions,
 * which only ever guarded the tools we remembered to wrap.
 *
 * The hold gate is the handler's first step, so a call it holds back never
 * reaches the screening, and the same hook that confines paths is the one that
 * pauses tool use. Pi awaits the handler, which is what lets a call wait on a
 * hold; it passes no signal to the handler, so the gate takes the run's signal
 * from the handler context, which has none outside a run, and the runner's stop
 * signal, which always settles it.
 */
export function createGuardExtension(
  ctx: FeatureContext,
  options: GuardOptions,
): HarnessExtension {
  return {
    name: "guards",
    factory: (pi) => {
      pi.on("turn_start", () => {
        ctx.holdGate.turnStarted();
      });
      pi.on("tool_call", async (event, handlerCtx) => {
        if (!holdExempt.has(event.toolName)) {
          const held = await ctx.holdGate.decide(event.toolName, [handlerCtx.signal, ctx.stopSignal]);
          if (held !== undefined) return held;
        }
        const decision = checkToolCall(event.toolName, event.input, {
          workspaceDir: ctx.workspaceDir,
          trustedReadRoots: options.trustedReadRoots,
          agentBrowserToolAvailable: options.agentBrowserToolAvailable,
        });
        return decision ?? {};
      });
    },
  };
}
