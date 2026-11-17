---
name: pendulum-implement-split
description: "Internal: the second stage of a Clockgrove Pendulum worker run, loaded only when a Pendulum task card names it. Implements the plan's checklist with implementer sub-agents on the pinned model, runs disjoint-file items concurrently, integrates once, and splits an Objective too large for one session into sequential PRs."
user-invocable: false
---

# Implement the checklist

You are the worker session on the strong model. You plan, integrate and deliver; the implementer sub-agent writes the code of each checklist item. Keep the whole Objective in your own context to see which items are independent.

## Implementer sub-agents

Spawn the `implementer` agent definition the job wrote into the checkout (`.claude/agents/implementer.md`, `.codex/agents/implementer.toml` or `.github/agents/implementer.agent.md`). Never pass a model at spawn time and never edit the definition: the model is pinned in the file so cost stays where the budget expects it, and the definition is a protected path.

Give each implementer one checklist item and nothing more: the item's text, the files it owns, the acceptance entries it serves, the relevant lines of the issue and of the repository instructions, and the one command that proves the item (a focused test, not the whole suite). Tell it the files it may not touch. Ask for a short report: files changed, the command run, its result, anything it assumed. Read the diff it produced before accepting it.

Where an item speaks a protocol, a file format, a codec or a provider's API, use the official SDK or a maintained library whose licence the repository can take; write that code yourself only when none fits (no library, a licence that does not fit, an unwanted install script or native binary, byte-for-byte deterministic output). Name the choice, or what you looked at and why it did not fit, under Assumptions in plan.md.

An implementer that fails twice on the same item is a planning fault: re-read the item, split it or re-scope it in `$PENDULUM_OUT/plan.md`, and try again yourself or with a new implementer.

## Run disjoint items at the same time

Items whose owned files do not overlap, and that do not depend on each other's output, run concurrently: start their implementers together and wait for all of them. Items that share a file, or that need an earlier item's export, run after it. Run no more at once than the session's sub-agent limit allows.

## Integrate once

After every item has landed, integrate once in the worker session: resolve overlaps, reconcile names, remove scaffolding the implementers left (temporary unit tests, debug output, TODOs that the plan already answers), and run the repository's formatter. Then run the validation commands once over the whole tree, the first full run: per item, only its focused command.

Commit as you go on `pendulum/<issue>`, each message naming its checklist item. Never push: Pendulum pushes the branch once you stop.

## Too large for one session

If the checklist cannot finish within the hour and dollar budget on the task card, or the integrated diff would exceed what a reviewer can read in one pass, split it: finish the first self-contained group of items, deliver it as this part's PR through pendulum-prove-acceptance and pendulum-deliver-pr, mark in plan.md which items remain, and list them in your exit record as `"part": {"remaining": [...]}`. Once that PR merges, Pendulum starts the next part from the default branch, with the plan in `$PENDULUM_IN/plan.md` and the merged parts in `$PENDULUM_IN/parts.md`. Each PR stands alone: validation green, the acceptance entries it proves named in its body, nothing the next part needs left broken. The last part leaves `part` out; its PR closes the issue. Decide this early, from the plan.

The task card caps the parts (`max_parts`): a count of PRs, not a spend bound, since each part's jobs have budgets of their own. When the plan needs more parts than that, stop before building: a `blocked` exit whose reason names `max_parts` and the groups, so the owner raises the cap or narrows the issue.

## Before leaving this step

Every checklist item is marked done in plan.md or assigned to a later part, the tree is formatted, and the validation commands have run once over the integrated tree. Then load pendulum-prove-acceptance.
