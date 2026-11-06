# Factory bench (0.6)

The scorecard, the blind pairwise judge and the auto-grader. Plain Node 22, no dependencies beyond `gh` (logged in, for anything that reads GitHub; `gh run download` unpacks artifacts).

## The row

One row per Objective, read from the issue, the PR on `factory/<issue>`, the job log and the usage artifact (`factory-usage-<issue>`, plus `factory-usage-<issue>-review`):

| Number | What the row says | Taken from |
| --- | --- | --- |
| Walk-away | `yes`, or `no` with the first human action | Binary. The clock starts at the first `factory:objective` label. Any human push, comment, review, edit or draft/ready toggle on the branch or the issue after it breaks it. A Blocked card (label or marker comment) is a miss; an answered Question is a miss, named as such. `*[bot]` actors never count; `--bot LOGIN` adds another. |
| Solution quality | `pending` with the pair for the judge | The judge's, never the scorecard's. With `--baseline REF` the row carries the `judge.mjs` and `grade-auto.mjs` commands for the merged head against it; without, the owner's read of the merged diff. Escapes found after merge go in `quality.escapes`. |
| Operator minutes | `0`, a number, or `unknown` | `--minutes <issue>=<n>` from a stopwatch; `0` on a clean merge; otherwise `unknown`, never estimated. |
| Cost | dollars with unit and basis | Claude: `usd` from `total_cost_usd` + `modelUsage` (sub-agents in). Codex: `tokens` priced from `prices.json`, dated, **placeholder rates until replaced**. Copilot: `credits`, `unmetered`, attribute from org billing by the row's time window. Reviewer artifacts are summed with the worker's. Runner minutes and wall time (label to merge) sit beside it; wall time is never alone. |

A missing input shows as `missing: <which>` in the row, never as a guess.

Beside the four numbers the row carries, from the same sources: `phases` (setup and install, model, CI-wait and other minutes, read from each run's progress comment), `activity` (turns, harness calls, distinct sessions, work and review run counts, read from the usage artifacts), cost by component (uncached, cached, written and output tokens, and a per-model split), and the harness CLI version. The table shows them as Setup min, Model min, CI wait min, Turns, Runs and Sessions, and the cost cell as `$ (in / cached / written / out)`.

## Baseline

```sh
node bench/baseline.mjs --scorecard scorecard.json --repo OWNER/NAME --label wave0 --append   # median and p25..p75 of model minutes, turns, cost, cached and written tokens, CI wait, setup, wall minutes and sessions, plus walk-away rate
node bench/baseline.mjs --scorecard scorecard.json --repo OWNER/NAME --since 2026-11-06 --last 5
```

One line per label under `baselines` in the scorecard, so a change's before and after is one command.

## Drill

```sh
node bench/drill.mjs --repo OWNER/SCRATCH --count 2 --dispatch                 # small: one-function additions, merged in minutes
node bench/drill.mjs --repo OWNER/SCRATCH --set medium --count 5 --dispatch    # medium: five Objectives of real size over the scratch adopter's notes CLI
node bench/drill.mjs --repo OWNER/SCRATCH --set conflict --dispatch            # conflict: two Objectives that edit one README section, so the second is sent back to rebase
```

A Question or Blocked exit ends the drill's wait for that Objective. The drill files Objectives on a scratch repository (never Factory's own, never a product repository), lets the Action take them, waits, and scores them. The medium set is the instrument for changes to the worker's skills; the reviewer's is `bench/review-replay.mjs` against the private replay set.

## Skills, versioned

`node bench/skills.mjs` records every plugin skill (SHA-256, lines, words) and a digest in `bench/skills.json`; each scorecard row carries that digest, so a row names the skills it ran on. `node bench/skills.mjs --check` fails when a skill changed without a new record, and both forms fail when a skill is over the one-page cap (60 lines, 700 words). Record after the scored Objective that justified the change, never before.

## Score

```sh
node bench/score.mjs --repo OWNER/NAME --issue 811 --issue 812            # table on stdout
node bench/score.mjs --repo OWNER/NAME --since 2026-11-01 --append scorecard.json   # every closed Objective; standing card
node bench/score.mjs --repo OWNER/NAME --issue 811 --usage ./usage-811 --minutes 811=12 --baseline main~3 --out 811.json
```

Artifacts download through `gh run download` with the `gh` login (needs `actions: read`); `--usage DIR` reads `result.json` or `events.jsonl` from disk instead (one artifact's unzip, or `DIR/<issue>/`). `--snapshot FILE` writes every GitHub answer used; `--replay FILE` scores from it without a token. `--append` replaces the rows of the same repository and issue and keeps the rest.

## Judge and auto-grader on two branches

```sh
gh repo clone OWNER/NAME widgets && gh issue view 811 --json body -q .body > objectives/811.md
node bench/judge.mjs --repo widgets --a factory/811 --b main~3 --objective objectives/811.md \
    --judge 'node graders/widgets-judge.mjs' --out judgments/811.json
node bench/grade-auto.mjs --repo widgets --commit factory/811 --base main~3 --objective objectives/811.md \
    --check "pnpm check" --check "pnpm test" --out grades/811.json
```

`judge.mjs` runs the 0.5 judge contract blind (which ref is A comes from a hash of the two names) and unblinds the answer to refs. `grade-auto.mjs` and `lib/judge.mjs` are kept from 0.5 unchanged; their flags are in their headers. Tests: `node --test 'bench/test/*.test.mjs'`.
