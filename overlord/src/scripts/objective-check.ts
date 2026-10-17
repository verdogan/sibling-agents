import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  MAX_CHUNK_CRITERIA,
  MAX_CHUNK_STATEMENT_CHARS,
  MAX_OBJECTIVE_STATEMENT_CHARS,
  ObjectiveConcurrentModificationError,
  ObjectiveInvariantError,
  ObjectiveManifestStore,
  ObjectiveSchemaError,
  chunkAddress,
  charterAddress,
  initializeObjective,
  parseObjectiveManifest,
  type ObjectiveChunkInput,
  type ObjectiveManifest,
} from "../objective/index.js";
import { contentAddress } from "../text.js";

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

const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "objective-check-"));
let objectiveSeq = 0;

async function openObjective(): Promise<{
  store: ObjectiveManifestStore;
  manifest: ObjectiveManifest;
}> {
  objectiveSeq += 1;
  const store = new ObjectiveManifestStore(
    path.join(tmpRoot, `objective-${objectiveSeq}`, "objective.json"),
  );
  const manifest = await initializeObjective(store, {
    id: `objective-${objectiveSeq}`,
    charter: {
      statement: "Find potential buyers for the apartment.",
      budget: { maxTotalCostUsd: 250, maxTotalTokens: 4_000_000 },
      constraints: ["Contact nobody without the principal's confirmation."],
    },
  });
  return { store, manifest };
}

function chunk(overrides: Partial<ObjectiveChunkInput> = {}): ObjectiveChunkInput {
  return {
    campaignId: "campaign-one",
    statement: "Enumerate listing portals that accept foreign buyers.",
    criteria: ["command: npm run verify-portals"],
    verdict: "completed",
    startedAt: "2026-09-06T10:00:00.000Z",
    finishedAt: "2026-09-06T11:00:00.000Z",
    costUsd: 3.25,
    ...overrides,
  };
}

const reportId = contentAddress(["report", "objective is unreachable"]);

try {
  await check("a new objective holds its charter and no history", async () => {
    const { manifest } = await openObjective();
    assert.equal(manifest.version, 2);
    assert.equal(manifest.charter.revision, 1);
    assert.equal(manifest.charter.statement, "Find potential buyers for the apartment.");
    assert.equal(manifest.charter.budget.maxTotalCostUsd, 250);
    // Nobody chose limits, so the conservative default applies rather than nothing.
    assert.equal(manifest.charter.limits.maxCampaignsPerWindow, 4);
    assert.deepEqual(manifest.chunks, []);
    assert.deepEqual(manifest.assessments, []);
    assert.deepEqual(manifest.reforms, []);
    assert.equal(manifest.halt, null);
  });

  await check("an appended chunk gets a dense index and an address over its own terms", async () => {
    const { store, manifest } = await openObjective();
    const first = await store.appendChunk(manifest, chunk());
    const second = await store.appendChunk(first, chunk({ campaignId: "campaign-two" }));
    assert.deepEqual(
      second.chunks.map((entry) => entry.index),
      [1, 2],
    );
    assert.equal(
      second.chunks[0]?.chunkId,
      chunkAddress(
        "Enumerate listing portals that accept foreign buyers.",
        ["command: npm run verify-portals"],
      ),
    );
    // The same terms twice is the same address, which is what makes a repeat visible.
    assert.equal(second.chunks[0]?.chunkId, second.chunks[1]?.chunkId);
    assert.equal(second.updatedAt > first.updatedAt, true);
  });

  await check("weakening a chunk's criteria makes it a different chunk", () => {
    const statement = "Enumerate listing portals that accept foreign buyers.";
    const strict = chunkAddress(statement, ["command: npm run verify-portals"]);
    const weakened = chunkAddress(statement, ["file: portals.json exists"]);
    const fewer = chunkAddress(statement, []);
    assert.notEqual(strict, weakened);
    assert.notEqual(strict, fewer);
    // Without a separator between parts, one part's tail becomes the next part's head
    // and two different chunks share an address.
    assert.notEqual(chunkAddress("ab", ["c"]), chunkAddress("a", ["bc"]));
    // Whitespace and wrapping are not identity; the terms are.
    assert.equal(chunkAddress(`  ${statement}  `, [" command:  npm run verify-portals "]), strict);
  });

  await check("a recorded chunk cannot be rewritten or dropped", async () => {
    const { store, manifest } = await openObjective();
    const withChunk = await store.appendChunk(manifest, chunk({ verdict: "blocked" }));
    const edited = structuredClone(withChunk);
    edited.chunks[0]!.verdict = "completed";
    await assert.rejects(store.save(edited), ObjectiveInvariantError);
    const truncated = structuredClone(withChunk);
    truncated.chunks = [];
    // The message is asserted because a dropped entry and a rewritten one are
    // different mistakes, and a refusal that reports the wrong one sends whoever is
    // reading the log looking for an edit that never happened.
    await assert.rejects(store.save(truncated), (error: unknown) => {
      assert.ok(error instanceof ObjectiveInvariantError);
      assert.match(error.message, /may only be appended to/u);
      return true;
    });
    assert.equal((await store.load()).chunks[0]?.verdict, "blocked");
  });

  await check("a recorded assessment cannot be rewritten, dropped, or reordered", async () => {
    const { store, manifest } = await openObjective();
    const first = await store.appendAssessment(manifest, {
      at: "2026-09-06T10:00:00.000Z",
      estimate: 0.8,
      trigger: "cadence",
      basis: ["three portals answered"],
    });
    const second = await store.appendAssessment(first, {
      at: "2026-09-06T12:00:00.000Z",
      estimate: 0.2,
      trigger: "campaign_blocked",
      basis: ["every portal requires a local agent"],
    });
    const rewritten = structuredClone(second);
    rewritten.assessments[0]!.estimate = 0.21;
    await assert.rejects(store.save(rewritten), ObjectiveInvariantError);
    const shortened = structuredClone(second);
    shortened.assessments = [second.assessments[1]!];
    await assert.rejects(store.save(shortened), ObjectiveInvariantError);
    // Reordering is refused by the schema itself, so a hand-written file cannot
    // present a collapse as a slow decline.
    assert.throws(
      () =>
        parseObjectiveManifest({
          ...second,
          assessments: [second.assessments[1], second.assessments[0]],
        }),
      ObjectiveSchemaError,
    );
    assert.deepEqual(
      (await store.load()).assessments.map((entry) => entry.estimate),
      [0.8, 0.2],
    );
  });

  await check("the charter cannot drift through an ordinary write", async () => {
    const { store, manifest } = await openObjective();
    const narrowed = structuredClone(manifest);
    narrowed.charter.statement = "Find one buyer, eventually.";
    await assert.rejects(store.save(narrowed), ObjectiveInvariantError);
    const cheapened = structuredClone(manifest);
    cheapened.charter.budget.maxTotalCostUsd = 5;
    await assert.rejects(store.save(cheapened), ObjectiveInvariantError);
    const relaxed = structuredClone(manifest);
    relaxed.charter.constraints = [];
    await assert.rejects(store.save(relaxed), ObjectiveInvariantError);
    // Rewriting a constraint rather than removing one keeps the count identical, so
    // this is the case that needs the constraint *text* inside the charter address.
    const inverted = structuredClone(manifest);
    inverted.charter.constraints = ["Contact whoever looks promising."];
    await assert.rejects(store.save(inverted), ObjectiveInvariantError);
    await assert.rejects(
      store.update((draft) => {
        draft.charter.limits.maxCampaignsPerWindow = 500;
      }),
      ObjectiveInvariantError,
    );
    const current = await store.load();
    assert.equal(current.charter.statement, "Find potential buyers for the apartment.");
    assert.equal(current.charter.budget.maxTotalCostUsd, 250);
    assert.equal(current.charter.limits.maxCampaignsPerWindow, 4);
    assert.deepEqual(current.charter.constraints, [
      "Contact nobody without the principal's confirmation.",
    ]);
  });

  await check("halting holds an unsent report, and sending it is a separate act", async () => {
    const { store, manifest } = await openObjective();
    const halted = await store.recordHalt(manifest, {
      reportId,
      summary: "No portal will list without a local agent, and none will act for a remote seller.",
    });
    assert.equal(halted.halt?.delivery, "unsent");
    assert.equal(halted.halt?.awaitingReply, false);
    // A reply cannot be awaited for a report nobody sent.
    assert.throws(
      () =>
        parseObjectiveManifest({
          ...halted,
          halt: { ...halted.halt, awaitingReply: true },
        }),
      ObjectiveSchemaError,
    );
    const sent = await store.markReportSent(halted);
    assert.equal(sent.halt?.delivery, "sent");
    assert.equal(sent.halt?.awaitingReply, true);
  });

  await check("a halted objective records no further work", async () => {
    const { store, manifest } = await openObjective();
    const halted = await store.recordHalt(manifest, { reportId, summary: "Unreachable." });
    await assert.rejects(store.appendChunk(halted, chunk()), ObjectiveInvariantError);
    await assert.rejects(
      store.appendAssessment(halted, {
        at: "2026-09-06T13:00:00.000Z",
        estimate: 0.1,
        trigger: "cadence",
        basis: ["still nothing"],
      }),
      ObjectiveInvariantError,
    );
    const current = await store.load();
    assert.deepEqual(current.chunks, []);
    assert.deepEqual(current.assessments, []);
  });

  await check("a halt cannot be lifted or swapped by an ordinary write", async () => {
    // The earlier guard only refused appends while *both* the current and candidate halt
    // were present, so one ordinary `save` could clear the halt and append in the same
    // write — and `save` is public. Lifting a halt is `reformCharter`'s job, because that
    // is the path that demands the report id and records what changed.
    const { store, manifest } = await openObjective();
    const halted = await store.recordHalt(manifest, { reportId, summary: "Unreachable." });

    const lifted = structuredClone(halted);
    lifted.halt = null;
    await assert.rejects(store.save(lifted), ObjectiveInvariantError);

    const liftedAndWorking = structuredClone(halted);
    liftedAndWorking.halt = null;
    liftedAndWorking.chunks = [
      {
        ...chunk(),
        index: 1,
        chunkId: chunkAddress(chunk().statement, chunk().criteria),
      },
    ];
    await assert.rejects(store.save(liftedAndWorking), ObjectiveInvariantError);

    // Nor may the report be substituted while the principal is answering the first one.
    const swapped = structuredClone(halted);
    swapped.halt = {
      ...halted.halt!,
      reportId: contentAddress(["report", "a more flattering account"]),
      summary: "A different story.",
    };
    await assert.rejects(store.save(swapped), ObjectiveInvariantError);

    // Marking it sent still works, because that operation owns the halt.
    const sent = await store.markReportSent(halted);
    assert.equal(sent.halt?.delivery, "sent");
    const current = await store.load();
    assert.equal(current.halt?.reportId, reportId);
    assert.deepEqual(current.chunks, []);
  });

  await check("halting twice cannot discard the report the principal is answering", async () => {
    const { store, manifest } = await openObjective();
    const halted = await store.recordHalt(manifest, { reportId, summary: "Unreachable." });
    await assert.rejects(
      store.recordHalt(halted, {
        reportId: contentAddress(["report", "second thoughts"]),
        summary: "Unreachable, differently.",
      }),
      ObjectiveInvariantError,
    );
    assert.equal((await store.load()).halt?.reportId, reportId);
  });

  await check("a reply re-forms the objective, records what it replaced, and resumes it", async () => {
    const { store, manifest } = await openObjective();
    const priorAddress = charterAddress(manifest.charter);
    const halted = await store.recordHalt(manifest, { reportId, summary: "Unreachable." });
    const sent = await store.markReportSent(halted);
    const reformed = await store.reformCharter(
      sent,
      {
        statement: "Find buyers through local agents instead.",
        budget: { maxTotalCostUsd: 400, maxTotalTokens: null },
      },
      { reportId, note: "Principal authorized agent commissions." },
    );
    assert.equal(reformed.charter.revision, 2);
    assert.equal(reformed.charter.statement, "Find buyers through local agents instead.");
    assert.equal(reformed.charter.budget.maxTotalCostUsd, 400);
    // Limits and constraints carry over when the reply did not restate them.
    assert.equal(reformed.charter.limits.maxCampaignsPerWindow, 4);
    assert.deepEqual(reformed.charter.constraints, [
      "Contact nobody without the principal's confirmation.",
    ]);
    assert.equal(reformed.reforms.length, 1);
    assert.equal(reformed.reforms[0]?.priorCharterRevision, 1);
    assert.equal(reformed.reforms[0]?.priorCharterAddress, priorAddress);
    // Resumed: the halt is lifted and work is possible again.
    assert.equal(reformed.halt, null);
    const working = await store.appendChunk(reformed, chunk());
    assert.equal(working.chunks.length, 1);
  });

  await check("a reform needs a halt and the report it answers", async () => {
    const { store, manifest } = await openObjective();
    const widened = {
      statement: "Find buyers anywhere, at any price.",
      budget: { maxTotalCostUsd: 10_000, maxTotalTokens: null },
    };
    await assert.rejects(
      store.reformCharter(manifest, widened, { reportId, note: "No halt happened." }),
      ObjectiveInvariantError,
    );
    await assert.rejects(store.markReportSent(manifest), ObjectiveInvariantError);
    const halted = await store.recordHalt(manifest, { reportId, summary: "Unreachable." });
    await assert.rejects(
      store.reformCharter(halted, widened, {
        reportId: contentAddress(["report", "a different report"]),
        note: "Answering something else.",
      }),
      ObjectiveInvariantError,
    );
    assert.equal((await store.load()).charter.budget.maxTotalCostUsd, 250);
  });

  await check("a charter revision cannot exceed the reforms that produced it", async () => {
    const { manifest } = await openObjective();
    assert.throws(
      () =>
        parseObjectiveManifest({
          ...manifest,
          charter: { ...manifest.charter, revision: 4 },
        }),
      ObjectiveSchemaError,
    );
  });

  await check("every mutator refuses a caller holding stale state", async () => {
    const { store, manifest } = await openObjective();
    const fresh = await store.appendAssessment(manifest, {
      at: "2026-09-06T10:00:00.000Z",
      estimate: 0.5,
      trigger: "cadence",
      basis: ["opening estimate"],
    });
    assert.notEqual(fresh.updatedAt, manifest.updatedAt);
    await assert.rejects(store.appendChunk(manifest, chunk()), ObjectiveConcurrentModificationError);
    await assert.rejects(
      store.appendAssessment(manifest, {
        at: "2026-09-06T11:00:00.000Z",
        estimate: 0.4,
        trigger: "cadence",
        basis: ["stale"],
      }),
      ObjectiveConcurrentModificationError,
    );
    await assert.rejects(
      store.recordHalt(manifest, { reportId, summary: "Stale." }),
      ObjectiveConcurrentModificationError,
    );
    await assert.rejects(store.save(manifest), ObjectiveConcurrentModificationError);
  });

  await check("a chunk cannot claim an index or an address that is not its own", async () => {
    const { store, manifest } = await openObjective();
    const withChunk = await store.appendChunk(manifest, chunk());
    assert.throws(
      () =>
        parseObjectiveManifest({
          ...withChunk,
          chunks: [{ ...withChunk.chunks[0], index: 7 }],
        }),
      ObjectiveSchemaError,
    );
    assert.throws(
      () =>
        parseObjectiveManifest({
          ...withChunk,
          chunks: [
            {
              ...withChunk.chunks[0],
              statement: "Do something much easier instead.",
            },
          ],
        }),
      ObjectiveSchemaError,
    );
    // Reaching past the type to supply a forged address changes nothing: the store
    // derives both fields from the terms it is storing.
    const forged = await store.appendChunk(withChunk, {
      ...chunk({ campaignId: "campaign-three" }),
      index: 99,
      chunkId: contentAddress(["chunk", "something else"]),
    } as ObjectiveChunkInput);
    assert.equal(forged.chunks[1]?.index, 2);
    assert.equal(forged.chunks[1]?.chunkId, forged.chunks[0]?.chunkId);
  });

  await check("a goal cannot smuggle an invisible character into a prompt", async () => {
    const nul = String.fromCharCode(0);
    const bell = String.fromCharCode(7);
    objectiveSeq += 1;
    const store = new ObjectiveManifestStore(
      path.join(tmpRoot, `objective-${objectiveSeq}`, "objective.json"),
    );
    const manifest = await initializeObjective(store, {
      id: "objective-smuggle",
      charter: {
        statement: `Find${nul} buyers.${bell}`,
        budget: { maxTotalCostUsd: 10, maxTotalTokens: null },
      },
    });
    assert.equal(manifest.charter.statement, "Find buyers.");
    // And the same for a chunk's terms, so an address cannot be forged with a NUL.
    const withChunk = await store.appendChunk(manifest,
      chunk({ statement: `Enumerate${nul} portals.`, criteria: [`command:${bell} check`] }),
    );
    assert.equal(withChunk.chunks[0]?.statement, "Enumerate portals.");
    assert.equal(withChunk.chunks[0]?.criteria[0], "command: check");
    assert.equal(
      withChunk.chunks[0]?.chunkId,
      chunkAddress("Enumerate portals.", ["command: check"]),
    );
  });

  await check("a version 1 record is refused", () => {
    // Version 1 held only a product pointer, and the charter it never recorded cannot
    // be recovered from it, so it is refused rather than read as something it is not.
    assert.throws(
      () =>
        parseObjectiveManifest({
          version: 1,
          id: "objective-legacy",
          currentProductSnapshot: null,
          updatedAt: "2026-09-01T00:00:00.000Z",
        }),
      ObjectiveSchemaError,
    );
  });

  await check("the record survives a reopen with its history intact", async () => {
    const { store, manifest } = await openObjective();
    const withChunk = await store.appendChunk(manifest, chunk({ verdict: "capped" }));
    const assessed = await store.appendAssessment(withChunk, {
      at: "2026-09-06T12:00:00.000Z",
      estimate: 0.3,
      trigger: "survival_rate_fell",
      basis: ["one finding in nine survived"],
    });
    await store.recordHalt(assessed, { reportId, summary: "Not reachable with what remains." });
    const reopened = await new ObjectiveManifestStore(store.filename).load();
    assert.equal(reopened.chunks[0]?.verdict, "capped");
    assert.equal(reopened.assessments[0]?.trigger, "survival_rate_fell");
    assert.equal(reopened.halt?.delivery, "unsent");
    assert.equal(reopened.charter.revision, 1);
  });

  await check("criteria are a set, so reordering them is the same chunk", async () => {
    const statement = "Qualify the leads.";
    const forward = chunkAddress(statement, ["command: a", "command: b", "command: c"]);
    const shuffled = chunkAddress(statement, ["command: c", "command: a", "command: b"]);
    // Otherwise a model asked to try again defeats the repeat check by emitting the
    // same criteria in a different order.
    assert.equal(shuffled, forward);
    assert.notEqual(chunkAddress(statement, ["command: a", "command: b"]), forward);
    // And the stored order is still the order it was given, since only identity sorts.
    const { store, manifest } = await openObjective();
    const appended = await store.appendChunk(
      manifest,
      chunk({ criteria: ["command: c", "command: a"] }),
    );
    assert.deepEqual(appended.chunks[0]?.criteria, ["command: c", "command: a"]);
    assert.equal(appended.chunks[0]?.chunkId, chunkAddress(chunk().statement, ["command: a", "command: c"]));
  });

  await check("of many writers holding the same state, exactly one wins", async () => {
    const { store, manifest } = await openObjective();
    const writers = Array.from(
      { length: 8 },
      () => new ObjectiveManifestStore(store.filename),
    );
    const results = await Promise.allSettled(
      writers.map((writer, index) =>
        writer.appendChunk(manifest, chunk({ campaignId: `campaign-${index}` })),
      ),
    );
    const won = results.filter((result) => result.status === "fulfilled");
    assert.equal(won.length, 1);
    // The losers must fail for a stated reason. A silent success or an unexpected
    // error class would both mean the file is not actually single-writer.
    for (const result of results) {
      if (result.status === "rejected") {
        assert.ok(
          result.reason instanceof ObjectiveConcurrentModificationError,
          `unexpected rejection: ${String(result.reason)}`,
        );
      }
    }
    const after = await store.load();
    assert.equal(after.chunks.length, 1);
    assert.equal(after.chunks[0]?.index, 1);
  });

  await check("writers that retry on conflict lose nothing and duplicate nothing", async () => {
    const { store } = await openObjective();
    /** What each writer was told it had written, to compare against the file after. */
    const reported = new Map<string, number>();
    const append = async (campaignId: string): Promise<void> => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          const saved = await new ObjectiveManifestStore(store.filename).appendChunk(
            await store.load(),
            chunk({ campaignId }),
          );
          const mine = saved.chunks.filter((entry) => entry.campaignId === campaignId);
          assert.equal(mine.length, 1, `${campaignId} appears ${mine.length} times in its result`);
          reported.set(campaignId, mine[0]!.index);
          return;
        } catch (error) {
          if (!(error instanceof ObjectiveConcurrentModificationError)) throw error;
          await new Promise((resolve) => setTimeout(resolve, 2 + Math.random() * 8));
        }
      }
      throw new Error(`${campaignId} never won the lock`);
    };
    const ids = Array.from({ length: 12 }, (_, index) => `campaign-${index}`);
    await Promise.all(ids.map((id) => append(id)));
    const after = await store.load();
    // Every writer landed exactly once, and the history is dense: no lost append
    // hiding behind a gap, and no entry written twice by a retry that had already won.
    assert.equal(after.chunks.length, ids.length);
    assert.deepEqual(
      after.chunks.map((entry) => entry.index),
      ids.map((_, index) => index + 1),
    );
    assert.deepEqual(new Set(after.chunks.map((entry) => entry.campaignId)), new Set(ids));
    // The sharper property, and the one a broken lock violates while the file still
    // looks well-formed: nothing was told it had written something that is not there.
    // Two writers inside the critical section each write a whole document, so the
    // loser's append vanishes and only its own return value remembers it.
    assert.equal(reported.size, ids.length);
    for (const entry of after.chunks) {
      assert.equal(
        reported.get(entry.campaignId),
        entry.index,
        `${entry.campaignId} was told it wrote index ${String(reported.get(entry.campaignId))}`,
      );
    }
  });

  await check("a lock is honoured while its owner lives and recovered once it cannot", async () => {
    const { store, manifest } = await openObjective();
    const lockPath = `${store.filename}.write-lock`;
    const write = async (body: string, ageMs: number): Promise<void> => {
      await writeFile(lockPath, body, "utf8");
      const when = new Date(Date.now() - ageMs);
      await utimes(lockPath, when, when);
    };

    // A lock this process is holding must be respected, or two writers in one
    // overlord would interleave.
    await write(
      JSON.stringify({ pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString() }),
      0,
    );
    await assert.rejects(
      store.appendChunk(manifest, chunk()),
      ObjectiveConcurrentModificationError,
    );

    // An unreadable lock is not evidence of a live writer, but a recent one might be
    // mid-write, so age is the only safe signal and a fresh one still blocks.
    await write("not json at all", 0);
    await assert.rejects(
      store.appendChunk(manifest, chunk()),
      ObjectiveConcurrentModificationError,
    );

    // Aged past the recovery window, it is treated as abandoned. Without this a
    // crashed overlord locks its objective permanently.
    await write("not json at all", 10 * 60 * 1000);
    const appended = await store.appendChunk(manifest, chunk());
    assert.equal(appended.chunks.length, 1);
    await rm(lockPath, { force: true });
  });

  await check("a staging file left by a crashed writer is ignored", async () => {
    const { store, manifest } = await openObjective();
    const litter = path.join(
      path.dirname(store.filename),
      `.${path.basename(store.filename)}.99999.abandoned.tmp`,
    );
    await writeFile(litter, "{ half-written garbage", "utf8");
    const appended = await store.appendChunk(manifest, chunk());
    assert.equal(appended.chunks.length, 1);
    assert.equal((await store.load()).chunks.length, 1);
    await rm(litter, { force: true });
  });

  await check("caps admit the limit and refuse the value past it", async () => {
    const { store, manifest } = await openObjective();
    const atCap = await store.appendChunk(
      manifest,
      chunk({
        statement: "x".repeat(MAX_CHUNK_STATEMENT_CHARS),
        criteria: Array.from({ length: MAX_CHUNK_CRITERIA }, (_, index) => `command: check ${index}`),
      }),
    );
    assert.equal(atCap.chunks[0]?.statement.length, MAX_CHUNK_STATEMENT_CHARS);
    assert.equal(atCap.chunks[0]?.criteria.length, MAX_CHUNK_CRITERIA);
    await assert.rejects(
      store.appendChunk(atCap, chunk({ statement: "x".repeat(MAX_CHUNK_STATEMENT_CHARS + 1) })),
      ObjectiveSchemaError,
    );
    await assert.rejects(
      store.appendChunk(
        atCap,
        chunk({
          criteria: Array.from(
            { length: MAX_CHUNK_CRITERIA + 1 },
            (_, index) => `command: check ${index}`,
          ),
        }),
      ),
      ObjectiveSchemaError,
    );
    // The same boundary on the charter, which is set once and never editable after.
    objectiveSeq += 1;
    const overlong = new ObjectiveManifestStore(
      path.join(tmpRoot, `objective-${objectiveSeq}`, "objective.json"),
    );
    await assert.rejects(
      initializeObjective(overlong, {
        id: "objective-overlong",
        charter: {
          statement: "y".repeat(MAX_OBJECTIVE_STATEMENT_CHARS + 1),
          budget: { maxTotalCostUsd: 1, maxTotalTokens: null },
        },
      }),
      ObjectiveSchemaError,
    );
  });

  await check("numbers that are not numbers are refused at every edge", async () => {
    const { store, manifest } = await openObjective();
    const assessment = { at: "2026-09-06T10:00:00.000Z", trigger: "cadence" as const, basis: ["x"] };
    // The ends of the range are legal; a whisker outside is not.
    const zero = await store.appendAssessment(manifest, { ...assessment, estimate: 0 });
    const one = await store.appendAssessment(zero, { ...assessment, estimate: 1 });
    assert.deepEqual(one.assessments.map((entry) => entry.estimate), [0, 1]);
    for (const estimate of [-0.000001, 1.000001, Number.NaN, Number.POSITIVE_INFINITY]) {
      await assert.rejects(
        store.appendAssessment(one, { ...assessment, estimate }),
        ObjectiveSchemaError,
        `estimate ${String(estimate)} should be refused`,
      );
    }
    // A free chunk is legal; a negative or non-finite cost is not.
    const free = await store.appendChunk(one, chunk({ costUsd: 0 }));
    assert.equal(free.chunks[0]?.costUsd, 0);
    for (const costUsd of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await assert.rejects(
        store.appendChunk(free, chunk({ costUsd })),
        ObjectiveSchemaError,
        `costUsd ${String(costUsd)} should be refused`,
      );
    }
    // A budget of zero is not a budget, and a token ceiling of zero is not a ceiling.
    objectiveSeq += 1;
    const store2 = new ObjectiveManifestStore(
      path.join(tmpRoot, `objective-${objectiveSeq}`, "objective.json"),
    );
    await assert.rejects(
      initializeObjective(store2, {
        id: "objective-free",
        charter: { statement: "Do it for nothing.", budget: { maxTotalCostUsd: 0, maxTotalTokens: null } },
      }),
      ObjectiveSchemaError,
    );
    await assert.rejects(
      initializeObjective(store2, {
        id: "objective-free",
        charter: { statement: "Do it.", budget: { maxTotalCostUsd: 1, maxTotalTokens: 0 } },
      }),
      ObjectiveSchemaError,
    );
  });

  await check("field order is not mistaken for a rewrite", async () => {
    const { store, manifest } = await openObjective();
    const withChunk = await store.appendChunk(manifest, chunk());
    // A caller that rebuilds an entry with its keys in another order has changed
    // nothing. The append-only check compares encoded JSON, so this is the case that
    // would make it reject a legal write.
    const entry = withChunk.chunks[0]!;
    const reordered = JSON.parse(
      JSON.stringify({
        ...withChunk,
        chunks: [
          {
            costUsd: entry.costUsd,
            finishedAt: entry.finishedAt,
            verdict: entry.verdict,
            criteria: entry.criteria,
            statement: entry.statement,
            campaignId: entry.campaignId,
            chunkId: entry.chunkId,
            index: entry.index,
            startedAt: entry.startedAt,
          },
        ],
      }),
    ) as ObjectiveManifest;
    const saved = await store.save(reordered);
    assert.equal(saved.chunks.length, 1);
    assert.equal(saved.chunks[0]?.chunkId, entry.chunkId);
  });

  await check("a polluting key is an unknown field, not a prototype", async () => {
    const { store, manifest } = await openObjective();
    const withChunk = await store.appendChunk(manifest, chunk());
    const polluted = JSON.parse(
      `{"__proto__":{"polluted":true},"version":2,"id":"x","charter":${JSON.stringify(
        withChunk.charter,
      )},"currentProductSnapshot":null,"chunks":[],"assessments":[],"reforms":[],"halt":null,"updatedAt":"2026-09-06T10:00:00.000Z"}`,
    ) as unknown;
    assert.throws(() => parseObjectiveManifest(polluted), ObjectiveSchemaError);
    assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
  });

  await check("the compare-and-swap token always advances", async () => {
    const { store } = await openObjective();
    const seen: string[] = [];
    let current = await store.load();
    for (let index = 0; index < 30; index += 1) {
      current = await store.appendChunk(current, chunk({ campaignId: `campaign-${index}` }));
      seen.push(current.updatedAt);
    }
    // Two writes inside the same millisecond must still produce different tokens, or
    // a stale caller would pass the freshness check.
    assert.equal(new Set(seen).size, seen.length);
    for (let index = 1; index < seen.length; index += 1) {
      assert.ok(seen[index]! > seen[index - 1]!, "updatedAt must increase monotonically");
    }
  });
} finally {
  await rm(tmpRoot, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} objective check(s) failed`);
  process.exitCode = 1;
} else {
  console.log("\nall objective checks passed");
}
