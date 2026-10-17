/**
 * Verifies the per-task docker sandbox. Run this on the Linux VM with
 * SANDBOX_MODE=docker set. It proves four things: commands really execute
 * inside a container, the task workspace is shared both ways, paths outside the
 * workspace are not reachable from the container, and what the container writes
 * is owned by the service user rather than by root.
 */
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { createPiHarness } from "../harness/pi.js";
import { createSandbox } from "../sandbox.js";

interface ToolLike {
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<{ content: Array<{ type: string; text?: string }> }>;
}

let failures = 0;

function report(label: string, passed: boolean, detail = ""): void {
  console.log(`${passed ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!passed) failures += 1;
}

if (config.sandboxMode !== "docker") {
  console.error("SANDBOX_MODE is not \"docker\". Set it in .env and rerun this on the VM.");
  process.exit(1);
}

const workspaceDir = path.join(config.workspacesDir, "__sandbox_check__");
const hostOnlyFile = path.join(config.workspacesDir, "__sandbox_host_only.txt");

await rm(workspaceDir, { recursive: true, force: true });
await mkdir(workspaceDir, { recursive: true });
await writeFile(hostOnlyFile, "host-only-secret\n", "utf8");
await writeFile(path.join(workspaceDir, "shared.txt"), "shared-from-host\n", "utf8");

const sandbox = createSandbox({ config, taskId: "sandbox-check", workspaceDir });
const harness = await createPiHarness();
const bashTool = harness
  .createWorkspaceTools(workspaceDir, { spawnHook: sandbox.spawnHook })
  .find((tool) => tool.name === "bash");
if (bashTool === undefined) {
  console.error("The harness did not provide a bash tool; nothing to verify.");
  process.exit(1);
}
const bash = bashTool as unknown as ToolLike;

async function sh(command: string): Promise<string> {
  const result = await bash.execute("sandbox-check", { command }, undefined, undefined, undefined);
  return result.content.map((part) => part.text ?? "").join("\n");
}

await sandbox.start();

try {
  const containerHost = (await sh("hostname")).trim();
  report(
    "commands run inside a container, not on the host",
    containerHost !== "" && !containerHost.includes(hostname()),
    `container reported ${containerHost.split("\n").pop() ?? "nothing"}, host is ${hostname()}`,
  );

  const shared = await sh("cat shared.txt");
  report("the task workspace is visible inside the container", shared.includes("shared-from-host"));

  const escape = await sh(`cat ${JSON.stringify(hostOnlyFile)} 2>&1 || true`);
  report(
    "paths outside the workspace are not reachable",
    !escape.includes("host-only-secret"),
    escape.replace(/\s+/g, " ").slice(0, 90),
  );

  const producedPath = path.join(workspaceDir, "from-container.txt");
  await sh("echo written-inside-container > from-container.txt");
  const roundTrip = await readFile(producedPath, "utf8").catch(() => "");
  report(
    "files written in the container appear on the host",
    roundTrip.includes("written-inside-container"),
  );

  // A root container would leave root-owned files in the bind-mounted workspace,
  // which the host-side read, write and edit tools then cannot touch. These two
  // checks are what keep that from reaching the VM unnoticed.
  const hostUid = process.getuid?.() ?? -1;
  const containerUid = Number.parseInt((await sh("id -u")).trim().split("\n").pop() ?? "", 10);
  report(
    "the container runs as the service user, not root",
    containerUid === hostUid,
    `container uid ${containerUid}, host uid ${hostUid}`,
  );

  const produced = await stat(producedPath).catch(() => undefined);
  report(
    "files from the container are owned by the service user on the host",
    produced?.uid === hostUid,
    `file uid ${produced?.uid ?? "unknown"}, host uid ${hostUid}`,
  );
} finally {
  await sandbox.stop();
  await rm(workspaceDir, { recursive: true, force: true });
  await rm(hostOnlyFile, { force: true });
}

console.log(failures === 0 ? "\nsandbox verified" : `\n${failures} sandbox check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
