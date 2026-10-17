#!/usr/bin/env node
/**
 * Pair measurement live CLI (§5): plan, register, status, run. Only run can spend.
 *
 * Every path is resolved from the repository root, so the command reads the same files whether npm
 * runs it from overlord/ or it is run from the root. The batch registry lives in the runs directory
 * (gitignored): registering a batch after planning it must not change the tree the manifest records.
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { planBatch, printPlanSummary } from "../experiment/batch/plan.js";
import { validateManifest, computeManifestSha256 } from "../experiment/batch/manifest.js";
import { statusBatch, printStatus } from "../experiment/batch/status.js";
import { scoreBatch, ScoreRefusedError } from "../experiment/batch/score.js";
import { familySpend, ledgerPath } from "../experiment/batch/ledger.js";
import { preflight, DEFAULT_DEPS, LING_ENV_PATH, REPO_ROOT } from "../experiment/batch/preflight.js";
import { runBatch } from "../experiment/batch/run.js";
import { endpointMaxTokens, PILOT_PIN_SPECS, resolvePins, type PinSpec } from "../experiment/batch/pins.js";
import { promptDigestKey, type ArmId } from "../experiment/records.js";

const RUNS_DIR = `${REPO_ROOT}/overlord/experiment/runs`;
const REGISTRY_PATH = `${RUNS_DIR}/registry.json`;
const PROTOCOL_REPO_PATH = "reports/experiment-protocol.md";
const PI_PACKAGE = `${REPO_ROOT}/ling/node_modules/@earendil-works/pi-coding-agent/package.json`;

function usage(): never {
  console.error(`Usage:
  pair-measurement-live plan --batch pilot-1|pilot-2 --digests <file> [--seed <hex>] [--id <batch-id>] --out <file>
  pair-measurement-live register <manifest>
  pair-measurement-live status <manifest>
  pair-measurement-live run <manifest> --approve <batch-id>
  pair-measurement-live score <manifest>`);
  process.exit(1);
}

function readManifest(file: string) {
  return validateManifest(JSON.parse(readFileSync(file, "utf8")));
}

function git(command: string): string {
  return execSync(`git ${command}`, { encoding: "utf8", cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** The protocol is pre-registered only if it is tracked and identical to HEAD's copy. */
function protocolCommitted(): boolean {
  try {
    git(`ls-files --error-unmatch -- ${PROTOCOL_REPO_PATH}`);
    git(`diff --quiet HEAD -- ${PROTOCOL_REPO_PATH}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * The key the runs' children use is in ling/.env; the generation lookups need the same key in this
 * process. It is read, never printed.
 */
function loadOpenRouterKey(): void {
  if ((process.env["OPENROUTER_API_KEY"] ?? "").trim() !== "") return;
  if (!existsSync(LING_ENV_PATH)) return;
  const match = /^\s*OPENROUTER_API_KEY\s*=\s*"?([^"\r\n]*)"?\s*$/m.exec(readFileSync(LING_ENV_PATH, "utf8"));
  const key = match?.[1]?.trim();
  if (key) process.env["OPENROUTER_API_KEY"] = key;
}

/** Each pin's output ceiling, from the public list of the one endpoint its routing allows (no key, no cost). */
async function withEndpointCeilings(specs: { a: PinSpec; b: PinSpec }): Promise<{ a: PinSpec; b: PinSpec }> {
  const ceiling = async (spec: PinSpec): Promise<PinSpec> => {
    const limit = await endpointMaxTokens(spec.model, spec.slug);
    return limit === undefined ? spec : { ...spec, maxTokens: limit };
  };
  return { a: await ceiling(specs.a), b: await ceiling(specs.b) };
}

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 && at + 1 < args.length ? args[at + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  if (command === undefined) usage();

  if (command === "plan") {
    const batch = option(args, "--batch");
    const digestsFile = option(args, "--digests");
    const seed = option(args, "--seed");
    const outFile = option(args, "--out");
    // A retry is a new batch: its cells are the named batch's, under an id of its own.
    const id = option(args, "--id");
    if (batch !== "pilot-1" && batch !== "pilot-2") {
      console.error("plan requires --batch pilot-1 or pilot-2");
      process.exit(1);
    }
    if (!digestsFile || !outFile) {
      console.error("plan requires --digests and --out");
      process.exit(1);
    }
    // The digests file is what experiment-e2e-check --digests-out writes after a passing dry-runs phase:
    // {gitHead, clean, digests}. Its digests are the registered ones only if it came from this very
    // commit with a clean tree.
    const written = JSON.parse(readFileSync(digestsFile, "utf8")) as {
      gitHead?: string;
      clean?: boolean;
      digests?: Record<string, string>;
    };
    const head = git("rev-parse HEAD");
    if (written.digests === undefined || written.gitHead !== head || written.clean !== true) {
      console.error(
        `the digests file must come from experiment-e2e-check --digests-out at HEAD ${head} with a clean tree ` +
          `(it records ${written.gitHead ?? "no commit"}, clean ${String(written.clean)})`,
      );
      process.exit(1);
    }
    const digests = written.digests;
    const piVersion = (JSON.parse(readFileSync(PI_PACKAGE, "utf8")) as { version: string }).version;
    const protocolPath = process.env["EXPERIMENT_PROTOCOL_FILE"] || `${REPO_ROOT}/${PROTOCOL_REPO_PATH}`;
    const protocolSha256 = createHash("sha256").update(readFileSync(protocolPath)).digest("hex");
    const manifest = planBatch({
      batch,
      digests,
      ...(seed === undefined ? {} : { seed }),
      piVersion,
      gitHead: head,
      protocolPath,
      protocolSha256,
      protocolCommitted: protocolCommitted(),
      models: await resolvePins(`${REPO_ROOT}/ling`, await withEndpointCeilings(PILOT_PIN_SPECS)),
      familySpentUsd: familySpend(RUNS_DIR, "pilot"),
      ...(id === undefined ? {} : { id }),
    });
    // Every run must find its registered digest, as the preflight and the scorer will look it up.
    validateManifest(JSON.parse(JSON.stringify(manifest)));
    for (const run of manifest.runs) {
      const key = promptDigestKey(run.arm as ArmId, run.prompted);
      if (!/^[0-9a-f]{64}$/.test(manifest.promptDigests[key] ?? "")) {
        console.error(`the digests file has no digest for ${key}`);
        process.exit(1);
      }
    }
    writeFileSync(outFile, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    printPlanSummary(manifest);
  } else if (command === "register") {
    const file = args[1];
    if (!file) usage();
    const manifest = readManifest(file);
    const sha = computeManifestSha256(manifest);
    mkdirSync(RUNS_DIR, { recursive: true });
    const registry = existsSync(REGISTRY_PATH)
      ? (JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as Record<string, string>)
      : {};
    const existing = registry[manifest.id];
    if (existing !== undefined && existing !== sha) {
      console.error(`${manifest.id} is already registered with another manifest (${existing}); a batch is registered once`);
      process.exit(1);
    }
    registry[manifest.id] = sha;
    writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + "\n", "utf8");
    console.log(`Registered ${manifest.id}: ${sha}`);
  } else if (command === "status") {
    const file = args[1];
    if (!file) usage();
    const manifest = readManifest(file);
    printStatus(statusBatch(manifest, ledgerPath(RUNS_DIR, manifest.id)));
  } else if (command === "run") {
    const file = args[1];
    if (!file) usage();
    const manifest = readManifest(file);
    const approve = option(args, "--approve");
    if (approve !== manifest.id) {
      console.error(`run requires --approve ${manifest.id}; nothing was run`);
      process.exit(1);
    }
    loadOpenRouterKey();
    const manifestSha256 = computeManifestSha256(manifest);
    const protocolFile = process.env["EXPERIMENT_PROTOCOL_FILE"] || `${REPO_ROOT}/${PROTOCOL_REPO_PATH}`;
    const checked = preflight(manifest, manifestSha256, REGISTRY_PATH, RUNS_DIR, protocolFile, DEFAULT_DEPS);
    if (!checked.ok) {
      console.error(`Preflight failed: ${checked.reason}${checked.details ? `\n  ${checked.details}` : ""}`);
      process.exit(1);
    }
    await runBatch(manifest, manifestSha256, { approve, runsDir: RUNS_DIR, registryPath: REGISTRY_PATH, protocolFile });
  } else if (command === "score") {
    const file = args[1];
    if (!file) usage();
    const manifest = readManifest(file);
    let written: string[];
    try {
      written = await scoreBatch({ runsDir: RUNS_DIR, manifest });
    } catch (error) {
      if (!(error instanceof ScoreRefusedError)) throw error;
      console.error(`score refused: ${error.message}`);
      process.exit(1);
    }
    // File paths only: no score field, class or count reaches the terminal (§1.7).
    for (const filePath of written) console.log(filePath);
  } else {
    usage();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
