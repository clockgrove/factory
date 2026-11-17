---
name: pendulum-draft
description: "Keep working on a draft Clockgrove Pendulum Objective by issue number: load the issue from GitHub, refine its goal and acceptance with the user, and save the changes back to the issue only on the user's yes. Use when the user asks to keep working on, refine, revise or continue a Clockgrove Pendulum Objective draft. Not for filing a new Objective (pendulum-file) or starting a draft (pendulum-start)."
---

# /pendulum:pendulum-draft <issue>

A draft Objective lives on GitHub, not in this chat: an issue with the `pendulum:draft` label, which Pendulum never runs. Load it, refine it with the user, and write it back only on their yes.

## Load it

Run `gh issue view <issue> --repo OWNER/NAME --json number,title,body,state,labels` and show the title and body.

- Closed: say so and stop.
- `pendulum:draft` on it: Pendulum does not run it; edit it freely.
- `pendulum:objective` without `pendulum:draft`: it is started. An edit before its first plan is used by the run; after it, a typo, formatting or wording-only edit keeps the plan, and any other edit Blocks the Objective at the next stage, where re-applying `pendulum:objective` plans again from the new text ([Edit an Objective](https://github.com/clockgrove/pendulum/blob/v0.9.37/docs/USAGE.md#edit-an-objective)). Say so before going on, and offer to make it a draft again first: `gh issue edit <issue> --repo OWNER/NAME --add-label pendulum:draft`, which stops a running stage the way a stop does. When `gh` says the label is not found, create it as the pendulum-file skill does, then apply it.

## Refine it

Work on it as the pendulum-file skill writes an Objective: the title, `## Goal`, `## Acceptance`, `## Context`, and its checks (doable now in this repository, nothing private). Keep the text that still fits and change only what you discussed. Ask only for what the issue cannot be written without.

## Save it

Show the whole new title and body, and say what changed. Write nothing to GitHub without a yes; on a no, keep discussing or leave the issue as it is.

On a yes:

1. Read the issue again. When its title or body changed on GitHub since you loaded it, show that change and ask which text to keep.
2. Check that `gh api repos/OWNER/NAME --jq .permissions.push` prints `true`: whoever saves the body becomes its last editor, and whoever changes the title its latest renamer, and Pendulum acts on an issue only when both can push. Otherwise say a maintainer has to save it.
3. Write the body to a temporary file, run `gh issue edit <issue> --repo OWNER/NAME --title "<title>" --body-file <file>`, and delete the file.

Then offer the next step: keep working on it, leave it as a draft, or start it ("Start Clockgrove Pendulum Objective <issue>", the pendulum-start skill).
