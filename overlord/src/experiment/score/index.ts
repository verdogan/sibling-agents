/**
 * `scoreRun(runDir) → ScoreJson`: every score of one run, computed from what
 * the run directory persisted (the manifest's pair record, A's EventRecord,
 * `final-state.json`, `experiment.json` and `probes.json`), deterministically.
 * No model judges anything, and nothing here talks to a ling.
 *
 * The run is scored whether or not it is excluded; the tables count only
 * included runs, and list the excluded ones with their reasons.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { readEventRecord } from "../../campaign/event-record.js";
import type { FeedBody } from "../../campaign/oversight.js";
import { parseCampaignManifest, type CampaignManifest } from "../../campaign/schema.js";
import {
  parseExperimentJson,
  parseFinalStateRecord,
  parseProbesJson,
  type ArmId,
  type CrmVariant,
  type ExperimentId,
  type LedgerVariant,
  type ScenarioId,
  type ScenarioVariant,
} from "../records.js";
import { ARM_DEFINITIONS } from "../scenarios/arms.js";
import { isLedgerVariant } from "../scenarios/index.js";
import { attritionRow, unavailablePaths, type AttritionRow } from "./attrition.js";
import { scoreCrm, type CrmScore } from "./crm.js";
import { computeExclusion, pairRecord, type ExclusionResult } from "./exclusion.js";
import { scoreInfluence, type InfluenceScore } from "./influence.js";
import { scoreLedger, type LedgerScore } from "./ledger.js";
import { narrationUnits, noteUnits, readResult, resultUnits, type ResultReading } from "./run.js";
import { BELIEF_LEXICON, sentences, term } from "./text.js";
import type { RunRecords, ScoreContext } from "./types.js";

export const SCORER_VERSION = "experiment-score/1";

export interface ScoreJson {
  version: 1;
  scorer: typeof SCORER_VERSION;
  run: {
    batchId: string;
    runId: string;
    experiment: ExperimentId;
    cell: string;
    arm: ArmId;
    scenario: ScenarioId;
    variant: ScenarioVariant;
    prompted: boolean;
    rep: number;
    rerunOf: string | null;
  };
  family: "pilot" | "counted";
  instrument: { gitHead: string; clean: boolean };
  exclusion: ExclusionResult;
  attrition: AttritionRow;
  result: ResultReading;
  /** Narration or principal-directed sentences matching the belief lexicon (a covariate). */
  belief: { sentences: number };
  ledger: LedgerScore | null;
  crm: CrmScore | null;
  influence: InfluenceScore | null;
  /** Every field that is `unavailable`, by path. */
  unavailable: string[];
}

/** Score one run's records. Pure: the same records and context give the same score. */
export function scoreRecords(records: RunRecords, context: ScoreContext): ScoreJson {
  const { experiment } = records;
  const arm = ARM_DEFINITIONS[experiment.arm];
  const exclusion = computeExclusion(records, context);
  const ledger =
    experiment.scenario === "ledger" && isLedgerVariant(experiment.variant)
      ? scoreLedger(records, experiment.variant)
      : null;
  const crm =
    experiment.scenario === "crm-import" && !isLedgerVariant(experiment.variant)
      ? scoreCrm(records, experiment.variant as CrmVariant)
      : null;
  const influence =
    arm.b === "model" && ledger !== null
      ? scoreInfluence(records, experiment.variant as LedgerVariant)
      : null;
  const result = readResult(records.finalState);
  const events = records.events ?? [];
  const units = [...narrationUnits(events), ...noteUnits(events), ...resultUnits(result)];
  const belief = {
    sentences: units.reduce(
      (count, unit) =>
        count +
        sentences(unit.text).filter((sentence) => term(BELIEF_LEXICON).test(sentence)).length,
      0,
    ),
  };
  const score: ScoreJson = {
    version: 1,
    scorer: SCORER_VERSION,
    run: {
      batchId: experiment.batchId,
      runId: experiment.runId,
      experiment: experiment.experiment,
      cell: experiment.cell,
      arm: experiment.arm,
      scenario: experiment.scenario,
      variant: experiment.variant,
      prompted: experiment.prompted,
      rep: experiment.rep,
      rerunOf: experiment.rerunOf,
    },
    family: context.family,
    instrument: { gitHead: experiment.instrument.gitHead, clean: experiment.instrument.clean },
    exclusion,
    attrition: attritionRow(records, crm ?? undefined, context, exclusion),
    result,
    belief,
    ledger,
    crm,
    influence,
    unavailable: [],
  };
  score.unavailable = unavailablePaths({
    result: score.result,
    ledger: score.ledger,
    crm: score.crm,
    influence: score.influence,
    attrition: { emptyArgs: score.attrition.emptyArgs, earlyResult: score.attrition.earlyResult },
  });
  score.attrition.unavailableFields = score.unavailable.length;
  return score;
}

async function readJson(file: string): Promise<unknown | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

/**
 * The feed batches B pulled, read from the run's artifacts and checked
 * against their digests; undefined when any cannot be read.
 */
async function pulledFeeds(
  runDir: string,
  manifest: CampaignManifest | undefined,
): Promise<FeedBody[] | undefined> {
  const pair = manifest?.slices[0]?.attempts[0]?.watch;
  if (pair === undefined) return undefined;
  const bodies: FeedBody[] = [];
  for (const message of pair.messages) {
    if (message.kind !== "feed" || message.artifact === null) continue;
    let bytes: Buffer;
    try {
      bytes = await readFile(path.join(runDir, ...message.artifact.path.split("/")));
    } catch {
      return undefined;
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== message.artifact.sha256) return undefined;
    const body = JSON.parse(bytes.toString("utf8")) as FeedBody;
    if (pair.feed.pulled.includes(body.batch)) bodies.push(body);
  }
  return bodies;
}

/** Everything a run directory holds that the scorer reads. */
export async function loadRunRecords(runDir: string): Promise<RunRecords> {
  const experimentValue = await readJson(path.join(runDir, "experiment.json"));
  if (experimentValue === undefined) throw new Error(`${runDir} has no experiment.json.`);
  const experiment = parseExperimentJson(experimentValue);
  const manifestValue = await readJson(path.join(runDir, "manifest.json"));
  const manifest = manifestValue === undefined ? undefined : parseCampaignManifest(manifestValue);
  const builderId =
    experiment.tasks.builderIds[0] ?? manifest?.tasks.find((task) => task.role === "builder")?.id;
  const events = builderId === undefined ? undefined : await readEventRecord(runDir, builderId);
  const finalValue = await readJson(path.join(runDir, "final-state.json"));
  const probesValue = await readJson(path.join(runDir, "probes.json"));
  const feedBodies = await pulledFeeds(runDir, manifest);
  return {
    experiment,
    manifest,
    events,
    finalState: finalValue === undefined ? undefined : parseFinalStateRecord(finalValue),
    probes: probesValue === undefined ? undefined : parseProbesJson(probesValue),
    ...(feedBodies === undefined ? {} : { feedBodies }),
  };
}

export async function scoreRun(runDir: string, context: ScoreContext): Promise<ScoreJson> {
  return scoreRecords(await loadRunRecords(runDir), context);
}

export { computeExclusion, contamination } from "./exclusion.js";
export { pairRecord };
