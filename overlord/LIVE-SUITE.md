# Live campaign suite

`npm run campaign-live-suite` runs six model-backed failure-path scenarios and
prints measured cost per scenario as JSON. `LIVE_SUITE_MAX_USD` defaults to
$2.00; the suite refuses to start when declared scenario budgets exceed it.

Declared worst-case cost:

- planning: $0.32 (planner, builder, reviewer, integration);
- revision: $0.40 (two builders, two reviewers, integration);
- URL reference bar: $0.24;
- command acceptance check: $0.24;
- budget exhaustion: $0.01 declared, $0 expected because no task may spawn;
- malformed worker result: $0.24. A real Ling worker runs, then a test-only
  overlord adapter corrupts the returned envelope at the HTTP boundary so the
  production parser handles the failure deterministically.

Total declared campaign budget is $1.45. The process-level hard cap remains
$2.00. The existing `npm run campaign-live-check` is the smaller three-task
happy-path smoke check.

Latest complete loopback measurement (2026-08-16): planning $0.066556,
revision $0.080516, URL reference bar $0.050062, command check $0.051087,
budget exhaustion $0, and malformed result $0.014941; total $0.263161.

`LIVE_REFERENCE_BAR_URL` defaults to `https://example.com/`. Add that host (or
the configured replacement) to the worker egress policy before running the
suite on a hardened fleet.

`npm run campaign-chaos-check` kills processes and is therefore opt-in:

```bash
LIVE_CHAOS_ALLOW_KILL=true npm run campaign-chaos-check
```

It refuses externally managed or multi-worker fleets. On an overlord-owned
single loopback worker it kills the overlord during a task and resumes, then
kills Ling during a second task and verifies durable recovery without
`--resume`. Its two campaigns each cap spend at $0.25. The 2026-08-16 loopback
run cost $0.053742 for overlord recovery and $0.059633 for Ling recovery.

For the production topology, set `LING_WORKERS_JSON` to at least two non-
loopback workers and run the same suite from the overlord host. A loopback run
does not satisfy the topology verification even when every scenario passes.

## Brain envelope compliance

`npm run brain-compliance-test` is the cheapest paid check and needs no worker
or fleet at all — only `OVERLORD_BRAIN_BASE_URL` and a model. It issues the
driver's own four decision requests (scheduling, reviewing, integration,
recovery) against a real endpoint and reports how often the reply is usable.

Run it before enabling `"brain": { "enabled": true }` on anything that matters.
A model whose reply the driver cannot parse fails every decision and the campaign
still completes on deterministic fallbacks, so the compliance rate is the only
thing separating a model-driven campaign from one the model never touched.

This is not hypothetical. Measured 2026-09-04, `gpt-5.6-terra` scores 20/20 —
but the first run scored 0/20, because the request sent `max_tokens` and
`temperature: 0` and every current reasoning model rejects both with an HTTP
400. Every brain-enabled campaign before that fix was running entirely on
fallbacks. The offline brain checks could not catch it: they stub `fetch` with a
handler that accepts any body, so they asserted the broken shape was sent
without ever asking whether a provider would take it. Treat this check as the
regression guard for the request contract, not just for model quality.

Defaults to 5 trials per phase, so 20 calls at a few cents total. Set
`BRAIN_COMPLIANCE_MODELS` to a comma-separated list to compare candidates, and
`BRAIN_COMPLIANCE_MIN_RATE` to fail the process below a threshold. The final
line of output is a JSON summary suitable for archiving alongside a run.

`overlord/brain-live-scenario.json` remains the full-campaign exercise: a
brain-enabled definition hard-capped at $2, run through `npm run campaign --
init` and `run`.
