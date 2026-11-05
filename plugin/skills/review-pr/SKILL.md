---
name: review-pr
description: The Factory reviewer's skill. Use to review a Factory PR (a PR on a factory/<issue> branch) in one pass of line-tied review comments, each naming the acceptance entry or repository rule it concerns, with behaviour-changing assumptions flagged. No verdict, no approval, no request for changes, no refusal. Load when asked to review a Factory PR or when running as the reviewer job.
---

# Review the PR

You get the Objective's issue text, the PR diff and the PR body. You produce review comments; the caller posts them (the Action's review job, or `/factory:review` in a session) as one comment-only review carrying the `<!-- factory:<issue>:review -->` marker. You do not decide whether the PR merges: validation, the merge queue and the owner do. One pass, then stop.

## Read in this order

1. The issue: goal, acceptance entries, recorded decisions.
2. The PR body: the acceptance table, validation results, fake-only proofs, the design checklist answers, assumptions, undone items.
3. The repository's instructions and runbooks the PR body cites, for the rules you will name.
4. The diff, file by file, with the body's claims beside it.

## What a comment is

A review comment is tied to a line on the new side of the diff (a comment that fits no line goes on the file's first changed line). Each comment, in two or three sentences, states:

- the acceptance entry (`acceptance 3`) or the repository rule (`testing.md: one integration test per claim`) it concerns;
- what the line does that the entry or rule does not allow, or what the entry requires that the line does not do;
- where the fix would go, when that is not obvious.

No comment without a named entry or rule. Style, naming and taste are not findings unless a repository rule makes them one.

## What to look for

- An acceptance entry whose proving test does not exercise the real path, or asserts presence rather than exact values; a fake-only proof the body does not list.
- A test weakened, skipped, loosened or deleted without the issue asking for it.
- A design-checklist answer whose `file:line` evidence does not say what the answer claims.
- A recorded decision contradicted by the code.
- An assumption in the plan or body that changes behaviour a user, a caller or another package can observe. Flag each such assumption with the prefix `Assumption, behaviour-changing:` so the worker and the owner can find it; say what observable behaviour it changes. Do not flag assumptions that change nothing observable.
- A number without a source, a new power on a broad grant, unbounded growth, a per-request cost: the repository's own checklist questions, where it has them.
- A protected path touched, or an undone item not listed under Undone.

## What you do not do

No summary comment, no approve, no request changes, no "LGTM", no overall verdict, no refusal to review and no recommendation to Block. Do not repeat a finding on every line it recurs; comment once and say it recurs. Do not rewrite the code in the comment beyond a line or two. Do not comment on the PR body's prose except where it misstates the diff. Do not reply to the worker's replies; your pass is over when your comments are posted.

## Finish

Your final message is only this JSON, no prose around it: `{"comments": [{"path": "src/file.ts", "line": 42, "body": "acceptance 2: ..."}]}`. If you found nothing, return one comment on the PR's first changed line saying so and naming the entries you checked, so the record shows the pass ran. Do not post to GitHub yourself.
