# Factory product requirements

The one document Factory is built and judged against. [The design](DESIGN.md) says how Factory meets these requirements, and [the user guide](USER-GUIDE.md) says how to use it. Where they disagree with this page, this page wins.

## Goal

A simple, unattended Objective scheduler for an indie developer or a small team, with git on GitHub as its only persistence.

The operator writes Objectives, queues as many as they like, and checks in from a phone a few times a day. Factory works several of them at once: it plans the work, builds it with coding agents, checks and reviews it, merges it, and reports. It asks only when a person must decide.

## Users

- **Operators:** the people who run Factory, each on their own machine, through a coding agent. One person, or each member of a small team, on one shared repository and Project.
- **Teammates without Factory:** they queue Objectives, answer questions and follow progress through GitHub alone.

Everyone checks in through chat and GitHub. A phone is enough.

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
   - Several Objectives run at once (3 per host by default), and several Work Items within each, within limits sized to the host.
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
   - Answers come from the CLI on any operator's machine, or from a `/factory <answer>` comment by a user with write access.
   - A Work Item's question stops only that item and the items that depend on it.
   - `cancel` always works, at once.
8. **Team use.**
   - Several operators run Factory against one repository and Project at once, each on their own machine.
   - An Objective is worked by one machine at a time. It's claimed through git, never a database.
   - If a machine stops, its claims lapse after a deadline, and another operator's machine continues those Objectives from the shared state with no duplicate effect.
   - Each machine acts with its operator's own GitHub and provider logins.
   - Every operator sees every Objective's status.
9. **Storage.**
   - **Shared, in git on GitHub:** each Objective's state, plan, questions and answers, and claims, plus the repository memory and the playbook. Any operator's machine can continue any Objective, and every machine works from the same memory.
   - **Local to each machine:** configuration, credentials and logins, the working clone, and run logs and captures, which are diagnostics only.
   - Losing a machine loses only its local diagnostics.
10. **Visibility.**
    - A phone check-in is enough to know what was delivered, what's running, what's blocked and what needs an answer.
    - Status shows in the CLI (`factory status`), a live status comment on the issue, one issue per Work Item, and the Project field.
    - `factory log`, `diagnostics` and model-call export show the detail of runs on that machine.
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

- A required database or hosted service. An opt-in Postgres store may come later.
- A dashboard.
- Embedding Factory as a library in other programs.
- Backward compatibility, or migrating earlier versions' state.
- Running Objectives on Factory's own repository.
- Managed execution (hosted agent sandboxes), until it's qualified with real API keys.

## Done

Factory is done when every requirement above has been shown working by real runs on the scratch drill repository. That includes team use: two machines on one Project, with one stopped mid-run. It also includes the drill: kill Factory at every crash point, cut the network, and stop a model mid-turn. Each run must finish with no duplicate effect and every question answerable.

Only then is Factory pointed at real targets such as Clockgrove. Real targets add requirements to this page; they aren't where Factory gets validated.
