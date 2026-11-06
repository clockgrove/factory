---
name: objective-plan
description: First step of working a Factory Objective (an issue labelled factory:objective). Use before any code is written to read the issue, post the plan comment, record every assumption and apply the Question rule. Load when a task card says to use objective-plan, or when asked to plan an Objective.
---

# Plan the Objective

Read the whole issue: goal, acceptance, sources, context and the owner's recorded decisions. Read the repository instructions (AGENTS.md or CLAUDE.md), any repository skill that names Objectives, and the runbooks they point to. Read only the contract documents for the code you will touch, not whole READMEs.

Do not read code to plan. Every question you have about the code (which files implement something, how a behaviour is tested, what a contract or pattern looks like) goes to the `explorer` agent definition the job wrote into the checkout (`.claude/agents/explorer.md`, `.codex/agents/explorer.toml` or `.github/agents/explorer.agent.md`), one question per spawn, with the issue lines it relates to. Work from its answers, which name files and lines; put the paths it returns into the checklist items. Your own context holds the issue, the plan and the answers, not file contents.

## The plan comment

Post one comment on the issue before writing code, and edit that same comment as the work moves; never post a second one. Mark it with `<!-- factory:<issue>:plan -->` on its first line, with the issue number in place of `<issue>`, so a rerun and the scorecard find it. It holds, in this order:

1. **Goal in your own words.** Two or three sentences. If your words and the issue disagree, the issue wins; fix your words.
2. **Checklist.** Ordered items, each small enough for one implementer sub-agent, each naming the files it owns. Two items that touch the same file are one item or run in sequence. Map every acceptance entry to at least one item and name which. Mark each item done by editing the comment as it lands.
3. **Assumptions.** Every one, numbered, however small: a default you chose, a behaviour the issue left unsaid, a library you picked, a name you invented. An assumption nobody can read is a silent change.
4. **Design note.** When the repository has a design checklist, answer it here before code exists; the deliver-pr skill answers it again with evidence.

## The simplest-reading rule

Where the issue admits more than one reading, take the simplest one that satisfies every acceptance entry and every recorded decision, say which reading you took under Assumptions, and move on. Do not build for a reading the issue does not ask for. Do not ask.

## The Question rule

An assumption that would change a public contract (an exported type, an HTTP or CLI surface, a schema, a documented behaviour, a wire format) or that contradicts a recorded decision in the issue is not yours to make silently. Start that item with `QUESTION:` in the Assumptions list (the marker is the item's first word; the word elsewhere in prose is not one), take the simplest reading anyway, and finish everything else. The deliver-pr skill then opens the PR as a draft with the question in its body, so the queue moves on and a human answers in the PR. Raise it only when this test is met; the exit costs nothing, which is why it must be rare.

## Mechanism the base lacks

If an acceptance entry needs a mechanism the base commit does not have (a table, a port, a test harness, a command, a permission), the mechanism is part of this Objective: add a checklist item for it, owned by you, placed before the items that depend on it. Do not fake the mechanism in a test and do not defer it to a later issue unless the issue says so. If building it would itself change a public contract, the Question rule applies.

## Before leaving this step

Confirm the checklist covers every acceptance entry, every item names its files, every assumption is listed, and the comment is posted. Then load implement-split.
