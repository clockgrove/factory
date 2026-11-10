---
name: prove-acceptance
description: Third step of working a Factory Objective, after implement-split and before deliver-pr. Use to prove every acceptance entry through the repository's real path per its testing guide, run the validation and test-budget commands, apply the base-failure rule and iterate locally before you hand off. Load when a task card says to use prove-acceptance.
---

# Prove the acceptance

Every acceptance entry in the issue gets a proof that a reviewer can run. A claim without a proof is not done.

## The real path

Prove each entry through the path the repository's testing guide calls real: the component that owns the behaviour, the real database, the real HTTP or CLI surface, the real browser where the guide places browser tests. One lasting test per claim, asserting exact values, placed where the guide says that kind of test lives. A proof that runs only against a fake, a mock or an in-memory stand-in is not a proof of the entry; if the real path cannot run in this sandbox, say so in pr.md (deliver-pr lists these) and keep the fake-only test marked as such in its name or a comment. Delete scaffolding tests the guide calls disposable before handoff.

## Never weaken a test

Do not edit, skip, loosen, retry or delete an existing test to make it pass, unless the issue asks for that change by name. Do not raise a timeout, widen an assertion, add a `skip` or an `only`, or move a test out of CI. If a test contradicts the issue, the issue wins and the plan comment records the contradiction as an assumption; if it contradicts a recorded decision, the Question rule applies.

## Never dodge a policy check

Meet a failing license, vulnerability or supply-chain check; never remove, override or pin away a needed dependency, or edit the policy. If only a policy change would meet it, apply the Question rule and name the decision.

## The budget command

Run the budget command from the task card exactly as given and make it pass. It compares your change with its base; in a checkout that lacks the default-branch ref, pass the base commit the way the repository's testing guide says. The owner grants no exceptions through you: do not edit the budget file, do not add an exception entry, do not raise an allowance. If the budget fails, shrink the tests (rewrite them smaller, remove redundant variants, delete scaffolding) or move more of the change into production code that earns its tests.

## The base-failure rule

A test that fails identically on the untouched base commit is not yours. Before chasing a failure, check out the base in a scratch worktree (or stash your change), run the same command, and compare. If it fails the same way there, name the test and the identical failure in pr.md under validation results and leave it alone. Do not fix it, do not skip it, do not mention it anywhere else. A failure that appears only with your change is yours.

## Iterate locally

Run every validation command on the task card and the budget command, read every failure, fix, and run again, as many times as it takes, before you hand off. Factory pushes your commits and re-runs validation at most twice; the second red run Blocks the Objective. Your own iterations are cheap; Factory's are not. Run the formatter before the final run.

## Comments

Write a code comment only where the code does not explain itself: a non-obvious invariant, a number with its source, a workaround with the issue it works around. No narration, no restated signatures, no headers that say what a function is named.

## Before leaving this step

Every acceptance entry maps to a test that ran and passed through its real path or is listed as fake-only with a reason; every validation command and the budget command are green or carry a base failure named in your notes; the formatter has run. Then load deliver-pr.
