# pendulum-score: reference

How Pendulum scores an Objective, for the pendulum-score skill: what each of the four numbers means, how it is measured, and the lookup detail behind it. Every rule here is as binding as one in SKILL.md.

Job one: file an Objective, walk away, come back to correct, merged work at a reasonable cost. Four numbers per Objective say whether that happened. One scorecard row holds all four, plus the unit and basis of each, so rows from different harnesses are never compared as if they measured the same thing.

## Walk-away (binary)

Did it merge with zero human input after the label? Read from the issue and the PR timelines: the label event starts the clock; any later push, comment, edit, relabel, un-block, review, or hand-started or re-run Pendulum workflow run by a human (anyone but the Pendulum App and the harness) breaks it, an answered Question breaks it even when the answer is not on the issue or PR, and a card that reached Blocked is a miss. A workflow hand-over is an owner step, not input: Workflow hand-over, below. Report `yes` or `no` with the first human action, and the bucket: walk-away, External or miss. External: every stop was a Block whose notice records an external cause, with no Question and no input but the answers those Blocks asked for; the 1.0 streak skips it. Codes: Block causes, below.

A merge that sat idle longer than the stall threshold between Pendulum's acts is a stall, not a walk-away, either way of counting: Stalls, below.

Split the human actions too. One is *asked for* when it follows a request Pendulum made (a Question, a Blocked notice, a review request) and comes before Pendulum next labels the Objective Running; any other is *unprompted*. Pendulum's posts carry `<!-- pendulum:... -->` markers, which tell them apart in local mode, where Pendulum posts as the operator; a local loop posts its `done` marker on a closed Objective before it removes the state labels that marker names, so those removals are Pendulum's. Report both counts, and walk-away a second way: counting only asked-for actions (Blocked is still a miss).

## Solution quality

Where there is a comparison (a bench run against a recorded baseline), the bench's blind pairwise judge ranks the two merged diffs; report the judge's pick and its stated reason. Where there is none, the number is the owner's read of the merged diff when they choose to read it, recorded as `read: ok`, `read: defect` or `unread`. Any defect found after merge and traced to the Objective counts against it as an escape, listed by issue number. Never infer quality from validation being green; green is the entry condition for merging, not a quality score.

## Operator minutes

Minutes a human spent on this Objective after the label: reading and acting on a Blocked card, answering a Question, re-filing, fixing a branch by hand. From a stopwatch or the owner's note, not estimated from timestamps. Zero on a clean merge. Report the minutes and what they went on.

## Dollars per merged Objective

Per harness, from the usage artifact the worker job uploads, plus the reviewer call: Dollars by harness, below, for the fields, unit and basis.

Beside the dollars, report runner minutes from the job log and wall time from label to merge. Wall time is never reported alone: the same Objective on a busy queue takes longer for no more dollars.

Name the harness and models that ran beside the dollars, so rows compare model to model: Harness and models, below. Each input's source: Reading the artifacts, below; a row names a missing input, never guesses.

## Dollars by harness

- **Claude.** The JSON result's `total_cost_usd`, and `modelUsage` keyed by model, which includes sub-agents; the top-level `usage` excludes them, so never use it for the whole run. Unit: USD. Basis: harness-reported.
- **Codex.** Each run's JSONL ends in one `turn.completed` whose `usage.input_tokens`, `usage.cached_input_tokens` and `usage.output_tokens` are the thread's running total (a stream with more than one is read at its last, never summed); `output_tokens` already includes `reasoning_output_tokens`. Sub-agent threads (`spawn_agent`) are not in it: the worker reads each from its own rollout and lists it in the usage record's `subAgents` (its tokens are in `tokens`, priced at its own model). A resumed thread reports its running total, so each pass counts only its own share. Sum per model and price from the price table (`<plugin root>/scripts/lib/codex-prices.json`, OpenAI's Standard rates: a project on the Fast Service Tier pays 2× them (2.5× on gpt-5.5, 1.8× on gpt-5-mini), and Codex does not report it), naming the table's date; the record's `tokens.long` (requests over 272K input tokens) is at the model's `long` rates, and a record past 272K without it is of unknown cost. Unit: USD. Basis: tokens priced by table.
- **Copilot.** Token counts, premium requests and AI credits (`totalNanoAiu`, billionths of a credit) from `copilot --usage-output-file`, which the worker writes beside `events.jsonl`. Dollars are the credits at `copilot_credit_usd`, GitHub's published $0.01 per credit by default. A resumed session reports its running total, so each pass counts only its own share. An artifact with no credits is of unknown cost. Unit: USD. Basis: harness-reported AI credits.
- **Sandbox cost (any harness).** A cloud sandbox stage's own cost is booked once, at its end: `vendor` in its usage artifact beside the harness's dollars, and its vendor comment's spend line (`vendorUsd`) beside its progress comment's model dollars. Report it apart from the model's dollars, with its basis (list rates); a stage whose usage the vendor did not report is of unknown cost.
- **Unknown spend (any harness).** A run whose spend no harness or vendor reported (killed, crashed or hung; a zeroed result; a resumed Claude session before Claude Code 2.1.277; a Codex model with no price row or an ended promotional rate; a Codex run past 272K whose requests were not read; unreported credits or relay calls) carries `usdUnknown` (a count of runs) and `usdUnknownWhy` (reason codes) in its record, spend line and `result.json`; `usd` is the known part only. Show "plus N runs of unknown cost" beside the known dollars, never $0, an estimate or a bound. Caps count only the known dollars, so a cap can be exceeded by unknown spend.

## Harness and models

Each stage's usage record carries `ran`: the worker, sub-agent and reviewer models it ran on (null for a harness's own default) and `labels`, the `pendulum:harness:`, `pendulum:model:`, `pendulum:subagent-model:` and `pendulum:reviewer-model:` labels that chose them; none means the repository's defaults. Its `hosts` are the network hosts the Objective's `pendulum:host:` labels (also in `labels`) opened to its sandboxes. It is in `result.json`, and for a local stage in the `models` and `labels` of the `<!-- pendulum:harness -->` line of its progress comment. Report the worker's model as the harness reported it (the work stage's `model`), else its `ran.worker`; the sub-agent model from the last work stage's `ran`; the reviewer's from the last review stage's `ran`; and the labels.

## Reading the artifacts

The issue gives the label time, the plan comment, the Blocked comment and any question. The PR gives the title, body, review comments, replies and merge time. The job log gives the runner minutes, the validation reruns and the exit (delivered, question, blocked). The usage artifact gives the tokens and dollars.

## Block causes

Each Blocked notice ends with a cause line, `<!-- pendulum:block {"cause":"<code>"} -->` (plugin `logic.mjs` `BLOCK_CAUSES`, the one list). External codes, outside Pendulum and the work:

- `max-usd`: Pendulum's own `max_usd` cap reached.
- `gateway-budget`: the AI Gateway refused for its own budget or credits.
- `provider-quota`: a provider's quota, usage limit, plan limit or billing refusal: the model provider (a subscription's usage limit included), GitHub's Git LFS storage, GitHub's API rate limit spent until a reset past the stage's deadline, or the sandbox vendor's plan after the bounded wait.
- `outage`: a provider or GitHub outage Pendulum handled by its rules (a required job GitHub never started, waited for in place, then Blocked as infrastructure; the same in the merge queue after one re-enqueue; the stage's machine unable to reach GitHub or the model provider past the outage's bound, its notice naming the host and since when).

Not external: `setup` (a credential or payment method, a secret, a host, an install, any other Git LFS refusal, the repository's settings or rules, the author's access), `work` (the worker's own Block, validation red, review findings, a protected path, the Objective's size, an edit to the Objective after its plan) and `pendulum` (Pendulum itself, or any Block it did not place).

An Objective is External when it is not a walk-away, it has at least one Blocked notice, every notice records an external code, it had no Question, every human action answered a Block (asked for), no stall, and every input source was read. A notice with no cause line (written before causes were) or a person's comment carrying the marker never makes one External. A parked Objective is External only when every stop it had is. In the streak an External Objective is listed as skipped: it does not count and does not reset; a P1 escape found later in its merge makes it a miss.

## Stalls

The walk-away rule's stall, as the scorecard script applies it:

- The threshold is 60 minutes by default (`--stall-minutes`), GitHub's default merge-queue timeout, so one healthy CI wait, on the PR or in the queue, fits under it.
- A merge that sat idle longer than the threshold between Pendulum's acts is a stall, not a walk-away: `walkAway.stall` gives the minutes and the span, and every merged row carries its longest idle span as `walkAway.longestIdleMinutes`.
- Pendulum's acts are its App's (or, in local mode, the operator's within a run) labels, comments, reviews, enqueues and merge, each run's job, and each run's progress comment from its creation to the stage's own last write (the comment's header, not its last edit). A local loop's `pendulum:local` label on an Objective it took where no Action runs is Pendulum's only when the same login's comment marked `<!-- pendulum:<n>:local-route:<event id> -->` names that label event; any other `pendulum:local` label is a person's. Booking a sandbox stage's cost is not an act: the stage's vendor comment (`<!-- pendulum:<n>:vendor:<stage>:<key> -->`) is written at its end, or by the sweep hours later for a stage that died, so that stage shows as idle; an older stage's booking edited its progress comment instead.
- Another machine's act (the queue dropping a PR) is not one, and time a Question or Blocked notice had a person's turn is not idle.
- The span runs from Pendulum's first act after the label: the wait from the label to that first act is not a stall but the first run's `dispatch` seconds (a slot wait apart as `slotWaitSeconds`), because the bench cannot yet tell a slot wait behind other Objectives from a missed tick.

## Workflow hand-over

Each merged PR whose body carries Pendulum's workflow hand-over line (`<!-- pendulum:N:handover-line -->`; every part of a split Objective) leaves a person's step: applying the change Pendulum handed over. Pendulum never pushes a workflow file and its App has no workflows permission, so this step is part of the design, like a publish, and it is scored as normal work by default, for every repository (the scorecard script's `--handover owner-step`):

- When Pendulum's own hand-over comment with the patch (`<!-- pendulum:N:handover -->`) is on the issue, the hand-over is an **owner step**, not input: the Objective can still walk away, and the row shows the step apart (`ownerStep`) with its own minutes, from a stopwatch (`--owner-minutes`), never estimated. The person's removal of `pendulum:handover` after the merge marks it applied and is part of the step. Operator minutes stay zero on such a merge. Report it as "walk-away, owner step: workflow hand-over, N minutes" (or "not applied yet").
- A hand-over with no such comment (or only a person's) is no owner step: each such merge is one human action, asked for, a miss.
- The strict read (`--handover input`): every hand-over is one human action at that merge, asked for, so the Objective is no walk-away, and its minutes are operator minutes. Report which rule a row used (`walkAway.handover`).

A hand-over that needed fixing when applied is an escape. An Objective whose whole change is the hand-over has no PR and Blocks: a miss either way.
