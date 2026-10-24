# Factory design

This is the specification for how Factory owns, saves, retries and recovers runs. Factory behaves like a simple scheduler that runs unattended: take an Objective from the queue, plan it, build it, deliver it, report.

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
- **Work Item:** one unit of work, delivered as one PR. From slice 5B it is also tracked by one issue, which only displays progress and never drives it.
- **Step:** one unit of progress, keyed in state, such as `plan`, `item:3:work` or `item:3:merge`.
- **Hold:** a step that needs a person. It's a question posted on the issue. A Work Item's hold stops only that item and the items that depend on it; a hold about the whole Objective stops every step.
- **Run log:** an append-only record of what happened, for status and analysis. It never drives progress.

## Lean code

Code is judged by how well it does the job, not by its size.

- **One implementation per job.** No duplicated helpers, and no two ways of doing the same thing.
- **No dead code.** Code that nothing calls is deleted.
- **Tests prove behavior.** A test proves a stability rule or real behavior. There are no unit tests of private helpers.

Every milestone ends with a sweep for duplication, dead code and unneeded tests.

## Testing

No mocks, fake services, fake providers or scripted responses.

- **Crash points.** Product code calls `crashPoint("<step>:<moment>")` at each step boundary, before and after each outside effect and after each save. When `FACTORY_CRASH_AT` names that point, the process sends itself SIGKILL. It is a no-op otherwise. `FACTORY_COMMENT_LIMIT` (tests only, off by default; 1,000 to 65,000 characters) lowers the comment size limit, so a small plan's data goes in continuation comments and the `plan:data:*` points are reached.
- **CI** runs the real `factory serve` on real Git repositories and files for everything that needs no GitHub or model: state saves, step order, restart at every crash point, request files, cancel, deadlines, log rotation.
- **Integration tests** ([integration/](../integration/README.md)) run on demand, never in CI. Real Objectives run on a scratch GitHub repository with real providers. They kill the service at every crash point and restart it, cut the network for a minute and stop a model mid-turn. They pass when every Objective finishes with no duplicate PR, comment or merge, and every hold had an answer that worked.

## Topics

Each topic has its own file, so a change touches only the topic it changes:

- [Process model](reference/process.md)
- [State](reference/state.md)
- [Steps](reference/steps.md)
- [Queue](reference/queue.md)
- [Holds and answers](reference/holds.md)
- [Delivery and cancel](reference/delivery.md)
- [Run log](reference/run-log.md)
- [GitHub displays](reference/github.md)
- [Capabilities](reference/capabilities.md)
- [Security](reference/security.md)
- [Setup and migration](reference/setup.md)
