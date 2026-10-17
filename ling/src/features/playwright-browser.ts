import type { HarnessExtension } from "../harness/index.js";
import { browserToolNames, createBrowserTools } from "../tools/browser.js";
import { onShutdownOnce } from "./lifecycle.js";
import type { Feature, FeatureContext } from "./types.js";

/**
 * The structured Playwright tools: browser_open, browser_click, and friends.
 *
 * These predate agent-browser and stay for the case it does not cover: a saved
 * login state. A task's `storageState` reaches these tools and not agent-browser.
 * Chromium starts lazily on the first call, so an active-but-unused feature
 * costs nothing.
 */
export const playwrightBrowserFeature: Feature = {
  name: "playwright-browser",

  toolNames: browserToolNames,

  promptSections: () => [
    `## Playwright browser tools

Call browser_snapshot first: it returns the interactive elements on the page
with short refs such as e4. browser_click and browser_type take those refs.
Refs are invalidated whenever the page changes, so take a fresh snapshot after
navigation or any action that re-renders the page.`,
  ],

  extension: (ctx: FeatureContext): HarnessExtension => ({
    name: "playwright-browser",
    factory: (pi) => {
      const handle = createBrowserTools({
        config: ctx.config,
        workspaceDir: ctx.workspaceDir,
        ...(ctx.storageStatePath !== undefined ? { storageStatePath: ctx.storageStatePath } : {}),
      });

      for (const tool of handle.tools) {
        pi.registerTool(tool);
      }

      onShutdownOnce(pi, async () => {
        ctx.onArtifacts(await handle.close());
      });
    },
  }),
};
