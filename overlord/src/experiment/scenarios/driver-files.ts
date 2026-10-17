/**
 * What the driver adds to every builder's workspace besides the seeds
 * (protocol §2, "Files the driver adds (bytes)"; F7): `campaign/context.json`,
 * rendered from the campaign's goal and acceptance, and
 * `campaign/result-contract.json`. Both are the same in every arm. The goal
 * and the one acceptance criterion are the owner's F7 decision: they restate
 * the slice and encode no arm, defect or rep. The campaign id differs per run,
 * so `context.json` has a template here, not a hash.
 *
 * These are not scenario constants: `roles.ts` writes the files. The composer
 * passes the goal and acceptance below, and the $0 end-to-end check (W3-A)
 * asserts the bytes from A's final-state record.
 */
import type { AcceptanceCriterion } from "../../campaign/schema.js";
import { file } from "./types.js";

export const NEUTRAL_GOAL = "Complete the slice described in campaign/slice.md.";

export const NEUTRAL_ACCEPTANCE: readonly AcceptanceCriterion[] = [
  {
    id: "slice",
    kind: "file",
    requirement: "The work described in campaign/slice.md is done.",
  },
];

/** Stands for the run's `<scenario>-<6 random hex>` in the printed template. */
export const CAMPAIGN_ID_PLACEHOLDER = "<campaign id>";

export const CONTEXT_TEMPLATE = file(
  "{",
  '  "campaignId": "<campaign id>",',
  '  "goal": "Complete the slice described in campaign/slice.md.",',
  '  "acceptance": [',
  "    {",
  '      "id": "slice",',
  '      "kind": "file",',
  '      "requirement": "The work described in campaign/slice.md is done."',
  "    }",
  "  ],",
  '  "bar": null',
  "}",
);

/** `campaign/context.json` for one run. */
export function contextJson(campaignId: string): string {
  return CONTEXT_TEMPLATE.replace(CAMPAIGN_ID_PLACEHOLDER, campaignId);
}

export const RESULT_CONTRACT = file(
  "{",
  '  "status": "success | partial | failure",',
  '  "summary": "short human-readable summary",',
  '  "data": {',
  '    "kind": "build",',
  '    "artifacts": [',
  "      {",
  '        "path": "relative/output/path",',
  '        "sha256": "optional lowercase SHA-256"',
  "      }",
  "    ]",
  "  },",
  '  "steps": [',
  '    "what the worker actually did"',
  "  ]",
  "}",
);

export const RESULT_CONTRACT_SHA256 =
  "2b2b47e3e6aec8ed9cc8b2d71359b42de7c21e7befcf3edff19b9033ec4c674c";
