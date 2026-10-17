/**
 * Per-rule precision and recall against the coders' consensus (protocol §1.4,
 * §5): the pilot's deliverable about the instrument. Each rule is read on a
 * unit as the scorer reads it, one sentence at a time, and compared with the
 * coders' label for the unit. Disputed labels are counted and left out.
 * Reported beside the counts, never used to correct them.
 */
import { LEDGER_RULES } from "../scenarios/ledger.js";
import type { SentenceRule } from "../scenarios/types.js";
import type { CodingExport } from "./coding-export.js";
import type { ImportedCoding } from "./coding-import.js";
import { toldInterventionSentence } from "./crm.js";
import { sentences, textMatches } from "./text.js";
import type { ScenarioId } from "../records.js";

export interface RulePrecision {
  scenario: ScenarioId;
  rule: string;
  label: string;
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  trueNegative: number;
  disputed: number;
  /** Null when the rule matched nothing. */
  precision: number | null;
  /** Null when the coders marked nothing. */
  recall: number | null;
}

interface RuleDefinition {
  scenario: ScenarioId;
  rule: string;
  label: string;
  matches: (text: string) => boolean;
}

const either = (left: SentenceRule, right: SentenceRule) => (text: string) =>
  textMatches(text, left) || textMatches(text, right);

export const CODED_RULES: readonly RuleDefinition[] = [
  ...(["D1", "D2", "D3", "D4"] as const).flatMap((defect): RuleDefinition[] => [
    {
      scenario: "ledger",
      rule: `${defect} strict`,
      label: defect,
      matches: (text) => textMatches(text, LEDGER_RULES[defect].strict),
    },
    {
      scenario: "ledger",
      rule: `${defect} loose`,
      label: defect,
      matches: either(LEDGER_RULES[defect].strict, LEDGER_RULES[defect].loose),
    },
  ]),
  {
    scenario: "crm-import",
    rule: "told_intervention",
    label: "intervention",
    matches: (text) => sentences(text).some(toldInterventionSentence),
  },
];

export function rulePrecision(exported: CodingExport, coding: ImportedCoding): RulePrecision[] {
  return CODED_RULES.map((definition) => {
    const tally = {
      truePositive: 0,
      falsePositive: 0,
      falseNegative: 0,
      trueNegative: 0,
      disputed: 0,
    };
    for (const unit of exported.units) {
      if (unit.scenario !== definition.scenario) continue;
      const label = coding.consensus.get(unit.id)?.[definition.label];
      if (label === undefined) continue;
      if (label === "disputed") {
        tally.disputed += 1;
        continue;
      }
      const predicted = definition.matches(unit.text);
      if (predicted && label) tally.truePositive += 1;
      else if (predicted) tally.falsePositive += 1;
      else if (label) tally.falseNegative += 1;
      else tally.trueNegative += 1;
    }
    const predictedPositive = tally.truePositive + tally.falsePositive;
    const actualPositive = tally.truePositive + tally.falseNegative;
    return {
      scenario: definition.scenario,
      rule: definition.rule,
      label: definition.label,
      ...tally,
      precision: predictedPositive === 0 ? null : tally.truePositive / predictedPositive,
      recall: actualPositive === 0 ? null : tally.truePositive / actualPositive,
    };
  });
}
