---
name: pendulum-stop
description: "Stop one Clockgrove Pendulum Objective on the user's yes: removes the issue's pendulum:objective label, which ends its running stage and keeps every tick and loop from picking it up; its branch and pull request stay. Use when the user asks to stop, halt or cancel one Clockgrove Pendulum Objective, or says one should not run. Not for starting one over from its issue's current text (pendulum-restart)."
---

# /pendulum:pendulum-stop <issue>

Stopping an Objective is removing its `pendulum:objective` label. Nothing else needs doing, on any route (Actions, local mode, the cloud sandbox), and the other Objectives keep running. Confirm first: a running stage ends without finishing its work.

## Check the issue

Run `gh issue view <issue> --repo OWNER/NAME --json number,title,state,labels`. When it is closed, carries no `pendulum:objective` label, or is a draft (`pendulum:draft`, which Pendulum never runs), it is stopped already: say so and stop. Otherwise note its state from its labels: `pendulum:running`, `pendulum:in-review`, `pendulum:blocked`, `pendulum:question`, or none (Queued).

## Ask

Show the issue's number, title and state, and say what the stop does:

- A running stage reads its issue once a minute: it ends its harness run, records the spend so far and exits, normally within two minutes.
- Its pull request, if it has one, leaves the merge queue and becomes a draft without the `pendulum:review` label, so nothing merges it and no review starts. A Running or In-review Objective goes back to Queued on the board; a Blocked one or a Question stays as it is.
- Nothing picks it up again until the label is re-applied, which continues from its branch and pull request. To start over from the issue's current text instead, the pendulum-restart skill applies `pendulum:restart`.
- Closing the issue stops it too, and is the way to drop it for good.

Ask for a yes. Removing a label needs triage or write access to the repository; when `gh` reports no access, say a maintainer has to do it. Starting it again is not the same: Pendulum takes the re-applied label only from someone who can push or a maintainer its workflow names, so a triager's re-apply on a Blocked or Question Objective, or on a stopped one, is refused with a comment.

## Stop it

On a yes, run `gh issue edit <issue> --repo OWNER/NAME --remove-label pendulum:objective`. Say it is stopped, and that `gh issue edit <issue> --repo OWNER/NAME --add-label pendulum:objective` starts it again.

To stop every Objective at once instead, the user disables the workflow (`gh workflow disable pendulum.yml`) and cancels its runs in the Actions tab; with the cloud sandbox, also the Objectives' sandboxes in the Vercel project, since a stage running there is no Actions run; in local mode, `pendulum serve` stops with Ctrl-C.
