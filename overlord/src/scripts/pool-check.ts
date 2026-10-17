import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CampaignArtifactStore } from "../campaign/artifacts.js";
import { initializeCampaign } from "../campaign/initialize.js";
import { CampaignManifestStore } from "../campaign/manifest.js";
import {
  parseCampaignManifest,
  type CampaignManifest,
  type SliceAttempt,
} from "../campaign/schema.js";
import {
  KnowledgePool,
  MAX_CLAIM_CHARS,
  MAX_LOCATOR_CHARS,
  MAX_TOPIC_CHARS,
  POOL_VERSION,
  PoolSchemaError,
  factId,
} from "../pool/index.js";

const execFileAsync = promisify(execFile);

let failures = 0;

async function check(label: string, run: () => void | Promise<void>): Promise<void> {
  try {
    await run();
    console.log(`PASS  ${label}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${label} -- ${error instanceof Error ? error.message : String(error)}`);
  }
}

const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "pool-check-"));
let poolSeq = 0;
let manifestSeq = 0;

function openPool(options: ConstructorParameters<typeof KnowledgePool>[1] = {}): KnowledgePool {
  poolSeq += 1;
  return new KnowledgePool(path.join(tmpRoot, `pool-${poolSeq}`, "pool.db"), {
    // Redaction is on by default from the environment; tests that care about it
    // pass their own, and the rest should not depend on the developer's shell.
    redact: (content) => content,
    ...options,
  });
}

/**
 * A real manifest, built the way a campaign builds one and then advanced to the
 * state under test. Going through `parseCampaignManifest` matters: a fixture the
 * schema would reject proves nothing about what promotion will see in production.
 *
 * `status` defaults to `completed`, which the schema only accepts when every slice
 * is accepted and integration accepted, so those are assembled to match. Passing a
 * mid-flight status leaves integration as initialized — verdict null, no attempts —
 * which is what a campaign that has not yet been reviewed as a whole looks like.
 */
async function campaignManifest(
  id: string,
  slices: Array<{
    id: string;
    gate: SliceAttempt["findingsGate"];
    /** An earlier, refused attempt, which is where the attempt-level check bites. */
    priorGate?: SliceAttempt["findingsGate"];
    /** Defaults to accepted. `pending` means the slice has not been worked yet. */
    status?: "accepted" | "pending";
  }>,
  options: { status?: CampaignManifest["status"] } = {},
): Promise<CampaignManifest> {
  manifestSeq += 1;
  const root = path.join(tmpRoot, `campaign-${manifestSeq}`);
  const artifacts = new CampaignArtifactStore(root, path.join(root, "workspaces"));
  const manifest = await initializeCampaign(
    new CampaignManifestStore(path.join(root, "manifest.json")),
    artifacts,
    {
      id,
      goal: "Learn things.",
      acceptance: [{ id: "output", kind: "file", requirement: "output.txt exists" }],
      budget: { maxTasks: 4, maxTotalCostUsd: 5 },
      slices: slices.map((slice) => ({ id: slice.id, spec: `Research ${slice.id}.` })),
    },
  );
  const deliverables = await Promise.all(
    slices.map((slice, index) =>
      artifacts.storeText(`slices/${index + 1}`, "output.txt", `output for ${slice.id}`),
    ),
  );
  // A completed campaign must have every slice accepted and integration accepted;
  // the schema enforces both, so there is no such thing as a completed campaign
  // carrying a refused slice. The attempt-level condition is what does the work.
  const attemptFor = (
    round: number,
    verdict: "accept" | "revise",
    gate: SliceAttempt["findingsGate"],
    artifacts: SliceAttempt["artifacts"],
  ): SliceAttempt => ({
    round,
    // Null rather than an invented id: the schema requires every task id in an
    // attempt to appear in manifest.tasks, and this fixture has no tasks.
    builderId: null,
    reviewerId: null,
    artifacts,
    verdict,
    evidence: [],
    gaps: verdict === "accept" ? [] : ["not good enough"],
    costUsd: 0,
    findings: null,
    findingsSample: null,
    verification: null,
    findingsGate: gate,
  });
  const status = options.status ?? "completed";
  const advanced = {
    ...manifest,
    status,
    slices: manifest.slices.map((slice, index) => {
      const plan = slices[index]!;
      if ((plan.status ?? "accepted") === "pending") return slice;
      const prior =
        plan.priorGate === undefined ? [] : [attemptFor(1, "revise", plan.priorGate, [])];
      return {
        ...slice,
        status: "accepted",
        attempts: [
          ...prior,
          attemptFor(prior.length + 1, "accept", plan.gate, [deliverables[index]!]),
        ],
      };
    }),
    integration:
      status === "completed"
        ? {
            reviewerId: null,
            verdict: "accept",
            evidence: ["everything lines up"],
            gaps: [],
            attempts: [
              {
                round: 1,
                reviewerId: null,
                verdict: "accept",
                evidence: ["everything lines up"],
                gaps: [],
                affectedSliceIds: [],
                retriesScheduled: false,
                costUsd: 0,
              },
            ],
          }
        : manifest.integration,
  };
  return parseCampaignManifest(advanced);
}

const passingGate = { outcome: "pass" as const, reasons: ["ok"], survivalRate: 1 };

try {
  await check("a fact is content-addressed, so a second source corroborates it", () => {
    const pool = openPool();
    try {
      const first = pool.record({
        topic: "antalya",
        claim: "Foreign buyers post intent in Russian-language groups.",
        campaignId: "c1",
        sliceId: "01",
        locator: "https://example.invalid/a",
      });
      // Same claim, different wrapping and a different slice. One fact, two sources.
      const second = pool.record({
        topic: "antalya",
        claim: "Foreign buyers post intent\n  in Russian-language groups.",
        campaignId: "c1",
        sliceId: "02",
      });
      assert.equal(second.id, first.id);
      assert.equal(second.id, factId("antalya", "Foreign buyers post intent in Russian-language groups."));
      assert.equal(pool.count(), 1);
      assert.equal(second.sources.length, 2);
      assert.deepEqual(
        second.sources.map((source) => source.sliceId),
        ["01", "02"],
      );
      // Repetition from the same slice is not corroboration.
      pool.record({
        topic: "antalya",
        claim: "Foreign buyers post intent in Russian-language groups.",
        campaignId: "c1",
        sliceId: "02",
      });
      assert.equal(pool.get(first.id)?.sources.length, 2);
      // The same sentence about a different subject is a different fact.
      const other = pool.record({
        topic: "izmir",
        claim: "Foreign buyers post intent in Russian-language groups.",
        campaignId: "c1",
        sliceId: "01",
      });
      assert.notEqual(other.id, first.id);
      assert.equal(pool.count(), 2);
    } finally {
      pool.close();
    }
  });

  await check("everything enters as claimed and nothing can assert otherwise", () => {
    const pool = openPool();
    try {
      const fact = pool.record({ topic: "t", claim: "A thing is so.", campaignId: "c1", sliceId: "01" });
      assert.equal(fact.provenance, "claimed");
      assert.equal(fact.verifiedAt, null);
      // The write API has no provenance field, so a caller supplying one is
      // ignored rather than obeyed. This is the property the store exists for.
      const forged = pool.record({
        topic: "t",
        claim: "Another thing is so.",
        campaignId: "c1",
        sliceId: "01",
        ...({ provenance: "verified", verifiedAt: "2026-01-01T00:00:00.000Z" } as object),
      });
      assert.equal(forged.provenance, "claimed");
      assert.equal(forged.verifiedAt, null);
      assert.equal(pool.count("verified"), 0);
    } finally {
      pool.close();
    }
  });

  await check("only a passing evidence gate promotes a fact", async () => {
    const pool = openPool();
    try {
      const gates = {
        pass: passingGate,
        fail: { outcome: "fail" as const, reasons: ["refuted"], survivalRate: 0 },
        inconclusive: { outcome: "inconclusive" as const, reasons: ["silent"], survivalRate: null },
        inapplicable: { outcome: "inapplicable" as const, reasons: ["none"], survivalRate: null },
        absent: null,
      };
      for (const [name] of Object.entries(gates)) {
        pool.record({ topic: "t", claim: `Claim from ${name}.`, campaignId: "c1", sliceId: name });
      }
      const manifest = await campaignManifest(
        "c1",
        Object.entries(gates).map(([id, gate]) => ({ id, gate })),
      );
      const promoted = pool.promoteFromCampaign(manifest, new Date("2026-09-06T00:00:00.000Z"));
      assert.deepEqual(promoted, [factId("t", "Claim from pass.")]);
      assert.equal(pool.count("verified"), 1);
      assert.equal(
        pool.get(factId("t", "Claim from pass."))?.verifiedAt,
        "2026-09-06T00:00:00.000Z",
      );
      // inapplicable is the opt-out case: a campaign whose reviewer had no
      // verification tool must not mint verified facts by declining to check.
      assert.equal(pool.get(factId("t", "Claim from inapplicable."))?.provenance, "claimed");
      assert.equal(pool.get(factId("t", "Claim from fail."))?.provenance, "claimed");
    } finally {
      pool.close();
    }
  });

  await check("a campaign still running promotes nothing, however good its evidence", async () => {
    const pool = openPool();
    try {
      pool.record({ topic: "t", claim: "Early and solid.", campaignId: "c2", sliceId: "01" });
      // Slice 01 is accepted with a passing gate and slice 02 has not been started.
      // Every per-slice condition holds, so only the campaign's own status stands
      // between this and promotion — integration has not run and can still refuse
      // the work and send the slice back, at which point the fact was never earned.
      const running = await campaignManifest(
        "c2",
        [
          { id: "01", gate: passingGate },
          { id: "02", gate: passingGate, status: "pending" },
        ],
        { status: "running" },
      );
      assert.equal(running.slices[0]?.status, "accepted");
      assert.equal(running.slices[0]?.attempts.at(-1)?.findingsGate?.outcome, "pass");
      assert.deepEqual(pool.promoteFromCampaign(running), []);
      assert.equal(pool.count("verified"), 0);
    } finally {
      pool.close();
    }
  });

  await check("an abandoned campaign promotes nothing", async () => {
    const pool = openPool();
    try {
      pool.record({ topic: "t", claim: "Unfinished business.", campaignId: "c2b", sliceId: "01" });
      const finished = await campaignManifest("c2b", [{ id: "01", gate: passingGate }]);
      // Same manifest, wound back to a status that means the acceptance criteria
      // were never checked. Nothing about the evidence changed; the standing did.
      const blocked = parseCampaignManifest({
        ...finished,
        status: "blocked",
        slices: finished.slices.map((slice) => ({ ...slice, status: "blocked" })),
        integration: {
          ...finished.integration,
          verdict: "blocked",
          attempts: finished.integration.attempts.map((attempt) => ({
            ...attempt,
            verdict: "blocked",
          })),
        },
      });
      assert.deepEqual(pool.promoteFromCampaign(blocked), []);
      assert.equal(pool.count("verified"), 0);
      assert.equal(pool.promoteFromCampaign(finished).length, 1);
    } finally {
      pool.close();
    }
  });

  await check("a passing gate on a refused attempt does not promote the slice", async () => {
    const pool = openPool();
    try {
      pool.record({ topic: "t", claim: "Evidence held, work did not.", campaignId: "c3", sliceId: "01" });
      // Round 1 checked out evidentially and was still sent back; round 2 was
      // accepted without anything being re-checked. Neither attempt is both, so
      // the claim stays a claim — the two conditions are per attempt, not per slice.
      const manifest = await campaignManifest("c3", [
        {
          id: "01",
          priorGate: passingGate,
          gate: { outcome: "inapplicable", reasons: ["nothing re-checkable"], survivalRate: null },
        },
      ]);
      assert.deepEqual(pool.promoteFromCampaign(manifest), []);
      assert.equal(pool.count("verified"), 0);
    } finally {
      pool.close();
    }
  });

  await check("promotion is idempotent, so replaying it after a crash rewrites nothing", async () => {
    const pool = openPool();
    try {
      pool.record({ topic: "t", claim: "Settled.", campaignId: "c4", sliceId: "01" });
      const manifest = await campaignManifest("c4", [{ id: "01", gate: passingGate }]);
      const first = new Date("2026-09-01T00:00:00.000Z");
      assert.equal(pool.promoteFromCampaign(manifest, first).length, 1);
      assert.deepEqual(
        pool.promoteFromCampaign(manifest, new Date("2026-09-09T00:00:00.000Z")),
        [],
      );
      assert.equal(pool.get(factId("t", "Settled."))?.verifiedAt, first.toISOString());
      // And a later claim of an already-verified fact does not demote it.
      pool.record({ topic: "t", claim: "Settled.", campaignId: "c9", sliceId: "07" });
      assert.equal(pool.get(factId("t", "Settled."))?.provenance, "verified");
    } finally {
      pool.close();
    }
  });

  await check("a fact recorded without a slice can never be promoted", async () => {
    const pool = openPool();
    try {
      // The overlord's own inferences have no slice, so there is no gate they
      // could have passed. They stay claims for as long as they exist.
      pool.record({ topic: "t", claim: "I infer this myself.", campaignId: "c5", sliceId: null });
      const manifest = await campaignManifest("c5", [{ id: "01", gate: passingGate }]);
      assert.deepEqual(pool.promoteFromCampaign(manifest), []);
      assert.equal(pool.count("verified"), 0);
    } finally {
      pool.close();
    }
  });

  await check("secrets are redacted on the way in, not on the way out", () => {
    const pool = openPool({
      redact: (content) => content.replaceAll("sk-live-abcdef0123456789", "[REDACTED:API_KEY]"),
    });
    try {
      const fact = pool.record({
        topic: "creds",
        claim: "The portal key is sk-live-abcdef0123456789 for now.",
        campaignId: "c6",
        sliceId: "01",
        locator: "https://example.invalid/?key=sk-live-abcdef0123456789",
      });
      assert.equal(fact.claim.includes("sk-live"), false);
      assert.match(fact.claim, /\[REDACTED:API_KEY\]/);
      assert.equal(fact.sources[0]?.locator?.includes("sk-live"), false);
      // Reading it back off disk must not resurrect it: the bytes never landed.
      const reopened = new KnowledgePool(pool.dbPath, { redact: (content) => content });
      try {
        assert.equal(reopened.get(fact.id)?.claim.includes("sk-live"), false);
      } finally {
        reopened.close();
      }
    } finally {
      pool.close();
    }
  });

  await check("prompt selection is fenced, ordered, and inside its budget", () => {
    const pool = openPool();
    try {
      for (let index = 0; index < 6; index += 1) {
        pool.record({
          topic: index % 2 === 0 ? "antalya" : "izmir",
          claim: `Observation number ${index} about the market.`,
          campaignId: "c7",
          sliceId: String(index),
        });
      }
      const everything = pool.selectForPrompt();
      assert.match(everything.text, /^<<<LING-UNTRUSTED-[A-Za-z0-9_-]+:BEGIN>>>\n/);
      assert.match(everything.text, /\n<<<LING-UNTRUSTED-[A-Za-z0-9_-]+:END>>>$/);
      assert.equal(everything.included.length, 6);
      assert.equal(everything.omitted, 0);
      // Provenance is stated on every line, because a model reading a flat list
      // will not infer trust from position.
      for (const line of everything.text.split("\n").slice(1, -1)) {
        assert.match(line, /^\[claimed\]/);
      }
      const scoped = pool.selectForPrompt({ topics: ["izmir"] });
      assert.equal(scoped.included.length, 3);
      assert.equal(
        scoped.included.every((fact) => fact.topic === "izmir"),
        true,
      );
      // An empty topic list means "nothing matches", not "everything".
      assert.equal(pool.selectForPrompt({ topics: [] }).text, "");
      // The budget truncates and says how much it dropped rather than hiding it.
      const budgeted = pool.selectForPrompt({}, { maxChars: 120 });
      assert.ok(budgeted.included.length > 0, "budget dropped everything");
      assert.ok(budgeted.included.length < 6, "budget dropped nothing");
      assert.equal(budgeted.omitted, 6 - budgeted.included.length);
      const body = budgeted.text.split("\n").slice(1, -1).join("\n");
      assert.ok(body.length <= 120, `body was ${body.length} chars`);
      assert.equal(pool.selectForPrompt({}, { maxChars: 0 }).text, "");
    } finally {
      pool.close();
    }
  });

  await check("verified facts sort ahead of claims, so truncation keeps the best", async () => {
    const pool = openPool();
    try {
      pool.record({
        topic: "t",
        claim: "Old but checked.",
        campaignId: "c8",
        sliceId: "01",
        // Deliberately the oldest fact in the pool.
      }, new Date("2026-01-01T00:00:00.000Z"));
      pool.record({ topic: "t", claim: "New and unchecked.", campaignId: "c8", sliceId: "02" },
        new Date("2026-09-01T00:00:00.000Z"));
      const manifest = await campaignManifest("c8", [
        { id: "01", gate: passingGate },
        { id: "02", gate: { outcome: "inapplicable", reasons: [], survivalRate: null } },
      ]);
      pool.promoteFromCampaign(manifest);
      const ordered = pool.select();
      assert.deepEqual(
        ordered.map((fact) => fact.claim),
        ["Old but checked.", "New and unchecked."],
      );
      assert.deepEqual(
        pool.select({ minProvenance: "verified" }).map((fact) => fact.claim),
        ["Old but checked."],
      );
    } finally {
      pool.close();
    }
  });

  await check("pruning expires claims first and only then evicts verified facts", async () => {
    const pool = openPool({ claimedRetentionMs: 60_000, maxFacts: 2 });
    try {
      const old = new Date("2026-09-01T00:00:00.000Z");
      pool.record({ topic: "t", claim: "Stale hearsay.", campaignId: "c1", sliceId: "01" }, old);
      pool.record({ topic: "t", claim: "Checked and old.", campaignId: "c1", sliceId: "02" }, old);
      const manifest = await campaignManifest("c1", [
        { id: "01", gate: { outcome: "inapplicable", reasons: [], survivalRate: null } },
        { id: "02", gate: passingGate },
      ]);
      pool.promoteFromCampaign(manifest, old);
      const now = new Date(old.getTime() + 120_000);
      pool.record({ topic: "t", claim: "Fresh hearsay.", campaignId: "c1", sliceId: "03" }, now);
      assert.equal(pool.prune(now), 1);
      assert.deepEqual(
        pool.select().map((fact) => fact.claim).sort(),
        ["Checked and old.", "Fresh hearsay."],
      );
      // Sources go with the fact rather than lingering as orphans.
      assert.equal(pool.get(factId("t", "Stale hearsay.")), undefined);

      // Under the ceiling with nothing left to expire, the least trusted goes.
      pool.record({ topic: "t", claim: "Newest hearsay.", campaignId: "c1", sliceId: "04" }, now);
      assert.equal(pool.count(), 3);
      assert.equal(pool.prune(now), 1);
      assert.equal(pool.count(), 2);
      assert.equal(pool.count("verified"), 1);
      assert.equal(pool.get(factId("t", "Checked and old."))?.provenance, "verified");
    } finally {
      pool.close();
    }
  });

  await check("a fact cannot smuggle in a control character or forge an id", () => {
    const pool = openPool();
    try {
      // The id joins topic and claim with a NUL, so a claim allowed to contain one
      // could wear a different fact's identity. Both spellings must be one fact.
      const plain = pool.record({ topic: "t", claim: "Ordinary claim.", campaignId: "c1", sliceId: "01" });
      const smuggled = pool.record({
        topic: "t",
        claim: "Ordinary\u0000 claim.\u0007",
        campaignId: "c1",
        sliceId: "02",
      });
      assert.equal(smuggled.id, plain.id);
      assert.equal(smuggled.claim, "Ordinary claim.");
      assert.equal(pool.count(), 1);
      // And both collisions the separator exists to prevent stay prevented: a space
      // would merge the fields, and no separator at all would let one field's tail
      // become the next one's head.
      assert.notEqual(factId("a b", "c"), factId("a", "b c"));
      assert.notEqual(factId("ab", "c"), factId("a", "bc"));
      // A locator is an address, so a control character is refused rather than
      // rewritten into something that points elsewhere while looking correct.
      assert.throws(
        () =>
          pool.record({
            topic: "t",
            claim: "Fine.",
            campaignId: "c1",
            sliceId: "01",
            locator: "https://example.invalid/a\u0000evil",
          }),
        PoolSchemaError,
      );
      // Text that is nothing but control characters is blank, not a fact.
      assert.throws(
        () => pool.record({ topic: "t", claim: "\u0001\u0002", campaignId: "c1", sliceId: "01" }),
        PoolSchemaError,
      );
      assert.equal(pool.count(), 1);
    } finally {
      pool.close();
    }
  });

  await check("the store refuses text it cannot bound", () => {
    const pool = openPool();
    try {
      assert.throws(
        () => pool.record({ topic: "t", claim: "   ", campaignId: "c1", sliceId: "01" }),
        PoolSchemaError,
      );
      assert.throws(
        () =>
          pool.record({
            topic: "t",
            claim: "x".repeat(MAX_CLAIM_CHARS + 1),
            campaignId: "c1",
            sliceId: "01",
          }),
        PoolSchemaError,
      );
      // A provenance that is not one of the two is refused wherever it arrives, which
      // includes a row read back from a database someone edited by hand.
      assert.throws(
        () => pool.select({ minProvenance: "trustworthy" as never }),
        PoolSchemaError,
      );
      assert.throws(() => pool.count("probably" as never), PoolSchemaError);
      // Every bound on worker-supplied text, not just the claim: a topic is a key and
      // a locator is an address, and both arrive from the same untrusted place.
      assert.throws(
        () =>
          pool.record({
            topic: "t".repeat(MAX_TOPIC_CHARS + 1),
            claim: "Fine.",
            campaignId: "c1",
            sliceId: "01",
          }),
        PoolSchemaError,
      );
      assert.throws(
        () =>
          pool.record({
            topic: "t",
            claim: "Fine.",
            campaignId: "c1",
            sliceId: "01",
            locator: `https://example.invalid/${"a".repeat(MAX_LOCATOR_CHARS)}`,
          }),
        PoolSchemaError,
      );
      assert.throws(
        () =>
          pool.record({
            topic: "t",
            claim: "Fine.",
            campaignId: "c1",
            sliceId: "01",
            locator: "https://example.invalid/a\nhttps://example.invalid/b",
          }),
        PoolSchemaError,
      );
      assert.equal(pool.count(), 0);
    } finally {
      pool.close();
    }
  });

  await check("the pool survives being closed and reopened", () => {
    const pool = openPool();
    try {
      pool.record({ topic: "t", claim: "Durable.", campaignId: "c1", sliceId: "01" });
    } finally {
      pool.close();
    }
    const reopened = new KnowledgePool(pool.dbPath, { redact: (content) => content });
    try {
      assert.equal(reopened.count(), 1);
      assert.equal(reopened.get(factId("t", "Durable."))?.sources[0]?.campaignId, "c1");
    } finally {
      reopened.close();
    }
  });

  await check("a topic is a key, so case and Unicode form do not split it", () => {
    const pool = openPool();
    try {
      const claim = "Foreign buyers post intent in Russian-language groups.";
      const first = pool.record({ topic: "Antalya", claim, campaignId: "c1", sliceId: "01" });
      const second = pool.record({ topic: "  ANTALYA ", claim, campaignId: "c1", sliceId: "02" });
      assert.equal(second.id, first.id);
      assert.equal(pool.count(), 1);
      // Two sources, which only happens if the second write recognised the first.
      assert.equal(second.sources.length, 2);
      assert.equal(second.topic, "antalya");
      // An id computed from an unfolded topic still finds the row, so a caller
      // cannot compute one that misses what it just wrote.
      assert.equal(pool.get(factId("Antalya", claim))?.id, first.id);
      // And a query folds too, which is the half that decides whether knowledge is
      // reachable at all.
      assert.equal(pool.select({ topics: ["ANTALYA"] }).length, 1);
      assert.equal(pool.selectForPrompt({ topics: ["Antalya"] }).included.length, 1);
      // Composed and decomposed spellings render identically, so they are one key.
      const composed = String.fromCharCode(0x015e);
      const decomposed = `S${String.fromCharCode(0x0327)}`;
      assert.notEqual(composed, decomposed);
      const viaComposed = pool.record({
        topic: `${composed}isli`,
        claim: "Agents demand exclusivity.",
        campaignId: "c1",
        sliceId: "01",
      });
      const viaDecomposed = pool.record({
        topic: `${decomposed}isli`,
        claim: "Agents demand exclusivity.",
        campaignId: "c1",
        sliceId: "02",
      });
      assert.equal(viaDecomposed.id, viaComposed.id);
      assert.equal(pool.count(), 2);
    } finally {
      pool.close();
    }
  });

  await check("the pool reports its own vocabulary rather than making a caller guess", async () => {
    const pool = openPool();
    try {
      const manifest = await campaignManifest("c-topics", [{ id: "01", gate: passingGate }]);
      pool.record({ topic: "Antalya", claim: "One.", campaignId: "c-topics", sliceId: "01" });
      pool.record({ topic: "antalya", claim: "Two.", campaignId: "c1", sliceId: "01" });
      pool.record({ topic: "izmir", claim: "Three.", campaignId: "c1", sliceId: "01" });
      // One of the three is promoted, so the verified column is exercised rather than
      // merely present: a caller choosing a topic wants to know how much of what it
      // holds was actually checked.
      assert.equal(pool.promoteFromCampaign(manifest).length, 1);
      assert.deepEqual(pool.topics(), [
        { topic: "antalya", facts: 2, verified: 1 },
        { topic: "izmir", facts: 1, verified: 0 },
      ]);
    } finally {
      pool.close();
    }
  });

  await check("a pool written by another schema version is refused, not mixed", () => {
    const pool = openPool();
    const dbPath = pool.dbPath;
    try {
      pool.record({ topic: "t", claim: "Recorded under this version.", campaignId: "c1", sliceId: "01" });
    } finally {
      pool.close();
    }
    // Ids come from normalized text, so a file whose text was normalized by other
    // rules holds rows this build would silently duplicate.
    const raw = new Database(dbPath);
    raw.pragma("user_version = 1");
    raw.close();
    assert.throws(() => new KnowledgePool(dbPath, { redact: (content) => content }), PoolSchemaError);
    // An unversioned file with nothing in it is the one case that can be adopted,
    // because nothing in it can have been written under the old rules.
    const adoptable = openPool();
    const adoptablePath = adoptable.dbPath;
    adoptable.close();
    const stripped = new Database(adoptablePath);
    stripped.pragma("user_version = 0");
    stripped.close();
    const adopted = new KnowledgePool(adoptablePath, { redact: (content) => content });
    try {
      assert.equal(adopted.count(), 0);
    } finally {
      adopted.close();
    }
    // Adoption has to be recorded, or every later open re-decides it.
    const inspect = new Database(adoptablePath);
    assert.equal(Number(inspect.pragma("user_version", { simple: true })), POOL_VERSION);
    inspect.close();
  });

  await check("two processes writing one pool lose nothing and merge the shared claim", async () => {
    const dbPath = path.join(tmpRoot, "contended", "pool.db");
    const rounds = 40;
    const tsxCli = fileURLToPath(new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url));
    const child = fileURLToPath(new URL("./pool-record-child.ts", import.meta.url));
    const tags = ["writer-a", "writer-b"];
    const results = await Promise.all(
      tags.map((tag) =>
        execFileAsync(process.execPath, [tsxCli, child, dbPath, tag, String(rounds)]),
      ),
    );
    assert.deepEqual(
      results.map((result) => result.stdout.trim()).sort(),
      ["writer-a done", "writer-b done"],
    );
    const pool = new KnowledgePool(dbPath, { redact: (content) => content });
    try {
      // Every distinct claim from both writers, plus the one they share.
      assert.equal(pool.count(), rounds * tags.length + 1);
      const shared = pool.get(factId("contention", "a claim both writers make"));
      // Contended writes merged into one fact with one source per writer, rather than
      // two rows or forty sources: the primary key on (fact, campaign, slice) is what
      // stops a writer inflating its own corroboration by repeating itself.
      assert.equal(shared?.sources.length, tags.length);
      assert.deepEqual(shared?.sources.map((source) => source.sliceId).sort(), tags);
    } finally {
      pool.close();
    }
  });

  await check("the pool keeps its ordering and its bound at volume", async () => {
    const pool = openPool({ maxFacts: 500, claimedRetentionMs: 60_000 });
    try {
      const manifest = await campaignManifest("c-volume", [{ id: "01", gate: passingGate }]);
      const start = Date.now();
      // Old enough to be expired by the retention pass below.
      const stale = new Date(Date.now() - 10 * 60_000);
      for (let index = 0; index < 1_000; index += 1) {
        pool.record(
          { topic: `topic-${index % 20}`, claim: `stale claim ${index}`, campaignId: "c1", sliceId: "01" },
          stale,
        );
      }
      // Fresh claims, and a handful the campaign's evidence gate can promote.
      for (let index = 0; index < 500; index += 1) {
        pool.record({
          topic: `topic-${index % 20}`,
          claim: `fresh claim ${index}`,
          campaignId: "c1",
          sliceId: "01",
        });
      }
      for (let index = 0; index < 50; index += 1) {
        pool.record({
          topic: "checked",
          claim: `verified claim ${index}`,
          campaignId: "c-volume",
          sliceId: "01",
        });
      }
      assert.equal(pool.promoteFromCampaign(manifest).length, 50);
      assert.equal(pool.count(), 1_550);
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 20_000, `recording 1,550 facts took ${elapsed}ms`);

      // Expiry takes the stale claims first, then the ceiling takes the oldest
      // remaining claims — and the verified facts survive both, which is the ordering
      // the whole store is arranged around.
      assert.equal(pool.prune(), 1_050);
      assert.equal(pool.count(), 500);
      assert.equal(pool.count("verified"), 50);
      // What a prompt gets is the strongest facts first, inside its budget, and it
      // says how much it dropped rather than hiding the truncation.
      const selection = pool.selectForPrompt({}, { maxChars: 4_000 });
      assert.ok(selection.included.length > 0);
      assert.equal(selection.included.length + selection.omitted, 500);
      assert.equal(
        selection.included.slice(0, 50).every((fact) => fact.provenance === "verified"),
        true,
      );
      assert.ok(selection.text.length <= 4_000 + 200, "the fence should not blow the budget");
    } finally {
      pool.close();
    }
  });
} finally {
  await rm(tmpRoot, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} pool check(s) failed`);
  process.exitCode = 1;
} else {
  console.log("\nall pool checks passed");
}
