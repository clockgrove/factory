---
name: score
description: How Factory scores an Objective. Use to read the four job-one numbers (walk-away, solution quality, operator minutes, dollars per merged Objective) from the issue, the PR, the job log and the harness's usage artifact, with the unit and basis for each harness. Load when asked to score, explain or compare Factory runs, or when building a scorecard row.
---

# Score an Objective

Job one: file an Objective, walk away, come back to correct, merged work at a reasonable cost. Four numbers per Objective say whether that happened. One scorecard row holds all four, plus the unit and basis of each, so rows from different harnesses are never compared as if they measured the same thing.

## 1. Walk-away (binary)

Did it merge with zero human input after the label? Read from the issue and the PR timelines: the label event starts the clock; any later push, comment, edit or review on the branch or the issue by a human (anyone but the Factory App and the harness) breaks it, and a card that reached Blocked is a miss. A Question draft answered by a human is a miss for walk-away, recorded with the question so the pattern is visible. Report `yes` or `no` with the first human action that broke it, if any.

## 2. Solution quality

Where there is a comparison (a bench run against a recorded baseline), the bench's blind pairwise judge ranks the two merged diffs; report the judge's pick and its stated reason. Where there is none, the number is the owner's read of the merged diff when they choose to read it, recorded as `read: ok`, `read: defect` or `unread`. Any defect found after merge and traced to the Objective counts against it as an escape, listed by issue number. Never infer quality from validation being green; green is the entry condition for merging, not a quality score.

## 3. Operator minutes

Minutes a human spent on this Objective after the label: reading and acting on a Blocked card, answering a Question, re-filing, fixing a branch by hand. From a stopwatch or the owner's note, not estimated from timestamps. Zero on a clean merge. Report the minutes and what they went on.

## 4. Dollars per merged Objective

Per harness, from the usage artifact the worker job uploads, plus the reviewer call:

- **Claude.** The JSON result's `total_cost_usd`, and `modelUsage` keyed by model, which includes sub-agents; the top-level `usage` excludes them, so never use it for the whole run. Unit: USD. Basis: harness-reported.
- **Codex.** The JSONL's `turn.completed` events carry `usage.input_tokens`, `usage.cached_input_tokens` and `usage.output_tokens` per turn; reasoning tokens may be missing, and sub-agent totals may be folded in. Sum per model and price from the bench's price table, naming the table's date. Unit: USD. Basis: tokens priced by table.
- **Copilot.** Token counts and premium requests from `copilot --usage-output-file` (the worker writes it beside `events.jsonl`); no dollars per run. Take the organization's billing data for GitHub AI Credits, attribute to the run by its time window, and convert at GitHub's rate; when the window cannot be attributed to one run, record `unmetered`. Unit: credits (USD at the stated rate). Basis: billing window.

Beside the dollars, report runner minutes from the job log and wall time from label to merge. Wall time is never reported alone: the same Objective on a busy queue takes longer for no more dollars.

## Reading the artifacts

The issue gives the label time, the plan comment, the Blocked comment and any question. The PR gives the title, body, review comments, replies and merge time. The job log gives the runner minutes, the validation reruns and the exit (delivered, question, blocked). The usage artifact gives the tokens and dollars. `/factory score` reads all four and writes the row; a row with a missing input says which, rather than guessing.
