# A-model choice (protocol revision 3, §1.1)

**Chosen:** `z-ai/glm-5.3-flash` via OpenRouter, thinking `low` (its registry map sends `low` for
`low`). Decided by the owner on 2026-10-07, before PILOT-1 was registered and before any pilot or
scenario outcome existed. B stays `openai/gpt-5.6-terra`.

## What the choice used, and what it did not

Only the repository's `npm run smoke` task: write `./scripts/hello.mjs` that prints the UTC time,
run it with bash, and write `result.json` with `data.timestamp` set to the printed value. None of the
protocol's scenarios, seed files, defects or scoring rules were run or consulted, so nothing the
protocol scores informed the choice.

Every run used the same ling (Pi 1.0.3, commit `8aac057` for the matcher fix; the runs themselves
on `7b1beba`), provider `openrouter`, and caps `MAX_COST_USD=0.25`, `MAX_TURNS=20`,
`MAX_WALL_CLOCK_MS=300000`, applied by environment override and confirmed from the effective config
before spending. Thinking was the `.env` default, `medium`, for every candidate. For GLM that level
maps to `null` in the registry, so its smoke runs did not run at the `low` the protocol will use;
this is a known difference between the evidence and the frozen setting.

## Runs

| Model | Run | Turns | Cost (USD) | Tool calls | Tool errors | `write_result` calls | Empty-argument calls | Smoke check |
|---|---|---|---|---|---|---|---|---|
| `deepseek/deepseek-v4.1-flash` | 1 | 4 | 0.0027 | 4 | 0 | 1 | 0 | passed (old matcher) |
| `deepseek/deepseek-v4.1-flash` | 2 | 16 | 0.0087 | 15 | 3 | 9 | 3 | passed |
| `qwen/qwen3.8-flash` | 1 | 6 | 0.0023 | 5 | 0 | 1 | 0 | failed under the old matcher; passes under the fixed one |
| `qwen/qwen3.8-flash` | 2 | 7 | 0.0027 | 7 | 0 | 1 | 0 | failed under the old matcher; passes under the fixed one |
| `z-ai/glm-5.3-flash` | 1 | 5 | 0.0018 | 4 | 0 | 1 | 0 | passed |
| `z-ai/glm-5.3-flash` | 2 | 6 | 0.0020 | 5 | 1 | 1 | 0 | passed |

The Qwen failures were the smoke check's, not the model's: each run printed the timestamp inside
its own echo (`stdout=[…Z]`), and the matcher then required a whole printed line to equal the
timestamp. Commit `8aac057` looks the timestamp up among the ISO timestamps the script printed; both
Qwen runs reported a value their script printed.

## What decided it

- **Declarations.** GLM declared the exact command it then ran (`node ./scripts/hello.mjs`) in both
  runs. Qwen declared only `node`. The intent experiments compare declarations against recorded
  actions, so a vague declaration weakens them.
- **Noise where the protocol measures.** DeepSeek's second run called tools with empty arguments
  three times and wrote `result.json` nine times, seven of them placeholders before any work,
  including a `"success"` with `timestamp: "x"`. That is the threat recorded in §9 item 13.
- **Paths.** Qwen wrote and ran through absolute Windows paths; the contamination rule resolves
  them, but GLM's relative paths need no resolution.
- **GLM's one tool error** was a first `declare_intent` without `hosts`, refused and immediately
  retried correctly.
- Cost was not a deciding factor; all three cost well under a cent per run.

## Limits

Two runs per model, on one task unlike the scenarios, at a thinking level the protocol will not
use for GLM. This is a screening for gross tool-use noise, not evidence about disposition, and the
application must not cite it as such.

Total spent on the comparison: about $0.020 (DeepSeek $0.011, Qwen $0.005, GLM $0.004).
