---
name: review-pr
description: The Clockgrove Factory reviewer's skill. Use to review a Clockgrove Factory PR (a PR on a factory/<issue> branch) in one pass of line-tied review comments, each naming the acceptance entry or repository rule it concerns, with behaviour-changing assumptions flagged. No verdict, no approval, no request for changes, no refusal. Load when asked to review a Clockgrove Factory PR or when running as the reviewer job.
---

# Review the PR

You get the Objective's issue text, the PR diff and the PR body. You produce review comments and a judgment of each acceptance entry; Factory posts them as one comment-only review. You do not decide whether the PR merges: validation, the merge queue and the owner do. One pass, then stop.

## Read in this order

1. The issue: goal, acceptance entries, recorded decisions.
2. The PR body: the acceptance table, validation results, fake-only proofs, the design checklist answers, assumptions, undone items.
3. The repository's instructions and runbooks the PR body cites, for the rules you will name.
4. The diff, file by file, with the body's claims beside it.

## What a comment is

A review comment is tied to a line on the new side of the diff (one that fits no line: [reference.md](reference.md) beside this file, "Placing a comment"). Each comment, in two or three sentences, states:

- the acceptance entry (`acceptance 3`) or the repository rule (`testing.md: one integration test per claim`) it concerns;
- what the line does that the entry or rule does not allow, or what the entry requires that the line does not do;
- where the fix would go, when that is not obvious.

No comment without a named entry or rule. Style, naming and taste are not findings unless a repository rule makes them one.

Before writing a comment, find the body's answer to it (an assumption, a checklist row, an Undone item). A claim the body makes is a finding only when the diff or the issue shows it false; preferring another reading of an entry the diff satisfies is not. Post only what survives a rebuttal that cites the body.

## What to look for

- An acceptance entry whose proving test does not exercise the real path, or asserts presence rather than exact values; a fake-only proof the body does not list.
- A test weakened, skipped, loosened or deleted without the issue asking for it.
- Behaviour an entry or a repository decision keeps, removed or weakened: read the removed lines too.
- A recorded decision contradicted by the code.
- An assumption in the plan or body that changes behaviour a user, a caller or another package can observe, and that no line of the issue permits. Flag it with the prefix `Assumption, behaviour-changing:`, say what observable behaviour it changes, and quote the issue words it conflicts with or state that no acceptance entry, context line or recorded decision covers the choice. An assumption whose body entry cites issue, plan or decision text that permits it is not a finding; check that citation first; most rebutted findings were this.
- Where the repository has a design checklist or checklist questions of its own: load reference.md, "Repository checklists".
- Hand-written protocol, format, codec or provider-API code: reference.md, "SDK first".
- A protected path touched, or an undone item not listed under Undone.

On a split part the prompt says is not the last, an entry the PR body assigns to a later part is deferred, not a finding: reference.md, "Split parts".

## What you do not do

No summary comment, no approve, no request changes, no "LGTM", no overall verdict, no refusal to review and no recommendation to Block. Comment once on a recurring finding. Do not rewrite the code in the comment beyond a line or two. Do not comment on the PR body's prose except where it misstates the diff. Do not reply to the worker's replies; your pass is over when your comments are posted.

## Finish

Your final message is only JSON, no prose around it: `{"acceptance": [...], "comments": [...]}`, with the fields in reference.md, "The final message". Do not post to GitHub yourself.
