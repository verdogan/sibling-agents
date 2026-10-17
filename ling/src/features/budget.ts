import {
  estimateTokens,
  type HarnessContextModel,
  type HarnessExtension,
  type HarnessExtensionContext,
  type HarnessToolResultEvent,
} from "../harness/index.js";
import { isOversightTool } from "../oversight.js";

const IMAGE_ESTIMATED_CHARS = 4_800;
const PROVIDER_OVERHEAD_TOKENS = 4_000;
const OUTPUT_RESERVE_TOKENS = 2_048;

type ToolContent = HarnessToolResultEvent["content"][number];
type Model = HarnessContextModel;

export interface BudgetExtensionOptions {
  maxCostUsd: number;
  maxToolResultChars: number;
  maxToolResultCharsPerTurn: number;
  getCurrentCostUsd(): number;
  onCostLimit(note: string): void;
}

export interface LimitedToolContent {
  content: ToolContent[];
  estimatedChars: number;
  truncated: boolean;
}

function contentChars(content: readonly ToolContent[]): number {
  return content.reduce(
    (total, part) => total + (part.type === "text" ? part.text.length : IMAGE_ESTIMATED_CHARS),
    0,
  );
}

/**
 * Bound one tool result before it enters model context.
 *
 * The complete result still exists in the tool's own execution path; this only
 * limits the copy sent back to the model. Keeping the beginning plus an explicit
 * marker lets the agent retry with a narrower query instead of silently losing
 * data.
 */
export function limitToolContent(
  content: readonly ToolContent[],
  maxChars: number,
): LimitedToolContent {
  const originalChars = contentChars(content);
  if (originalChars <= maxChars) {
    return { content: [...content], estimatedChars: originalChars, truncated: false };
  }

  const marker =
    "\n\n[tool output truncated by the task context budget; request a narrower endpoint, range, or extraction]";
  const contentBudget = Math.max(0, maxChars - marker.length);
  const limited: ToolContent[] = [];
  let used = 0;

  for (const part of content) {
    const remaining = contentBudget - used;
    if (remaining <= 0) break;

    if (part.type === "text") {
      const text = part.text.slice(0, remaining);
      if (text !== "") {
        limited.push({ ...part, text });
        used += text.length;
      }
      continue;
    }

    if (remaining >= IMAGE_ESTIMATED_CHARS) {
      limited.push(part);
      used += IMAGE_ESTIMATED_CHARS;
    }
  }

  limited.push({ type: "text", text: marker });
  return {
    content: limited,
    estimatedChars: used + marker.length,
    truncated: true,
  };
}

function effectiveRates(model: Model, inputTokens: number) {
  let rates = model.cost;
  for (const tier of [...(model.cost.tiers ?? [])].sort(
    (left, right) => left.inputTokensAbove - right.inputTokensAbove,
  )) {
    if (inputTokens > tier.inputTokensAbove) rates = tier;
  }
  return rates;
}

/**
 * Conservatively price the next provider call. Prompt-cache behavior varies by
 * provider, so input is charged at the larger of normal-input and cache-write
 * rates rather than assuming the cheaper path.
 */
export function estimateProviderCallCost(
  model: Model,
  inputTokens: number,
  outputTokens = OUTPUT_RESERVE_TOKENS,
): number {
  const rates = effectiveRates(model, inputTokens);
  const inputRate = Math.max(rates.input, rates.cacheWrite);
  return (inputTokens * inputRate + outputTokens * rates.output) / 1_000_000;
}

export function createBudgetExtension(options: BudgetExtensionOptions): HarnessExtension {
  return {
    name: "budget",
    factory: (pi) => {
      let turnToolChars = 0;
      let projectedCallCost = 0;

      const stopIfUnaffordable = (ctx: HarnessExtensionContext, projected: number): void => {
        const spent = options.getCurrentCostUsd();
        if (spent < options.maxCostUsd && spent + projected <= options.maxCostUsd) return;

        const note =
          spent >= options.maxCostUsd
            ? `cost limit of $${options.maxCostUsd.toFixed(2)} reached at $${spent.toFixed(4)} before another provider call`
            : `next provider call is projected to cost $${projected.toFixed(4)}, exceeding the $${options.maxCostUsd.toFixed(2)} task limit from $${spent.toFixed(4)} spent`;
        options.onCostLimit(note);
        ctx.abort();
      };

      pi.on("turn_start", () => {
        turnToolChars = 0;
      });

      pi.on("tool_result", (event) => {
        // An oversight result cut or omitted here would be recorded as
        // delivered while the model never read it: an answer A did not see, or
        // a batch whose ids B can no longer cite. Each is bounded by its own
        // tool, so it passes whole, and still counts towards the turn's total
        // so the calls after it are budgeted as before. A refusal is a thrown
        // error, a short fixed text the model can repeat, and is budgeted.
        if (isOversightTool(event.toolName) && !event.isError) {
          turnToolChars += contentChars(event.content);
          return undefined;
        }
        const remaining = options.maxToolResultCharsPerTurn - turnToolChars;
        if (remaining <= 0) {
          return {
            content: [
              {
                type: "text",
                text: "[tool output omitted: this turn's context budget is exhausted; use fewer or narrower calls next turn]",
              },
            ],
          };
        }

        const limited = limitToolContent(
          event.content,
          Math.min(options.maxToolResultChars, remaining),
        );
        turnToolChars += limited.estimatedChars;
        return limited.truncated ? { content: limited.content } : undefined;
      });

      pi.on("context", (event, ctx) => {
        const model = ctx.model;
        if (model === undefined) return;

        const messageTokens = event.messages.reduce(
          (total, message) => total + estimateTokens(message),
          0,
        );
        const systemPromptTokens = Math.ceil(ctx.getSystemPrompt().length / 4);
        const estimatedInputTokens =
          messageTokens + systemPromptTokens + PROVIDER_OVERHEAD_TOKENS;
        projectedCallCost = estimateProviderCallCost(model, estimatedInputTokens);
        stopIfUnaffordable(ctx, projectedCallCost);
      });

      pi.on("before_provider_request", (_event, ctx) => {
        stopIfUnaffordable(ctx, projectedCallCost);
      });
    },
  };
}
