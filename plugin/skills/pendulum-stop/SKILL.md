---
name: pendulum-stop
description: "Stop one Pendulum Objective on the user's yes by applying pendulum:draft. Keep its Objective label, branch and pull request. Use when asked to stop, hold or halt an Objective. Not for starting over from its current text (pendulum-restart)."
---

# /pendulum:pendulum-stop <issue>

Apply `pendulum:draft` to stop the Objective on its current route. Keep `pendulum:objective` on the issue. Confirm first because a running stage ends without finishing its work.

## Check the issue

Run `gh issue view <issue> --repo OWNER/NAME --json number,title,state,labels`. A closed issue or an issue without `pendulum:objective` cannot run. If Draft is already on, check whether its old stage is still stopping and report what you find. Otherwise note its state using pendulum-status.

## Ask

Show the issue's number, title and state, and say what the stop does:

- A running stage reads its issue once a minute: it ends its harness run, records the spend so far and exits, normally within two minutes.
- Its pull request, if it has one, leaves the merge queue and becomes a draft without the `pendulum:review` label, so nothing merges it and no review starts. A Running or In-review Objective goes back to Queued on the board; a Blocked one or a Question stays as it is.
- While Draft is on, nothing picks it up. Removing Draft after the stop settles queues it with its branch and pull request. Use pendulum-restart to start over from the issue's current text.
- Closing the issue stops it too, and is the way to drop it for good.

Ask for a yes. If GitHub refuses the label edit, relay the refusal. Pendulum takes a Draft removal that queues work only from someone who can push or a maintainer its workflow names.

## Stop it

On a yes, run `gh issue edit <issue> --repo OWNER/NAME --add-label pendulum:draft`. Report that Draft is on. When there was an active stage or queued merge, follow the existing stop until the stage exits and the PR leaves the queue. Use pendulum-file to remove Draft once it has stopped and the user wants it queued again.

To stop every Objective at once instead, the user disables the workflow (`gh workflow disable pendulum.yml`) and cancels its runs in the Actions tab; with the cloud sandbox, also the Objectives' sandboxes in the Vercel project, since a stage running there is no Actions run; in local mode, `pendulum serve` stops with Ctrl-C.
