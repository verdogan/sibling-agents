import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_FINDINGS_GATE,
  FINDINGS_FILE,
  FindingsError,
  RECORD_FINDING_TOOL_NAME,
  VERIFICATION_FILE,
  VERIFY_FINDING_TOOL_NAME,
  MAX_CLOCK_SKEW_MS,
  MIN_VERIFIABLE_EXCERPT_CHARS,
  judgeFindings,
  normalizeForMatch,
  parseFindingsDocument,
  parseVerificationDocument,
  scoreFindings,
  selectVerificationSample,
  type Finding,
  type FindingVerification,
} from "../campaign/findings.js";

let failures = 0;

async function check(label: string, run: () => void | Promise<void>): Promise<void> {
  try {
    await run();
    console.log(`PASS  ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${label} -- ${error instanceof Error ? error.message : String(error)}`);
  }
}

const RETRIEVED_AT = "2026-09-01T10:00:00.000Z";
const CHECKED_AT = "2026-09-02T10:00:00.000Z";

function finding(overrides: Partial<Finding> & { id: string }): Finding {
  return {
    claim: "A buyer enquiry names Antalya as the target city.",
    confidence: "asserted",
    fields: { city: "Antalya" },
    ...overrides,
    source: {
      kind: "url",
      locator: "https://example.invalid/thread/1",
      retrievedAt: RETRIEVED_AT,
      excerpt: "looking to buy a two bedroom flat in Antalya this autumn",
      ...overrides.source,
    },
  };
}

function observation(
  overrides: Partial<FindingVerification> & { findingId: string },
): FindingVerification {
  return {
    locatorFetched: true,
    checkedAt: CHECKED_AT,
    evidence: "fetched and read the page",
    ...overrides,
  };
}

function findingsDoc(findings: readonly Finding[]): unknown {
  return JSON.parse(JSON.stringify({ findings }));
}

function assertRejected(label: string, value: unknown, parse: (input: unknown) => unknown): void {
  assert.throws(() => parse(value), FindingsError, `${label} should have been rejected`);
}

// --- parsing ------------------------------------------------------------------

await check("parses a well-formed findings document", () => {
  const parsed = parseFindingsDocument(
    findingsDoc([finding({ id: "lead-1" }), finding({ id: "lead-2", confidence: "inferred" })]),
  );
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]?.id, "lead-1");
  assert.equal(parsed[1]?.confidence, "inferred");
  assert.equal(parsed[0]?.fields["city"], "Antalya");
});

await check("rejects an unknown field rather than ignoring it", () => {
  const doc = findingsDoc([finding({ id: "lead-1" })]) as {
    findings: Record<string, unknown>[];
  };
  doc.findings[0]!["verified"] = true;
  assertRejected("extra field", doc, parseFindingsDocument);
});

await check("rejects two findings sharing one id", () => {
  assertRejected(
    "duplicate id",
    findingsDoc([finding({ id: "lead-1" }), finding({ id: "lead-1" })]),
    parseFindingsDocument,
  );
});

await check("rejects a missing or empty excerpt", () => {
  for (const excerpt of [undefined, "", "   "]) {
    const doc = findingsDoc([finding({ id: "lead-1" })]) as {
      findings: { source: Record<string, unknown> }[];
    };
    if (excerpt === undefined) delete doc.findings[0]!.source["excerpt"];
    else doc.findings[0]!.source["excerpt"] = excerpt;
    assertRejected(`excerpt ${JSON.stringify(excerpt)}`, doc, parseFindingsDocument);
  }
});

await check("rejects a non-timestamp retrievedAt and a non-string field value", () => {
  const bad = findingsDoc([finding({ id: "lead-1" })]) as {
    findings: { source: Record<string, unknown>; fields: Record<string, unknown> }[];
  };
  bad.findings[0]!.source["retrievedAt"] = "last tuesday";
  assertRejected("prose timestamp", bad, parseFindingsDocument);

  const alsoBad = findingsDoc([finding({ id: "lead-1" })]) as {
    findings: { fields: Record<string, unknown> }[];
  };
  alsoBad.findings[0]!.fields["budget"] = 250000;
  assertRejected("numeric field value", alsoBad, parseFindingsDocument);
});

await check("rejects an unknown source kind and an unknown confidence", () => {
  const kind = findingsDoc([finding({ id: "lead-1" })]) as {
    findings: { source: Record<string, unknown> }[];
  };
  kind.findings[0]!.source["kind"] = "vibes";
  assertRejected("invented source kind", kind, parseFindingsDocument);

  const confidence = findingsDoc([finding({ id: "lead-1" })]) as {
    findings: Record<string, unknown>[];
  };
  confidence.findings[0]!["confidence"] = "certain";
  assertRejected("invented confidence", confidence, parseFindingsDocument);
});

await check("parses a verification report and rejects a duplicated observation", () => {
  const parsed = parseVerificationDocument({
    verifications: [observation({ findingId: "lead-1", observedText: "hello" })],
  });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.locatorFetched, true);

  assertRejected(
    "two observations of one finding",
    {
      verifications: [
        observation({ findingId: "lead-1", observedText: "yes" }),
        observation({ findingId: "lead-1", locatorFetched: false }),
      ],
    },
    parseVerificationDocument,
  );
});

await check("rejects a non-boolean locatorFetched", () => {
  assertRejected(
    "string locatorFetched",
    { verifications: [{ ...observation({ findingId: "lead-1" }), locatorFetched: "yes" }] },
    parseVerificationDocument,
  );
});

// --- matching -----------------------------------------------------------------

await check("normalization ignores case, whitespace runs, and Unicode form", () => {
  assert.equal(normalizeForMatch("  Two   Bedroom\nFlat "), "two bedroom flat");
  // NFKC folds the compatibility ligature, so a page rendering it differently
  // from the excerpt still matches.
  assert.equal(normalizeForMatch("ﬂat"), "flat");
});

await check("confirms an excerpt whose surrounding text was re-wrapped", () => {
  const findings = [finding({ id: "lead-1" })];
  const score = scoreFindings(findings, [
    observation({
      findingId: "lead-1",
      observedText:
        "Posted yesterday:  LOOKING TO BUY   a two\n bedroom FLAT in Antalya this autumn, cash ready.",
    }),
  ]);
  assert.equal(score.findings[0]?.outcome, "confirmed");
  assert.equal(score.survivalRate, 1);
  assert.equal(score.coverage, 1);
});

await check("refutes an excerpt absent from the observed text", () => {
  const score = scoreFindings(
    [finding({ id: "lead-1" })],
    [observation({ findingId: "lead-1", observedText: "This listing has been removed." })],
  );
  assert.equal(score.findings[0]?.outcome, "refuted");
  assert.equal(score.survivalRate, 0);
});

await check("refutes a verifier that fetched the page but reported no text", () => {
  // The "trust me, I checked" case. Without observed text there is nothing to
  // compare, so it cannot count as evidence.
  const score = scoreFindings(
    [finding({ id: "lead-1" })],
    [observation({ findingId: "lead-1" })],
  );
  assert.equal(score.findings[0]?.outcome, "refuted");
  assert.match(score.findings[0]?.detail ?? "", /no text to compare/);
});

await check("refutes an observation dated before the source was retrieved", () => {
  const tooEarly = new Date(Date.parse(RETRIEVED_AT) - MAX_CLOCK_SKEW_MS - 1_000).toISOString();
  const score = scoreFindings(
    [finding({ id: "lead-1" })],
    [
      observation({
        findingId: "lead-1",
        checkedAt: tooEarly,
        observedText: "looking to buy a two bedroom flat in Antalya this autumn",
      }),
    ],
  );
  assert.equal(score.findings[0]?.outcome, "refuted");

  const withinSkew = new Date(Date.parse(RETRIEVED_AT) - 60_000).toISOString();
  const tolerated = scoreFindings(
    [finding({ id: "lead-1" })],
    [
      observation({
        findingId: "lead-1",
        checkedAt: withinSkew,
        observedText: "looking to buy a two bedroom flat in Antalya this autumn",
      }),
    ],
  );
  assert.equal(tolerated.findings[0]?.outcome, "confirmed");
});

// --- scoring ------------------------------------------------------------------

await check("an unreachable locator is neither confirmed nor refuted", () => {
  // Link rot must not read as fabrication: a task that cited a page which later
  // went offline has not been caught lying, and counting it as a failure would
  // make the metric punish honest sourcing.
  const score = scoreFindings(
    [finding({ id: "lead-1" }), finding({ id: "lead-2" })],
    [
      observation({ findingId: "lead-1", locatorFetched: false, evidence: "HTTP 404" }),
      observation({
        findingId: "lead-2",
        observedText: "looking to buy a two bedroom flat in Antalya this autumn",
      }),
    ],
  );
  assert.equal(score.counts.unreachable, 1);
  assert.equal(score.counts.confirmed, 1);
  assert.equal(score.survivalRate, 1);
  assert.equal(score.coverage, 0.5);
});

await check("an excerpt too short to be distinctive cannot confirm anything", () => {
  const short = "the".padEnd(MIN_VERIFIABLE_EXCERPT_CHARS - 1, "!");
  const score = scoreFindings(
    [finding({ id: "lead-1", source: { excerpt: short } as Finding["source"] })],
    [observation({ findingId: "lead-1", observedText: `prefix ${short} suffix` })],
  );
  assert.equal(score.findings[0]?.outcome, "unverifiable");
  assert.equal(score.survivalRate, undefined);
});

await check("a source nobody can re-fetch is attested, never confirmed", () => {
  const score = scoreFindings(
    [
      finding({
        id: "call-1",
        source: {
          kind: "call",
          locator: "tel:+900000000000",
          retrievedAt: RETRIEVED_AT,
          excerpt: "he said he wants to see it on Saturday",
        },
      }),
    ],
    // Even a verifier claiming to have confirmed it cannot promote an attestation.
    [observation({ findingId: "call-1", observedText: "he said he wants to see it on Saturday" })],
  );
  assert.equal(score.findings[0]?.outcome, "attested");
  assert.equal(score.counts.confirmed, 0);
  assert.equal(score.survivalRate, undefined);
  assert.equal(score.recheckable, 0);
});

await check("a finding no verifier looked at is unchecked", () => {
  const score = scoreFindings([finding({ id: "lead-1" })], []);
  assert.equal(score.findings[0]?.outcome, "unchecked");
  assert.equal(score.survivalRate, undefined);
  assert.equal(score.coverage, 0);
});

await check("coverage exposes a survival rate computed from a token sample", () => {
  // One confirmation out of forty findings is a perfect survival rate and almost
  // no evidence. A verdict that reads survivalRate alone would be fooled here,
  // which is why coverage is returned beside it.
  const findings = Array.from({ length: 40 }, (_, index) => finding({ id: `lead-${index}` }));
  const score = scoreFindings(findings, [
    observation({
      findingId: "lead-0",
      observedText: "looking to buy a two bedroom flat in Antalya this autumn",
    }),
  ]);
  assert.equal(score.survivalRate, 1);
  assert.equal(score.coverage, 1 / 40);
  assert.equal(score.counts.unchecked, 39);
  assert.equal(score.total, 40);
});

await check("a half-fabricated set scores at half", () => {
  const findings = [
    finding({ id: "real-1" }),
    finding({ id: "real-2", source: { excerpt: "cash buyer, wants sea view" } as Finding["source"] }),
    finding({ id: "fake-1" }),
    finding({ id: "fake-2" }),
  ];
  const score = scoreFindings(findings, [
    observation({
      findingId: "real-1",
      observedText: "looking to buy a two bedroom flat in Antalya this autumn",
    }),
    observation({ findingId: "real-2", observedText: "Cash buyer, wants sea view." }),
    observation({ findingId: "fake-1", observedText: "Unrelated page about car rental." }),
    observation({ findingId: "fake-2", observedText: "404 not found" }),
  ]);
  assert.equal(score.survivalRate, 0.5);
  assert.equal(score.coverage, 1);
  assert.deepEqual(
    score.findings.filter((entry) => entry.outcome === "refuted").map((entry) => entry.id),
    ["fake-1", "fake-2"],
  );
});

await check("an observation of an unknown finding id is an error", () => {
  // The verifier and the producer disagree about what was researched; scoring
  // the intersection would quietly score the wrong set.
  assert.throws(
    () => scoreFindings([finding({ id: "lead-1" })], [observation({ findingId: "lead-9" })]),
    FindingsError,
  );
});

// --- cross-package contract ---------------------------------------------------

// The writer lives in the ling package and the scorer lives here. CI builds the
// two packages in isolation, each with only its own node_modules, so this side
// cannot import the writer or run it to produce a real document. What it can do
// is read the source and pin the contract, so a field or enum member added on
// one side alone fails loudly here instead of silently becoming unscorable.
const lingFindingsSource = fileURLToPath(
  new URL("../../../ling/src/features/findings.ts", import.meta.url),
);

await check("the ling tool and the overlord scorer agree on their enumerations", async () => {
  const source = await readFile(lingFindingsSource, "utf8");
  const literals = (name: string): string[] => {
    const match = new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const;`).exec(source);
    assert.ok(match, `could not find ${name} in ${lingFindingsSource}`);
    return [...match[1]!.matchAll(/"([^"]+)"/g)].map((entry) => entry[1]!);
  };
  assert.deepEqual(literals("sourceKinds"), ["url", "message", "call", "document"]);
  assert.deepEqual(literals("claimConfidences"), ["asserted", "inferred"]);
  assert.deepEqual(literals("recheckableSourceKinds"), ["url"]);

  // The overlord re-declares these two because the packages build in isolation,
  // and it uses them to go and fetch the file itself. A rename on the ling side
  // would silently turn that collection into "the task recorded nothing".
  const constant = (name: string): string => {
    const match = new RegExp(`export const ${name} = "([^"]+)";`).exec(source);
    assert.ok(match, `could not find ${name} in ${lingFindingsSource}`);
    return match[1]!;
  };
  assert.equal(constant("FINDINGS_FILE"), FINDINGS_FILE);
  assert.equal(constant("RECORD_FINDING_TOOL_NAME"), RECORD_FINDING_TOOL_NAME);
  assert.equal(constant("VERIFICATION_FILE"), VERIFICATION_FILE);
  assert.equal(constant("VERIFY_FINDING_TOOL_NAME"), VERIFY_FINDING_TOOL_NAME);
});

/**
 * The two halves of the contract live in one ling module, so a field-scanning
 * regex over the whole file would attribute one tool's parameters to the other.
 * Splitting on the feature boundary keeps each list honest, and a third tool in
 * that file breaks this deliberately rather than silently.
 */
async function writtenFields(feature: "verification" | "findings"): Promise<string[]> {
  const source = await readFile(lingFindingsSource, "utf8");
  const boundary = source.indexOf("export const findingsFeature");
  assert.ok(boundary > 0, "could not find the feature boundary in the ling source");
  const section = feature === "verification" ? source.slice(0, boundary) : source.slice(boundary);
  return [
    ...new Set(
      [...section.matchAll(/^\s{14}(\w+): Type\./gm)].map((entry) => entry[1]!).concat(
        // Added by execute() rather than declared in the schema.
        [...section.matchAll(/(\w+): new Date\(\)\.toISOString\(\)/g)].map((entry) => entry[1]!),
      ),
    ),
  ].sort();
}

await check("the parser accepts exactly the fields the ling tool writes", async () => {
  // Every field the writer emits has to round-trip. A field added to the tool
  // and not to the parser would make the whole document unparseable, losing the
  // honest findings alongside the new one.
  const written = await writtenFields("findings");
  assert.deepEqual(written, ["claim", "confidence", "fields", "id", "note", "recordedAt", "source"]);

  // Proves the pinned list is the one the parser really allows, rather than a
  // list that merely happens to sit next to it in this file.
  const doc = findingsDoc([finding({ id: "lead-1", note: "context" })]) as {
    findings: Record<string, unknown>[];
  };
  doc.findings[0]!["recordedAt"] = RETRIEVED_AT;
  assert.deepEqual(Object.keys(doc.findings[0]!).sort(), written);
  assert.equal(parseFindingsDocument(doc).length, 1);
});

await check("the parser accepts exactly the fields the ling verifier writes", async () => {
  const written = await writtenFields("verification");
  assert.deepEqual(written, [
    "checkedAt",
    "evidence",
    "findingId",
    "locatorFetched",
    "observedText",
  ]);

  const document = {
    verifications: [
      {
        findingId: "lead-1",
        locatorFetched: true,
        observedText: "looking to buy a two bedroom flat in Antalya this autumn",
        evidence: "Opened the thread and copied the first post.",
        checkedAt: RETRIEVED_AT,
      },
    ],
  };
  assert.deepEqual(Object.keys(document.verifications[0]!).sort(), written);
  assert.equal(parseVerificationDocument(document).length, 1);
});

// --- sampling -----------------------------------------------------------------

const POOL: Finding[] = Array.from({ length: 12 }, (_unused, index) =>
  finding({ id: `lead-${String(index + 1).padStart(2, "0")}` }),
);

const SEEDS = Array.from({ length: 50 }, (_unused, index) => `campaign:c1:slice:01:round:1:${index}`);

await check("the same seed always selects the same sample", () => {
  const first = selectVerificationSample(POOL, { seed: "seed-a" });
  const again = selectVerificationSample(POOL, { seed: "seed-a" });
  assert.deepEqual(first.ids, again.ids);
  assert.equal(first.candidates, 12);
});

await check("different seeds select different samples", () => {
  const distinct = new Set(
    SEEDS.map((seed) => selectVerificationSample(POOL, { seed }).ids.join(",")),
  );
  // A seed that changed nothing would leave one entry here, and the whole
  // unpredictability property would be decoration.
  assert.ok(distinct.size > 10, `only ${distinct.size} distinct samples across 50 seeds`);
});

await check("the sample is not just the findings recorded first", () => {
  // The failure this guards: a verifier that always checks the first three
  // findings teaches the fleet to fabricate the fourth.
  const head = ["lead-01", "lead-02", "lead-03"].join(",");
  const matches = SEEDS.filter(
    (seed) => selectVerificationSample(POOL, { seed }).ids.join(",") === head,
  );
  assert.ok(matches.length <= 2, `${matches.length} of 50 seeds sampled the first three`);
});

await check("no finding is structurally exempt from being checked", () => {
  // If some position were never drawn, a producer could learn to put its
  // inventions there, and every guarantee above it would be void.
  const seen = new Set<string>();
  for (const seed of SEEDS) {
    for (const id of selectVerificationSample(POOL, { seed }).ids) seen.add(id);
  }
  assert.deepEqual([...seen].sort(), POOL.map((entry) => entry.id).sort());
});

await check("recording order cannot steer the sample", () => {
  // Written order is the one input the producer fully controls, so the shuffle
  // must not depend on it.
  const forwards = selectVerificationSample(POOL, { seed: "seed-a" });
  const backwards = selectVerificationSample([...POOL].reverse(), { seed: "seed-a" });
  assert.deepEqual(forwards.ids, backwards.ids);
});

await check("the sample honours the fraction, the minimum, and the pool size", () => {
  assert.equal(selectVerificationSample(POOL, { seed: "s", fraction: 0.5 }).ids.length, 6);
  // Minimum wins when the fraction rounds down below it.
  assert.equal(selectVerificationSample(POOL, { seed: "s", fraction: 0.01 }).ids.length, 3);
  // And the pool wins when the minimum exceeds it.
  const small = POOL.slice(0, 2);
  const sample = selectVerificationSample(small, { seed: "s", minimum: 5 });
  assert.equal(sample.ids.length, 2);
  assert.equal(sample.candidates, 2);
});

await check("only findings whose outcome is not already decided are sampled", () => {
  const mixed = [
    finding({ id: "checkable-1" }),
    finding({ id: "checkable-2" }),
    // Nobody can re-fetch a phone call, and a four-character excerpt matches
    // any document. Spending a fetch on either buys nothing.
    finding({ id: "phoned", source: { kind: "call", locator: "+90...", retrievedAt: RETRIEVED_AT, excerpt: "he said yes, he is looking to buy" } }),
    finding({ id: "too-short", source: { kind: "url", locator: "https://example.invalid/x", retrievedAt: RETRIEVED_AT, excerpt: "flat" } }),
  ];
  const sample = selectVerificationSample(mixed, { seed: "s", minimum: 4 });
  assert.equal(sample.candidates, 2);
  assert.deepEqual(sample.ids, ["checkable-1", "checkable-2"]);
});

await check("the sampler rejects a seed or size it cannot honour", () => {
  assert.throws(() => selectVerificationSample(POOL, { seed: "  " }), FindingsError);
  assert.throws(() => selectVerificationSample(POOL, { seed: "s", fraction: 0 }), FindingsError);
  assert.throws(() => selectVerificationSample(POOL, { seed: "s", fraction: 1.5 }), FindingsError);
  assert.throws(() => selectVerificationSample(POOL, { seed: "s", minimum: 0 }), FindingsError);
  assert.throws(() => selectVerificationSample(POOL, { seed: "s", minimum: 1.5 }), FindingsError);
});

// --- the gate -----------------------------------------------------------------

function judgeWith(
  findings: readonly Finding[],
  verifications: readonly FindingVerification[],
  sampleIds: readonly string[],
  gate?: Parameters<typeof judgeFindings>[2],
): ReturnType<typeof judgeFindings> {
  const score = scoreFindings(findings, verifications);
  return judgeFindings(score, { ids: [...sampleIds], candidates: findings.length, seed: "s" }, gate);
}

const EXCERPT = "looking to buy a two bedroom flat in Antalya this autumn";

await check("a sample whose excerpts all survive passes", () => {
  const findings = [finding({ id: "a" }), finding({ id: "b" }), finding({ id: "c" })];
  const judgement = judgeWith(
    findings,
    ["a", "b"].map((id) => observation({ findingId: id, observedText: `... ${EXCERPT} ...` })),
    ["a", "b"],
  );
  assert.equal(judgement.outcome, "pass");
  assert.equal(judgement.survivalRate, 1);
  assert.deepEqual(judgement.refuted, []);
});

await check("a survival rate under the floor fails the slice", () => {
  const findings = [finding({ id: "a" }), finding({ id: "b" }), finding({ id: "c" })];
  const judgement = judgeWith(
    findings,
    [
      observation({ findingId: "a", observedText: `... ${EXCERPT} ...` }),
      observation({ findingId: "b", observedText: "an unrelated page about tractors" }),
      observation({ findingId: "c", observedText: "another unrelated page" }),
    ],
    ["a", "b", "c"],
  );
  assert.equal(judgement.outcome, "fail");
  assert.deepEqual(judgement.refuted, ["b", "c"]);
  // The gap text has to name the findings, or the builder cannot act on it.
  assert.match(judgement.reasons.join(" "), /33%.*floor.*b, c/s);
});

await check("a verifier that reported nothing is inconclusive, not a failure", () => {
  // Silence from the verifier says nothing about the producer, and scoring it as
  // fabrication would punish a builder for someone else's crash.
  const findings = [finding({ id: "a" }), finding({ id: "b" })];
  const judgement = judgeWith(findings, [], ["a", "b"]);
  assert.equal(judgement.outcome, "inconclusive");
  assert.deepEqual(judgement.skipped, ["a", "b"]);
  assert.equal(judgement.survivalRate, undefined);
  assert.match(judgement.reasons.join(" "), /reported nothing for 2 of 2/);
});

await check("a sample that is mostly link rot decides nothing", () => {
  const findings = [finding({ id: "a" }), finding({ id: "b" }), finding({ id: "c" })];
  const judgement = judgeWith(
    findings,
    [
      observation({ findingId: "a", observedText: `... ${EXCERPT} ...` }),
      observation({ findingId: "b", locatorFetched: false, evidence: "404" }),
      observation({ findingId: "c", locatorFetched: false, evidence: "connection reset" }),
    ],
    ["a", "b", "c"],
  );
  assert.equal(judgement.outcome, "inconclusive");
  assert.deepEqual(judgement.unreachable, ["b", "c"]);
  // Survival is still 100% of what was conclusive; the sample is simply too thin.
  assert.equal(judgement.survivalRate, 1);
});

await check("evidence of fabrication outranks a botched verification", () => {
  // Both rules trip. Re-verifying cannot raise a rate that has already fallen
  // through the floor on what was checked, so this must not come back as a
  // retryable inconclusive.
  const findings = ["a", "b", "c", "d"].map((id) => finding({ id }));
  const judgement = judgeWith(
    findings,
    [
      observation({ findingId: "a", observedText: `... ${EXCERPT} ...` }),
      observation({ findingId: "b", observedText: "an unrelated page about tractors" }),
    ],
    ["a", "b", "c", "d"],
  );
  assert.equal(judgement.outcome, "fail");
  assert.deepEqual(judgement.skipped, ["c", "d"]);
  assert.equal(judgement.reasons.length, 2);
});

await check("a set nobody can ever re-check fails instead of passing by default", () => {
  // The trivial bypass: report every finding as a phone call and no excerpt is
  // ever tested. An empty sample must not read as a clean sample.
  const findings = ["a", "b", "c"].map((id) =>
    finding({
      id,
      source: { kind: "call", locator: "+90 555 000 0000", retrievedAt: RETRIEVED_AT, excerpt: EXCERPT },
    }),
  );
  const judgement = judgeWith(findings, [], []);
  assert.equal(judgement.outcome, "fail");
  assert.equal(judgement.requested, 0);
  assert.match(judgement.reasons.join(" "), /nobody can re-fetch/);
  assert.match(judgement.reasons.join(" "), /nothing in this set could be checked/);
});

await check("excerpts too short to match are not a way through the gate", () => {
  const findings = ["a", "b"].map((id) =>
    finding({
      id,
      source: { kind: "url", locator: `https://example.invalid/${id}`, retrievedAt: RETRIEVED_AT, excerpt: "flat" },
    }),
  );
  const judgement = judgeWith(findings, [], []);
  assert.equal(judgement.outcome, "fail");
  assert.match(judgement.reasons.join(" "), /excerpt too short to match/);
});

await check("recording nothing is honest, so it is not gradeable", () => {
  // The tool prompt tells a task that finding nothing is a valid outcome. A gate
  // that failed an empty set would make that instruction a trap.
  const judgement = judgeWith([], [], []);
  assert.equal(judgement.outcome, "inapplicable");
  assert.deepEqual(judgement.reasons, ["no findings were recorded"]);
});

await check("a sampled id the scorer never saw is an error, not a skip", () => {
  const score = scoreFindings([finding({ id: "a" })], []);
  assert.throws(
    () => judgeFindings(score, { ids: ["a", "ghost"], candidates: 1, seed: "s" }),
    FindingsError,
  );
});

await check("the gate is tunable without touching the scorer", () => {
  const findings = [finding({ id: "a" }), finding({ id: "b" })];
  const verifications = [
    observation({ findingId: "a", observedText: `... ${EXCERPT} ...` }),
    observation({ findingId: "b", observedText: "an unrelated page about tractors" }),
  ];
  // 50% survival: under the default floor, over a lenient one.
  assert.equal(judgeWith(findings, verifications, ["a", "b"]).outcome, "fail");
  assert.equal(
    judgeWith(findings, verifications, ["a", "b"], {
      ...DEFAULT_FINDINGS_GATE,
      minSurvivalRate: 0.5,
    }).outcome,
    "pass",
  );
});

console.log(
  failures === 0 ? "\nall findings checks passed" : `\n${failures} findings check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
