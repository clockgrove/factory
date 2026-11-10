# scoring: reference

Lookup detail for the scoring skill. SKILL.md says when to load each section; every rule here is as binding as one there.

## Dollars by harness

- **Claude.** The JSON result's `total_cost_usd`, and `modelUsage` keyed by model, which includes sub-agents; the top-level `usage` excludes them, so never use it for the whole run. Unit: USD. Basis: harness-reported.
- **Codex.** The JSONL's `turn.completed` events carry `usage.input_tokens`, `usage.cached_input_tokens` and `usage.output_tokens` per turn; reasoning tokens may be missing, and sub-agent totals may be folded in. Sum per model and price from the bench's price table, naming the table's date. Unit: USD. Basis: tokens priced by table.
- **Copilot.** Token counts, premium requests and AI credits (`totalNanoAiu`, billionths of a credit) from `copilot --usage-output-file`, which the worker writes beside `events.jsonl`. Dollars are the credits at `copilot_credit_usd`, GitHub's published $0.01 per credit by default. A resumed session reports its running total, so each pass counts only its own share. An artifact with no credits is `unmetered`. Unit: USD. Basis: harness-reported AI credits.

## Reading the artifacts

The issue gives the label time, the plan comment, the Blocked comment and any question. The PR gives the title, body, review comments, replies and merge time. The job log gives the runner minutes, the validation reruns and the exit (delivered, question, blocked). The usage artifact gives the tokens and dollars.

## Stalls

The walk-away rule's stall (#2597), as `bench/score.mjs` applies it:

- The threshold is 60 minutes by default (`--stall-minutes`), GitHub's default merge-queue timeout, so one healthy CI wait, on the PR or in the queue, fits under it.
- A merge that sat idle longer than the threshold between Factory's acts is a stall, not a walk-away: `walkAway.stall` gives the minutes and the span, and every merged row carries its longest idle span as `walkAway.longestIdleMinutes`.
- Factory's acts are its App's (or, in local mode, the operator's within a run) labels, comments, reviews, enqueues and merge, each run's job, and each run's progress comment from its creation to the stage's own last write (the comment's header, not its last edit: booking a lost stage's sandbox cost edits it late, so a stage that died and waited for the sweep shows as idle).
- Another machine's act (the queue dropping a PR) is not one, and time a Question or Blocked notice had a person's turn is not idle.
- The span runs from Factory's first act after the label: the wait from the label to that first act is not a stall but the first run's `dispatch` seconds (a slot wait apart as `slotWaitSeconds`), because the bench cannot yet tell a slot wait behind other Objectives from a missed tick.
