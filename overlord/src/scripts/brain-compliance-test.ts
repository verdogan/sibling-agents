/**
 * Measures whether a real model answers the brain's questions in a form the
 * driver would act on, for every phase the driver actually asks about.
 *
 * The questions are the production ones. Each phase's request comes from the
 * builder the driver itself calls, fed the fixed inputs in
 * `campaign/fixtures-decisions.ts`, and an answer counts as compliant only when
 * its envelope parses *and* that builder's validator accepts it: types,
 * non-empty and unique selections, ready and retryable ids, bounds, and
 * dependency cycles. Until the validators were shared this harness checked
 * argument keys alone, so `sliceIds: []` counted as compliant. Rates measured
 * before that change are not comparable with rates measured after it.
 *
 * This measures rather than verifies. A low compliance rate is a finding, not a
 * broken build: when an answer does not parse or is refused, the driver
 * silently uses its deterministic fallback and the campaign still completes, so
 * the rate below is the only thing that distinguishes a model-driven campaign
 * from one whose model contributes nothing.
 *
 * The production request path is exercised end to end, so a failure here is a
 * failure a campaign would really have taken.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import {
  CampaignBrainError,
  campaignBrainFromEnv,
  type CampaignBrain,
  type CampaignBrainPhase,
} from "../campaign/brain.js";
import { complianceDecisions } from "./campaign/fixtures-decisions.js";

// Read the same `.env` the client does. Without this, a correctly configured
// checkout reported "nothing was measured" — the one failure mode a compliance
// harness must not have, since an unmeasured run and a zero score look alike to
// anyone reading a summary later.
const envFile = path.resolve(process.cwd(), ".env");
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

type OutcomeKind =
  | "compliant"
  | "markdown_fenced"
  | "unparsable_content"
  | "unknown_field"
  | "illegal_action"
  | "malformed_envelope"
  | "invalid_arguments"
  | "oversized"
  | "transport";

interface Attempt {
  phase: CampaignBrainPhase;
  kind: OutcomeKind;
  action: string | null;
  detail: string | null;
  ms: number;
}

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

/**
 * Captures the raw provider response so a parse failure can be attributed to
 * Markdown fencing specifically, which is the failure the prompt asks the model
 * to avoid and the only one a `response_format` would remove.
 *
 * Content-encoding and content-length are dropped because the replayed body is
 * already decoded; the streaming byte cap in the brain still applies.
 */
function capturingFetch(capture: { body: string | undefined }): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await globalThis.fetch(input, init);
    const text = await response.text();
    capture.body = text;
    const headers = new Headers(response.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    return new Response(NULL_BODY_STATUS.has(response.status) ? null : text, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}

function assistantContent(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  try {
    const body: unknown = JSON.parse(raw);
    if (typeof body !== "object" || body === null) return undefined;
    const choices = (body as Record<string, unknown>)["choices"];
    if (!Array.isArray(choices) || choices.length === 0) return undefined;
    const first = choices[0];
    if (typeof first !== "object" || first === null) return undefined;
    const message = (first as Record<string, unknown>)["message"];
    if (typeof message !== "object" || message === null) return undefined;
    const content = (message as Record<string, unknown>)["content"];
    return typeof content === "string" ? content : undefined;
  } catch {
    return undefined;
  }
}

function isMarkdownFenced(content: string | undefined): boolean {
  return content !== undefined && content.trim().startsWith("```");
}

function classify(error: unknown, content: string | undefined): { kind: OutcomeKind; detail: string } {
  const detail = error instanceof Error ? error.message : String(error);
  if (!(error instanceof CampaignBrainError)) return { kind: "transport", detail };
  if (detail.startsWith("Overlord brain request failed") || detail.includes("returned HTTP")) {
    return { kind: "transport", detail };
  }
  if (detail.includes("exceeds")) return { kind: "oversized", detail };
  if (detail.includes("unknown field")) return { kind: "unknown_field", detail };
  if (detail.includes("illegal action")) return { kind: "illegal_action", detail };
  if (detail.includes("was not a JSON object") || detail.includes("was not valid JSON")) {
    return { kind: isMarkdownFenced(content) ? "markdown_fenced" : "unparsable_content", detail };
  }
  return { kind: "malformed_envelope", detail };
}

const decisions = complianceDecisions();
const phases = Object.keys(decisions) as CampaignBrainPhase[];

function positiveEnvInteger(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const trials = positiveEnvInteger("BRAIN_COMPLIANCE_TRIALS", 5);
const models = (process.env["BRAIN_COMPLIANCE_MODELS"] ?? process.env["OVERLORD_BRAIN_MODEL"] ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry !== "");

if (models.length === 0) {
  console.error(
    "Set OVERLORD_BRAIN_MODEL (and OVERLORD_BRAIN_BASE_URL), or BRAIN_COMPLIANCE_MODELS for a\n" +
      "comma-separated comparison. Nothing was measured.",
  );
  process.exit(1);
}

const minRate = Number.parseFloat(process.env["BRAIN_COMPLIANCE_MIN_RATE"] ?? "");
const gated = Number.isFinite(minRate);

function rate(compliant: number, total: number): string {
  return total === 0 ? "n/a" : `${((compliant / total) * 100).toFixed(1)}%`;
}

const summary: Record<string, unknown>[] = [];
let overallCompliant = 0;
let overallTotal = 0;
let failed = false;

console.log(
  `${models.length} model(s) x ${phases.length} phases x ${trials} trial(s) = ` +
    `${models.length * phases.length * trials} paid decision call(s)\n`,
);

for (const model of models) {
  const capture: { body: string | undefined } = { body: undefined };
  let brain: CampaignBrain | undefined;
  try {
    brain = campaignBrainFromEnv(
      { ...process.env, OVERLORD_BRAIN_MODEL: model },
      capturingFetch(capture),
    );
  } catch (error) {
    failed = true;
    console.error(`${model}: ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }
  if (brain === undefined) {
    failed = true;
    console.error(`${model}: OVERLORD_BRAIN_BASE_URL is not configured.`);
    continue;
  }

  const attempts: Attempt[] = [];
  for (const phase of phases) {
    const decision = decisions[phase];
    for (let trial = 0; trial < trials; trial += 1) {
      capture.body = undefined;
      const startedAt = Date.now();
      try {
        const choice = await brain.decide(decision.request);
        // The validator the driver would run before acting on this answer.
        let invalid: string | null = null;
        try {
          decision.validate(choice);
        } catch (error) {
          invalid = error instanceof Error ? error.message : String(error);
        }
        attempts.push({
          phase,
          kind: invalid === null ? "compliant" : "invalid_arguments",
          action: choice.action,
          detail: invalid,
          ms: Date.now() - startedAt,
        });
      } catch (error) {
        const { kind, detail } = classify(error, assistantContent(capture.body));
        attempts.push({ phase, kind, action: null, detail, ms: Date.now() - startedAt });
      }
    }
  }

  const compliant = attempts.filter((attempt) => attempt.kind === "compliant").length;
  overallCompliant += compliant;
  overallTotal += attempts.length;

  console.log(`${model}  ${rate(compliant, attempts.length)} compliant (${compliant}/${attempts.length})`);
  for (const phase of phases) {
    const forPhase = attempts.filter((attempt) => attempt.phase === phase);
    const ok = forPhase.filter((attempt) => attempt.kind === "compliant").length;
    const median = [...forPhase].sort((a, b) => a.ms - b.ms)[Math.floor(forPhase.length / 2)]?.ms ?? 0;
    const chosen = [...new Set(forPhase.map((attempt) => attempt.action).filter((a) => a !== null))];
    console.log(
      `  ${phase.padEnd(12)} ${String(ok).padStart(3)}/${String(forPhase.length).padEnd(3)} ` +
        `${rate(ok, forPhase.length).padStart(6)}  ${String(median).padStart(6)}ms  ` +
        `${chosen.join(", ") || "-"}`,
    );
  }
  const failures = attempts.filter((attempt) => attempt.kind !== "compliant");
  if (failures.length > 0) {
    const byKind = new Map<OutcomeKind, number>();
    for (const attempt of failures) byKind.set(attempt.kind, (byKind.get(attempt.kind) ?? 0) + 1);
    console.log(
      `  failures: ${[...byKind].map(([kind, count]) => `${kind}=${count}`).join(" ")}`,
    );
    for (const attempt of failures.slice(0, 3)) {
      console.log(`    ${attempt.phase} ${attempt.kind}: ${attempt.detail?.slice(0, 160) ?? ""}`);
    }
  }
  console.log("");

  summary.push({
    model,
    trials,
    compliant,
    total: attempts.length,
    complianceRate: attempts.length === 0 ? null : compliant / attempts.length,
    byPhase: Object.fromEntries(
      phases.map((phase) => {
        const forPhase = attempts.filter((attempt) => attempt.phase === phase);
        return [
          phase,
          {
            compliant: forPhase.filter((attempt) => attempt.kind === "compliant").length,
            total: forPhase.length,
            kinds: forPhase.reduce<Record<string, number>>((counts, attempt) => {
              counts[attempt.kind] = (counts[attempt.kind] ?? 0) + 1;
              return counts;
            }, {}),
          },
        ];
      }),
    ),
  });
}

console.log(
  JSON.stringify(
    {
      measuredAt: new Date().toISOString(),
      endpoint: process.env["OVERLORD_BRAIN_BASE_URL"] ?? null,
      overallComplianceRate: overallTotal === 0 ? null : overallCompliant / overallTotal,
      models: summary,
    },
    null,
    2,
  ),
);

if (gated && overallTotal > 0 && overallCompliant / overallTotal < minRate) {
  failed = true;
  console.error(
    `Overall compliance ${rate(overallCompliant, overallTotal)} is below ` +
      `BRAIN_COMPLIANCE_MIN_RATE=${minRate}.`,
  );
}

process.exit(failed ? 1 : 0);
