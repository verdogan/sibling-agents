/**
 * Preflight checks (§5.3): every check before the batch runs, with injectable
 * dependencies for testing. Returns a refusal or ok. Each refusal exits non-zero
 * and summons nothing.
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promptDigestKey, type ArmId } from "../records.js";
import type { BatchManifest } from "./manifest.js";
import { familySpend } from "./ledger.js";

/**
 * The repository root, from this file's place (overlord/src/experiment/batch), with forward slashes.
 * Every path the preflight reads is absolute: run from overlord/ (as npm does), a relative
 * `ling/.env` or `git status ling/src` would name nothing, and a check would pass without looking.
 */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..").replace(/\\/g, "/");
export const LING_ENV_PATH = `${REPO_ROOT}/ling/.env`;
const PI_PACKAGE = `${REPO_ROOT}/ling/node_modules/@earendil-works/pi-coding-agent/package.json`;

export interface PreflightDeps {
  /** Git probe: returns { head: string; clean: boolean } or throws */
  git: () => { head: string; clean: boolean };
  /** Environment reader: returns the value of a key or undefined */
  env: (key: string) => string | undefined;
  /** Node version check */
  nodeVersion: () => string;
  /** Read a file for sha256 */
  readFile: (path: string) => Buffer;
  /** Check if file exists */
  fileExists: (path: string) => boolean;
  /** Pi version from package.json */
  piVersion: () => string;
  /** Family spend from ledgers */
  familySpend: (runsDir: string, family: "pilot" | "counted") => number;
}

export const DEFAULT_DEPS: PreflightDeps = {
  git: () => {
    const head = execSync("git rev-parse HEAD", { encoding: "utf8", cwd: REPO_ROOT }).trim();
    const status = execSync(
      "git status --porcelain -- ling/src overlord/src overlord/experiment ling/package-lock.json overlord/package-lock.json",
      { encoding: "utf8", cwd: REPO_ROOT },
    );
    return { head, clean: status.trim().length === 0 };
  },
  env: (key) => process.env[key],
  nodeVersion: () => process.versions.node,
  readFile: (file) => readFileSync(file),
  fileExists: (file) => existsSync(file),
  piVersion: () => {
    const pkg = JSON.parse(readFileSync(PI_PACKAGE, "utf8")) as { version: string };
    return pkg.version;
  },
  familySpend: (runsDir, family) => familySpend(runsDir, family),
};

export type PreflightResult =
  | { ok: true }
  | { ok: false; reason: string; details?: string };

const FORBIDDEN_ENV_KEYS = [
  "OVERLORD_BRAIN_MODEL",
  "LING_SCRIPTED_MODEL",
  "LING_ALLOW_SCRIPTED_MODEL",
  "LING_SCRIPTED_MODEL_TRACE",
  "OVERSIGHT_ADVICE_WAIT_MS",
  "OVERSIGHT_WATCH_IDLE_MS",
  "LING_MODEL_ROUTING",
  "LING_MODEL_MAX_TOKENS",
  "PI_CODING_AGENT_DIR",
  "TAU_CODING_AGENT_DIR",
];

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function preflight(
  manifest: BatchManifest,
  manifestSha256: string,
  registryPath: string,
  runsDir: string,
  protocolFile: string,
  deps: PreflightDeps,
): PreflightResult {
  // 1. Registry check
  if (!deps.fileExists(registryPath)) {
    return { ok: false, reason: "registry file not found" };
  }
  const registryText = deps.readFile(registryPath).toString("utf8");
  let registry: Record<string, string>;
  try {
    registry = JSON.parse(registryText);
  } catch {
    return { ok: false, reason: "registry is not valid JSON" };
  }
  if (registry[manifest.id] !== manifestSha256) {
    return {
      ok: false,
      reason: "manifest sha256 does not match registry",
      details: `expected ${manifestSha256}, got ${registry[manifest.id] ?? "missing"}`,
    };
  }

  // 2. Git check
  let gitState: { head: string; clean: boolean };
  try {
    gitState = deps.git();
  } catch (err) {
    return { ok: false, reason: "git check failed", details: String(err) };
  }
  if (!gitState.clean) {
    return { ok: false, reason: "tracked files under ling/src or overlord/src are not clean" };
  }
  if (gitState.head !== manifest.gitHead) {
    return {
      ok: false,
      reason: "git HEAD does not match manifest",
      details: `HEAD is ${gitState.head}, manifest expects ${manifest.gitHead}`,
    };
  }

  // 3. Protocol check (committed at HEAD, file exists and sha256 matches)
  if (!deps.fileExists(protocolFile)) {
    return { ok: false, reason: "protocol file not found", details: protocolFile };
  }
  if (!deps.fileExists(manifest.protocolPath)) {
    return {
      ok: false,
      reason: "protocol file path from manifest not found",
      details: manifest.protocolPath,
    };
  }
  const protocolBytes = deps.readFile(manifest.protocolPath);
  const protocolSha = sha256(protocolBytes);
  if (protocolSha !== manifest.protocolSha256) {
    return {
      ok: false,
      reason: "protocol sha256 does not match manifest",
      details: `computed ${protocolSha}, manifest expects ${manifest.protocolSha256}`,
    };
  }

  // 4. Environment check
  for (const key of FORBIDDEN_ENV_KEYS) {
    const value = deps.env(key);
    if (value !== undefined && value.trim().length > 0) {
      return { ok: false, reason: `environment variable ${key} is set`, details: key };
    }
  }
  // Check for OPENROUTER key
  const openRouterKey = deps.env("OPENROUTER_API_KEY");
  if (!openRouterKey || openRouterKey.trim().length === 0) {
    return { ok: false, reason: "OPENROUTER_API_KEY is not set" };
  }

  // Check ling/.env for forbidden keys (an absolute path: a relative one would miss the file when the
  // command runs from overlord/, and the check would pass without reading anything).
  if (deps.fileExists(LING_ENV_PATH)) {
    const lingEnv = deps.readFile(LING_ENV_PATH).toString("utf8");
    for (const key of FORBIDDEN_ENV_KEYS) {
      // Simple check: key= at start of line
      const pattern = new RegExp(`^${key}=.`, "m");
      if (pattern.test(lingEnv)) {
        return { ok: false, reason: `ling/.env sets ${key}`, details: key };
      }
    }
  }

  // 5. Pi version check
  const installedPi = deps.piVersion();
  if (installedPi !== manifest.piVersion) {
    return {
      ok: false,
      reason: "installed pi-coding-agent version does not match manifest",
      details: `installed ${installedPi}, manifest expects ${manifest.piVersion}`,
    };
  }

  // 6. Prompt digests check, by the key the scorer reads (arm and prompted flag).
  for (const run of manifest.runs) {
    const key = promptDigestKey(run.arm as ArmId, run.prompted);
    if (!manifest.promptDigests[key]) {
      return {
        ok: false,
        reason: `missing prompt digest for arm ${run.arm}`,
        details: key,
      };
    }
  }

  // 7. Node version check
  const nodeVer = deps.nodeVersion();
  const parts = nodeVer.split(".");
  const majorStr = parts[0];
  if (!majorStr) {
    return { ok: false, reason: "Invalid Node version format", details: nodeVer };
  }
  const major = parseInt(majorStr, 10);
  if (major < 24) {
    return {
      ok: false,
      reason: "Node version must be >= 24",
      details: `current version is ${nodeVer}`,
    };
  }

  // 8. Budget (§5.2 item 8): what the family has spent so far, this batch's earlier runs included, is
  //    below both ceilings. Each run's cap is checked against what remains when the run is reached
  //    (run.ts), so a batch whose caps add up past its ceiling (PILOT-2) still starts, and stops where
  //    its money ends.
  const runsDirectory = runsDir || ".";
  const familySpentSoFar = deps.familySpend(runsDirectory, manifest.family);
  if (manifest.ceilingUsd > manifest.familyCeilingUsd) {
    return {
      ok: false,
      reason: "the batch ceiling is above the family ceiling",
      details: `batch $${manifest.ceilingUsd.toFixed(2)}, family $${manifest.familyCeilingUsd.toFixed(2)}`,
    };
  }
  if (familySpentSoFar >= manifest.familyCeilingUsd) {
    return {
      ok: false,
      reason: "the family has spent its ceiling",
      details: `family spent $${familySpentSoFar.toFixed(2)}, ceiling $${manifest.familyCeilingUsd.toFixed(2)}`,
    };
  }

  return { ok: true };
}
