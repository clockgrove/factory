# Factory architecture

Factory turns a GitHub issue that describes an outcome (an **Objective**) into merged, validated pull requests. It compiles the Objective into a graph of **Work Items**, runs coding agents on them in parallel, checks each exact result independently, delivers through GitHub, and validates the integrated result before closing the Objective.

Factory is a plugin and CLI installed for one target repository. It is not a hosted service and not a dependency of the target. It refuses to run against its own source repository.

## Core flow

```text
Objective issue
  → compile: pinned sources → Work Item graph → independent plan review
  → project: Work Item issues with native dependencies
  → schedule: ready items with no conflicting paths, up to the concurrency limit
  → execute: agent works in an owned worktree at an exact base
  → validate: commands run on the exact result tree, then independent result review
  → deliver: pull request, required checks, merge
  → finalize: commands and review on the integrated default branch, then close
```

Each step has one owner in the code:

| Step     | Code                                          | What it does                                                                                               |
| -------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Compile  | `src/compiler.ts`, `src/compiler-wire.ts`     | Pins the Objective and cited sources, asks the planning model for a graph, validates it, runs plan review. |
| Project  | `src/github.ts`                               | Creates or reconciles Work Item issues, labels, sub-issues and dependencies.                               |
| Schedule | `src/scheduler.ts`, `src/phase-admission.ts`  | Orders the graph, finds ready items, reserves capacity per phase.                                          |
| Execute  | `src/execution/`                              | Runs one attempt through an `ExecutionDriver` and collects an exact change.                                |
| Validate | `src/validation.ts`, `src/review-evidence.ts` | Runs validation commands on the result tree and asks an independent reviewer to judge acceptance criteria. |
| Deliver  | `src/delivery/`                               | Publishes and merges pull requests, one at a time or as a native linear stack.                             |
| Finalize | `src/completion.ts`, `src/qa.ts`              | Validates the integrated head, checks coverage of every criterion, seals acceptance, closes issues.        |
| Run      | `src/runner.ts`                               | Coordinates the steps, owns the state snapshot and handles restart, pause and cancel.                      |

## Planning

The planner receives a **pinned source packet**: the Objective body, the base commit, and the exact content of every repository file it cites. Planning, review and activation all bind to the packet's digest, so a changed source or base is detected rather than silently used.

The model makes semantic choices; code fills in facts. The planner picks, by index, which source line authorizes a command or which criterion an item covers. Factory then derives identities, digests and exact command text itself. _Because_ models copy text unreliably, anything the controller already knows is never asked of the model.

Every Objective acceptance criterion must be covered by a typed proof: a result or integrated command, a semantic review, a required CI check, or final review. A plan with an uncovered criterion is rejected before it runs.

Every planning provider shares one prompt, schema and decoder per phase; only the transport differs. `StructuredPlanningModel` in `src/compiler.ts` owns prompts, bounded review retries, parsing and observations. A `PlanningTransport` runs one provider attempt: Codex SDK (`src/compiler.ts`) or Claude Agent SDK (`src/claude-planning.ts`). A transport may adapt a schema to its provider's supported subset; Factory's decoders still enforce the full contract.

An independent model reviews the complete plan once. A concrete finding allows one evidenced revision; after that, an unresolved question goes to the operator.

## Work Items

A Work Item declares:

- **owned paths**: literal files or directory prefixes ending in `/` that it may change;
- **dependencies** on other Work Items, and optional exclusive **resources**;
- **acceptance criteria**, **non-goals** and source **citations**;
- **validation commands**, each either observed in the base repository or declared literally in a pinned source;
- a **brief** for the agent, with the cited source sections attached.

Items whose owned paths overlap, or that claim the same resource, never run at the same time. A `qa` item runs checks without an agent or PR. An `aggregate` item joins its children's results and has no agent or PR of its own.

## Execution

An `ExecutionDriver` starts, observes, cancels and collects one attempt. Three kinds exist:

| Driver  | Where the agent runs                                      | Status                                    |
| ------- | --------------------------------------------------------- | ----------------------------------------- |
| Local   | A Factory-owned worktree on this machine                  | Supported                                 |
| Managed | A provider's hosted agent (OpenAI Agents, Claude Managed) | Implemented; hosted qualification pending |
| Sandbox | A `SandboxProvider` machine, such as Daytona              | Implemented; hosted qualification pending |

Local and sandbox drivers run an `AgentHarness`: Codex SDK by default, with optional Claude Agent SDK and GitHub Copilot SDK harnesses, or a registered third-party adapter. **Execution profiles** let the planner assign each Work Item one of several configured harness/model choices.

The harness works only inside its worktree, must not move `HEAD`, and never receives Factory's GitHub credentials. Factory collects the changed files itself, checks ownership and scans for secrets. _Because_ the controller alone publishes, an agent cannot push, merge or change another item's work.

## Validation and review

Validation runs in a fresh worktree checked out at the exact result tree:

1. Hydrate any selected Git LFS content from the local content store.
2. Run each validation command in order and record a receipt: command, exit code, tree.
3. Confirm the worktree is unchanged afterwards; a command that writes tracked or unignored files fails validation.

An independent reviewer model then judges each acceptance criterion against the change, the receipts and the cited sources. It must cite evidence; a criterion it cannot support from complete evidence stays pending for the operator.

## Delivery

The `regular` strategy publishes and merges one pull request at a time. The `native-stack` strategy groups each unbranched chain of Work Items into a GitHub stacked pull request; forks and joins start new stacks after their predecessors merge.

Before merging, Factory checks the exact PR head, the target's branch protection, and every CI check the plan requires before integration. Pending checks wait; failing checks stop. _Because_ GitHub only blocks a merge for checks its rules require, Factory enforces source-required checks itself.

## Final acceptance

After all Work Items are integrated, Factory runs the Objective's final commands and final review on the current default-branch head, rechecks that every criterion has accepted proof, records a sealed acceptance of that exact commit and graph, and closes the Objective. Closing every Work Item is not enough on its own.

## State and recovery

Each Objective has one atomic JSON snapshot at `$XDG_STATE_HOME/clockgrove-factory/repositories/OWNER/REPO/objectives/N/state.json`, written with write-then-rename. Configuration lives at `$XDG_CONFIG_HOME/clockgrove-factory/config.json`. Nothing is stored in the target checkout.

One controller owns an Objective at a time, through a lock and a private control socket. Other CLI commands (`status`, `pause`, `cancel`) talk to that owner.

- **Every step is safe to repeat.** Factory never needs to know whether an interrupted call succeeded, _because_ every effect has a stable identity. A restart re-reads its snapshot and GitHub and repeats the current step:
  - model calls (planning, reviews, diagnosis) have no side effects, so they are asked again;
  - issues are found by their `factory:` marker before any is created;
  - a PR is found by its deterministic branch before one is opened;
  - a merge first checks whether the PR or stack is already merged at the expected head.
- **Restart** adopts the recorded attempt through its driver: the attempt id is saved before the worker starts, a started worker is checkpointed before `start` returns, and a collected result is checkpointed before its worktree is removed. A restart never starts a second worker beside the first; a new worker starts only after the driver confirms the old one stopped.
- **Real decisions still stop:** an edited or closed Objective, a PR changed by someone else, failing required checks, or a criterion the reviewer could not decide.
- **Interruptions repeat; failures stop.** Work Item execution, validation, review and diagnosis are steps (`src/step.ts`): a transient fault repeats with a persisted backoff. A dead worker, a lost model answer and an invalid model answer (asked again with its validation error) may have been paid for, so a step repeats three of them and then asks the operator to retry or cancel. Publication and merge still repeat a lost GitHub response or server error twice per attempt. A real failure (validation failed, a criterion refused, the worker reported failure) keeps its evidence; a new attempt needs `factory retry` or a remaining repair allowance.

Diagnostics (`factory diagnostics`, `logs`, `analyze`) are a private timeline of observations. They never drive lifecycle decisions.

## Media and large files

A harness can return several candidate **AssetSets**: groups of files with provenance. Factory stores the bytes by SHA-256, pauses for a human to select one whole set, and delivers it through ordinary validation and delivery. The target's `.gitattributes` decides which files use Git LFS; Factory verifies pointers, uploads, and hydration from a fresh clone.

## Autonomous operation

`factory run --objective N` is the one command: it plans, saves the plan and its review in the Objective's state, and runs a clean or human-accepted plan until the Objective completes, fails or needs a human decision. Running is the consent for that Objective. A rerun resumes from state and never plans an existing plan again. Within each run:

- **Limits**: the optional `autonomy` section of the configuration sets bounded allowances (planning revisions, implementation repairs, result rereviews), per-Work-Item limits, the enabled repair classes and required worker environment. Defaults are on and bounded. Each Objective snapshots its limits when it starts; allowances never reset.
- **Repair**: a diagnosed failure uses an allowance instead of stopping. Only a wrong result is charged: a failed validation or worker result, a refused criterion, refused review evidence, or plan review findings. A transient or configuration failure never is. Each charge is recorded under its failure event, so repeating that event after a restart or a lost response is free. The event is `item/<id>/<step>/<round>` for a Work Item (`round` counts its earlier attempts) and `objective/plan/<round>` for a plan revision.
- **Amendments** use a planning revision each, charged once under `objective/amend/<amendment id>`.
- **Graph amendments**: a worker can propose missing work; it is compiled, independently reviewed, and added without restarting running items.
- **Intake and supervision**: a `systemd` user service runs explicitly selected Objectives one at a time and keeps running after the terminal closes. It can watch GitHub for new candidate Objectives, but each still needs explicit selection before any model is called.

An exhausted allowance or an undelegated decision stops for the operator.

## Extension points

Seven interfaces in `src/contracts.ts` are the only planned variation points:

| Interface          | Purpose                                        | Implementations                          |
| ------------------ | ---------------------------------------------- | ---------------------------------------- |
| `PlanningModel`    | Compile, review plans and review results       | Codex SDK, Claude Agent SDK              |
| `ExecutionDriver`  | Run one Work Item attempt                      | Local, managed, sandbox                  |
| `AgentHarness`     | The coding agent inside a local or sandbox run | Codex, Claude Agent, Copilot, registered |
| `SandboxProvider`  | Machines for sandbox execution                 | Daytona                                  |
| `DeliveryStrategy` | Publish and merge                              | Regular, native stack                    |
| `ContentStore`     | Immutable bytes by digest                      | Local                                    |
| `GitHubGateway`    | Issues, PRs, checks, merges                    | Octokit                                  |

The runner, scheduler, validator, state store and Git model are deliberately concrete. Add an implementation behind an interface; do not add a new abstraction layer.

## Safety invariants

1. **Workers never get controller credentials.** Only the controller publishes or merges. _Because_ the agent runs untrusted model output.
2. **Validation uses the exact tree.** Every receipt names the tree it ran on, and delivery checks the PR head matches. _Because_ "tests passed" means nothing for a different commit.
3. **Commands need authority.** A validation command must be observed in the base repository or declared in a pinned source. _Because_ the model must not invent what counts as passing.
4. **Owned paths are enforced.** A result that changes files outside its ownership is rejected. _Because_ parallel items must not overwrite each other.
5. **Every effect is safe to repeat.** Issues, PRs and merges are found by stable identities before they are created, and model calls have no side effects. _Because_ recovery is then just "re-read and continue", an interrupted run never needs manual reconciliation.
6. **Failures stop; retries are explicit or within configured limits.** _Because_ the operator controls rework and spending.
7. **Acceptance is proven, not assumed.** Every criterion needs supplied evidence, and the Objective closes only after final validation on the integrated head. _Because_ closed child issues do not prove the outcome.
8. **The target repository is the authority** for requirements, commands, branch protection and acceptance. Factory does not change the target's protection rules.
9. **One active Objective per installation**, one execution mode, and no state migration between incompatible versions. _Because_ these keep recovery simple.

## Known limits

- Planning and review: Codex SDK or Claude Agent SDK (`planning.kind`).
- Linux x64 only; workers run under your OS account and are not a security boundary against hostile code.
- Managed and sandbox execution are implemented but not yet qualified against live providers.

## History

Factory was rebuilt in September 2026 from an earlier implementation.
