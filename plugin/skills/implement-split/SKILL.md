---
name: implement-split
description: Second step of working a Factory Objective, after objective-plan. Use to implement the plan's checklist with implementer sub-agents on the pinned model, run disjoint-file items concurrently, integrate once, and split an Objective too large for one session into sequential PRs. Load when a task card says to use implement-split.
---

# Implement the checklist

You are the worker session on the strong model. You plan, integrate and deliver; the implementer sub-agent writes the code of each checklist item. Keep the whole Objective in your own context so you can see which items are independent.

## Implementer sub-agents

Spawn the `implementer` agent definition the job wrote into the checkout (`.claude/agents/implementer.md`, `.codex/agents/implementer.toml` or `.github/agents/implementer.agent.md`). Never pass a model at spawn time and never edit the definition: the model is pinned in the file so cost stays where the budget expects it, and the definition is a protected path.

Give each implementer one checklist item and nothing more: the item's text, the files it owns, the acceptance entries it serves, the relevant lines of the issue and of the repository instructions, and the one command that proves the item (a focused test, not the whole suite). Tell it the files it may not touch. Ask for a short report: files changed, the command run, its result, anything it assumed. Read the diff it produced before accepting it.

An implementer that fails twice on the same item is a planning fault: re-read the item, split it or re-scope it in `$FACTORY_OUT/plan.md`, and try again yourself or with a new implementer.

## Run disjoint items at the same time

Items whose owned files do not overlap, and that do not depend on each other's output, run concurrently: start their implementers together and wait for all of them. Items that share a file, or that need an earlier item's export, run after it. Keep the number running at once to what the session's sub-agent limit allows; the agent definition or the harness sets that, not you.

## Integrate once

After every item has landed, integrate once in the worker session: resolve overlaps, reconcile names, remove scaffolding the implementers left (temporary unit tests, debug output, TODOs that the plan already answers), and run the repository's formatter. Then run the validation commands once over the whole tree; this is the first time the full suite runs. Do not validate per item beyond the focused command; the full run is the integration's job.

Commit as you go on `factory/<issue>`. Each commit message names the checklist item. Never push: Factory pushes the branch once you stop.

## Too large for one session

If the checklist cannot finish within the hour and dollar budget on the task card, or the integrated diff would exceed what a reviewer can read in one pass, split it: finish the first self-contained group of items, deliver it as this part's PR through prove-acceptance and deliver-pr, mark in plan.md which items remain for a later part, and list them in your exit record as `"part": {"remaining": [...]}`. Factory links that PR to the issue without closing it; once it merges, Factory starts the next part from the default branch, with the plan in `$FACTORY_IN/plan.md` and the merged parts in `$FACTORY_IN/parts.md`. Each PR stands alone: validation green, acceptance entries it proves named in its body, nothing the next part needs left broken. The last part leaves `part` out, and its PR closes the issue. Factory caps an Objective at six parts. Decide this early, from the plan, not after the budget runs out.

## Before leaving this step

Every checklist item is marked done in plan.md or assigned to a later part, the tree is formatted, and the validation commands have run once over the integrated tree. Then load prove-acceptance.
