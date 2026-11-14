---
name: factory-deliver-pr
description: Last step of working a Clockgrove Factory Objective, after factory-prove-acceptance. Use to rebase on the default branch, write the one PR's title and body, answer each reviewer comment once, write the exit record and stop; Clockgrove Factory pushes, opens the PR and posts the replies. Load when a task card says to use factory-deliver-pr, or when a Clockgrove Factory PR has reviewer comments to answer.
---

# Deliver the PR

## Rebase, then write the PR

Rebase `factory/<issue>` onto `origin/<default branch>`: Factory fetched it before this pass, and `$FACTORY_IN/base.txt` names its commit. Never fetch, pull or push. Resolve conflicts in favour of the default branch's structure and your change's intent; re-run the validation commands after any non-trivial conflict (with required checks on the task card, the tests the conflict touches).

Write the one PR to `$FACTORY_OUT/pr.md`: its first line is the title, `#<issue>: <goal in a few words>`; the rest is the body. On a rerun, start from `$FACTORY_IN/pr.md`. Factory opens it as a draft and marks it ready once its own validation is green. Write no `Closes`, `Fixes` or `Resolves` line, no @-mention and no HTML comment: Factory links the issue itself and neutralises them.

## The PR body

These sections, in this order, each under exactly this `##` heading (Factory reads the headings; do not number or rename them):

- `## Acceptance`: one row per acceptance entry: the entry, the change that satisfies it (files), and the proving test (file and name). An entry split into a later PR says so.
- `## Validation`: every validation command and the budget command, exactly as run, each with its result and, for a failure, whether it fails identically on the base commit.
- `## Fake-only proofs`: each entry proved only against a fake or in-memory stand-in, and why the real path could not run here. Write `none` when there are none.
- `## Design checklist`: when the repository has one, each question answered with `file:line` evidence, or `n/a` with the reason.
- `## Assumptions`: the plan's list, with any item that starts with `QUESTION:` first and phrased as the question a human must answer; an answered one no longer starts with it.
- `## Undone`: anything the issue asked for that this PR does not deliver, with the reason and, for a split Objective, that a later part delivers it.
- `## Blocked` (only when blocked beyond recovery): what blocked you, in one paragraph.

## Workflow hand-over

Factory never pushes a change under `.github/workflows/`, and the commit hook refuses one. When the Objective needs one, keep it out of your commits and hand it over as `$FACTORY_OUT/workflow.patch`: read [reference.md](reference.md), "Workflow hand-over", first.

## Reviewer comments

When the PR has review comments (`$FACTORY_IN/review-comments.json` holds them), read [reference.md](reference.md) beside this file first: its "Reviewer comments" section says how to answer each one once, then finish the pass.

If Factory's validation is red after its push, it sends you the failure; fix it and commit once more. Factory's second re-run is the last.

## Stop

Write your exit record last, as one JSON object in `$FACTORY_OUT/exit.json`: {"exit": "delivered" | "question" | "blocked", "questions": [{"question": "verbatim", "test": "contract" | "decision" | "access", "existing": "the existing contract it changes or removes, the decision it contradicts, or the access it grants"}], "reason": "why you are blocked, else empty"}, with "part": {"remaining": [...]} only for a split Objective with items left, and "deniedHosts": ["host.example.com"] only when you are blocked because the sandbox denied those hosts (bare host names; the operator decides whether to allow them). Factory reads that file, never the PR body, to decide whether you delivered, raised a question or are blocked.

Your outputs are the commits on `factory/<issue>` and the files in `$FACTORY_OUT`. Anything else is noise that a human has to read.
