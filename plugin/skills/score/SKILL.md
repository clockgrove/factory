---
name: score
description: "/factory:score [issue...]. Build or print the Clockgrove Factory scorecard: one row per Objective with the four job-one numbers, read from the issue, the PR, the job log and the uploaded usage artifact. Use when the user asks for the scorecard, the cost of an Objective, or whether an Objective walked away clean."
---

# /factory:score

Load the `scoring` skill first; it defines the four numbers, their units and their basis. This skill is the wiring.

## Inputs per Objective

- **Issue.** `gh issue view <issue> --json title,labels,closedAt,comments` and the timeline (`gh api repos/{owner}/{repo}/issues/<issue>/timeline`) for the label event, the plan comment, a Blocked comment and the human actions after the label.
- **PR.** `gh pr list --head factory/<issue> --state all --json number,mergedAt,isDraft,reviews,comments,body`, then the review comments for the reviewer's pass and the worker's replies.
- **Job log.** The runs that uploaded this issue's usage artifacts (`gh api repos/{owner}/{repo}/actions/artifacts?name=factory-usage-<issue>`, and `-review`; each carries its `workflow_run.id`), then `gh run view <id> --log` for runner minutes, validation reruns and the exit line. The worker job is named `work (<issue>)`; the review job is `review (factory/<issue>)`.
- **Usage artifact.** `gh run download <id> -n factory-usage-<issue>` (and `-n factory-usage-<issue>-review` from the review run) into a scratch directory. Every harness uploads `result.json` (normalized) and `events.jsonl` (the raw stream); read `result.json`. Copilot's dollars are its AI credits at `copilot_credit_usd`; an artifact without credits is `unmetered`.

For a run made with `/factory:run <issue> --here` there is no job log or artifact: take the harness's usage from the session's own output if the user has it, else mark the dollars `unmetered` and the runner minutes `n/a`. A local-mode run (`factory run`, `factory serve`) uploads no artifact either; `bench/score.mjs` reads its dollars from the `<!-- factory:spend -->` lines in Factory's progress comments.

## Write the row

When the bench is available (`bench/score.mjs` in a Factory checkout), run `node bench/score.mjs --repo <owner/name> --issue <issue> --usage <artifact dir> --print` and show its output (`--clock-after <date>` when the issue carries label events from an earlier Factory). Without it, print the row yourself as a table with these columns: issue, walk-away (yes/no, first human action), walk-away counting only asked-for actions, asked / unprompted counts (the scoring skill), quality (judge pick / read / unread, escapes), operator minutes (and what on), dollars (unit, basis), runner minutes, wall time, exit (delivered / question / blocked with reason). A missing input shows as `missing: <which>`, never as a guess.

With no issue given, score every issue that carries `factory:objective` and closed since the date the user names, plus the open ones that are Blocked, Question, In review or Running (`--since <date>`); the table is oldest first.

## After

Show the rows. Say in one line which columns came from a priced table or a billing window rather than a harness report, and the date of the price table.
