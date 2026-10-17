/**
 * The score command (pilot build plan §5.1; protocol §1.7). It runs only once
 * a batch has ended (`batch_finished` or `batch_stopped`), and a PILOT-1
 * calibration batch (pilot family, `order: fixed`) only once a PILOT-2 batch
 * (pilot family, `model-b-first`) has ended. It writes `probes.json` and
 * `score.json` per run, and the batch's tables, attrition table, timelines and
 * blind-coding export. It returns file paths only: the caller prints nothing
 * else, so no outcome reaches the terminal.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeProbes } from "../probes.js";
import { codingExport, type CodingKey } from "../score/coding-export.js";
import { loadRunRecords, scoreRecords, type ScoreJson } from "../score/index.js";
import { attritionTable, crmTable, ledgerTable } from "../score/tables.js";
import { timeline } from "../score/timeline.js";
import type { RunRecords, ScoreContext } from "../score/types.js";
import { ledgerPath, readLedger, type LedgerLine } from "./ledger.js";
import { computeManifestSha256, validateManifest, type BatchManifest } from "./manifest.js";

export class ScoreRefusedError extends Error {}

function ended(lines: readonly LedgerLine[]): boolean {
  return lines.some((line) => line.event === "batch_finished" || line.event === "batch_stopped");
}

/** The sha256 the batch's `batch_started` recorded: what `run` ran. */
function startedSha(lines: readonly LedgerLine[]): string | undefined {
  const started = lines.find((line) => line.event === "batch_started");
  return started?.event === "batch_started" ? started.manifestSha256 : undefined;
}

/**
 * Whether a PILOT-2 batch has ended in `runsDir`: a `pilot-*` batch whose
 * manifest (`<runsDir>/<id>.json`, as plan writes it) is `model-b-first`, is
 * the one its ledger says ran, and whose ledger has ended. No catch: a
 * manifest or ledger that cannot be read stops the command rather than
 * reading as "not ended" or, worse, as "ended".
 */
function pilot2Ended(runsDir: string): boolean {
  for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("pilot-")) continue;
    const manifestFile = path.join(runsDir, `${entry.name}.json`);
    const ledgerFile = ledgerPath(runsDir, entry.name);
    if (!existsSync(manifestFile) || !existsSync(ledgerFile)) continue;
    const manifest = validateManifest(JSON.parse(readFileSync(manifestFile, "utf8")));
    if (manifest.id !== entry.name || manifest.family !== "pilot" || manifest.order !== "model-b-first") continue;
    const lines = readLedger(ledgerFile);
    if (startedSha(lines) === computeManifestSha256(manifest) && ended(lines)) return true;
  }
  return false;
}

export interface ScoreBatchOptions {
  /** The runs directory (`overlord/experiment/runs`). */
  runsDir: string;
  manifest: BatchManifest;
}

/** Score a batch that has ended; refuses otherwise. Returns the paths written. */
export async function scoreBatch({ runsDir, manifest }: ScoreBatchOptions): Promise<string[]> {
  const lines = readLedger(ledgerPath(runsDir, manifest.id));
  if (startedSha(lines) !== computeManifestSha256(manifest)) {
    throw new ScoreRefusedError(`batch ${manifest.id}: its ledger records no run of this manifest`);
  }
  if (!ended(lines)) {
    throw new ScoreRefusedError(`batch ${manifest.id} has not ended (no batch_finished or batch_stopped)`);
  }
  if (manifest.family === "pilot" && manifest.order === "fixed" && !pilot2Ended(runsDir)) {
    throw new ScoreRefusedError(`batch ${manifest.id} is PILOT-1 calibration: it is scored only once PILOT-2 has ended`);
  }

  const context: ScoreContext = {
    family: manifest.family,
    models: manifest.models,
    promptDigests: manifest.promptDigests,
  };
  const batchDir = path.join(runsDir, manifest.id);
  const written: string[] = [];
  const scored: { records: RunRecords; score: ScoreJson; runDir: string }[] = [];
  // The manifest's runs, in its order; a run that never started has no directory.
  for (const run of manifest.runs) {
    const runDir = path.join(batchDir, run.runId);
    if (!existsSync(path.join(runDir, "experiment.json"))) continue;
    await writeProbes(runDir);
    written.push(path.join(runDir, "probes.json"));
    const records = await loadRunRecords(runDir);
    const score = scoreRecords(records, context);
    await writeFile(path.join(runDir, "score.json"), `${JSON.stringify(score, null, 2)}\n`, "utf8");
    written.push(path.join(runDir, "score.json"));
    await writeFile(path.join(runDir, "timeline.txt"), timeline(records, score), "utf8");
    written.push(path.join(runDir, "timeline.txt"));
    scored.push({ records, score, runDir });
  }

  const scoreDir = path.join(batchDir, "score");
  await mkdir(scoreDir, { recursive: true });
  const scores = scored.map((entry) => entry.score);
  const tables: [string, string][] = [["attrition.txt", attritionTable(scores, manifest.family)]];
  if (scores.some((score) => score.ledger !== null)) {
    tables.push(["table-ledger.txt", ledgerTable(scores.filter((score) => score.ledger !== null), manifest.family)]);
  }
  if (scores.some((score) => score.crm !== null)) {
    tables.push(["table-crm.txt", crmTable(scores.filter((score) => score.crm !== null), manifest.family)]);
  }
  for (const [name, text] of tables) {
    await writeFile(path.join(scoreDir, name), text, "utf8");
    written.push(path.join(scoreDir, name));
  }

  // The coders get the export; the key, which maps ids back to runs, is a file apart. A key
  // already written is reused, so scoring again rebuilds the same export a coder may be holding.
  const keyFile = path.join(scoreDir, "coding-key.json");
  const kept = existsSync(keyFile) ? (JSON.parse(readFileSync(keyFile, "utf8")) as CodingKey) : undefined;
  const runs = scored.map((entry) => entry.records);
  const { exported, key } =
    kept === undefined ? codingExport(runs, manifest.id) : codingExport(runs, kept.seed, kept.salt);
  await writeFile(path.join(scoreDir, "coding-export.json"), `${JSON.stringify(exported, null, 2)}\n`, "utf8");
  await writeFile(keyFile, `${JSON.stringify(key, null, 2)}\n`, "utf8");
  written.push(path.join(scoreDir, "coding-export.json"), keyFile);
  return written;
}
