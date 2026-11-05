# Factory 0.6 bench: notes from the bench lane

## What is here

```
score.mjs            the four numbers per Objective -> Markdown table + JSON rows; --append keeps the standing scorecard
judge.mjs            bench/lib/judge.mjs (0.5, kept) on two refs of one clone, blind, unblinded to refs
grade-auto.mjs       kept from 0.5 unchanged; its prompts in grade-auto/
prices.json          Codex price table: PLACEHOLDER rates, dated; replace before reading Codex rows as dollars
lib/objective.mjs    pure scoring of one collected Objective (walk-away, quality pair, operator, cost, wall, runner)
lib/collect.mjs      the REST reads (issue, timeline, comments, PRs by head, commits, reviews, jobs, artifacts); snapshot/replay
lib/cost.mjs         usage records -> cost row with unit and basis per harness; reads result.json, raw Claude json, raw Codex JSONL
lib/gh.mjs           `gh api` wrapper and artifact zip download
lib/judge.mjs, lib/grade-auto.mjs, lib/grade.mjs, lib/mutate.mjs, lib/outcomes.mjs   copied from 0.5 unchanged (diff -q is clean)
lib/definition.mjs, lib/provision.mjs   path fixes only: the two exports judge.mjs needs (CHOICES, treeDigest), so nothing imports 0.5's dist/
test/                13 node --test tests; fixtures invented (acme/widgets, 2031) as 0.5's public-data rule asks
```

Tests: `node --test 'test/*.test.mjs'` passes 13/13 on Node 22.23. Every script passes `node --check`.

## Assumptions

1. **The clock is the first `labeled factory:objective` event** on the issue timeline. A re-applied label after a Blocked fix does not restart it: the plan says a human re-applying the label is human input, so the whole history after the first label counts. Without a label event the issue's creation time is used and the row says `missing: label event`.
2. **Human = not a Bot.** An actor with `type: "Bot"`, a login ending in `[bot]`, or a commit authored from `*[bot]@users.noreply.github.com` is machine (the App commits that way per action/NOTES.md). `--bot LOGIN` adds other machine logins. A commit with no linked GitHub user counts as human by its git name; a worker run from a developer's own session (`/factory <issue>`) therefore scores as a human push, which is right for walk-away.
3. **Passive timeline events do not count**: `mentioned`, `subscribed`, `referenced`, `cross-referenced`, `connected`. A human `labeled`/`unlabeled`, `closed`, `reopened`, `renamed`, `ready_for_review`, `convert_to_draft`, `assigned` does. Issue body edits are not on the timeline REST endpoint, so an edit is seen only if it also left a comment or label; the NOTES below list this as unverifiable offline.
4. **Blocked** is the `factory:blocked` label after the clock, or a comment with the `<!-- factory:<issue>:blocked:<stage> -->` marker; the reason is parsed from the worker's `Blocked (<stage>): <reason> — ...` line. The Project card itself is GraphQL and is not read (Claude's cloud blocks it); the label is the jobs' own fallback for the card, written by the same code.
5. **Question** is the `factory:question` label, `QUESTION` in a PR body, or `QUESTION` in the plan comment (action logic.mjs's `hasQuestion`). "Answered" means any human action on the PR at or after the question. Walk-away is a miss either way; the row carries `walkAway.question` so the pattern is visible, as the score skill asks.
6. **The PR** is found by head `OWNER:factory/<issue>` (open and closed lists), then fetched one by one for `merged_by` and `merge_commit_sha`, which the list endpoint omits. The merged PR is the row's PR; else the open one; else the newest. The candidate ref for the judge is the merge commit when merged, else the head sha.
7. **Runner minutes** come from the `factory.yml` workflow's jobs whose name contains the issue number as a whole number (`work (811)`, `review (#811)`), summed over `started_at..completed_at`. A workflow of another name needs a code change (one constant in collect.mjs). A 404 on the workflow gives `unknown`.
8. **Usage artifacts**: exact-name listing for `factory-usage-<issue>`, plus a full listing filtered to `factory-usage-<issue>-review-` for the reviewer passes; all are summed and the basis says how many. Codex tokens are re-priced by the bench's `prices.json`, not the worker's table (action/NOTES.md asked for this); the date in the basis is the bench table's.
9. **`--since`** lists closed issues with the label updated since the date (the issues API's `since` is on `updated_at`) and keeps those closed at or after it. Open Objectives are scored only when named with `--issue`.
10. **Quality is pending by design.** The judge needs a clone, an Objective text file and a judge command; the row carries the exact `judge.mjs` and `grade-auto.mjs` lines when `--baseline` is given. `quality.escapes` is an empty list the owner fills by hand (or a later `--escape` flag).
11. **Operator minutes** are never derived from timestamps; the plan says stopwatch.
12. **`judge.mjs`** writes a stub definition (`{id, judge}`) in a temp bench home so the unchanged 0.5 `runJudge` finds `graders/` beside it; `--graders DIR` symlinks the given directory there. Blind order hashes the two ref *names* (`blindOrder`), so `--a X --b Y` and `--a Y --b X` give the same order.
13. **Markdown table** is one row per Objective, oldest first, plus notes for placeholder prices and missing inputs. JSON rows are `version: 1` with the full `walkAway`, `quality`, `operator`, `cost` objects; `scorecard.json` is `{version, updatedAt, rows}` sorted by repository then issue.

## Needs a token or an artifact to verify

- Every live REST shape: the timeline endpoint's event names for draft/ready toggles (`convert_to_draft`, `ready_for_review`) and whether comments appear as `commented` events with `user` or `actor`; the `pulls?head=OWNER:branch` filter; `merged_by` on the single-PR endpoint; the artifacts `name=` filter being exact; `--paginate --slurp` page shapes (the code accepts both a bare array and `{total_count, artifacts|jobs|workflow_runs}` per page).
- Artifact download: `gh api .../artifacts/<id>/zip` with binary stdout, and that the zip holds `result.json` at the root or under `usage/` (`findFile` walks for it either way).
- Issue body edits by a human: not on the REST timeline; a token-bearing run should check whether `edited` events exist for issues (they do for comments via the audit log only). Until then an edit without a comment or label is invisible to walk-away.
- Project card state (Blocked column) is GraphQL; the label fallback is what is read.
- Codex prices: all placeholder. Copilot: whether AI Credits can be attributed by window at all; the row stays `unmetered` until someone does it by hand.
- Job names in a real run of `workflow-template.yml`: the matrix job is presumably `work (811)`; if GitHub names it otherwise the issue-number regex in `jobsFor` needs the real shape.
- `grade-auto.mjs` and `judge.mjs` against a real Objective need `claude` on PATH and a judge command; only the stand-in judge is exercised here.
