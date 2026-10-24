# Factory product requirements

The one document Factory is built and judged against. [The design](DESIGN.md) says how Factory meets these requirements, and [the user guide](USER-GUIDE.md) says how to use it. Where they disagree with this page, this page wins.

## Goal

A simple, unattended Objective scheduler for one developer, with GitHub as the only infrastructure it needs. Team use is a later feature with its own requirements: [Team use](prd/team-use.md).

The operator writes Objectives, queues as many as they like, and checks in from a phone a few times a day. Factory works several of them at once: it plans the work, builds it with coding agents, checks and reviews it, merges it, and reports. It asks only when a person must decide.

## Users

- **The operator:** one person who runs Factory on one machine, through a coding agent.
- **Others with write access** can queue Objectives, answer questions and follow progress through GitHub. Factory still runs on the operator's one machine.

The operator checks in through chat and GitHub. A phone is enough.

## Delivery

Factory ships as a plugin for coding-agent harnesses (Codex and Claude Code). The plugin's skills set Factory up and direct it through the `factory` CLI.

## How it works

1. **Queue.** An Objective is a GitHub issue in the Objective format. Setting its Project field to the queued option queues it. Any number can wait, in Project order.
2. **Check.** Factory checks it once, when it's first seen in the queue. A problem holds the Objective with a question naming the fix.
3. **Plan.** A planner turns it into Work Items with dependencies, owned paths and acceptance criteria. An independent review checks the plan, and the plan is posted on the issue.
4. **Build.** Each Work Item is built by a coding agent in a sandbox, then validated and independently reviewed.
5. **Deliver.** Each Work Item is one PR, merged in dependency order.
6. **Accept.** A final review checks the merged result against every criterion of the Objective. Factory posts a report and closes the issue.

Several Objectives move through these steps at once.

## Requirements

1. **Queue and concurrency.**
   - Any number of Objectives can be queued. They are taken in Project order.
   - Several Objectives run at once (3 by default), and several Work Items within each, within limits sized to the machine.
   - Objectives whose owned paths overlap take turns.
2. **Intake.**
   - An Objective is queued through the Project field and checked once, with the same checks planning uses.
   - A body written by someone without write access runs only after a writer approves the text GitHub shows.
   - `factory propose` drafts Objectives from an intent or a roadmap section.
3. **Planning.**
   - Plans are reviewed before any work starts.
   - A plan can be amended, by the operator or by a worker's discovery, and is reviewed again.
   - `replan` plans again from the current issue.
4. **Execution.**
   - Workers run on Codex (the default), Claude or Copilot.
   - Each worker is sandboxed and limited to its owned paths.
   - Failed work is repaired within configured allowances.
5. **Validation and review.**
   - Each Work Item's validation commands run in the sandbox.
   - Each result is reviewed independently against its contract.
   - The integrated result gets an independent final acceptance review, and QA runs on the default branch.
6. **Delivery.**
   - Each Work Item is one PR, merged in dependency order; native stacks are supported.
   - Media of any format travels in Git LFS.
   - No PR, comment or merge is ever duplicated.
7. **Questions.**
   - When a person must decide, Factory holds and asks one question with named answers. Every answer works.
   - Answers come from the CLI, or from a `/factory <answer>` comment by a user with write access.
   - A Work Item's question stops only that item and the items that depend on it.
   - `cancel` always works, at once.
8. **Single player.**
   - Factory runs on one machine for a repository and its Project.
   - A second machine or installation that tries to serve the same repository or Project is refused. It does nothing on GitHub, and its message names the machine that holds the repository.
   - The check uses GitHub only.
   - Moving to another machine is a deliberate handoff: stop the first machine, then set up the second.
9. **Storage.** No infrastructure beyond GitHub and the machine itself.
   - **On GitHub:** the plans, questions and answers, PRs and reports, which are enough to rebuild any Objective on another machine with `factory reset`.
   - **Local to the machine:** configuration, credentials and logins, the working clone, the current Objective state, and run logs and captures (diagnostics only).
   - **The knowledge store** is also local: repository memory and the playbook, in a SQLite file, searched by every role. Losing the machine loses memory, the playbook and diagnostics, never an Objective.
10. **Visibility.**
    - A phone check-in is enough to know what was delivered, what's running, what's blocked and what needs an answer.
    - Status shows in the CLI (`factory status`), a live status comment on the issue, one issue per Work Item, and the Project field.
    - `factory log`, `diagnostics` and model-call export show the detail.
11. **Recovery.**
    - Killing Factory at any point and restarting it continues the work, with no duplicate effect.
    - Every wait has a deadline.
    - GitHub errors are retried, never treated as failures.
12. **Knowledge.**
    - Factory learns repository memory from past runs and uses it in planning, work and review.
    - A playbook is proposed with `factory dream` and changes only when an operator approves it.
13. **Setup.**
    - `factory setup` writes and checks the configuration, and checks that the machine is ready, without model calls.
    - `setup --background` runs Factory as a user service.

## Stability

These hold for every run (the design gives each one a test):

1. **Contained.** A failure affects only its own Objective; Factory and the queue keep running.
2. **Deadlines.** Every wait ends in progress, an automatic retry, or a question.
3. **Actionable.** Every question has named answers that work. Cancel always works.
4. **Crash-only.** Factory can be killed at any point and continues on its own.
5. **GitHub is retried.** A GitHub error, timeout or partial read never fails a run.
6. **Bounded.** Cost follows active work, never history.
7. **Checked once.** Input is checked where it enters, and trusted after that.

## Not in scope

- Team use: several operators or machines on one repository or Project. See [Team use](prd/team-use.md).
- Any required infrastructure beyond GitHub: no database or hosted service.
- A dashboard.
- Embedding Factory as a library in other programs.
- Backward compatibility, or migrating earlier versions' state.
- Running Objectives on Factory's own repository.
- Managed execution (hosted agent sandboxes), until it's qualified with real API keys.

## Done

Factory is done when every requirement above has been shown working by real runs on the scratch drill repository. That includes refusing a second machine on the same Project, and the [integration tests](../integration/README.md): kill Factory at every crash point, cut the network, and stop a model mid-turn. Each run must finish with no duplicate effect and every question answerable.

Only then is Factory pointed at real targets such as Clockgrove. Real targets add requirements to this page; they aren't where Factory gets validated.
