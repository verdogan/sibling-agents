import { replaceWorkspaceFile } from "../guards.js";
import { defineTool, type HarnessExtension } from "../harness/index.js";
import { Type } from "typebox";
import type { Feature, FeatureContext } from "./types.js";

/** Larger than result.json because findings accumulate across a whole task. */
const MAX_FINDINGS_BYTES = 512 * 1024;
const MAX_FINDINGS = 500;
const MAX_CLAIM_CHARS = 500;
const MAX_EXCERPT_CHARS = 2_000;
const MAX_LOCATOR_CHARS = 2_048;
const MAX_NOTE_CHARS = 1_000;

export const FINDINGS_FILE = "findings.json";
export const RECORD_FINDING_TOOL_NAME = "record_finding";

export const VERIFICATION_FILE = "verification.json";
export const VERIFY_FINDING_TOOL_NAME = "verify_finding";

/**
 * Generous, because the verifier is not told which string it has to hit.
 *
 * The overlord holds the excerpt back on purpose, so the only way to report an
 * observation that could contain it is to quote a whole region of the page. A
 * tight cap here would make honest verification impossible.
 */
const MAX_OBSERVED_TEXT_CHARS = 12_000;
const MAX_EVIDENCE_CHARS = 1_000;
const MAX_VERIFICATION_BYTES = 512 * 1024;
const MAX_VERIFICATIONS = 500;

/**
 * A source kind whose locator another agent can independently fetch again.
 * Anything else is an attestation: worth recording, but nobody can re-check it
 * later, so the overlord scores the two classes separately.
 */
export const recheckableSourceKinds = ["url"] as const;
export const sourceKinds = ["url", "message", "call", "document"] as const;
export const claimConfidences = ["asserted", "inferred"] as const;

export function isRecheckableSourceKind(kind: string): boolean {
  return (recheckableSourceKinds as readonly string[]).includes(kind);
}

/**
 * Re-check at execute time what the parameter schema already declares.
 *
 * The schema is advertised to the model, but nothing between the model and this
 * function guarantees the arguments were validated against it, and for this tool
 * the excerpt is not a nicety — it is the entire property that makes a finding
 * checkable. An unsourced finding written to disk is worse than a refused tool
 * call, because it looks exactly like a sourced one.
 */
function assertRecordable(params: {
  id: string;
  claim: string;
  confidence: string;
  source: { kind: string; locator: string; retrievedAt: string; excerpt: string };
}): void {
  const blank = (value: unknown): boolean => typeof value !== "string" || value.trim() === "";

  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(params.id)) {
    throw new Error("id must be a lowercase slug of at most 64 characters.");
  }
  if (blank(params.claim)) throw new Error("claim cannot be empty.");
  if (!(claimConfidences as readonly string[]).includes(params.confidence)) {
    throw new Error(`confidence must be one of: ${claimConfidences.join(", ")}.`);
  }
  if (!(sourceKinds as readonly string[]).includes(params.source?.kind)) {
    throw new Error(`source.kind must be one of: ${sourceKinds.join(", ")}.`);
  }
  if (blank(params.source?.locator)) throw new Error("source.locator cannot be empty.");
  if (blank(params.source?.excerpt)) {
    throw new Error(
      "source.excerpt cannot be empty: quote the exact text from the source that supports " +
        "this claim. Without it the finding cannot be verified and will be discarded.",
    );
  }
  if (Number.isNaN(Date.parse(params.source?.retrievedAt))) {
    throw new Error("source.retrievedAt must be an ISO-8601 timestamp.");
  }
}

/**
 * Re-check at execute time what the parameter schema already declares.
 *
 * The asymmetry with `assertRecordable` is deliberate: a verification that claims
 * the locator was fetched but reports no text is refused here rather than written,
 * because the overlord can only read such a record as a failed claim, and the
 * verifier that made it deserves to be told what is missing while it can still
 * fix it.
 */
function assertVerifiable(params: {
  findingId: string;
  locatorFetched: boolean;
  observedText?: string;
  evidence: string;
}): void {
  const blank = (value: unknown): boolean => typeof value !== "string" || value.trim() === "";

  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(params.findingId)) {
    throw new Error("findingId must be one of the ids listed in the verification request.");
  }
  if (typeof params.locatorFetched !== "boolean") {
    throw new Error("locatorFetched must be true or false.");
  }
  if (blank(params.evidence)) {
    throw new Error("evidence cannot be empty: say what you did and what you saw.");
  }
  if (params.locatorFetched && blank(params.observedText)) {
    throw new Error(
      "observedText cannot be empty when locatorFetched is true: quote the text you actually " +
        "saw at the locator, verbatim and generously. If you could not retrieve the page, set " +
        "locatorFetched to false and explain why in evidence.",
    );
  }
}

/**
 * Independent re-checking of someone else's findings.
 *
 * The verifier is given ids, claims and locators, and deliberately not the
 * excerpts the original task quoted. It reports what it saw; the overlord does
 * the string comparison. That split is the whole point: a verifier that never
 * received the excerpt cannot manufacture a match without actually retrieving the
 * page, so a confirmation means something even though a model produced it.
 */
export const verificationFeature: Feature = {
  name: "verification",
  toolNames: [VERIFY_FINDING_TOOL_NAME],
  promptSections: () => [
    `## Verifying findings

If the task seeds a verification request, another task recorded those findings and
your job is to re-check them independently. For each id listed, retrieve the
locator yourself and call ${VERIFY_FINDING_TOOL_NAME} once with what you saw.

You have not been shown the text the original task quoted, and that is not an
oversight. Copy a generous verbatim region of the retrieved page into
\`observedText\` — the passage relevant to the claim plus the surrounding text.
Do not summarise it, translate it, or tidy it, and never assemble it from the
claim, from other seeded files, or from memory. The comparison happens elsewhere,
against text you cannot see, so a paraphrase reads as a contradiction.

If a locator cannot be retrieved, set \`locatorFetched\` to false and say why. That
is an honest and useful answer; a page that has moved is not the same thing as a
claim that was never true, and only you can tell them apart.

Report what you found, not what would be convenient. A finding you cannot
substantiate is the single most valuable thing you can return.`,
  ],
  extension: (ctx: FeatureContext): HarnessExtension => ({
    name: "verification",
    factory: (pi) => {
      // Keyed by finding id, so a retried call replaces rather than duplicates:
      // the overlord rejects a document that reports one finding twice.
      const verifications = new Map<string, unknown>();

      pi.registerTool(
        defineTool({
          name: VERIFY_FINDING_TOOL_NAME,
          label: "Verify Finding",
          description:
            "Report the result of independently retrieving one finding's locator. " +
            "Call once per requested finding id. Re-reporting the same id replaces it.",
          promptSnippet: `${VERIFY_FINDING_TOOL_NAME}: report the text you observed at one finding's locator`,
          parameters: Type.Object(
            {
              findingId: Type.String({
                pattern: "^[a-z0-9][a-z0-9-]{0,63}$",
                description: "The id from the verification request that this report covers.",
              }),
              locatorFetched: Type.Boolean({
                description: "True only if you actually retrieved the locator yourself.",
              }),
              observedText: Type.Optional(
                Type.String({
                  maxLength: MAX_OBSERVED_TEXT_CHARS,
                  description:
                    "Verbatim text from the retrieved locator, quoted generously. Required when locatorFetched is true.",
                }),
              ),
              evidence: Type.String({
                minLength: 1,
                maxLength: MAX_EVIDENCE_CHARS,
                pattern: "\\S",
                description: "What you did to retrieve it, and what happened.",
              }),
            },
            { additionalProperties: false },
          ),
          execute: async (_toolCallId, params) => {
            assertVerifiable(params);

            const replaced = verifications.has(params.findingId);
            if (!replaced && verifications.size >= MAX_VERIFICATIONS) {
              throw new Error(
                `This task already reported ${MAX_VERIFICATIONS} verifications, which is the limit.`,
              );
            }
            // checkedAt is stamped here rather than taken from the model. The
            // overlord refuses an observation dated before the source was
            // retrieved, and that check is worthless if the observer sets the clock.
            verifications.set(params.findingId, {
              ...params,
              checkedAt: new Date().toISOString(),
            });

            const body = `${JSON.stringify({ verifications: [...verifications.values()] }, null, 2)}\n`;
            const bytes = Buffer.byteLength(body);
            if (bytes > MAX_VERIFICATION_BYTES) {
              verifications.delete(params.findingId);
              throw new Error(
                `${VERIFICATION_FILE} would be ${bytes} bytes; the limit is ${MAX_VERIFICATION_BYTES}. ` +
                  "Quote a shorter region, but keep it verbatim.",
              );
            }

            await replaceWorkspaceFile(ctx.workspaceDir, VERIFICATION_FILE, body);

            return {
              content: [
                {
                  type: "text" as const,
                  text: `${replaced ? "Replaced" : "Recorded"} verification of ${params.findingId}. ${verifications.size} reported.`,
                },
              ],
              details: {
                findingId: params.findingId,
                replaced,
                count: verifications.size,
                bytes,
              },
            };
          },
        }),
      );
    },
  }),
};

/**
 * Evidence-bound findings.
 *
 * A model asked to research the world will produce fluent, plausible, entirely
 * invented answers, and every acceptance check this repository has — the file
 * exists, the JSON parses, the schema matches — passes on a convincing fake. The
 * excerpt field is what closes that hole: the task must quote the exact text its
 * claim rests on, so re-verification reduces to fetching the locator again and
 * testing whether that string is still present. String comparison, not a second
 * model's judgement.
 */
export const findingsFeature: Feature = {
  name: "findings",
  toolNames: [RECORD_FINDING_TOOL_NAME],
  promptSections: () => [
    `## Recording findings

When the task asks you to find things out about the world, record each one with
${RECORD_FINDING_TOOL_NAME} as you confirm it. Do not save them up for a summary
at the end; a finding you recorded survives a crash and one you were about to
write does not.

Every finding needs the exact text it rests on, copied verbatim into \`excerpt\`
from the page or message you actually retrieved. Do not paraphrase it, tidy it,
translate it, or reconstruct it from memory. This is not bookkeeping: a separate
task later fetches your locator again and checks whether that exact string is
still there, and anything that fails is discarded and counted against the task.
If you cannot quote a source, you do not have a finding yet.

Mark \`confidence\` as "asserted" only when the source itself states the claim.
If you worked it out by combining or interpreting sources, mark it "inferred"
and still quote whatever you reasoned from. Both are useful and only one is
evidence; conflating them is the failure this tool exists to prevent.

Recording nothing is a valid and honest outcome. A task that reports it found
nothing is far more useful than one that fills a quota.`,
  ],
  extension: (ctx: FeatureContext): HarnessExtension => ({
    name: "findings",
    factory: (pi) => {
      // Keyed by id so a retried call replaces rather than duplicates, which
      // makes the tool idempotent for a model that loses track mid-task.
      const findings = new Map<string, unknown>();

      pi.registerTool(
        defineTool({
          name: RECORD_FINDING_TOOL_NAME,
          label: "Record Finding",
          description:
            "Record one evidence-bound finding, with the verbatim source text the claim rests on. " +
            "Call once per finding as you confirm it. Re-recording the same id replaces it.",
          promptSnippet: `${RECORD_FINDING_TOOL_NAME}: record one finding with its verbatim source excerpt`,
          parameters: Type.Object(
            {
              id: Type.String({
                pattern: "^[a-z0-9][a-z0-9-]{0,63}$",
                description: "Stable slug, unique within this task.",
              }),
              claim: Type.String({
                minLength: 1,
                maxLength: MAX_CLAIM_CHARS,
                pattern: "\\S",
                description: "The single assertion this finding makes, in one sentence.",
              }),
              confidence: Type.Union(claimConfidences.map((value) => Type.Literal(value))),
              source: Type.Object(
                {
                  kind: Type.Union(sourceKinds.map((value) => Type.Literal(value))),
                  locator: Type.String({
                    minLength: 1,
                    maxLength: MAX_LOCATOR_CHARS,
                    pattern: "\\S",
                    description: "URL, message id, or document identifier that can be resolved again.",
                  }),
                  retrievedAt: Type.String({
                    format: "date-time",
                    description: "When you actually retrieved it, not when you wrote this down.",
                  }),
                  excerpt: Type.String({
                    minLength: 1,
                    maxLength: MAX_EXCERPT_CHARS,
                    pattern: "\\S",
                    description:
                      "Verbatim text from the source supporting the claim. Copied, never paraphrased.",
                  }),
                },
                { additionalProperties: false },
              ),
              fields: Type.Record(Type.String(), Type.String(), {
                description: "Structured data extracted from the source, such as a name or a contact.",
              }),
              note: Type.Optional(
                Type.String({
                  maxLength: MAX_NOTE_CHARS,
                  description: "Optional context for a human reading the finding later.",
                }),
              ),
            },
            { additionalProperties: false },
          ),
          execute: async (_toolCallId, params) => {
            assertRecordable(params);

            const replaced = findings.has(params.id);
            if (!replaced && findings.size >= MAX_FINDINGS) {
              throw new Error(
                `This task already recorded ${MAX_FINDINGS} findings, which is the limit.`,
              );
            }
            findings.set(params.id, { ...params, recordedAt: new Date().toISOString() });

            const body = `${JSON.stringify({ findings: [...findings.values()] }, null, 2)}\n`;
            const bytes = Buffer.byteLength(body);
            if (bytes > MAX_FINDINGS_BYTES) {
              findings.delete(params.id);
              throw new Error(
                `${FINDINGS_FILE} would be ${bytes} bytes; the limit is ${MAX_FINDINGS_BYTES}. ` +
                  "Record fewer or shorter findings.",
              );
            }

            // Findings accumulate, so a truncated write would lose every earlier
            // one. Write beside the target and rename, which is atomic on one
            // filesystem, rather than rewriting the file in place. The temp name
            // is random and created exclusively, and a findings.json that is a
            // link is refused rather than written through: the shell can make
            // either, and a fixed `findings.json.tmp` was a name it could plant.
            await replaceWorkspaceFile(ctx.workspaceDir, FINDINGS_FILE, body);

            return {
              content: [
                {
                  type: "text" as const,
                  text: `${replaced ? "Replaced" : "Recorded"} finding ${params.id}. ${findings.size} recorded.`,
                },
              ],
              details: { id: params.id, replaced, count: findings.size, bytes },
            };
          },
        }),
      );
    },
  }),
};
