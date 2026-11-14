---
name: factory-stop
description: "/factory:factory-stop <issue>. Stop one Clockgrove Factory Objective on the user's yes: removes the issue's factory:objective label, which ends its running stage and keeps every tick and loop from picking it up. Use when the user asks to stop, halt or cancel one Clockgrove Factory Objective, or says one should not run."
---

# /factory:factory-stop <issue>

Stopping an Objective is removing its `factory:objective` label. Nothing else needs doing, on any route (Actions, local mode, the cloud sandbox), and the other Objectives keep running. Confirm first: a running stage ends without finishing its work.

## Check the issue

Run `gh issue view <issue> --repo OWNER/NAME --json number,title,state,labels`. When it is closed, or carries no `factory:objective` label, it is stopped already: say so and stop. Otherwise note its state from its labels: `factory:running`, `factory:in-review`, `factory:blocked`, `factory:question`, or none (Queued).

## Ask

Show the issue's number, title and state, and say what the stop does:

- A running stage reads its issue once a minute: it ends its harness run, records the spend so far and exits, normally within two minutes.
- Its pull request, if it has one, leaves the merge queue and becomes a draft without the `factory:review` label, so nothing merges it and no review starts. A Running or In-review Objective goes back to Queued on the board; a Blocked one or a Question stays as it is.
- Nothing picks it up again until the label is re-applied, which continues from its branch and pull request.
- Closing the issue stops it too, and is the way to drop it for good.

Ask for a yes. Removing a label needs triage or write access to the repository; when `gh` reports no access, say a maintainer has to do it.

## Stop it

On a yes, run `gh issue edit <issue> --repo OWNER/NAME --remove-label factory:objective`. Say it is stopped, and that `gh issue edit <issue> --repo OWNER/NAME --add-label factory:objective` starts it again.

To stop every Objective at once instead, the README's "To stop everything" says how.
