# Factory bench

The scorecard, the blind pairwise judge and the auto-grader. Plain Node 22, no dependencies beyond `gh` (logged in, for anything that reads GitHub; `gh run download` unpacks artifacts).

## The row

One row per Objective, read from the issue, the PR on `factory/<issue>`, the job log and the usage artifact (`factory-usage-<issue>`, plus `factory-usage-<issue>-review`):

| Number | What the row says | Taken from |
| --- | --- | --- |
| Walk-away | `yes`, or `no` with the first human action | Binary. The clock starts at the first `factory:objective` label. Any human push, comment, review, edit or draft/ready toggle on the branch or the issue after it breaks it. A person's `workflow_dispatch` or re-run of the Factory workflow (`--workflow`, default `factory.yml`) between the clock and the merge is input too: one whose jobs name Objectives counts for those, one that names none (a hand-started dispatcher tick) for every Objective in flight then. The adopter drill's own dispatch (`drill.mjs --dispatch`) is not input for the Objectives it filed: the drill records the run id GitHub returned on each of them (`<!-- factory:N:drill {"dispatch": ID} -->`, posted by the issue's author), and that run's first attempt, started by the same login, is the drill's. A re-run of it, or any other dispatch, still counts. A Blocked card (label or marker comment) is a miss; an answered Question is a miss, named as such, even when the answer is nowhere the scorer reads (Factory resumed after its Question). `*[bot]` actors never count; `--bot LOGIN` adds another. Each human action is also split: *asked for* when it follows a Question, Blocked notice or review request Factory made and comes before Factory's next `factory:running` label, else *unprompted* (an owner's note, scope added after the label). The row carries `walkAway.interventions` (`asked`, `unprompted`, Factory's `requests`) and `walkAway.askedOnly`, walk-away counting only asked-for actions; the table shows both, and the line under it sums them. A merge that sat idle longer than the stall threshold (`--stall-minutes`, default 60) between Factory's acts is a stall, not a walk-away (`walkAway.stall`; every merged row carries `walkAway.longestIdleMinutes`): the rule, what counts as Factory's acts and as idle, is the scoring skill's, in `plugin/skills/scoring/reference.md` (Stalls). Factory's posts are told from a person's by their `<!-- factory:... -->` markers (in local mode Factory posts as the operator's login, and an unmarked comment, a label other than Factory's state labels, or removing `factory:blocked` without a re-applied Objective label is the operator's). The PR closed by its merge, its branch deleted and the issue closed right after it are the merge's, never acts of their own. |
| Solution quality | `pending` with the pair for the judge | The judge's, never the scorecard's. With `--baseline REF` the row carries the `judge.mjs` and `grade-auto.mjs` commands for the merged head against it; without, the owner's read of the merged diff. Escapes found after merge go in `quality.escapes`: an issue labelled P1, opened after the merge, that references the merged PR is filled in, a P1 Objective filed to fix it included; add others by hand. `--append` keeps the hand-filled ones (once per `owner/name#N` they name) and replaces the found ones with this run's, so one whose P1 label was removed drops out. |
| Operator minutes | `0`, a number, or `unknown` | `--minutes <issue>=<n>` from a stopwatch; `0` on a clean merge; otherwise `unknown`, never estimated. |
| Cost | dollars with unit and basis | Claude: `usd` from `total_cost_usd` + `modelUsage` (sub-agents in). Codex: `tokens` priced from `prices.json`, OpenAI's published rates with the date and page they were read from. Copilot: `usd` from the AI credits its `--usage-output-file` reports, at the run's `copilot_credit_usd` (GitHub's published $0.01 per credit by default), with the premium requests beside them (`cost.premiumRequests`, `cost.aiCredits`); an artifact without credits stays `unmetered`. Reviewer artifacts are summed with the worker's. A stage that ran in a cloud sandbox carries the vendor's cost in its record (`vendor`, at the vendor's dated list rates, docs/ADAPTERS.md "Vendor cost"); it is summed beside the model's dollars as `cost.vendorUsd`, with `cost.totalUsd` for both, and the cell reads `model + sandbox = total` (`≤` when a stage's is the session's ceiling). With no usage artifact (local mode uploads none), the dollars are the `<!-- factory:spend -->` lines in Factory's own progress comments, as the worker priced them, and a stage without one leaves the figure partial. Runner minutes and wall time (label to merge) sit beside it; wall time is never alone. |

A missing input shows as `missing: <which>` in the row, never as a guess.

Beside the four numbers the row carries, from the same sources: `phases` (setup and install, model, CI-wait and other minutes, read from each run's progress comment), `dispatch` (for each run, the seconds from the GitHub event that started it to its progress comment appearing, on every path; the latest trigger since the previous run counts, and a run no event explains has none. A work stage that waited for a concurrency slot is timed from the tick that started it, the sandbox record's launch entry or else the Actions run that launched it, and the wait is reported apart as `slotWaitSeconds`, but only when that tick freed a slot (a Factory PR merged, or a job's or stage's end tick not of the Objective's own); a later cron or own-stage tick stays in dispatch seconds and is named as `tickEvent`, as does the wait of an Objective the dispatcher had already picked before that tick: sent back to Queued after a failed start (`tickEvent` `requeued`), or still Running after a lost launch it launched again (`relaunched`). Only Factory's own marker comments are read: its App's login from `--app`, else the App that applied `factory:running`), `phases.setupSeconds` (each run's setup in seconds, from its progress comment to the usage record's harness start; the largest per Objective), `activity` (turns, harness calls, distinct sessions, work and review run counts, read from the usage artifacts), cost by component (uncached, cached, written and output tokens, and a per-model split), and the harness CLI version. The table shows them as Dispatch s (max), Slot wait s, Setup s (max), Model min, CI wait min, Turns, Runs and Sessions, and the cost cell as `$ (in / cached / written / out)`.

## The streak

```sh
node bench/score.mjs --streak --repo OWNER/NAME --since v0.9.0 [--append scorecard.json]
```

Consecutive walk-away merges per harness from a Factory tag (its Release's time, read from `--factory`, default `clockgrove/factory`): the Objectives whose clock started at or after it, in the order they ended. A walk-away merge with no P1 escape and every input source read extends the harness's streak; any human input, a Blocked card, a stall, an unmerged end, a P1 escape in `quality.escapes`, or an input source the scorer could not read (`walkAway.unseen`: the workflow runs without Actions read, or more than GitHub's 1,000 in the window; the body edits without GraphQL) resets it, and the sequence says which. The harness is the usage artifact's, else the `<!-- factory:harness -->` line or the `harness <name>` start line in Factory's own progress comments; a row with none, or with two (a relabel that switched harness), is listed as `unknown`: it extends no harness's streak, and when it breaks, it breaks every harness's. In local mode a re-run by the operator's login on a head Factory's triage record names is Factory's own. A re-run of a run created before the first label is not listed. Objectives still running are listed as in flight; ones whose clock started before the tag are left out by number. The adopter's pin is not read: score a repository only while it is pinned to the tag.

## Prompt cache after a CI wait

Each usage record carries `cache`: the TTL Factory asked Claude Code for (`prompt_cache_ttl`, `null` when the CLI default applied), the stage's cache-write share (writes over all input tokens), and, for every validation fix pass (each follows a wait for the required checks), the minutes waited and its first request's split: `first.written` against `first.input`, per `first.unit`. Claude reports a request, and splits the writes into `written1h` and `written5m`, so the TTL actually used is visible. Codex reports a turn and no writes: OpenAI's caching has no write charge, so its share is null; a resumed thread reports its running total, so a resumed pass's split is its own share. A raw Codex `events.jsonl` (no `result.json`) is read the same way: a pass that resumes a thread seen earlier in the stream counts only its own share. Copilot reports only the run, plus the TTL it chose (`harnessTtlSeconds`). The scorecard row sums these under `cost.cache` and the table's notes print one line per Objective.

To decide the setting, score the same medium drill set twice on an API key, once with the default (`off`, five minutes on a key) and once with the workflow's `FACTORY_PROMPT_CACHE_TTL: auto` (one hour), then compare:

```sh
node bench/score.mjs --repo OWNER/SCRATCH --issue N ... --out ttl-5m.json     # the off run
node bench/score.mjs --repo OWNER/SCRATCH --issue M ... --out ttl-1h.json     # the auto run
jq '[.[] | .cost.cache.firstWritten] | add' ttl-5m.json ttl-1h.json     # writes on the first request after CI waits
jq '[.[] | .cost.usd] | add' ttl-5m.json ttl-1h.json                    # dollars, which the higher 1h write rate can outweigh
```

`auto` becomes the default only if those writes drop and the dollars do not rise.

## Baseline

```sh
node bench/baseline.mjs --scorecard scorecard.json --repo OWNER/NAME --label wave0 --append   # median and p25..p75 of model minutes, turns, cost (model, sandbox and total), cached and written tokens, CI wait, dispatch seconds, setup, wall minutes and sessions, plus walk-away rate
node bench/baseline.mjs --scorecard scorecard.json --repo OWNER/NAME --since 2026-11-06 --last 5
```

One line per label under `baselines` in the scorecard, so a change's before and after is one command.

## Drill

```sh
node bench/drill.mjs --repo OWNER/SCRATCH --count 2 --dispatch                 # small: one-function additions, merged in minutes
node bench/drill.mjs --repo OWNER/SCRATCH --set medium --count 5 --dispatch    # medium: five Objectives of real size over the scratch adopter's notes CLI
node bench/drill.mjs --repo OWNER/SCRATCH --set conflict --dispatch            # conflict: two Objectives that edit one README section, so the second is sent back to rebase
```

A Question or Blocked exit ends the drill's wait for that Objective. The drill then waits (`--usage-wait-minutes`, default 10) for the usage artifact of each stage Factory ran, which can land after the label, downloads every one, and scores Blocked and merged Objectives alike; an artifact that never came is named in the report's `usageMissing` and its row says `missing: usage artifact`. An Objective still running when `--wait-minutes` runs out is not waited for, but its finished stages' artifacts are downloaded and scored, and its running stage is named in `usageMissing` as `(still running)`: its dollars are a floor. The drill files Objectives on a scratch repository (never Factory's own, never a product repository), lets the Action take them, waits, and scores them. The medium set is the instrument for changes to the worker's skills; the reviewer's is `bench/review-replay.mjs` against the private replay set.

## Sandbox check

```sh
node bench/sandbox-check.mjs                          # srt, Claude Code, Codex and Copilot, as local mode configures them
node bench/sandbox-check.mjs --harness srt,codex      # the two that need no model call
```

Local mode's sandbox bar, probed on this machine. One probe script runs under srt (Factory's own commands) and under each harness's own sandbox, and every result is checked: the credential store unreadable, writes only in the clone and the stage directories (the clone's hooks and config, the stage's `bin` and another stage's temp directory not), escapes to /tmp and the home directory looked for on the host, the allow-listed host reachable for GET and POST and others not, no model key in the commands' environment, `TMPDIR` inside the stage's private temp directory, pnpm's lock directory writable, and the npm, pnpm, Bun and Yarn caches writable. Claude Code and Copilot take one model call each. On Windows it checks that local mode refuses and names WSL2.

## Skills, versioned

`node bench/skills.mjs` records every plugin skill (SHA-256, lines, words of its SKILL.md, and the same for each other file in its directory, such as a `reference.md` it loads on demand) and a digest over all of them in `bench/skills.json`; each scorecard row carries that digest, so a row names the skills it ran on. `node bench/skills.mjs --check` fails when a skill changed without a new record, and both forms fail when a SKILL.md is over the one-page cap (60 lines, 700 words). Detail a run looks up rather than follows every time goes in a reference file beside the SKILL.md, which names it with a pointer saying when to load it; every route that installs a skill copies its whole directory. Record after the scored Objective that justified the change, never before.

## Score

```sh
node bench/score.mjs --repo OWNER/NAME --issue 811 --issue 812            # table on stdout
node bench/score.mjs --repo OWNER/NAME --since 2026-11-01 --append scorecard.json   # every closed Objective; standing card
node bench/score.mjs --repo OWNER/NAME --issue 811 --usage ./usage-811 --minutes 811=12 --baseline main~3 --out 811.json
```

Artifacts download through `gh run download` with the `gh` login (needs `actions: read`); `--usage DIR` reads `result.json` or `events.jsonl` from disk instead: `DIR/<issue>/` per issue, where an issue without its own directory has no usage (never the other issues'), or one artifact's unzip when one issue is scored. `--snapshot FILE` writes every GitHub answer used; `--replay FILE` scores from it without a token. `--append` replaces the rows of the same repository and issue and keeps the rest.

## Judge and auto-grader on two branches

```sh
gh repo clone OWNER/NAME widgets && gh issue view 811 --json body -q .body > objectives/811.md
node bench/judge.mjs --repo widgets --a factory/811 --b main~3 --objective objectives/811.md \
    --judge 'node graders/widgets-judge.mjs' --out judgments/811.json
node bench/grade-auto.mjs --repo widgets --commit factory/811 --base main~3 --objective objectives/811.md \
    --check "pnpm check" --check "pnpm test" --out grades/811.json
```

`judge.mjs` runs the judge blind (which ref is A comes from a hash of the two names) and unblinds the answer to refs. `judge.mjs` and `grade-auto.mjs` take the flags in their headers. Tests: `node --test 'bench/test/*.test.mjs'`.
