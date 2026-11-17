---
name: pendulum-status
description: "Show what Clockgrove Pendulum is doing in the current repository, read-only: each open Objective's state and route, and for one that is Blocked or asks a Question the reason Pendulum gave and the way on (fix it and resume by re-applying pendulum:objective, answer the Question, or restart), taken only on the user's yes. Use when the user asks what Clockgrove Pendulum is doing, what is running or queued, why an Objective is Blocked or stuck, or how to answer or resume one. Not for whether the repository is set up (pendulum-doctor) or the scorecard of finished Objectives (pendulum-score)."
---

# /pendulum:pendulum-status [issue]

Read GitHub and report; change nothing. A way on it offers is one of Pendulum's labels or a comment, taken only once the user has read what it does and said yes.

## Read the queue

1. `gh issue list --repo OWNER/NAME --state open --label pendulum:objective --json number,title,labels,createdAt --limit 100`, and the same with `--label pendulum:draft`. Given an issue number, `gh issue view <issue> --repo OWNER/NAME --json number,title,state,labels` alone.
2. Each one's state from its labels ([reference.md](reference.md), States). A closed issue is done. `pendulum:draft` wins over every other label: a draft, never run. An open issue without `pendulum:objective` is stopped. `pendulum:restart` on it: a restart is under way.
3. Its route: `pendulum:local` is the local loop's on the machine that runs `pendulum serve`; any other, the Action's, or the local loop's where no Action is active.
4. For a Running one, the status line of Pendulum's progress comment on the issue.

Show one line per Objective, oldest first: number, title, state, route, and for Blocked and Question the one-line reason (below). Stop there unless one is Blocked or a Question, or the user asks about one. To be told of the next change rather than ask again, `pendulum wait` (the pendulum-serve skill) waits for it.

## Blocked

Read the issue's comments (`gh issue view <issue> --repo OWNER/NAME --comments`) and take Pendulum's latest Blocked notice: its first line is the marker `<!-- pendulum:<issue>:blocked:` and its text says `Blocked (<stage>):`. Relay its reason, its fix and its last paragraph, which says whether to resume or restart. Its cause is the notice's last line ([reference.md](reference.md), Block causes). Then offer the way on:

- **Fix, then resume (the usual way):** the fix the notice names comes first (a push to `pendulum/<issue>`, an issue edit, a secret, a setting; the pendulum-doctor skill checks setup). Then re-apply the label: `gh issue edit <issue> --repo OWNER/NAME --remove-label pendulum:objective`, then `--add-label pendulum:objective`. It goes on from its branch and PR; after an issue edit it plans again from the new text.
- **Restart:** only when the work itself must be redone: it discards the PR, its review, the branch's commits and the spend on them. Hand over to the pendulum-restart skill.

## Question

Read Pendulum's Question: its notice on the issue (first line `<!-- pendulum:<issue>:question:`, text `Question (<stage>):`), or, with no notice since the `pendulum:question` label, the `QUESTION:` items of its draft PR's body (`gh pr list --repo OWNER/NAME --head pendulum/<issue> --state open --json number,body`). Show it, then where it is answered ([reference.md](reference.md), Questions):

- **On the issue** (no open PR, or the notice's marker ends `:issue`): the user's decision as a comment on the issue. Never mark the PR ready.
- **On the PR** (otherwise): the decision as a comment on the issue or the PR, then the PR marked ready (`gh pr ready <pr> --repo OWNER/NAME`).

Write the answer with the user, in their words, and post it with `gh issue comment` or `gh pr comment` only on their yes; with a decision model, a comment that decides nothing, such as "I'll look tomorrow", leaves it open. Re-applying `pendulum:objective` instead reruns the worker with the answer unjudged.

## Who can act

Pendulum takes a re-applied label, an answer or a restart only from someone who can push to the repository or a maintainer the workflow names. Check `gh api repos/OWNER/NAME --jq .permissions.push` prints `true` before offering one; otherwise say a maintainer has to. When `gh` fails, relay its message.
