/**
 * Exercises http_request and every browser tool against a local fixture page.
 * Needs no API key and no internet: it starts its own HTTP server, drives a
 * real headless Chromium against it, and asserts on what comes back.
 */
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { config } from "../config.js";
import { createBrowserTools } from "../tools/browser.js";
import { createHttpTool } from "../tools/http.js";

const FIXTURE_HTML = `<!doctype html>
<html>
  <head><title>Fixture Page</title></head>
  <body>
    <h1>Tools Check Fixture</h1>
    <p id="marker">fixture-marker-9182</p>
    <input id="name" type="text" name="visitor" placeholder="your name" />
    <button id="greet">Greet</button>
    <p id="greeting"></p>
    <a href="/second">second page</a>
    <script>
      document.getElementById("greet").addEventListener("click", () => {
        const value = document.getElementById("name").value;
        document.getElementById("greeting").textContent = "Hello, " + value + "!";
      });
    </script>
  </body>
</html>`;

interface ToolLike {
  name: string;
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<{ content: Array<{ type: string; text?: string }>; details?: unknown }>;
}

let failures = 0;

function report(label: string, passed: boolean, detail = ""): void {
  console.log(`${passed ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!passed) failures += 1;
}

async function call(tool: unknown, params: unknown): Promise<string> {
  const executable = tool as unknown as ToolLike;
  const result = await executable.execute("tools-check", params, undefined, undefined, undefined);
  return result.content.map((part) => part.text ?? "").join("\n");
}

const server = createServer((req, res) => {
  if (req.url === "/large") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("x".repeat(config.httpMaxBodyChars * 2));
    return;
  }
  if (req.url === "/redirect") {
    res.writeHead(302, { location: "/second" });
    res.end();
    return;
  }
  if (req.url === "/second") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><head><title>Second</title></head><body><p>second-page-content</p></body></html>");
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(FIXTURE_HTML);
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;

const workspaceDir = path.join(config.workspacesDir, "__tools_check__");
await rm(workspaceDir, { recursive: true, force: true });
await mkdir(workspaceDir, { recursive: true });

const httpTool = createHttpTool(config);
const browser = createBrowserTools({ config, workspaceDir });
const byName = new Map(browser.tools.map((tool) => [tool.name, tool]));

try {
  const httpBody = await call(httpTool, { url: base });
  report(
    "http_request fetches a page",
    httpBody.includes("200 OK") && httpBody.includes("fixture-marker-9182"),
    httpBody.split("\n")[1] ?? "",
  );

  const largeHttpBody = await call(httpTool, { url: `${base}/large` });
  report(
    "http_request bounds large response bodies",
    largeHttpBody.includes(`body truncated to ${config.httpMaxBodyChars}`) &&
      largeHttpBody.length < config.httpMaxBodyChars + 500,
    `${largeHttpBody.length} chars returned`,
  );

  const redirected = await call(httpTool, { url: `${base}/redirect` });
  report(
    "http_request follows a redirect and lists the hop",
    redirected.includes(`-> 302 ${base}/second`) && redirected.includes("second-page-content"),
    redirected.split("\n").slice(0, 3).join(" | "),
  );

  const refusedScheme = await call(byName.get("browser_open"), { url: "file:///etc/passwd" }).catch(
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
  report("browser_open refuses a non-http URL", refusedScheme.startsWith("Refused"), refusedScheme);

  const opened = await call(byName.get("browser_open"), { url: base });
  report("browser_open returns a snapshot", opened.includes("title: Fixture Page"), "");

  const inputRef = /^(e\d+) input/m.exec(opened)?.[1];
  const buttonRef = /^(e\d+) BUTTON|^(e\d+) button/m.exec(opened);
  const resolvedButtonRef = buttonRef?.[1] ?? buttonRef?.[2];
  report(
    "snapshot exposes refs for the input and button",
    inputRef !== undefined && resolvedButtonRef !== undefined,
    `input=${inputRef ?? "none"} button=${resolvedButtonRef ?? "none"}`,
  );

  if (inputRef !== undefined && resolvedButtonRef !== undefined) {
    await call(byName.get("browser_type"), { ref: inputRef, text: "Playwright" });
    await call(byName.get("browser_click"), { ref: resolvedButtonRef });

    const extracted = await call(byName.get("browser_extract"), {});
    report("typing and clicking changed the page", extracted.includes("Hello, Playwright!"), "");

    const waited = await call(byName.get("browser_wait_for"), { text: "Hello, Playwright!" });
    report("browser_wait_for finds visible text", waited.includes("Hello, Playwright!"), "");
  }

  const html = await call(byName.get("browser_extract"), { format: "html" });
  report("browser_extract can return HTML", html.includes('id="marker"'), "");

  const shot = await call(byName.get("browser_screenshot"), {});
  const shotPath = /screenshot saved to (.+)/.exec(shot)?.[1]?.trim();
  const shotExists = shotPath !== undefined && existsSync(path.join(workspaceDir, shotPath));
  report("browser_screenshot writes a file into artifacts", shotExists, shotPath ?? "no path returned");

  report(
    "browser_script is gone from the browser tools",
    !byName.has("browser_script"),
    [...byName.keys()].join(", "),
  );

  const snapshotAfterNav = await call(byName.get("browser_open"), { url: `${base}/second` });
  report(
    "browser_open follows a second navigation",
    snapshotAfterNav.includes("second-page-content"),
    "",
  );

  const rejected = await call(byName.get("browser_snapshot"), {}).catch((error: unknown) =>
    error instanceof Error ? error.message : String(error),
  );
  report("browser_snapshot works after navigation", rejected.includes("title: Second"), "");
} finally {
  const artifacts = await browser.close();
  console.log(`artifacts captured: ${artifacts.length > 0 ? artifacts.join(", ") : "none"}`);
  server.close();
  await rm(workspaceDir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nall tool checks passed" : `\n${failures} tool check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
