---
name: pendulum-status
description: "Show what Pendulum is doing in the current repository, read-only: each open Objective's state and route, and for a Blocked one or a Question the reason and the way on (resume, answer or restart), taken only on the user's yes. Use when the user asks what Pendulum is doing, what is running or queued, why an Objective is Blocked or stuck, or how to answer or resume one. Not for whether the repository is set up (pendulum-doctor) or the scorecard of finished Objectives (pendulum-score)."
---

# /pendulum:pendulum-status [issue]

Read GitHub and report; change nothing. A way on is one of Pendulum's labels or a comment, taken only on the user's yes.

## Read the queue

1. `gh issue list --repo OWNER/NAME --state open --label pendulum:objective --json number,title,labels,createdAt --limit 100`, and the same with `--label pendulum:draft` to include legacy drafts without the Objective label. Combine by issue number. Given an issue number, `gh issue view <issue> --repo OWNER/NAME --json number,title,state,labels` alone.
2. Read state from its labels ([reference.md](reference.md), States). A closed issue is done. Draft holds processing. An issue without `pendulum:objective` is unadmitted or stopped under the older flow. `pendulum:restart` records a restart request.
3. Its route: `pendulum:local`, the local loop's; any other, the Action's (the local loop's where no Action is active).
4. For a Running one, the steps table in Pendulum's progress comment on the issue: its last row, marked **Now**, is the step in progress and for how long; with no **Now** row the stage is between steps, and the rows above say what has run.

Show one line per Objective, oldest first: number, title, state, route, and for Blocked and Question the one-line reason (below). `pendulum wait` (the pendulum-serve skill) waits for the next change instead of asking again.

## Blocked

Read the issue's comments (`gh issue view <issue> --repo OWNER/NAME --comments`) and take Pendulum's latest Blocked notice: its first line is the marker `<!-- pendulum:<issue>:blocked:` and its text says `Blocked (<stage>):`. Relay its reason, its fix and its last paragraph, and offer only the way on that paragraph names; an older notice without one, its cause's ([reference.md](reference.md), Block causes; no cause line: `work`):

- **"Resume, don't restart"** (`resume`): apply the notice's fix, then [resume through Draft](reference.md#resume-through-draft). It goes on from its branch and PR.
- **"Resume once the cause is fixed"** (`work`): resume through Draft. Restart only when the user wants to redo the work.
- **"To keep the work instead of restarting"**: apply the fix, then retry the requested restart with pendulum-restart or resume through Draft to keep the work.
- **"Neither a resume nor a restart gets past this"**: its author cannot push. Offer that someone who can push files it again (the pendulum-file skill).

## Question

Read Pendulum's Question: its notice on the issue (first line `<!-- pendulum:<issue>:question:`, text `Question (<stage>):`), else the `QUESTION:` items of its draft PR's body (`gh pr list --repo OWNER/NAME --head pendulum/<issue> --state open --json number,body`). Show it and where it is answered ([reference.md](reference.md), Questions):

- **On the issue** (no open PR, or the notice's marker ends `:issue`): the user's decision as a comment on the issue. Never mark the PR ready.
- **On the PR** (otherwise): the decision as a comment on the issue or the PR, then the PR marked ready (`gh pr ready <pr> --repo OWNER/NAME`).

Post the user's approved answer with `gh issue comment` or `gh pr comment`. A comment without a decision may leave it open. A requested worker rerun uses Draft instead of sending the answer to the review job.

## Who can act

Pendulum takes a Draft removal, an answer or a restart only from someone who can push or a maintainer the workflow names. Check `gh api repos/OWNER/NAME --jq .permissions.push`. When `gh` fails, relay its message.
