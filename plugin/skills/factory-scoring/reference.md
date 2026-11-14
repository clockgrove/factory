# scoring: reference

Lookup detail for the factory-scoring skill. SKILL.md says when to load each section; every rule here is as binding as one there.

## Dollars by harness

- **Claude.** The JSON result's `total_cost_usd`, and `modelUsage` keyed by model, which includes sub-agents; the top-level `usage` excludes them, so never use it for the whole run. Unit: USD. Basis: harness-reported.
- **Codex.** Each run's JSONL ends in one `turn.completed` whose `usage.input_tokens`, `usage.cached_input_tokens` and `usage.output_tokens` are the thread's running total; `output_tokens` already includes `reasoning_output_tokens`. Sub-agent threads (`spawn_agent`) are not in it: the worker reads each from its own rollout and lists it in the usage record's `subAgents` (its tokens are in `tokens`, priced at its own model). A resumed thread reports its running total, so each pass counts only its own share. Sum per model and price from the bench's price table, naming the table's date. Unit: USD. Basis: tokens priced by table.
- **Copilot.** Token counts, premium requests and AI credits (`totalNanoAiu`, billionths of a credit) from `copilot --usage-output-file`, which the worker writes beside `events.jsonl`. Dollars are the credits at `copilot_credit_usd`, GitHub's published $0.01 per credit by default. A resumed session reports its running total, so each pass counts only its own share. An artifact with no credits is `unmetered`. Unit: USD. Basis: harness-reported AI credits.
- **Sandbox cost (any harness).** A cloud sandbox stage's own cost is booked once, at its end: `vendor` in its usage artifact beside the harness's dollars, and its vendor comment's spend line (`vendorUsd`) beside its progress comment's model dollars. Report it apart from the model's dollars, with its basis (list rates, or the session's ceiling as an upper bound).

## Harness and models

Each stage's usage record carries `ran`: the worker, sub-agent and reviewer models it ran on (null for a harness's own default) and `labels`, the `factory:harness:`, `factory:model:`, `factory:subagent-model:` and `factory:reviewer-model:` labels that chose them; none means the repository's defaults. It is in `result.json`, and for a local stage in the `models` and `labels` of the `<!-- factory:harness -->` line of its progress comment. Report the worker's model as the harness reported it (the work stage's `model`), else its `ran.worker`; the sub-agent model from the last work stage's `ran`; the reviewer's from the last review stage's `ran`; and the labels.

## Reading the artifacts

The issue gives the label time, the plan comment, the Blocked comment and any question. The PR gives the title, body, review comments, replies and merge time. The job log gives the runner minutes, the validation reruns and the exit (delivered, question, blocked). The usage artifact gives the tokens and dollars.

## Block causes

Each Blocked notice ends with a cause line, `<!-- factory:block {"cause":"<code>"} -->` (plugin `logic.mjs` `BLOCK_CAUSES`, the one list). External codes, outside Factory and the work:

- `max-usd`: Factory's own `max_usd` cap reached.
- `gateway-budget`: the AI Gateway refused for its own budget or credits.
- `provider-quota`: a provider's quota, plan limit or billing refusal: the model provider, GitHub's Git LFS storage, or the sandbox vendor's plan after the bounded wait.
- `outage`: a provider or GitHub outage Factory handled by its rules (a required job GitHub never started, waited for in place, then Blocked as infrastructure; the same in the merge queue after one re-enqueue; the stage's machine unable to reach GitHub or the model provider past the outage's bound, its notice naming the host and since when).

Not external: `setup` (a credential or payment method, a secret, a host, an install, any other Git LFS refusal, the repository's settings or rules, the author's access), `work` (the worker's own Block, validation red, review findings, a protected path, the Objective's size, an edit to the Objective after its plan) and `factory` (Factory itself, or any Block it did not place).

An Objective is External when it is not a walk-away, it has at least one Blocked notice, every notice records an external code, it had no Question, every human action answered a Block (asked for), no stall, and every input source was read. A notice with no cause line (written before causes were) or a person's comment carrying the marker never makes one External. A parked Objective is External only when every stop it had is. In the streak an External Objective is listed as skipped: it does not count and does not reset; a P1 escape found later in its merge makes it a miss.

## Stalls

The walk-away rule's stall, as `bench/score.mjs` applies it:

- The threshold is 60 minutes by default (`--stall-minutes`), GitHub's default merge-queue timeout, so one healthy CI wait, on the PR or in the queue, fits under it.
- A merge that sat idle longer than the threshold between Factory's acts is a stall, not a walk-away: `walkAway.stall` gives the minutes and the span, and every merged row carries its longest idle span as `walkAway.longestIdleMinutes`.
- Factory's acts are its App's (or, in local mode, the operator's within a run) labels, comments, reviews, enqueues and merge, each run's job, and each run's progress comment from its creation to the stage's own last write (the comment's header, not its last edit). Booking a sandbox stage's cost is not an act: the stage's vendor comment (`<!-- factory:<n>:vendor:<stage>:<key> -->`) is written at its end, or by the sweep hours later for a stage that died, so that stage shows as idle; an older stage's booking edited its progress comment instead.
- Another machine's act (the queue dropping a PR) is not one, and time a Question or Blocked notice had a person's turn is not idle.
- The span runs from Factory's first act after the label: the wait from the label to that first act is not a stall but the first run's `dispatch` seconds (a slot wait apart as `slotWaitSeconds`), because the bench cannot yet tell a slot wait behind other Objectives from a missed tick.
