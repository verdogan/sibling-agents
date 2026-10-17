/**
 * Batch manifest (§2.6): what the plan command writes and run executes. The
 * manifest is registered, committed and immutable: a changed batch is a new id.
 */
import { createHash } from "node:crypto";
import type { ModelPin } from "../compose.js";
import type {
  ArmId,
  BatchModel,
  ExperimentId,
  ScenarioId,
  ScenarioVariant,
} from "../records.js";

export const BATCH_ID_PATTERN = /^(pilot|counted)-[1-9][0-9]*$/;

export interface BatchRun {
  runId: string;
  cell: string;
  arm: ArmId;
  experiment: ExperimentId;
  scenario: ScenarioId;
  variant: ScenarioVariant;
  prompted: boolean;
  rep: number;
  estimateUsd: number;
  capUsd: number;
}

export interface BatchManifest {
  id: string;
  family: "pilot" | "counted";
  runs: BatchRun[];
  models: {
    a: BatchModel;
    b: BatchModel;
  };
  thinking: "low";
  capMarginUsd: {
    aOnly: number;
    modelB: number;
  };
  ceilingUsd: number;
  familyCeilingUsd: number;
  promptDigests: Record<string, string>;
  piVersion: string;
  gitHead: string;
  protocolPath: string;
  protocolSha256: string;
  order?: "fixed" | "model-b-first";
}

export function computeManifestSha256(manifest: BatchManifest): string {
  return createHash("sha256").update(JSON.stringify(manifest), "utf8").digest("hex");
}

export function validateManifest(data: unknown): BatchManifest {
  if (typeof data !== "object" || data === null) {
    throw new TypeError("manifest is not an object");
  }
  const m = data as Record<string, unknown>;

  if (typeof m.id !== "string" || !BATCH_ID_PATTERN.test(m.id)) {
    throw new TypeError("id is not a valid batch id");
  }
  if (m.family !== "pilot" && m.family !== "counted") {
    throw new TypeError("family must be pilot or counted");
  }
  if (!Array.isArray(m.runs) || m.runs.length === 0) {
    throw new TypeError("runs must be a non-empty array");
  }
  for (const [i, run] of m.runs.entries()) {
    if (typeof run !== "object" || run === null) {
      throw new TypeError(`runs[${i}] is not an object`);
    }
    if (typeof run.runId !== "string" || !/^run-[0-9a-f]{8}$/.test(run.runId)) {
      throw new TypeError(`runs[${i}].runId is not valid`);
    }
    if (typeof run.cell !== "string") {
      throw new TypeError(`runs[${i}].cell is not a string`);
    }
    if (typeof run.arm !== "string") {
      throw new TypeError(`runs[${i}].arm is not a string`);
    }
    if (typeof run.experiment !== "string") {
      throw new TypeError(`runs[${i}].experiment is not a string`);
    }
    if (typeof run.scenario !== "string") {
      throw new TypeError(`runs[${i}].scenario is not a string`);
    }
    if (typeof run.variant !== "string") {
      throw new TypeError(`runs[${i}].variant is not a string`);
    }
    if (typeof run.prompted !== "boolean") {
      throw new TypeError(`runs[${i}].prompted is not a boolean`);
    }
    if (!Number.isInteger(run.rep) || run.rep < 1) {
      throw new TypeError(`runs[${i}].rep must be a positive integer`);
    }
    if (typeof run.estimateUsd !== "number" || run.estimateUsd < 0) {
      throw new TypeError(`runs[${i}].estimateUsd must be a non-negative number`);
    }
    if (typeof run.capUsd !== "number" || run.capUsd <= 0) {
      throw new TypeError(`runs[${i}].capUsd must be a positive number`);
    }
  }

  if (typeof m.models !== "object" || m.models === null) {
    throw new TypeError("models is not an object");
  }
  const models = m.models as Record<string, unknown>;
  for (const key of ["a", "b"]) {
    if (typeof models[key] !== "object" || models[key] === null) {
      throw new TypeError(`models.${key} is not an object`);
    }
    const pin = models[key] as Record<string, unknown>;
    if (typeof pin.provider !== "string") {
      throw new TypeError(`models.${key}.provider is not a string`);
    }
    if (typeof pin.model !== "string") {
      throw new TypeError(`models.${key}.model is not a string`);
    }
    if (typeof pin.thinking !== "string") {
      throw new TypeError(`models.${key}.thinking is not a string`);
    }
    if (typeof pin.servedProviderName !== "string") {
      throw new TypeError(`models.${key}.servedProviderName is not a string`);
    }
  }

  if (m.thinking !== "low") {
    throw new TypeError("thinking must be low");
  }

  if (typeof m.capMarginUsd !== "object" || m.capMarginUsd === null) {
    throw new TypeError("capMarginUsd is not an object");
  }
  const margins = m.capMarginUsd as Record<string, unknown>;
  if (typeof margins.aOnly !== "number" || margins.aOnly < 0) {
    throw new TypeError("capMarginUsd.aOnly must be a non-negative number");
  }
  if (typeof margins.modelB !== "number" || margins.modelB < 0) {
    throw new TypeError("capMarginUsd.modelB must be a non-negative number");
  }

  if (typeof m.ceilingUsd !== "number" || m.ceilingUsd <= 0) {
    throw new TypeError("ceilingUsd must be a positive number");
  }
  if (typeof m.familyCeilingUsd !== "number" || m.familyCeilingUsd <= 0) {
    throw new TypeError("familyCeilingUsd must be a positive number");
  }

  if (typeof m.promptDigests !== "object" || m.promptDigests === null) {
    throw new TypeError("promptDigests is not an object");
  }
  const digests = m.promptDigests as Record<string, unknown>;
  for (const [arm, digest] of Object.entries(digests)) {
    if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) {
      throw new TypeError(`promptDigests.${arm} is not a valid sha256`);
    }
  }

  if (typeof m.piVersion !== "string") {
    throw new TypeError("piVersion is not a string");
  }
  if (typeof m.gitHead !== "string" || !/^[0-9a-f]{7,40}$/.test(m.gitHead)) {
    throw new TypeError("gitHead is not a valid git commit");
  }
  if (typeof m.protocolPath !== "string") {
    throw new TypeError("protocolPath is not a string");
  }
  if (typeof m.protocolSha256 !== "string" || !/^[0-9a-f]{64}$/.test(m.protocolSha256)) {
    throw new TypeError("protocolSha256 is not a valid sha256");
  }

  if (m.order !== undefined && m.order !== "fixed" && m.order !== "model-b-first") {
    throw new TypeError("order must be fixed, model-b-first or undefined");
  }

  return m as unknown as BatchManifest;
}
