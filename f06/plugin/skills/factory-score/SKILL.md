---
name: factory-score
description: /factory score [issue...]. Build or print the Factory scorecard: one row per Objective with the four job-one numbers, read from the issue, the PR, the job log and the uploaded usage artifact. Use when the user asks for the scorecard, the cost of an Objective, or whether an Objective walked away clean.
---

# /factory score

Load the `score` skill first; it defines the four numbers, their units and their basis. This skill is the wiring.

## Inputs per Objective

- **Issue.** `gh issue view <issue> --json title,labels,closedAt,comments` and the timeline (`gh api repos/{owner}/{repo}/issues/<issue>/timeline`) for the label event, the plan comment, a Blocked comment and the human actions after the label.
- **PR.** `gh pr list --head factory/<issue> --state all --json number,mergedAt,isDraft,reviews,comments,body`, then the review comments for the reviewer's pass and the worker's replies.
- **Job log.** `gh run list --workflow factory.yml --json databaseId,createdAt,conclusion` filtered to the issue (the run name carries the issue number), then `gh run view <id> --log` for runner minutes, validation reruns and the exit line.
- **Usage artifact.** `gh run download <id> -n factory-usage-<issue>` into a scratch directory. Claude: `result.json`; Codex: `events.jsonl`; Copilot: none, use the billing window.

For a run made with `/factory <issue>` in a session, there is no job log or artifact: take the harness's usage from the session's own output if the user has it, else mark the dollars `unmetered` and the runner minutes `n/a`.

## Write the row

When the bench is available (`bench/score.mjs` in the Factory checkout, or `FACTORY_BENCH_HOME`), run `node bench/score.mjs --issue <issue> --repository <owner/name> --usage <artifact dir> --print` and show its output. Without it, print the row yourself as a table with these columns: issue, walk-away (yes/no, first human action), quality (judge pick / read / unread, escapes), operator minutes (and what on), dollars (unit, basis), runner minutes, wall time, exit (delivered / question / blocked with reason). A missing input shows as `missing: <which>`, never as a guess.

With no issue given, score every issue that carries `factory:objective` and has a `factory/<issue>` branch or PR, newest first.

## After

Show the rows. Say in one line which columns came from a priced table or a billing window rather than a harness report, and the date of the price table.
