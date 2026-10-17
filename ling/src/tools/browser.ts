import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { Type } from "typebox";
import type { Config } from "../config.js";
import { defineTool } from "../harness/index.js";
import { egressRefusal, resolveHost, sessionResolver, type EgressPolicy, type HostResolver } from "./http.js";
import type { AnyToolDefinition } from "./types.js";

const SNAPSHOT_ELEMENT_LIMIT = 250;
const SNAPSHOT_TEXT_LIMIT = 12_000;
const EXTRACT_LIMIT = 40_000;
const DEFAULT_ACTION_TIMEOUT_MS = 30_000;
const MAX_BLIND_WAIT_MS = 15_000;
// Lookups the request gate may have in flight at once, out of libuv's four
// threads, and how long it waits for one before refusing the request.
const LOOKUP_CONCURRENCY = 2;
const LOOKUP_TIMEOUT_MS = 10_000;

export interface BrowserToolsOptions {
  config: Config;
  workspaceDir: string;
  storageStatePath?: string;
  /**
   * Seams for the offline egress check: the resolver the private-network check
   * uses, and Chromium switches (--host-resolver-rules) that send the browser
   * to the same answers.
   */
  resolve?: HostResolver;
  chromiumArgs?: readonly string[];
}

export interface BrowserToolsHandle {
  tools: AnyToolDefinition[];
  /** Closes the browser and returns workspace-relative artifact paths. */
  close(): Promise<string[]>;
}

interface SnapshotResult {
  title: string;
  url: string;
  elements: string[];
  text: string;
  truncatedElements: boolean;
}

function formatSnapshot(snapshot: SnapshotResult): string {
  const text =
    snapshot.text.length > SNAPSHOT_TEXT_LIMIT
      ? `${snapshot.text.slice(0, SNAPSHOT_TEXT_LIMIT)}\n[text truncated]`
      : snapshot.text;

  return [
    `title: ${snapshot.title}`,
    `url: ${snapshot.url}`,
    "",
    "interactive elements (use these refs with browser_click and browser_type):",
    snapshot.elements.length > 0 ? snapshot.elements.join("\n") : "(none found)",
    snapshot.truncatedElements ? `[element list capped at ${SNAPSHOT_ELEMENT_LIMIT}]` : "",
    "",
    "page text:",
    text,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

class BrowserSession {
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  private screenshotCount = 0;
  private readonly artifactsDir: string;
  private tracing = false;
  readonly policy: EgressPolicy;
  private readonly refusedRedirects: string[] = [];
  private readonly pendingChecks = new Set<Promise<void>>();

  constructor(private readonly options: BrowserToolsOptions) {
    this.artifactsDir = path.join(options.workspaceDir, "artifacts");
    this.policy = {
      blockPrivateNetwork: options.config.blockPrivateNetwork,
      resolve: sessionResolver(options.resolve ?? resolveHost, LOOKUP_CONCURRENCY, LOOKUP_TIMEOUT_MS),
    };
  }

  async getPage(): Promise<Page> {
    if (this.page) return this.page;

    this.browser = await chromium.launch({
      headless: this.options.config.browserHeadless,
      ...(this.options.chromiumArgs !== undefined ? { args: [...this.options.chromiumArgs] } : {}),
    });

    const contextOptions: Parameters<Browser["newContext"]>[0] = {
      viewport: { width: 1280, height: 900 },
    };
    if (this.options.storageStatePath !== undefined) {
      contextOptions.storageState = this.options.storageStatePath;
    }
    // Requests a service worker makes are not routed, so they would go around the gate.
    if (this.policy.blockPrivateNetwork) contextOptions.serviceWorkers = "block";
    this.context = await this.browser.newContext(contextOptions);
    if (this.policy.blockPrivateNetwork) await this.gateEgress(this.context);

    // Transpilers with keepNames (tsx/esbuild) rewrite named inner functions to
    // calls to a `__name` helper that exists in the bundle but not in the page,
    // which breaks any evaluated function that declares helpers. Passing the
    // shim as a string keeps it out of that rewrite.
    await this.context.addInitScript({
      content: "window.__name = window.__name || function (value) { return value; };",
    });

    if (this.options.config.browserTrace) {
      await this.context.tracing.start({ screenshots: true, snapshots: true });
      this.tracing = true;
    }

    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(DEFAULT_ACTION_TIMEOUT_MS);
    return this.page;
  }

  /**
   * Puts what the context loads behind the egress policy: page loads,
   * subresources, popups and the WebSockets a page opens. Not covered: sockets
   * opened from a web worker, WebRTC, and Chromium's own DNS answer, which can
   * differ from the one the check saw.
   *
   * Playwright does not route the next hop of a redirect, so a public page
   * that redirects to a private address does reach it. Those hops are checked
   * as Playwright reports them, and a refused one fails the browser tool call
   * that is running, or the next one, and clears the page; see guarded(). The
   * request has gone by then; on a worker VM the firewall is what stops it.
   *
   * Names are resolved through a per-session cache, so the gate keeps the
   * first answer it got for a name while Chromium keeps resolving on its own.
   */
  private async gateEgress(context: BrowserContext): Promise<void> {
    await context.route(
      () => true,
      async (route) => {
        const refusal = await this.refusal(route.request().url());
        await (refusal === undefined ? route.continue() : route.abort("blockedbyclient")).catch(
          () => undefined,
        );
      },
    );

    await context.routeWebSocket(
      () => true,
      async (socket) => {
        // ws and wss go where http and https would, so they get the same check.
        const refusal = await this.refusal(socket.url().replace(/^ws(s?):/i, "http$1:"));
        if (refusal === undefined) {
          socket.connectToServer();
        } else {
          await socket.close({ code: 1008, reason: "BLOCK_PRIVATE_NETWORK" }).catch(() => undefined);
        }
      },
    );

    context.on("request", (request) => {
      if (request.redirectedFrom() === null) return;
      const check = this.refusal(request.url()).then((refusal) => {
        if (refusal !== undefined) this.refusedRedirects.push(refusal);
      });
      this.pendingChecks.add(check);
      void check.finally(() => this.pendingChecks.delete(check));
    });
  }

  private async refusal(raw: string): Promise<string | undefined> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return `Refused: ${raw} is not a valid URL.`;
    }
    return await egressRefusal(url, this.policy);
  }

  /**
   * Runs one browser tool's page work behind the redirect check. A refusal
   * already queued fails the call before the page is touched. One that
   * arrives while the work runs fails the call afterwards, whether the work
   * returned or threw, and replaces its error: a timeout's call log quotes the
   * elements it found, so an error can carry the page as well as a result can.
   * Either way the page is cleared. What still differs is how long the call
   * took, for example a wait that found its text against one that timed out.
   */
  async guarded<T>(work: () => Promise<T>): Promise<T> {
    await this.assertNoRefusedRedirect();
    let result: T;
    try {
      result = await work();
    } catch (error) {
      await this.assertNoRefusedRedirect();
      throw error;
    }
    await this.assertNoRefusedRedirect();
    return result;
  }

  /**
   * Fails, and clears the page, when a redirect since the last check reached
   * a refused destination.
   */
  async assertNoRefusedRedirect(): Promise<void> {
    while (this.pendingChecks.size > 0) await Promise.all(this.pendingChecks);
    const refused = this.refusedRedirects.splice(0);
    if (refused.length === 0) return;
    await this.page?.goto("about:blank").catch(() => undefined);
    throw new Error(
      `${refused[0]} A redirect led there, and a redirect cannot be stopped in flight, so the page was cleared instead of read.`,
    );
  }

  async snapshot(): Promise<SnapshotResult> {
    const page = await this.getPage();
    return page.evaluate((limit) => {
      for (const stale of Array.from(document.querySelectorAll("[data-agent-ref]"))) {
        stale.removeAttribute("data-agent-ref");
      }

      const selector = [
        "a[href]",
        "button",
        'input:not([type="hidden"])',
        "select",
        "textarea",
        '[role="button"]',
        '[role="link"]',
        '[role="tab"]',
        '[role="checkbox"]',
        '[role="radio"]',
        '[role="textbox"]',
        '[contenteditable="true"]',
        "summary",
      ].join(", ");

      const isVisible = (element: Element): boolean => {
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return false;
        const style = window.getComputedStyle(element);
        return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
      };

      const label = (element: Element): string => {
        const aria = element.getAttribute("aria-label");
        if (aria) return aria;
        const placeholder = element.getAttribute("placeholder");
        if (placeholder) return placeholder;
        const title = element.getAttribute("title");
        if (title) return title;
        const name = element.getAttribute("name");
        if (name) return name;
        const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
        return text.slice(0, 80);
      };

      const describe = (element: Element): string => {
        const parts: string[] = [element.tagName.toLowerCase()];
        const type = element.getAttribute("type");
        if (type) parts.push(`type=${type}`);
        const described = label(element);
        if (described) parts.push(`"${described}"`);
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          if (element.value) parts.push(`value="${element.value.slice(0, 40)}"`);
        }
        const href = element.getAttribute("href");
        if (href) parts.push(`href=${href.slice(0, 80)}`);
        if (element.hasAttribute("disabled")) parts.push("disabled");
        return parts.join(" ");
      };

      const elements: string[] = [];
      let index = 0;
      let truncatedElements = false;

      for (const element of Array.from(document.querySelectorAll(selector))) {
        if (index >= limit) {
          truncatedElements = true;
          break;
        }
        if (!isVisible(element)) continue;
        index += 1;
        const ref = `e${index}`;
        element.setAttribute("data-agent-ref", ref);
        elements.push(`${ref} ${describe(element)}`);
      }

      return {
        title: document.title,
        url: window.location.href,
        elements,
        text: (document.body?.innerText ?? "").trim(),
        truncatedElements,
      };
    }, SNAPSHOT_ELEMENT_LIMIT);
  }

  async locator(ref: string) {
    const page = await this.getPage();
    const escaped = ref.replace(/"/g, '\\"');
    return page.locator(`[data-agent-ref="${escaped}"]`).first();
  }

  async screenshot(fullPage: boolean): Promise<string> {
    const page = await this.getPage();
    await mkdir(this.artifactsDir, { recursive: true });
    this.screenshotCount += 1;
    const filePath = path.join(this.artifactsDir, `screenshot-${this.screenshotCount}.png`);
    await page.screenshot({ path: filePath, fullPage });
    // Checked here as well as by guarded(), so that a refused page's
    // screenshot is deleted rather than left in the artifacts.
    try {
      await this.assertNoRefusedRedirect();
    } catch (error) {
      await rm(filePath, { force: true });
      throw error;
    }
    return path.relative(this.options.workspaceDir, filePath);
  }

  async close(): Promise<string[]> {
    const artifacts: string[] = [];

    // Cleanup runs after the task has already produced its result, so a failure
    // here must never surface as a task failure.
    if (this.context && this.tracing) {
      try {
        await mkdir(this.artifactsDir, { recursive: true });
        const tracePath = path.join(this.artifactsDir, "trace.zip");
        await this.context.tracing.stop({ path: tracePath });
        artifacts.push(path.relative(this.options.workspaceDir, tracePath));
      } catch {
        // Trace capture is best effort.
      }
    }

    try {
      await this.context?.close();
    } catch {
      // Already gone.
    }
    try {
      await this.browser?.close();
    } catch {
      // Already gone.
    }

    this.page = undefined;
    this.context = undefined;
    this.browser = undefined;
    this.refusedRedirects.length = 0;
    return artifacts;
  }
}

export function createBrowserTools(options: BrowserToolsOptions): BrowserToolsHandle {
  const session = new BrowserSession(options);
  const screenshots: string[] = [];
  let closed: Promise<string[]> | undefined;

  const openTool = defineTool({
    name: "browser_open",
    label: "Browser Open",
    description:
      "Navigate a real browser to a URL and return a snapshot of the page: title, interactive element refs, and visible text.",
    promptSnippet: "browser_open: navigate the browser to a URL",
    parameters: Type.Object({
      url: Type.String({ description: "Absolute http:// or https:// URL to open" }),
      wait_until: Type.Optional(
        Type.String({
          description: "load | domcontentloaded | networkidle | commit. Default domcontentloaded.",
        }),
      ),
    }),
    execute: async (_id, params) => {
      let target: URL;
      try {
        target = new URL(params.url);
      } catch {
        throw new Error(`Not a valid URL: ${params.url}`);
      }
      // Checked before Chromium starts, so a refusal is cheap and says why.
      const refusal = await egressRefusal(target, session.policy);
      if (refusal !== undefined) throw new Error(refusal);

      const page = await session.getPage();
      const waitUntil = (params.wait_until ?? "domcontentloaded") as
        | "load"
        | "domcontentloaded"
        | "networkidle"
        | "commit";
      await page.goto(target.href, { waitUntil });
      const snapshot = await session.snapshot();
      return {
        content: [{ type: "text" as const, text: formatSnapshot(snapshot) }],
        details: { url: snapshot.url, title: snapshot.title, elements: snapshot.elements.length },
      };
    },
  });

  const snapshotTool = defineTool({
    name: "browser_snapshot",
    label: "Browser Snapshot",
    description:
      "Re-read the current page and return fresh element refs plus visible text. Call this after any navigation or action that changes the page, because previous refs go stale.",
    promptSnippet: "browser_snapshot: list current page elements and text",
    parameters: Type.Object({}),
    execute: async () => {
      const snapshot = await session.snapshot();
      return {
        content: [{ type: "text" as const, text: formatSnapshot(snapshot) }],
        details: { url: snapshot.url, title: snapshot.title, elements: snapshot.elements.length },
      };
    },
  });

  const clickTool = defineTool({
    name: "browser_click",
    label: "Browser Click",
    description:
      "Click an element by the ref shown in the latest browser_snapshot. Waits for the element to be actionable first.",
    promptSnippet: "browser_click: click an element by snapshot ref",
    parameters: Type.Object({
      ref: Type.String({ description: 'Element ref from a snapshot, for example "e7"' }),
    }),
    execute: async (_id, params) => {
      const locator = await session.locator(params.ref);
      await locator.click();
      const snapshot = await session.snapshot();
      return {
        content: [
          {
            type: "text" as const,
            text: `clicked ${params.ref}\n\n${formatSnapshot(snapshot)}`,
          },
        ],
        details: { ref: params.ref, url: snapshot.url },
      };
    },
  });

  const typeTool = defineTool({
    name: "browser_type",
    label: "Browser Type",
    description:
      "Fill text into an input, textarea or contenteditable element identified by a snapshot ref. Optionally press Enter afterwards.",
    promptSnippet: "browser_type: enter text into a field by snapshot ref",
    parameters: Type.Object({
      ref: Type.String({ description: "Element ref from a snapshot" }),
      text: Type.String({ description: "Text to enter" }),
      submit: Type.Optional(Type.Boolean({ description: "Press Enter after typing" })),
    }),
    execute: async (_id, params) => {
      const locator = await session.locator(params.ref);
      await locator.fill(params.text);
      if (params.submit === true) {
        await locator.press("Enter");
      }
      const snapshot = await session.snapshot();
      return {
        content: [
          {
            type: "text" as const,
            text: `typed into ${params.ref}${params.submit === true ? " and pressed Enter" : ""}\n\n${formatSnapshot(snapshot)}`,
          },
        ],
        details: { ref: params.ref, url: snapshot.url },
      };
    },
  });

  const extractTool = defineTool({
    name: "browser_extract",
    label: "Browser Extract",
    description:
      "Extract text or HTML from the whole page or from one element. Use this to read content rather than taking screenshots.",
    promptSnippet: "browser_extract: read text or HTML from the page",
    parameters: Type.Object({
      ref: Type.Optional(Type.String({ description: "Element ref. Omit for the whole page." })),
      format: Type.Optional(Type.String({ description: "text or html. Default text." })),
    }),
    execute: async (_id, params) => {
      const page = await session.getPage();
      const wantsHtml = (params.format ?? "text").toLowerCase() === "html";

      let value: string;
      if (params.ref !== undefined) {
        const locator = await session.locator(params.ref);
        value = wantsHtml ? await locator.innerHTML() : await locator.innerText();
      } else if (wantsHtml) {
        value = await page.content();
      } else {
        value = await page.evaluate(() => (document.body?.innerText ?? "").trim());
      }

      const truncated = value.length > EXTRACT_LIMIT;
      return {
        content: [
          {
            type: "text" as const,
            text: truncated ? `${value.slice(0, EXTRACT_LIMIT)}\n[truncated]` : value,
          },
        ],
        details: { truncated, length: value.length },
      };
    },
  });

  const waitForTool = defineTool({
    name: "browser_wait_for",
    label: "Browser Wait",
    description:
      "Wait for text to appear or a CSS selector to become visible. Prefer this over sleeping. With neither argument it waits a fixed delay, capped at 15 seconds.",
    promptSnippet: "browser_wait_for: wait for text or a selector",
    parameters: Type.Object({
      text: Type.Optional(Type.String({ description: "Visible text to wait for" })),
      selector: Type.Optional(Type.String({ description: "CSS selector to wait for" })),
      timeout_ms: Type.Optional(Type.Number({ description: "Timeout, default 30000" })),
    }),
    execute: async (_id, params) => {
      const page = await session.getPage();
      const timeout = params.timeout_ms ?? DEFAULT_ACTION_TIMEOUT_MS;

      if (params.selector !== undefined) {
        await page.locator(params.selector).first().waitFor({ state: "visible", timeout });
      } else if (params.text !== undefined) {
        await page.getByText(params.text).first().waitFor({ state: "visible", timeout });
      } else {
        await page.waitForTimeout(Math.min(timeout, MAX_BLIND_WAIT_MS));
      }

      const snapshot = await session.snapshot();
      return {
        content: [{ type: "text" as const, text: formatSnapshot(snapshot) }],
        details: { url: snapshot.url },
      };
    },
  });

  const screenshotTool = defineTool({
    name: "browser_screenshot",
    label: "Browser Screenshot",
    description:
      "Save a PNG screenshot into the task artifacts directory and return its path. Use it as evidence or when layout matters, not as a way to read text.",
    promptSnippet: "browser_screenshot: save a screenshot to artifacts",
    parameters: Type.Object({
      full_page: Type.Optional(Type.Boolean({ description: "Capture the full scrollable page" })),
    }),
    execute: async (_id, params) => {
      const relativePath = await session.screenshot(params.full_page === true);
      screenshots.push(relativePath);
      return {
        content: [{ type: "text" as const, text: `screenshot saved to ${relativePath}` }],
        details: { path: relativePath },
      };
    },
  });

  // Every tool's page work runs behind the redirect check, including the work
  // that fails; see guarded().
  const guard = (tool: AnyToolDefinition): AnyToolDefinition => ({
    ...tool,
    execute: async (...args: Parameters<AnyToolDefinition["execute"]>) =>
      await session.guarded(() => tool.execute(...args)),
  });

  return {
    tools: [
      openTool,
      snapshotTool,
      clickTool,
      typeTool,
      extractTool,
      waitForTool,
      screenshotTool,
    ].map(guard),
    // Memoized so a repeated close returns the same artifact list instead of
    // reporting the screenshots a second time.
    close: async () => {
      closed ??= session.close().then((artifacts) => [...screenshots, ...artifacts]);
      return await closed;
    },
  };
}

export const browserToolNames = [
  "browser_open",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_extract",
  "browser_wait_for",
  "browser_screenshot",
] as const;
