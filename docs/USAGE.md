# Using Factory

How to write an Objective, what you see while it runs, what the two stops mean and how to answer them. [INSTALL.md](INSTALL.md) covers setup; [PLAN.md](PLAN.md) has the full contracts.

## Write an Objective

An Objective is a GitHub issue with the `factory:objective` label. The issue is the whole specification: nobody answers questions during the run.

- **State the goal and what must be true when it is done.** Put the acceptance entries in a list under a heading such as `Acceptance` (`Done when`, `Definition of done`, `Must be true` and `Criteria` are read the same way). The reviewer judges each entry, met or not, with the line that shows it. Without such a section, the reviewer names the entries from the issue text itself.
- **Say what you have decided.** Where the issue admits more than one reading, the worker takes the simplest one that satisfies every acceptance entry and records it as an assumption in its plan and in the PR.
- **Label it yourself, or have a maintainer do it.** Factory acts on an issue only when its author and, once the body was edited, its last editor can push to the repository or are maintainers the workflow names. Otherwise the run Blocks before any model sees the text.
- **Keep it to one repository** (below).

```markdown
## Goal

`mytool --version` prints the version.

## Acceptance

- `mytool --version` prints the version from package.json and exits 0.
- A test covers it.
```

Ready Objectives start in priority order (`P0` to `P2`, then the lowest issue number), up to `max_concurrent` at once. An Objective too large for one session is delivered as up to six pull requests in sequence, one open at a time.

## What you see on the issue

While a job runs, one comment on the issue (edited in place, one per run) carries a bold status line and the phases with clocks: setup, install, harness, each validation pass, reviewer, answer pass, exit. The status line comes from the harness's own event stream, not from its prose: elapsed minutes, turns, tool calls, the sub-agents running and what each was asked to do, when the last event arrived, tokens so far, the last tool it ran. A harness that prints nothing for 30 minutes is killed and retried once, and the line says so. The labels (`factory:running`, `factory:in-review`, `factory:blocked`, `factory:question`) and the board column are the state; the plan comment is the harness's own checklist, ticked as it goes; the PR carries the validation marker and the review.

## Blocked and Question

Nothing asks a question during a run. The only stops are **Blocked** (a draft PR, the card in the Blocked column, one comment with the reason) and **Question** (a draft PR whose body asks the one thing a human must decide), and neither stops the queue.

- **Blocked:** fix what the comment names, then re-apply `factory:objective` to run the Objective again.
- **Question:** comment the decision on the issue or the PR (a review or a line comment works too) and mark the PR ready: the review job applies it, and with no answer since the question the PR goes back to a Question rather than merging. Re-applying `factory:objective` instead reruns the worker with it.

A comment counts when its author has write access to the repository or is a maintainer the workflow names (`notify`, and the optional `maintainers` list), since an App cannot always see an organization member's access.

## Factory merges on its own

Code lands with no human read. The gate is your CI workflow's checks on the reviewed head and the integrated commit, the comment-only reviewer pass, and the merge queue's own re-run where you have one. Set `FACTORY_AUTO_MERGE: false` for ready-for-review PRs instead.

## Siblings that touch the same files

Two Objectives running at once that edit the same files cost a rebase run each time one merges (ten minutes, a dollar or a few) and, without a merge queue, strict checks refuse the one left behind until the worker rebases it. When you know two Objectives share an area, say so: add the GitHub issue dependency (`blocked_by`) and the dispatcher orders them; or set `max_concurrent: 1` for the stretch. Factory does not guess file overlap from prose.

## One repository per Objective

Factory works in one repository per Objective. An Objective that needs a change in another repository stops after its plan with a Question on the issue, before any work: split it into one Objective per repository and re-apply the label, or answer on the issue how to do the work in this repository alone.

## Commands

In a Claude Code or Codex session with the plugin installed:

| Command | What it does |
| --- | --- |
| `/factory:setup` | Installs Factory in the current repository, one consented step at a time |
| `/factory:doctor` | Checks the repository, its settings, the credential and the runner; changes nothing |
| `/factory:run <issue>` | Runs the worker on one Objective in your own session, on your login |
| `/factory:review <pr>` | Runs the reviewer on one Factory PR in your session |
| `/factory:serve` | Starts the local loop ([LOCAL.md](LOCAL.md)) |
| `/factory:queue` | Starts the unattended scheduler for the repository |
| `/factory:score` | Prints the scorecard: walk-away, quality, operator minutes, cost |

On the command line, `gh workflow run factory.yml -f issue=<number>` starts one Objective now, and local mode has `factory serve`, `factory run <issue>` and `factory review <pr>` ([LOCAL.md](LOCAL.md), Run it).
