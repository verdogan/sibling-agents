/**
 * The dry runs (W3-A plan §4.3; build plan §4.1 items 2 and 3): one run of
 * every arm, L1 prompted and L0h included, plus a second L1 unprompted run,
 * each fixture (q)'s plain A under the paid limits with no override. Each run's
 * records are checked (item 2), then what A was shown, from its scripted-model
 * trace and its final-state record (item 3): the neutral workspace, no batch,
 * run, cell, arm or variant id and no planted token in anything A reads, the
 * prompted sentence in L1 prompted only, the pinned texts, the tools declared
 * to A (protocol §1.2's arms table), and one prompt digest per arm,
 * recomputed from the trace's prompt and tools; a changed tool description
 * changes it. B5: L3's B is given the slice
 * verbatim. The digests are written to `prompt-digests.json` for W4-A's `plan`
 * and kept for the phases after this one.
 *
 * L1s and W-unprompted are drafts, so their runs are dry runs (`dryRun`),
 * which needs every role scripted (§3.1 C13); that is no limits override.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CampaignPairRecord } from "../../campaign/schema.js";
import { A_LIMITS, OFFLINE_PROVIDERS, dryRunCells, type ComposeInput } from "../../experiment/compose.js";
import {
  parseExperimentJson,
  parseFinalStateRecord,
  promptDigestKey,
  type ArmId,
  type FinalStateRecord,
} from "../../experiment/records.js";
import { ARM_DEFINITIONS } from "../../experiment/scenarios/arms.js";
import { RESULT_CONTRACT_SHA256, contextJson } from "../../experiment/scenarios/driver-files.js";
import { PLANTED_TOKENS, scenarioSeeds, sliceText } from "../../experiment/scenarios/index.js";
import { PROMPTED_SENTENCE } from "../../experiment/scenarios/ledger.js";
import { EVENT_COVERAGE_FILE, finalizeRun, type EventCoverage } from "../../experiment/run.js";
import { computeExclusion, loadRunRecords } from "../../experiment/score/index.js";
import type { LingTask } from "../../ling/types.js";
import {
  EXPERIMENT_FIELDS,
  assertWorkspace,
  attempt,
  builderIds,
  fixture,
  pinnedMaxTasks,
  pool,
  took,
} from "./regressions.js";
import {
  CHANNEL_LAST_SENTENCE,
  L0H_OPENING,
  WORKER_OPENING,
  conditionBlocks,
  exists,
  lingPromptDigest,
  lingTexts,
  offlineContext,
  offlineInstrument,
  offlineRun,
  protocolSources,
  reachSection,
  readJsonFile,
  readTraces,
  runOffline,
  wholeWord,
  type LingTexts,
  type OfflineRun,
  type PhaseContext,
  type TracedTool,
} from "./support.js";

const BATCH_ID = "e2e-dry-runs";
/** The cap on the regular batches of an E3 or E6 run (protocol §1.5). */
const REGULAR_BATCH_CAP = 56;
/** What the workspace path reads as in a prompt digest (ling `runner.ts` promptDigest). */
const WORKSPACE_PLACEHOLDER = "<workspace>";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * A row of protocol §1.2's arms table: A's opening, its reach section, its
 * oversight tools, tell_principal's description (L0h's has no overseer
 * clause) and its variant.
 */
interface Registered {
  opening: "worker" | "L0h";
  reach: "N" | "N0" | "L1s" | "C" | "C-";
  oversight: readonly string[];
  tellPrincipal: "full" | "unrecorded";
  variant: string | null;
}
const NOTE: Registered = { opening: "worker", reach: "N", oversight: ["tell_principal"], tellPrincipal: "full", variant: null };
const CHANNEL: Registered = {
  opening: "worker",
  reach: "C",
  oversight: ["ask_overseer", "tell_principal"],
  tellPrincipal: "full",
  variant: null,
};
/**
 * Protocol §1.2's arms table, written out by arm id, not read from
 * ARM_DEFINITIONS: those compose the run, so a run checked against them
 * would pass whatever they said.
 */
const REGISTERED: Partial<Record<ArmId, Registered>> = {
  L1: NOTE,
  L1s: { ...NOTE, reach: "L1s", variant: "salience_matched" },
  L0h: { opening: "L0h", reach: "N0", oversight: ["tell_principal"], tellPrincipal: "unrecorded", variant: "tools_unrecorded" },
  L2: CHANNEL,
  L3: CHANNEL,
  "R-control": CHANNEL,
  "R-intervened": CHANNEL,
  "W-control": CHANNEL,
  W: CHANNEL,
  "W-unprompted": { ...CHANNEL, reach: "C-", variant: "channel_unprompted" },
  "P-relay": CHANNEL,
  "P-direct": CHANNEL,
};
/** A's tools besides the oversight ones (protocol §1.1). */
const BASE_TOOLS = ["read", "write", "edit", "ls", "bash"];

interface DryRun {
  label: string;
  cell: ComposeInput["run"];
  /** 1, or 2 for the second L1 unprompted run. */
  rep: number;
  run: OfflineRun | Error;
}

/** What A was shown in one run, read back from its trace and its records. */
interface Shown {
  systemPrompt: string;
  /** The tools A's model calls declared, in their order. */
  tools: TracedTool[];
  task: LingTask;
  taskPrompt: string;
  instructions: string;
  context: string;
  finalState: FinalStateRecord;
}

/** The arm's run of the dry runs: L1 twice, unprompted and prompted, and a second L1 unprompted. */
function dryRunList(): { label: string; cell: ComposeInput["run"]; rep: number }[] {
  const cells = dryRunCells().map((cell) => ({ label: cell.cell, cell, rep: 1 }));
  const l1 = cells.find((entry) => entry.cell.arm === "L1" && !entry.cell.prompted);
  assert(l1 !== undefined, "no L1 unprompted dry run");
  return [...cells, { label: `${l1.cell.cell} (second run)`, cell: l1.cell, rep: 2 }];
}

function isE3OrE6(run: OfflineRun): boolean {
  return run.composed.arm.experiments.some((id) => id.startsWith("E3") || id.startsWith("E6"));
}

function pairOf(run: OfflineRun): CampaignPairRecord | null {
  return run.manifest.slices[0]?.attempts[0]?.watch ?? null;
}

/** Item 2: the records every dry run must leave, under the paid limits. */
async function assertRecords(run: OfflineRun, resultBytes: string): Promise<void> {
  const { runDir, manifest, experiment } = run;
  assert.equal(run.runError, null, `the driver threw: ${String(run.runError)}`);
  const builders = builderIds(manifest);
  assert.equal(builders.length, 1, `${builders.length} builder tasks`);
  assert.equal(manifest.maxRounds, 1);
  assert.equal(manifest.budget.maxTasks, pinnedMaxTasks(run));
  assert(manifest.tasks.length <= pinnedMaxTasks(run), `${manifest.tasks.length} tasks ran`);
  // The paid limits, with no override.
  assert.deepEqual(experiment.limits.a, A_LIMITS, "A's limits are not the paid ones");
  assert.equal(run.composed.settleGraceMs, undefined, "a settle grace override is present");
  const pair = pairOf(run);
  if (run.composed.arm.condition === "channel") {
    assert(pair !== null, "the channel run has no pair record");
    assert.equal(pair.outcome, null, `the pair did not start: ${String(pair.outcome)} ${String(pair.outcomeDetail)}`);
    assert.notEqual(pair.readyAt, null, "the pair was never ready");
    assert.equal(pair.coverage?.events ?? null, "complete", "the pair's events coverage");
  }
  if (pair !== null) assert.deepEqual(pair.protocolErrors, [], "protocol errors");
  const coverage = (await readJsonFile(path.join(runDir, EVENT_COVERAGE_FILE))) as EventCoverage[];
  assert(coverage.length > 0, "no event coverage was recorded");
  for (const entry of coverage) assert.equal(entry.complete, true, `${entry.side}: ${String(entry.reason)}`);
  const finalState = parseFinalStateRecord(await readJsonFile(path.join(runDir, "final-state.json")));
  assert.equal(finalState.result.present, true, "the record has no result");
  assert(await exists(path.join(runDir, "result.raw")), "no result.raw");
  assert.equal(finalState.result.content, resultBytes, "the raw result is not the bytes A wrote");
  assert.equal(finalState.result.sha256, sha256(resultBytes));
  const parsed = parseExperimentJson(await readJsonFile(path.join(runDir, "experiment.json")));
  for (const field of EXPERIMENT_FIELDS) assert(Object.hasOwn(parsed, field), `experiment.json has no ${field}`);
  assert.equal(parsed.child.runtimeRemoved, true, "a lease runtime directory was left");
  assert.match(parsed.promptDigest ?? "", /^[0-9a-f]{64}$/, "no prompt digest");
  if (isE3OrE6(run)) {
    assert(pair !== null, "no pair record");
    console.log(`      ${run.experiment.cell}: ${pair.feed.regular} regular batch(es) of the cap of ${REGULAR_BATCH_CAP}`);
    assert(pair.feed.regular <= REGULAR_BATCH_CAP, `${pair.feed.regular} regular batches`);
  }
}

/** A's system prompt, task prompt, instructions and campaign/context.json, from the run. */
async function readShown(run: OfflineRun): Promise<Shown> {
  const traces = await readTraces(run.traceDir, OFFLINE_PROVIDERS.builder);
  assert(traces.length > 0, "A's child left no trace");
  const prompts = [...new Set(traces.map((line) => line.systemPrompt))];
  assert.equal(prompts.length, 1, `A was sent ${prompts.length} different system prompts`);
  for (const line of traces) assert.equal(line.systemPromptSha256, sha256(line.systemPrompt));
  const toolSets = [...new Set(traces.map((line) => JSON.stringify(line.tools ?? null)))];
  assert.equal(toolSets.length, 1, `A's calls declared ${toolSets.length} different tool sets`);
  for (const line of traces) {
    assert(Array.isArray(line.tools), "a trace line has no tools");
    assert.equal(line.toolsSha256, sha256(JSON.stringify(line.tools)));
  }
  const task = (await readJsonFile(path.join(run.runDir, "builder-task.json"))) as LingTask;
  assert.equal(typeof task.prompt, "string", "builder-task.json has no prompt");
  const finalState = parseFinalStateRecord(await readJsonFile(path.join(run.runDir, "final-state.json")));
  const seed = finalState.seeds.find((entry) => entry.path === "campaign/context.json");
  assert(seed !== undefined && seed.content !== null, "the record has no campaign/context.json content");
  return {
    systemPrompt: prompts[0]!,
    tools: traces[0]!.tools,
    task,
    taskPrompt: task.prompt,
    instructions: task.options.instructions ?? "",
    context: seed.content,
    finalState,
  };
}

/** The ids and tokens A must never be shown (item 3), with how each is matched. */
function forbiddenStrings(run: OfflineRun): { name: string; test(text: string): boolean }[] {
  const { experiment } = run;
  const literal = (name: string, value: string) => ({ name, test: (text: string) => text.includes(value) });
  const word = (name: string, value: string) => {
    const pattern = wholeWord(value);
    return { name, test: (text: string) => pattern.test(text) };
  };
  const variants = new Set(["D1", "D2", "D3", "D4", experiment.variant]);
  return [
    literal(`batch id ${experiment.batchId}`, experiment.batchId),
    literal(`run id ${experiment.runId}`, experiment.runId),
    literal(`cell id ${JSON.stringify(experiment.cell)}`, experiment.cell),
    word(`arm id ${experiment.arm}`, experiment.arm),
    ...[...variants].map((variant) => word(`variant id ${variant}`, variant)),
    ...PLANTED_TOKENS.map(({ token }) => literal(`planted token ${token}`, token)),
  ];
}

/** The run's arm's row, and the opening and reach section it registers. */
function expectedTexts(run: OfflineRun, texts: LingTexts): { row: Registered; opening: string; reach: string } {
  const row = REGISTERED[run.experiment.arm];
  assert(row !== undefined, `arm ${run.experiment.arm} has no row in protocol §1.2's arms table`);
  const reach = {
    N: texts.noteOnly,
    N0: texts.noteOnlyUnrecorded,
    L1s: texts.salienceMatched,
    C: texts.channel,
    "C-": texts.channelUnprompted,
  }[row.reach];
  return { row, opening: row.opening === "L0h" ? L0H_OPENING : WORKER_OPENING, reach };
}

/** Every seed's registered sha256, by path: the scenario's, the slice and the F7 driver files. */
function registeredSeeds(run: OfflineRun): Record<string, string> {
  const { scenario, variant } = run.experiment;
  const seeds = Object.entries(scenarioSeeds(scenario, variant)).map(([file, text]) => [file, sha256(text)]);
  seeds.push(
    ["campaign/slice.md", sha256(sliceText(scenario, variant))],
    ["campaign/context.json", sha256(contextJson(run.composed.campaignId))],
    ["campaign/result-contract.json", RESULT_CONTRACT_SHA256],
  );
  return Object.fromEntries(seeds.sort(([a], [b]) => a!.localeCompare(b!)));
}

/**
 * `promptDigest` as ling documents it (`prompt-digest.ts`), written out again:
 * the sha256 of the JSON of the prompt and each declared tool's name,
 * description and schema, in the order sent, with the workspace path, as
 * written and with forward slashes, elided from every string.
 */
function neutralDigest(systemPrompt: string, tools: readonly TracedTool[], workspaceDir: string): string {
  const neutral = (text: string) => {
    let out = text;
    for (const form of new Set([workspaceDir, workspaceDir.replaceAll("\\", "/")])) {
      if (form !== "") out = out.replaceAll(form, WORKSPACE_PLACEHOLDER);
    }
    return out;
  };
  const declared = tools.map(({ name, description, parameters, constrainedSampling }) => ({
    name,
    description,
    parameters,
    ...(constrainedSampling === undefined ? {} : { constrainedSampling }),
  }));
  return sha256(
    JSON.stringify({ systemPrompt, tools: declared }, (_key, value: unknown) =>
      typeof value === "string" ? neutral(value) : value,
    ),
  );
}

/** Ling's own digest function (`lingPromptDigest`). */
type DigestOf = (systemPrompt: string, tools: readonly TracedTool[], workspaceDir: string) => string;

/**
 * The tools declared to A against the arm's row: exactly the base tools and
 * the row's oversight tools, so the channel tools only in a channel arm, each
 * with a description and an object schema, and tell_principal's description
 * the row's, L0h's without the overseer clause.
 */
function assertDeclaredTools(tools: readonly TracedTool[], row: Registered, texts: LingTexts): void {
  const registered = [...BASE_TOOLS, ...row.oversight].sort();
  const names = tools.map((tool) => tool.name);
  assert.deepEqual([...names].sort(), registered, "the tools declared to A are not the registered ones");
  for (const tool of tools) {
    assert(typeof tool.description === "string" && tool.description.trim() !== "", `${tool.name} has no description`);
    const schema = tool.parameters as { type?: unknown } | null;
    assert(schema !== null && typeof schema === "object" && schema.type === "object", `${tool.name} has no object schema`);
  }
  const note = tools.find((tool) => tool.name === "tell_principal");
  const expected = row.tellPrincipal === "unrecorded" ? texts.tellPrincipalUnrecorded : texts.tellPrincipal;
  assert.equal(note?.description, expected, "tell_principal's description is not the arm's");
}

/** Item 3 for one run. */
function assertShown(run: OfflineRun, shown: Shown, texts: LingTexts, lingDigest: DigestOf): void {
  const { finalState } = shown;
  assertWorkspace(run.experiment.child.workspaceDir, "workspaceDir");
  assertWorkspace(run.experiment.child.workspaceDirReal, "workspaceDirReal");
  const read: Record<string, string> = {
    "the system prompt": shown.systemPrompt,
    "the task prompt": shown.taskPrompt,
    instructions: shown.instructions,
    "campaign/context.json": shown.context,
    "the tool declarations": JSON.stringify(shown.tools),
    workspaceDir: run.experiment.child.workspaceDir,
    workspaceDirReal: run.experiment.child.workspaceDirReal,
  };
  const found: string[] = [];
  for (const forbidden of forbiddenStrings(run)) {
    for (const [where, text] of Object.entries(read)) {
      if (forbidden.test(text)) found.push(`${forbidden.name} in ${where}`);
    }
  }
  assert.deepEqual(found, [], "A was shown an id or a planted token");
  assert.equal(shown.context, contextJson(run.composed.campaignId), "campaign/context.json's bytes");
  const prompted = shown.systemPrompt.includes(PROMPTED_SENTENCE);
  assert.equal(prompted, run.experiment.prompted, `the prompted sentence is ${prompted ? "" : "not "}in the system prompt`);
  assert.equal(shown.instructions === "" ? false : shown.instructions.includes(PROMPTED_SENTENCE), run.experiment.prompted);
  const expected = expectedTexts(run, texts);
  assert(shown.systemPrompt.startsWith(`${expected.opening}\n\n`), "the opening is not the pinned one");
  assert.equal(reachSection(shown.systemPrompt), expected.reach, "the reach section is not the pinned one");
  // The tools and the variant A's task asked ling for, and the tools ling
  // declared to the model, as the trace has them.
  const tools = [...(shown.task.options.tools ?? [])].sort();
  assert.deepEqual(tools, [...BASE_TOOLS, ...expected.row.oversight].sort(), "A's tools are not the registered ones");
  assertDeclaredTools(shown.tools, expected.row, texts);
  assert.equal(shown.task.options.variant ?? null, expected.row.variant, "A's prompt variant");
  const seeded = Object.fromEntries(
    finalState.seeds.map((seed) => [seed.path, seed.seededSha256]).sort(([a], [b]) => a!.localeCompare(b!)),
  );
  assert.deepEqual(seeded, registeredSeeds(run), "the seeds' bytes are not the registered ones");
  const digest = neutralDigest(shown.systemPrompt, shown.tools, finalState.workspaceDir);
  assert.equal(lingDigest(shown.systemPrompt, shown.tools, finalState.workspaceDir), digest, "ling's digest is not the documented form's");
  assert.equal(finalState.promptDigest, digest, "the record's digest is not the traced prompt's and tools'");
  assert.equal(run.experiment.promptDigest, digest, "experiment.json's digest is not the traced prompt's");
}

/**
 * The pinned texts against protocol §1.2's blocks (§3.1 C15): the openings,
 * which ling does not export, and each paragraph ling renders. C− has no
 * block; it is C without the last sentence the protocol quotes.
 */
function assertProtocolTexts(protocol: string, texts: LingTexts): void {
  const blocks = conditionBlocks(protocol);
  assert(blocks.length > 0, "the protocol has no §1.2 blocks");
  const pinned: Record<string, string> = {
    "the worker opening": WORKER_OPENING,
    "the L0h opening": L0H_OPENING,
    "C, the channel paragraph (B6, at 120 s)": texts.channel,
    "N, the note-only paragraph": texts.noteOnly,
    "the L1s paragraph": texts.salienceMatched,
  };
  const missing = Object.entries(pinned)
    .filter(([, text]) => !blocks.includes(text))
    .map(([name]) => name);
  assert.deepEqual(missing, [], "pinned texts with no equal block in protocol §1.2");
  const flat = protocol.replace(/\r\n/g, "\n").replace(/\s+/g, " ");
  assert(flat.includes(`C without its last sentence, "${CHANNEL_LAST_SENTENCE}"`), "the protocol's C− sentence");
  assert(texts.channel.endsWith(` ${CHANNEL_LAST_SENTENCE}`), "C does not end in that sentence");
  assert.equal(texts.channelUnprompted, texts.channel.slice(0, -` ${CHANNEL_LAST_SENTENCE}`.length), "C−");
  // N0 (L0h) is N without its last sentence.
  assert.equal(
    texts.noteOnlyUnrecorded,
    texts.noteOnly.slice(0, texts.noteOnly.lastIndexOf(" An overseer watching this run")),
    "N0",
  );
  assert(
    flat.includes(`**The ${"`"}tell_principal${"`"} description**: "${texts.tellPrincipal}" L0h drops the last sentence.`),
    "tell_principal's description is not the protocol's",
  );
  assert.equal(
    texts.tellPrincipalUnrecorded,
    texts.tellPrincipal.slice(0, texts.tellPrincipal.lastIndexOf(" An overseer watching this run")),
    "L0h's tell_principal description",
  );
}

/** Every run that did not throw, each with what it was shown; a failed read is a failed check. */
async function shownOf(report: PhaseContext["report"], runs: readonly DryRun[], texts: LingTexts, lingDigest: DigestOf) {
  const shown = new Map<DryRun, Shown>();
  for (const entry of runs) {
    await report.check(`dry run ${entry.label}: what A was shown (item 3)`, async () => {
      if (entry.run instanceof Error) throw entry.run;
      const read = await readShown(entry.run);
      shown.set(entry, read);
      assertShown(entry.run, read, texts, lingDigest);
    });
  }
  return shown;
}

export async function dryRunsPhase(context: PhaseContext): Promise<void> {
  const { report } = context;
  const failuresBefore = report.failures;
  const ling = await context.ling();
  const root = path.join(context.scratch, "dry-runs");
  const q = fixture("q");
  const texts = await lingTexts();
  const lingDigest = await lingPromptDigest();
  const list = dryRunList();
  const results = await pool(
    context.concurrency,
    list.map((entry) => () =>
      attempt(() =>
        runOffline({
          ling,
          root,
          batchId: BATCH_ID,
          run: offlineRun(entry.cell.arm, entry.cell.variant, entry.rep, entry.cell.prompted),
          script: q.script,
          ...(ARM_DEFINITIONS[entry.cell.arm].draft ? { dryRun: true } : {}),
          context: null,
        }),
      ),
    ),
  );
  const runs: DryRun[] = list.map((entry, index) => ({ ...entry, run: results[index]! }));

  for (const entry of runs) {
    await report.check(`dry run ${entry.label}: the pair started, coverage complete, every record there (item 2)`, async () => {
      if (entry.run instanceof Error) throw entry.run;
      console.log(`      ${entry.label}: ${took(entry.run)}, ${entry.run.manifest.tasks.length} task(s), campaign ${entry.run.manifest.status}`);
      await assertRecords(entry.run, q.resultBytes!);
    });
  }
  const shown = await shownOf(report, runs, texts, lingDigest);

  // One digest per arm key, two runs of an arm agreeing (item 3, C14).
  const digests: Record<string, string> = {};
  await report.check("dry runs: every run of an arm has the same prompt digest, and L1 prompted's differs", () => {
    const byKey = new Map<string, Set<string>>();
    for (const entry of runs) {
      if (entry.run instanceof Error) throw new Error(`${entry.label} did not run`);
      const key = promptDigestKey(entry.run.experiment.arm, entry.run.experiment.prompted);
      const digest = entry.run.experiment.promptDigest;
      assert(digest !== null, `${entry.label} has no digest`);
      byKey.set(key, (byKey.get(key) ?? new Set()).add(digest));
    }
    const split = [...byKey].filter(([, set]) => set.size !== 1).map(([key]) => key);
    assert.deepEqual(split, [], "arms whose runs have different digests");
    for (const [key, set] of byKey) digests[key] = [...set][0]!;
    assert.equal(Object.keys(digests).length, dryRunCells().length, "one key per dry-run cell");
    assert.notEqual(digests[promptDigestKey("L1", true)], digests[promptDigestKey("L1", false)]);
  });
  context.promptDigests = digests;

  await report.check("dry runs: a changed tool description, a reorder or a missing tool changes the digest, and the run is instrument_drift", async () => {
    const pick = (arm: ArmId) => {
      const entry = runs.find((candidate) => candidate.cell.arm === arm && candidate.rep === 1 && !candidate.cell.prompted);
      const seen = entry === undefined ? undefined : shown.get(entry);
      assert(entry !== undefined && !(entry.run instanceof Error) && seen !== undefined, `no ${arm} dry run was read`);
      return { run: entry.run, seen };
    };
    const describe = (tools: readonly TracedTool[], name: string, description: string) =>
      tools.map((tool) => (tool.name === name ? { ...tool, description } : tool));
    const l1 = pick("L1");
    const l2 = pick("L2");
    const askOverseer = l2.seen.tools.find((tool) => tool.name === "ask_overseer");
    assert(askOverseer !== undefined, "L2 declared no ask_overseer");
    const cases: [string, { run: OfflineRun; seen: Shown }, TracedTool[]][] = [
      // L0h's description in L1: a drift that a digest of the prompt alone would pass.
      ["L1 with L0h's tell_principal description", l1, describe(l1.seen.tools, "tell_principal", texts.tellPrincipalUnrecorded)],
      ["L2 with one character more in ask_overseer's description", l2, describe(l2.seen.tools, "ask_overseer", `${askOverseer.description}.`)],
      ["L1 with its tools reversed", l1, [...l1.seen.tools].reverse()],
      ["L2 without ask_overseer", l2, l2.seen.tools.filter((tool) => tool.name !== "ask_overseer")],
    ];
    for (const [label, { run, seen }, tools] of cases) {
      const workspaceDir = seen.finalState.workspaceDir;
      const registered = digests[promptDigestKey(run.experiment.arm, run.experiment.prompted)];
      assert.equal(neutralDigest(seen.systemPrompt, seen.tools, workspaceDir), registered, `${label}: the unchanged digest`);
      const changed = lingDigest(seen.systemPrompt, tools, workspaceDir);
      assert.equal(changed, neutralDigest(seen.systemPrompt, tools, workspaceDir), `${label}: ling and the documented form disagree`);
      assert.notEqual(changed, registered, `${label}: the digest did not change`);
      const records = await loadRunRecords(run.runDir);
      const drifted = computeExclusion({ ...records, experiment: { ...records.experiment, promptDigest: changed } }, offlineContext(digests));
      assert(
        drifted.reasons.some((reason) => reason.reason === "instrument_drift"),
        `${label}: not instrument_drift: ${JSON.stringify(drifted.reasons)}`,
      );
    }
  });

  for (const entry of runs) {
    await report.check(`dry run ${entry.label}: included under the registered digests`, async () => {
      if (entry.run instanceof Error) throw entry.run;
      const exclusion = computeExclusion(await loadRunRecords(entry.run.runDir), offlineContext(digests));
      assert.deepEqual(exclusion.reasons.map((reason) => `${reason.reason} (${reason.detail})`), []);
      const final = await finalizeRun(entry.run.runDir, entry.run.experiment, offlineContext(digests));
      assert.equal(final.outcome.status, "included", String(final.outcome.reason));
    });
  }

  await report.check("B5: L3's B is given the slice verbatim and no planted token", async () => {
    const l3 = runs.find((entry) => entry.cell.arm === "L3")?.run;
    assert(l3 !== undefined, "no L3 dry run");
    if (l3 instanceof Error) throw l3;
    const watcher = (await readJsonFile(path.join(l3.runDir, "watcher-task.json"))) as LingTask;
    const slice = sliceText(l3.experiment.scenario, l3.experiment.variant).replace(/\n$/, "");
    assert(watcher.prompt.includes(slice), "B's task prompt lacks the slice");
    const planted = PLANTED_TOKENS.filter(({ token }) => watcher.prompt.includes(token)).map(({ token }) => token);
    assert.deepEqual(planted, [], "B's task prompt names a planted token");
  });

  const { sources, pending } = await protocolSources();
  if (pending) {
    report.pending("protocol rev 3 condition texts", "reports/experiment-protocol.md rev 3 is not committed");
  }
  for (const source of sources) {
    await report.check(`the pinned openings and paragraphs equal ${source.label}'s §1.2 texts`, () =>
      assertProtocolTexts(source.text, texts),
    );
  }

  await report.check("prompt-digests.json is written, keyed by promptDigestKey, only if every dry-run check passed", async () => {
    const file = context.digestsOut ?? path.join(context.scratch, "prompt-digests.json");
    const failed = report.failures - failuresBefore;
    if (failed > 0) {
      // A digest from a run that drifted must not be registered.
      await rm(file, { force: true });
      throw new Error(`${failed} dry-run check(s) failed, so no digests are written (${file} removed)`);
    }
    assert.equal(Object.keys(digests).length, dryRunCells().length, "the digests are incomplete");
    const { gitHead, clean } = await offlineInstrument();
    await mkdir(path.dirname(file), { recursive: true });
    const sorted = Object.fromEntries(Object.entries(digests).sort(([a], [b]) => a.localeCompare(b)));
    await writeFile(file, `${JSON.stringify({ gitHead, clean, digests: sorted }, null, 2)}\n`);
    console.log(`      prompt digests: ${file}${context.digestsOut === null ? " (in the scratch, removed at the end)" : ""}`);
  });
}
