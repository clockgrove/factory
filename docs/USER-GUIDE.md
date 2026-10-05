# Factory user guide

Factory turns one Objective, a GitHub issue in your target repository, into reviewed pull requests: it plans, runs coding agents, validates, delivers and checks the integrated result. The target repository owns requirements and branch rules. Factory's configuration and state stay outside it.

Agents operate Factory through the `setup` and `director` skills, and the skills run the commands below. `factory help` lists every command and option of the installed version and is the authority if this guide differs. Install with the [README](../README.md#install). To change Factory itself, see [Contributing](https://github.com/clockgrove/factory/blob/main/CONTRIBUTING.md).

## Prerequisites

- Linux x64 (WSL2 works), Node.js 22 or later, Git 2.31 or later, an authenticated `gh`, and a Codex login. Other providers are in [agent harnesses](AGENT-HARNESSES.md).
- A trusted checkout whose `origin` fetch and push URLs resolve to the same GitHub `OWNER/REPO`. Factory refuses local-path origins, mismatched push URLs and its own source repositories.
- The target's toolchain on the validation `PATH`. Factory installs no package manager or build tool. Validation runs commands with non-login `sh -c`, so shell profiles do not provision it.
- Requirements and validation instructions committed. Planning reads the pinned Git base, not uncommitted edits.
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

Choose these at setup. Defaults: planner and reviewer `gpt-5.6-sol`, worker `gpt-5.6-luna`, all `medium` reasoning.

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

Start from [the template](https://github.com/clockgrove/factory/blob/main/docs/templates/objective.md) or [the issue form](https://github.com/clockgrove/factory/blob/main/docs/templates/objective.yml). The sections that matter:

- **Acceptance:** one observable fact per bullet. A bullet that is one command line means that command must pass.
- **Final validation:** exact commands that must pass on the integrated result. "Run the tests" is not a command.
- **Required checks** (optional): CI check names that are not pull-request workflow jobs, such as checks from external apps. A plan can name only checks that exist at the base or are listed here.
- **Planning sources** (optional): files or `path#Exact heading` sections workers need. Each costs tokens, so keep the list short.
- **Workspace package additions** (optional): exact backticked directories, to add packages to an existing `pnpm-workspace.yaml`. Undeclared workspace changes are blocked.

Keep the first Objective small. Editing the issue after planning invalidates the saved plan; refuse it (below) and run again.

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

Run the same command again to resume. A saved plan is never planned again, and every step is safe to repeat. The first run also checks host and worker readiness, without a model call, and names any failing check and its fix. Control a live run from another terminal with `factory pause|drain|resume|cancel --objective N`. Pause and drain survive restarts, and `resume` continues either. `--deadline` is absolute and a restart cannot extend it.

## Queue and background

The background service runs queued Objectives one at a time. It needs a systemd user manager and keeps running after the terminal closes. Sleep pauses it, shutdown stops it, and logout behavior follows your host's linger setting. Factory changes neither.

```sh
factory queue add N [N ...]   # consent to run these, in order, within the autonomy limits
factory queue list | remove N | pause | resume | drain
factory supervisor start | stop [--disable] | upgrade --cli /abs/installed/dist/cli.js | uninstall
```

- `queue add` never replaces the queue. An Objective already queued keeps its place and takes the issue's current body. `remove` withdraws a pending Objective and refuses an active one.
- With an empty queue the service only watches GitHub, makes no model calls and lists unqueued candidates. Labels and discovery never admit work. Polling uses `queue.pollSeconds` (default 30).
- `supervisor stop` drains and keeps state. `--disable` also stops it starting at login. `upgrade` checks that the new package can continue the retained state before switching.
- An Objective that needs a human exits the service with code 2. Decide it, run `factory queue resume`, then `factory supervisor start`.

## Status

```sh
factory status --objective N [--json]
factory status
```

The first line is the headline, for example `Objective #7: needs plan decision — plan review needs a human decision`. The next lines give `Next:`, the exact command that answers it. Then come the question, if any, and a table of Work Items. The phases are `not started`, `planning`, `needs plan decision`, `running`, `waiting`, `needs decision`, `failed`, `cancelled` and `complete`. `--json` carries the same summary plus the plan, graph, consumed allowances and failure identities. Without `--objective`, status shows the service and the queue.

Status names a command only while Factory would accept it. `status --json` reports `repairs.ID.repairable` (the `implementation` class is enabled and an allowance fits; otherwise status names `factory retry --item`). For a rejected graph amendment, `pendingAmendment.replacementRefusal` is null when `factory propose-amendment` would take a replacement, else `{kind, message}` for the first refusal, and status then names a command that works: `factory cancel` for `not-replaceable`, `planning-class` and `planning-limit`, `factory retry`, `factory resume` or `factory run` for `ownership` when one of them settles it (a paused owner with live work cannot, so that ends in `factory cancel`). The kinds are `intake` (the Objective is closing or finished), `not-replaceable` (an operator-supplied graph, or a rejection the validator does not know), `ownership` (the coordinator is not paused, or a stop, subprocess or Work Item is still live), `planning-class` (no planning class in `autonomy.repairClasses`) and `planning-limit` (no planning revision left; the rejected attempt used the default one). A raised limit applies to a new Objective. When the configuration changed after an Objective started, a new run refuses it. Status then says to restore the configuration it started with, then `factory run`, or to end it: `factory decide --outcome refuse` while planning, before projection starts; otherwise `factory cancel`. Once the final acceptance is sealed, cancel is refused, so only the restore and `factory run` reconcile it. While an owner is running it keeps its loaded configuration, so status keeps naming `resume`, `decide` and `select`.

Observe further with `factory diagnostics --objective N` (the agent timeline; add `--follow`, `--summary`, or `--logs ITEM`). A quiet timeline means no new provider event. It does not mean done, and missing usage is unknown, not zero. Diagnostics can hold private source, so keep them out of public issues. Timing and capture analysis are in [capture](CAPTURE.md).

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
- **amendment file:** `scope` (`in-scope` or `backlog`), `reason`, nonempty `evidence`, `ownership` and `acceptance` arrays, `dependencies` (known Work Item IDs), `actor`, and `expectedGraphDigest` (the `graphDigest` in `status --json`). An optional `graph` is a complete proposed replacement. Workers can also stage `.factory-discovery.json`, and Factory reviews it the same way. While the Objective is stopped, `propose-amendment` takes an in-scope amendment and the next `factory run` reviews and projects it. A backlog discovery needs a running owner.
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
