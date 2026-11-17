---
name: pendulum-restart
description: "Restart one Pendulum Objective from its issue's current text, in any state, on the user's yes: applies the pendulum:restart label, which stops a running stage and discards the earlier plan, branch and pull request. Use when the user asks to restart, redo or start over a Pendulum Objective, or says one was built from the wrong text. Not for pausing one (pendulum-stop), or letting one go on after a fix or an answer (pendulum-status)."
---

# /pendulum:pendulum-restart <issue>

Restarting an Objective is applying the `pendulum:restart` label to its issue, in any state: Queued, Running, In review, Blocked or a Question. The run that follows plans from the issue's text as it is now. Confirm first: the work done so far is set aside.

## Check the issue

Run `gh issue view <issue> --repo OWNER/NAME --json number,title,state,labels`. A closed issue is not restarted: say so and stop. Note its state from its labels (`pendulum:running`, `pendulum:in-review`, `pendulum:blocked`, `pendulum:question`, or none: Queued). When it carries no `pendulum:objective` label it is stopped: the restart waits until that label is back, so offer to apply both. A draft (`pendulum:draft`) is not restarted until it is started (the pendulum-file skill): say so.

When the user only wants it to go on after a fix or an answer, a restart is not needed: re-applying `pendulum:objective` continues from its branch and pull request. Say so if that is what they described.

## Ask

Show the issue's number, title and state, and say what the restart does:

- A running stage reads its issue once a minute: it ends its harness run, records the spend so far and exits.
- Then the dispatcher closes the earlier pull request with a comment linking the restart (its commits and review stay readable there), deletes the `pendulum/<issue>` branch, sets the earlier plan aside, and queues the Objective again. The restarted run starts from the default branch and the issue's current text; comments made before the label was applied do not feed it.
- The restart record on the issue names the deleted branch's last commit, so the branch can be restored. The retry and rebase counts start over. The scorecard counts the restart as a human action.

Ask for a yes, saying the label is created first when the repository lacks it. Pendulum restarts an Objective only for a person who can push to the repository or is a maintainer its workflow names; anyone else's label, an App's own token's included, is taken off with a comment.

## Restart it

On a yes, run `gh issue edit <issue> --repo OWNER/NAME --add-label pendulum:restart` (with `--add-label pendulum:objective` too for a stopped one). When GitHub says the label does not exist (setup's labels step makes it), create it with `gh label create pendulum:restart --repo OWNER/NAME --color 5319E7 --description "Restart this Objective from the issue's current text (any state)"`, then apply it.

Say it is restarting: the label comes off once the dispatcher has restarted it, and the issue's progress comment shows the new run.
