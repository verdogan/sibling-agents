/**
 * Offline check of the egress policy: the address and name rules, the default
 * for local child lings, the browser session's resolver, redirects in
 * http_request, the browser's request gate, agent_browser's commands,
 * navigation targets, refused flags and host files, the configuration file
 * the agent-browser CLI reads, and the environment it inherits. Needs no API
 * key and no internet. DNS answers come from the table below, one local
 * server plays both the "public" and the private hosts, and Chromium is sent
 * to it with --host-resolver-rules. The browser section drives a real
 * headless Chromium, as tools-check does. The configuration section runs the
 * pinned agent-browser binary, but only `plugin list`, which starts neither a
 * browser nor a daemon.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  agentBrowserConfigDir,
  agentBrowserEnvironment,
  assertAgentBrowserInstalled,
  runAgentBrowser,
} from "../agent-browser.js";
import { config } from "../config.js";
import { agentBrowserFeature, agentBrowserRefusal } from "../features/agent-browser.js";
import { inertOversight } from "../features/oversight.js";
import type { HarnessExtensionApi } from "../harness/index.js";
import { createBrowserTools } from "../tools/browser.js";
import {
  createHttpTool,
  egressRefusal,
  isPrivateAddress,
  resolveHost,
  sessionResolver,
  type EgressPolicy,
  type HostResolver,
} from "../tools/http.js";

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

const execFileAsync = promisify(execFile);
let failures = 0;

function report(label: string, passed: boolean, detail = ""): void {
  console.log(`${passed ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!passed) failures += 1;
}

/** Runs a tool and returns its text, or the message it failed with. */
async function attempt(tool: unknown, params: unknown): Promise<{ ok: boolean; text: string }> {
  try {
    const result = await (tool as ToolLike).execute("egress-check", params);
    return { ok: true, text: result.content.map((part) => part.text ?? "").join("\n") };
  } catch (error) {
    return { ok: false, text: error instanceof Error ? error.message : String(error) };
  }
}

const dnsTable: Record<string, string[]> = {
  "public.test": ["203.0.113.7"],
  "public2.test": ["203.0.113.8"],
  "fda.gov": ["203.0.113.9"],
  "v6.test": ["2606:4700:4700::1111"],
  "rebind.test": ["127.0.0.1"],
  "mixed.test": ["203.0.113.10", "10.0.0.10"],
  "mapped.test": ["::ffff:7f00:1"],
  "ula.test": ["fd00::1"],
  "nat64.test": ["64:ff9b::a9fe:a9fe"],
};
const resolverCalls: string[] = [];
const resolve: HostResolver = async (hostname) => {
  resolverCalls.push(hostname);
  const answer = dnsTable[hostname];
  if (answer === undefined) throw new Error(`getaddrinfo ENOTFOUND ${hostname}`);
  return answer;
};
const blocking: EgressPolicy = { blockPrivateNetwork: true, resolve };

async function refusedAll(urls: string[], policy: EgressPolicy): Promise<string[]> {
  const passed: string[] = [];
  for (const url of urls) {
    if ((await egressRefusal(new URL(url), policy)) === undefined) passed.push(url);
  }
  return passed;
}

async function allowedAll(urls: string[], policy: EgressPolicy): Promise<string[]> {
  const refused: string[] = [];
  for (const url of urls) {
    const refusal = await egressRefusal(new URL(url), policy);
    if (refusal !== undefined) refused.push(`${url}: ${refusal}`);
  }
  return refused;
}

async function checkRefused(label: string, urls: string[], policy = blocking): Promise<void> {
  const through = await refusedAll(urls, policy);
  report(label, through.length === 0, through.length === 0 ? `${urls.length} refused` : `got through: ${through.join(", ")}`);
}

async function checkAllowed(label: string, urls: string[], policy = blocking): Promise<void> {
  const refused = await allowedAll(urls, policy);
  report(label, refused.length === 0, refused.length === 0 ? `${urls.length} allowed` : refused.join("; "));
}

// --- Address and name rules -------------------------------------------------

report(
  "the URL parser renders [::ffff:127.0.0.1] as ::ffff:7f00:1, and that is private",
  new URL("http://[::ffff:127.0.0.1]/").hostname === "[::ffff:7f00:1]" && isPrivateAddress("::ffff:7f00:1"),
  new URL("http://[::ffff:127.0.0.1]/").hostname,
);
await checkRefused("IPv4-mapped IPv6 literals are refused", [
  "http://[::ffff:127.0.0.1]/",
  "http://[::ffff:169.254.169.254]/latest/meta-data/",
  "http://[::ffff:10.0.0.1]/",
  "http://[::ffff:8.8.8.8]/",
]);
await checkRefused("unique-local, link-local and other private IPv6 literals are refused", [
  "http://[fc00::1]/",
  "http://[fd00:ec2::254]/",
  "http://[fe80::1]/",
  "http://[fec0::1]/",
  "http://[ff02::1]/",
  "http://[::1]/",
  "http://[::]/",
  "http://[::127.0.0.1]/",
]);
await checkRefused("NAT64 and 6to4 addresses carrying a private IPv4 address are refused, and local-use NAT64 and discard", [
  "http://[64:ff9b::a9fe:a9fe]/",
  "http://[64:ff9b::10.0.0.5]/",
  "http://[64:ff9b::7f00:1]/",
  "http://[2002:a9fe:a9fe::1]/",
  "http://[2002:7f00:1::]/",
  "http://[64:ff9b:1::a00:5]/",
  "http://[100::1]/",
]);
await checkRefused("CGNAT 100.64.0.0/10 and 0.0.0.0/8 literals are refused", [
  "http://100.64.0.1/",
  "http://100.100.100.200/",
  "http://100.127.255.255/",
  "http://0.0.0.0/",
  "http://0.1.2.3/",
]);
await checkRefused("loopback, private and metadata literals are refused in every spelling", [
  "http://127.0.0.1:8787/",
  "http://127.1/",
  "http://2130706433/",
  "http://0x7f000001/",
  "http://10.1.2.3/",
  "http://172.16.0.1/",
  "http://172.31.255.255/",
  "http://192.168.1.1/",
  "http://169.254.169.254/latest/meta-data/",
  "http://192.0.0.192/",
  "http://198.18.0.1/",
  "http://224.0.0.1/",
  "http://255.255.255.255/",
]);
await checkAllowed("public literals next to the private blocks are allowed", [
  "http://8.8.8.8/",
  "https://1.1.1.1/",
  "http://100.63.255.255/",
  "http://100.128.0.1/",
  "http://172.32.0.1/",
  "http://192.169.0.1/",
  "http://[2606:4700:4700::1111]/",
  "http://[2001:4860:4860::8888]/",
  "http://[64:ff9b::808:808]/",
  "http://[2002:808:808::1]/",
]);

resolverCalls.length = 0;
await checkRefused("local names are refused, trailing dot and case included", [
  "http://localhost/",
  "http://LOCALHOST./",
  "http://localhost.:8787/",
  "http://api.localhost/",
  "http://printer.local/",
  "http://metadata.google.internal/computeMetadata/v1/",
]);
report("local names are refused without asking DNS", resolverCalls.length === 0, resolverCalls.join(", "));

const rebind = await egressRefusal(new URL("http://rebind.test/"), blocking);
report(
  "a name that resolves to loopback is refused",
  rebind?.includes("resolves to 127.0.0.1") === true,
  rebind ?? "allowed",
);
await checkRefused("a name with any private answer is refused", [
  "http://mixed.test/",
  "http://mapped.test/",
  "http://ula.test/",
  "http://nat64.test/",
]);
const unresolved = await egressRefusal(new URL("http://nosuch.test/"), blocking);
report("a name that does not resolve is refused", unresolved?.includes("did not resolve") === true, unresolved ?? "allowed");
await checkAllowed("names with only public answers are allowed, fda.gov included", [
  "https://public.test/",
  "https://fda.gov/",
  "https://v6.test/",
]);

const systemLocalhost = await resolveHost("localhost");
report(
  "the system resolver answers localhost with private addresses only",
  systemLocalhost.length > 0 && systemLocalhost.every(isPrivateAddress),
  systemLocalhost.join(", "),
);
const realLocalhost = await egressRefusal(new URL("http://localhost:8787/"), { blockPrivateNetwork: true });
report("localhost is refused with the real resolver", realLocalhost !== undefined, realLocalhost ?? "allowed");

const open: EgressPolicy = { blockPrivateNetwork: false, resolve };
await checkAllowed("with BLOCK_PRIVATE_NETWORK off, private destinations are allowed", ["http://127.0.0.1:8787/", "http://rebind.test/"], open);
await checkRefused(
  "with BLOCK_PRIVATE_NETWORK off, non-http schemes are still refused",
  ["file:///etc/passwd", "ftp://example.com/", "javascript:alert(1)", "data:text/html,hi", "ws://example.com/"],
  open,
);

// --- The default for local child lings ------------------------------------------

/**
 * blockPrivateNetwork as config.ts works it out in a fresh process with `env`
 * added, run from an empty directory so that no .env is read.
 */
async function blockPrivateNetworkDefault(env: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "egress-check-"));
  // config.ts has loaded this process's .env into process.env, so its
  // settings are taken out rather than handed on.
  const base: NodeJS.ProcessEnv = { ...process.env };
  delete base["BLOCK_PRIVATE_NETWORK"];
  delete base["WORKER_ID"];
  const configUrl = new URL("../config.ts", import.meta.url).href;
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        "--input-type=module",
        "--eval",
        `const { config } = await import(${JSON.stringify(configUrl)}); console.log(config.blockPrivateNetwork);`,
      ],
      { cwd: directory, env: { ...base, ...env } },
    );
    return stdout.trim();
  } catch (error) {
    return `failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const defaults = await Promise.all([
  blockPrivateNetworkDefault({ WORKER_ID: "local-3f9c" }),
  blockPrivateNetworkDefault({ WORKER_ID: "local" }),
  blockPrivateNetworkDefault({ WORKER_ID: "worker-a" }),
  blockPrivateNetworkDefault({ WORKER_ID: "local-3f9c", BLOCK_PRIVATE_NETWORK: "false" }),
]);
report(
  "BLOCK_PRIVATE_NETWORK defaults on for a local child ling only, and an explicit false still wins",
  defaults.join(",") === "true,false,false,false",
  `local-*: ${defaults[0]}, local: ${defaults[1]}, worker-a: ${defaults[2]}, local-* set to false: ${defaults[3]}`,
);

// --- The browser session's resolver -------------------------------------------

const lookups: string[] = [];
let inFlight = 0;
let mostInFlight = 0;
// "late" names answer after a second, every other name after 100 ms.
const slowResolve: HostResolver = async (hostname) => {
  lookups.push(hostname);
  inFlight += 1;
  mostInFlight = Math.max(mostInFlight, inFlight);
  await new Promise((done) => setTimeout(done, hostname.startsWith("late") ? 1_000 : 100));
  inFlight -= 1;
  return ["203.0.113.20"];
};

const cached = sessionResolver(slowResolve, 2, 5_000);
await Promise.all([cached("same.test"), cached("same.test")]);
await cached("same.test");
report(
  "the session resolver looks a name up once and reuses the answer",
  lookups.filter((name) => name === "same.test").length === 1,
  `${lookups.filter((name) => name === "same.test").length} lookup(s) of same.test for three calls`,
);

await Promise.all(["n1", "n2", "n3", "n4", "n5", "n6"].map((name) => cached(`${name}.test`)));
report("the session resolver runs at most two lookups at once", mostInFlight === 2, `at most ${mostInFlight} at once`);

const impatient = sessionResolver(slowResolve, 2, 200);
const lateStarted = Date.now();
const late = await egressRefusal(new URL("http://late.test/"), { blockPrivateNetwork: true, resolve: impatient });
const lateElapsed = Date.now() - lateStarted;
report(
  "a name that does not answer within the session resolver's timeout is refused, without waiting for it",
  late?.includes("did not resolve (no answer within 200ms)") === true && lateElapsed < 900,
  `${lateElapsed}ms: ${late ?? "allowed"}`,
);
await impatient("late.test").catch(() => undefined);
report(
  "the session resolver does not remember a failure",
  lookups.filter((name) => name === "late.test").length === 2,
  `${lookups.filter((name) => name === "late.test").length} lookup(s) of late.test`,
);

// --- Fixture server -----------------------------------------------------------

const hits: string[] = [];
let port = 0;

function sendPage(res: import("node:http").ServerResponse, html: string): void {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(html);
}

function echo(req: IncomingMessage, body: string): string {
  return `final-marker method=${req.method ?? ""} auth=${req.headers.authorization ?? "none"} body=${body || "none"}`;
}

const server = createServer((req, res) => {
  const url = req.url ?? "/";
  let body = "";
  req.on("data", (chunk: Buffer) => {
    body += chunk.toString("utf8");
  });
  req.on("end", () => {
    if (url.startsWith("/hit/")) {
      hits.push(url);
      sendPage(res, "<html><head><title>Secret</title></head><body><p>secret-marker-5521</p></body></html>");
      return;
    }
    const redirects: Record<string, [number, string]> = {
      "/redirect-public": [302, `http://public.test:${port}/final`],
      "/redirect-cross-origin": [302, `http://public2.test:${port}/final`],
      "/redirect-303": [303, `/final`],
      "/redirect-307": [307, `/final`],
      "/redirect-private": [302, `http://127.0.0.1:${port}/hit/redirect-private`],
      "/redirect-rebind": [302, `http://rebind.test:${port}/hit/redirect-rebind`],
      "/redirect-mapped": [301, `http://[::ffff:127.0.0.1]:${port}/hit/redirect-mapped`],
      "/redirect-metadata": [302, "http://169.254.169.254/latest/meta-data/"],
      "/redirect-file": [302, "file:///etc/passwd"],
      "/loop": [302, "/loop"],
    };
    const redirect = redirects[url];
    if (redirect !== undefined) {
      res.writeHead(redirect[0], { location: redirect[1] });
      res.end("moved");
      return;
    }
    if (url === "/final") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(echo(req, body));
      return;
    }
    if (url === "/later-private") {
      // A public page that goes through the refused redirect on its own, after
      // the call that opened it has returned.
      sendPage(
        res,
        `<!doctype html><html><head><title>Later Page</title></head><body><p>later-page-marker</p>
<script>setTimeout(() => { location.href = "/redirect-private"; }, 1500);</script></body></html>`,
      );
      return;
    }
    sendPage(
      res,
      `<!doctype html><html><head><title>Public Page</title></head><body>
<p>public-page-marker</p>
<img src="http://public.test:${port}/hit/img-public">
<img src="http://127.0.0.1:${port}/hit/img-literal">
<img src="http://rebind.test:${port}/hit/img-rebind">
<a href="http://127.0.0.1:${port}/hit/link">private link</a>
<p id="ws">ws-pending</p>
<script>
  fetch("http://127.0.0.1:${port}/hit/fetch-literal", { mode: "no-cors" }).catch(() => undefined);
  const socket = new WebSocket("ws://127.0.0.1:${port}/hit/ws");
  socket.onclose = (event) => { document.getElementById("ws").textContent = "ws-closed-" + event.code; };
</script>
</body></html>`,
    );
  });
});

await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
port = (server.address() as AddressInfo).port;
const publicBase = `http://public.test:${port}`;

const workspaceDir = path.join(config.workspacesDir, "__egress_check__");
await rm(workspaceDir, { recursive: true, force: true });
await mkdir(workspaceDir, { recursive: true });

const blockingConfig = { ...config, blockPrivateNetwork: true };
const browser = createBrowserTools({
  config: blockingConfig,
  workspaceDir,
  resolve,
  chromiumArgs: [`--host-resolver-rules=MAP public.test 127.0.0.1, MAP rebind.test 127.0.0.1`],
});
const byName = new Map(browser.tools.map((tool) => [tool.name, tool]));

try {
  // --- http_request redirects ---------------------------------------------------

  // fetch is handed the fixture for the two "public" names; the policy still
  // sees the answers in the table above, so nothing private is ever fetched.
  const routedFetch: typeof fetch = (input, init) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    if (target.hostname === "public.test" || target.hostname === "public2.test") target.hostname = "127.0.0.1";
    return fetch(target, init);
  };
  const http = createHttpTool(blockingConfig, { resolve, fetch: routedFetch });

  const followed = await attempt(http, { url: `${publicBase}/redirect-public` });
  report(
    "http_request follows a redirect to a public host and lists the hop",
    followed.ok && followed.text.includes(`-> 302 ${publicBase}/final`) && followed.text.includes("final-marker"),
    followed.text.split("\n").slice(0, 3).join(" | "),
  );

  const direct = await attempt(http, { url: `http://rebind.test:${port}/hit/direct-rebind` });
  const directLocal = await attempt(http, { url: `http://localhost:${port}/hit/direct-localhost` });
  report(
    "http_request refuses a name that resolves to loopback, and localhost",
    !direct.ok && direct.text.includes("resolves to 127.0.0.1") && !directLocal.ok && directLocal.text.includes("Refused"),
    `${direct.text.slice(0, 70)} | ${directLocal.text.slice(0, 70)}`,
  );

  for (const [route, expected] of [
    ["/redirect-private", "127.0.0.1 is a private or loopback address"],
    ["/redirect-rebind", "resolves to 127.0.0.1"],
    ["/redirect-mapped", "is a private or loopback address"],
    ["/redirect-metadata", "169.254.169.254 is a private or loopback address"],
    ["/redirect-file", "only http and https"],
  ] as const) {
    const result = await attempt(http, { url: `${publicBase}${route}` });
    report(
      `http_request refuses the hop of ${route}`,
      !result.ok && result.text.includes(expected) && result.text.includes("redirect from"),
      result.text.slice(0, 140),
    );
  }
  report(
    "nothing http_request refused reached the fixture",
    !hits.some((hit) => hit.startsWith("/hit/redirect-") || hit.startsWith("/hit/direct-")),
    hits.join(", ") || "no hits",
  );

  const loop = await attempt(http, { url: `${publicBase}/loop` });
  report("http_request stops a redirect loop", !loop.ok && loop.text.includes("stopped after 20 redirects"), loop.text);

  const seeOther = await attempt(http, { url: `${publicBase}/redirect-303`, method: "POST", body: "payload" });
  report(
    "a 303 turns a POST into a GET without the body",
    seeOther.ok && seeOther.text.includes("method=GET") && seeOther.text.includes("body=none"),
    /final-marker.*/.exec(seeOther.text)?.[0] ?? seeOther.text.slice(0, 120),
  );
  const temporary = await attempt(http, { url: `${publicBase}/redirect-307`, method: "POST", body: "payload" });
  report(
    "a 307 keeps the method and the body",
    temporary.ok && temporary.text.includes("method=POST") && temporary.text.includes("body=payload"),
    /final-marker.*/.exec(temporary.text)?.[0] ?? temporary.text.slice(0, 120),
  );
  const crossOrigin = await attempt(http, {
    url: `${publicBase}/redirect-cross-origin`,
    headers: { authorization: "Bearer egress-check" },
  });
  const sameOrigin = await attempt(http, {
    url: `${publicBase}/redirect-public`,
    headers: { authorization: "Bearer egress-check" },
  });
  report(
    "Authorization survives a same-origin hop and is dropped on a cross-origin one",
    sameOrigin.text.includes("auth=Bearer egress-check") && crossOrigin.text.includes("auth=none"),
    `same: ${/auth=\S+( \S+)?/.exec(sameOrigin.text)?.[0] ?? "?"}, cross: ${/auth=\S+/.exec(crossOrigin.text)?.[0] ?? "?"}`,
  );

  const stalled = createHttpTool(blockingConfig, { resolve: () => new Promise<string[]>(() => undefined) });
  const stalledStarted = Date.now();
  const stalledResult = await attempt(stalled, { url: "https://stalled.test/", timeout_ms: 300 });
  const stalledElapsed = Date.now() - stalledStarted;
  report(
    "http_request's timeout_ms covers the egress check's DNS lookup",
    !stalledResult.ok && stalledResult.text.includes("timed out after 300ms") && stalledElapsed < 2_000,
    `${stalledElapsed}ms: ${stalledResult.text.slice(0, 100)}`,
  );

  // --- Browser ------------------------------------------------------------------

  const unblocked = createBrowserTools({ config: { ...config, blockPrivateNetwork: false }, workspaceDir });
  const unblockedOpen = unblocked.tools.find((tool) => tool.name === "browser_open");
  const schemes: string[] = [];
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi", "about:blank", "chrome://version"]) {
    const result = await attempt(unblockedOpen, { url });
    if (result.ok || !result.text.includes("only http and https")) schemes.push(`${url}: ${result.text.slice(0, 60)}`);
  }
  report("browser_open refuses non-http schemes with BLOCK_PRIVATE_NETWORK off", schemes.length === 0, schemes.join("; "));
  await unblocked.close();

  const literal = await attempt(byName.get("browser_open"), { url: `http://127.0.0.1:${port}/hit/open-literal` });
  report("browser_open refuses a private literal", !literal.ok && literal.text.includes("Refused"), literal.text.slice(0, 100));
  const resolved = await attempt(byName.get("browser_open"), { url: `http://rebind.test:${port}/hit/open-rebind` });
  report(
    "browser_open refuses a name that resolves to loopback",
    !resolved.ok && resolved.text.includes("resolves to 127.0.0.1"),
    resolved.text.slice(0, 100),
  );

  const page = await attempt(byName.get("browser_open"), { url: `${publicBase}/`, wait_until: "load" });
  report("browser_open loads a public page with the gate on", page.ok && page.text.includes("public-page-marker"), page.text.slice(0, 80));
  const socket = await attempt(byName.get("browser_wait_for"), { text: "ws-closed-", timeout_ms: 10_000 });
  report(
    "a WebSocket to loopback is closed by the gate (1008), not by a failed connection (1006)",
    socket.text.includes("ws-closed-1008"),
    /ws-closed-\d+/.exec(socket.text)?.[0] ?? socket.text.slice(0, 80),
  );
  report("the page's public subresource loaded", hits.includes("/hit/img-public"), hits.join(", "));
  report(
    "the page's private subresources, fetch and WebSocket never reached the fixture",
    !hits.some((hit) => ["/hit/img-literal", "/hit/img-rebind", "/hit/fetch-literal", "/hit/ws"].includes(hit)),
    hits.join(", "),
  );

  const linkRef = /^(e\d+) a "private link"/m.exec(page.text)?.[1];
  if (linkRef === undefined) {
    report("the private link is in the snapshot", false, page.text.slice(0, 200));
  } else {
    await attempt(byName.get("browser_click"), { ref: linkRef });
    report("clicking a link to a private address does not reach it", !hits.includes("/hit/link"), hits.join(", "));
  }

  const hitsBefore = hits.length;
  const redirected = await attempt(byName.get("browser_open"), { url: `${publicBase}/redirect-private` });
  report(
    "a browser redirect to a private address fails the call instead of returning the page",
    !redirected.ok && redirected.text.includes("Refused") && redirected.text.includes("redirect") && !redirected.text.includes("secret-marker"),
    redirected.text.slice(0, 140),
  );
  const after = await attempt(byName.get("browser_snapshot"), {});
  report(
    "the page was cleared after the refused redirect",
    after.ok && after.text.includes("url: about:blank") && !after.text.includes("secret-marker"),
    after.text.split("\n").slice(0, 2).join(" | "),
  );
  report(
    "the refused redirect's request itself still left, as documented",
    hits.slice(hitsBefore).includes("/hit/redirect-private"),
    hits.slice(hitsBefore).join(", ") || "not sent",
  );

  const publicRedirect = await attempt(byName.get("browser_open"), { url: `${publicBase}/redirect-public` });
  report(
    "a browser redirect to a public host still works with the gate on",
    publicRedirect.ok && publicRedirect.text.includes(`${publicBase}/final`),
    publicRedirect.text.split("\n").slice(0, 2).join(" | "),
  );

  // The page goes through the refused redirect while browser_wait_for waits
  // for an element that is never visible. Playwright's timeout error quotes
  // the elements it found, so the error must not be the one returned.
  const later = await attempt(byName.get("browser_open"), { url: `${publicBase}/later-private`, wait_until: "load" });
  report("a page that navigates itself later opens normally", later.ok && later.text.includes("later-page-marker"), later.text.slice(0, 80));
  const waited = await attempt(byName.get("browser_wait_for"), { selector: "title", timeout_ms: 4_000 });
  report(
    "a wait that times out after a refused redirect fails with the refusal, not with the page",
    !waited.ok &&
      waited.text.includes("Refused") &&
      waited.text.includes("redirect") &&
      !waited.text.includes("Secret") &&
      !waited.text.includes("secret-marker"),
    waited.text.slice(0, 160),
  );
  const afterWait = await attempt(byName.get("browser_snapshot"), {});
  report(
    "the page was cleared after the failed wait",
    afterWait.ok && afterWait.text.includes("url: about:blank"),
    afterWait.text.split("\n").slice(0, 2).join(" | "),
  );

  // --- agent_browser --------------------------------------------------------------

  const refusedCalls: [string, readonly string[], string?][] = [
    ["open file://", ["open", "file:///etc/passwd"]],
    ["open javascript:", ["open", "javascript:alert(1)"]],
    ["open a private literal", ["open", "http://127.0.0.1:9222/json"]],
    ["open a bare loopback host", ["open", "localhost:3000"]],
    ["goto a bare mapped address", ["goto", "[::ffff:127.0.0.1]:8787"]],
    ["navigate to metadata", ["navigate", "169.254.169.254/latest/meta-data/"]],
    ["open after global flags", ["--allowed-domains", "example.com", "--json", "open", "10.0.0.1"]],
    ["read a name resolving to loopback", ["read", "http://rebind.test/", "--json"]],
    ["tab new with a label", ["tab", "new", "--label", "docs", "http://192.168.1.1/"]],
    ["diff url", ["diff", "url", "https://public.test/", "http://[fd00::1]/"]],
    ["a batch step in args", ["batch", "--bail", "open http://10.0.0.1/"]],
    ["a batch step as a JSON array in args", ["batch", '["navigate","http://localhost:3000/target"]']],
    ["a batch step on stdin", ["batch", "--json"], JSON.stringify([["open", "https://public.test/"], ["open", "http://100.64.0.1/"]])],
    ["a batch on stdin that is not JSON", ["batch"], "open https://public.test/\nopen 127.0.0.1"],
    ["a --session inside a batch", ["batch", "--json"], JSON.stringify([["--session", "other", "snapshot"]])],
    ["a loopback --proxy", ["--proxy", "http://127.0.0.1:7890", "open", "https://public.test/"]],
    ["open after the boolean --hide-scrollbars", ["--hide-scrollbars", "open", "http://169.254.169.254/latest/meta-data/"]],
    ["a batch step after --hide-scrollbars", ["batch", "--hide-scrollbars open http://127.0.0.1:9222/json"]],
    ["record start", ["record", "start", "./demo.webm", "http://10.0.0.1/"]],
    ["pushstate to an absolute URL", ["pushstate", "http://169.254.169.254/latest/meta-data/"]],
    ["pushstate to a host without a scheme", ["pushstate", "//127.0.0.1:8787/"]],
  ];
  const leaked: string[] = [];
  for (const [label, args, stdin] of refusedCalls) {
    const refusal = await agentBrowserRefusal(args, stdin, blocking, workspaceDir);
    if (refusal === undefined) leaked.push(label);
  }
  report(
    "agent_browser refuses private, local and non-http destinations wherever they appear",
    leaked.length === 0,
    leaked.length === 0 ? `${refusedCalls.length} refused` : `allowed: ${leaked.join(", ")}`,
  );

  // Refused whatever the policy, so these run with blocking off.
  const refusedCommandCalls: [string, readonly string[], string?][] = [
    ["connect", ["connect", "9222"]],
    ["connect after --hide-scrollbars", ["--hide-scrollbars", "connect", "9222"]],
    [
      "mcp, whose open tool takes any URL and any flag",
      ["mcp", "--tools", "all"],
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"agent_browser_open","arguments":{"url":"http://169.254.169.254/","extraArgs":["--cdp","9222"]}}}',
    ],
    ["mcp after a global flag", ["--json", "mcp"]],
    ["mcp inside a batch", ["batch", "--json"], JSON.stringify([["mcp"]])],
    ["chat", ["chat", "open http://127.0.0.1:8787/"]],
    ["dashboard", ["dashboard", "start"]],
    ["stream enable", ["stream", "enable", "--port", "9223"]],
    ["plugin add", ["plugin", "add", "agent-browser-plugin-captcha"]],
    ["plugins, the CLI's other name for plugin", ["plugins", "list"]],
    ["install", ["install", "--with-deps"]],
    ["auth login, which types saved credentials into a public page", ["auth", "login", "x", "--url", "https://public.test/login"]],
    ["auth show", ["auth", "show", "x"]],
    ["auth save inside a batch", ["batch", "--json"], JSON.stringify([["auth", "save", "x", "--url", "https://public.test/", "--username", "u", "--password", "p"]])],
    ["close --all", ["close", "--all"]],
    ["doctor --fix", ["doctor", "--fix"]],
    ["a command the list does not know", ["profiles"]],
    ["an unknown flag before the command", ["--frobnicate", "snapshot"]],
    ["upgrade", ["upgrade"]],
    ["doctor --fix given as a flag's value", ["doctor", "--user-agent", "--fix"]],
    [
      "a batch step that starts with a global flag",
      ["batch", "--json"],
      JSON.stringify([["--proxy", "http://127.0.0.1:7890", "open", "https://public.test/"]]),
    ],
  ];
  const ran: string[] = [];
  for (const [label, args, stdin] of refusedCommandCalls) {
    const refusal = await agentBrowserRefusal(args, stdin, open, workspaceDir);
    if (refusal === undefined) ran.push(label);
  }
  report(
    "agent_browser refuses commands outside its list, and connect, mcp and the other listed ones by name",
    ran.length === 0,
    ran.length === 0 ? `${refusedCommandCalls.length} refused` : `allowed: ${ran.join(", ")}`,
  );

  const allowedCalls: [string, readonly string[], string?][] = [
    ["open a public URL", ["open", "https://public.test/"]],
    ["open a bare public host", ["open", "public.test"]],
    ["read with a filter", ["read", "https://public.test/", "--filter", "overview", "--json"]],
    ["open with --enable", ["--enable", "react-devtools", "open", "https://public.test/"]],
    ["fill with the word open", ["fill", "@e1", "open", "--json"]],
    ["snapshot", ["snapshot", "-i", "-c", "--json"]],
    ["a public batch", ["batch", "--bail", "--json"], JSON.stringify([["open", "https://public.test/"], ["snapshot", "-i"], ["close"]])],
    ["a socks5 proxy on a public host", ["--proxy", "socks5://public.test:1080", "open", "https://public.test/"]],
    ["open with no URL", ["open"]],
    [
      "diff url with --wait-until and a selector",
      ["diff", "url", "https://public.test/", "https://public2.test/", "--wait-until", "networkidle", "-s", "#main"],
    ],
    ["open after --hide-scrollbars false", ["--hide-scrollbars", "false", "open", "https://public.test/"]],
    ["doctor, as the skill runs it", ["doctor", "--offline", "--quick", "--json"]],
    ["close", ["close", "--json"]],
    ["help", ["--help"]],
    ["a11y scoped with -s", ["a11y", "-s", "#main"]],
    ["a11y of a URL scoped with --selector", ["a11y", "https://public.test/", "--selector", "#main", "--json"]],
    ["read with --llms", ["read", "https://public.test/", "--llms", "index"]],
    ["open a bare public host with a port", ["open", "public.test:8443"]],
    ["fill with the word upgrade", ["fill", "@e1", "upgrade"]],
    ["string steps with quoted words", ["batch", "--bail", 'open "https://public.test/"', 'fill @e1 "two words"']],
    ["pushstate to a path on the page's own origin", ["pushstate", "/docs/intro"]],
  ];
  const wronglyRefused: string[] = [];
  for (const [label, args, stdin] of allowedCalls) {
    const refusal = await agentBrowserRefusal(args, stdin, blocking, workspaceDir);
    if (refusal !== undefined) wronglyRefused.push(`${label}: ${refusal}`);
  }
  report(
    "agent_browser allows ordinary public commands",
    wronglyRefused.length === 0,
    wronglyRefused.length === 0 ? `${allowedCalls.length} allowed` : wronglyRefused.join("; "),
  );

  const devLoopback = await agentBrowserRefusal(["open", "localhost:3000"], undefined, open, workspaceDir);
  const devFile = await agentBrowserRefusal(["open", "file:///etc/passwd"], undefined, open, workspaceDir);
  report(
    "with BLOCK_PRIVATE_NETWORK off, agent_browser opens loopback but still not file://",
    devLoopback === undefined && devFile?.includes("only http and https") === true,
    `localhost: ${devLoopback ?? "allowed"}; file: ${devFile ?? "allowed"}`,
  );

  // A line, and a batch step, are read as the CLI reads them: a string step is
  // split and unquoted as the CLI does it, a step keeps the flags the CLI does
  // not remove from it, and a URL gets the scheme Chrome would give it. With
  // blocking off, the scheme rule is all that stands between these and a file.
  const fileCalls: [string, readonly string[], string?][] = [
    ["a double-quoted step", ["batch", 'open "file:///etc/passwd"']],
    ["a single-quoted step", ["batch", "open 'file:///etc/passwd'"]],
    ["a backslash-escaped step", ["batch", "open fi\\le:///etc/passwd"]],
    ["a quoted string step on stdin", ["batch"], JSON.stringify(['open "file:///etc/passwd"'])],
    ["a global flag inside a step", ["batch", "--json"], JSON.stringify([["open", "--proxy", "file:///etc/passwd"]])],
    ["a file URL whose path starts with a digit", ["open", "file:0/../../etc/passwd"]],
    ["a tab inside the scheme", ["tab", "new", "fi\tle:///etc/passwd"]],
    ["diff url's second URL after -s", ["diff", "url", "-s", "file:///etc/passwd"]],
    ["record start with an upper-case scheme", ["record", "start", "./demo.webm", "FILE:///etc/passwd"]],
  ];
  const fileOpened: string[] = [];
  for (const [label, args, stdin] of fileCalls) {
    const refusal = await agentBrowserRefusal(args, stdin, open, workspaceDir);
    if (refusal?.includes("only http and https") !== true) fileOpened.push(`${label}: ${refusal ?? "allowed"}`);
  }
  report(
    "with BLOCK_PRIVATE_NETWORK off, agent_browser refuses file:// however the line or the step spells it",
    fileOpened.length === 0,
    fileOpened.length === 0 ? `${fileCalls.length} refused as file URLs` : fileOpened.join("; "),
  );
  const quotedPrivate = await agentBrowserRefusal(["batch", 'open "http://127.0.0.1:9222/json"'], undefined, blocking, workspaceDir);
  report(
    "a quoted private URL in a string step is refused as the private address it is",
    quotedPrivate?.includes("127.0.0.1 is a private or loopback address") === true,
    quotedPrivate ?? "allowed",
  );

  // --- agent_browser flags --------------------------------------------------------

  // Each loads code, an extension, a profile, saved state or configuration,
  // changes the program the CLI starts, or keeps a browser running that the
  // service cannot close. Refused whatever the policy, so these run with
  // blocking off, and by name, so the model is told which flag it was.
  const refusedFlagCalls: [string, readonly string[], string?][] = [
    ["--namespace", ["--namespace", "another", "open", "https://public.test/"]],
    ["--namespace", ["--namespace", "another", "--idle-timeout", "0", "open", "https://public.test/"]],
    ["--idle-timeout", ["--idle-timeout", "0", "open", "https://public.test/"]],
    ["--idle-timeout", ["open", "https://public.test/", "--idle-timeout", "999999999"]],
    ["--executable-path", ["--executable-path", "/tmp/x", "open", "https://public.test/"]],
    ["--engine", ["--engine", "lightpanda", "open", "https://public.test/"]],
    ["--provider", ["--provider", "browserbase", "open", "https://public.test/"]],
    ["-p", ["-p", "planted-plugin", "open", "https://public.test/"]],
    ["--extension", ["--extension", "./extension", "open", "https://public.test/"]],
    ["--init-script", ["--init-script", "./hook.js", "open", "https://public.test/"]],
    ["--args", ["--args", "--host-resolver-rules=MAP public.test 169.254.169.254", "open", "https://public.test/"]],
    ["--args", ["--args", "--proxy-server=http://127.0.0.1:7890", "open", "https://public.test/"]],
    ["--state", ["--state", "./state.json", "open", "https://public.test/"]],
    ["--profile", ["--profile", "Default", "open", "https://public.test/"]],
    ["--session-name", ["--session-name", "another-task", "open", "https://public.test/"]],
    ["--restore", ["--restore", "another-task", "open", "https://public.test/"]],
    ["--restore=old", ["open", "https://public.test/", "--restore=old"]],
    ["--config", ["--config", "./agent-browser.json", "open", "https://public.test/"]],
    ["--action-policy", ["--action-policy", "./policy.json", "open", "https://public.test/"]],
    ["--allow-file-access", ["--allow-file-access", "true", "open", "https://public.test/"]],
    ["--cdp", ["--cdp", "9222", "snapshot"]],
    ["--auto-connect", ["--auto-connect", "snapshot"]],
    ["--init-script", ["open", "https://public.test/", "--init-script", "./hook.js"]],
    ["--extension", ["batch", "--json"], JSON.stringify([["open", "--extension", "./extension", "https://public.test/"]])],
  ];
  const unrefusedFlags: string[] = [];
  for (const [flag, args, stdin] of refusedFlagCalls) {
    const refusal = await agentBrowserRefusal(args, stdin, open, workspaceDir);
    if (refusal?.startsWith(`Refused: ${flag} is not allowed`) !== true) {
      unrefusedFlags.push(`${args.join(" ")}: ${refusal ?? "allowed"}`);
    }
  }
  report(
    "agent_browser refuses, by name, each flag that loads code, an extension, a profile, state or configuration, changes the program it starts, or keeps a browser running that the service cannot close",
    unrefusedFlags.length === 0,
    unrefusedFlags.length === 0 ? `${refusedFlagCalls.length} refused` : unrefusedFlags.join("; "),
  );

  // --- agent_browser and files on the host ----------------------------------------

  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "egress-check-outside-"));
  try {
    const outsideFile = path.join(outsideDir, "secret.txt");
    await writeFile(outsideFile, "outside-secret-marker\n");
    const insideFile = path.join(workspaceDir, "artifacts", "upload.txt");
    await mkdir(path.dirname(insideFile), { recursive: true });
    await writeFile(insideFile, "inside\n");

    // Refused whatever the policy, so these run with blocking off.
    const hostReads: [string, readonly string[], string?][] = [
      ["upload of an absolute path outside", ["upload", "#file", outsideFile]],
      ["upload of a relative path that climbs out", ["upload", "#file", path.relative(workspaceDir, outsideFile)]],
      ["upload of one file inside and one outside", ["upload", "#file", "artifacts/upload.txt", outsideFile]],
      ["upload after a global flag", ["--json", "upload", "#file", outsideFile]],
      ["upload in a batch step on stdin", ["batch", "--json"], JSON.stringify([["upload", "#file", outsideFile]])],
      ["upload in a quoted string step", ["batch", `upload #file '${outsideFile}'`]],
      ["state show", ["state", "show", outsideFile]],
      ["cookies set --curl", ["cookies", "set", "--curl", outsideFile, "--domain", "public.test"]],
      ["diff snapshot --baseline", ["diff", "snapshot", "--baseline", outsideFile]],
      ["diff screenshot -b", ["diff", "screenshot", "-b", outsideFile]],
    ];
    const readOutside: string[] = [];
    for (const [label, args, stdin] of hostReads) {
      const refusal = await agentBrowserRefusal(args, stdin, open, workspaceDir);
      if (refusal?.includes("reads the file on the host") !== true) readOutside.push(`${label}: ${refusal ?? "allowed"}`);
    }
    report(
      "agent_browser refuses upload, state show and the CLI's other reads of a file outside the workspace",
      readOutside.length === 0,
      readOutside.length === 0 ? `${hostReads.length} refused` : readOutside.join("; "),
    );

    // A link the task could make with bash, from the workspace to outside it.
    // A junction needs no privilege on Windows; elsewhere the type is ignored.
    const linkLabel = "agent_browser refuses an upload through a link in the workspace that leads outside it";
    const linked = await symlink(outsideDir, path.join(workspaceDir, "escape"), "junction").then(
      () => undefined,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    if (linked !== undefined) {
      console.log(`SKIP  ${linkLabel} -- no link could be made here (${linked})`);
    } else {
      const throughLink = await agentBrowserRefusal(["upload", "#file", "escape/secret.txt"], undefined, open, workspaceDir);
      report(linkLabel, throughLink?.includes("symbolic link or junction") === true, throughLink ?? "allowed");
    }

    // state load sends the browser to every origin in the file before it
    // sets that origin's storage, so a file in the workspace is no safer than
    // one outside it: the first origin here opens a host file, the / the CLI
    // appends becoming a fragment, and the second is a private address. It is
    // refused by name, as are the state subcommands that work on every
    // session's saved state, so these run with blocking off.
    const savedState = (origin: string): string =>
      JSON.stringify({ cookies: [], origins: [{ origin, localStorage: [{ name: "a", value: "b" }], sessionStorage: [] }] });
    const privateOriginFile = path.join(workspaceDir, "artifacts", "private-origin.json");
    await writeFile(path.join(workspaceDir, "artifacts", "file-origin.json"), savedState(`${pathToFileURL(outsideFile).href}#`));
    await writeFile(privateOriginFile, savedState("http://169.254.169.254"));
    const stateCalls: [string, readonly string[], string?][] = [
      ["state load", ["state", "load", "artifacts/file-origin.json"]],
      ["state load", ["state", "load", privateOriginFile]],
      ["state load", ["--json", "state", "load", "artifacts/private-origin.json"]],
      ["state load", ["batch", "--json"], JSON.stringify([["state", "load", "artifacts/file-origin.json"]])],
      ["state load", ["batch", "state load artifacts/private-origin.json"]],
      ["state list", ["state", "list"]],
      ["state clear", ["state", "clear", "--all"]],
      ["state clear", ["state", "clear", "another-task"]],
      ["state clean", ["state", "clean", "--older-than", "0"]],
      ["state rename", ["batch", "--json"], JSON.stringify([["state", "rename", "another-task", "mine"]])],
      ["state --json", ["batch", "--json"], JSON.stringify([["state", "--json", "load", "artifacts/file-origin.json"]])],
    ];
    const stateRan: string[] = [];
    for (const [label, args, stdin] of stateCalls) {
      const refusal = await agentBrowserRefusal(args, stdin, open, workspaceDir);
      if (refusal?.startsWith(`Refused: ${label} is not allowed`) !== true) {
        stateRan.push(`${args.join(" ")} ${stdin ?? ""}: ${refusal ?? "allowed"}`);
      }
    }
    report(
      "agent_browser refuses state load of a workspace file whose origins are a host file or a private address, and the state subcommands that work on every session's state",
      stateRan.length === 0,
      stateRan.length === 0 ? `${stateCalls.length} refused` : stateRan.join("; "),
    );

    const workspaceReads: [string, readonly string[], string?][] = [
      ["upload of a workspace file", ["upload", "#file", "artifacts/upload.txt"]],
      ["upload by absolute path in the workspace", ["upload", "#file", insideFile]],
      ["upload of two workspace files in a batch step", ["batch", "--json"], JSON.stringify([["upload", "#file", "artifacts/upload.txt", "./artifacts/upload.txt"]])],
      ["state show from the workspace", ["state", "show", "artifacts/private-origin.json"]],
      ["cookies set --curl from the workspace", ["cookies", "set", "--curl", "artifacts/cookies.txt"]],
      ["diff snapshot against a workspace baseline", ["diff", "snapshot", "-b", "artifacts/baseline.txt"]],
    ];
    const refusedInside: string[] = [];
    for (const [label, args, stdin] of workspaceReads) {
      const refusal = await agentBrowserRefusal(args, stdin, blocking, workspaceDir);
      if (refusal !== undefined) refusedInside.push(`${label}: ${refusal}`);
    }
    report(
      "agent_browser allows the same reads of files in the workspace",
      refusedInside.length === 0,
      refusedInside.length === 0 ? `${workspaceReads.length} allowed` : refusedInside.join("; "),
    );

    // Where the CLI writes is not confined. Asserted so that the limit stays
    // visible: this fails once it is closed, and then belongs in the list above.
    const writes: [string, readonly string[]][] = [
      ["screenshot", ["screenshot", path.join(outsideDir, "shot.png")]],
      ["download", ["download", "@e1", path.join(outsideDir, "payload")]],
      ["state save", ["state", "save", path.join(outsideDir, "state.json")]],
    ];
    const confinedWrites: string[] = [];
    for (const [label, args] of writes) {
      const refusal = await agentBrowserRefusal(args, undefined, blocking, workspaceDir);
      if (refusal !== undefined) confinedWrites.push(`${label}: ${refusal}`);
    }
    report(
      "agent_browser does not confine where the CLI writes, as documented",
      confinedWrites.length === 0,
      confinedWrites.length === 0 ? `${writes.map(([label]) => label).join(", ")} outside the workspace allowed` : confinedWrites.join("; "),
    );

    // The tool itself hands its own workspace to the check. A refusal comes
    // before the CLI is looked for, and the binary named here does not exist,
    // so a call that is not refused fails without starting a browser.
    let registered: unknown;
    const fakePi = {
      on: () => undefined,
      registerTool: (tool: unknown) => {
        registered = tool;
      },
    } as unknown as HarnessExtensionApi;
    const extension = agentBrowserFeature.extension({
      config: { ...blockingConfig, agentBrowserBinary: path.join(outsideDir, "no-agent-browser") },
      taskId: "__egress_check__",
      workspaceDir,
      onArtifacts: () => undefined,
      onCampaignMessage: () => undefined,
      onIntentDeclaration: () => undefined,
      subscribeCampaignMessages: () => () => undefined,
      ...inertOversight(config, []),
    });
    if (typeof extension === "function") await extension(fakePi);
    else await extension.factory(fakePi);
    // Pinned from both sides, so that handing the check another root fails
    // here. A file under a wider one, every task's workspaces or the ling's
    // own directory, is refused; the files outside need not exist. A file in
    // the workspace gets past the check to the missing binary, named by its
    // absolute path too, which a narrower root would refuse; a relative path
    // is read against whatever root the check is given.
    const elsewhere: [string, string][] = [
      ["a temporary directory", outsideFile],
      ["another task's workspace", path.join(config.workspacesDir, "other-task", "secret.txt")],
      ["the ling's own directory", path.join(config.rootDir, ".env")],
    ];
    const uploadedElsewhere: string[] = [];
    for (const [label, file] of elsewhere) {
      const uploaded = await attempt(registered, { args: ["upload", "#file", file] });
      if (uploaded.ok || !uploaded.text.includes("outside this task's workspace")) {
        uploadedElsewhere.push(`${label}: ${uploaded.text.slice(0, 140)}`);
      }
    }
    report(
      "the agent_browser tool refuses an upload from outside its own workspace, another task's included",
      uploadedElsewhere.length === 0,
      uploadedElsewhere.length === 0 ? `${elsewhere.map(([label]) => label).join(", ")} refused` : uploadedElsewhere.join("; "),
    );
    const refusedInWorkspace: string[] = [];
    for (const file of ["artifacts/upload.txt", insideFile]) {
      const uploaded = await attempt(registered, { args: ["upload", "#file", file] });
      if (uploaded.ok || !uploaded.text.startsWith("agent-browser is not installed")) {
        refusedInWorkspace.push(`${file}: ${uploaded.text.slice(0, 140)}`);
      }
    }
    report(
      "the agent_browser tool lets an upload from its own workspace past the check",
      refusedInWorkspace.length === 0,
      refusedInWorkspace.length === 0 ? "relative and absolute paths reach the missing binary" : refusedInWorkspace.join("; "),
    );
  } finally {
    await rm(outsideDir, { recursive: true, force: true });
  }

  // --- The configuration the agent-browser CLI reads ------------------------------

  // The file a task would write into its workspace, which the CLI reads from
  // its working directory unless AGENT_BROWSER_CONFIG names another. Every
  // setting here starts a program, moves the browser's traffic or opens the
  // host's files. plugin list shows what the CLI read without starting a
  // browser or a daemon, and runs none of the plugins it lists.
  const plantedPlugin = { name: "planted-plugin", command: "planted-plugin-program", args: [], capabilities: ["command.run"] };
  await writeFile(
    path.join(workspaceDir, "agent-browser.json"),
    JSON.stringify({
      executablePath: "planted-browser-program",
      args: "--host-resolver-rules=MAP * 127.0.0.1",
      proxy: "http://127.0.0.1:7890",
      allowFileAccess: true,
      plugins: [plantedPlugin],
    }),
  );

  /** plugin list run in the workspace with `env`, around runAgentBrowser. */
  const pluginList = async (env: NodeJS.ProcessEnv): Promise<string> => {
    try {
      const { stdout } = await execFileAsync(config.agentBrowserBinary, ["plugin", "list", "--json"], {
        cwd: workspaceDir,
        env,
        timeout: 30_000,
        windowsHide: true,
      });
      return stdout;
    } catch (error) {
      return `failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
    }
  };
  /** The service's environment for the CLI, without AGENT_BROWSER_CONFIG. */
  const unprotected = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
    const copy = { ...env };
    delete copy["AGENT_BROWSER_CONFIG"];
    return copy;
  };

  const plantedLabel = "an agent-browser.json planted in the workspace has no effect: the CLI reads the service's file instead";
  const missing = (() => {
    try {
      assertAgentBrowserInstalled(config);
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  })();
  if (missing !== undefined) {
    console.log(`SKIP  ${plantedLabel} -- ${missing}`);
  } else {
    // The service writes the CLI's file into a directory of its own, here a
    // temporary one. The file left in it stands for one a task aimed there:
    // download and state save, run through agent_browser, can write it, and
    // runs before this one could have read a file by that name.
    const runConfig = { ...config, dataDir: await mkdtemp(path.join(os.tmpdir(), "egress-check-data-")) };
    try {
      const configDir = agentBrowserConfigDir(runConfig);
      const leftFile = path.join(configDir, "config.json");
      const leftPlugin = { ...plantedPlugin, name: "planted-service-plugin", command: "planted-service-program" };
      const leftConfig = JSON.stringify({ plugins: [leftPlugin] });
      await mkdir(configDir, { recursive: true });
      await writeFile(leftFile, leftConfig);

      // The call agent_browser makes, in the workspace, through runAgentBrowser.
      const listed = await runAgentBrowser(runConfig, ["plugin", "list", "--json"], {
        session: "egress-check",
        cwd: workspaceDir,
        timeoutMs: 30_000,
      }).then(
        (run) => run.stdout + run.stderr,
        (error: unknown) => `failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      report(plantedLabel, listed.includes('"plugins"') && !listed.includes("planted-plugin"), listed.trim().slice(0, 160));
      const control = await pluginList(unprotected(agentBrowserEnvironment(runConfig, "egress-check", leftFile)));
      report(
        "without AGENT_BROWSER_CONFIG the same CLI reads the planted file, so the check above can fail",
        control.includes("planted-plugin"),
        control.trim().slice(0, 160),
      );

      report(
        "a file left in the service's directory has no effect: each run reads a new file of its own",
        listed.includes('"plugins"') && !listed.includes("planted-service-plugin"),
        listed.trim().slice(0, 160),
      );
      const leftControl = await pluginList(agentBrowserEnvironment(runConfig, "egress-check", leftFile));
      report(
        "the same CLI given the left file reads it, so the check above can fail",
        leftControl.includes("planted-service-plugin"),
        leftControl.trim().slice(0, 160),
      );
      const remaining = await readdir(configDir);
      const leftNow = await readFile(leftFile, "utf8").catch(() => "missing");
      report(
        "the run removed its own file and left the other as it was",
        remaining.length === 1 && remaining[0] === "config.json" && leftNow === leftConfig,
        `${remaining.join(", ") || "empty"}; config.json ${leftNow === leftConfig ? "unchanged" : `now ${leftNow.slice(0, 60)}`}`,
      );
      const serviceDir = agentBrowserConfigDir(config);
      report(
        "the service's directory for the CLI's files is outside every workspace",
        path.relative(config.workspacesDir, serviceDir).startsWith(".."),
        serviceDir,
      );

      // ~/.agent-browser/config.json comes before ./agent-browser.json, and
      // AGENT_BROWSER_CONFIG replaces it as well.
      const homeLabel = "a planted ~/.agent-browser/config.json has no effect either";
      if (process.platform === "win32") {
        console.log(
          `SKIP  ${homeLabel} -- on Windows the CLI asks the shell for the profile folder instead of reading HOME or USERPROFILE, so a planted home cannot stand in for the real one`,
        );
      } else {
        const home = await mkdtemp(path.join(os.tmpdir(), "egress-check-home-"));
        try {
          await mkdir(path.join(home, ".agent-browser"));
          await writeFile(
            path.join(home, ".agent-browser", "config.json"),
            JSON.stringify({ plugins: [{ ...plantedPlugin, name: "planted-home-plugin" }] }),
          );
          // The file runAgentBrowser would write for the run.
          const runFile = path.join(configDir, "run-egress-check.json");
          await writeFile(runFile, "{}\n");
          const withHome = agentBrowserEnvironment(runConfig, "egress-check", runFile, { ...process.env, HOME: home });
          const homeListed = await pluginList(withHome);
          const homeControl = await pluginList(unprotected(withHome));
          report(
            homeLabel,
            homeListed.includes('"plugins"') && !homeListed.includes("planted-home-plugin") && homeControl.includes("planted-home-plugin"),
            `with it: ${homeListed.trim().slice(0, 70)} | without it: ${homeControl.trim().slice(0, 70)}`,
          );
        } finally {
          await rm(home, { recursive: true, force: true });
        }
      }
    } finally {
      await rm(runConfig.dataDir, { recursive: true, force: true });
    }
  }

  // --- agent-browser environment ------------------------------------------------

  const runFile = path.join(agentBrowserConfigDir(config), "run-egress-check.json");
  const environment = agentBrowserEnvironment(config, "egress-check", runFile, {
    Path: "C:\\Windows\\system32",
    HOME: "/opt/autonomous-pi-agent/runtime-home",
    SystemRoot: "C:\\Windows",
    LC_ALL: "C.UTF-8",
    PLAYWRIGHT_BROWSERS_PATH: "/opt/autonomous-pi-agent/browsers",
    http_proxy: "http://proxy.example:3128",
    AGENT_BROWSER_HEADED: "1",
    AGENT_BROWSER_CONFIG: "./agent-browser.json",
    AGENT_TOKEN: "service-bearer-token",
    AGENT_TOKENS_JSON: '{"overlord":"service-bearer-token"}',
    OPENAI_API_KEY: "sk-provider-key",
    OPENROUTER_API_KEY: "sk-or-provider-key",
    CONTAINER_HOST: "unix:///run/piagent-podman/podman.sock",
  });
  const values = Object.values(environment).join("\n");
  report(
    "the agent-browser CLI does not inherit tokens, provider keys or the container socket",
    !values.includes("service-bearer-token") && !values.includes("sk-") && !("CONTAINER_HOST" in environment),
    Object.keys(environment).sort().join(", "),
  );
  report(
    "the agent-browser CLI keeps what it needs to run",
    environment.HOME === "/opt/autonomous-pi-agent/runtime-home" &&
      environment.SystemRoot === "C:\\Windows" &&
      environment.LC_ALL === "C.UTF-8" &&
      environment.PLAYWRIGHT_BROWSERS_PATH === "/opt/autonomous-pi-agent/browsers" &&
      environment.http_proxy === "http://proxy.example:3128" &&
      environment.AGENT_BROWSER_HEADED === "1" &&
      environment.AGENT_BROWSER_SESSION === "egress-check" &&
      environment.PATH?.endsWith(`${path.delimiter}C:\\Windows\\system32`) === true &&
      !("Path" in environment),
    `PATH=${environment.PATH ?? "unset"}`,
  );
  report(
    "an inherited AGENT_BROWSER_CONFIG does not replace the run's file",
    environment.AGENT_BROWSER_CONFIG === runFile,
    `AGENT_BROWSER_CONFIG=${environment.AGENT_BROWSER_CONFIG ?? "unset"}`,
  );
} finally {
  await browser.close();
  server.close();
  await rm(workspaceDir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nall egress checks passed" : `\n${failures} egress check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
