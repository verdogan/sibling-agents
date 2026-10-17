/**
 * What `experiment.json` records of the instrument a run used (protocol §1.8,
 * build plan §5.2 item 4): the commit and whether the experiment's sources
 * were clean, the Pi versions the children load, and the digest of ling's
 * agent settings. W4-A's preflight reads the same values, and refuses a batch
 * whose instrument differs from the registered one.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The paths whose state is the instrument's: a change in any of them is a dirty tree. */
export const INSTRUMENT_PATHS = [
  "ling/src",
  "overlord/src",
  "overlord/experiment",
  "ling/package-lock.json",
  "overlord/package-lock.json",
] as const;

async function git(repoRoot: string, args: readonly string[]): Promise<string> {
  const { stdout } = await run("git", [...args], { cwd: repoRoot, windowsHide: true });
  return stdout;
}

/** `git rev-parse HEAD`, and whether `git status` lists nothing under INSTRUMENT_PATHS. */
export async function gitProvenance(repoRoot: string): Promise<{ gitHead: string; clean: boolean }> {
  const gitHead = (await git(repoRoot, ["rev-parse", "HEAD"])).trim();
  const status = await git(repoRoot, ["status", "--porcelain", "--", ...INSTRUMENT_PATHS]);
  return { gitHead, clean: status.trim() === "" };
}

const PI_SCOPE = "@earendil-works";

async function versionAt(packageDir: string): Promise<string | null> {
  try {
    const text = await readFile(path.join(packageDir, "package.json"), "utf8");
    const value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as {
      version?: unknown;
    };
    return typeof value.version === "string" ? value.version : null;
  } catch {
    return null;
  }
}

async function scopeEntries(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * The installed `pi-coding-agent`, and every `pi-ai` copy: the hoisted one
 * and any nested under another Pi package. Sorted and de-duplicated.
 */
export async function piVersions(lingDir: string): Promise<{ codingAgent: string; ai: string[] }> {
  const scope = path.join(lingDir, "node_modules", PI_SCOPE);
  const codingAgent = (await versionAt(path.join(scope, "pi-coding-agent"))) ?? "absent";
  const ai = new Set<string>();
  const hoisted = await versionAt(path.join(scope, "pi-ai"));
  if (hoisted !== null) ai.add(hoisted);
  for (const name of await scopeEntries(scope)) {
    const nested = await versionAt(path.join(scope, name, "node_modules", PI_SCOPE, "pi-ai"));
    if (nested !== null) ai.add(nested);
  }
  return { codingAgent, ai: [...ai].sort() };
}

/** The sha256 of `ling/agent/settings.json`, or `"absent"`. */
export async function agentSettingsSha256(lingDir: string): Promise<string> {
  try {
    const bytes = await readFile(path.join(lingDir, "agent", "settings.json"));
    return createHash("sha256").update(bytes).digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
}

/** Everything `experiment.json`'s `instrument` holds but the run's own Pi agent directory. */
export async function instrumentRecord(
  repoRoot: string,
  lingDir: string,
): Promise<{
  gitHead: string;
  clean: boolean;
  pi: { codingAgent: string; ai: string[] };
  agentSettingsSha256: string;
}> {
  const [provenance, pi, settings] = await Promise.all([
    gitProvenance(repoRoot),
    piVersions(lingDir),
    agentSettingsSha256(lingDir),
  ]);
  return { ...provenance, pi, agentSettingsSha256: settings };
}
