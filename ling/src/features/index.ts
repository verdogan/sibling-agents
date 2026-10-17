import type { HarnessExtension } from "../harness/index.js";
import { agentBrowserFeature } from "./agent-browser.js";
import { createBudgetExtension, type BudgetExtensionOptions } from "./budget.js";
import { campaignFeature } from "./campaign.js";
import { findingsFeature, verificationFeature } from "./findings.js";
import { createGuardExtension } from "./guards.js";
import { intentFeature } from "./intent.js";
import { workerOversightFeature } from "./oversight.js";
import { playwrightBrowserFeature } from "./playwright-browser.js";
import type { Feature, FeatureContext } from "./types.js";
import { watcherFeature } from "./watcher.js";
import { writeResultFeature } from "./write-result.js";

export type { Feature, FeatureContext } from "./types.js";

/**
 * Every optional feature the service can offer a task. The oversight features
 * come first so that a watcher reads its role before how to write its report.
 */
export const availableFeatures: readonly Feature[] = [
  workerOversightFeature,
  watcherFeature,
  writeResultFeature,
  findingsFeature,
  verificationFeature,
  agentBrowserFeature,
  playwrightBrowserFeature,
  campaignFeature,
  intentFeature,
];

export const featureToolNames: readonly string[] = availableFeatures.flatMap(
  (feature) => feature.toolNames ?? [],
);

export interface ComposedFeatures {
  /** Inline extensions to hand to the harness, guards first. */
  extensions: HarnessExtension[];
  /** Skill directories to load, and the only paths readable outside the workspace. */
  skillPaths: string[];
  /** System-prompt sections contributed by the active features. */
  promptSections: string[];
}

/**
 * Assemble the extensions for one task.
 *
 * A feature is active when the task enabled at least one of its tools, so the
 * prompt, the skills, and the tools a run carries always agree. Guards go first
 * so their `tool_call` handler sees a call before any feature handler does. A
 * feature's pre-budget extension sits between the guards and the budget, so the
 * budget prices the context that extension leaves, which is what is sent.
 */
export function composeFeatures(
  ctx: FeatureContext,
  enabledToolNames: readonly string[],
  budget: BudgetExtensionOptions,
  requestedSkillPaths: readonly string[] = [],
): ComposedFeatures {
  const enabled = new Set(enabledToolNames);
  const active = availableFeatures.filter((feature) =>
    (feature.toolNames ?? []).some((name) => enabled.has(name)),
  );

  const featureSkillPaths = active.flatMap((feature) => [
    ...(feature.skillPaths?.(ctx) ?? []),
  ]);
  const skillPaths = [...new Set([...featureSkillPaths, ...requestedSkillPaths])];

  const guards = createGuardExtension(ctx, {
    // Skill files are injected into the prompt as a name and a path, so the model
    // has to read the file itself. Only those directories open up, which keeps
    // the credentials sitting elsewhere in agentDir unreadable.
    trustedReadRoots: skillPaths,
    agentBrowserToolAvailable: enabled.has("agent_browser"),
  });

  return {
    extensions: [
      guards,
      ...active.flatMap((feature) =>
        feature.preBudgetExtension === undefined ? [] : [feature.preBudgetExtension(ctx)],
      ),
      createBudgetExtension(budget),
      ...active.map((feature) => feature.extension(ctx)),
    ],
    skillPaths,
    promptSections: active.flatMap((feature) => [...(feature.promptSections?.(ctx) ?? [])]),
  };
}
