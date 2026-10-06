# Factory user guide

Factory turns one Objective, a GitHub issue in your target repository, into reviewed pull requests: it plans, runs coding agents, validates, delivers and checks the integrated result. The target repository owns requirements and branch rules. Factory's configuration and state stay outside it.

Agents operate Factory through the `setup` and `director` skills, and the skills run the commands below. `factory help` lists every command and option of the installed version and is the authority if this guide differs. Install with the [README](../README.md#install). To change Factory itself, see [Contributing](https://github.com/clockgrove/factory/blob/main/CONTRIBUTING.md).

## Prerequisites

- Linux x64 (WSL2 works), Node.js 22 or later, Git 2.31 or later, an authenticated `gh`, and a Codex login. Other providers are in [agent harnesses](AGENT-HARNESSES.md).
- A trusted checkout whose `origin` fetch and push URLs resolve to the same GitHub `OWNER/REPO`. Factory refuses local-path origins, mismatched push URLs and its own source repositories.
- The target's toolchain on the validation `PATH`. Factory installs no package manager or build tool. Validation runs commands with non-login `sh -c`, so shell profiles do not provision it.
- Requirements and validation instructions committed. Planning reads the pinned Git base, not uncommitted or unpushed edits. The base is the head of the default branch on `origin`, fetched when the run first plans; the Objective keeps that base on every later run.
- A controller started from an ordinary host terminal. A controller inside an agent command sandbox passes that sandbox to its workers.

## Set up

Pick one:

```sh
factory setup --config-only --repository OWNER/REPO --checkout /abs/path/to/target
factory setup --background  --repository OWNER/REPO --checkout /abs/path/to/target
```

`--config-only` writes the configuration and starts nothing. `--background` also checks readiness, then installs and starts the service that runs the queue. Running it is the service consent. It grants no provider spending and runs no Objective. The command prints JSON: `status` is `configured`, `ready` or `blocked`. A `blocked` result names the failed stage; fix it and repeat the same command.

Repeating setup with a matching binding reuses the configuration. A conflicting option stops, because Factory never changes an active binding.

Configuration lives under `$XDG_CONFIG_HOME/clockgrove-factory` and state under `$XDG_STATE_HOME/clockgrove-factory` (defaults `~/.config` and `~/.local/state`). Keep both, and all plan output and logs, outside the checkout.

### Models, network and delivery

Choose these at setup. Defaults: `gpt-6.1-sol` for planner, reviewer and worker, with `high` reasoning for planner and reviewer and `medium` for the worker.

| Option                                                      | Effect                                                                                                                                    |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `--concurrency N`                                           | Worker ceiling. Omit it to size workers from the host; setup reports `capacity`.                                                          |
| `--planning-model` `--review-model` `--worker-model`        | Role models. Each has a matching `--*-reasoning`.                                                                                         |
| `--planning claude-agent-sdk`                               | Plan and review with Claude. Pass both models. It uses `claude auth login`.                                                               |
| `--harness codex-sdk\|claude-agent-sdk\|github-copilot-sdk` | The worker agent. Details in [agent harnesses](AGENT-HARNESSES.md).                                                                       |
| `--delivery regular\|native-stack`                          | Pull requests, or native linear stacks.                                                                                                   |
| `--network host\|off`                                       | Worker network policy. `off` works for Codex only.                                                                                        |
| `--capture-content`                                         | Keep prompts and responses locally. See [capture](CAPTURE.md).                                                                            |
| `--credential-file NAME=/abs/private/file`                  | With `--background`: bind a provider credential to the service. Repeat per credential.                                                    |
| `--outside-directory /abs/dir`                              | With `--background`: the directory for the Codex write-refusal check. The default is your home; change it if home is inside the checkout. |

Remote execution (`execution.kind: "managed-agent"`) runs Work Items in a provider-hosted session. It is implemented, not yet qualified against live providers; see [managed execution](REMOTE-EXECUTION.md).

## Write an Objective

Start from [the template](https://github.com/clockgrove/factory/blob/main/docs/templates/objective.md) or [the issue form](https://github.com/clockgrove/factory/blob/main/docs/templates/objective.yml). An Objective has four sections. Keep it to one page.

- **Outcome:** one paragraph: what changes, for whom, and what is out of scope.
- **Acceptance:** one observable fact per bullet. A bullet that is exactly one backticked command means that command must pass on the integrated result. "Run the tests" is not a command. Put a path or other code span inside a sentence, not as a bullet of its own.
- **Sources:** files or `path#Exact Heading` sections workers need, one per bullet. Each costs tokens, so keep the list short.
- **Constraints:** non-goals and limits workers must respect.

A plan can name a CI check only if it is a pull-request workflow job at the base. Checks from external apps cannot be named. Delivery re-checks the job against the default branch: if it is renamed after planning, the run asks you to restore it and `factory retry`, or to cancel and plan again.

Factory refuses the earlier sections with a message that says where the content goes: Final validation (an Acceptance command bullet), Required checks (a workflow job), Planning sources (Sources), What must be true (Acceptance), Goal (Outcome), Non-goals (Constraints). For adding packages to an existing `pnpm-workspace.yaml`, use the optional **Workspace package additions** section: exact backticked directories, as a level-two or level-three heading like the other sections. Undeclared workspace changes are blocked, and planning refuses a plan that creates an undeclared package. Any other change to `pnpm-workspace.yaml` (such as `allowBuilds` dependency build approvals) is yours to make, because which dependency scripts may run is the operator's decision: no Objective section authorizes it. Merge it to the default branch before `factory run`. If planning already stopped on it, merge the change, refuse the stopped planning and run again.

Keep the first Objective small. Editing the issue after planning invalidates the saved plan; refuse it (below) and run again.

### Writing Objectives that deliver

Short rules from real runs. Each has its reason.

- **One packet per Objective.** Do not bundle unrelated fixes. _Because_ one bad part stops the whole Objective, and a bundle cannot be reviewed as one outcome.
- **Check that the work it depends on is delivered, and that every Source exists on the default branch.** _Because_ Factory plans from the base branch, so a file that is still in an open PR is missing for the planner and the workers.
- **Say where a new check gets wired.** Name a file the fixed acceptance scripts already run. _Because_ acceptance script bodies are fixed: a new test or check that no existing script runs is never run.
- **Leave dependency build approvals and other workspace configuration to the operator.** Set them on the base branch before the run. _Because_ a worker's change to them is out of its ownership and is blocked.
- **Inject what does not exist yet; do not require it.** Pass a missing file, service or value in through the code under test. _Because_ an Acceptance bullet that needs something absent can never pass.
- **Put stable repository facts in the target's own contributor docs** (for example its `AGENTS.md` or `CONTRIBUTING.md`), not in every Objective. _Because_ workers read them each run, and an Objective stays short and about one outcome.

A version refresh of an existing exact stable npm or pnpm `packageManager` pin needs an optional **Package manager update** section. Use exactly one backticked pin in one bullet, under a level-two or level-three heading:

```markdown
## Package manager update

- `pnpm@10.34.5`
```

Factory parses this section from the pinned Objective, checks that the accepted base uses the same manager, and supplies the exact update to the planner and workers. Prose elsewhere does not grant authority. A range, URL, prerelease, manager switch, duplicate section or multiple pins is refused before planning. Intermediate work may keep the base pin until the update lands; successors preserve the declared pin, and final validation requires it. Package scripts invoked by acceptance commands and their pre/post lifecycle hooks remain fixed. The update grants no changes to `config`, `pnpm`, `.npmrc`, workspace security settings, alternative `package.yaml` manifests or package-manager hook files, including when validation uses only Node or other commands. Configured `pnpmfile` hooks are unsupported under this authority and are refused before planning, including when only Node validation commands are declared. For npm/pnpm validation commands, prepare the declared version on the validation PATH before running: host readiness checks that exact version.

The section cannot be added retroactively to an accepted plan: its Objective body is digest-bound. If a prior attempt failed on the fixed-pin guard, preserve the rejected candidate, evidence, usage and consumed allowances. Diagnose the conflict and use the supported lifecycle to stop the predecessor before a corrected new Objective; an unchanged retry cannot authorize the update.

## Run

```sh
factory run --objective N [--deadline ISO_TIMESTAMP]
```

Running is the consent to execute that Objective. `run` plans if needed, saves the plan and its independent review, executes a clean plan, and exits:

| Exit | Meaning                                                   |
| ---- | --------------------------------------------------------- |
| 0    | The Objective completed; final validation passed.         |
| 2    | It needs you. The message names the decision and command. |
| 1    | It failed or was cancelled. The message says why.         |

Run the same command again to resume. A saved plan is never planned again, and every step is safe to repeat. The first run also checks host and worker readiness, without a model call, and names any failing check and its fix. Control a live run from another terminal with `factory pause|drain|resume|cancel --objective N`. Pause and drain survive restarts, and `resume` continues either. `--deadline` is absolute and a restart cannot extend it. Different Objectives can run at the same time, each from its own terminal with its own configured concurrency; a second live run of the same Objective is refused.

## Queue and background

The background service runs queued Objectives one at a time. Foreground runs of different Objectives can run in parallel, but the service and a live foreground run exclude each other. It needs a systemd user manager and keeps running after the terminal closes. Sleep pauses it, shutdown stops it, and logout behavior follows your host's linger setting. Factory changes neither.

```sh
factory queue add N [N ...]   # consent to run these, in order, within the autonomy limits
factory queue list | remove N | pause | resume | drain
factory supervisor start | stop [--disable] | upgrade --cli /abs/installed/dist/cli.js | uninstall
```

- `queue add` never replaces the queue. An Objective already queued keeps its place and takes the issue's current body. `remove` withdraws a pending Objective and refuses an active one.
- Queued Objectives that an earlier run left unfinished go first, one at a time in queue order. The service leaves an unfinished Objective that is not queued alone; `factory queue add N` hands it over.
- With an empty queue the service only watches GitHub, makes no model calls and lists unqueued candidates. Labels and discovery never admit work. Polling uses `queue.pollSeconds` (default 30).
- `supervisor stop` drains and keeps state. `--disable` also stops it starting at login. `upgrade` drains the owner, then switches the unit. The new package refuses state written by an incompatible version when it starts. If the restarted service does not take ownership, the error names `journalctl --user -u UNIT` and the `factory supervisor upgrade --cli PREVIOUS_CLI` command that returns to the previous package and restarts the service.
- An Objective that needs a human exits the service with code 2. Decide it, run `factory queue resume`, then `factory supervisor start`.

## Status

```sh
factory status --objective N [--json]
factory status
```

The first line is the headline, for example `Objective #7: needs plan decision — plan review needs a human decision`. The next lines give `Next:`, the exact command that answers it. Then come the question, if any, and a table of Work Items. The phases are `not started`, `planning`, `needs plan decision`, `running`, `waiting`, `needs decision`, `failed`, `cancelled` and `complete`. `--json` carries the same summary plus the plan, graph, consumed allowances and failure identities. Without `--objective`, status shows the service and the queue.

Status names a command only while Factory would accept it. `status --json` reports `repairs.ID.repairable` (the `implementation` class is enabled and an allowance fits; otherwise status names `factory retry --item`). For a rejected graph amendment, `pendingAmendment.replacementRefusal` is null when `factory propose-amendment` would take a replacement, else `{kind, message}` for the first refusal. Branch on `kind`, never on `message`. A rejection holds the Objective paused, so `factory resume` and `drain` leave it paused and report `hold` with the command that lifts it; `factory queue resume` leaves it paused too. The replacement lifts the hold. Status names the command that works for each kind:

- `not-paused` (a state from before the hold, or one the hold did not reach): `factory pause`.
- `stop` (an unrelated stop is recorded): `factory retry`.
- `live-work` (Work Items are still live): `factory retry` while the Objective is failed, else `factory run` with no owner, else `factory cancel`; a paused owner cannot settle them because the rejection blocks delivery.
- `unsettled` (a recorded subprocess or an unresolved cancellation): `factory cancel`.
- `intake` (the Objective is closing or finished), `not-replaceable` (an operator-supplied graph, or a rejection the validator does not know), `planning-class` (no planning class in `autonomy.repairClasses`) and `planning-limit` (no planning revision left): `factory cancel`. A raised limit applies to a new Objective.

After the first three commands status names the replacement.

When the configuration changed after an Objective started, a new run refuses it. Status then says to restore the configuration it started with, then `factory run`, or to end it: `factory decide --outcome refuse` while planning, before projection starts; otherwise `factory cancel`. Status compares the configuration live, so restoring it is enough. A run also records `changedSincePlanning` (in `status --json`) when the Objective body or the sources differ from what the plan was made from, and status names the same two commands; restoring them and running again clears it. While planning, a pause or drain comes first (`factory resume`), because a refusal would discard it. Once the final acceptance is sealed, cancel is refused, so only the restore and `factory run` reconcile it. While an owner is running it keeps its loaded configuration, so status keeps naming `resume`, `decide` and `select`.

Observe further with `factory diagnostics --objective N` (the agent timeline; add `--follow` or `--logs ITEM`; `--summary` prints the efficiency report: wall time per stage, operator waits, attempts and tokens per role, and `--summary --json` the same for tools). A quiet timeline means no new provider event. It does not mean done, and missing usage is unknown, not zero. Diagnostics can hold private source, so keep them out of public issues. Timing and capture analysis are in [capture](CAPTURE.md).

## Decisions

Factory stops for a decision only when a human owns it. Show the operator the exact question and evidence, then record the answer. Each command is followed by `factory run --objective N`.

```sh
# Plan question: accept needs --answer; refuse discards the plan so the next run plans again
factory decide --objective N --outcome accept --answer "Specific answer" --reason "Evidence and authority"
factory decide --objective N --outcome refuse --reason "Why"

# Result criterion: --item names a Work Item; omit it for final acceptance
factory decide --objective N --item ITEM --outcome accept|refuse --reason "Reviewed evidence"
```

Decisions read the exact plan or tree from state, apply only to that plan or tree, and never bypass branch protection. Review excerpts can be truncated, and a truncated excerpt cannot auto-pass, so inspect the full tree before accepting. Raising `FACTORY_RESULT_REVIEW_TEXT_BUDGET_BYTES` may allow a complete automatic review.

```sh
# Run validation and review again on a pending Work Item result. No model call, accepts nothing.
factory retry --objective N --item ITEM --rereview

# Start a failed or cancelled Work Item's new attempt, or answer the stopped step that status names
factory retry --objective N [--item ITEM]

# Record a diagnosed correction for a failed Work Item
factory repair --objective N --proposal /abs/repair.json

# Submit a graph amendment, or a replacement for a rejected one
factory propose-amendment --objective N --proposal /abs/proposal.json
```

- **repair file:** `{"item": "ITEM", "correction": {"kind": "implementation", "failureDigest": "...", "diagnosis": "...", "correction": "...", "actor": "NAME"}}`. The `failureDigest` is `repairs.ITEM.failureDigest` in `status --json`. The correction starts a new attempt from the accepted base and uses the allowance already charged for the failure.
- **blamed on a merged predecessor:** when the failing file belongs to a merged predecessor (by the accepted graph's `ownedPaths`), the item stops with a decision that names the predecessor, its PR and the file, and no repair is spent, because repairing the dependent cannot fix it. Submit an amendment that adds a Work Item after the predecessor and owns the file, then `factory run` to merge it, `factory retry --objective N --item ITEM` for a new attempt on the integrated head, and `factory run`. `factory status` names whichever step is due. An amendment costs a planning revision (default 1) and is refused when none is left; then only `factory cancel` and a new Objective with a higher `autonomy.allowances.planningRevisions` helps, because limits are fixed when an Objective starts.
- **amendment file:** `scope` (`in-scope` or `backlog`), `reason`, nonempty `evidence`, `ownership` and `acceptance` arrays, `dependencies` (known Work Item IDs), `actor`, and `expectedGraphDigest` (the `graphDigest` in `status --json`). An optional `graph` is a complete proposed replacement. Workers can also stage `.factory-discovery.json`, and Factory reviews it the same way. A worker that needs a path its item does not own names it there and stops; when the amendment is accepted, the item owns the path and starts a new attempt without a repair or a decision. While the Objective is stopped, `propose-amendment` takes an in-scope amendment and the next `factory run` reviews and projects it. A backlog discovery needs a running owner.
- **replacing a rejected amendment:** add `replacement: {"amendmentId": "...", "correction": {...}}` with the same correction fields as a repair, taking `amendmentId` (its `id`) and `failureDigest` from `pendingAmendment` in `status --json`. It needs a paused, settled Objective and a remaining planning allowance. It consumes one revision, and the fresh amendment still goes through validation and independent review.
- **media:** `factory select --objective N --item ITEM --output /abs/new/dir` writes every candidate AssetSet for review. Then `factory select --objective N --item ITEM --set SET_ID [--bind DEPENDENT ...]` records the whole-set pick. The target's `.gitattributes` owns Git LFS policy.

## Autonomy limits

Runs repair and amend within bounded limits. The optional `autonomy` configuration section changes them. Omitted fields keep these defaults:

```json
{
  "autonomy": {
    "allowances": {
      "planningRevisions": 1,
      "implementationRepairs": 2,
      "resultRereviews": 1
    },
    "repairClasses": [
      "implementation",
      "planning-output",
      "planning-evidence",
      "planning-choice"
    ],
    "repairPolicy": {
      "perPath": {
        "planningRevisions": 1,
        "implementationRepairs": 1,
        "resultRereviews": 1
      }
    },
    "requiredEnvironment": []
  }
}
```

`allowances` cap the Objective and `perPath` caps each original Work Item. Zero is valid, and `repairClasses: []` stops for a human on every failure. `requiredEnvironment` lists worker secrets that must exist before planning; each must also be in `policy.allowedSecretNames`. Only a wrong result is charged: a failed validation, a refused criterion or a plan finding. A transient or configuration failure never is. Each Objective snapshots its limits when it starts, and consumption never resets. Exhausted limits stop for a decision. The optional `scheduling` section sets CPU, memory, review and validation reservations, and by default these come from the host.

## Stopping and recovery

Every step is safe to repeat, so after any interruption run the Objective again: Factory re-reads its state and GitHub, finds its issues, pull requests and merges by stable identity, reattaches a running worker, and repeats only the step it was on. A real failure keeps its evidence and stops until you `retry`, `repair` or `cancel`. See [Architecture, State and recovery](https://github.com/clockgrove/factory/blob/main/docs/ARCHITECTURE.md#state-and-recovery) for the state layout, the step rules and the retry limits. Never delete state or start a new root to get past a stop.

## Safety

Factory checks changed-path ownership, unsafe links and special files, and scans staged content with its packaged Secretlint rules before publishing. A finding names the rule and path, never the value. Review false positives outside the checkout, then point `FACTORY_SECRETLINT_CONFIG` at a reviewed config and retry. Workers get a filtered environment without controller GitHub, Git or SSH credentials. Workers run as your OS user and are not a boundary against hostile code. Follow the [security policy](https://github.com/clockgrove/factory/blob/main/SECURITY.md).
