/**
 * The static phase (W3-A plan §1.2 item 5, and the composer's units): every
 * pilot cell's paid definition and every dry run's offline one pass
 * initializeCampaign, every refusal is made by its fixed text, and the
 * campaign id has its shape. No ling starts and nothing is spent.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { workerOversightTools, minBatchIntervalMs, watcherLimits } from "../../campaign/oversight.js";
import type { CampaignManifest, RoleProfile } from "../../campaign/schema.js";
import {
  A_LIMITS,
  COMPOSE_REFUSALS,
  MAX_TASKS,
  OFFLINE_MODELS,
  PILOT_MODELS,
  SCRIPTED_B_PLACEHOLDER,
  assertIntervalDecided,
  composeRun,
  dryRunCells,
  newCampaignId,
  pilotCells,
  type ComposeInput,
  type ComposeRefusal,
  type RunMode,
  type ComposedRun,
} from "../../experiment/compose.js";
import { CAMPAIGN_ID_PATTERN, RUN_ID_PATTERN, type ArmId } from "../../experiment/records.js";
import { ARM_DEFINITIONS, type ArmDefinition } from "../../experiment/scenarios/arms.js";
import { PLANTED_TOKENS, scenarioSeeds, sliceText } from "../../experiment/scenarios/index.js";
import { PROMPTED_SENTENCE } from "../../experiment/scenarios/ledger.js";
import { watcherScriptSha256 } from "../../experiment/watcher-scripts.js";
import { applySpawnPolicy, profileCapabilityViolation } from "../../policy.js";
import { campaignRequestKeyPrefix } from "../../campaign/request-key.js";
import {
  childPathsFrom,
  missingChildPaths,
  servedCalls,
  withCapture,
  type CapturedTask,
} from "../../experiment/capture.js";
import { SYNTHETIC_CONTEXT } from "../../experiment/fixtures/index.js";
import {
  MODEL_RESPONSE_EVENT,
  type BatchModel,
  type ExperimentJson,
  type ServedCall,
} from "../../experiment/records.js";
import { coverageReasons, EVENT_COVERAGE_FILE, resolvedModelCheck } from "../../experiment/run.js";
import { contamination, servedReading } from "../../experiment/score/exclusion.js";
import type { RunRecords } from "../../experiment/score/types.js";
import type { LocalStartedWorker } from "../../ling/local-provisioner.js";
import type { LingProvisioner, ProvisionedLingClient } from "../../ling/provisioner.js";
import type { LingEvent, LingHealth, LingResolvedModel } from "../../ling/types.js";
import {
  assertRefuses,
  cellDirectory,
  contaminationVerdict,
  initializeInto,
  offlineContext,
  type PhaseContext,
  type Report,
} from "./support.js";

const WORK_ROLES = ["planner", "builder", "reviewer", "integration"] as const;
const SCRIPTED = /^scripted(?:-[a-z0-9]+)*$/;

/** What every composed run holds, paid or offline. */
function assertShape(composed: ComposedRun, manifest: CampaignManifest, run: ComposeInput["run"]): void {
  const arm = ARM_DEFINITIONS[run.arm];
  for (const role of WORK_ROLES) {
    const profile: RoleProfile = manifest.roles[role];
    for (const key of ["provider", "model", "thinking"] as const) {
      assert.equal(typeof profile[key], "string", `${role} states no ${key}`);
    }
    for (const key of ["maxTurns", "maxWallClockMs", "maxCostUsd"] as const) {
      assert(Number.isFinite(profile[key]) && profile[key] > 0, `${role} states no ${key}`);
    }
    // The policy trims no role: a trim would change what A's prompt renders.
    const applied = applySpawnPolicy(
      {
        tools: profile.tools,
        max_cost_usd: profile.maxCostUsd,
        max_turns: profile.maxTurns,
        max_wall_clock_ms: profile.maxWallClockMs,
      },
      composed.policy,
    );
    assert.equal(applied.trimmed, false, `the policy trims ${role}`);
    assert.equal(
      profileCapabilityViolation({ provider: profile.provider, model: profile.model }, composed.policy),
      undefined,
      `the policy refuses ${role}`,
    );
    if (role !== "builder") assert.equal(profile.thinking, "off", `${role} thinks`);
  }
  const builder = manifest.roles.builder;
  assert.deepEqual(
    { maxTurns: builder.maxTurns, maxWallClockMs: builder.maxWallClockMs, maxCostUsd: builder.maxCostUsd },
    A_LIMITS,
  );
  assert.deepEqual(composed.limits.a, A_LIMITS);
  assert.equal(composed.settleGraceMs, undefined, "a limits override is present");
  assert.deepEqual(
    [...builder.tools].sort(),
    ["read", "write", "edit", "ls", "bash", ...workerOversightTools(arm.condition)].sort(),
  );
  assert.equal(builder.instructions, run.prompted ? PROMPTED_SENTENCE : undefined);
  assert.deepEqual(builder.files, scenarioSeeds(arm.scenario, run.variant));
  assert.equal(manifest.coordination.enabled, true);
  assert.equal(manifest.coordination.passiveMessaging, false);
  assert.equal(manifest.maxRounds, 1);
  assert.equal(composed.maxRounds, 1);
  const pinned = MAX_TASKS[arm.condition === "no_watcher" ? "no_watcher" : "channel"];
  assert.equal(manifest.budget.maxTasks, pinned);
  assert.equal(composed.maxTasks, pinned);
  assert.equal(composed.policy.maxTasksPerRun, pinned);
  assert.equal(manifest.budget.maxTotalCostUsd, run.capUsd);
  assert.equal(manifest.brain.enabled, false);
  assert.equal(manifest.slices.length, 1);
  // The spec is stored as an artifact, by its bytes' sha256.
  const sliceSha256 = createHash("sha256").update(sliceText(arm.scenario, run.variant), "utf8").digest("hex");
  assert.equal(manifest.slices[0]!.spec.sha256, sliceSha256);
  assert.match(composed.campaignId, CAMPAIGN_ID_PATTERN);
  assert.equal(manifest.id, composed.campaignId);

  const watch = manifest.coordination.watch;
  assert(watch !== undefined, "no watch config");
  assert.equal(watch.condition, arm.condition);
  assert.equal(watch.workerVariant, arm.workerVariant ?? undefined);
  if (arm.b === "none") {
    assert.equal(watch.watcher, null);
    assert.equal(watch.required, false);
    assert.equal(composed.limits.b, null);
    assert.deepEqual(composed.b, { kind: "none" });
    assert.deepEqual(composed.driverTimings, {});
  } else {
    assert.equal(watch.required, true);
    assert.deepEqual(composed.limits.b, watcherLimits(A_LIMITS.maxWallClockMs, watch.watcherMaxCostUsd));
    // B's derived turns and wall clock are within the policy, and so is its spend.
    const b = composed.limits.b!;
    assert(b.maxTurns <= composed.policy.maxTurnsPerTask, "the policy is below B's turns");
    assert(b.maxWallClockMs <= composed.policy.maxWallClockMsPerTask, "the policy is below B's wall clock");
    assert(b.maxCostUsd <= composed.policy.maxCostUsdPerTask, "the policy trims B's spend");
    assert.equal(
      profileCapabilityViolation(
        { provider: watch.watcher!.provider, model: watch.watcher!.model },
        composed.policy,
      ),
      undefined,
    );
    const interval = arm.scenario === "ledger" ? minBatchIntervalMs(A_LIMITS.maxWallClockMs) : 3_000;
    assert.deepEqual(composed.driverTimings, { minBatchIntervalMs: interval });
  }
  if (arm.b === "script") {
    assert.deepEqual(watch.watcher, { ...SCRIPTED_B_PLACEHOLDER });
    assert.equal(watch.watcherMaxCostUsd, 0.01);
    assert.equal(watch.watchFor, undefined, "a scripted B is told what to watch for");
    assert.deepEqual(composed.b, {
      kind: "script",
      script: arm.script,
      scriptSha256: watcherScriptSha256(arm.script!),
    });
  }
  if (arm.b === "model") {
    assert.equal(watch.watcherMaxCostUsd, 1.5);
    const text = watch.watchFor ?? "";
    assert(text.includes(sliceText(arm.scenario, run.variant).replace(/\n$/, "")), "watchFor lacks the slice");
    for (const { token } of PLANTED_TOKENS) assert(!text.includes(token), `watchFor names ${token}`);
    assert.equal(composed.b.kind, "model");
  }
}

function cellOf(cells: readonly ComposeInput["run"][], name: string): ComposeInput["run"] {
  const found = cells.find((run) => run.cell === name);
  assert(found !== undefined, `no cell ${name}`);
  return found;
}

export async function staticPhase({ report, scratch }: PhaseContext): Promise<void> {
  const root = path.join(scratch, "static");
  const pilot = pilotCells();
  const dry = dryRunCells();
  const check = report.check.bind(report);

  await check("pilot cells: every pilot arm's variants, L1 prompted on D2 and D3, opaque run ids", () => {
    const expected = Object.values(ARM_DEFINITIONS)
      .filter((arm) => arm.inPilot)
      .flatMap((arm) => arm.variants.map((variant) => `${arm.id} ${variant}`));
    assert.deepEqual(
      pilot.map((run) => run.cell),
      [...expected, "L1 D2 prompted", "L1 D3 prompted"],
    );
    assert(pilot.every((run) => RUN_ID_PATTERN.test(run.runId)));
    assert.equal(new Set(pilot.map((run) => run.runId)).size, pilot.length);
  });

  // Item 5: the paid shapes pass initialize offline; no ling starts.
  for (const run of pilot) {
    await check(`paid definition of ${run.cell} passes initializeCampaign`, async () => {
      const composed = composeRun({ run, mode: "paid", models: PILOT_MODELS });
      const { manifest } = await initializeInto(root, `paid-${cellDirectory(run.cell)}`, composed.definition);
      assertShape(composed, manifest, run);
      const builder = manifest.roles.builder;
      assert.deepEqual(
        { provider: builder.provider, model: builder.model, thinking: builder.thinking },
        PILOT_MODELS.a,
      );
      const watch = manifest.coordination.watch!;
      assert.equal(watch.dryRun, undefined);
      if (ARM_DEFINITIONS[run.arm].b === "model") assert.deepEqual(watch.watcher, PILOT_MODELS.b);
      assert.equal(composed.providers.builder, "openrouter");
    });
  }

  await check("dry-run cells: the 13 arms, L1 twice, on their first variants", () => {
    assert.deepEqual(
      dry.map((run) => run.cell),
      [
        "L1 D1",
        "L1 D2 prompted",
        "L1s D1",
        "L2 D1",
        "L3 D1",
        "R-control R",
        "R-intervened R",
        "W-control W",
        "W W",
        "W-unprompted W",
        "P-relay R",
        "P-direct P-direct",
        "L0h D1",
      ],
    );
  });

  for (const run of dry) {
    const arm = ARM_DEFINITIONS[run.arm];
    await check(`offline dry run of ${run.cell} passes initializeCampaign`, async () => {
      const composed = composeRun({ run, mode: "offline", models: OFFLINE_MODELS, dryRun: arm.draft });
      const { manifest } = await initializeInto(root, `dry-${cellDirectory(run.cell)}`, composed.definition);
      assertShape(composed, manifest, run);
      const watch = manifest.coordination.watch!;
      // A dry run exactly where the text is a draft; all of it scripted either way.
      assert.equal(watch.dryRun, run.arm === "L1s" || run.arm === "W-unprompted" ? true : undefined);
      for (const role of WORK_ROLES) {
        assert.match(manifest.roles[role].provider ?? "", SCRIPTED);
        assert.match(manifest.roles[role].model ?? "", SCRIPTED);
      }
      if (watch.watcher !== null) {
        assert.match(watch.watcher.provider, SCRIPTED);
        assert.match(watch.watcher.model, SCRIPTED);
      }
      if (arm.b === "model") assert.deepEqual(watch.watcher, OFFLINE_MODELS.b);
      assert.equal(manifest.roles.builder.thinking, "low");
    });
  }

  // The refusal matrix: one case per refusal, by its fixed text.
  const l1 = cellOf(pilot, "L1 D1");
  const l2 = cellOf(pilot, "L2 D1");
  const l3 = cellOf(pilot, "L3 D1");
  const paid = { mode: "paid", models: PILOT_MODELS } as const;
  const offline = { mode: "offline", models: OFFLINE_MODELS } as const;
  const undecidedL2 = {
    ...ARM_DEFINITIONS.L2,
    minBatchIntervalMs: { ms: ARM_DEFINITIONS.L2.minBatchIntervalMs!.ms, decided: false },
  };
  // Every interval is decided, so the predicate composeRun calls is tested on its own.
  const unsetL2 = { ...ARM_DEFINITIONS.L2, minBatchIntervalMs: { ms: 1 } } as unknown as ArmDefinition;
  const cases: [string, ComposeRefusal, () => unknown][] = [
    ["an unknown mode", "mode", () => composeRun({ ...paid, mode: "Offline" as RunMode, run: l1 })],
    ["no mode", "mode", () => composeRun({ ...paid, mode: undefined as unknown as RunMode, run: l1 })],
    ["an unknown arm", "arm", () => composeRun({ ...offline, run: { ...l1, arm: "L9" as ArmId } })],
    ["an arm id from Object.prototype", "arm", () => composeRun({ ...offline, run: { ...l1, arm: "toString" as ArmId } })],
    ["an experiment not the arm's", "experiment", () => composeRun({ ...offline, run: { ...l1, experiment: "E6b" } })],
    ["O3, even in a dry run", "o3", () => composeRun({ ...offline, run: { ...l1, arm: "O3" }, dryRun: true })],
    ["a draft arm without a dry run", "draft", () => composeRun({ ...offline, run: cellOf(dry, "L1s D1") })],
    ["a paid dry run", "dryRunMode", () => composeRun({ ...paid, run: l1, dryRun: true })],
    [
      "a rehearsal limits override",
      "overrideMode",
      () => composeRun({ mode: "rehearsal", models: PILOT_MODELS, run: l1, limitsOverride: { aMaxWallClockMs: 60_000 } }),
    ],
    ["B's wall clock override", "bWallClock", () => composeRun({ ...offline, run: l2, limitsOverride: { bMaxWallClockMs: 60_000 } })],
    ["another scenario's arm", "scenario", () => composeRun({ ...offline, run: { ...l1, scenario: "crm-import" } })],
    ["a variant not the arm's", "variant", () => composeRun({ ...offline, run: { ...l1, variant: "R" } })],
    ["a prompted L2", "prompted", () => composeRun({ ...paid, run: { ...l2, prompted: true } })],
    ["an undecided interval, paid", "undecided", () => assertIntervalDecided(undecidedL2, "paid")],
    ["an interval with no decided flag, rehearsal", "undecided", () => assertIntervalDecided(unsetL2, "rehearsal")],
    ["a paid L0h", "l0hMode", () => composeRun({ ...paid, run: { ...l1, arm: "L0h", experiment: "E5" } })],
    ["offline on paid pins", "offlineUnscripted", () => composeRun({ mode: "offline", models: PILOT_MODELS, run: l1 })],
    [
      "offline on a paid B pin",
      "offlineUnscripted",
      () => composeRun({ mode: "offline", models: { a: OFFLINE_MODELS.a, b: PILOT_MODELS.b }, run: l3 }),
    ],
    ["paid on a scripted A", "paidScripted", () => composeRun({ mode: "paid", models: OFFLINE_MODELS, run: l1 })],
    [
      "paid on a scripted model B",
      "paidScripted",
      () => composeRun({ mode: "paid", models: { a: PILOT_MODELS.a, b: OFFLINE_MODELS.b }, run: l3 }),
    ],
    ["a model-B arm with no B pin", "modelBMissing", () => composeRun({ mode: "paid", models: { a: PILOT_MODELS.a, b: null }, run: l3 })],
    ["another scenario's campaign id", "campaignId", () => composeRun({ ...offline, run: l1, campaignId: "crm-import-0a1b2c" })],
    ["a malformed campaign id", "campaignId", () => composeRun({ ...offline, run: l1, campaignId: "ledger-xyz" })],
    ["role ceilings over the cap", "overCap", () => composeRun({ ...paid, run: { ...l3, capUsd: 1.8 } })],
  ];
  for (const [label, refusal, run] of cases) {
    await check(`the composer refuses ${label}`, () => assertRefuses(run, refusal));
  }
  await check("the refusal matrix covers every refusal", () => {
    assert.deepEqual(
      [...new Set(cases.map(([, refusal]) => refusal))].sort(),
      Object.keys(COMPOSE_REFUSALS).sort(),
    );
  });

  await check("what the refusals bound still composes: offline undecided, the cap at the ceilings", () => {
    assertIntervalDecided(undecidedL2, "offline");
    // A + scripted B + planner, reviewer and integration at 0.01 each.
    composeRun({ ...paid, run: { ...l2, capUsd: 0.34 } });
    assertRefuses(() => composeRun({ ...paid, run: { ...l2, capUsd: 0.339 } }), "overCap");
    composeRun({ ...paid, run: { ...l3, capUsd: 1.83 } });
  });

  await check("an offline override shortens A's wall clock and the settle grace only", async () => {
    const composed = composeRun({
      ...offline,
      run: l1,
      limitsOverride: { aMaxWallClockMs: 60_000, settleGraceMs: 3_000 },
    });
    const { manifest } = await initializeInto(root, "override", composed.definition);
    assert.deepEqual(composed.limits.a, { ...A_LIMITS, maxWallClockMs: 60_000 });
    assert.equal(manifest.roles.builder.maxWallClockMs, 60_000);
    assert.equal(manifest.roles.builder.maxTurns, A_LIMITS.maxTurns);
    assert.equal(composed.settleGraceMs, 3_000);
  });

  await check("newCampaignId is <scenario>-<6 hex>, fresh each call", () => {
    const ids = [newCampaignId("ledger"), newCampaignId("ledger"), newCampaignId("crm-import")];
    for (const id of ids) assert.match(id, CAMPAIGN_ID_PATTERN);
    assert.notEqual(ids[0], ids[1]);
    assert(ids[2]!.startsWith("crm-import-"));
    const a = composeRun({ ...offline, run: l1 });
    const b = composeRun({ ...offline, run: l1 });
    assert.notEqual(a.campaignId, b.campaignId);
  });

  await check("F9: L2 and L3 at 27 858 ms, derived from A's wall clock; the crm arms at 3 000 ms; all decided", () => {
    assert.equal(minBatchIntervalMs(A_LIMITS.maxWallClockMs), 27_858);
    for (const arm of Object.values(ARM_DEFINITIONS)) {
      if (arm.id === "O3" || arm.minBatchIntervalMs === null) continue;
      assert.equal(arm.minBatchIntervalMs.decided, true, `${arm.id}'s interval is not decided`);
      if (arm.scenario === "crm-import" && arm.b === "script") {
        assert.equal(arm.minBatchIntervalMs.ms, 3_000, arm.id);
      }
    }
    assert.equal(ARM_DEFINITIONS.L2.minBatchIntervalMs!.ms, 27_858);
    assert.equal(ARM_DEFINITIONS.L3.minBatchIntervalMs!.ms, 27_858);
  });

  await check("the prompted sentence goes to L1 prompted's builder only", () => {
    for (const run of [...pilot, ...dry]) {
      const arm = ARM_DEFINITIONS[run.arm];
      const definition = composeRun({ ...offline, run, dryRun: arm.draft }).definition as {
        roles: { builder: { instructions?: string } };
      };
      assert.equal(
        definition.roles.builder.instructions,
        run.prompted ? PROMPTED_SENTENCE : undefined,
        run.cell,
      );
    }
  });

  await captureUnits(check);
}

// ---------------------------------------------------------------------------
// WP2's pure units: served, the resolved-model check, child paths, capture.

const A_PIN = SYNTHETIC_CONTEXT.models.a;
const B_PIN = SYNTHETIC_CONTEXT.models.b!;

function response(seq: number, responseId: string | null, servedProvider: string | null, model: string): LingEvent {
  return {
    seq,
    type: MODEL_RESPONSE_EVENT,
    ts: new Date(seq * 1000).toISOString(),
    data: {
      responseId,
      responseModel: null,
      servedProvider,
      provider: "openrouter",
      model,
      stopReason: "stop",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, costUsd: 0.001 },
    },
  } as unknown as LingEvent;
}

/** The records servedReading reads: `served` and A's events. */
function servedRecords(served: ServedCall[], events: LingEvent[]): RunRecords {
  return {
    experiment: { served } as ExperimentJson,
    manifest: undefined,
    events,
    finalState: undefined,
    probes: undefined,
  };
}

function resolvedFor(pin: BatchModel, change: (model: LingResolvedModel) => void = () => {}): LingResolvedModel {
  const model: LingResolvedModel = {
    provider: pin.provider,
    id: pin.model,
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    cost: { ...pin.prices } as unknown as LingResolvedModel["cost"],
    compat: { ...(pin.compat ?? {}), openRouterRouting: pin.routing },
    thinkingLevelMap: { [pin.thinking]: pin.thinkingLevel },
    contextWindow: 128_000,
    maxTokens: 16_000,
    thinking: pin.thinking as LingResolvedModel["thinking"],
  };
  change(model);
  return model;
}

function startedWorker(role: string, health: LingHealth): LocalStartedWorker {
  return {
    requestKey: `${campaignRequestKeyPrefix("ledger-abc123")}${role}:MDE:1`,
    workerId: `w-${role}`,
    profile: {} as LocalStartedWorker["profile"],
    runtimePaths: { runtimeDir: "r", workspacesDir: "r/w", home: "r/h", tmp: "r/t" },
    health,
  };
}

async function captureUnits(check: Report["check"]): Promise<void> {
  const aEvents = [
    response(1, "gen-1", "Z.AI", A_PIN.model),
    response(2, "gen-1", "Z.AI", A_PIN.model),
    { seq: 3, type: "tool_start", ts: new Date(3000).toISOString(), data: {} } as unknown as LingEvent,
    response(4, null, null, A_PIN.model),
  ];
  const bEvents = [response(1, "gen-b1", "OpenAI", B_PIN.model)];

  await check("servedCalls: one entry per model_response, de-duplicated by responseId, A's then B's (C6)", () => {
    const served = servedCalls({ a: aEvents, b: bEvents });
    assert.deepEqual(
      served.map((call) => [call.responseId, call.inBandProvider, call.model]),
      [
        ["gen-1", "Z.AI", A_PIN.model],
        [null, null, A_PIN.model],
        ["gen-b1", "OpenAI", B_PIN.model],
      ],
    );
    assert(served.every((call) => call.lookupProvider === null && call.attempts === 0 && call.costUsd === 0.001));
    assert.equal(servedCalls({ a: aEvents }).length, 2);
  });

  await check("servedReading over servedCalls: ids pair, a null-id call is unknown once, B's provider is judged (C6, C7)", () => {
    const served = servedCalls({ a: aEvents, b: bEvents });
    const reading = servedReading(servedRecords(served, aEvents), SYNTHETIC_CONTEXT);
    assert.deepEqual(reading, { mismatch: undefined, unknown: 1 });
    const wrongB = servedCalls({ a: aEvents, b: [response(1, "gen-b1", "Azure", B_PIN.model)] });
    assert.match(servedReading(servedRecords(wrongB, aEvents), SYNTHETIC_CONTEXT).mismatch ?? "", /gen-b1.*Azure/);
    // Without B in served, the same call is invisible to the rule.
    const withoutB = servedCalls({ a: aEvents });
    assert.equal(servedReading(servedRecords(withoutB, aEvents), SYNTHETIC_CONTEXT).mismatch, undefined);
    // Offline: every scripted call has no id and no provider, and counts once.
    const scriptedEvents = [1, 2, 3].map((seq) => response(seq, null, null, "scripted-model"));
    const offlineServed = servedCalls({ a: scriptedEvents, b: [response(1, null, null, "scripted-model")] });
    assert.equal(servedReading(servedRecords(offlineServed, scriptedEvents), offlineContext({})).unknown, 4);
  });

  await check("resolvedModelCheck: a match passes; cost, routing, other compat and thinking level mismatches throw", async () => {
    const pin: BatchModel = { ...A_PIN, compat: { supportsStore: false } };
    const kept: [string, LingResolvedModel | null][] = [];
    const hook = resolvedModelCheck({ a: pin, b: B_PIN }, (role, model) => kept.push([role, model]));
    const health = (model: LingResolvedModel): LingHealth => ({ ok: true, queued: 0, provider: "openrouter", model });
    await hook(startedWorker("builder", health(resolvedFor(pin))));
    await hook(startedWorker("watcher", health(resolvedFor(B_PIN))));
    assert.deepEqual(kept.map(([role]) => role), ["builder", "watcher"]);
    const mismatches: [string, (model: LingResolvedModel) => void, RegExp][] = [
      ["cost", (model) => ((model.cost as unknown as Record<string, number>)["input"] = 9), /cost\.input/],
      ["routing", (model) => (model.compat!["openRouterRouting"] = { order: ["x"], allow_fallbacks: false }), /openRouterRouting/],
      ["compat", (model) => (model.compat!["supportsStore"] = true), /compat\.supportsStore/],
      ["thinking level", (model) => (model.thinkingLevelMap = { low: "high" }), /thinkingLevelMap\.low/],
      ["model id", (model) => (model.id = "z-ai/other"), /resolved openrouter\/z-ai\/other/],
    ];
    for (const [what, change, pattern] of mismatches) {
      await assert.rejects(
        async () => hook(startedWorker("builder", health(resolvedFor(pin, change)))),
        pattern,
        what,
      );
    }
    await assert.rejects(
      async () => hook(startedWorker("builder", { ok: true, queued: 0, provider: "openrouter", model: null })),
      /no resolved model/,
    );
    const before = kept.length;
    await hook(startedWorker("reviewer", { ok: true, queued: 0, provider: "scripted-reviewer", models: ["scripted-model"] }));
    assert.equal(kept.length, before, "a scripted child was recorded");
  });

  await check("childPathsFrom: the record's workspace, else the task's; the lease's home, tmp and profile", () => {
    const paths = { runtimeDir: "R", workspacesDir: "R/w", home: "R/home", tmp: "R/tmp", userProfile: "C:/Users/u" };
    const base: CapturedTask = {
      taskId: "t1",
      workerId: "w1",
      role: "builder",
      requestKey: "k",
      task: { workspaceDir: "T/ws" } as unknown as CapturedTask["task"],
      finalState: { workspaceDir: "F/ws", workspaceDirReal: "F/real" } as unknown as CapturedTask["finalState"],
      finalStateError: null,
      runtimePaths: paths,
      via: "release",
      capturedAt: "",
    };
    assert.deepEqual(childPathsFrom(base, true), {
      workspaceDir: "F/ws",
      workspaceDirReal: "F/real",
      home: "R/home",
      tmp: "R/tmp",
      userProfile: "C:/Users/u",
      runtimeRemoved: true,
    });
    const noRecord = childPathsFrom({ ...base, finalState: null }, false);
    assert.equal(noRecord.workspaceDir, "T/ws");
    assert.equal(noRecord.workspaceDirReal, "", "a real path nobody observed was written");
    assert.equal(noRecord.runtimeRemoved, false);
    assert.deepEqual(missingChildPaths(noRecord), ["workspaceDirReal"]);
    assert.deepEqual(missingChildPaths(childPathsFrom(base, true)), []);
    // The verdict comes from the rule itself, given the child paths the capture wrote.
    const scored = (child: ReturnType<typeof childPathsFrom>) =>
      ({ exclusion: { contamination: contamination([], child, "L1") } }) as unknown as Parameters<typeof contaminationVerdict>[0];
    assert.equal(contaminationVerdict(scored(childPathsFrom(base, true)), childPathsFrom(base, true)), "clean");
    assert.equal(contaminationVerdict(scored(noRecord), noRecord), "unresolved", "a verdict on an unobserved path");
    assert.deepEqual(childPathsFrom(undefined, true), {
      workspaceDir: "",
      workspaceDirReal: "",
      home: "",
      tmp: "",
      userProfile: "",
      runtimeRemoved: true,
    });
  });

  await check("withCapture: optional methods only where the inner client has them; a builder is read before its release", async () => {
    const calls: string[] = [];
    const inner = {
      spawn: async (input: { requestKey?: string }) => ({ id: "t1", workerId: "w1", requestKey: input.requestKey }),
      get: async () => {
        calls.push("get");
        return { id: "t1", status: "completed", workspaceDir: "ws" };
      },
      list: async () => [],
      cancel: async () => undefined,
      finalState: async () => {
        calls.push("finalState");
        return { version: 1, workspaceDir: "ws", workspaceDirReal: "ws" };
      },
      release: async () => {
        calls.push("release");
      },
    } as unknown as ProvisionedLingClient;
    const lease = { lease: () => undefined } as unknown as LingProvisioner;
    const client = withCapture(inner, lease, {
      beforeRelease: async () => {
        calls.push("beforeRelease");
      },
    });
    assert.equal(client.terminate, undefined, "terminate was added to a client without one");
    assert.equal(client.events, undefined);
    assert.equal(typeof client.release, "function");
    await client.spawn({ requestKey: `${campaignRequestKeyPrefix("ledger-abc123")}builder:MDE:1` } as never);
    await client.release!("t1", "w1");
    assert.deepEqual(calls, ["get", "finalState", "beforeRelease", "release"]);
    assert.equal(client.captures()[0]?.via, "release");
    await client.captureUnreleased();
    assert.equal(client.captures().length, 1, "a released builder was taken twice");
  });

  await check("withCapture: a capture overlapping another of the same task waits, and keeps the first record", async () => {
    let finalStates = 0;
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const inner = {
      spawn: async (input: { requestKey?: string }) => ({ id: "t1", workerId: "w1", requestKey: input.requestKey }),
      get: async () => {
        await sleep(20);
        return { id: "t1", status: "failed", workspaceDir: "ws" };
      },
      list: async () => [],
      cancel: async () => undefined,
      // The first read finds the record; any later one finds the lease gone.
      finalState: async () => {
        finalStates += 1;
        if (finalStates === 1) return { version: 1, workspaceDir: "ws", workspaceDirReal: "ws" };
        throw new Error("Worker w1 was released before task t1 was snapshotted.");
      },
      release: async () => undefined,
    } as unknown as ProvisionedLingClient;
    const client = withCapture(inner, { lease: () => undefined } as unknown as LingProvisioner);
    await client.spawn({ requestKey: `${campaignRequestKeyPrefix("ledger-abc123")}builder:MDE:1` } as never);
    // driver.shutdown's release (the watchdog path) beside runPlannedRun's captureUnreleased.
    await Promise.all([client.release!("t1", "w1"), client.captureUnreleased()]);
    const captures = client.captures();
    assert.equal(captures.length, 1);
    assert.equal(captures[0]?.via, "release");
    assert.notEqual(captures[0]?.finalState, null, "a later capture replaced the record");
    assert.equal(finalStates, 1, "the second capture read again");
  });

  await check("coverageReasons: an incomplete B record, or a builder's past the first, excludes the run", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ling-experiment-e2e-coverage-"));
    try {
      const tasks = { builderIds: ["a1", "a2"], watcherId: "b1" };
      assert.deepEqual(
        (await coverageReasons(dir, { tasks })).map((entry) => entry.reason),
        ["events_incomplete"],
        "a run with no coverage file passed",
      );
      const write = (coverage: unknown) => writeFile(path.join(dir, EVENT_COVERAGE_FILE), JSON.stringify(coverage));
      await write([
        { side: "a", taskId: "a1", complete: false, reason: "the scorer's own" },
        { side: "a", taskId: "a2", complete: true, reason: null },
        { side: "b", taskId: "b1", complete: true, reason: null },
      ]);
      assert.deepEqual(await coverageReasons(dir, { tasks }), [], "the scorer's own record was judged twice");
      await write([
        { side: "a", taskId: "a1", complete: true, reason: null },
        { side: "a", taskId: "a2", complete: false, reason: "a gap after seq 3" },
        { side: "b", taskId: "b1", complete: false, reason: "no event record" },
      ]);
      assert.deepEqual(await coverageReasons(dir, { tasks }), [
        { reason: "events_incomplete", detail: "A's EventRecord a2: a gap after seq 3" },
        { reason: "events_incomplete", detail: "B's EventRecord b1: no event record" },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
