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
- Shared state lives in git on GitHub, and every machine reads and writes it: Objective state, plans, questions and answers, claims, memory and the playbook.
- No new kind of failure: every stability rule in the requirements holds across machines, including crash-only restarts and no duplicate effects.
- Each machine keeps its own limits on how much it runs at once.
- A team can turn this on deliberately, and a single-player installation keeps working unchanged.

## Storage

Shared state lives in git on GitHub, so team use needs nothing beyond GitHub: no hosted database and no hosted service. Memory and the playbook are recorded in git, and each machine keeps its local SQLite store as a search index rebuilt from git. The design has to show that git and GitHub's API can carry the claims and shared state for the supported number of machines, within GitHub's rate limits.

## Open questions

- Who may operate: anyone with write access, or a named list of operators?
- How do a team's Objectives share out across machines: first come, by owner, or by capacity?
- Run logs and captures can include prompts. Do they stay on the machine that made them, or are they shared?
- Turning team use on: how does an existing single-player installation join, and how does a machine leave?
- How many machines must it support?

## Not in scope

- A hosted database, a hosted Factory service or a dashboard.
- Machines that serve different repositories but share one installation.

## Done

To be written once the open questions are answered. It will include a drill with two machines on one Project, with one stopped mid-run.
