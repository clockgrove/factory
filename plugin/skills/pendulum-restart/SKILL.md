---
name: pendulum-restart
description: "Restart one Pendulum Objective from its issue's current text, in any state, on the user's yes: applies the pendulum:restart label, which stops a running stage and discards the earlier plan, branch and pull request. Use when the user asks to restart, redo or start over a Pendulum Objective, or says one was built from the wrong text. Not for pausing one (pendulum-stop), or letting one go on after a fix or an answer (pendulum-status)."
---

# /pendulum:pendulum-restart <issue>

Restarting an Objective is applying the `pendulum:restart` label to its issue, in any state: Queued, Running, In review, Blocked or a Question. The run that follows plans from the issue's text as it is now. Confirm first: the work done so far is set aside.

## Check the issue

Run `gh issue view <issue> --repo OWNER/NAME --json number,title,state,labels`. A closed issue cannot restart. Keep `pendulum:objective` on managed issues. If an older stopped Objective lacks it, use the filing skill's Draft-first steps to restore the identity while it is held. A restart requested while Draft is on waits for its removal.

For continuing after a fix or an answer, follow pendulum-status. Resuming via Draft keeps the existing branch and pull request.

## Ask

Show the issue's number, title and state, and say what the restart does:

- A running stage reads its issue once a minute: it ends its harness run, records the spend so far and exits.
- Then the dispatcher closes the earlier pull request with a comment linking the restart (its commits and review stay readable there), deletes the `pendulum/<issue>` branch, sets the earlier plan aside, and queues the Objective again. The restarted run starts from the default branch and the issue's current text; comments made before the label was applied do not feed it.
- The restart record on the issue names the deleted branch's last commit, so the branch can be restored. The retry and rebase counts start over. The scorecard counts the restart as a human action.

Ask for a yes, saying the label is created first when the repository lacks it. Pendulum restarts an Objective only for a person who can push to the repository or is a maintainer its workflow names; anyone else's label, an App's own token's included, is taken off with a comment.

## Restart it

On a yes, run `gh issue edit <issue> --repo OWNER/NAME --add-label pendulum:restart`. When GitHub says the label does not exist, create it with `gh label create pendulum:restart --repo OWNER/NAME --color 5319E7 --description "Restart this Objective from the issue's current text (any state)"`, then apply it.

Report the restart request. If Draft is on, it still holds the issue. Use pendulum-file to remove Draft when the user approves running it. The restart label comes off after the dispatcher restarts it.
