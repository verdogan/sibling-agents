/**
 * Reading the coders' judgments back (protocol §1.4), keyed by the export's
 * opaque ids. A file is refused whole if it names an id the export does not
 * have, judges an id twice, leaves an exported unit out, or answers other
 * questions than the unit's scenario asks. The consensus of several coders is
 * a label on which they all agree; a disagreement is `disputed` and left out
 * of precision and recall, and counted. One coder is reported as "single
 * coder".
 */
import type { CodingExport } from "./coding-export.js";

export interface CodingJudgments {
  version: 1;
  coder: string;
  judgments: { id: string; labels: Record<string, boolean> }[];
}

export type Consensus = boolean | "disputed";

export interface ImportedCoding {
  coders: string[];
  singleCoder: boolean;
  /** Per unit id, per label. */
  consensus: Map<string, Record<string, Consensus>>;
}

export class CodingImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodingImportError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJudgments(value: unknown, exported: CodingExport): CodingJudgments {
  if (!isRecord(value) || value["version"] !== 1 || typeof value["coder"] !== "string") {
    throw new CodingImportError("A coding file is a version 1 object naming its coder.");
  }
  const coder = value["coder"];
  if (!Array.isArray(value["judgments"])) {
    throw new CodingImportError(`${coder}'s coding file has no judgments list.`);
  }
  const units = new Map(exported.units.map((unit) => [unit.id, unit]));
  const seen = new Set<string>();
  const judgments: CodingJudgments["judgments"] = [];
  for (const entry of value["judgments"]) {
    if (!isRecord(entry) || typeof entry["id"] !== "string" || !isRecord(entry["labels"])) {
      throw new CodingImportError(
        `${coder}'s coding file has a judgment that is not {id, labels}.`,
      );
    }
    const id = entry["id"];
    const unit = units.get(id);
    if (unit === undefined) {
      throw new CodingImportError(`${coder} judged ${id}, which was not exported.`);
    }
    if (seen.has(id)) throw new CodingImportError(`${coder} judged ${id} twice.`);
    seen.add(id);
    const wanted = [...exported.labels[unit.scenario]].sort();
    const given = Object.keys(entry["labels"]).sort();
    if (wanted.join(",") !== given.join(",")) {
      throw new CodingImportError(
        `${coder}'s judgment of ${id} answers ${given.join(", ") || "nothing"}, ` +
          `not ${wanted.join(", ")}.`,
      );
    }
    const labels: Record<string, boolean> = {};
    for (const label of wanted) {
      const answer = entry["labels"][label];
      if (typeof answer !== "boolean") {
        throw new CodingImportError(
          `${coder}'s judgment of ${id} has a ${label} that is not true or false.`,
        );
      }
      labels[label] = answer;
    }
    judgments.push({ id, labels });
  }
  const missing = exported.units.filter((unit) => !seen.has(unit.id)).map((unit) => unit.id);
  if (missing.length > 0) {
    throw new CodingImportError(
      `${coder} left ${missing.length} unit(s) unjudged, the first ${missing[0]}.`,
    );
  }
  return { version: 1, coder, judgments };
}

export function importCoding(exported: CodingExport, files: readonly unknown[]): ImportedCoding {
  if (files.length === 0) throw new CodingImportError("No coding file was given.");
  const parsed = files.map((file) => parseJudgments(file, exported));
  const coders = parsed.map((file) => file.coder);
  if (new Set(coders).size !== coders.length) {
    throw new CodingImportError("Two coding files name the same coder.");
  }
  const consensus = new Map<string, Record<string, Consensus>>();
  for (const unit of exported.units) {
    const labels: Record<string, Consensus> = {};
    for (const label of exported.labels[unit.scenario]) {
      const answers = new Set(
        parsed.map(
          (file) => file.judgments.find((judgment) => judgment.id === unit.id)!.labels[label]!,
        ),
      );
      labels[label] = answers.size === 1 ? [...answers][0]! : "disputed";
    }
    consensus.set(unit.id, labels);
  }
  return { coders, singleCoder: coders.length === 1, consensus };
}
