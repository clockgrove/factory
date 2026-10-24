# Factory product requirements

The one document Factory is built and judged against. [The design](DESIGN.md) says how Factory meets these requirements, and [the user guide](USER-GUIDE.md) says how to use it. Where they disagree with this page, this page wins.

## Goal

A simple, unattended Objective scheduler for an indie developer or a small team, with GitHub as persistence.

The operator writes an Objective, queues it, and checks in from a phone a few times a day. Factory plans the work, builds it with coding agents, checks and reviews it, merges it, and reports. It asks only when a person must decide.

## Users

- **The operator:** one person, or a small team, who owns a GitHub repository and its Project. They write Objectives, answer questions and read results. They check in from a phone, using chat and GitHub only.
- **A host program** (optional): software that embeds Factory as a library with its own planner or worker.

## How it works

1. **Queue.** An Objective is a GitHub issue in the Objective format. Setting its Project field to the queued option queues it.
2. **Check.** Factory checks it once, when it's first seen in the queue. A problem holds the Objective with a question naming the fix.
3. **Plan.** A planner turns it into Work Items with dependencies, owned paths and acceptance criteria. An independent review checks the plan, and the plan is posted on the issue.
4. **Build.** Each Work Item is built by a coding agent in a sandbox, then validated and independently reviewed.
5. **Deliver.** Each Work Item is one PR, merged in dependency order.
6. **Accept.** A final review checks the merged result against every criterion of the Objective. Factory posts a report and closes the issue.

## Requirements

1. **Intake.**
   - An Objective is queued through the Project field and checked once, with the same checks planning uses.
   - A body written by someone without write access runs only after a writer approves the text GitHub shows.
   - `factory propose` drafts Objectives from an intent or a roadmap section.
2. **Planning.**
   - Plans are reviewed before any work starts.
   - A plan can be amended: by the operator, or by a worker's discovery, reviewed again.
   - `replan` plans again from the current issue.
3. **Execution.**
   - Workers run on Codex (the default), Claude or Copilot, or on a host program's registered kind.
   - Each worker is sandboxed and limited to its owned paths.
   - Several Objectives and several Work Items per Objective run at once, within host-sized limits.
   - Failed work is repaired within configured allowances.
4. **Validation and review.**
   - Each Work Item's validation commands run in the sandbox.
   - Each result is reviewed independently against its contract.
   - The integrated result gets an independent final acceptance review, and QA runs on the default branch.
5. **Delivery.**
   - Each Work Item is one PR, merged in dependency order; native stacks are supported.
   - Media of any format travels in Git LFS.
   - No PR, comment or merge is ever duplicated.
6. **Questions.**
   - When a person must decide, Factory holds and asks one question with named answers. Every answer works.
   - Answers come from the CLI or from a `/factory <answer>` comment by a user with write access.
   - A Work Item's question stops only that item and the items that depend on it.
   - `cancel` always works, at once.
7. **Visibility.**
   - A phone check-in is enough to know what was delivered, what's running, what's blocked and what needs an answer.
   - Status shows in the CLI (`factory status`), a live status comment on the issue, one issue per Work Item, and the Project field.
   - `factory log`, `diagnostics` and model-call export show the detail.
8. **Recovery.**
   - Killing the service at any point and restarting it continues the work, with no duplicate effect.
   - `factory reset` rebuilds an Objective's state from GitHub.
   - Every wait has a deadline.
   - GitHub errors are retried, never treated as failures.
9. **Knowledge.**
   - Factory keeps repository memory from past runs and uses it in planning, work and review.
   - A playbook is proposed with `factory dream` and changes only when the operator approves it.
10. **Setup.**
    - `factory setup` writes and checks the configuration, and checks that the host is ready, without model calls.
    - `setup --background` runs Factory as a user service.
    - A library API lets a host program serve an installation or run an Objective.

## Stability

These hold for every run (the design gives each one a test):

1. **Contained.** A failure affects only its own Objective; the service and the queue keep running.
2. **Deadlines.** Every wait ends in progress, an automatic retry, or a question.
3. **Actionable.** Every question has named answers that work. Cancel always works.
4. **Crash-only.** The service can be killed at any point and continues on its own.
5. **GitHub is retried.** A GitHub error, timeout or partial read never fails a run.
6. **Bounded.** Cost follows active work, never history.
7. **Checked once.** Input is checked where it enters, and trusted after that.

## Not in scope

- More than one installation serving one repository or Project.
- A hosted service, a dashboard, or a second state store.
- Backward compatibility, or migrating earlier versions' state.
- Running Objectives on Factory's own repository.
- Managed execution (hosted agent sandboxes), until it's qualified with real API keys.

## Done

Factory is done when every requirement above has been shown working by a real run on the scratch drill repository. That includes the drill: kill the service at every crash point, cut the network, and stop a model mid-turn, and the run must finish with no duplicate effect and every question answerable.

Only then is Factory pointed at real targets such as Clockgrove. Real targets add requirements to this page; they aren't where Factory gets validated.
