---
name: pendulum-status
description: "Show what Pendulum is doing in the current repository, read-only: each open Objective's state and route, and for a Blocked one or a Question the reason and the way on (resume, answer or restart), taken only on the user's yes. Use when the user asks what Pendulum is doing, what is running or queued, why an Objective is Blocked or stuck, or how to answer or resume one. Not for whether the repository is set up (pendulum-doctor) or the scorecard of finished Objectives (pendulum-score)."
---

# /pendulum:pendulum-status [issue]

Read GitHub and report; change nothing. A way on is one of Pendulum's labels or a comment, taken only on the user's yes.

## Read the queue

1. `gh issue list --repo OWNER/NAME --state open --label pendulum:objective --json number,title,labels,createdAt --limit 100`, and the same with `--label pendulum:draft`, merged by number (a draft may carry both). Given an issue number, `gh issue view <issue> --repo OWNER/NAME --json number,title,state,labels` alone.
2. Each one's state from its labels ([reference.md](reference.md), States). A closed issue is done. `pendulum:draft` wins over every other label: a draft, never run. An open issue without `pendulum:objective` is stopped. `pendulum:restart` on it: a restart is under way.
3. Its route: `pendulum:local`, the local loop's; any other, the Action's (the local loop's where no Action is active).
4. For a Running one, the status line of Pendulum's progress comment on the issue.

Show one line per Objective, oldest first: number, title, state, route, and for Blocked and Question the one-line reason (below). `pendulum wait` (the pendulum-serve skill) waits for the next change instead of asking again.

## Blocked

Read the issue's comments (`gh issue view <issue> --repo OWNER/NAME --comments`) and take Pendulum's latest Blocked notice: its first line is the marker `<!-- pendulum:<issue>:blocked:` and its text says `Blocked (<stage>):`. Relay its reason, its fix and its last paragraph, and offer only the way on that paragraph names; an older notice without one, its cause's ([reference.md](reference.md), Block causes; no cause line: `work`):

- **"Resume, don't restart"** (`resume`): the notice's fix first (a push to `pendulum/<issue>`, an issue edit, a secret, a setting; pendulum-doctor checks setup), then re-apply the label: `gh issue edit <issue> --repo OWNER/NAME --remove-label pendulum:objective`, then `--add-label pendulum:objective`. It goes on from its branch and PR. Never offer a restart.
- **"Resume once the cause is fixed"** (`work`): the same resume. A restart (the pendulum-restart skill) only when the user says the work must be redone: it discards the PR, its review, the branch's commits and their spend.
- **"To keep the work instead of restarting"**: a restart could not finish. After its fix, the pendulum-restart skill applies it again; or re-apply the label to keep the work.
- **"Neither a resume nor a restart gets past this"**: its author cannot push. Offer that someone who can push files it again (the pendulum-file skill).

## Question

Read Pendulum's Question: its notice on the issue (first line `<!-- pendulum:<issue>:question:`, text `Question (<stage>):`), else the `QUESTION:` items of its draft PR's body (`gh pr list --repo OWNER/NAME --head pendulum/<issue> --state open --json number,body`). Show it and where it is answered ([reference.md](reference.md), Questions):

- **On the issue** (no open PR, or the notice's marker ends `:issue`): the user's decision as a comment on the issue. Never mark the PR ready.
- **On the PR** (otherwise): the decision as a comment on the issue or the PR, then the PR marked ready (`gh pr ready <pr> --repo OWNER/NAME`).

Write the answer with the user and post it (`gh issue comment` or `gh pr comment`) on their yes; a comment that decides nothing ("I'll look tomorrow") may leave it open. Re-applying `pendulum:objective` instead reruns the worker with it unjudged.

## Who can act

Pendulum takes a re-applied label, an answer or a restart only from someone who can push or a maintainer the workflow names: unless `gh api repos/OWNER/NAME --jq .permissions.push` prints `true`, say a maintainer has to. When `gh` fails, relay its message.
