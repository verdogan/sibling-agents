/**
 * The fixtures phase (W3-A plan §4.4): every scorer fixture (a)-(u) runs as a
 * real campaign (`runOffline`), its probes run on the final files A left
 * (`writeProbes`), and it is scored with the digests the dry runs registered.
 * Every field the fixture declares must come out as declared, and every probe
 * it declares must be what the real probe finds. Then the record asserts:
 * B9's busy workspace, B13's raw results and the F5 capture, the max_turns run
 * (C23), item 7's contamination, B12's holds, C7's served-unknown, and the
 * E3/E6 batches against the cap of 56.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { CampaignPairRecord } from "../../campaign/schema.js";
import { SCORER_FIXTURES, type ScorerFixture } from "../../experiment/fixtures/index.js";
import { call, script, turn } from "../../experiment/fixtures/types.js";
import { writeProbes } from "../../experiment/probes.js";
import { parseFinalStateRecord, type ProbesJson } from "../../experiment/records.js";
import { scoreRun, type ScoreJson } from "../../experiment/score/index.js";
import { attempt, fixture, pool, took } from "./regressions.js";
import {
  contaminationVerdict,
  offlineContext,
  offlineRun,
  readJsonFile,
  runOffline,
  type OfflineRun,
  type PhaseContext,
} from "./support.js";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
/** The cap on the regular batches of an E3 or E6 run (protocol §1.5). */
const REGULAR_BATCH_CAP = 56;
/** The fixtures whose B holds A (B12). */
const HOLD_FIXTURES = ["c", "d", "f", "g", "h", "i"];

interface Scored {
  run: OfflineRun;
  probes: ProbesJson;
  score: ScoreJson;
}

/** A dotted path into a score; numeric segments index arrays. */
function at(value: unknown, dotted: string): unknown {
  let current = value;
  for (const segment of dotted.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * The score fields read from a probe. A fixture that declares no such probe
 * has the synthetic run's placeholder (`unavailable`) as its expected value;
 * the real probe computes the real one, so those fields are not compared.
 */
const FROM_PROBE: Readonly<Record<string, keyof Omit<ProbesJson, "version">>> = {
  "ledger.testsPass": "testsPass",
  "crm.completed": "testsPass",
  "ledger.p2": "settleEven",
  "ledger.chargesZeroWeight": "settleZeroWeight",
};

function undeclaredProbeFields(entry: ScorerFixture): string[] {
  return Object.keys(entry.expected).filter((dotted) => {
    const probe = FROM_PROBE[dotted];
    return probe !== undefined && entry.probes?.[probe] === undefined;
  });
}

/** Every declared field against the score, and every declared probe against the real one. */
function mismatches(entry: ScorerFixture, scored: Scored): string[] {
  const skipped = new Set(undeclaredProbeFields(entry));
  const wrong = Object.entries(entry.expected)
    .filter(([dotted]) => !skipped.has(dotted))
    .filter(([dotted, value]) => JSON.stringify(at(scored.score, dotted)) !== JSON.stringify(value))
    .map(([dotted, value]) => `${dotted}: ${JSON.stringify(at(scored.score, dotted))}, not ${JSON.stringify(value)}`);
  for (const [name, declared] of Object.entries(entry.probes ?? {})) {
    const actual = scored.probes[name as keyof ProbesJson] as { status: string; value?: unknown } | undefined;
    const same =
      actual?.status === declared.status &&
      (declared.status !== "ran" || JSON.stringify(actual.value) === JSON.stringify(declared.value));
    if (!same) wrong.push(`probe ${name}: ${JSON.stringify(actual)}, declared ${JSON.stringify(declared)}`);
  }
  return wrong;
}

function pairOf(run: OfflineRun): CampaignPairRecord | null {
  return run.manifest.slices[0]?.attempts[0]?.watch ?? null;
}

async function scoreOffline(run: OfflineRun, digests: Record<string, string>): Promise<Scored> {
  const probes = await writeProbes(run.runDir);
  return { run, probes, score: await scoreRun(run.runDir, offlineContext(digests)) };
}

export async function fixturesPhase(context: PhaseContext): Promise<void> {
  const { report } = context;
  const digests = context.promptDigests;
  if (digests === null) {
    await report.check("fixtures: the dry runs registered the prompt digests", () => {
      throw new Error("the dry-runs phase did not run before the fixtures");
    });
    return;
  }
  const ling = await context.ling();
  const root = path.join(context.scratch, "fixtures");
  const selected =
    context.fixtureIds === null ? SCORER_FIXTURES : SCORER_FIXTURES.filter((entry) => context.fixtureIds!.includes(entry.id));
  const offline = (entry: ScorerFixture, turns = entry.script) =>
    attempt(async () => {
      const run = await runOffline({
        ling,
        root,
        batchId: "e2e-fixtures",
        run: offlineRun(entry.arm, entry.variant, 1, entry.prompted),
        script: turns,
        context: offlineContext(digests),
      });
      return scoreOffline(run, digests);
    });
  const results = await pool(context.concurrency, selected.map((entry) => () => offline(entry)));

  const scored = new Map<string, Scored>();
  for (const [index, entry] of selected.entries()) {
    const result = results[index]!;
    await report.check(`fixture (${entry.id}) ${entry.title}: a real run scores as declared`, () => {
      if (result instanceof Error) throw result;
      scored.set(entry.id, result);
      console.log(`      (${entry.id}): ${took(result.run)}, ${result.run.final.outcome.status}`);
      for (const dotted of undeclaredProbeFields(entry)) {
        console.log(`      (${entry.id}) ${dotted}: declares no probe; the real one gives ${JSON.stringify(at(result.score, dotted))}`);
      }
      assert.deepEqual(mismatches(entry, result), []);
    });
  }
  const ran = (id: string): Scored => {
    const found = scored.get(id);
    assert(found !== undefined, `fixture (${id}) did not run`);
    return found;
  };
  const has = (id: string) => selected.some((entry) => entry.id === id);

  await report.check("B9: every fixture run left a final-state record, captured before release", async () => {
    for (const { run } of scored.values()) {
      parseFinalStateRecord(await readJsonFile(path.join(run.runDir, "final-state.json")));
      const builder = run.captures.find((entry) => entry.role === "builder");
      assert(builder?.finalState != null, `${run.experiment.cell}: no builder capture with a final state`);
    }
  });

  if (has("s")) {
    await report.check("B9 (s): the busy workspace is listed whole, and the files it reads keep their content", async () => {
      const finalState = parseFinalStateRecord(await readJsonFile(path.join(ran("s").run.runDir, "final-state.json")));
      const pad = finalState.files.filter((entry) => entry.path.startsWith("node_modules/pad/"));
      assert.equal(pad.length, 600, `${pad.length} node_modules/pad files listed`);
      assert(pad.every((entry) => entry.type === "file" && /^[0-9a-f]{64}$/.test(entry.sha256 ?? "")), "a pad file has no sha256");
      assert.equal(finalState.filesOmitted, 0);
      for (const kept of ["CHANGES.md", "test/fixtures/customers.csv"]) {
        const entry = finalState.files.find((file) => file.path === kept);
        assert(entry !== undefined && entry.content !== null, `${kept} has no content`);
      }
    });
  }

  for (const id of ["q", "r"].filter(has)) {
    await report.check(`B13 (${id}): result.raw and the record's sha256 are the bytes A wrote`, async () => {
      const { run } = ran(id);
      const bytes = fixture(id).resultBytes!;
      assert.equal(await readFile(path.join(run.runDir, "result.raw"), "utf8"), bytes);
      const finalState = parseFinalStateRecord(await readJsonFile(path.join(run.runDir, "final-state.json")));
      assert.equal(finalState.result.sha256, sha256(bytes));
    });
  }

  if (has("a")) {
    await report.check("B13 (a): the ledger run that ends without a reviewer is captured after the run (F5)", () => {
      const builder = ran("a").run.captures.find((entry) => entry.role === "builder");
      assert.equal(builder?.via, "after_run");
      assert(builder.finalState !== null, "the after-run capture has no final state");
    });
  }

  if (has("q")) {
    await report.check("C23: a run stopped at max_turns keeps its result and its record", async () => {
      const q = fixture("q");
      const turns = script(...q.script.turns, ...Array.from({ length: 30 }, () => turn([call("ls", { path: "." })])));
      const result = await offline(q, turns);
      if (result instanceof Error) throw result;
      assert.equal(result.score.attrition.stoppedBy, "max_turns");
      assert.equal(await readFile(path.join(result.run.runDir, "result.raw"), "utf8"), q.resultBytes);
      assert.equal(at(result.score, "result.state"), "valid");
    });
  }

  if (has("o") && has("g")) {
    await report.check("item 7: (o) is contaminated and excluded, (g) is clean, on the real child paths", () => {
      const o = ran("o");
      assert.equal(contaminationVerdict(o.score, o.run.final.child), "contaminated");
      assert.equal(o.score.exclusion.excluded, true);
      assert.equal(o.run.final.outcome.status, "excluded");
      const g = ran("g");
      assert.equal(contaminationVerdict(g.score, g.run.final.child), "clean");
    });
  }

  await report.check("B12: every hold run has no protocol error, and every hold an integer creditMs", () => {
    const holding = HOLD_FIXTURES.filter(has);
    for (const id of holding) {
      const pair = pairOf(ran(id).run);
      assert(pair !== null, `(${id}) has no pair record`);
      assert.deepEqual(pair.protocolErrors, [], `(${id}) protocol errors`);
      assert(pair.holds.length > 0, `(${id}) has no hold`);
      for (const hold of pair.holds) {
        assert(Number.isInteger(hold.creditMs), `(${id}) hold ${hold.holdId} creditMs ${String(hold.creditMs)}`);
      }
    }
  });

  await report.check("C7: each run counts every scripted call once as served-unknown", () => {
    for (const { run, score } of scored.values()) {
      assert.equal(score.attrition.servedUnknown, run.final.served.length, run.experiment.cell);
      assert(run.final.served.length > 0, `${run.experiment.cell} recorded no call`);
    }
  });

  await report.check(`E3/E6 runs use at most ${REGULAR_BATCH_CAP} regular batches`, () => {
    for (const { run } of scored.values()) {
      if (run.experiment.scenario !== "crm-import") continue;
      const pair = pairOf(run);
      assert(pair !== null, `${run.experiment.cell} has no pair record`);
      console.log(`      ${run.experiment.cell}: ${pair.feed.regular} regular batch(es) of ${REGULAR_BATCH_CAP}`);
      assert(pair.feed.regular <= REGULAR_BATCH_CAP, `${run.experiment.cell}: ${pair.feed.regular} regular batches`);
    }
  });
}
