/**
 * Probes: $0 runtime checks on the final workspace files (protocol §1.4, plan
 * §2.5). Each probe rebuilds its own scratch workspace from the final-state
 * record and runs A's JavaScript there as a child process (P1 `node --test`,
 * P2 and P3 the ledger's settle calls), in a stripped environment, with a 20 s
 * timeout that kills the child's whole tree. A probe whose input has no
 * content is `unavailable`. `writeProbes` loads a run's record and writes
 * `probes.json`.
 */
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  parseExperimentJson,
  parseFinalStateRecord,
  type FinalStateRecord,
  type ProbeOutcome,
  type ProbesJson,
  type ScenarioId,
} from "./records.js";

export const PROBE_TIMEOUT_MS = 20_000;
/** What a probe keeps of a child's output: A's code may print without end. */
const OUTPUT_CAP_CHARS = 64 * 1024;

/**
 * The directories whose every file is a probe's input, beside `package.json`
 * (plan §2.5). P2 and P3 name `src/settle.js` and `config/settings.json`; all
 * of `src/` counts, since what settle.js imports is input too.
 */
const P1_DIRS = ["src", "test", "config"] as const;
const SETTLE_DIRS = ["src", "config"] as const;

function inScope(filePath: string, dirs: readonly string[]): boolean {
  return filePath === "package.json" || dirs.some((dir) => filePath.startsWith(`${dir}/`));
}

const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * A path A chose may be written into the scratch only if it is plain and
 * relative: `/`-separated segments, none empty, `.` or `..`, none ending in a
 * dot or a space (Windows drops them), no backslash, no colon (a drive letter
 * or an NTFS stream), no control character, no Windows device name.
 */
export function trustedPath(filePath: string): boolean {
  if (filePath === "" || filePath.startsWith("/") || /[\\:\u0000-\u001f]/.test(filePath)) return false;
  return filePath
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== ".." && !/[. ]$/.test(segment) && !WINDOWS_DEVICE.test(segment));
}

/**
 * Why a probe reading `package.json` and `dirs` cannot run on what the record
 * kept, or null (protocol §1.4: a probe whose input has no content is
 * `unavailable`, never false). An input has no content when it is a seed that
 * is still there but was not read (`not_regular`, `unreadable`, or content
 * omitted), a file whose content was omitted, a link (never followed), or
 * when a directory on the way could not be listed, or entries were left out.
 */
export function unavailableReason(finalState: FinalStateRecord, dirs: readonly string[]): string | null {
  if (finalState.filesOmitted > 0) return `${finalState.filesOmitted} workspace entries were not listed`;
  for (const seed of finalState.seeds) {
    if (!inScope(seed.path, dirs) || seed.state === "absent") continue;
    if (seed.content === null) return `${seed.path} has no content (${seed.state}, ${seed.contentOmitted})`;
  }
  for (const file of finalState.files) {
    if (file.type === "directory") {
      if (file.path === "." || dirs.includes(file.path) || inScope(file.path, dirs)) {
        return `${file.path} could not be listed`;
      }
      continue;
    }
    if (!inScope(file.path, dirs)) continue;
    if (!trustedPath(file.path)) return `${JSON.stringify(file.path)} is not a path the probe writes`;
    // A link's content is never read, so it is null here too (contentOmitted "symlink").
    if (file.content === null) return `${file.path} has no content (${file.contentOmitted})`;
  }
  return null;
}

/**
 * Rebuild a scratch workspace from the final-state record: every seed still
 * there and every regular file, with its content. A path that is not trusted
 * is never written; one inside a probe's inputs has made it unavailable
 * already. No link is ever created. The caller removes the scratch.
 */
async function rebuildWorkspace(finalState: FinalStateRecord, scratchRoot?: string): Promise<string> {
  const scratchDir = path.join(scratchRoot ?? os.tmpdir(), `ling-probe-${randomBytes(4).toString("hex")}`);
  await mkdir(scratchDir, { recursive: true });
  const entries = [
    ...finalState.seeds.filter((seed) => seed.state !== "absent"),
    ...finalState.files.filter((file) => file.type === "file"),
  ];
  try {
    for (const entry of entries) {
      if (entry.content === null || !trustedPath(entry.path)) continue;
      const target = path.join(scratchDir, ...entry.path.split("/"));
      // Belt and braces: the joined path must stay inside the scratch.
      if (path.relative(scratchDir, target).startsWith("..")) continue;
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, entry.content, "utf8");
    }
  } catch (error) {
    await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return scratchDir;
}

/**
 * Stripped environment (F20): only PATH, SystemRoot, windir, ComSpec and
 * PATHEXT, plus HOME, TEMP, TMP and TMPDIR inside the scratch. Nothing else
 * crosses.
 */
function strippedEnvironment(scratch: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // Keep only these Windows system variables
  for (const key of ["PATH", "SystemRoot", "windir", "ComSpec", "PATHEXT"]) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  // Set HOME, TEMP, TMP, TMPDIR inside scratch
  env["HOME"] = scratch;
  env["TEMP"] = scratch;
  env["TMP"] = scratch;
  env["TMPDIR"] = scratch;
  return env;
}

/** Every live pid's parent, from `ps`; empty if `ps` cannot be run. */
async function parentTable(): Promise<Map<number, number>> {
  return new Promise((resolve) => {
    execFile("ps", ["-A", "-o", "pid=", "-o", "ppid="], (error, stdout) => {
      const parents = new Map<number, number>();
      if (!error) {
        for (const line of stdout.split("\n")) {
          const [pid, ppid] = line.trim().split(/\s+/).map(Number);
          if (Number.isInteger(pid) && Number.isInteger(ppid)) parents.set(pid!, ppid!);
        }
      }
      resolve(parents);
    });
  });
}

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch {
    // Already gone.
  }
}

/**
 * Kill a probe's whole process tree: `taskkill /pid <pid> /T /F` on Windows,
 * where a detached grandchild leaves the job object that would otherwise end
 * it. Elsewhere the child leads its own process group, but a detached
 * grandchild starts a new one, so the group alone does not reach it. The tree
 * is walked by parent pid instead, stopping each process as it is found so
 * that none can fork past the walk, until a walk finds nothing new; then the
 * group and every process found are killed.
 */
async function killTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    return new Promise<void>((resolve) => {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }).on("close", () => resolve());
    });
  }
  signal(-pid, "SIGSTOP");
  const tree = new Set([pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [child, parent] of await parentTable()) {
      if (tree.has(parent) && !tree.has(child)) {
        tree.add(child);
        signal(child, "SIGSTOP");
        grew = true;
      }
    }
  }
  signal(-pid, "SIGKILL");
  for (const member of tree) signal(member, "SIGKILL");
}

/**
 * Run a child process with a timeout and tree kill. Returns { stdout, stderr,
 * exitCode } on success, or throws on timeout or spawn error.
 */
async function runWithTimeout(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      // Off Windows, its own process group, so that killTree reaches every descendant.
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(async () => {
      timedOut = true;
      await killTree(child.pid!);
      reject(new Error(`Timeout after ${options.timeout} ms`));
    }, options.timeout);
    child.stdout?.on("data", (chunk) => {
      if (stdout.length < OUTPUT_CAP_CHARS) stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < OUTPUT_CAP_CHARS) stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (!timedOut) reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!timedOut) {
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      }
    });
  });
}

/**
 * P1: `node --test` on the final files. Returns `ran` with value `exit code ===
 * 0`, or `threw` on timeout or spawn error.
 */
async function runP1(scratch: string, env: NodeJS.ProcessEnv, timeout: number): Promise<ProbeOutcome<boolean>> {
  try {
    const result = await runWithTimeout(process.execPath, ["--test"], { cwd: scratch, env, timeout });
    return { status: "ran", value: result.exitCode === 0 };
  } catch (error) {
    return { status: "threw", error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * P2 or P3: `node --input-type=module -e` importing `./src/settle.js` and
 * printing `JSON.stringify(settle(...))`. Returns `ran` with the parsed array,
 * or `threw` on a non-zero exit, timeout or unparsable output.
 */
async function runSettle(
  scratch: string,
  env: NodeJS.ProcessEnv,
  timeout: number,
  totalCents: number,
  weights: number[],
): Promise<ProbeOutcome<number[]>> {
  const code = `import { settle } from './src/settle.js'; console.log(JSON.stringify(settle(${totalCents}, ${JSON.stringify(weights)})));`;
  try {
    const result = await runWithTimeout(process.execPath, ["--input-type=module", "-e", code], { cwd: scratch, env, timeout });
    if (result.exitCode !== 0) {
      return { status: "threw", error: `Exit code ${result.exitCode}` };
    }
    try {
      const parsed = JSON.parse(result.stdout.trim()) as unknown;
      if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "number")) {
        return { status: "threw", error: "Output is not a number array" };
      }
      return { status: "ran", value: parsed };
    } catch {
      return { status: "threw", error: "Output is not valid JSON" };
    }
  } catch (error) {
    return { status: "threw", error: error instanceof Error ? error.message : String(error) };
  }
}

export interface ProbeOptions {
  scratchRoot?: string;
  /** Tests only: the protocol's limit is PROBE_TIMEOUT_MS. */
  timeoutMs?: number;
}

/**
 * Run all probes on a final-state record. Each probe gets its own scratch
 * workspace, rebuilt from the record, so what one probe's code writes cannot
 * reach the next; every scratch is removed afterwards.
 */
export async function runProbes(
  finalState: FinalStateRecord,
  scenario: ScenarioId,
  options: ProbeOptions = {},
): Promise<ProbesJson> {
  const timeout = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const inScratch = async <T>(probe: (scratch: string, env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> => {
    const scratch = await rebuildWorkspace(finalState, options.scratchRoot);
    try {
      return await probe(scratch, strippedEnvironment(scratch));
    } finally {
      await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
    }
  };

  const p1Missing = unavailableReason(finalState, P1_DIRS);
  const testsPass: ProbeOutcome<boolean> =
    p1Missing !== null
      ? { status: "unavailable", reason: p1Missing }
      : await inScratch((scratch, env) => runP1(scratch, env, timeout));
  if (scenario !== "ledger") return { version: 1, testsPass };

  // P2 and P3 are the ledger's.
  const settleMissing = unavailableReason(finalState, SETTLE_DIRS);
  if (settleMissing !== null) {
    const unavailable = { status: "unavailable" as const, reason: settleMissing };
    return { version: 1, testsPass, settleEven: unavailable, settleZeroWeight: unavailable };
  }
  const settleEven = await inScratch((scratch, env) => runSettle(scratch, env, timeout, 1000, [1, 1, 1]));
  const settleZeroWeight = await inScratch((scratch, env) => runSettle(scratch, env, timeout, 1001, [1, 0, 1, 1]));
  return { version: 1, testsPass, settleEven, settleZeroWeight };
}

/**
 * Read the final-state record and experiment.json from a run directory, run the
 * probes, and write `probes.json`.
 */
export async function writeProbes(runDir: string): Promise<ProbesJson> {
  const experimentValue = JSON.parse(await readFile(path.join(runDir, "experiment.json"), "utf8")) as unknown;
  const experiment = parseExperimentJson(experimentValue);
  let finalStateText: string | undefined;
  try {
    finalStateText = await readFile(path.join(runDir, "final-state.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // A run with no record (excluded as instrument_missing) is still scored; its probes have no input.
  const probes: ProbesJson =
    finalStateText === undefined
      ? { version: 1, testsPass: { status: "unavailable", reason: "the run has no final-state record" } }
      : await runProbes(parseFinalStateRecord(JSON.parse(finalStateText) as unknown), experiment.scenario);
  await writeFile(path.join(runDir, "probes.json"), JSON.stringify(probes, null, 2) + "\n", "utf8");
  return probes;
}
