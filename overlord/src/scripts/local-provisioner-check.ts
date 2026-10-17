import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapLing } from "../ling/bootstrap.js";
import {
  LingClient,
  LingClientError,
  LingFinalStateTooLargeError,
  type LingFetch,
} from "../ling/client.js";
import { isTerminalStatus, LingProtocolError } from "../ling/events.js";
import {
  LEASE_SET_SETTING_KEYS,
  LING_SETTING_KEYS,
  leaseSettings,
  LocalTaskProvisioner,
  readLingSettings,
  type LocalStartedWorker,
} from "../ling/local-provisioner.js";
import {
  LingProvisionerError,
  ProvisionedLingClient,
  resolvedWorkerProfileFromSpawnInput,
  type ProvisionedWorkerLease,
} from "../ling/provisioner.js";
import type { LingFinalState, LingResolvedModel } from "../ling/types.js";

const now = Date.now();
const sourceLingDir = path.resolve(
  process.env["LING_DIR"]?.trim() || fileURLToPath(new URL("../../../ling", import.meta.url)),
);
const profile = {
  profileId: "local-provisioner-check",
  tools: ["read"],
  ...(process.env["AGENT_PROVIDER"]?.trim()
    ? { provider: process.env["AGENT_PROVIDER"]?.trim() }
    : {}),
  ...(process.env["AGENT_MODEL"]?.trim()
    ? { model: process.env["AGENT_MODEL"]?.trim() }
    : {}),
};
const request = (requestKey: string) => ({
  requestKey,
  profile,
  createdAt: new Date(now).toISOString(),
  expiresAt: new Date(now + 5 * 60 * 1000).toISOString(),
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The parent-death case at the end runs this script a second time, as the
 * overlord a child ling must not outlive: that process summons one lease,
 * says which processes it started, and waits to be killed. The check kills it
 * rather than itself, so it is still there to see what the child does.
 */
const STAND_IN_PARENT = "LOCAL_PROVISIONER_CHECK_STAND_IN_PARENT";
const standIn = process.env[STAND_IN_PARENT];
if (standIn !== undefined) {
  const setup = JSON.parse(standIn) as {
    sourceLingDir: string;
    runtimeRootDir: string;
    args: string[];
    reportPath: string;
  };
  const env = { ...process.env };
  delete env[STAND_IN_PARENT];
  let root: number | undefined;
  const parent = new LocalTaskProvisioner({
    sourceLingDir: setup.sourceLingDir,
    runtimeRootDir: setup.runtimeRootDir,
    env,
    args: setup.args,
    // Windows children are not detached, so libuv's job object would end the
    // child with this process whatever it was told. Detached, as POSIX
    // children already are, only the child's own watch can end it.
    ...(process.platform === "win32"
      ? {
          startProcess: (command, args, options) =>
            spawn(command, [...args], { ...options, detached: true, windowsHide: true }),
        }
      : {}),
    bootstrap: async (options) => {
      const runtime = await bootstrapLing(options);
      root = runtime.pid;
      return runtime;
    },
  });
  await parent.summon(request(`local-provisioner-check-orphan-${now}`));
  await writeFile(setup.reportPath, JSON.stringify({ parent: process.pid, root: root ?? null }));
  setInterval(() => undefined, 1 << 30);
  await new Promise<never>(() => undefined);
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

const provisioner = new LocalTaskProvisioner({ sourceLingDir });

let lease;
let defaultPaths: ProvisionedWorkerLease["runtimePaths"];
try {
  await provisioner.recover();
  lease = await provisioner.summon(request(`local-provisioner-check-${now}`));
  const health = await lease.client.health();
  assert.equal(health.ok, true);
  assert.equal(health.workerId, lease.workerId);
  assert.equal(health.maxConcurrency, 1);
  console.log(`PASS  summoned isolated local worker ${lease.workerId}`);

  // The default root begins every task's workspace path, which ling shows the
  // task as its working directory, so it names nothing but the worker.
  defaultPaths = lease.runtimePaths;
  assert(defaultPaths !== undefined, "a local lease does not say where its worker runs");
  const neutralRoot = escapeRegExp(path.join(os.tmpdir(), "ling-overlord-workers"));
  assert.match(defaultPaths.runtimeDir, new RegExp(`^${neutralRoot}[\\\\/]local-[0-9a-f-]{36}-\\w{6}$`));
  assert.equal(defaultPaths.workspacesDir, path.join(defaultPaths.runtimeDir, "workspaces"));
  assert.equal(defaultPaths.home, path.join(defaultPaths.runtimeDir, "runtime-home"));
  assert.equal(defaultPaths.tmp, path.join(defaultPaths.runtimeDir, "tmp"));
  assert.equal(defaultPaths.piAgentDir, undefined);
  assert(existsSync(defaultPaths.tmp), "the lease's temp directory was not made");
  console.log("PASS  a lease runs under the neutral default root, with its home and temp directory inside");
} finally {
  await lease?.release("shutdown");
  await provisioner.shutdown();
}

assert.equal(lease?.released, true);
assert.equal(existsSync(defaultPaths?.runtimeDir ?? ""), false, "the runtime directory outlived release()");
console.log("PASS  stopped and removed isolated local worker");

/**
 * The same service, started through a wrapper that first launches a sleeper and
 * reports what the service process can see. The sleeper stands in for whatever
 * a task leaves running.
 *
 * The sleeper is detached everywhere, which makes it the hard case for both
 * kill paths. On POSIX it leads its own group, as every command Pi's bash tool
 * runs does, so signalling the ling's group misses it. On Windows it is outside
 * the job object libuv puts its children in: without that, killing the root
 * alone takes the whole tree down with it and this check would prove nothing.
 * A second worker has only its root killed first, as a crash would, and its
 * termination must say the tree could not be walked from the root.
 *
 * Its source checkout is a scratch one whose .env holds dummy secrets beside
 * one real setting, with node_modules linked to the real install, and the
 * overlord's environment it is given carries dummy secrets too. A provisioner
 * that copied the file or spread its environment fails the checks below. The
 * checkout also holds what ling keeps locally: reviewed skills, Pi's settings,
 * credential store and model cache beside them, and two saved browser logins.
 * The store holds only another provider's entry, which no child may get; that
 * a child gets its own provider's entry is foundation-check's to show, since
 * here it would hand the worker below a key.
 *
 * One task is posted, to show a lease admits its own limits. Neither the
 * overlord's environment it is given nor the credential store holds a key for
 * its provider, and the worker is checked to hold none, in its environment or
 * its directory, before the post, so the task fails at its first model call
 * without making it. Its final-state record is then read through its lease,
 * where the ling serves one.
 *
 * The wrapper also reports the child's temp variables, os.tmpdir() as the
 * service sees it, which is where Pi's bash tool writes its output files, and
 * the Pi agent directory and model routing it was handed. A third provisioner
 * sets LING_MODEL_ROUTING and piAgentDir, and starts an openrouter child with a
 * dummy key, which is never posted a task, and a scripted one, which needs no
 * key; and its beforePost hook refuses one more. Before any of that, a ling
 * that is only a fetch function shows the order of the hook and the post, and
 * the final-state record's way through a lease, without starting a process.
 */
const dummy = "local-provisioner-check-dummy";
/** The settings the wrapper reports the values of. */
const reportedSettings = [
  "MAX_TURNS",
  "MAX_WALL_CLOCK_MS",
  "MAX_COST_USD",
  "MAX_TOOL_RESULT_CHARS",
  "OVERSIGHT_ADVICE_WAIT_MS",
  "OVERSIGHT_WATCH_IDLE_MS",
] as const;
const wrapperSource = `import { spawn } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const [serverPath, reportPath] = process.argv.slice(2);
const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], {
  detached: true,
  stdio: "ignore",
  windowsHide: true,
});
const files = (dir) =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => path.relative(".", path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    : [];
writeFileSync(reportPath, JSON.stringify({
  server: process.pid,
  grandchild: sleeper.pid,
  keys: Object.keys(process.env),
  carryingDummy: Object.entries(process.env)
    .filter(([, value]) => value?.includes(${JSON.stringify(dummy)}))
    .map(([key]) => key),
  settings: Object.fromEntries(
    ${JSON.stringify(reportedSettings)}.map((name) => [name, process.env[name] ?? null]),
  ),
  lingSettings: Object.fromEntries(
    ${JSON.stringify(LING_SETTING_KEYS)}
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]),
  ),
  files: [...files("agent"), ...files("auth")].sort(),
  dotEnvInWorkingDirectory: existsSync(".env"),
  paths: {
    tmpdir: os.tmpdir(),
    ...Object.fromEntries(
      ["TEMP", "TMP", "TMPDIR", "PI_CODING_AGENT_DIR", "LING_MODEL_ROUTING"].map((name) => [
        name,
        process.env[name] ?? null,
      ]),
    ),
  },
}));
await import(pathToFileURL(serverPath).href);
`;

const scratch = await mkdtemp(path.join(os.tmpdir(), "ling-local-provisioner-check-"));
const scratchLingDir = path.join(scratch, "ling");
const workersDir = path.join(scratch, "workers");
const reportPath = path.join(scratch, "child.json");
const routedReportPath = path.join(scratch, "routed-child.json");
const wrapperPath = path.join(scratch, "ling-with-sleeper.mjs");
await writeFile(wrapperPath, wrapperSource);
await mkdir(scratchLingDir);
await symlink(
  path.join(sourceLingDir, "node_modules"),
  path.join(scratchLingDir, "node_modules"),
  process.platform === "win32" ? "junction" : "dir",
);
// A provider key, but not for a provider any child here runs, which would take
// it: not the first lease's, and not the watcher's, which is openai.
const childProvider = profile.provider ?? "openai";
const otherProvider = childProvider === "groq" ? "mistral" : "groq";
const otherProviderKey = `${otherProvider.toUpperCase()}_API_KEY`;
await writeFile(
  path.join(scratchLingDir, ".env"),
  [
    `OVERLORD_BRAIN_API_KEY=${dummy}-dotenv-brain-key`,
    `LING_TOKEN=${dummy}-dotenv-ling-token`,
    `${otherProviderKey}=${dummy}-dotenv-provider-key`,
    `AGENT_TOKENS_JSON={"intruder":"${dummy}-dotenv-worker-token"}`,
    "MAX_TURNS=3",
  ].join("\n"),
);
const localState: Record<string, string> = {
  "agent/skills/fixture/SKILL.md": "---\nname: fixture\ndescription: Fixture\n---\nA reviewed skill.",
  "agent/settings.json": "{}",
  "agent/auth.json": `{"${otherProvider}":{"type":"api_key","key":"${dummy}-pi-credential"}}`,
  "agent/models-store.json": "{}",
  "auth/site.json": `{"cookies":[],"origins":[],"note":"${dummy}-site-login"}`,
  "auth/other.json": `{"cookies":[],"origins":[],"note":"${dummy}-other-login"}`,
};
for (const [name, content] of Object.entries(localState)) {
  await mkdir(path.dirname(path.join(scratchLingDir, name)), { recursive: true });
  await writeFile(path.join(scratchLingDir, name), content);
}
const overlordSecrets = {
  OVERLORD_BRAIN_API_KEY: `${dummy}-brain-key`,
  LING_TOKEN: `${dummy}-ling-token`,
  LING_WORKERS_JSON: JSON.stringify([
    { id: "fleet", baseUrl: "http://127.0.0.1:1", token: `${dummy}-fleet-token` },
  ]),
  CAMPAIGN_PROGRESS_WEBHOOK_TOKEN: `${dummy}-webhook-token`,
  [otherProviderKey]: `${dummy}-provider-key`,
};
const overlordEnv: NodeJS.ProcessEnv = { ...process.env };
// No real provider key, so the one task posted below cannot reach a model.
for (const name of Object.keys(overlordEnv)) {
  if (/_API_KEY$/i.test(name)) delete overlordEnv[name];
}
Object.assign(overlordEnv, overlordSecrets, {
  OVERSIGHT_ADVICE_WAIT_MS: "15000",
  OVERSIGHT_WATCH_IDLE_MS: "45000",
});
// The overlord's value would win over the .env's, which is checked below, and
// the ceilings are checked against what the task asks for alone. The routing
// is set only where a check below sets it.
for (const name of [
  "MAX_TURNS",
  "MAX_WALL_CLOCK_MS",
  "MAX_COST_USD",
  "MAX_TOOL_RESULT_CHARS",
  "LING_MODEL_ROUTING",
]) {
  delete overlordEnv[name];
}
let handedOver: NodeJS.ProcessEnv | undefined;
let rootPid: number | undefined;
const terminating = new LocalTaskProvisioner({
  sourceLingDir: scratchLingDir,
  runtimeRootDir: workersDir,
  env: overlordEnv,
  args: [
    path.join(sourceLingDir, "node_modules", "tsx", "dist", "cli.mjs"),
    wrapperPath,
    path.join(sourceLingDir, "src", "server.ts"),
    reportPath,
  ],
  // The real bootstrap and a real process; this only records what the
  // provisioner handed it and the pid of the process it started.
  bootstrap: async (options) => {
    handedOver = options.env;
    const runtime = await bootstrapLing(options);
    rootPid = runtime.pid;
    return runtime;
  },
});

/** Windows environment names are case-insensitive. */
const envName = (name: string) => (process.platform === "win32" ? name.toUpperCase() : name);
/**
 * What the platform puts in any child's environment, whatever it is given. On
 * Windows libuv fills in a fixed set of system variables from the parent's own
 * (LOGONSERVER and USERDOMAIN among them), and host software can inject more.
 * None of it is the provisioner's to withhold, so it is measured, not listed.
 */
const platformAdded = JSON.parse(
  execFileSync(
    process.execPath,
    ["-e", "process.stdout.write(JSON.stringify(Object.keys(process.env)))"],
    { env: {}, encoding: "utf8", windowsHide: true },
  ),
) as string[];

interface ChildReport {
  server: number;
  grandchild: number;
  keys: string[];
  carryingDummy: string[];
  settings: Record<(typeof reportedSettings)[number], string | null>;
  /** Every one of LING_SETTING_KEYS the child has, by its name there. */
  lingSettings: Record<string, string>;
  /** Every file under the child's agent/ and auth/, relative to its directory. */
  files: string[];
  dotEnvInWorkingDirectory: boolean;
  paths: {
    /** os.tmpdir() in the service's own process. */
    tmpdir: string;
    TEMP: string | null;
    TMP: string | null;
    TMPDIR: string | null;
    PI_CODING_AGENT_DIR: string | null;
    LING_MODEL_ROUTING: string | null;
  };
}

/**
 * The child's temp variables, and so the os.tmpdir() Pi's output files go to,
 * are all its lease's own tmp/, which is there while the lease is.
 */
function assertTempInLease(report: ChildReport, lease: ProvisionedWorkerLease): void {
  const paths = lease.runtimePaths;
  assert(paths !== undefined, "a local lease does not say where its worker runs");
  assert.equal(paths.tmp, path.join(paths.runtimeDir, "tmp"));
  assert.deepEqual(
    [report.paths.tmpdir, report.paths.TEMP, report.paths.TMP, report.paths.TMPDIR],
    [paths.tmp, paths.tmp, paths.tmp, paths.tmp],
    "the child's temp directory is not its lease's",
  );
  assert(existsSync(paths.tmp), "the lease's temp directory is missing while it runs");
}

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

/** A resolved model as a ling with routing would report it; the values are a fixture's. */
const STUB_MODEL: LingResolvedModel = {
  provider: "openrouter",
  id: "deepseek/deepseek-v4.1-flash",
  api: "openai-completions",
  baseUrl: "https://openrouter.ai/api/v1",
  cost: { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0 },
  compat: {
    openRouterRouting: { order: ["deepseek"], allow_fallbacks: false },
    requiresReasoningContentOnAssistantMessages: true,
  },
  thinkingLevelMap: { low: "low", medium: null },
  contextWindow: 1_000_000,
  maxTokens: 943_718,
  thinking: "low",
};

/**
 * A final-state record with one of each kind of entry: a changed seed and an
 * absent one, a kept file, one too large to keep, a link, and a result.json
 * that is not valid JSON, which the record keeps byte for byte.
 */
function stubRecord(taskId: string): LingFinalState {
  const seeded = "export const settle = () => 1;\n";
  const edited = "export const settle = () => 2;\n";
  const changes = "# Changes\n\n- settle returns 2\n";
  const result = '{"status":"done","summary":"cut off';
  const kept = (text: string) => ({
    sha256: sha256(text),
    size: Buffer.byteLength(text),
    content: text,
    contentOmitted: "none" as const,
  });
  return {
    version: 1,
    taskId,
    workspaceDir: `/stub/workspaces/${taskId}`,
    workspaceDirReal: `/stub/workspaces/${taskId}`,
    capturedAt: "2026-10-07T12:00:00.000Z",
    promptDigest: null,
    seeds: [
      { path: "src/settle.js", seededSha256: sha256(seeded), state: "changed", ...kept(edited) },
      {
        path: "campaign/context.json",
        seededSha256: sha256("{}"),
        state: "absent",
        sha256: null,
        size: 0,
        content: null,
        contentOmitted: "none",
      },
    ],
    files: [
      { path: "CHANGES.md", type: "file", ...kept(changes) },
      {
        path: "node_modules/big.bin",
        type: "file",
        sha256: sha256("big"),
        size: 40_000,
        content: null,
        contentOmitted: "too_large",
      },
      { path: "link", type: "symlink", sha256: null, size: 11, content: null, contentOmitted: "symlink" },
    ],
    filesOmitted: 0,
    result: { present: true, sha256: sha256(result), size: Buffer.byteLength(result), content: result },
  };
}

/**
 * A ling that is only a fetch function: enough of /healthz, POST /tasks,
 * GET /tasks/:id and its final-state record for what the lease and the client
 * do with them. Every request is logged, as `<worker> <method> <path>`, in the
 * one log beforePost writes to as well, so the order between them shows.
 */
interface StubLing {
  log: string[];
  model: LingResolvedModel | null | undefined;
  /** Status per task id; a task is running until a check says otherwise. */
  status: Map<string, "running" | "completed">;
  /** What the final-state route serves for a task, by default stubRecord's. */
  record: (taskId: string) => unknown;
}

function stubFetch(ling: StubLing, workerId: string): LingFetch {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  return async (input, init) => {
    const method = init?.method ?? "GET";
    const { pathname } = new URL(String(input));
    ling.log.push(`${workerId} ${method} ${pathname}`);
    if (pathname === "/healthz") {
      return json(200, {
        ok: true,
        workerId,
        queued: 0,
        running: 0,
        maxConcurrency: 1,
        provider: "openrouter",
        models: [STUB_MODEL.id],
        ...(ling.model === undefined ? {} : { model: ling.model }),
      });
    }
    if (method === "POST" && pathname === "/tasks") {
      const body = JSON.parse(String(init?.body)) as { requestKey?: string; tools?: string[] };
      const id = `${workerId}-task`;
      ling.status.set(id, "running");
      return json(202, {
        id,
        requestKey: body.requestKey,
        status: "running",
        options: { tools: body.tools },
        seededFiles: [],
      });
    }
    const match = /^\/tasks\/([^/]+)(\/final-state)?$/.exec(pathname);
    const id = match === null ? undefined : decodeURIComponent(match[1]!);
    const status = id === undefined ? undefined : ling.status.get(id);
    if (id === undefined || status === undefined) return json(404, { error: "No such task" });
    if (match?.[2] === undefined) {
      return json(200, {
        id,
        status,
        prompt: "Stand in for a builder's brief.",
        options: { tools: ["read"] },
        createdAt: "2026-10-07T11:59:00.000Z",
        ...(status === "completed" ? { finishedAt: "2026-10-07T12:00:00.000Z", result: {} } : {}),
        workspaceDir: `/stub/workspaces/${id}`,
        seededFiles: [],
      });
    }
    if (status !== "completed") {
      return json(409, { error: `Task ${id} is still running.`, code: "task_active" });
    }
    return json(200, ling.record(id));
  };
}

const leases: ProvisionedWorkerLease[] = [];
/** Every process the checks below started, so none is left behind. */
const started: number[] = [];
let passed = false;
try {
  // ---------------------------------------------------------------------------
  // Through a ling that is only a fetch function: the health parse, the order
  // of beforePost and the post, and the final-state record's way to the caller.

  const healthOf = (model: unknown) => {
    const ling: StubLing = { log: [], model: model as LingResolvedModel, status: new Map(), record: stubRecord };
    return new LingClient({
      baseUrl: "http://ling.invalid",
      maxAttempts: 1,
      retryDelayMs: 0,
      fetch: stubFetch(ling, "stub"),
    }).health();
  };
  assert.equal((await healthOf(undefined)).model, undefined);
  assert.equal((await healthOf(null)).model, null);
  assert.deepEqual((await healthOf(STUB_MODEL)).model, STUB_MODEL);
  // Pi's own objects pass through whatever they hold, and may be absent.
  const { compat: _compat, thinkingLevelMap: _levels, ...bare } = STUB_MODEL;
  assert.deepEqual((await healthOf(bare)).model, bare);
  assert.deepEqual(
    (await healthOf({ ...STUB_MODEL, compat: { newPiField: [1] }, cost: { ...STUB_MODEL.cost, tiers: [] } }))
      .model?.compat,
    { newPiField: [1] },
  );
  // Values are the registry's, compared by the caller: a router's variable
  // price is negative there, and a field the entry lacks is null.
  const variablePrice = {
    ...STUB_MODEL,
    id: "openrouter/auto",
    cost: { input: -1_000_000, output: -1_000_000, cacheRead: 0, cacheWrite: 0 },
  };
  assert.deepEqual((await healthOf(variablePrice)).model, variablePrice);
  const sparse = { ...STUB_MODEL, baseUrl: null, cost: null, contextWindow: null, maxTokens: null };
  assert.deepEqual((await healthOf(sparse)).model, sparse);
  const { id: _id, ...unnamed } = STUB_MODEL;
  for (const malformed of [
    { ...STUB_MODEL, served: "DeepSeek" },
    unnamed,
    { ...STUB_MODEL, cost: { ...STUB_MODEL.cost, output: "0.4" } },
    { ...STUB_MODEL, cost: { input: 0.1, output: 0.4 } },
    { ...STUB_MODEL, thinking: "warm" },
    { ...STUB_MODEL, compat: [] },
    { ...STUB_MODEL, thinkingLevelMap: { low: 1 } },
    { ...STUB_MODEL, contextWindow: "1000000" },
    { ...STUB_MODEL, baseUrl: 443 },
    "openrouter/deepseek/deepseek-v4.1-flash",
  ]) {
    await assert.rejects(
      healthOf(malformed),
      (error: unknown) => error instanceof LingProtocolError,
      JSON.stringify(malformed),
    );
  }
  console.log("PASS  healthz passes the resolved model through, and refuses one that is malformed");

  const stub: StubLing = { log: [], model: STUB_MODEL, status: new Map(), record: stubRecord };
  const shown: LocalStartedWorker[] = [];
  const stubWorkersDir = path.join(scratch, "stub-workers");
  const stubbed = new LocalTaskProvisioner({
    sourceLingDir: scratchLingDir,
    runtimeRootDir: stubWorkersDir,
    env: overlordEnv,
    // The stub starts nothing, so here this bounds only beforePost.
    startupTimeoutMs: 500,
    bootstrap: async (options) => {
      const workerId = options.env?.["WORKER_ID"] ?? "";
      return {
        client: new LingClient({
          baseUrl: options.baseUrl ?? "http://ling.invalid",
          token: options.token ?? "",
          maxAttempts: 1,
          retryDelayMs: 0,
          fetch: stubFetch(stub, workerId),
        }),
        startedByOverlord: true,
        stop: async () => undefined,
        kill: async () => [],
        stopTree: async () => [],
      };
    },
    beforePost: (worker) => {
      shown.push(worker);
      stub.log.push(`${worker.workerId} beforePost`);
      if (worker.requestKey.endsWith(":refused")) {
        throw new Error("local-provisioner-check: beforePost refused this worker");
      }
      if (worker.requestKey.endsWith(":hung")) return new Promise<never>(() => undefined);
      return undefined;
    },
  });
  const stubClient = new ProvisionedLingClient({
    provisioner: stubbed,
    resolveProfile: resolvedWorkerProfileFromSpawnInput,
  });
  const spawned = await stubClient.spawn({
    task: "Stand in for a builder's brief.",
    requestKey: `local-provisioner-check-stub-${now}`,
    provider: "openrouter",
    model: STUB_MODEL.id,
    thinking: "low",
    tools: ["read"],
  });
  const stubLease = stubbed.lease(spawned.workerId ?? "");
  assert(stubLease !== undefined);
  leases.push(stubLease);
  assert.deepEqual(
    stub.log.filter((entry) => entry.startsWith(`${stubLease.workerId} `)),
    [
      `${stubLease.workerId} GET /healthz`,
      `${stubLease.workerId} beforePost`,
      `${stubLease.workerId} POST /tasks`,
    ],
  );
  assert.equal(shown.length, 1);
  assert.equal(shown[0]?.workerId, stubLease.workerId);
  assert.equal(shown[0]?.health.workerId, stubLease.workerId);
  assert.deepEqual(shown[0]?.health.model, STUB_MODEL);
  assert.equal(shown[0]?.profile.provider, "openrouter");
  assert.deepEqual(shown[0]?.runtimePaths, stubLease.runtimePaths);
  console.log("PASS  beforePost is shown the worker's health once it answers, before its task is posted");

  await assert.rejects(
    stubClient.finalState(spawned.id, spawned.workerId),
    (error: unknown) =>
      error instanceof LingClientError && error.status === 409 && error.code === "task_active",
  );
  stub.status.set(spawned.id, "completed");
  assert.deepEqual(await stubClient.finalState(spawned.id, spawned.workerId), stubRecord(spawned.id));
  // What ling saw nothing of may have no size, and something at result.json
  // that is not a regular file is present with no hash. What ling could not
  // read is listed unread, and the workspace itself as `.` when it is a link.
  // A backslash is a POSIX file name's to hold, so it is not the parse's to
  // refuse.
  const accepted: Array<[string, (record: LingFinalState) => LingFinalState]> = [
    ["an absent seed and an absent result with no size", (record) => {
      record.seeds[1]!.size = null;
      record.result = { present: false, sha256: null, size: null, content: null };
      return record;
    }],
    ["a seed that is now a directory", (record) => {
      record.seeds[1] = { ...record.seeds[1]!, state: "not_regular", size: 4096 };
      return record;
    }],
    ["a result.json that is a link", (record) => {
      record.result = { present: true, sha256: null, size: 11, content: null };
      return record;
    }],
    ["a file name with a backslash", (record) => {
      record.files[1]!.path = "node_modules/big\\part.bin";
      return record;
    }],
    ["a seed that could not be read", (record) => {
      record.seeds[1] = { ...record.seeds[1]!, state: "unreadable", size: 2 };
      return record;
    }],
    ["a file that could not be read", (record) => {
      record.files[1] = { ...record.files[1]!, sha256: null, contentOmitted: "unreadable" };
      return record;
    }],
    ["a directory that could not be listed", (record) => {
      record.files.push({
        path: "locked",
        type: "directory",
        sha256: null,
        size: 0,
        content: null,
        contentOmitted: "unreadable",
      });
      return record;
    }],
    ["a workspace that is itself a link", (record) => {
      record.seeds = record.seeds.map((seed) => ({
        ...seed,
        state: "not_regular",
        sha256: null,
        size: 0,
        content: null,
        contentOmitted: "none",
      }));
      record.files = [
        { path: ".", type: "symlink", sha256: null, size: 0, content: null, contentOmitted: "symlink" },
      ];
      record.result = { present: true, sha256: null, size: 0, content: null };
      return record;
    }],
  ];
  for (const [label, vary] of accepted) {
    stub.record = (taskId) => vary(stubRecord(taskId));
    assert.deepEqual(
      await stubClient.finalState(spawned.id, spawned.workerId),
      vary(stubRecord(spawned.id)),
      label,
    );
  }
  // A record that contradicts itself is refused rather than scored, and so is
  // a path no ling lists, whatever the task named its files.
  const tampered: Array<[string, (record: LingFinalState) => unknown]> = [
    ["content that is not its hash", (record) => {
      record.seeds[0]!.content = "export const settle = () => 3;\n";
      return record;
    }],
    ["an unchanged seed with another hash", (record) => {
      record.seeds[0]!.state = "unchanged";
      return record;
    }],
    ["an absent seed with content", (record) => {
      record.seeds[1]!.content = "{}";
      return record;
    }],
    ["a kept file without its content", (record) => {
      record.files[0]!.content = null;
      return record;
    }],
    ["a link with a hash", (record) => {
      record.files[2]!.sha256 = sha256("target");
      return record;
    }],
    ["result.json among the files", (record) => {
      record.files[0]!.path = "result.json";
      return record;
    }],
    ["a seed among the files", (record) => {
      record.files[0]!.path = "src/settle.js";
      return record;
    }],
    ["an absent result with a hash", (record) => {
      record.result = { present: false, sha256: sha256(""), size: 0, content: null };
      return record;
    }],
    ["an absent seed with a size", (record) => {
      record.seeds[1]!.size = 12;
      return record;
    }],
    ["an absent result with a size", (record) => {
      record.result = { present: false, sha256: null, size: 12, content: null };
      return record;
    }],
    ["a hash with no size", (record) => {
      record.seeds[0]!.size = null;
      return record;
    }],
    ["a result.json that is not a file, with content", (record) => {
      record.result = { ...record.result, sha256: null };
      return record;
    }],
    ["a seed path that leaves the workspace", (record) => {
      record.seeds[1]!.path = "../context.json";
      return record;
    }],
    ["a seed at the workspace's own path", (record) => {
      record.seeds[1]!.path = ".";
      return record;
    }],
    ["an unread file with content", (record) => {
      record.files[0] = { ...record.files[0]!, sha256: null, contentOmitted: "unreadable" };
      return record;
    }],
    ["a file read and said to be unreadable", (record) => {
      record.files[1]!.contentOmitted = "unreadable";
      return record;
    }],
    ["a link said to be unreadable", (record) => {
      record.files[2]!.contentOmitted = "unreadable";
      return record;
    }],
    ["a directory with a hash", (record) => {
      record.files.push({
        path: "listed",
        type: "directory",
        sha256: sha256(""),
        size: 0,
        content: null,
        contentOmitted: "none",
      });
      return record;
    }],
    ...["../../outside.txt", "/etc/passwd", "notes//a.md", "./CHANGES.md", "src/./a.js", "notes/", "a\0b", "."].map(
      (badPath): [string, (record: LingFinalState) => unknown] => [
        `the file path ${JSON.stringify(badPath)}`,
        (record) => {
          record.files[0]!.path = badPath;
          return record;
        },
      ],
    ),
    ["another task's record", (record) => ({ ...record, taskId: "another-task" })],
    ["a later version", (record) => ({ ...record, version: 2 })],
    ["a field version 1 does not have", (record) => ({ ...record, extra: true })],
  ];
  for (const [label, tamper] of tampered) {
    stub.record = (taskId) => tamper(stubRecord(taskId));
    await assert.rejects(
      stubClient.finalState(spawned.id, spawned.workerId),
      (error: unknown) => error instanceof LingProtocolError,
      label,
    );
  }
  stub.record = stubRecord;
  console.log(
    "PASS  a final-state record is read through its lease, and one that contradicts itself " +
      "or names a path no ling lists is refused",
  );

  // The one honest record that is refused: one past the byte ceiling, which a
  // task can cause by naming 20 000 files in control characters, each of which
  // JSON writes in six bytes. It has an error of its own, for a caller to record.
  stub.record = (taskId) => ({
    ...stubRecord(taskId),
    files: Array.from({ length: 20_000 }, (_, index) => ({
      path: `${index}/${"\u0001".repeat(300)}`,
      type: "file",
      sha256: sha256(""),
      size: 0,
      content: "",
      contentOmitted: "none",
    })),
  });
  await assert.rejects(
    stubClient.finalState(spawned.id, spawned.workerId),
    (error: unknown) =>
      error instanceof LingFinalStateTooLargeError &&
      error.taskId === spawned.id &&
      error.maxBytes === 32 * 1024 * 1024,
  );
  stub.record = stubRecord;
  console.log("PASS  a record past the byte ceiling, which a task can cause, is refused with an error of its own");

  await stubClient.collectComplete(spawned.id, spawned.workerId);
  await stubClient.release(spawned.id, spawned.workerId);
  await assert.rejects(
    stubClient.finalState(spawned.id, spawned.workerId),
    (error: unknown) => error instanceof LingProvisionerError && error.code === "worker_released",
  );
  assert.equal(existsSync(stubLease.runtimePaths?.runtimeDir ?? ""), false);
  console.log("PASS  the final-state record goes with the worker: none is read after its release");

  await assert.rejects(
    stubClient.spawn({
      task: "Never posted.",
      requestKey: `local-provisioner-check-stub-${now}:refused`,
      provider: "openrouter",
      model: STUB_MODEL.id,
      tools: ["read"],
    }),
    /beforePost refused this worker/,
  );
  const refusedWorker = shown[1];
  assert(refusedWorker !== undefined);
  assert.deepEqual(
    stub.log.filter((entry) => entry.startsWith(`${refusedWorker.workerId} `)),
    [`${refusedWorker.workerId} GET /healthz`, `${refusedWorker.workerId} beforePost`],
    "a task was posted to a worker beforePost refused",
  );
  assert.equal(stubbed.lease(refusedWorker.workerId), undefined);
  assert.equal(existsSync(refusedWorker.runtimePaths.runtimeDir), false);
  assert.deepEqual(await readdir(stubWorkersDir), []);
  console.log("PASS  a beforePost that throws fails the summon, and nothing is posted to the worker");

  // Until its lease exists a worker is out of forceShutdown()'s reach, so a
  // hook that never settles is not waited on past the startup timeout.
  await assert.rejects(
    stubClient.spawn({
      task: "Never posted.",
      requestKey: `local-provisioner-check-stub-${now}:hung`,
      provider: "openrouter",
      model: STUB_MODEL.id,
      tools: ["read"],
    }),
    /beforePost did not settle within 500ms/,
  );
  const hungWorker = shown[2];
  assert(hungWorker !== undefined);
  assert.deepEqual(
    stub.log.filter((entry) => entry.startsWith(`${hungWorker.workerId} `)),
    [`${hungWorker.workerId} GET /healthz`, `${hungWorker.workerId} beforePost`],
    "a task was posted to a worker whose beforePost never settled",
  );
  assert.equal(stubbed.lease(hungWorker.workerId), undefined);
  assert.deepEqual(await readdir(stubWorkersDir), []);
  console.log("PASS  a beforePost that never settles fails the summon at the startup timeout");

  const target = await terminating.summon(request(`local-provisioner-check-terminate-${now}`));
  leases.push(target);
  const report = JSON.parse(await readFile(reportPath, "utf8")) as ChildReport;
  started.push(report.grandchild, report.server, ...(rootPid === undefined ? [] : [rootPid]));
  assert.deepEqual(report.carryingDummy, [], "a dummy secret reached the child");
  for (const name of Object.keys(overlordSecrets)) {
    assert(!report.keys.map(envName).includes(envName(name)), `${name} reached the child`);
  }
  assert.equal(report.dotEnvInWorkingDirectory, false, "the source .env was copied");
  assert.equal(
    report.settings.MAX_TURNS,
    "3",
    "ling's own settings did not reach the child from its .env",
  );
  assert.equal(report.settings.OVERSIGHT_ADVICE_WAIT_MS, "15000");
  assert.equal(report.settings.OVERSIGHT_WATCH_IDLE_MS, "45000");
  // What the real process sees is what the provisioner built, plus the
  // address bootstrapLing adds and what the platform adds to every child;
  // nothing else of the overlord's crosses on the way, through bootstrapLing or
  // tsx. Which names the provisioner builds is foundation-check's to pin.
  const built = new Set(
    [...Object.keys(handedOver ?? {}), "BIND_ADDRESS", "PORT", ...platformAdded].map(envName),
  );
  assert(built.has(envName("PATH")) && built.has(envName("WORKER_ID")));
  assert.deepEqual(
    report.keys.filter((key) => !built.has(envName(key))),
    [],
    "the child sees variables the provisioner never named",
  );
  console.log("PASS  child environment is the named one, without the overlord's secrets or a .env");

  assertTempInLease(report, target);
  assert.equal(report.paths.PI_CODING_AGENT_DIR, null, "a Pi agent directory crossed unasked");
  console.log("PASS  a child's TEMP, TMP and TMPDIR, and so its os.tmpdir(), are its lease's own tmp/");

  // What the preflight reads is what a child is handed: the scratch .env's one
  // setting and none of its secrets, under the overlord's own.
  const settings = await readLingSettings({ sourceLingDir: scratchLingDir, env: overlordEnv });
  assert.deepEqual(settings.dotEnv, { MAX_TURNS: "3" });
  assert.equal(settings.environment["OVERSIGHT_ADVICE_WAIT_MS"], "15000");
  for (const name of reportedSettings) {
    assert.equal(
      report.settings[name],
      settings.inForce[name] ?? null,
      `${name} reached the child otherwise than readLingSettings reads it`,
    );
  }
  // And of all ling's settings, the child has those in force with its lease's
  // own over them, and nothing else changed.
  assert.deepEqual(
    report.lingSettings,
    { ...settings.inForce, ...leaseSettings(target.profile, settings.inForce) },
    "a child's ling settings are not those in force under leaseSettings()",
  );
  // Of what a lease sets, what a profile can state is LEASE_SET_SETTING_KEYS;
  // an oversight tool also raises MAX_TOOL_RESULT_CHARS, and never lowers it.
  const statesAll = {
    profileId: "local-provisioner-check-states-all",
    tools: ["read"],
    provider: "openrouter",
    model: STUB_MODEL.id,
    thinking: "low" as const,
    limits: { maxTurns: 10, maxWallClockMs: 60_000, maxCostUsd: 0.5 },
  };
  const setOver = (tools: string[], inherited: NodeJS.ProcessEnv) =>
    Object.keys(leaseSettings({ ...statesAll, tools }, inherited)).sort();
  assert(LEASE_SET_SETTING_KEYS.every((name) => LING_SETTING_KEYS.includes(name)));
  assert.deepEqual(setOver(["read"], {}), [...LEASE_SET_SETTING_KEYS].sort());
  assert.deepEqual(
    setOver(["read", "tell_principal"], { MAX_TOOL_RESULT_CHARS: "8000" }),
    [...LEASE_SET_SETTING_KEYS, "MAX_TOOL_RESULT_CHARS"].sort(),
  );
  assert.deepEqual(setOver(["tell_principal"], { MAX_TOOL_RESULT_CHARS: "20000" }), [
    ...LEASE_SET_SETTING_KEYS,
  ].sort());
  assert.deepEqual(setOver(["read"], { MAX_TOOL_RESULT_CHARS: "8000" }), [...LEASE_SET_SETTING_KEYS].sort());
  console.log(
    "PASS  readLingSettings reads ling's settings by source, as a child is handed them, " +
      "and leaseSettings what its lease sets over them",
  );

  assert.deepEqual(
    report.files,
    ["agent/settings.json", "agent/skills/fixture/SKILL.md"],
    "the child got more of ling's local state than the reviewed skills and Pi's settings",
  );
  console.log(
    "PASS  child gets the reviewed skills and Pi's settings, not another provider's " +
      "credentials, the model cache or browser logins",
  );

  // Without limits of its own the lease keeps ling's setting, three turns, and
  // refuses a watcher's budget: what the next lease's ceilings are for. Ling
  // checks the budget before the tools, so the unknown tool changes nothing
  // here, except that no task could run if the budget were let through.
  await assert.rejects(
    target.client.spawn({
      task: "Refused before it is queued.",
      requestKey: `local-provisioner-check-refused-${now}`,
      maxTurns: 154,
      tools: ["local_provisioner_check_no_such_tool"],
    }),
    /Ling returned 400: "maxTurns" of 154 exceeds this server's limit of 3/,
  );

  assert(alive(report.server) && alive(report.grandchild));
  const termination = await target.terminate("operator");
  assert.equal(termination.reason, "operator");
  assert.deepEqual(termination.errors, []);
  assert.notEqual(termination.completedAt, undefined);
  assert.equal(target.released, true);
  assert.equal(alive(report.server), false, "the ling service outlived terminate()");
  assert.equal(alive(report.grandchild), false, "the grandchild outlived terminate()");
  assert.deepEqual(await readdir(workersDir), []);
  assert.equal(existsSync(target.runtimePaths?.tmp ?? ""), false);
  console.log("PASS  terminate killed the worker's process tree and removed its directory");

  // A watcher's lease, as resolvedWorkerProfileFromSpawnInput makes it from the
  // spawn input for a worker at the builder default of 600 000 ms, with one
  // saved login. The provider is fixed, so that its key is known to be absent, and so is the model:
  // left to the ling's AGENT_MODEL, an id Pi does not know for openai fails the task before its key does.
  const watcherKey = `local-provisioner-check-watcher-${now}`;
  const watcherInput = {
    task: "Stand in for a watcher's brief.",
    requestKey: watcherKey,
    provider: "openai",
    model: "gpt-5",
    tools: ["watch_next", "report_concern", "write_result"],
    maxTurns: 154,
    maxWallClockMs: 1_620_000,
    maxCostUsd: 0.75,
    storageState: "site",
  };
  const watcher = await terminating.summon({
    ...request(watcherKey),
    profile: resolvedWorkerProfileFromSpawnInput(watcherInput),
  });
  leases.push(watcher);
  const watcherReport = JSON.parse(await readFile(reportPath, "utf8")) as ChildReport;
  started.push(
    watcherReport.grandchild,
    watcherReport.server,
    ...(rootPid === undefined ? [] : [rootPid]),
  );
  assert.deepEqual(watcherReport.settings, {
    MAX_TURNS: "154",
    MAX_WALL_CLOCK_MS: "1620000",
    MAX_COST_USD: "0.75",
    MAX_TOOL_RESULT_CHARS: "12000",
    OVERSIGHT_ADVICE_WAIT_MS: "15000",
    OVERSIGHT_WATCH_IDLE_MS: "45000",
  });
  // Its MAX_TOOL_RESULT_CHARS is none in force, and leaseSettings says so.
  assert.equal(settings.inForce["MAX_TOOL_RESULT_CHARS"], undefined);
  assert.deepEqual(watcherReport.lingSettings, {
    ...settings.inForce,
    ...leaseSettings(watcher.profile, settings.inForce),
  });
  assert.deepEqual(watcherReport.files, [
    "agent/settings.json",
    "agent/skills/fixture/SKILL.md",
    "auth/site.json",
  ]);
  assertTempInLease(watcherReport, watcher);
  // The task posted below must not be able to reach a model.
  const credentials = [
    ...watcherReport.keys.filter((key) => /_API_KEY$/i.test(key)),
    ...watcherReport.files.filter((file) => file === "agent/auth.json"),
  ];
  assert.deepEqual(credentials, [], "the worker holds a provider key; refusing to post a task");
  // The watcher's own tools are the oversight ling's to accept; this ling
  // predates them, so the post carries the watcher's budget with a tool it
  // knows. Ling's defaults (40 turns, 900 000 ms) would refuse that budget.
  // One seeded file, for its final-state record below.
  const seedText = "A seeded note.\n";
  const posted = await watcher.client.spawn({
    task: watcherInput.task,
    requestKey: watcherKey,
    maxTurns: watcherInput.maxTurns,
    maxWallClockMs: watcherInput.maxWallClockMs,
    maxCostUsd: watcherInput.maxCostUsd,
    tools: ["read"],
    files: { "notes/seed.txt": seedText },
  });
  assert.deepEqual(
    [posted.options.maxTurns, posted.options.maxWallClockMs, posted.options.maxCostUsd],
    [154, 1_620_000, 0.75],
  );
  let ended = await watcher.client.get(posted.id);
  const deadline = Date.now() + 30_000;
  while (!isTerminalStatus(ended.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    ended = await watcher.client.get(posted.id);
  }
  assert.equal(ended.status, "failed", "the task without a provider key did not fail");
  assert.match(ended.error ?? "", /api key/i, "the task failed for a reason other than its missing key");
  assert.equal(ended.stats?.cost ?? 0, 0);
  console.log("PASS  a lease's ceilings are its task's own limits, so a watcher's budget is admitted");
  console.log("PASS  a lease gets only the browser login its task names");

  // Read as a capture reads it: through a client that routes by the lease,
  // before the release. A ling that does not report its resolved model
  // predates the final-state route as well.
  const watcherRoutes = new ProvisionedLingClient({
    provisioner: terminating,
    resolveProfile: resolvedWorkerProfileFromSpawnInput,
  });
  if ((await watcher.client.health()).model === undefined) {
    await assert.rejects(
      watcherRoutes.finalState(posted.id, watcher.workerId),
      (error: unknown) => error instanceof LingClientError && error.status === 404,
    );
    console.log(
      "SKIP  a terminal task's final-state record through its lease -- " +
        "this ling predates GET /tasks/:id/final-state",
    );
  } else {
    const record = await watcherRoutes.finalState(posted.id, watcher.workerId);
    assert.equal(record.taskId, posted.id);
    assert.equal(record.workspaceDir, ended.workspaceDir);
    assert.deepEqual(record.seeds, [
      {
        path: "notes/seed.txt",
        seededSha256: sha256(seedText),
        state: "unchanged",
        sha256: sha256(seedText),
        size: Buffer.byteLength(seedText),
        content: seedText,
        contentOmitted: "none",
      },
    ]);
    assert.equal(record.result.present, false);
    console.log("PASS  a terminal task's final-state record is read through its lease");
  }

  // The sleeper stands in for what the finished task backgrounded.
  assert(alive(watcherReport.server) && alive(watcherReport.grandchild));
  await watcher.release("task-failed");
  assert.equal(watcher.released, true);
  assert.deepEqual(watcher.releaseCaveats, []);
  assert.equal(watcher.termination, undefined);
  assert.equal(alive(watcherReport.server), false, "the ling service outlived release()");
  assert.equal(alive(watcherReport.grandchild), false, "the backgrounded process outlived release()");
  assert.deepEqual(await readdir(workersDir), []);
  assert.equal(existsSync(watcher.runtimePaths?.tmp ?? ""), false);
  console.log("PASS  release stopped the worker, killed what its task left running and removed its directory");

  // Model routing and a Pi agent directory of the caller's, handed to an
  // openrouter child and to a scripted one alike, as a paid run hands them to
  // A and B and to the scripted reviewer beside them. The openrouter child
  // holds a dummy key and is never posted a task; the scripted one would
  // answer from a one-line script, and needs no key.
  const routing = {
    [STUB_MODEL.id]: { order: ["deepseek"], allow_fallbacks: false },
  };
  const routedWorkersDir = path.join(scratch, "routed-workers");
  const piAgentDir = path.join(scratch, "pi-agent");
  const modelScript = path.join(scratch, "scripted-model.json");
  await mkdir(piAgentDir);
  await writeFile(modelScript, JSON.stringify({ version: 1, turns: [{ text: "Nothing to do." }] }));
  // A relative one would be read against each child's own working directory.
  assert.throws(
    () => new LocalTaskProvisioner({ sourceLingDir: scratchLingDir, piAgentDir: "pi-agent" }),
    (error: unknown) =>
      error instanceof LingProvisionerError &&
      error.code === "invalid_request" &&
      /^piAgentDir must be an absolute path/.test(error.message),
  );
  const routedShown: LocalStartedWorker[] = [];
  let routedRoot: number | undefined;
  const routed = new LocalTaskProvisioner({
    sourceLingDir: scratchLingDir,
    runtimeRootDir: routedWorkersDir,
    env: {
      ...overlordEnv,
      LING_MODEL_ROUTING: JSON.stringify(routing),
      OPENROUTER_API_KEY: `${dummy}-openrouter-key`,
    },
    piAgentDir,
    args: [
      path.join(sourceLingDir, "node_modules", "tsx", "dist", "cli.mjs"),
      wrapperPath,
      path.join(sourceLingDir, "src", "server.ts"),
      routedReportPath,
    ],
    bootstrap: async (options) => {
      const scripted = /^scripted(-|$)/.test(options.env?.["AGENT_PROVIDER"] ?? "");
      const runtime = await bootstrapLing(
        scripted
          ? {
              ...options,
              env: { ...options.env, LING_SCRIPTED_MODEL: modelScript, LING_ALLOW_SCRIPTED_MODEL: "1" },
            }
          : options,
      );
      routedRoot = runtime.pid;
      return runtime;
    },
    beforePost: (worker) => {
      routedShown.push(worker);
      if (worker.requestKey.endsWith(":refused")) {
        throw new Error("local-provisioner-check: beforePost refused this worker");
      }
    },
  });
  const summonRouted = async (
    requestKey: string,
    child: { provider: string; model: string; thinking?: "low" },
  ) => {
    const routedLease = await routed.summon({
      ...request(requestKey),
      profile: { profileId: requestKey, tools: ["read"], ...child },
    });
    leases.push(routedLease);
    const routedReport = JSON.parse(await readFile(routedReportPath, "utf8")) as ChildReport;
    started.push(routedReport.grandchild, routedReport.server, ...(routedRoot === undefined ? [] : [routedRoot]));
    return { lease: routedLease, report: routedReport };
  };
  const openrouter = await summonRouted(`local-provisioner-check-openrouter-${now}`, {
    provider: "openrouter",
    model: STUB_MODEL.id,
    thinking: "low",
  });
  const scripted = await summonRouted(`local-provisioner-check-scripted-${now}`, {
    provider: "scripted-reviewer",
    model: "scripted-model",
  });
  for (const child of [openrouter, scripted]) {
    assert.equal(child.report.paths.LING_MODEL_ROUTING, JSON.stringify(routing));
    assert.equal(child.report.paths.PI_CODING_AGENT_DIR, piAgentDir);
    assert.equal(child.lease.runtimePaths?.piAgentDir, piAgentDir);
    assertTempInLease(child.report, child.lease);
  }
  // Each holds its own provider's key, which for the scripted one is none.
  assert.deepEqual(openrouter.report.carryingDummy, ["OPENROUTER_API_KEY"]);
  assert.deepEqual(scripted.report.carryingDummy, []);
  console.log("PASS  with LING_MODEL_ROUTING set, an openrouter child and a scripted child both start, and both get it");
  console.log("PASS  piAgentDir reaches every child as PI_CODING_AGENT_DIR, and a relative one is refused");

  assert.deepEqual(
    routedShown.map((worker) => [worker.workerId, worker.health.workerId, worker.health.provider]),
    [
      [openrouter.lease.workerId, openrouter.lease.workerId, "openrouter"],
      [scripted.lease.workerId, scripted.lease.workerId, "scripted-reviewer"],
    ],
  );
  const [openrouterModel, scriptedModel] = routedShown.map((worker) => worker.health.model);
  if (openrouterModel === undefined) {
    console.log(
      "SKIP  the routing in force in the openrouter child's resolved model -- " +
        "this ling does not report its resolved model",
    );
  } else {
    assert.equal(openrouterModel?.id, STUB_MODEL.id);
    assert.equal(openrouterModel?.thinking, "low");
    assert.deepEqual(openrouterModel?.compat?.["openRouterRouting"], routing[STUB_MODEL.id]);
    assert.equal(scriptedModel?.compat?.["openRouterRouting"], undefined);
    console.log("PASS  the openrouter child resolves its model with the routing, and the scripted child without");
  }

  const routedClient = new ProvisionedLingClient({
    provisioner: routed,
    resolveProfile: resolvedWorkerProfileFromSpawnInput,
  });
  const refusedKey = `local-provisioner-check-refused-${now}:refused`;
  await assert.rejects(
    routedClient.spawn({
      task: "Never posted.",
      requestKey: refusedKey,
      provider: "scripted-reviewer",
      model: "scripted-model",
      tools: ["read"],
    }),
    /beforePost refused this worker/,
  );
  const refusedReport = JSON.parse(await readFile(routedReportPath, "utf8")) as ChildReport;
  started.push(
    refusedReport.grandchild,
    refusedReport.server,
    ...(routedRoot === undefined ? [] : [routedRoot]),
  );
  const refused = routedShown.find((worker) => worker.requestKey === refusedKey);
  assert(refused !== undefined, "beforePost was not shown the refused worker");
  assert.equal(routed.lease(refused.workerId), undefined);
  assert.equal(alive(refusedReport.server), false, "a worker beforePost refused is still running");
  assert.equal(alive(refusedReport.grandchild), false, "what a refused worker started is still running");
  assert.equal(existsSync(refused.runtimePaths.runtimeDir), false);
  assert.deepEqual(await routedClient.list(), [], "a task reached one of the routed workers");
  console.log("PASS  a real worker beforePost refuses is stopped and removed, and given no task");

  for (const child of [openrouter, scripted]) await child.lease.release("shutdown");
  for (const child of [openrouter, scripted]) {
    assert.equal(alive(child.report.server), false, "a routed worker outlived release()");
    assert.equal(alive(child.report.grandchild), false);
  }
  assert.deepEqual(await readdir(routedWorkersDir), []);
  // The agent directory is the caller's, outside every lease.
  assert(existsSync(piAgentDir));
  console.log("PASS  release removes each lease's tmp/ with its directory, and leaves piAgentDir to its owner");

  // A worker whose root died on its own, the case terminate("worker-unreachable")
  // is for. The kill can no longer walk the tree from the root, and the record
  // has to say so rather than read as a clean kill.
  const crashed = await terminating.summon(request(`local-provisioner-check-crashed-${now}`));
  leases.push(crashed);
  const crashedReport = JSON.parse(await readFile(reportPath, "utf8")) as ChildReport;
  const crashedRoot = rootPid;
  assert(crashedRoot !== undefined && crashedRoot !== report.server);
  started.push(crashedReport.grandchild, crashedReport.server, crashedRoot);
  assert(alive(crashedReport.server) && alive(crashedReport.grandchild));
  process.kill(crashedRoot, "SIGKILL");
  assert(await waitUntil(() => !alive(crashedRoot), 10_000), "the root outlived SIGKILL");
  // Time for the overlord to see the exit, as it would have long before a
  // caller decided the worker was unreachable.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const crash = await crashed.terminate("worker-unreachable");
  assert.equal(crash.reason, "worker-unreachable");
  assert.match(
    crash.errors[0] ?? "",
    /^kill worker \S+: the root had exited before the kill, so its tree /,
    "a kill that could not walk the tree read as a clean one",
  );
  if (process.platform === "win32") {
    // Windows has nothing to look in once the root is gone. The detached
    // sleeper lives on, and its working directory holds the runtime directory,
    // which keeps the termination open; the record names both.
    assert(alive(crashedReport.grandchild), "the sleeper died with the root; this proves nothing");
    assert.equal(crash.completedAt, undefined);
    assert.match(crash.errors.join("\n"), /remove runtime directory: /);
    process.kill(crashedReport.grandchild);
    assert(await waitUntil(() => !alive(crashedReport.grandchild), 10_000));
    const finished = await crashed.terminate("operator");
    assert.notEqual(finished.completedAt, undefined);
    assert.equal(finished.reason, "worker-unreachable");
    assert.deepEqual(finished.errors, [crash.errors[0]], "the caveat went with the retry");
  } else {
    if (process.platform === "linux") {
      // The marker still reaches the sleeper, whatever became of its parents.
      assert.equal(alive(crashedReport.grandchild), false, "the sleeper outlived terminate()");
    } else if (alive(crashedReport.grandchild)) {
      // Elsewhere the root's group is the only way in, and the sleeper is out
      // of reach once the server has died with the root; the caveat says so.
      process.kill(crashedReport.grandchild);
    }
    assert.notEqual(crash.completedAt, undefined);
  }
  assert.equal(alive(crashedReport.server), false, "the ling service outlived terminate()");
  assert.equal(crashed.released, true);
  assert.deepEqual(await readdir(workersDir), []);
  console.log("PASS  terminate after the root died says the tree could not be walked from it");

  // An overlord that dies without releasing its lease, as a crash or a kill
  // leaves one: nothing will ever stop the child, so the child stops itself.
  // The stand-in parent is this script again (see STAND_IN_PARENT), and the
  // service reports its own pid and the parent it was given through a
  // wrapper with no sleeper, since a detached sleeper would outlive any watch.
  const orphanWorkersDir = path.join(scratch, "orphan-workers");
  const orphanReportPath = path.join(scratch, "orphan.json");
  const orphanServerPath = path.join(scratch, "orphan-server.json");
  const pidWrapperPath = path.join(scratch, "ling-reporting-pid.mjs");
  await writeFile(
    pidWrapperPath,
    `import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const [serverPath, reportPath] = process.argv.slice(2);
writeFileSync(reportPath, JSON.stringify({ server: process.pid, parent: process.env.LING_PARENT_PID ?? null }));
await import(pathToFileURL(serverPath).href);
`,
  );
  const standInParent = spawn(
    process.execPath,
    ["--import", import.meta.resolve("tsx"), fileURLToPath(import.meta.url)],
    {
      env: {
        ...overlordEnv,
        [STAND_IN_PARENT]: JSON.stringify({
          sourceLingDir: scratchLingDir,
          runtimeRootDir: orphanWorkersDir,
          args: [
            path.join(sourceLingDir, "node_modules", "tsx", "dist", "cli.mjs"),
            pidWrapperPath,
            path.join(sourceLingDir, "src", "server.ts"),
            orphanServerPath,
          ],
          reportPath: orphanReportPath,
        }),
      },
      stdio: "inherit",
      windowsHide: true,
    },
  );
  if (standInParent.pid !== undefined) started.push(standInParent.pid);
  assert(
    await waitUntil(() => existsSync(orphanReportPath) && existsSync(orphanServerPath), 90_000),
    "the stand-in parent did not summon its lease",
  );
  const orphan = JSON.parse(await readFile(orphanReportPath, "utf8")) as {
    parent: number;
    root: number | null;
  };
  const orphanServer = JSON.parse(await readFile(orphanServerPath, "utf8")) as {
    server: number;
    parent: string | null;
  };
  assert(orphan.root !== null, "the stand-in parent did not see its child's pid");
  started.push(orphanServer.server, orphan.root);
  assert.equal(orphanServer.parent, String(orphan.parent), "the child was not told its parent's pid");
  assert(alive(orphanServer.server) && alive(orphan.root));
  standInParent.kill("SIGKILL");
  assert(await waitUntil(() => !alive(orphan.parent), 10_000), "the stand-in parent outlived SIGKILL");
  // About a second for the child's watch to see it, then its cancel and exit.
  assert(
    await waitUntil(() => !alive(orphanServer.server) && !alive(orphan.root!), 20_000),
    "the child ling outlived the parent it was given",
  );
  await rm(orphanWorkersDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  console.log("PASS  a child ling exits on its own once the overlord that started it is killed");
  passed = true;
} finally {
  for (const lease of leases) {
    if (!lease.released) await lease.terminate("operator").catch(() => undefined);
  }
  // Never leave a sleeper behind if the assertions above failed partway. After
  // a pass each pid is confirmed gone, and may already be someone else's. A
  // summon that failed was never recorded above, but its wrapper reported.
  if (!passed) {
    for (const file of [reportPath, routedReportPath]) {
      const last = await readFile(file, "utf8").then(
        (text) => JSON.parse(text) as ChildReport,
        () => undefined,
      );
      if (last !== undefined) started.push(last.grandchild, last.server);
    }
    for (const pid of started) {
      if (alive(pid)) process.kill(pid);
    }
  }
  // The link first, so the removal below cannot reach the real install.
  await unlink(path.join(scratchLingDir, "node_modules")).catch(() => undefined);
  await rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
