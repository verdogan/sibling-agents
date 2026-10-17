import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Type } from "typebox";
import type { Config } from "../config.js";
import { defineTool } from "../harness/index.js";

const DEFAULT_TIMEOUT_MS = 30_000;
// fetch's own limit, which applied before redirects were followed here
const MAX_REDIRECTS = 20;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BODY_HEADERS = ["content-type", "content-length", "content-encoding", "content-language", "content-location"];
const CREDENTIAL_HEADERS = ["authorization", "proxy-authorization", "cookie", "host"];

/** Resolves a hostname to every address it currently has. */
export type HostResolver = (hostname: string) => Promise<string[]>;

export const resolveHost: HostResolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

/** Settles with `work`, or rejects with the signal's reason as soon as it aborts. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * A resolver for one browser session. The browser asks it about every request
 * a page makes, and getaddrinfo runs on libuv's threadpool, four threads that
 * the process's file work shares. So each name is looked up once per session
 * and the answer reused, at most `concurrency` lookups are in flight, and a
 * name that has not answered within `timeoutMs` counts as unresolved. A lookup
 * keeps its slot until getaddrinfo returns, because it holds a thread until
 * then. A failure is not remembered, so the next request asks again.
 */
export function sessionResolver(resolve: HostResolver, concurrency: number, timeoutMs: number): HostResolver {
  const answers = new Map<string, Promise<string[]>>();
  let running = 0;
  const waiting: (() => void)[] = [];
  const acquire = async (): Promise<void> => {
    if (running < concurrency) {
      running += 1;
      return;
    }
    // release() hands its slot straight to the next waiter.
    await new Promise<void>((wake) => waiting.push(wake));
  };
  const release = (): void => {
    const next = waiting.shift();
    if (next === undefined) running -= 1;
    else next();
  };

  return async (hostname) => {
    let answer = answers.get(hostname);
    if (answer === undefined) {
      const lookup = (async () => {
        await acquire();
        try {
          return await resolve(hostname);
        } finally {
          release();
        }
      })();
      answer = untilAborted(lookup, AbortSignal.timeout(timeoutMs)).catch((error: unknown) => {
        answers.delete(hostname);
        throw error instanceof DOMException && error.name === "TimeoutError"
          ? new Error(`no answer within ${timeoutMs}ms`)
          : error;
      });
      answers.set(hostname, answer);
    }
    return await answer;
  };
}

export interface EgressPolicy {
  blockPrivateNetwork: boolean;
  /** Replaces DNS for the private-network check. The offline egress check injects one. */
  resolve?: HostResolver;
}

/**
 * Destinations BLOCK_PRIVATE_NETWORK refuses: private, loopback, link-local,
 * CGNAT, multicast and reserved space, and the IPv6 blocks listed. Not
 * refused: the documentation ranges (192.0.2.0/24, 198.51.100.0/24,
 * 203.0.113.0/24, 2001:db8::/32), which route nowhere and one of which
 * egress-check uses as its public host, and Teredo (2001::/32), whose IPv4
 * address is obscured.
 */
const privateAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT, also Alibaba Cloud's metadata service
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, including the cloud metadata service
  ["172.16.0.0", 12],
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, including broadcast
] as const) {
  privateAddresses.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 96], // unspecified, loopback and the deprecated IPv4-compatible block
  ["64:ff9b:1::", 48], // NAT64 for a site's own use, which can front its private space
  ["100::", 64], // discard
  ["fc00::", 7], // unique local, including AWS's fd00:ec2::254 metadata address
  ["fe80::", 10], // link-local
  ["fec0::", 10], // deprecated site-local
  ["ff00::", 8], // multicast
] as const) {
  privateAddresses.addSubnet(network, prefix, "ipv6");
}

/**
 * IPv4-mapped IPv6 (::ffff:0:0/96), refused whole: [::ffff:127.0.0.1] is
 * loopback, and a public host has no reason to be written this way. It lives
 * in its own list because BlockList matches IPv4 and IPv4-mapped addresses
 * against each other's rules, so in the list above it would refuse every IPv4
 * address.
 */
const mappedAddresses = new BlockList();
mappedAddresses.addSubnet("::ffff:0:0", 96, "ipv6");

/**
 * Prefixes whose addresses carry an IPv4 address and lead to it: on a network
 * with a NAT64 translator, 64:ff9b::a9fe:a9fe is 169.254.169.254, and 6to4
 * tunnels to the address it carries. An address in either is refused when the
 * IPv4 address inside it would be. `group` is the 16-bit group where that
 * address starts.
 */
const embeddingPrefixes = [
  { network: "64:ff9b::", prefix: 96, group: 6 },
  { network: "2002::", prefix: 16, group: 1 },
].map(({ network, prefix, group }) => {
  const list = new BlockList();
  list.addSubnet(network, prefix, "ipv6");
  return { list, group };
});

/** The eight 16-bit groups of an IPv6 address isIP() accepts. */
function ipv6Groups(address: string): number[] {
  // A trailing dotted quad is the last two groups.
  const text = address.replace(
    /(\d+)\.(\d+)\.(\d+)\.(\d+)$/,
    (_match: string, a: string, b: string, c: string, d: string) =>
      `${((Number(a) << 8) | Number(b)).toString(16)}:${((Number(c) << 8) | Number(d)).toString(16)}`,
  );
  const groups = (part: string): number[] =>
    part === "" ? [] : part.split(":").map((group) => Number.parseInt(group, 16));
  const [head = "", tail] = text.split("::");
  if (tail === undefined) return groups(head);
  const left = groups(head);
  const right = groups(tail);
  return [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right];
}

/** The IPv4 address an IPv6 address carries, when it is in one of embeddingPrefixes. */
function embeddedIPv4(address: string): string | undefined {
  const embedding = embeddingPrefixes.find(({ list }) => list.check(address, "ipv6"));
  if (embedding === undefined) return undefined;
  const groups = ipv6Groups(address);
  const high = groups[embedding.group] ?? 0;
  const low = groups[embedding.group + 1] ?? 0;
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

/** True for an address literal in any block BLOCK_PRIVATE_NETWORK refuses. */
export function isPrivateAddress(address: string): boolean {
  const bare = address.replace(/%.*$/, "");
  const family = isIP(bare);
  if (family === 0) return false;
  if (family === 4) return privateAddresses.check(bare, "ipv4");
  if (mappedAddresses.check(bare, "ipv6") || privateAddresses.check(bare, "ipv6")) return true;
  const embedded = embeddedIPv4(bare);
  return embedded !== undefined && privateAddresses.check(embedded, "ipv4");
}

/** Names that are local by definition, refused without asking DNS. */
function isLocalName(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  );
}

/**
 * The egress policy every tool applies before a URL leaves: http and https
 * only, and with BLOCK_PRIVATE_NETWORK on, neither a local name nor an address
 * in private space, whether the URL spells the address out or the name
 * resolves to it. Returns why the URL is refused, or undefined when it may go.
 *
 * The check resolves the name and the request then resolves it again, so a
 * DNS server that answers differently the second time still gets through. The
 * firewall is the boundary; this keeps an ordinary mistake, or a redirect, from
 * reaching the metadata service or a neighbour's port.
 *
 * When `signal` aborts during the lookup, this rejects with its reason instead
 * of returning a refusal. The lookup itself cannot be cancelled and runs on.
 */
export async function egressRefusal(
  url: URL,
  policy: EgressPolicy,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `Refused: only http and https are allowed, got ${url.protocol}`;
  }
  if (!policy.blockPrivateNetwork) return undefined;

  // The URL parser has already turned numeric forms such as 127.1 and
  // 2130706433 into dotted quads, and IPv6 into its compressed form.
  const host = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.+$/, "");
  const refused = `Refused: ${url.hostname} is a private or loopback address and BLOCK_PRIVATE_NETWORK is on.`;
  if (isIP(host) !== 0) return isPrivateAddress(host) ? refused : undefined;
  if (isLocalName(host)) return refused;

  let addresses: string[];
  try {
    addresses = await untilAborted((policy.resolve ?? resolveHost)(host), signal);
  } catch (error) {
    if (signal?.aborted === true) throw signal.reason;
    const reason = error instanceof Error ? error.message : String(error);
    return `Refused: ${url.hostname} did not resolve (${reason}), and BLOCK_PRIVATE_NETWORK checks the address before anything is sent.`;
  }
  if (addresses.length === 0) {
    return `Refused: ${url.hostname} resolved to no address, and BLOCK_PRIVATE_NETWORK checks the address before anything is sent.`;
  }
  const offending = addresses.find((address) => isIP(address) === 0 || isPrivateAddress(address));
  if (offending !== undefined) {
    return `Refused: ${url.hostname} resolves to ${offending}, a private or loopback address, and BLOCK_PRIVATE_NETWORK is on.`;
  }
  return undefined;
}

export interface HttpToolOptions {
  /** Seams for the offline egress check, which answers DNS and serves the "public" host itself. */
  resolve?: HostResolver;
  fetch?: typeof fetch;
}

export function createHttpTool(config: Config, options: HttpToolOptions = {}) {
  const policy: EgressPolicy = {
    blockPrivateNetwork: config.blockPrivateNetwork,
    ...(options.resolve !== undefined ? { resolve: options.resolve } : {}),
  };
  const send = options.fetch ?? fetch;

  return defineTool({
    name: "http_request",
    label: "HTTP Request",
    description:
      "Send an HTTP request and return the status, headers and body. Use this instead of the browser whenever the target offers an API: it is faster, cheaper and far more reliable than driving a page.",
    promptSnippet: "http_request: call an HTTP API directly, preferred over the browser",
    parameters: Type.Object({
      url: Type.String({ description: "Absolute http:// or https:// URL" }),
      method: Type.Optional(
        Type.String({ description: "HTTP method, default GET (GET, POST, PUT, PATCH, DELETE, HEAD)" }),
      ),
      headers: Type.Optional(
        Type.Record(Type.String(), Type.String(), { description: "Request headers" }),
      ),
      body: Type.Optional(
        Type.String({ description: "Request body as a string. For JSON, pass the serialized JSON." }),
      ),
      timeout_ms: Type.Optional(
        Type.Number({ description: `Timeout in milliseconds, default ${DEFAULT_TIMEOUT_MS}` }),
      ),
    }),
    execute: async (_toolCallId, params, signal) => {
      let target: URL;
      try {
        target = new URL(params.url);
      } catch {
        throw new Error(`Not a valid URL: ${params.url}`);
      }

      // The timeout covers the egress check's DNS lookups as well as the requests.
      const timeoutMs = params.timeout_ms ?? DEFAULT_TIMEOUT_MS;
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      const check = async (url: URL): Promise<string | undefined> => {
        try {
          return await egressRefusal(url, policy, combined);
        } catch (error) {
          if (timeoutSignal.aborted) throw new Error(`Request to ${url.href} timed out after ${timeoutMs}ms`);
          throw error;
        }
      };

      const refusal = await check(target);
      if (refusal !== undefined) throw new Error(refusal);

      const requestedMethod = (params.method ?? "GET").toUpperCase();
      const started = Date.now();

      // Redirects are followed here rather than by fetch so that every hop
      // passes the same egress check as the first request. What changes per
      // hop -- the method, the body, credentials on a cross-origin hop -- is
      // what fetch itself would change.
      let method = requestedMethod;
      let body =
        params.body !== undefined && method !== "GET" && method !== "HEAD" ? params.body : undefined;
      let headers: Headers;
      try {
        headers = new Headers(params.headers);
      } catch (error) {
        throw new Error(
          `Request to ${target.href} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const hops: string[] = [];
      let current = target;
      let response: Response;
      for (;;) {
        try {
          const init: RequestInit = { method, headers, signal: combined, redirect: "manual" };
          if (body !== undefined) init.body = body;
          response = await send(current, init);
        } catch (error) {
          if (timeoutSignal.aborted) {
            throw new Error(`Request to ${current.href} timed out after ${timeoutMs}ms`);
          }
          throw new Error(
            `Request to ${current.href} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        const location = response.headers.get("location");
        if (!REDIRECT_STATUSES.has(response.status) || location === null) break;
        await response.body?.cancel().catch(() => undefined);

        if (hops.length >= MAX_REDIRECTS) {
          throw new Error(`Request to ${target.href} stopped after ${MAX_REDIRECTS} redirects.`);
        }
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          throw new Error(`Request to ${current.href} redirected to an invalid URL: ${location}`);
        }
        const hopRefusal = await check(next);
        if (hopRefusal !== undefined) {
          throw new Error(`${hopRefusal} It was a ${response.status} redirect from ${current.href}.`);
        }

        const becomesGet =
          response.status === 303
            ? method !== "HEAD"
            : (response.status === 301 || response.status === 302) && method === "POST";
        if (becomesGet) {
          method = "GET";
          body = undefined;
          for (const name of BODY_HEADERS) headers.delete(name);
        }
        if (next.origin !== current.origin) {
          for (const name of CREDENTIAL_HEADERS) headers.delete(name);
        }
        hops.push(`-> ${response.status} ${next.href}`);
        current = next;
      }

      const rawBody = await response.text();
      const truncated = rawBody.length > config.httpMaxBodyChars;
      const responseBody = truncated ? rawBody.slice(0, config.httpMaxBodyChars) : rawBody;

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      const summary = [
        `${requestedMethod} ${target.href}`,
        ...hops,
        `${response.status} ${response.statusText} in ${Date.now() - started}ms`,
        `content-type: ${responseHeaders["content-type"] ?? "unknown"}`,
        truncated
          ? `body truncated to ${config.httpMaxBodyChars} of ${rawBody.length} characters`
          : undefined,
        "",
        responseBody,
      ]
        .filter((line) => line !== undefined)
        .join("\n");

      return {
        content: [{ type: "text" as const, text: summary }],
        details: {
          status: response.status,
          ok: response.ok,
          url: current.href,
          redirects: hops.length,
          headers: responseHeaders,
          truncated,
          bytes: rawBody.length,
        },
      };
    },
  });
}
