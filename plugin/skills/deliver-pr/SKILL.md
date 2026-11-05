---
name: deliver-pr
description: Last step of working a Factory Objective, after prove-acceptance. Use to rebase on the default branch, open the one PR with the required body, link it from the issue, answer each reviewer comment once, push and stop. Load when a task card says to use deliver-pr, or when a Factory PR has reviewer comments to answer.
---

# Deliver the PR

## Rebase, then open one PR

Fetch the default branch and rebase `factory/<issue>` onto it. Resolve conflicts in favour of the default branch's structure and your change's intent; re-run the validation commands after any non-trivial conflict (when the task card names required checks, the tests the conflict touches; CI runs the suite). Push with the credential the job provides; never with a token you print or copy.

Open exactly one PR from `factory/<issue>` against the default branch, titled `#<issue>: <goal in a few words>`. If the plan comment holds an assumption marked `QUESTION`, or you are blocked beyond recovery, open it as a draft; otherwise open it ready for review. Reopen or update the existing PR on a rerun; never open a second.

## The PR body

These sections, in this order, each under exactly this `##` heading (Factory reads the headings; do not number or rename them):

- `## Acceptance`: one row per acceptance entry: the entry, the change that satisfies it (files), and the proving test (file and name). An entry split into a later PR says so.
- `## Validation`: every validation command and the budget command, exactly as run, each with its result and, for a failure, whether it fails identically on the base commit.
- `## Fake-only proofs`: each entry proved only against a fake or in-memory stand-in, and why the real path could not run here. Write `none` when there are none.
- `## Design checklist`: when the repository has one, each question answered with `file:line` evidence, or `n/a` with the reason.
- `## Assumptions`: the plan comment's list, with any item that starts with `QUESTION:` first and phrased as the question a human must answer; an answered one no longer starts with it.
- `## Undone`: anything the issue asked for that this PR does not deliver, with the reason and, for a split Objective, the PR that will.
- `## Blocked` (only when blocked beyond recovery): what blocked you, in one paragraph.

Edit the plan comment to link the PR. Post nothing else on the issue, except the one blocked comment the task card names.

## Reviewer comments

The reviewer posts one pass of line comments. Handle them once: for each comment, either make the change and reply with the commit, or reply with a rebuttal that names the acceptance entry or repository rule that makes the comment wrong. Never leave a comment unanswered and never answer twice. A comment that names a real defect is fixed, not argued. A comment that flags an assumption as behaviour-changing is answered, when the Question rule's test is met, by marking that assumption `QUESTION` under `## Assumptions` and converting the PR to a draft.

After the replies: rebase on the default branch again, run the validation commands (when the task card names required checks, only the tests your replies touched), push, and stop. Do not wait for the merge queue, do not re-request review, do not post a summary. If validation is red after your push, fix it locally and push once more; Factory's second re-run is the last.

## Stop

When the FACTORY_EXIT_FILE environment variable is set, write your exit record there as one JSON object before you stop: {"exit": "delivered" | "question" | "blocked", "questions": ["each open question, verbatim"], "reason": "why you are blocked, else empty"}. Factory reads that file, never the PR body, to decide whether you delivered, raised a question or are blocked.

Your outputs are the plan comment and its edits, the commits on `factory/<issue>`, the one PR and its body, one reply per reviewer comment, and the exit record. Anything else is noise that a human has to read.
