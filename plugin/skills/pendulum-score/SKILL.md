---
name: pendulum-score
description: "Build or print the Pendulum scorecard: one row per Objective with the four job-one numbers (walk-away, solution quality, operator minutes, dollars per merged Objective), read from the issue, the PR, the job log and the uploaded usage artifact; its reference says how each is measured, its unit and basis per harness. Use when the user asks for the scorecard, the cost of an Objective, whether an Objective walked away clean, or how Pendulum runs are scored. Not for what an Objective is doing now or why it is Blocked (pendulum-status)."
---

# /pendulum:pendulum-score

The scorecard script, `<pendulum clone>/bench/score.mjs`, is not part of the plugin: it runs from a clone of Pendulum's repository (`git clone https://github.com/clockgrove/pendulum`, Node 22 or newer). Without one, write the row by hand (Write the row).

Read [reference.md](reference.md) first: it defines the four numbers, their units and their basis. This page is the wiring. `<plugin root>` is `${CLAUDE_PLUGIN_ROOT}` in Claude Code, elsewhere two directories above this SKILL.md; where `pendulum` is not on PATH (only Claude Code puts the plugin's `bin/` there), run `node <plugin root>/scripts/local.mjs` instead.

## Inputs per Objective

- **Issue.** `gh issue view <issue> --json title,labels,closedAt,comments` and the timeline (`gh api repos/{owner}/{repo}/issues/<issue>/timeline`) for the label event, the plan comment, a Blocked comment and the human actions after the label.
- **PR.** `gh pr list --head pendulum/<issue> --state all --json number,mergedAt,isDraft,reviews,comments,body`, then the review comments for the reviewer's pass and the worker's replies.
- **Job log.** The runs that uploaded this issue's usage artifacts (`gh api repos/{owner}/{repo}/actions/artifacts?name=pendulum-usage-<issue>`, and `-review`; each carries its `workflow_run.id`), then `gh run view <id> --log` for runner minutes, validation reruns and the exit line. The worker job is named `work (<issue>)`; the review job is `review (pendulum/<issue>)`.
- **Usage artifact.** `gh run download <id> -n pendulum-usage-<issue>` (and `-n pendulum-usage-<issue>-review` from the review run) into a scratch directory. Every harness uploads `result.json` (normalized); read it. The raw stream, `events.jsonl`, is sealed on a public repository unless `publish_transcripts` is on. Copilot's dollars are its AI credits at `copilot_credit_usd`; an artifact without credits is of unknown cost.

For a run made with `/pendulum:pendulum-run <issue> --here` there is no job log or artifact: take the harness's usage from the session's own output if the user has it, else mark the dollars `unknown` and the runner minutes `n/a`. A local-mode run (`pendulum run`, `pendulum serve`) uploads no artifact either; the scorecard script reads its dollars from the `<!-- pendulum:spend -->` lines in Pendulum's progress comments. An Objective whose stages ran on several routes gets its dollars from both, each stage once: a progress comment whose stage an artifact names (its `progressRun`) counts as that artifact, and a stand-in record (`standIn`, written for a stage whose own process wrote none) gives way to the stage's comment.

## Write the row

With a clone, run `node <pendulum clone>/bench/score.mjs --repo <owner/name> --issue <issue> --usage <artifact dir> --print` and show its output (`--clock-after <date>` starts each clock at the first label event on or after that date, for an issue whose earlier label events belong to no run being scored). Without it, print the row yourself as a table with these columns: issue, walk-away (yes/no, first human action), walk-away counting only asked-for actions, asked / unprompted counts (reference.md, Walk-away), quality (judge pick / read / unread, escapes), operator minutes (and what on), owner step minutes (a workflow hand-over, scored as normal work: reference.md, Workflow hand-over), dollars (unit, basis), runner minutes, wall time, exit (delivered / question / blocked with reason). A missing input shows as `missing: <which>`, never as a guess.

With no issue given, score every issue that carries `pendulum:objective` and closed since the date the user names, plus the open ones that are Blocked, Question, In review or Running (`--since <date>`); the table is oldest first.

## After

Show the rows. Say in one line which columns came from a priced table or a billing window rather than a harness report, and the date of the price table.
