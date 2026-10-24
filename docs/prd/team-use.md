# Team use (draft, for discussion)

A feature on top of [the requirements](../PRD.md). It's not scheduled: Factory is single player until this page is agreed and built. Until then, a second machine on the same repository or Project is refused.

## Problem

A small team shares a repository and its Project, and only one person's machine can run Factory. Everyone else can queue and answer through GitHub, but:

- work stops whenever that machine is off;
- only that person's GitHub account and model subscriptions are used;
- nobody else can see run detail or use the CLI.

## Use cases

1. **Parallel operators.** Two developers each run Factory on their own machine against one Project. Their Objectives run at the same time, and no Objective is worked twice.
2. **Handoff.** One machine goes offline mid-run. Another operator's machine picks up its Objectives and continues, with no duplicate PR, comment or merge.
3. **Shared view.** Any operator sees every Objective's status from their own CLI, and can answer any question.
4. **Shared learning.** Every machine plans and reviews with the same repository memory and playbook.
5. **Attribution.** Each machine acts with its own operator's GitHub and model logins, so it's clear who did what and whose subscription paid for it.

## Requirements

- An Objective is worked by exactly one machine at a time. A machine that stops loses its claims after a deadline.
- Shared state lives in git on GitHub (see [Storage](#storage-git-on-github)), and every machine reads and writes it.
- No new kind of failure: every stability rule in the requirements holds across machines, including crash-only restarts and no duplicate effects.
- Each machine keeps its own limits on how much it runs at once.
- A team can turn this on deliberately, and a single-player installation keeps working unchanged.

## Storage: git on GitHub

Team use needs nothing beyond GitHub: no hosted database and no hosted service. Every machine has a local clone of Factory's shared data and works from it.

**What's in git:**

| Data                                                | Notes                                                                      |
| --------------------------------------------------- | -------------------------------------------------------------------------- |
| Each Objective's state, plan, questions and answers | Enough for any machine to continue the Objective                           |
| Claims                                              | Which machine is working which Objective, and until when                   |
| Repository memory                                   | Failures, holds, worker learnings, operator decisions, one episode per run |
| The playbook                                        | Each approved version, and the drafts waiting for a decision               |

**What stays local to each machine:** configuration, credentials and logins, the working clone of the target, and run logs and captures. Logs and captures can include prompts, so they're never pushed.

**Where it lives:** never on the target's default branch or in its PRs, so it adds nothing to the project's history.

- In a private target repository: Factory's own branch in that repository, with no extra setup.
- In a public target repository: a separate private repository that the team names at setup. Memory records failures and operator decisions, so it must never be public.

**How machines share it:**

- **One file per record, never edited in place.** Two machines never change the same file, so a push can't conflict, and every record reads as plain text in a diff.
- **Sync.** A machine pulls before it reads and pushes after it writes. A push that loses a race pulls and pushes again.
- **Claims.** Claiming an Objective is a git update that only succeeds if no one claimed it first. A claim lapses after a deadline unless its machine renews it, and then another machine may take the Objective.
- **Search.** Memory is searched in the local clone with ripgrep, which ships with Codex and Claude Code. There's no index to build: at the supported size (the newest 1,000 episodes), a full scan takes milliseconds. Factory ranks the matches itself (how well they match, how close their paths are, how recent they are) to fill each role's memory budget.
- **Bounded.** Memory keeps the newest records and drops the oldest. History stays in git and is never read to make progress.

**How machines see changes.** Polling is the only option: webhooks would need a public endpoint on every machine, which is infrastructure.

- Each machine checks the shared branch's tip every 30 seconds, the same cadence as the queue. It uses a conditional request, so an unchanged tip costs nothing against GitHub's rate limit. It fetches only when the tip moved.
- GitHub itself (issues, comments, Project cards, PRs) is polled the same way, with conditional requests budgeted for the number of machines.
- **Freshness affects speed, never correctness:**
  - A claim succeeds only on the tip its machine read, so stale views can't both win.
  - A machine confirms its claim before each step. If it can't renew a claim, it stops working that Objective before the claim lapses, so a machine that takes over never acts alongside it.
  - Memory reaches the other machines within one poll interval, which is soon enough for planning and review.

**One storage model.** Once team use ships, single player uses the same git storage, and the local SQLite store goes away.

**To show in the design:** that GitHub's rate limits and git's push contention hold up for the supported number of machines, at the expected rate of writes and polls.

## Open questions

- Who may operate: anyone with write access, or a named list of operators?
- How do a team's Objectives share out across machines: first come, by owner, or by capacity?
- Turning team use on: how does an existing single-player installation join, and how does a machine leave?
- How many machines must it support, and how many writes a minute does that mean?
- Who prunes memory, and when: any machine, or one at a time?

## Not in scope

- A hosted database, a hosted Factory service or a dashboard.
- Machines that serve different repositories but share one installation.

## Done

To be written once the open questions are answered. It will include a drill with two machines on one Project, with one stopped mid-run.
