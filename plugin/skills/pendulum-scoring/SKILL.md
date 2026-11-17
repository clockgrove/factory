---
name: pendulum-scoring
description: "How Clockgrove Pendulum scores an Objective: the four job-one numbers (walk-away, solution quality, operator minutes, dollars per merged Objective), their units and basis per harness. Use when asked to explain or compare how Clockgrove Pendulum runs are scored, or when building a scorecard row (pendulum-score loads it). Not for building or printing the scorecard (pendulum-score)."
---

# Score an Objective

Job one: file an Objective, walk away, come back to correct, merged work at a reasonable cost. Four numbers per Objective say whether that happened. One scorecard row holds all four, plus the unit and basis of each, so rows from different harnesses are never compared as if they measured the same thing.

The scorecard script and judge (`<pendulum clone>/bench/`) need a clone of Pendulum's repository; without one, score by hand. `<plugin root>` is `${CLAUDE_PLUGIN_ROOT}` in Claude Code, elsewhere two directories above this SKILL.md; where `pendulum` is not on PATH (only Claude Code puts the plugin's `bin/` there), run `node <plugin root>/scripts/local.mjs` instead.

## 1. Walk-away (binary)

Did it merge with zero human input after the label? Read from the issue and the PR timelines: the label event starts the clock; any later push, comment, edit, relabel, un-block, review, or hand-started or re-run Pendulum workflow run by a human (anyone but the Pendulum App and the harness) breaks it, an answered Question breaks it even when the answer is not on the issue or PR, and a card that reached Blocked is a miss. A workflow hand-over is an owner step, not input: reference.md, "Workflow hand-over". Report `yes` or `no` with the first human action, and the bucket: walk-away, External or miss. External: every stop was a Block whose notice records an external cause, with no Question and no input but the answers those Blocks asked for; the 1.0 streak skips it. Codes: [reference.md](reference.md), "Block causes".

A merge that sat idle longer than the stall threshold between Pendulum's acts is a stall, not a walk-away, either way of counting: [reference.md](reference.md), "Stalls".

Split the human actions too. One is *asked for* when it follows a request Pendulum made (a Question, a Blocked notice, a review request) and comes before Pendulum next labels the Objective Running; any other is *unprompted*. Pendulum's posts carry `<!-- pendulum:... -->` markers, which tell them apart in local mode, where Pendulum posts as the operator; a local loop posts its `done` marker on a closed Objective before it removes the state labels that marker names, so those removals are Pendulum's. Report both counts, and walk-away a second way: counting only asked-for actions (Blocked is still a miss).

## 2. Solution quality

Where there is a comparison (a bench run against a recorded baseline), the bench's blind pairwise judge ranks the two merged diffs; report the judge's pick and its stated reason. Where there is none, the number is the owner's read of the merged diff when they choose to read it, recorded as `read: ok`, `read: defect` or `unread`. Any defect found after merge and traced to the Objective counts against it as an escape, listed by issue number. Never infer quality from validation being green; green is the entry condition for merging, not a quality score.

## 3. Operator minutes

Minutes a human spent on this Objective after the label: reading and acting on a Blocked card, answering a Question, re-filing, fixing a branch by hand. From a stopwatch or the owner's note, not estimated from timestamps. Zero on a clean merge. Report the minutes and what they went on.

## 4. Dollars per merged Objective

Per harness, from the usage artifact the worker job uploads, plus the reviewer call: reference.md, "Dollars by harness", for the fields, unit and basis.

Beside the dollars, report runner minutes from the job log and wall time from label to merge. Wall time is never reported alone: the same Objective on a busy queue takes longer for no more dollars.

Name the harness and models that ran beside the dollars, so rows compare model to model: reference.md, "Harness and models". Each input's source: reference.md, "Reading the artifacts"; a row names a missing input, never guesses.
