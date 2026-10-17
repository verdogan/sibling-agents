/**
 * The experiment end to end at $0 (pilot build plan §4.1): planned runs
 * composed into real single-slice campaigns, run by the real driver with
 * scripted children, captured and scored, and the score compared with each
 * pre-registered fixture's declared fields.
 *
 * Phases run in a fixed order: `static` (the composer against
 * initializeCampaign, paid shapes included; no ling starts), then `smoke`,
 * `dry-runs`, `fixtures`, `regressions` and `canary`, which start scripted
 * lings. The canary runs last and alone: its check that no new `pi-bash-*`
 * file appeared in host temp could catch another run's. A phase not built
 * yet prints SKIP and is neither a pass nor a failure.
 *
 * Not in `npm run check`. Run it with `npm run experiment-e2e-check`, with
 * `-- --only <phase|fixture id>[,...]`, `--concurrency <n>` (default 1),
 * `--keep` (keep the scratch directory when a check fails) and
 * `--digests-out <file>`. Nothing here is paid: every child is scripted, the
 * scratch ling directory has no `.env`, and the composer refuses an offline
 * run whose pins are not scripted.
 */
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SCORER_FIXTURES } from "../experiment/fixtures/index.js";
import { dryRunsPhase } from "./experiment-e2e/dry-runs.js";
import { fixturesPhase } from "./experiment-e2e/fixtures.js";
import { canaryPhase, regressionsPhase, smokePhase } from "./experiment-e2e/regressions.js";
import { staticPhase } from "./experiment-e2e/static.js";
import {
  Report,
  SOURCE_LING_DIR,
  makeLingScratch,
  unlinkJunction,
  type LingScratch,
  type PhaseContext,
} from "./experiment-e2e/support.js";

const PHASES = ["static", "smoke", "dry-runs", "fixtures", "regressions", "canary"] as const;
type Phase = (typeof PHASES)[number];

/** Each phase's runner; null for one a later W3-A package builds. */
const RUNNERS: Record<Phase, ((context: PhaseContext) => Promise<void>) | null> = {
  static: staticPhase,
  smoke: smokePhase,
  "dry-runs": dryRunsPhase,
  fixtures: fixturesPhase,
  regressions: regressionsPhase,
  canary: canaryPhase,
};

interface Options {
  phases: Set<Phase>;
  fixtureIds: string[] | null;
  concurrency: number;
  keep: boolean;
  digestsOut: string | null;
}

function usage(message: string): never {
  console.error(`experiment-e2e-check: ${message}`);
  console.error(
    "usage: experiment-e2e-check [--only <phase|fixture id>[,...]] [--concurrency <n>] [--keep] [--digests-out <file>]",
  );
  process.exit(2);
}

function parseOptions(argv: readonly string[]): Options {
  const options: Options = {
    phases: new Set(PHASES),
    fixtureIds: null,
    concurrency: 1,
    keep: false,
    digestsOut: null,
  };
  const fixtureIds = new Set(SCORER_FIXTURES.map((fixture) => fixture.id));
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) usage(`${flag} needs a value`);
      index += 1;
      return next;
    };
    if (flag === "--only") {
      const phases = new Set<Phase>();
      const fixtures: string[] = [];
      for (const token of value().split(",").map((part) => part.trim()).filter(Boolean)) {
        if ((PHASES as readonly string[]).includes(token)) phases.add(token as Phase);
        else if (fixtureIds.has(token)) fixtures.push(token);
        else usage(`--only names no phase or fixture ${JSON.stringify(token)}`);
      }
      if (fixtures.length > 0) {
        phases.add("fixtures");
        options.fixtureIds = fixtures;
      }
      options.phases = phases;
    } else if (flag === "--concurrency") {
      const text = value();
      const concurrency = Number(text);
      if (!Number.isInteger(concurrency) || concurrency < 1) {
        usage(`--concurrency must be a positive integer, not ${JSON.stringify(text)}`);
      }
      options.concurrency = concurrency;
    } else if (flag === "--keep") {
      options.keep = true;
    } else if (flag === "--digests-out") {
      options.digestsOut = path.resolve(value());
    } else {
      usage(`unknown argument ${JSON.stringify(flag)}`);
    }
  }
  if (options.phases.size === 0) usage("--only selects nothing");
  // The fixtures are scored with the digests the dry runs register, so they need them first.
  if (options.phases.has("fixtures")) options.phases.add("dry-runs");
  return options;
}

const options = parseOptions(process.argv.slice(2));
const report = new Report();
const scratch = await mkdtemp(path.join(os.tmpdir(), "ling-experiment-e2e-"));
let lingScratch: Promise<LingScratch> | undefined;
try {
  const context: PhaseContext = {
    report,
    scratch,
    concurrency: options.concurrency,
    fixtureIds: options.fixtureIds,
    digestsOut: options.digestsOut,
    promptDigests: null,
    ling: () => (lingScratch ??= makeLingScratch(scratch)),
  };
  for (const phase of PHASES) {
    if (!options.phases.has(phase)) continue;
    const runner = RUNNERS[phase];
    if (runner === null) {
      report.skip(`phase ${phase}`, "not built yet (a later W3-A work package)");
      continue;
    }
    console.log(`\n# ${phase}`);
    const started = Date.now();
    await runner(context);
    console.log(`# ${phase} took ${((Date.now() - started) / 1000).toFixed(1)} s`);
  }
} catch (error) {
  // A phase that throws outside its checks fails the run, not just one check.
  report.failures += 1;
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`FAIL  phase aborted -- ${detail}`);
} finally {
  // The junction first, so that the removal below cannot reach the real
  // install; if it cannot be unlinked, the scratch is left in place.
  const unlinked =
    lingScratch === undefined
      ? true
      : await lingScratch.then((ling) => unlinkJunction(ling.junction)).catch(() => false);
  if (!unlinked) {
    report.failures += 1;
    console.error(`FAIL  the scratch ling junction could not be unlinked; left ${scratch} in place`);
  } else if (options.keep && report.failures > 0) {
    console.log(`kept the scratch directory ${scratch}`);
  } else {
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
      () => undefined,
    );
  }
}

// The check never reaches the real install (HANDOVER §7).
await report.check("ling/node_modules/tsx is still installed", () =>
  access(path.join(SOURCE_LING_DIR, "node_modules", "tsx", "package.json")),
);
console.log(`\n${report.summary()}`);
process.exit(report.failures === 0 ? 0 : 1);
