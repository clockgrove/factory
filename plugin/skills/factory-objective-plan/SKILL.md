---
name: factory-objective-plan
description: First step of working a Clockgrove Factory Objective (an issue labelled factory:objective). Use before any code is written to read the issue, write the plan, record every assumption and apply the Question rule. Load when a task card says to use factory-objective-plan, or when asked to plan an Objective.
---

# Plan the Objective

Read the whole issue (`$FACTORY_IN/issue.md`) and the owner's recorded decisions (`$FACTORY_IN/decisions.md`). Read the repository instructions (AGENTS.md or CLAUDE.md), any repository skill that names Objectives, and the runbooks they point to. Read only the contract documents for the code you touch.

## The plan

Write the plan to `$FACTORY_OUT/plan.md` before code, and edit it as the work moves. Factory posts it on the issue as the plan comment; you never post it yourself. On a rerun, start from `$FACTORY_IN/plan.md`, the plan as it stands. It holds, in this order:

1. **Goal in your own words.** Two or three sentences; where they disagree with the issue, the issue wins.
2. **Checklist.** Ordered items, each small enough for one implementer sub-agent, each naming the files it owns. Two items that touch the same file are one item or run in sequence. Map every acceptance entry to at least one item and name which. Mark each item done as it lands.
3. **Assumptions.** Every one, numbered, however small: a default you chose, a behaviour the issue left unsaid, a library you picked, a name you invented. An assumption nobody can read is a silent change.
4. **Design note.** When the repository has a design checklist, answer it here.

## The simplest-reading rule

Where the issue admits more than one reading, take the simplest one that satisfies every acceptance entry and every recorded decision, and record which under Assumptions. Do not build for a reading the issue does not ask for. Do not ask.

## The Question rule

An assumption that would change or remove an existing public contract (an exported type, an HTTP or CLI surface, a schema, a documented behaviour, a wire format), so that a use that works on the base commit breaks or behaves differently, that contradicts a recorded decision in the issue, or that grants new access (a permission, a credential, a service reachable from outside that was not), is not yours to make silently. Start that item with `QUESTION:` in the Assumptions list (the marker is the item's first word; the word elsewhere in prose is not one), take the simplest reading anyway, and finish everything else. The factory-deliver-pr skill then puts the question in pr.md's body and writes a `question` exit record naming, for each question, the test it meets; Factory keeps the PR a draft, so the queue moves on and a human answers in the PR. Any other addition that leaves every existing use working (a new command, endpoint, export, file or optional field) is an assumption, never a Question, and so is a reversible choice the issue leaves open (a placeholder, a stand-in, a default, a label). Raise it only when one of these tests is met; the exit costs nothing, which is why it must be rare.

## Another repository

Factory works in one repository per Objective. If the Objective needs a change in another repository, do not work around it here. Add the plan line `Needs-Repository: OWNER/NAME` and why, write a `question` exit record (test `access`), and stop before any code. Once a recorded decision takes that change out of scope, delete the line from plan.md.

## Mechanism the base lacks

If an acceptance entry needs a mechanism the base commit does not have (a table, a port, a test harness, a command, a permission), the mechanism is part of this Objective: add a checklist item for it, owned by you, before the items that depend on it. Do not fake it in a test or defer it to a later issue unless the issue says so. If building it would change or remove an existing public contract or grant new access, the Question rule applies.

## Before leaving

Confirm every acceptance entry maps to an item, every item names its files, every assumption is listed and plan.md is written. Then load factory-implement-split.
