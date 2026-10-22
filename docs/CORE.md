# Factory core

This is the specification for the rebuilt Factory core. Everything that works today keeps working; the rebuild changes how runs are owned, saved, retried and recovered. Once the core ships, this page replaces the state and recovery parts of [the architecture](ARCHITECTURE.md), and [the lifecycle](LIFECYCLE.md).

## Why a new core

Factory should behave like a simple scheduler that runs unattended: take an Objective from the queue, plan it, build it, deliver it, report. The current core has become fragile:

- Code fails closed with no way out, so an error becomes a hold that no command clears.
- Two writers, the CLI and the service, hand ownership back and forth through claims and bindings.
- The GitHub Project sits on the critical path, so one missed card read fails a run.
- Work grows with history: cancel and restart verify a whole Git archive.
- Timeouts turn into human decisions instead of retries.
- The rule "unknown stays unknown, never replay" leaves every uncertain effect as a permanent fence.

The new core replaces those mechanisms. Every capability stays and is ported onto it.

## Stability rules

Each rule has a test (see [Testing](#testing)).

1. **Contained.** A failure affects only its own Objective. The service and the queue keep running.
2. **Deadlines.** Every wait has a deadline. It ends in progress, an automatic retry, or a hold.
3. **Actionable holds.** Every hold is a question with named answers, and each answer works. Cancel always works and takes effect at once.
4. **Crash-only.** The service can be killed at any instruction. On restart it continues on its own from the last saved step, without duplicating any GitHub effect.
5. **GitHub is retried.** A GitHub error, timeout or partial read never fails a run.
6. **Bounded.** Cost follows active work. Nothing reads history to make progress.
7. **Checked once.** An Objective is checked when it's first seen in the queue, with the same checks planning uses.

## Concepts

- **Objective:** a GitHub issue that follows the Objective template, and an item in the configured GitHub Project.
- **Plan:** the Work Items for an Objective, with their dependencies. It's posted on the issue.
- **Work Item:** one unit of work, delivered as one PR.
- **Step:** one unit of progress, such as "plan", "run the worker for item 3" or "merge item 3".
- **Hold:** a step that needs a person. It's a question posted on the issue.
- **Run log:** an append-only record of what happened, for status and analysis. It never drives progress.

## Process model

There is one process, `factory serve`, per installation, run by systemd. It is the only writer of state.

- **Lock.** `serve` takes an `flock` on `service.lock`. The kernel releases the lock when the process dies, so there are no owner records, PID proofs or handoffs. A second `serve` exits at once with "already running".
- **CLI.** Commands that read (`status`, `log`) read the state files directly. Commands that change something (`answer`, `cancel`, `retry`, `queue`) write one request file to `requests/`. The service picks it up within a second and deletes it when the request is applied. If the service isn't running, the request waits there and the CLI says so.
- **No foreground runs.** `factory run` starts the service in the foreground for development. It is the same code path.
- **Upgrade.** Stop the service, install, start. Restart is the normal recovery path, so an upgrade needs nothing more.

## State

Each Objective has one JSON file: `objectives/<issue>.json` under the installation's state directory.

```jsonc
{
  "version": 1,
  "issue": 123,
  "status": "planning | building | holding | done | failed | cancelled",
  "base": "<default-branch SHA the plan was made against>",
  "plan": { "items": [/* id, title, contract, owned paths, deps, commands */] },
  "items": {
    "<id>": {
      "step": "waiting | working | validating | reviewing | delivering | merged | failed | skipped",
      "attempt": 1,
      "branch": "factory/123/<id>",
      "pr": 456,
      "repairs": 0,
      "lastError": null,
    },
  },
  "hold": null, // or { "id", "question", "answers": [...], "recommended", "askedAt" }
  "retries": { "<step key>": { "count": 2, "nextAt": "<time>" } },
  "modules": {/* per-capability state, see Capabilities */},
}
```

- **Saved after every step**, by writing a temporary file, calling `fsync`, then renaming it. A crash leaves either the old file or the new one.
- **Trusted.** The state belongs to the installation's user, as do Factory's code and credentials. There are no digests, seals, witnesses or tamper checks.
- **Small.** Large bodies (prompts, worker transcripts, review packets) go in the run log directory, never in state.
- **Rebuildable.** `factory reset --objective N` rebuilds the state from GitHub: the plan comment, the Work Item branches and the PRs. It's how a corrupt file, an incompatible version or a new machine is recovered.
- **One version.** If the file's version isn't the current one, the Objective holds with the answers `reset` and `cancel`. There are no migrations.

## Steps

The service loop:

```text
every second:   apply request files
every 30 s:     read the queue (on failure, keep the last good view)
for the active Objective (one at a time in v1):
    pick the next runnable steps (up to 2 Work Items at once)
    run each step with its deadline → outcome → save state → log
```

The steps:

```text
check → plan → plan review → [hold: plan question?]
  → per Work Item, in dependency order:
      prepare → work → validate → review → deliver (push, PR) → wait for CI → merge
  → final validation → final review → report → done
```

Every step returns exactly one outcome:

| Outcome                 | Meaning                                                          | What the core does                                                                       |
| ----------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `done(data)`            | The step finished.                                               | Save the data and move on.                                                               |
| `retry(reason, after?)` | Transient: network, 5xx, rate or usage limit, overload, timeout. | Back off (30 s doubling to 15 min, or the provider's reset time) and run the step again. |
| `repair(finding)`       | The work is wrong: validation, review or CI failed.              | Run the item's work step again with the finding, until the repair budget is spent.       |
| `hold(question)`        | Only a person can decide.                                        | Post the question on the issue, set Status to "Needs you", and wait.                     |
| `fail(reason)`          | The item can't be done as planned.                               | Hold, with the answers `retry`, `replan` and `cancel`.                                   |

An exception that escapes a step counts as `retry`. After three in a row on the same step, it becomes a hold: the error, plus `retry` and `cancel`. A step can't crash the service, block another Objective, or leave an Objective without an answer that works.

### Idempotence

Every step is safe to run again. Before it does anything with an outside effect, it looks for that effect on GitHub:

| Effect        | How the step finds it                                                                                     |
| ------------- | --------------------------------------------------------------------------------------------------------- |
| Branch        | Fixed name: `factory/<issue>/<item>`.                                                                     |
| PR            | Open or merged PR whose head is that branch.                                                              |
| Merge         | That PR's merged state.                                                                                   |
| Comment       | A hidden marker, `<!-- factory:<issue>:<kind>:<id> -->`. An existing comment is edited, not posted again. |
| Issue close   | The issue's state.                                                                                        |
| Project field | Written every time; it is a display.                                                                      |

So an effect whose result was lost is never "unknown". The next run of the step finds it on GitHub and carries on.

A model call has no outside effect. If the process dies mid-call, the call runs again. A worker's worktree is kept and reused, so a repeated work step continues from its files.

### Deadlines

| Wait                   | Deadline (configurable)             | At the deadline               |
| ---------------------- | ----------------------------------- | ----------------------------- |
| GitHub request         | 60 s                                | retry                         |
| Plan, plan review      | 45 min each, 15 min idle            | retry; hold after 3           |
| Worker turn            | 2 h total, 15 min idle              | retry; hold after 3           |
| One validation command | from configuration                  | repair                        |
| Result or final review | 30 min, 15 min idle                 | retry; hold after 3           |
| CI on a PR             | 60 min after the last check started | retry; hold after 3           |
| Hold                   | none: it waits for a person         | a reminder comment after 24 h |

## Queue

The GitHub Project is the source of truth for what is queued.

- **Queued** means the item's Status field equals the configured "queued" option. **Order** comes from the Project's configured number field, then issue number.
- **Read-only, and retried.** The service reads the Project every 30 s. If a read fails or comes back partial, it keeps the last good view and tries again. A read failure never fails a run.
- **Status is a display.** The service sets Status as the run moves: Planning, Building, Needs you, Done, Failed, Cancelled. A failed write is logged and written again on the next transition.
- **Operator controls:** set an item's Status to the queued option to queue it, move it out of the queued option to dequeue it if it hasn't started, and set the order number to reorder. There is no control card and no managed metadata field.
- **One at a time (v1).** The core runs one Objective at a time; `queue.maxActiveObjectives` raises the limit later.

## Check at queue time

When the service first sees a queued Objective, it runs the Objective checks: template sections, pinned Sources that resolve at the default branch, no duplicate headings, and declarations that parse. Planning uses the same function.

A failed check is a hold. It names each problem and how to fix it, and Status goes to "Needs you". Editing the issue and setting Status back to the queued option checks it again.

## Holds and answers

A hold is a question with named answers:

```jsonc
{
  "id": "plan-1",
  "question": "...",
  "answers": ["approve", "revise", "cancel"],
  "recommended": "approve",
}
```

- It is posted as one issue comment with a marker, and it lists the answers.
- **Answering:** a comment `/factory <answer> [text]` from a user with write access to the repository, or `factory answer <issue> <answer> [--text ...]`. The service checks for comments every 30 s while it is holding. If someone without write access answers, that's ignored and logged.
- **In an agent host.** The director skill shows each open hold with the host's question tool (Claude Code's AskUserQuestion, or its Codex equivalent): the question, each answer with the recommended one first, and a one-line consequence for each. That gives the operator an app notification. The chosen answer runs `factory answer`. `factory status --json` lists open holds in this shape so the skill needs no parsing.
- An answer that doesn't match the open hold gets a reply naming the valid answers. Nothing else changes.
- `cancel` is valid at every hold and at any time.

## Cancel

`/factory cancel` or `factory cancel <issue>`:

1. Abort the Objective's running steps. This kills the process groups the service started for those steps; it tracks them in memory, and they die with the service anyway.
2. Close open Factory PRs with a comment, and set Status to Cancelled.
3. Mark the state cancelled.

Cancel reads only the Objective's state file and its open PRs, so its cost doesn't depend on history. It can't be refused. If closing a PR fails, the close is retried in the background; it never blocks the cancel.

## Run log

Each run appends to `logs/<issue>/<run>.jsonl`: step start and end, outcome, durations, tokens, cost, errors, and references to body files in the same directory.

- `factory status` reads the state file plus the end of the log.
- Diagnostics, capture export, accounting, scorecards and analysis read logs. They never write state.
- The service keeps the last 20 runs per Objective and 2 GB in total, deleting the oldest first.

## Capabilities

A capability is a module that plugs into one of these seams:

| Seam               | Used by                                           | Examples                                                                                              |
| ------------------ | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `Planner`          | plan, plan review, repair diagnosis, final review | Codex and Claude planning                                                                             |
| `Worker`           | the work step                                     | Codex, Claude, Copilot local; OpenAI Agents, Claude Managed Agents                                    |
| `Reviewer`         | result and final review                           | Codex and Claude                                                                                      |
| `Delivery`         | deliver, wait for CI, merge                       | regular PRs, native linear stacks, LFS assets                                                         |
| `Planning options` | the plan step                                     | discovery, adaptive workflow, recipes, quality checkpoint, package-manager update, splits, amendments |
| `Knowledge`        | plan and work prompts                             | curated playbook, repository memory, Dream proposals                                                  |
| `Observers`        | the run log                                       | diagnostics, accounting, scorecard, capture export                                                    |

Rules for modules:

- A module returns step outcomes. It never writes state directly, takes a lock, starts a background loop, or keeps its own archive.
- A module keeps its data in `modules.<name>` of the state file, or in the run log.
- A module validates its input once, where the input enters, and doesn't re-verify it later.
- Provider APIs stay inside their adapter.

## Security

These carry over unchanged:

- Credentials stay with the service. Workers never see them.
- Workers run in the OS sandbox with the configured network policy.
- Secrets are named by reference.
- Deploys stay in the target's own GitHub Actions, behind environment approvals.

A same-user process is trusted, as decided for the archive: it can already change Factory's code and credentials.

## Size

| Part                                                | Budget (source lines) |
| --------------------------------------------------- | --------------------- |
| Core: loop, state, steps, queue, holds, CLI, status | 20k                   |
| Whole product with every capability                 | 60k                   |
| Tests                                               | at most the source    |

Going over a budget needs the maintainer's approval.

## Testing

No mocks, fake services, fake providers or scripted responses.

- **Crash points.** Product code calls `crashPoint("<step>:<moment>")` at each step boundary, before and after each outside effect and after each save. When `FACTORY_CRASH_AT` names that point, the process sends itself SIGKILL. It is a no-op otherwise.
- **CI** runs the real `factory serve` on real Git repositories and files for everything that needs no GitHub or model: state saves, step order, restart at every crash point, request files, cancel, deadlines, log rotation.
- **Drill.** At each milestone, a small real Objective runs on a scratch GitHub repository with real providers. The drill kills the service at every crash point and restarts it. It also cuts the network for a minute and stops a model mid-turn. It passes when the Objective finishes with no duplicate PR, comment or merge, and every hold had an answer that worked.

## Migration

Pre-release, with no compatibility layer:

1. Stop the old service.
2. Cancel and clear the old Objective state.
3. Install the new core and run setup.
4. Queue Objectives again.

The old source tree is deleted once every capability is ported.
