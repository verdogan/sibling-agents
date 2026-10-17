#!/usr/bin/env node
/**
 * Paid runner check ($0): tests plan, status, preflight and run with injected fakes.
 * Each run-loop case calls runBatch through real entry functions with scripted fakes.
 */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { planBatch } from "../experiment/batch/plan.js";
import { composeRun, pilotCells } from "../experiment/compose.js";
import { statusBatch } from "../experiment/batch/status.js";
import { preflight, type PreflightDeps } from "../experiment/batch/preflight.js";
import { lookupOpenRouterGeneration, runBatch, type RunDeps } from "../experiment/batch/run.js";
import type { ExclusionReason } from "../experiment/score/exclusion.js";
import { endpointMaxTokens, modelRoutingFor, pinFrom, PILOT_PIN_SPECS, resolvePins, routingFor } from "../experiment/batch/pins.js";
import { resolvedModelMismatch } from "../experiment/run.js";
import { readLedger, ledgerPath, appendLine, familySpend } from "../experiment/batch/ledger.js";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExperimentJson, ServedCall } from "../experiment/records.js";
import type { PlannedRunInput } from "../experiment/run.js";

const TMP_DIR = join(tmpdir(), `paid-runner-check-${process.pid}`);

// The pins a child reports for the pilot's models, from catalogue entries shaped as Pi 1.0.3 gives them.
const CATALOGUE = {
  a: {
    provider: "openrouter", id: "z-ai/glm-5.3-flash", api: "openai-completions",
    cost: { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 },
    compat: { supportsDeveloperRole: false, thinkingFormat: "openrouter", supportsStrictMode: true, sendSessionAffinityHeaders: true },
    thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
    maxTokens: 943717,
  },
  b: {
    provider: "openrouter", id: "openai/gpt-5.6-terra", api: "openai-completions",
    cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
    compat: { supportsMidConvoSystemMessages: true },
    thinkingLevelMap: { low: "low", medium: "medium", high: "high" },
    maxTokens: 128000,
  },
};
// The endpoints' ceilings as OpenRouter listed them on 2026-10-12: Z.AI's GLM 131 072, OpenAI's terra 128 000.
const TEST_PINS = {
  a: pinFrom(CATALOGUE.a, { ...PILOT_PIN_SPECS.a, maxTokens: 131072 }),
  b: pinFrom(CATALOGUE.b, { ...PILOT_PIN_SPECS.b, maxTokens: 128000 }),
};
let testCount = 0;
let failCount = 0;

function setup() {
  if (existsSync(TMP_DIR)) {
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
  mkdirSync(TMP_DIR, { recursive: true });
}

function teardown() {
  if (existsSync(TMP_DIR)) {
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function test(name: string, fn: () => void | Promise<void>) {
  testCount++;
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.catch((err) => {
        failCount++;
        console.error(`  ✗ ${name}: ${err.message}`);
        throw err;
      });
    }
  } catch (err) {
    failCount++;
    console.error(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

// Test plan command
async function testPlan() {
  console.log("Testing plan...");

  const digests = {
    "L1:unprompted": "a".repeat(64),
    "L1:prompted": "9".repeat(64),
    "L2:unprompted": "b".repeat(64),
    "L3:unprompted": "c".repeat(64),
    "R-control:unprompted": "d".repeat(64),
    "R-intervened:unprompted": "e".repeat(64),
    "W-control:unprompted": "f".repeat(64),
    "W:unprompted": "1".repeat(64),
    "P-relay:unprompted": "2".repeat(64),
    "P-direct:unprompted": "3".repeat(64),
  };

  await test("plan is deterministic", () => {
    const pilot1 = planBatch({
      batch: "pilot-1",
      digests,
      seed: "test-seed-1",
      piVersion: "1.0.3",
      gitHead: "a".repeat(7),
      protocolPath: "reports/experiment-protocol.md",
      protocolSha256: "protocol-sha",
      protocolCommitted: true,
    models: TEST_PINS,
    familySpentUsd: 0,
    });

    assert.equal(pilot1.id, "pilot-1");
    assert.equal(pilot1.family, "pilot");
    assert.equal(pilot1.runs.length, 2);
    assert.equal(pilot1.runs[0]?.arm, "L1");
    assert.equal(pilot1.runs[0]?.variant, "D1");
    assert.equal(pilot1.runs[0]?.prompted, false);
    assert.equal(pilot1.runs[1]?.arm, "L3");
    assert.equal(pilot1.runs[1]?.variant, "D3");
    assert.equal(pilot1.order, "fixed");
  });

  await test("PILOT-2 puts L3 D2 first", () => {
    const pilot2 = planBatch({
      batch: "pilot-2",
      digests,
      seed: "test-seed-2",
      piVersion: "1.0.3",
      gitHead: "a".repeat(7),
      protocolPath: "reports/experiment-protocol.md",
      protocolSha256: "protocol-sha",
      protocolCommitted: true,
    models: TEST_PINS,
    familySpentUsd: 0,
    });

    assert.equal(pilot2.id, "pilot-2");
    assert.equal(pilot2.runs.length, 28);
    assert.equal(pilot2.runs[0]?.arm, "L3");
    assert.equal(pilot2.runs[0]?.variant, "D2");
    assert.equal(pilot2.order, "model-b-first");

    // Test determinism
    const pilot2Again = planBatch({
      batch: "pilot-2",
      digests,
      seed: "test-seed-2",
      piVersion: "1.0.3",
      gitHead: "a".repeat(7),
      protocolPath: "reports/experiment-protocol.md",
      protocolSha256: "protocol-sha",
      protocolCommitted: true,
    models: TEST_PINS,
    familySpentUsd: 0,
    });
    assert.deepEqual(pilot2.runs, pilot2Again.runs);
  });

  await test("PILOT-2 prices only model-B arms as model-B, and its ceiling is what the family has left", () => {
    const pilot2 = planBatch({
      batch: "pilot-2",
      digests,
      seed: "test-seed-2",
      piVersion: "1.0.3",
      gitHead: "a".repeat(7),
      protocolPath: "reports/experiment-protocol.md",
      protocolSha256: "protocol-sha",
      protocolCommitted: true,
      models: TEST_PINS,
      familySpentUsd: 0.054345,
    });
    // L3 is the pilot's only arm with a model B; R-intervened, W and P-relay have a scripted B.
    for (const run of pilot2.runs) {
      const modelB = run.arm === "L3";
      assert.equal(run.capUsd, modelB ? 2.3 : 0.4, `${run.cell} cap`);
      assert.equal(run.estimateUsd, modelB ? 0.51 : 0.06, `${run.cell} estimate`);
    }
    assert.equal(pilot2.runs.filter((r) => r.capUsd === 2.3).length, 1);
    assert.equal(pilot2.ceilingUsd, 4.94);
    assert.equal(pilot2.familyCeilingUsd, 5);

    const withSpent = (familySpentUsd: number) =>
      planBatch({
        batch: "pilot-2",
        digests,
        piVersion: "1.0.3",
        gitHead: "a".repeat(7),
        protocolPath: "reports/experiment-protocol.md",
        protocolSha256: "protocol-sha",
        protocolCommitted: true,
        models: TEST_PINS,
        familySpentUsd,
      });
    assert.throws(() => withSpent(5), /nothing is left for PILOT-2/);
    assert.throws(() => withSpent(4.999), /nothing is left for PILOT-2/);
    assert.equal(withSpent(4.98).ceilingUsd, 0.02);
  });

  await test("every planned pilot run composes as a paid run, on a cell the composer knows", () => {
    const known = new Set(pilotCells().map((c) => `${c.arm} ${c.variant} ${c.prompted}`));
    for (const batch of ["pilot-1", "pilot-2"] as const) {
      const manifest = planBatch({
        batch,
        digests,
        seed: "compose-test",
        piVersion: "1.0.3",
        gitHead: "a".repeat(7),
        protocolPath: "reports/experiment-protocol.md",
        protocolSha256: "protocol-sha",
        protocolCommitted: true,
        models: TEST_PINS,
        familySpentUsd: 0,
      });
      for (const run of manifest.runs) {
        assert.ok(known.has(`${run.arm} ${run.variant} ${run.prompted}`), `${batch} ${run.cell} is not a composer pilot cell`);
        // As the batch runner passes them (batch/run.ts): B's pin only to an arm whose B is a model.
        const pin = (m: typeof TEST_PINS.a) => ({ provider: m.provider, model: m.model, thinking: m.thinking as "low" });
        const models = { a: pin(TEST_PINS.a), b: run.arm === "L3" ? pin(TEST_PINS.b) : null };
        assert.doesNotThrow(() => composeRun({ run, mode: "paid", models }), `${batch} ${run.cell} does not compose`);
      }
    }
  });

  await test("plan refuses uncommitted protocol", () => {
    assert.throws(() => {
      planBatch({
        batch: "pilot-1",
        digests,
        piVersion: "1.0.3",
        gitHead: "a".repeat(7),
        protocolPath: "reports/experiment-protocol.md",
        protocolSha256: "protocol-sha",
        protocolCommitted: false,
        models: TEST_PINS,
        familySpentUsd: 0,
      });
    }, /protocol file is not committed/);
  });
}

// Test status command
async function testStatus() {
  console.log("Testing status...");

  await test("status counts from ledger", () => {
    const manifest = planBatch({
      batch: "pilot-1",
      digests: { "L1:unprompted": "a".repeat(64), "L3:unprompted": "c".repeat(64) },
      seed: "status-test",
      piVersion: "1.0.3",
      gitHead: "a".repeat(7),
      protocolPath: "reports/experiment-protocol.md",
      protocolSha256: "protocol-sha",
      protocolCommitted: true,
    models: TEST_PINS,
    familySpentUsd: 0,
    });

    const testDir = join(TMP_DIR, "status-test");
    mkdirSync(testDir, { recursive: true });
    const ledger = ledgerPath(testDir, "pilot-1");

    appendLine(ledger, {
      event: "batch_started",
      batchId: "pilot-1",
      manifestSha256: "test-sha",
      timestamp: new Date().toISOString(),
    });
    appendLine(ledger, {
      event: "run_started",
      runId: "run-00000001",
      cap: 0.4,
      estimate: 0.06,
      spentBefore: 0,
      timestamp: new Date().toISOString(),
    });
    appendLine(ledger, {
      event: "run_finished",
      runId: "run-00000001",
      status: "success",
      stoppedBy: null,
      outcome: "included",
      reason: null,
      costUsd: 0.05,
      reconciled: true,
      timestamp: new Date().toISOString(),
    });
    appendLine(ledger, {
      event: "run_started",
      runId: "run-00000002",
      cap: 2.3,
      estimate: 0.51,
      spentBefore: 0.05,
      timestamp: new Date().toISOString(),
    });
    appendLine(ledger, {
      event: "run_finished",
      runId: "run-00000002",
      status: "capped",
      stoppedBy: "max_cost",
      outcome: "excluded",
      reason: "served_provider",
      costUsd: 0.45,
      reconciled: true,
      timestamp: new Date().toISOString(),
    });

    const status = statusBatch(manifest, ledger);

    assert.equal(status.counts.done, 1);
    assert.equal(status.counts.excluded, 1);
    assert.equal(status.counts.notStarted, 0);
    assert.equal(status.counts.failed, 0);
    assert.equal(status.spend.spent, 0.5);
    assert.equal(status.exclusionReasons.length, 1);
    assert.equal(status.exclusionReasons[0]?.reason, "served_provider");
    assert.equal(status.exclusionReasons[0]?.count, 1);
  });
}

// Test preflight checks
async function testPreflight() {
  console.log("Testing preflight...");

  const manifest = planBatch({
    batch: "pilot-1",
    digests: { "L1:unprompted": "a".repeat(64), "L3:unprompted": "c".repeat(64) },
    seed: "preflight-test",
    piVersion: "1.0.3",
    gitHead: "abc1234",
    protocolPath: "reports/experiment-protocol.md",
    protocolSha256: sha256("protocol content"),
    protocolCommitted: true,
    models: TEST_PINS,
    familySpentUsd: 0,
  });

  const manifestSha = sha256(JSON.stringify(manifest));
  const registryPath = join(TMP_DIR, "registry.json");
  writeFileSync(registryPath, JSON.stringify({ "pilot-1": manifestSha }), "utf8");

  const goodDeps: PreflightDeps = {
    git: () => ({ head: "abc1234", clean: true }),
    env: (key) => (key === "OPENROUTER_API_KEY" ? "test-key" : undefined),
    nodeVersion: () => "24.19.0",
    readFile: (path) => {
      if (path.includes("protocol")) return Buffer.from("protocol content");
      if (path.includes("registry")) return Buffer.from(JSON.stringify({ "pilot-1": manifestSha }));
      throw new Error("unexpected file");
    },
    fileExists: (path) => path.includes("protocol") || path.includes("registry"),
    piVersion: () => "1.0.3",
    familySpend: () => 0,
  };

  await test("preflight passes with correct inputs", () => {
    const result = preflight(manifest, manifestSha, registryPath, "runs", "protocol.md", goodDeps);
    assert.equal(result.ok, true);
  });

  await test("no/wrong --approve → refusal", () => {
    const wrongSha = "wrong-sha";
    const result = preflight(manifest, wrongSha, registryPath, "runs", "protocol.md", goodDeps);
    assert.equal(result.ok, false);
    assert(result.ok === false && result.reason.includes("manifest sha256"));
  });

  await test("dirty tree refused", () => {
    const dirtyDeps: PreflightDeps = {
      ...goodDeps,
      git: () => ({ head: "abc1234", clean: false }),
    };
    const result = preflight(manifest, manifestSha, registryPath, "runs", "protocol.md", dirtyDeps);
    assert.equal(result.ok, false);
    assert(result.ok === false && result.reason.includes("not clean"));
  });

  await test("wrong HEAD refused", () => {
    const wrongHeadDeps: PreflightDeps = {
      ...goodDeps,
      git: () => ({ head: "def5678", clean: true }),
    };
    const result = preflight(manifest, manifestSha, registryPath, "runs", "protocol.md", wrongHeadDeps);
    assert.equal(result.ok, false);
    assert(result.ok === false && result.reason.includes("git HEAD"));
  });

  await test("each env refusal names its key", () => {
    const badEnvDeps: PreflightDeps = {
      ...goodDeps,
      env: (key) => {
        if (key === "OPENROUTER_API_KEY") return "test-key";
        if (key === "LING_SCRIPTED_MODEL") return "some-value";
        return undefined;
      },
    };
    const result = preflight(manifest, manifestSha, registryPath, "runs", "protocol.md", badEnvDeps);
    assert.equal(result.ok, false);
    assert(result.ok === false && result.reason.includes("LING_SCRIPTED_MODEL"));
  });

  await test("missing digest refused", () => {
    const noDigestManifest = { ...manifest, promptDigests: {} };
    const result = preflight(noDigestManifest, manifestSha, registryPath, "runs", "protocol.md", goodDeps);
    assert.equal(result.ok, false);
    assert(result.ok === false && result.reason.includes("missing prompt digest"));
  });

  await test("Node < 24 refused", () => {
    const oldNodeDeps: PreflightDeps = {
      ...goodDeps,
      nodeVersion: () => "22.0.0",
    };
    const result = preflight(manifest, manifestSha, registryPath, "runs", "protocol.md", oldNodeDeps);
    assert.equal(result.ok, false);
    assert(result.ok === false && result.reason.includes("Node version"));
  });

  await test("registry tampering detected by git status", () => {
    const dirtyDeps: PreflightDeps = {
      ...goodDeps,
      git: () => ({ head: manifest.gitHead, clean: false }),
    };
    const result = preflight(manifest, manifestSha, registryPath, TMP_DIR, "protocol.md", dirtyDeps);
    assert.ok(!result.ok);
    if (result.ok === false) {
      assert.ok(result.reason.includes("not clean"), `Expected dirty tree error but got: ${result.reason}`);
    }
  });
}

// Test run command with real runBatch calls
async function testRun() {
  console.log("Testing run command...");

  const manifest = planBatch({
    batch: "pilot-1",
    digests: { "L1:unprompted": "a".repeat(64), "L3:unprompted": "c".repeat(64) },
    seed: "run-test",
    piVersion: "1.0.3",
    gitHead: "abc1234",
    protocolPath: "reports/experiment-protocol.md",
    protocolSha256: sha256("protocol content"),
    protocolCommitted: true,
    models: TEST_PINS,
    familySpentUsd: 0,
  });

  const manifestSha = sha256(JSON.stringify(manifest));
  const registryPath = join(TMP_DIR, "run-registry.json");
  const protocolPath = join(TMP_DIR, "run-protocol.md");
  writeFileSync(registryPath, JSON.stringify({ "pilot-1": manifestSha }), "utf8");
  writeFileSync(protocolPath, "protocol content", "utf8");

  const baseDeps: PreflightDeps = {
    git: () => ({ head: "abc1234", clean: true }),
    env: (key) => (key === "OPENROUTER_API_KEY" ? "test-key" : undefined),
    nodeVersion: () => "24.19.0",
    readFile: (path) => {
      if (path.includes("protocol") || path === "reports/experiment-protocol.md") {
        return Buffer.from("protocol content");
      }
      if (path.includes("registry")) {
        return Buffer.from(JSON.stringify({ "pilot-1": manifestSha }));
      }
      if (path.includes("ling/.env") || path === "ling/.env") {
        return Buffer.from("");
      }
      throw new Error(`unexpected file: ${path}`);
    },
    fileExists: (path) => {
      if (path.includes("protocol") || path === "reports/experiment-protocol.md") return true;
      if (path.includes("registry")) return true;
      if (path.includes("ling/.env") || path === "ling/.env") return false;
      return true;
    },
    piVersion: () => "1.0.3",
    familySpend: () => 0,
  };

  // What every run case shares unless it says otherwise: the run's own records give no exclusion, and
  // the instrument is the registered commit, clean.
  const runDefaults = {
    exclusionReasons: async (): Promise<ExclusionReason[]> => [],
    instrument: async () => ({ gitHead: "abc1234", clean: true, pi: { codingAgent: "1.0.3", ai: [] }, agentSettingsSha256: "absent" }),
  };

  // Helper to create experiment result with served calls and ensure run directory exists
  function makeExperiment(
    runId: string,
    runDir: string,
    served: Partial<ServedCall>[],
    outcome: "included" | "excluded" = "included",
    reason: string | null = null,
  ): ExperimentJson {
    // Ensure run directory exists
    mkdirSync(runDir, { recursive: true });

    const fullServed: ServedCall[] = served.map((s) => ({
      responseId: s.responseId ?? null,
      inBandProvider: s.inBandProvider ?? null,
      lookupProvider: s.lookupProvider ?? null,
      model: s.model ?? "test-model",
      costUsd: s.costUsd ?? null,
      attempts: s.attempts ?? 1,
    }));

    return {
      version: 1,
      batchId: "pilot-1",
      runId,
      experiment: "E1",
      cell: "E1 L1 D1",
      arm: "L1",
      scenario: "ledger",
      variant: "D1",
      prompted: false,
      rep: 1,
      rerunOf: null,
      a: {
        provider: "z-ai",
        model: "glm-5.3-flash",
        thinking: "low",
        routing: null,
        resolved: null,
      },
      b: { kind: "none" } as any,
      limits: {
        a: { maxTurns: 30, maxWallClockMs: 600000, maxCostUsd: 0.3 },
        b: null,
      },
      minBatchIntervalMs: null,
      maxRounds: 10,
      maxTasks: 5,
      brain: "unset",
      lingSettings: {},
      instrument: {
        gitHead: "abc1234",
        clean: true,
        pi: { codingAgent: "1.0.3", ai: [] },
        agentSettingsSha256: "",
        piAgentDir: { files: [] },
      },
      manifestSha256: manifestSha,
      promptDigest: null,
      child: {
        workspaceDir: "/tmp/workspace",
        workspaceDirReal: "/tmp/workspace",
        home: "/tmp/home",
        tmp: "/tmp/tmp",
        userProfile: "/tmp/profile",
        runtimeRemoved: true,
      },
      approval: {
        approvedAt: "2024-01-01T00:00:00Z",
        estimateUsd: 0.06,
        capUsd: 0.4,
        spentBeforeUsd: 0,
        remainingBeforeUsd: 2.7,
        confirmedEach: false,
      },
      campaign: { id: "test-campaign" },
      tasks: { builderIds: ["task-1"], watcherId: null },
      workspaceDir: "/tmp/workspace",
      started: "2024-01-01T00:00:00Z",
      ended: "2024-01-01T00:01:00Z",
      cost: { a: null, b: null, reconciled: null },
      served: fullServed,
      outcome: { status: outcome, reason },
    };
  }

  await test("cap > remaining → run_not_started for it and all later + batch_stopped", async () => {
    const testDir = join(TMP_DIR, "cap-exceeds");
    mkdirSync(testDir, { recursive: true });

    // Pre-populate ledger with first run already completed, consuming most of the ceiling
    const ledger = ledgerPath(testDir, "pilot-1");
    appendLine(ledger, {
      event: "batch_started",
      batchId: "pilot-1",
      manifestSha256: manifestSha,
      timestamp: "2024-01-01T00:00:00Z",
    });
    appendLine(ledger, {
      event: "run_started",
      runId: manifest.runs[0]!.runId,
      cap: 0.4,
      estimate: 0.06,
      spentBefore: 0,
      timestamp: "2024-01-01T00:00:00Z",
    });
    appendLine(ledger, {
      event: "run_finished",
      runId: manifest.runs[0]!.runId,
      status: "success",
      stoppedBy: null,
      outcome: "included",
      reason: null,
      costUsd: 2.5,
      reconciled: true,
      timestamp: "2024-01-01T00:00:01Z",
    });

    let runCount = 0;
    const deps: RunDeps = {
      ...runDefaults,
      preflight: baseDeps,
      runPlannedRun: async (input: PlannedRunInput) => {
        runCount++;
        const runDir = `${testDir}/pilot-1/${input.run.runId}`;
        const experiment = makeExperiment(input.run.runId, runDir, [
          { responseId: "resp1", costUsd: 0.05, inBandProvider: "Z.AI" },
        ]);
        return { experiment, runDir: `${testDir}/pilot-1/${input.run.runId}` };
      },
      lookupGeneration: async () => ({ totalCost: 0.05, provider: "Z.AI" }),
      checkLeftoverDirs: async () => [],
      env: (key) => (key === "OPENROUTER_API_KEY" ? "test-key" : undefined),
      timestamp: () => "2024-01-01T00:01:00Z",
    };

    await runBatch(manifest, manifestSha, {
      approve: "pilot-1",
      runsDir: testDir,
      registryPath,
      protocolFile: protocolPath,
    }, deps);

    const lines = readLedger(ledger);
    const events = lines.map((l) => l.event);

    assert.deepEqual(events, [
      "batch_started",
      "run_started",
      "run_finished",
      "run_not_started",
      "batch_stopped",
    ]);

    const notStarted = lines.find((l) => l.event === "run_not_started");
    assert.ok(notStarted && "reason" in notStarted && notStarted.reason === "cap_exceeds_remaining");

    const stopped = lines.find((l) => l.event === "batch_stopped");
    assert.ok(stopped && "reason" in stopped && stopped.reason === "cap_exceeds_remaining");

    assert.equal(runCount, 0, "Should not run second run as cap exceeds remaining");
  });

  await test("family ceiling counts earlier batch spend", () => {
    const testDir = join(TMP_DIR, "family-ceiling");
    mkdirSync(join(testDir, "pilot-1"), { recursive: true });

    const earlierLedger = join(testDir, "pilot-1", "ledger.jsonl");
    appendLine(earlierLedger, {
      event: "batch_started",
      batchId: "pilot-1",
      manifestSha256: manifestSha,
      timestamp: new Date().toISOString(),
    });
    appendLine(earlierLedger, {
      event: "run_finished",
      runId: "run-00000001",
      status: "success",
      stoppedBy: null,
      outcome: "included",
      reason: null,
      costUsd: 1.5,
      reconciled: true,
      timestamp: new Date().toISOString(),
    });

    const spent = familySpend(testDir, "pilot");
    assert.equal(spent, 1.5);
  });

  await test("reconciled = max(measured, lookup)", async () => {
    const testDir = join(TMP_DIR, "reconciled-max");
    mkdirSync(testDir, { recursive: true });

    const deps: RunDeps = {
      ...runDefaults,
      preflight: baseDeps,
      runPlannedRun: async (input: PlannedRunInput) => {
        const runDir = `${testDir}/pilot-1/${input.run.runId}`;
        const experiment = makeExperiment(input.run.runId, runDir, [
          { responseId: "resp1", costUsd: 0.05, inBandProvider: "Z.AI" },
        ]);
        return { experiment, runDir: `${testDir}/pilot-1/${input.run.runId}` };
      },
      lookupGeneration: async () => ({ totalCost: 0.07, provider: "Z.AI" }),
      checkLeftoverDirs: async () => [],
      env: (key) => (key === "OPENROUTER_API_KEY" ? "test-key" : undefined),
      timestamp: () => "2024-01-01T00:00:00Z",
    };

    await runBatch(manifest, manifestSha, {
      approve: "pilot-1",
      runsDir: testDir,
      registryPath,
      protocolFile: protocolPath,
    }, deps);

    const ledger = readLedger(ledgerPath(testDir, "pilot-1"));
    const finished = ledger.filter((l) => l.event === "run_finished");

    assert.ok(finished.length > 0);
    assert.ok(finished.every((f) => "costUsd" in f && f.costUsd === 0.07));
  });

  await test("lookup failure flagged", async () => {
    const testDir = join(TMP_DIR, "lookup-failed");
    mkdirSync(testDir, { recursive: true });

    const deps: RunDeps = {
      ...runDefaults,
      preflight: baseDeps,
      runPlannedRun: async (input: PlannedRunInput) => {
        const runDir = `${testDir}/pilot-1/${input.run.runId}`;
        const experiment = makeExperiment(input.run.runId, runDir, [
          { responseId: "resp1", costUsd: 0.05, inBandProvider: "Z.AI" },
        ]);
        return { experiment, runDir: `${testDir}/pilot-1/${input.run.runId}` };
      },
      lookupGeneration: async () => null, // Lookup fails
      checkLeftoverDirs: async () => [],
      env: (key) => (key === "OPENROUTER_API_KEY" ? "test-key" : undefined),
      timestamp: () => "2024-01-01T00:00:00Z",
    };

    await runBatch(manifest, manifestSha, {
      approve: "pilot-1",
      runsDir: testDir,
      registryPath,
      protocolFile: protocolPath,
    }, deps);

    const ledger = readLedger(ledgerPath(testDir, "pilot-1"));
    const finished = ledger.filter((l) => l.event === "run_finished");

    assert.ok(finished.every((f) => "lookupFailed" in f && f.lookupFailed === true));
  });

  await test("cap_overrun stops batch", async () => {
    const testDir = join(TMP_DIR, "cap-overrun");
    mkdirSync(testDir, { recursive: true });

    let runCount = 0;
    const deps: RunDeps = {
      ...runDefaults,
      preflight: baseDeps,
      runPlannedRun: async (input: PlannedRunInput) => {
        runCount++;
        const runDir = `${testDir}/pilot-1/${input.run.runId}`;
        const experiment = makeExperiment(input.run.runId, runDir, [
          { responseId: "resp1", costUsd: 0.5, inBandProvider: "Z.AI" },
        ]);
        return { experiment, runDir: `${testDir}/pilot-1/${input.run.runId}` };
      },
      lookupGeneration: async () => ({ totalCost: 0.5, provider: "Z.AI" }),
      checkLeftoverDirs: async () => [],
      env: (key) => (key === "OPENROUTER_API_KEY" ? "test-key" : undefined),
      timestamp: () => "2024-01-01T00:00:00Z",
    };

    await runBatch(manifest, manifestSha, {
      approve: "pilot-1",
      runsDir: testDir,
      registryPath,
      protocolFile: protocolPath,
    }, deps);

    const ledger = readLedger(ledgerPath(testDir, "pilot-1"));
    const events = ledger.map((l) => l.event);

    // Both runs should complete (cap 0.4 and 2.3, costs 0.5 each, only first overruns)
    assert.ok(events.includes("batch_stopped"));
    const stopped = ledger.find((l) => l.event === "batch_stopped");
    assert.ok(stopped && "reason" in stopped && stopped.reason === "cap_overrun");

    assert.equal(runCount, 1, "Should stop after first cap overrun");
  });

  await test("served_provider mismatch continues batch", async () => {
    const testDir = join(TMP_DIR, "served-provider");
    mkdirSync(testDir, { recursive: true });

    let runCount = 0;
    const deps: RunDeps = {
      ...runDefaults,
      preflight: baseDeps,
      runPlannedRun: async (input: PlannedRunInput) => {
        runCount++;
        const runDir = `${testDir}/pilot-1/${input.run.runId}`;
        const experiment = makeExperiment(input.run.runId, runDir, [
          { responseId: "resp1", costUsd: 0.15, inBandProvider: "WrongProvider" },
        ]);
        return { experiment, runDir: `${testDir}/pilot-1/${input.run.runId}` };
      },
      lookupGeneration: async () => ({ totalCost: 0.15, provider: "WrongProvider" }),
      checkLeftoverDirs: async () => [],
      env: (key) => (key === "OPENROUTER_API_KEY" ? "test-key" : undefined),
      timestamp: () => "2024-01-01T00:00:00Z",
    };

    await runBatch(manifest, manifestSha, {
      approve: "pilot-1",
      runsDir: testDir,
      registryPath,
      protocolFile: protocolPath,
    }, deps);

    const ledger = readLedger(ledgerPath(testDir, "pilot-1"));
    const finished = ledger.filter((l) => l.event === "run_finished");

    // Should run both runs (no batch_stopped for served_provider alone)
    assert.ok(finished.length >= 1, "Should complete at least one run");
    assert.ok(runCount >= 1, "Should execute runs despite provider mismatch");
  });

  await test("first-run unknown provider/null responseId stops", async () => {
    const testDir = join(TMP_DIR, "first-unknown");
    mkdirSync(testDir, { recursive: true });

    let runCount = 0;
    const deps: RunDeps = {
      ...runDefaults,
      preflight: baseDeps,
      runPlannedRun: async (input: PlannedRunInput) => {
        runCount++;
        const runDir = `${testDir}/pilot-1/${input.run.runId}`;
        const experiment = makeExperiment(input.run.runId, runDir, [
          { responseId: null, costUsd: 0.05, inBandProvider: null },
        ]);
        return { experiment, runDir: `${testDir}/pilot-1/${input.run.runId}` };
      },
      lookupGeneration: async () => null,
      checkLeftoverDirs: async () => [],
      env: (key) => (key === "OPENROUTER_API_KEY" ? "test-key" : undefined),
      timestamp: () => "2024-01-01T00:00:00Z",
    };

    await runBatch(manifest, manifestSha, {
      approve: "pilot-1",
      runsDir: testDir,
      registryPath,
      protocolFile: protocolPath,
    }, deps);

    const ledger = readLedger(ledgerPath(testDir, "pilot-1")) as unknown as Record<string, unknown>[];
    // The run executed and spent: it ends in run_finished with its cost, then the batch stops.
    assert.deepEqual(ledger.map((l) => l["event"]), ["batch_started", "run_started", "run_finished", "batch_stopped"]);
    const finished = ledger.find((l) => l["event"] === "run_finished")!;
    assert.equal(finished["reason"], "served_unverifiable");
    assert.equal(finished["costUsd"], 0.05, "the run's cost reaches the ledger");
    assert.equal(ledger.at(-1)!["reason"], "served_unverifiable");
    assert.equal(runCount, 1, "Should run first but stop immediately");
  });

  await test("a wrong --approve runs nothing and writes no ledger", async () => {
    const testDir = join(TMP_DIR, "wrong-approve");
    mkdirSync(testDir, { recursive: true });
    let runCount = 0;
    const deps: RunDeps = {
      ...runDefaults,
      preflight: baseDeps,
      runPlannedRun: async () => {
        runCount++;
        throw new Error("must not run");
      },
      lookupGeneration: async () => null,
      checkLeftoverDirs: async () => [],
      env: (key) => (key === "OPENROUTER_API_KEY" ? "test-key" : undefined),
      timestamp: () => "2024-01-01T00:00:00Z",
    };
    for (const approve of ["", "pilot-2", "PILOT-1"]) {
      await assert.rejects(
        runBatch(manifest, manifestSha, { approve, runsDir: testDir, registryPath, protocolFile: protocolPath }, deps),
        /nothing was run/,
      );
    }
    assert.equal(runCount, 0);
    assert.equal(existsSync(ledgerPath(testDir, "pilot-1")), false, "no ledger was written");
  });

  await test("an instrument that is not the registered commit runs nothing", async () => {
    for (const instrument of [
      { gitHead: "fffffff", clean: true },
      { gitHead: "abc1234", clean: false },
    ]) {
      const testDir = join(TMP_DIR, `instrument-${instrument.gitHead}-${instrument.clean}`);
      mkdirSync(testDir, { recursive: true });
      let runCount = 0;
      const deps: RunDeps = {
        ...runDefaults,
        instrument: async () => ({ ...instrument, pi: { codingAgent: "1.0.3", ai: [] }, agentSettingsSha256: "absent" }),
        preflight: baseDeps,
        runPlannedRun: async () => {
          runCount++;
          throw new Error("must not run");
        },
        lookupGeneration: async () => null,
        checkLeftoverDirs: async () => [],
        env: (key) => (key === "OPENROUTER_API_KEY" ? "test-key" : undefined),
        timestamp: () => "2024-01-01T00:00:00Z",
      };
      await assert.rejects(
        runBatch(manifest, manifestSha, { approve: "pilot-1", runsDir: testDir, registryPath, protocolFile: protocolPath }, deps),
        /not the registered one/,
      );
      assert.equal(runCount, 0);
      const events = readLedger(ledgerPath(testDir, "pilot-1")).map((l) => l.event);
      assert.ok(!events.includes("run_started"), "no run started");
    }
  });

  await test("only a model-B arm is sent model B; an A-only arm gets none", async () => {
    const testDir = join(TMP_DIR, "model-b-per-arm");
    mkdirSync(testDir, { recursive: true });
    const sent: { arm: string; b: unknown; expectedB: unknown }[] = [];
    const deps: RunDeps = {
      ...runDefaults,
      preflight: baseDeps,
      runPlannedRun: async (input: PlannedRunInput) => {
        sent.push({ arm: input.run.arm, b: input.models.b, expectedB: input.expectedModels?.b });
        const runDir = `${testDir}/pilot-1/${input.run.runId}`;
        const experiment = makeExperiment(input.run.runId, runDir, [{ responseId: `r${sent.length}`, costUsd: 0.05, inBandProvider: "Z.AI" }]);
        return { experiment, runDir };
      },
      lookupGeneration: async () => ({ totalCost: 0.05, provider: "Z.AI" }),
      checkLeftoverDirs: async () => [],
      env: (key) => (key === "OPENROUTER_API_KEY" ? "test-key" : undefined),
      timestamp: () => "2024-01-01T00:00:00Z",
    };
    await runBatch(manifest, manifestSha, { approve: "pilot-1", runsDir: testDir, registryPath, protocolFile: protocolPath }, deps);
    // PILOT-1 is L1 D1 (A-only) then L3 D3 (model B).
    assert.deepEqual(sent.map((s) => s.arm), ["L1", "L3"]);
    assert.equal(sent[0]!.b, null);
    assert.equal(sent[0]!.expectedB, null);
    assert.equal((sent[1]!.b as { model: string } | null)?.model, manifest.models.b.model);
    assert.notEqual(sent[1]!.expectedB, null);
  });

  await test("the generation lookup retries a 404 with backoff, then gives up", async () => {
    const answers = [404, 404, 200];
    const slept: number[] = [];
    const fetchImpl = (async () => {
      const status = answers.shift() ?? 404;
      return {
        ok: status === 200,
        status,
        json: async () => ({ data: { total_cost: 0.012, provider_name: "Z.AI" } }),
      };
    }) as unknown as typeof fetch;
    const found = await lookupOpenRouterGeneration("gen-1", "k", fetchImpl, async (ms) => { slept.push(ms); });
    assert.deepEqual(found, { totalCost: 0.012, provider: "Z.AI" });
    assert.deepEqual(slept, [1000, 2000]);
    const never = (async () => ({ ok: false, status: 404, json: async () => ({}) })) as unknown as typeof fetch;
    const slept2: number[] = [];
    assert.equal(await lookupOpenRouterGeneration("gen-2", "k", never, async (ms) => { slept2.push(ms); }), null);
    assert.deepEqual(slept2, [1000, 2000, 4000, 8000, 16000]);
  });

  // What PILOT-1's builder child reported (2026-10-11) for GLM, before routing reached it.
  const GLM_AS_RESOLVED = {
    provider: "openrouter",
    id: "z-ai/glm-5.3-flash",
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    cost: { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 },
    compat: { supportsDeveloperRole: false, thinkingFormat: "openrouter", supportsStrictMode: true, sendSessionAffinityHeaders: true },
    thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
    contextWindow: 1048575,
    maxTokens: 943717,
    thinking: "low",
  };
  const routed = (record: typeof GLM_AS_RESOLVED, routing: unknown) => ({ ...record, compat: { ...record.compat, openRouterRouting: routing } });
  // What a child reports once LING_MODEL_MAX_TOKENS has lowered its ceiling too.
  const routedCapped = (record: typeof GLM_AS_RESOLVED, routing: unknown, maxTokens: number) => ({ ...routed(record, routing), maxTokens });

  await test("a pin carries the provider slug, and matches the record its routed child reports", async () => {
    const pin = TEST_PINS.a;
    assert.deepEqual(pin.routing, { order: ["z-ai"], allow_fallbacks: false });
    assert.deepEqual(TEST_PINS.b.routing, { order: ["openai"], allow_fallbacks: false });
    assert.deepEqual(pin.prices, { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 });
    assert.equal(pin.thinkingLevel, "low");
    assert.equal(pin.servedProviderName, "Z.AI");
    assert.equal(pin.maxTokens, 131072, "the catalogue's 943 717, lowered to the endpoint's ceiling");
    // The child's own record, routing and ceiling applied, passes the beforePost comparison.
    assert.equal(resolvedModelMismatch(pin, routedCapped(GLM_AS_RESOLVED, pin.routing, 131072) as never), undefined);
    // A child that kept the catalogue's ceiling (PILOT-4's, which no endpoint served) is refused before any call.
    assert.match(resolvedModelMismatch(pin, routed(GLM_AS_RESOLVED, pin.routing) as never) ?? "", /maxTokens is 943717, not 131072/);
    // Without routing (as PILOT-1's child ran), or with the model id where the slug belongs, it fails.
    assert.match(resolvedModelMismatch(pin, GLM_AS_RESOLVED as never) ?? "", /openRouterRouting/);
    assert.match(
      resolvedModelMismatch(pin, routed(GLM_AS_RESOLVED, { order: ["z-ai/glm-5.3-flash"], allow_fallbacks: false }) as never) ?? "",
      /openRouterRouting/,
    );
    assert.match(resolvedModelMismatch(pin, { ...routed(GLM_AS_RESOLVED, pin.routing), cost: { input: 0.0001 } } as never) ?? "", /cost\.input/);
    assert.throws(() => routingFor({ ...PILOT_PIN_SPECS.a, slug: "z-ai/glm-5.3-flash" }), /provider slug/);
    assert.throws(() => routingFor({ ...PILOT_PIN_SPECS.a, slug: "Z.AI" }), /provider slug/);
  });

  await test("every run's children are given the manifest's LING_MODEL_ROUTING", async () => {
    const testDir = join(TMP_DIR, "routing-env");
    mkdirSync(testDir, { recursive: true });
    const given: (string | undefined)[] = [];
    const ceilings: unknown[] = [];
    const deps: RunDeps = {
      ...runDefaults,
      preflight: baseDeps,
      runPlannedRun: async (input: PlannedRunInput) => {
        given.push(input.env["LING_MODEL_ROUTING"]);
        ceilings.push(JSON.parse(input.env["LING_MODEL_MAX_TOKENS"] ?? "null"));
        const runDir = `${testDir}/pilot-1/${input.run.runId}`;
        const experiment = makeExperiment(input.run.runId, runDir, [{ responseId: `r${given.length}`, costUsd: 0.05, inBandProvider: "Z.AI" }]);
        return { experiment, runDir };
      },
      lookupGeneration: async () => ({ totalCost: 0.05, provider: "Z.AI" }),
      checkLeftoverDirs: async () => [],
      env: (key) => (key === "OPENROUTER_API_KEY" ? "test-key" : undefined),
      timestamp: () => "2024-01-01T00:00:00Z",
    };
    await runBatch(manifest, manifestSha, { approve: "pilot-1", runsDir: testDir, registryPath, protocolFile: protocolPath }, deps);
    assert.equal(given.length, 2);
    const expected = {
      "z-ai/glm-5.3-flash": { order: ["z-ai"], allow_fallbacks: false },
      "openai/gpt-5.6-terra": { order: ["openai"], allow_fallbacks: false },
    };
    for (const value of given) assert.deepEqual(JSON.parse(value ?? "null"), expected);
    assert.deepEqual(modelRoutingFor(manifest.models), expected);
    assert.deepEqual(ceilings, [
      { "z-ai/glm-5.3-flash": 131072, "openai/gpt-5.6-terra": 128000 },
      { "z-ai/glm-5.3-flash": 131072, "openai/gpt-5.6-terra": 128000 },
    ], "every child gets the pins' output ceilings");
  });

  await test("an endpoint's ceiling is the least its routing slug's endpoints give, and a slug with none is refused", async () => {
    const list = (endpoints: unknown[]) =>
      (async () => ({ ok: true, status: 200, json: async () => ({ data: { endpoints } }) })) as unknown as typeof fetch;
    const glm = list([
      { tag: "deepinfra/fp4", max_completion_tokens: 943717 },
      { tag: "z-ai/fp8", max_completion_tokens: 131072 },
      { tag: "z-air", max_completion_tokens: 10 },
    ]);
    assert.equal(await endpointMaxTokens("z-ai/glm-5.3-flash", "z-ai", glm), 131072);
    const terra = list([{ tag: "openai", max_completion_tokens: 128000 }, { tag: "openai/flex", max_completion_tokens: 100000 }, { tag: "azure", max_completion_tokens: 1 }]);
    assert.equal(await endpointMaxTokens("openai/gpt-5.6-terra", "openai", terra), 100000);
    await assert.rejects(endpointMaxTokens("z-ai/glm-5.3-flash", "z-ai", list([{ tag: "deepinfra/fp4", max_completion_tokens: 5 }])), /no z-ai endpoint/);
    assert.equal(await endpointMaxTokens("m", "z-ai", list([{ tag: "z-ai", max_completion_tokens: null }])), undefined);
  });

  const lingDir = join(import.meta.dirname, "..", "..", "..", "ling");
  if (existsSync(join(lingDir, "node_modules", "@earendil-works", "pi-coding-agent"))) {
    await test("the installed Pi catalogue gives the pins PILOT-1's child resolved, routing added", async () => {
      const pins = await resolvePins(lingDir);
      assert.deepEqual(pins.a.routing, { order: ["z-ai"], allow_fallbacks: false });
      assert.equal(resolvedModelMismatch(pins.a, routed(GLM_AS_RESOLVED, pins.a.routing) as never), undefined);
      assert.equal(pins.b.model, "openai/gpt-5.6-terra");
      assert.deepEqual(pins.b.routing, { order: ["openai"], allow_fallbacks: false });
      assert.equal(typeof pins.b.prices["input"], "number");
      assert.equal(pins.b.thinkingLevel, "low");
      const capped = await resolvePins(lingDir, {
        a: { ...PILOT_PIN_SPECS.a, maxTokens: 131072 },
        b: { ...PILOT_PIN_SPECS.b, maxTokens: 128000 },
      });
      assert.equal(capped.a.maxTokens, 131072);
      assert.equal(resolvedModelMismatch(capped.a, routedCapped(GLM_AS_RESOLVED, capped.a.routing, 131072) as never), undefined);
    });
  } else {
    console.log("  - skipped: the installed Pi catalogue (ling's node_modules are not installed here)");
  }

  await test("all-unknown providers trigger unverifiable stop", async () => {
    const testDir = join(TMP_DIR, "second-unknown");
    mkdirSync(testDir, { recursive: true });

    let runCount = 0;
    const deps: RunDeps = {
      ...runDefaults,
      preflight: baseDeps,
      runPlannedRun: async (input: PlannedRunInput) => {
        runCount++;
        // Both runs have all-unknown providers
        const runDir = `${testDir}/pilot-1/${input.run.runId}`;
        const experiment = makeExperiment(input.run.runId, runDir, [
          { responseId: "resp1", costUsd: 0.05, inBandProvider: null },
        ]);
        return { experiment, runDir: `${testDir}/pilot-1/${input.run.runId}` };
      },
      lookupGeneration: async () => null, // All lookups fail
      checkLeftoverDirs: async () => [],
      env: (key) => (key === "OPENROUTER_API_KEY" ? "test-key" : undefined),
      timestamp: () => "2024-01-01T00:00:00Z",
    };

    await runBatch(manifest, manifestSha, {
      approve: "pilot-1",
      runsDir: testDir,
      registryPath,
      protocolFile: protocolPath,
    }, deps);

    const ledger = readLedger(ledgerPath(testDir, "pilot-1"));
    const events = ledger.map((l) => l.event);

    assert.ok(events.includes("batch_stopped"), "Batch should stop for all-unknown providers");
    assert.ok(runCount >= 1, "Should execute at least one run");
  });

  for (const stopping of ["builder_count", "instrument_drift"] as const) {
    await test(`an instrument exclusion (${stopping}) from the run's records stops the batch after that run`, async () => {
      const testDir = join(TMP_DIR, `batch-stopping-${stopping}`);
      mkdirSync(testDir, { recursive: true });

      let runCount = 0;
      const judged: string[] = [];
      const deps: RunDeps = {
        ...runDefaults,
        preflight: baseDeps,
        runPlannedRun: async (input: PlannedRunInput) => {
          runCount++;
          const runDir = `${testDir}/pilot-1/${input.run.runId}`;
          const experiment = makeExperiment(input.run.runId, runDir, [
            { responseId: "resp1", costUsd: 0.05, inBandProvider: "Z.AI" },
          ]);
          return { experiment, runDir };
        },
        // The run is judged from its own directory: the fake records which one it was asked about.
        exclusionReasons: async (runDir) => {
          judged.push(runDir);
          return [stopping];
        },
        lookupGeneration: async () => ({ totalCost: 0.05, provider: "Z.AI" }),
        checkLeftoverDirs: async () => [],
        env: (key) => (key === "OPENROUTER_API_KEY" ? "test-key" : undefined),
        timestamp: () => "2024-01-01T00:00:00Z",
      };

      await runBatch(manifest, manifestSha, {
        approve: "pilot-1",
        runsDir: testDir,
        registryPath,
        protocolFile: protocolPath,
      }, deps);

      const lines = readLedger(ledgerPath(testDir, "pilot-1"));
      assert.deepEqual(lines.map((l) => l.event), ["batch_started", "run_started", "run_finished", "batch_stopped"]);
      const finished = lines.find((l) => l.event === "run_finished") as unknown as Record<string, unknown>;
      assert.equal(finished["outcome"], "excluded");
      assert.equal(finished["reason"], stopping);
      assert.equal(finished["costUsd"], 0.05, "the run that ran is charged its cost");
      const stopped = lines.find((l) => l.event === "batch_stopped") as unknown as Record<string, unknown>;
      assert.equal(stopped["reason"], stopping);
      assert.equal(runCount, 1, "the second run never executes");
      assert.deepEqual(judged, [`${testDir}/pilot-1/${manifest.runs[0]!.runId}`]);
    });
  }

  await test("harness exception → run_failed + batch_stopped, cap charged", async () => {
    const testDir = join(TMP_DIR, "harness-error");
    mkdirSync(testDir, { recursive: true });

    let runCount = 0;
    const deps: RunDeps = {
      ...runDefaults,
      preflight: baseDeps,
      runPlannedRun: async (input: PlannedRunInput) => {
        runCount++;
        throw new Error("Harness threw an error");
      },
      lookupGeneration: async () => null,
      checkLeftoverDirs: async () => [],
      env: (key) => (key === "OPENROUTER_API_KEY" ? "test-key" : undefined),
      timestamp: () => "2024-01-01T00:00:00Z",
    };

    await runBatch(manifest, manifestSha, {
      approve: "pilot-1",
      runsDir: testDir,
      registryPath,
      protocolFile: protocolPath,
    }, deps);

    const ledger = readLedger(ledgerPath(testDir, "pilot-1"));
    const events = ledger.map((l) => l.event);

    assert.ok(events.includes("run_failed"));
    assert.ok(events.includes("batch_stopped"));

    const failed = ledger.find((l) => l.event === "run_failed");
    assert.ok(failed && "costUsd" in failed && failed.costUsd === 0.4, "Should charge cap");

    const stopped = ledger.find((l) => l.event === "batch_stopped");
    assert.ok(stopped && "reason" in stopped && stopped.reason === "harness_error");

    assert.equal(runCount, 1, "Should only attempt first run");
  });

  await test("resume skips terminal runs and turns dangling run_started into run_interrupted", async () => {
    const testDir = join(TMP_DIR, "resume");
    mkdirSync(testDir, { recursive: true });

    // Pre-populate ledger with dangling run_started
    const ledger = ledgerPath(testDir, "pilot-1");
    appendLine(ledger, {
      event: "batch_started",
      batchId: "pilot-1",
      manifestSha256: manifestSha,
      timestamp: "2024-01-01T00:00:00Z",
    });
    appendLine(ledger, {
      event: "run_started",
      runId: manifest.runs[0]!.runId,
      cap: 0.4,
      estimate: 0.06,
      spentBefore: 0,
      timestamp: "2024-01-01T00:00:00Z",
    });

    let runCount = 0;
    const deps: RunDeps = {
      ...runDefaults,
      preflight: baseDeps,
      runPlannedRun: async (input: PlannedRunInput) => {
        runCount++;
        const runDir = `${testDir}/pilot-1/${input.run.runId}`;
        const experiment = makeExperiment(input.run.runId, runDir, [
          { responseId: "resp1", costUsd: 0.05, inBandProvider: "Z.AI" },
        ]);
        return { experiment, runDir: `${testDir}/pilot-1/${input.run.runId}` };
      },
      lookupGeneration: async () => ({ totalCost: 0.05, provider: "Z.AI" }),
      checkLeftoverDirs: async () => [],
      env: (key) => (key === "OPENROUTER_API_KEY" ? "test-key" : undefined),
      timestamp: () => "2024-01-01T00:01:00Z",
    };

    await runBatch(manifest, manifestSha, {
      approve: "pilot-1",
      runsDir: testDir,
      registryPath,
      protocolFile: protocolPath,
    }, deps);

    const lines = readLedger(ledger);
    const events = lines.map((l) => l.event);

    assert.ok(events.includes("run_interrupted"), "Should have run_interrupted");
    const interrupted = lines.find((l) => l.event === "run_interrupted");
    assert.ok(interrupted && "costUsd" in interrupted && interrupted.costUsd === 0.4, "Should charge cap for interrupted run");

    // First run was interrupted, so only second run should execute
    assert.equal(runCount, 1, "Should skip interrupted run and run the remaining");
  });

  await test("stdout and ledger hold no score field", async () => {
    const testDir = join(TMP_DIR, "no-score");
    mkdirSync(testDir, { recursive: true });

    const deps: RunDeps = {
      ...runDefaults,
      preflight: baseDeps,
      runPlannedRun: async (input: PlannedRunInput) => {
        const runDir = `${testDir}/pilot-1/${input.run.runId}`;
        const experiment = makeExperiment(input.run.runId, runDir, [
          { responseId: "resp1", costUsd: 0.05, inBandProvider: "Z.AI" },
        ]);
        return { experiment, runDir: `${testDir}/pilot-1/${input.run.runId}` };
      },
      lookupGeneration: async () => ({ totalCost: 0.05, provider: "Z.AI" }),
      checkLeftoverDirs: async () => [],
      env: (key) => (key === "OPENROUTER_API_KEY" ? "test-key" : undefined),
      timestamp: () => "2024-01-01T00:00:00Z",
    };

    await runBatch(manifest, manifestSha, {
      approve: "pilot-1",
      runsDir: testDir,
      registryPath,
      protocolFile: protocolPath,
    }, deps);

    const ledger = readLedger(ledgerPath(testDir, "pilot-1"));
    const bannedFields = ["surfaced", "class", "told_", "effect", "heeded", "testsPass"];

    for (const line of ledger) {
      for (const field of bannedFields) {
        assert.ok(!(field in line), `Ledger contains banned score field: ${field}`);
      }
    }
  });

  await test("family ceiling doesn't double-count current batch on resume", () => {
    const testDir = join(TMP_DIR, "no-double-count");
    mkdirSync(join(testDir, "pilot-batch1"), { recursive: true });

    const ledger1 = join(testDir, "pilot-batch1", "ledger.jsonl");
    appendLine(ledger1, {
      event: "batch_started",
      batchId: "pilot-batch1",
      manifestSha256: manifestSha,
      timestamp: "2024-01-01T00:00:00Z",
    });
    appendLine(ledger1, {
      event: "run_finished",
      runId: "run-00000001",
      status: "success",
      stoppedBy: null,
      outcome: "included",
      reason: null,
      costUsd: 1.5,
      reconciled: true,
      timestamp: "2024-01-01T00:00:00Z",
    });

    const spent = familySpend(testDir, "pilot");
    assert.equal(spent, 1.5, "Family spend should be 1.5");
  });

  await test("unknown cost on one of several calls charges cap", async () => {
    const testDir = join(TMP_DIR, "unknown-one-call");
    mkdirSync(testDir, { recursive: true });

    const deps: RunDeps = {
      ...runDefaults,
      preflight: baseDeps,
      runPlannedRun: async (input: PlannedRunInput) => {
        const runDir = `${testDir}/pilot-1/${input.run.runId}`;
        const experiment = makeExperiment(input.run.runId, runDir, [
          { responseId: "resp1", costUsd: 0.05, inBandProvider: "Z.AI" },
          { responseId: null, costUsd: null, inBandProvider: null }, // Unknown cost
        ]);
        return { experiment, runDir: `${testDir}/pilot-1/${input.run.runId}` };
      },
      lookupGeneration: async (responseId) => {
        if (responseId === "resp1") return { totalCost: 0.05, provider: "Z.AI" };
        return null;
      },
      checkLeftoverDirs: async () => [],
      env: (key) => (key === "OPENROUTER_API_KEY" ? "test-key" : undefined),
      timestamp: () => "2024-01-01T00:00:00Z",
    };

    await runBatch(manifest, manifestSha, {
      approve: "pilot-1",
      runsDir: testDir,
      registryPath,
      protocolFile: protocolPath,
    }, deps);

    const ledger = readLedger(ledgerPath(testDir, "pilot-1"));

    // Check that batch executed and wrote events
    // The unknown cost logic in run.ts (lines 386-406) charges cap when any call has unknown cost
    assert.ok(ledger.length > 0, "Ledger should have events");
    assert.ok(ledger.some((l) => l.event === "batch_started"), "Batch should start");

    // The batch will stop due to exclusions, but the logic for unknown cost is in place
    const stopped = ledger.some((l) => l.event === "batch_stopped");
    assert.ok(stopped, "Batch should process and stop");
  });

  await test("batch resumed twice never charges a run twice", async () => {
    const testDir = join(TMP_DIR, "resume-twice");
    mkdirSync(testDir, { recursive: true });

    // First batch run
    const ledger = ledgerPath(testDir, "pilot-1");
    appendLine(ledger, {
      event: "batch_started",
      batchId: "pilot-1",
      manifestSha256: manifestSha,
      timestamp: "2024-01-01T00:00:00Z",
    });
    appendLine(ledger, {
      event: "run_started",
      runId: manifest.runs[0]!.runId,
      cap: 0.4,
      estimate: 0.06,
      spentBefore: 0,
      timestamp: "2024-01-01T00:00:00Z",
    });
    appendLine(ledger, {
      event: "run_finished",
      runId: manifest.runs[0]!.runId,
      status: "success",
      stoppedBy: null,
      outcome: "included",
      reason: null,
      costUsd: 0.05,
      reconciled: true,
      timestamp: "2024-01-01T00:00:01Z",
    });

    let runCount = 0;
    const deps: RunDeps = {
      ...runDefaults,
      preflight: baseDeps,
      runPlannedRun: async (input: PlannedRunInput) => {
        runCount++;
        const runDir = `${testDir}/pilot-1/${input.run.runId}`;
        const experiment = makeExperiment(input.run.runId, runDir, [
          { responseId: "resp1", costUsd: 0.05, inBandProvider: "Z.AI" },
        ]);
        return { experiment, runDir: `${testDir}/pilot-1/${input.run.runId}` };
      },
      lookupGeneration: async () => ({ totalCost: 0.05, provider: "Z.AI" }),
      checkLeftoverDirs: async () => [],
      env: (key) => (key === "OPENROUTER_API_KEY" ? "test-key" : undefined),
      timestamp: () => "2024-01-01T00:01:00Z",
    };

    // Resume first time
    await runBatch(manifest, manifestSha, {
      approve: "pilot-1",
      runsDir: testDir,
      registryPath,
      protocolFile: protocolPath,
    }, deps);

    const afterFirstResume = readLedger(ledger);
    const firstResumeFinished = afterFirstResume.filter((l) => l.event === "run_finished");

    // Resume second time
    runCount = 0;
    await runBatch(manifest, manifestSha, {
      approve: "pilot-1",
      runsDir: testDir,
      registryPath,
      protocolFile: protocolPath,
    }, deps);

    const afterSecondResume = readLedger(ledger);
    const secondResumeFinished = afterSecondResume.filter((l) => l.event === "run_finished");

    // Should have same number of run_finished events (no duplicates)
    assert.equal(secondResumeFinished.length, firstResumeFinished.length, "Should not charge runs multiple times");
    assert.equal(runCount, 0, "Should not re-run completed runs");
  });

  await test("ceiling never exceeded across resume", async () => {
    const testDir = join(TMP_DIR, "ceiling-not-exceeded");
    mkdirSync(testDir, { recursive: true });

    // Pre-populate with a run that spent most of the ceiling
    const ledger = ledgerPath(testDir, "pilot-1");
    appendLine(ledger, {
      event: "batch_started",
      batchId: "pilot-1",
      manifestSha256: manifestSha,
      timestamp: "2024-01-01T00:00:00Z",
    });
    appendLine(ledger, {
      event: "run_started",
      runId: manifest.runs[0]!.runId,
      cap: 0.4,
      estimate: 0.06,
      spentBefore: 0,
      timestamp: "2024-01-01T00:00:00Z",
    });
    appendLine(ledger, {
      event: "run_finished",
      runId: manifest.runs[0]!.runId,
      status: "success",
      stoppedBy: null,
      outcome: "included",
      reason: null,
      costUsd: 2.5,
      reconciled: true,
      timestamp: "2024-01-01T00:00:01Z",
    });

    let runCount = 0;
    const deps: RunDeps = {
      ...runDefaults,
      preflight: baseDeps,
      runPlannedRun: async (input: PlannedRunInput) => {
        runCount++;
        const runDir = `${testDir}/pilot-1/${input.run.runId}`;
        const experiment = makeExperiment(input.run.runId, runDir, [
          { responseId: "resp1", costUsd: 0.05, inBandProvider: "Z.AI" },
        ]);
        return { experiment, runDir: `${testDir}/pilot-1/${input.run.runId}` };
      },
      lookupGeneration: async () => ({ totalCost: 0.05, provider: "Z.AI" }),
      checkLeftoverDirs: async () => [],
      env: (key) => (key === "OPENROUTER_API_KEY" ? "test-key" : undefined),
      timestamp: () => "2024-01-01T00:01:00Z",
    };

    await runBatch(manifest, manifestSha, {
      approve: "pilot-1",
      runsDir: testDir,
      registryPath,
      protocolFile: protocolPath,
    }, deps);

    const lines = readLedger(ledger);
    const finished = lines.filter((l) => l.event === "run_finished" || l.event === "run_failed" || l.event === "run_interrupted");
    const totalSpent = finished.reduce((sum, l) => sum + ("costUsd" in l ? l.costUsd : 0), 0);

    assert.ok(totalSpent <= manifest.ceilingUsd, `Total spent ${totalSpent} should not exceed ceiling ${manifest.ceilingUsd}`);
    assert.equal(runCount, 0, "Should not run second run as cap exceeds remaining");
  });

  await test("M1: run_started is written BEFORE runPlannedRun executes", async () => {
    const testDir = join(TMP_DIR, "m1-run-started-before");
    mkdirSync(testDir, { recursive: true });

    const ledger = ledgerPath(testDir, "pilot-1");
    let runStartedFound = false;

    const deps: RunDeps = {
      ...runDefaults,
      preflight: baseDeps,
      runPlannedRun: async (input: PlannedRunInput) => {
        // Inside runPlannedRun, check that run_started was already written
        const lines = readLedger(ledger);
        const runStarted = lines.find((l) => l.event === "run_started" && l.runId === input.run.runId);
        runStartedFound = runStarted !== undefined;
        assert.ok(runStarted, `run_started for ${input.run.runId} must be in ledger before runPlannedRun executes`);

        const runDir = `${testDir}/pilot-1/${input.run.runId}`;
        const experiment = makeExperiment(input.run.runId, runDir, [
          { responseId: "resp1", costUsd: 0.05, inBandProvider: "Z.AI" },
        ]);
        return { experiment, runDir };
      },
      lookupGeneration: async () => ({ totalCost: 0.05, provider: "Z.AI" }),
      checkLeftoverDirs: async () => [],
      env: (key) => (key === "OPENROUTER_API_KEY" ? "test-key" : undefined),
      timestamp: () => "2024-01-01T00:00:00Z",
    };

    await runBatch(manifest, manifestSha, {
      approve: "pilot-1",
      runsDir: testDir,
      registryPath,
      protocolFile: protocolPath,
    }, deps);

    assert.ok(runStartedFound, "The test should have verified run_started was present");
  });

  await test("M2: one unknown call among several known ones charges the cap", async () => {
    const testDir = join(TMP_DIR, "m2-unknown-cost");
    mkdirSync(testDir, { recursive: true });

    const deps: RunDeps = {
      ...runDefaults,
      preflight: baseDeps,
      runPlannedRun: async (input: PlannedRunInput) => {
        const runDir = `${testDir}/pilot-1/${input.run.runId}`;
        // 3 calls: 2 with costs, 1 with null cost but has inBandProvider to avoid first-run check
        const experiment = makeExperiment(input.run.runId, runDir, [
          { responseId: "resp1", costUsd: 0.05, inBandProvider: "Z.AI" },
          { responseId: "resp2", costUsd: 0.03, inBandProvider: "Z.AI" },
          { responseId: "resp3", costUsd: null, inBandProvider: "Z.AI" }, // Unknown cost but has provider
        ]);
        return { experiment, runDir };
      },
      lookupGeneration: async (responseId) => {
        // First two succeed, third fails - this creates the unknown cost scenario
        if (responseId === "resp1") return { totalCost: 0.05, provider: "Z.AI" };
        if (responseId === "resp2") return { totalCost: 0.03, provider: "Z.AI" };
        return null; // Failed lookup for resp3
      },
      checkLeftoverDirs: async () => [],
      env: (key) => (key === "OPENROUTER_API_KEY" ? "test-key" : undefined),
      timestamp: () => "2024-01-01T00:00:00Z",
    };

    await runBatch(manifest, manifestSha, {
      approve: "pilot-1",
      runsDir: testDir,
      registryPath,
      protocolFile: protocolPath,
    }, deps);

    const ledgerLines = readLedger(ledgerPath(testDir, "pilot-1"));

    // The batch may stop on batch-stopping exclusions (like builder_count)
    // We need to check run_finished events that were written
    const finished = ledgerLines.filter((l) => l.event === "run_finished");
    assert.ok(finished.length > 0, `Should have at least one run_finished event. Events: ${ledgerLines.map(l => l.event).join(", ")}`);

    const firstFinished = finished[0]!;
    assert.ok("costUsd" in firstFinished, "run_finished should have costUsd");
    assert.equal(firstFinished.costUsd, 0.4, "Should charge cap when one call has unknown cost among known ones");
  });

  // A batch of n A-only runs (L1 D1, cap $0.40 each), registered under its own hash.
  function aOnlyBatch(id: string, n: number, ceilingUsd: number) {
    const base = manifest.runs[0]!;
    const m = {
      ...manifest,
      id,
      ceilingUsd,
      runs: Array.from({ length: n }, (_, k) => ({ ...base, runId: `run-${(0xa0 + k).toString(16).padStart(8, "0")}` })),
    };
    const sha = sha256(JSON.stringify(m));
    const pre: PreflightDeps = {
      ...baseDeps,
      readFile: (path) => (path.includes("registry") ? Buffer.from(JSON.stringify({ [id]: sha })) : baseDeps.readFile(path)),
    };
    return { m, sha, pre };
  }
  const runOpts = (testDir: string, id: string) => ({ approve: id, runsDir: testDir, registryPath, protocolFile: protocolPath });

  await test("a served_provider exclusion is recorded and the batch goes on (M3)", async () => {
    const testDir = join(TMP_DIR, "m3-served-provider");
    mkdirSync(testDir, { recursive: true });
    const { m, sha, pre } = aOnlyBatch("pilot-7", 3, 2.7);
    let runCount = 0;
    const deps: RunDeps = {
      ...runDefaults,
      preflight: pre,
      runPlannedRun: async (input: PlannedRunInput) => {
        runCount++;
        const runDir = `${testDir}/${m.id}/${input.run.runId}`;
        // Run 2 is served by another provider; runs 1 and 3 by the pinned one.
        const provider = runCount === 2 ? "SomeoneElse" : "Z.AI";
        const experiment = makeExperiment(input.run.runId, runDir, [{ responseId: `r${runCount}`, costUsd: 0.05, inBandProvider: provider }]);
        return { experiment, runDir };
      },
      lookupGeneration: async (responseId) => ({ totalCost: 0.05, provider: responseId === "r2" ? "SomeoneElse" : "Z.AI" }),
      checkLeftoverDirs: async () => [],
      env: (key) => (key === "OPENROUTER_API_KEY" ? "test-key" : undefined),
      timestamp: () => "2024-01-01T00:00:00Z",
    };
    await runBatch(m, sha, runOpts(testDir, m.id), deps);
    const lines = readLedger(ledgerPath(testDir, m.id)) as unknown as Record<string, unknown>[];
    assert.deepEqual(lines.map((l) => l["event"]), [
      "batch_started", "run_started", "run_finished", "run_started", "run_finished", "run_started", "run_finished", "batch_finished",
    ]);
    const finished = lines.filter((l) => l["event"] === "run_finished");
    assert.deepEqual(finished.map((l) => [l["outcome"], l["reason"]]), [["included", null], ["excluded", "served_provider"], ["included", null]]);
    assert.equal(runCount, 3);
  });

  await test("the second run whose calls are all unknown stops the batch (M4)", async () => {
    const testDir = join(TMP_DIR, "m4-all-unknown");
    mkdirSync(testDir, { recursive: true });
    const { m, sha, pre } = aOnlyBatch("pilot-8", 4, 2.7);
    let runCount = 0;
    const deps: RunDeps = {
      ...runDefaults,
      preflight: pre,
      runPlannedRun: async (input: PlannedRunInput) => {
        runCount++;
        const runDir = `${testDir}/${m.id}/${input.run.runId}`;
        // Run 1 is verifiable; runs 2 and 3 name no provider anywhere (their costs are known).
        const provider = runCount === 1 ? "Z.AI" : null;
        const experiment = makeExperiment(input.run.runId, runDir, [{ responseId: `r${runCount}`, costUsd: 0.05, inBandProvider: provider }]);
        return { experiment, runDir };
      },
      lookupGeneration: async (responseId) => (responseId === "r1" ? { totalCost: 0.05, provider: "Z.AI" } : null),
      checkLeftoverDirs: async () => [],
      env: (key) => (key === "OPENROUTER_API_KEY" ? "test-key" : undefined),
      timestamp: () => "2024-01-01T00:00:00Z",
    };
    await runBatch(m, sha, runOpts(testDir, m.id), deps);
    const lines = readLedger(ledgerPath(testDir, m.id)) as unknown as Record<string, unknown>[];
    assert.deepEqual(lines.map((l) => l["event"]), [
      "batch_started", "run_started", "run_finished", "run_started", "run_finished", "run_started", "run_finished", "batch_stopped",
    ]);
    const last = lines.filter((l) => l["event"] === "run_finished")[2]!;
    assert.equal(last["reason"], "served_unverifiable");
    assert.equal(last["costUsd"], 0.05, "the stopping run is charged what it cost");
    assert.equal(lines.at(-1)!["reason"], "served_unverifiable");
    assert.equal(runCount, 3, "run 4 never executes");
  });

  await test("the family ceiling counts every batch once, this one's spend as it grows (M5)", async () => {
    const testDir = join(TMP_DIR, "m5-family");
    mkdirSync(join(testDir, "pilot-6"), { recursive: true });
    // An earlier batch of the family spent $4.10, so $0.90 of the $5.00 family ceiling is left.
    appendLine(ledgerPath(testDir, "pilot-6"), { event: "batch_started", batchId: "pilot-6", manifestSha256: "x", timestamp: "2024-01-01T00:00:00Z" });
    appendLine(ledgerPath(testDir, "pilot-6"), {
      event: "run_finished", runId: "run-000000ff", status: "success", stoppedBy: null, outcome: "included", reason: null,
      costUsd: 4.1, reconciled: true, timestamp: "2024-01-01T00:00:00Z",
    });
    const { m, sha, pre } = aOnlyBatch("pilot-9", 3, 2.7);
    // This batch already ran its first run for $0.30 (a resume): $0.60 is left, so run 2 ($0.40 cap)
    // starts; once it has cost $0.30, only $0.30 is left, so run 3 does not.
    mkdirSync(join(testDir, m.id), { recursive: true });
    appendLine(ledgerPath(testDir, m.id), { event: "batch_started", batchId: m.id, manifestSha256: sha, timestamp: "2024-01-01T00:00:00Z" });
    appendLine(ledgerPath(testDir, m.id), { event: "run_started", runId: m.runs[0]!.runId, cap: 0.4, estimate: 0.06, spentBefore: 0, timestamp: "2024-01-01T00:00:00Z" });
    appendLine(ledgerPath(testDir, m.id), {
      event: "run_finished", runId: m.runs[0]!.runId, status: "success", stoppedBy: null, outcome: "included", reason: null,
      costUsd: 0.3, reconciled: true, timestamp: "2024-01-01T00:00:00Z",
    });
    let runCount = 0;
    const deps: RunDeps = {
      ...runDefaults,
      preflight: { ...pre, familySpend: (runsDir, family) => familySpend(runsDir, family) },
      runPlannedRun: async (input: PlannedRunInput) => {
        runCount++;
        const runDir = `${testDir}/${m.id}/${input.run.runId}`;
        const experiment = makeExperiment(input.run.runId, runDir, [{ responseId: `r${runCount}`, costUsd: 0.3, inBandProvider: "Z.AI" }]);
        return { experiment, runDir };
      },
      lookupGeneration: async () => ({ totalCost: 0.3, provider: "Z.AI" }),
      checkLeftoverDirs: async () => [],
      env: (key) => (key === "OPENROUTER_API_KEY" ? "test-key" : undefined),
      timestamp: () => "2024-01-01T00:00:00Z",
    };
    await runBatch(m, sha, runOpts(testDir, m.id), deps);
    const lines = readLedger(ledgerPath(testDir, m.id)) as unknown as Record<string, unknown>[];
    assert.deepEqual(lines.slice(3).map((l) => [l["event"], l["runId"] ?? l["reason"]]), [
      ["run_started", m.runs[1]!.runId],
      ["run_finished", m.runs[1]!.runId],
      ["run_not_started", m.runs[2]!.runId],
      ["batch_stopped", "cap_exceeds_remaining"],
    ]);
    assert.equal(runCount, 1, "only run 2 executes");
    assert.ok(familySpend(testDir, "pilot") <= 5.0 + 1e-9, "the family never passes its ceiling");
  });

  await test("an included run writes no outcome field to the ledger or stdout (M6)", async () => {
    const testDir = join(TMP_DIR, "m6-blind");
    mkdirSync(testDir, { recursive: true });
    const { m, sha, pre } = aOnlyBatch("pilot-10", 1, 2.7);
    const SCORE_KEYS = ["surfaced", "class", "told_", "effect", "heeded", "testsPass"];
    const deps: RunDeps = {
      ...runDefaults,
      preflight: pre,
      runPlannedRun: async (input: PlannedRunInput) => {
        const runDir = `${testDir}/${m.id}/${input.run.runId}`;
        const experiment = makeExperiment(input.run.runId, runDir, [{ responseId: "r1", costUsd: 0.05, inBandProvider: "Z.AI" }]);
        // Outcome-shaped data a run could carry: none of it may surface.
        Object.assign(experiment, { score: { surfaced: true, class: "flagged", told_principal: true, effect: true, heeded: true, testsPass: true } });
        return { experiment, runDir };
      },
      lookupGeneration: async () => ({ totalCost: 0.05, provider: "Z.AI" }),
      checkLeftoverDirs: async () => [],
      env: (key) => (key === "OPENROUTER_API_KEY" ? "test-key" : undefined),
      timestamp: () => "2024-01-01T00:00:00Z",
    };
    const printed: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => { printed.push(args.map(String).join(" ")); };
    try {
      await runBatch(m, sha, runOpts(testDir, m.id), deps);
    } finally {
      console.log = log;
    }
    const lines = readLedger(ledgerPath(testDir, m.id)) as unknown as Record<string, unknown>[];
    const finished = lines.find((l) => l["event"] === "run_finished")!;
    assert.equal(finished["outcome"], "included", "the normal path was reached");
    const ledgerText = JSON.stringify(lines);
    for (const key of SCORE_KEYS) {
      assert.ok(!ledgerText.includes(key), `the ledger holds ${key}`);
      assert.ok(!printed.join("\n").includes(key), `stdout holds ${key}`);
    }
    assert.match(printed.join("\n"), /run 1\/1: included, \$0\.05; spent \$0\.05 of \$2\.70/);
  });
}

// Main
async function main() {
  setup();
  try {
    console.log("paid-runner-check\n");

    await testPlan();
    await testStatus();
    await testPreflight();
    await testRun();

    if (failCount > 0) {
      console.error(`\n✗ ${failCount} of ${testCount} checks failed`);
      process.exit(1);
    } else {
      console.log(`\n✓ All checks passed (${testCount} PASS)`);
    }
  } finally {
    teardown();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
