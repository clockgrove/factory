# Factory user guide

Factory turns one Objective, a GitHub issue in your target repository, into reviewed pull requests: it plans, runs coding agents, validates, delivers and checks the integrated result. The target repository owns requirements and branch rules. Factory's configuration and state stay outside it.

Agents operate Factory through the `setup` and `director` skills, and the skills run the commands below. `factory help` lists every command and option of the installed version and is the authority if this guide differs. Install with the [README](../README.md#install). To change Factory itself, see [Contributing](https://github.com/clockgrove/factory/blob/main/CONTRIBUTING.md).

## Prerequisites

- Linux x64 (WSL2 works), Node.js 22 or later, Git 2.31 or later, an authenticated `gh`, and a Codex login. Other providers are in [local providers](#local-providers).
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

When a prerequisite needs you, Factory’s operator should collect all retained review findings, available readiness results and source-verified requirements into one checklist. Each missing or unknown item should include its reason, source, setup step and verification command; an unchecked stage remains unknown. Answer required choices together and put secrets only in the approved secret store or private credential file, never chat or issues. Verify the requirements before answering a decision. The checklist grants no new authority; independent work can continue only where already authorized and admitted by the current gates.

Repeating setup with a matching binding reuses the configuration. A conflicting option stops, because Factory never changes an active binding.

Configuration lives under `$XDG_CONFIG_HOME/clockgrove-factory` and state under `$XDG_STATE_HOME/clockgrove-factory` (defaults `~/.config` and `~/.local/state`). Keep both, and all plan output and logs, outside the checkout.

### Models, network and delivery

Choose these at setup. Defaults: `gpt-6.1-sol` for planner, reviewer and worker, with `high` reasoning for planner and reviewer and `medium` for the worker.

| Option                                                      | Effect                                                                                                                                    |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `--concurrency N`                                           | Worker ceiling. Omit it to size workers from the host; setup reports effective `capacity` and a local host recommendation.                |
| `--planning-model` `--review-model` `--worker-model`        | Role models. Each has a matching `--*-reasoning`.                                                                                         |
| `--planning claude-agent-sdk`                               | Plan and review with Claude. Pass both models. It uses `claude auth login`.                                                               |
| `--harness codex-sdk\|claude-agent-sdk\|github-copilot-sdk` | The worker agent. Details in [local providers](#local-providers).                                                                         |
| `--delivery regular\|native-stack`                          | Pull requests, or native linear stacks.                                                                                                   |
| `--network host\|off`                                       | Worker network policy. `off` works for Codex only.                                                                                        |
| `--capture-content`                                         | Keep prompts and responses locally. See [diagnostic capture and export](#diagnostic-capture-and-export).                                  |
| `--credential-file NAME=/abs/private/file`                  | With `--background`: bind a provider credential to the service. Repeat per credential.                                                    |
| `--outside-directory /abs/dir`                              | With `--background`: the directory for the Codex write-refusal check. The default is your home; change it if home is inside the checkout. |

Remote execution (`execution.kind: "managed-agent"`) runs Work Items in a provider-hosted session. It is implemented, not yet qualified against live providers; see [managed execution](#managed-execution).

## Local providers

The harness executes Work Items; `--planning` selects the separate planner and reviewer. Codex is the default. Factory never falls back to another provider. Local logins must belong to the OS user running the controller; on WSL2, log in inside that distribution.

| Harness              | Setup requirements                                              | Login                                                | Worker network  |
| -------------------- | --------------------------------------------------------------- | ---------------------------------------------------- | --------------- |
| `codex-sdk`          | No extra flags                                                  | `codex login`                                        | `host` or `off` |
| `claude-agent-sdk`   | `--worker-model MODEL --claude-max-turns N`                     | `claude auth login`, or supported Claude credentials | `host`          |
| `github-copilot-sdk` | `--worker-model MODEL --copilot-timeout-seconds N`; Node 22.12+ | `copilot`, or supported Copilot credentials          | `host`          |

For example, add `--harness claude-agent-sdk --worker-model MODEL --claude-max-turns 12` to setup. A normal npm install includes both optional SDKs; `--omit=optional` leaves Codex and registered adapters. Claude planning also requires `--planning-model` and `--review-model`. It supports the local Claude login, `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`, without settings files; Bedrock, Vertex and `apiKeyHelper` are unsupported. Factory stores no tokens in its configuration. A missing login stops the attempt; status names the login command and the retry command.

Claude worker credentials can also use `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_PROFILE`, `ANTHROPIC_CONFIG_DIR` or `CLAUDE_CONFIG_DIR`. Copilot supports `COPILOT_GITHUB_TOKEN`, `GITHUB_COPILOT_API_TOKEN`, `COPILOT_API_URL` and `COPILOT_PROVIDER_*`. Its local login must work without the system keychain. For a headless Claude service, bind `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` with `--credential-file`.

Claude's default tools are `Read`, `Edit`, `Write`, `Glob`, `Grep`; `--claude-tool` replaces them and `--claude-allow-tool` sets permissions. `--claude-permission` accepts `acceptEdits` (default) or `dontAsk`. No settings files load unless you add `--claude-setting-source user|project|local`; those settings and hooks are trusted local code. Copilot defaults to `view`, `create`, `edit`, `apply_patch`, `grep`, `glob`; `--copilot-tool` replaces that list. Keep `apply_patch` for models that need it to edit.

Codex workers and reviewers use a private `HOME`, `CODEX_HOME` and `TMPDIR` with the controller's Codex authentication. Personal Codex configuration, instructions, skills and MCP servers do not apply. Workers get read-only Git access in their own worktree and read-only tools from the controller’s `PATH`; commits and publication belong to the controller. Keep credentials out of Git config and remote URLs. Package stores are private to each worker, so a first install needs `--network host`.

Use real tool installation directories on `PATH`, rather than version-manager shims. A `bin` or `sbin` path normally exposes its install prefix read-only; under hidden prefixes such as `~/.local` only the bin directory is mounted. Directories containing your home, credentials, Factory state/configuration or checkout Git metadata are refused. Links into those directories and tools needing other unmounted files cannot run. The refusal names the path to remove or relocate.

Claude and Copilot keep the login-bearing home in the SDK process, but the model has no shell and its file tools stay inside the worktree. Claude personal instructions, skills, plugins, subagents and memory are disabled; explicitly selected settings and administrator-managed components remain trusted. Copilot shell, web, GitHub, MCP, plugins and configuration discovery are disabled. Harness processes run as your OS user; these controls do not isolate hostile code.

### Execution profiles and adapters

To let planning select a harness per item, replace `execution.harness` with `execution.profiles` and an eligible `execution.defaultProfile`:

```json
{
  "kind": "local",
  "concurrency": 2,
  "defaultProfile": "standard",
  "profiles": {
    "standard": {
      "description": "General implementation.",
      "selectionHints": ["Default for routine work."],
      "harness": {
        "kind": "codex-sdk",
        "model": "gpt-6.1-sol",
        "reasoningEffort": "medium"
      }
    }
  }
}
```

Copy other harness objects from setup output. Listing a profile authorizes its provider to read the whole worktree and supplied inputs; ownership limits writes. Keep secrets out of descriptions and hints. Assignments and reasons persist through restart and collection; editing an issue cannot change an item's binding.

A profile's optional `environment.instructions` appends worker instructions without granting permissions. `environment.mcp: {"kind":"factory-worktree-read","version":1}` is Claude-only, requires `Read` in both tool lists and exposes only regular files inside the worktree. Registered profiles accept no environment. Unknown configuration fields are refused; changing configuration changes its digest and stops an existing Objective at its next step.

Custom adapters use the exported `AgentHarness` contract and `composeWithLocalHarness`, or `composeWithLocalProfiles` keyed by profile ID. Configure `{"kind":"registered","adapter":"IDENTITY","config":{...}}`; the registration's identity and config must match. Adapters must preserve HEAD, use only the supplied worktree, return durable JSON-safe handles, and make observation, cancellation and collection restart-safe without duplicating attempts. They never publish. Factory still validates and reviews results and assets. A behavior change needs a new adapter identity; see the exported types in `@clockgrove/factory`.

## Managed execution

`execution.kind: "managed-agent"` runs Work Items with `claude-managed-agents` or `openai-agents`; planning, validation, review and delivery stay on the controller. Neither provider is live-qualified. First authorize the source leaving the host (pinned base and supplied assets), provider account, model, data handling and spending limit. Installation grants none of those permissions. The removed `sandbox` execution kind is refused.

Edit the installation's `execution` object before starting an Objective. Set `policy.network` to `off` and `policy.allowedSecretNames` to `[]`; the controller still needs provider and GitHub connectivity. `execution.concurrency` bounds Factory’s workers, not provider capacity. Input is a shallow base snapshot without history or local Git configuration; symlinks and submodules are refused. Results pass the same path, digest, validation and review checks as local work.

OpenAI configuration:

```json
{
  "kind": "managed-agent",
  "provider": "openai-agents",
  "concurrency": 1,
  "config": {
    "model": "APPROVED_MODEL",
    "reasoningEffort": "medium",
    "containerSize": "small",
    "apiKeyEnv": "FACTORY_OPENAI_API_KEY",
    "timeoutSeconds": 600
  }
}
```

All five config fields are required. Reasoning is `low|medium|high`; container size is `small|medium|large`. Input is limited to 5 MiB, output to 200 MiB. Extra turns, subagents, networking, extra tools, plugins and credentials are refused.

Claude configuration requires `agentId`, pinned positive `agentVersion`, `environmentId`, `workspaceId`, `credentialEnv`, the full resolved `agent` snapshot including its model, and this `environment`:

```json
{
  "type": "cloud",
  "networking": {
    "type": "limited",
    "allowed_hosts": [],
    "allow_mcp_servers": false,
    "allow_package_managers": false
  },
  "packages": { "type": "packages" }
}
```

Place those fields in `execution.config` with `execution.provider: "claude-managed-agents"`. The agent snapshot must match its ID and version, disable the default toolset, MCP, skills and subagents, and enable only `bash`, `read`, `write`, `edit`, `glob`, `grep`; `bash` is required. Obtain the full snapshot from the provider; a placeholder is not valid configuration. `timeoutSeconds` defaults to 900. Optional `budgetCents` is a positive integer string and is a cost threshold, not a hard cap: a request can cross it. Factory must own the session exclusively; reusable agents and environments are not deleted.

The named API key belongs in the foreground controller environment, never the config or model input. Local CLI logins do not supply it. For background operation, put only the key in an owner-private `0600` file outside the target checkout and pass `--credential-file NAME=/absolute/private/file`. This requires systemd `LoadCredential`; restart the service after rotation. A missing service credential stops execution without ambient fallback. Readiness checks presence without a provider call, so they do not establish account access, billing or hosted support.

The timeout bounds the entire attempt; cleanup gets a fresh window of the same length. Factory checkpoints calls, reconciles lost responses where possible and reattaches collection after transient failures. Nontransient failures stop the old resource before a fresh attempt or repair. Cleanup after completion or cancellation confirms deletion; unconfirmed cleanup remains visible and retries on restart. Never start replacement work beside an unresolved old resource.

`factory diagnostics` records `possible-orphan` resources with attempt ID and time. For Claude lost uploads, inspect and delete unreferenced uploads from that interval. For an OpenAI lost session creation, find sessions tagged `factory_attempt=<attempt ID>` and delete them, confirming the environment is gone. Token counters are not a bill; absent counters stay unknown.

## Write an Objective

Start from [the template](https://github.com/clockgrove/factory/blob/main/docs/templates/objective.md) or [the issue form](https://github.com/clockgrove/factory/blob/main/docs/templates/objective.yml). An Objective has four sections. Keep it to one page.

The Markdown template contains the four core sections. Add an optional authority section only for a change this Objective actually requests; its examples are syntax guidance, not default package or version choices. The issue form keeps those fields optional.

- **Outcome:** one paragraph: what changes, for whom, and what is out of scope.
- **Acceptance:** one observable fact per bullet. A bullet that is exactly one backticked command means that command must pass on the integrated result. "Run the tests" is not a command. Put a path or other code span inside a sentence, not as a bullet of its own.
- **Sources:** files or `path#Exact Heading` sections workers need, one per bullet. Each costs tokens, so keep the list short.
- **Constraints:** non-goals and limits workers must respect.

A plan can name a CI check only if it is a pull-request workflow job at the base. Checks from external apps cannot be named. Delivery re-checks the job against the default branch: if it is renamed after planning, the run asks you to restore it and `factory retry`, or to cancel and plan again.

Factory refuses the earlier sections with a message that says where the content goes: Final validation (an Acceptance command bullet), Required checks (a workflow job), Planning sources (Sources), What must be true (Acceptance), Goal (Outcome), Non-goals (Constraints). For adding packages to an existing `pnpm-workspace.yaml`, use the optional **Workspace package additions** section: exact backticked directories, as a level-two or level-three heading like the other sections. Undeclared workspace changes are blocked, and planning refuses a plan that creates an undeclared package. Any other change to `pnpm-workspace.yaml` (such as `allowBuilds` dependency build approvals) is yours to make, because which dependency scripts may run is the operator's decision: no Objective section authorizes it. Merge it to the default branch before `factory run`. If planning already stopped on it, merge the change, refuse the stopped planning and run again.

Keep the first Objective small. Editing the issue after planning invalidates the saved plan; refuse it (below) and run again.

### Writing Objectives that deliver

Keep Objectives small and executable:

- Deliver one packet per Objective, without unrelated fixes.
- Confirm prerequisites are delivered and every Source exists on the default branch.
- Name where each new check is wired into the fixed acceptance scripts.
- Put dependency build approvals and other workspace configuration on the base branch before running.
- Inject missing services or values rather than requiring prerequisites that do not exist.
- Keep stable repository facts in the target’s contributor docs instead of repeating them in every Objective.

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

Run the same command again to resume from recorded state. A saved plan is reused rather than planned again. The first run also checks host and worker readiness, without a model call, and names any failing check and its fix. Control a live run from another terminal with `factory pause|drain|resume|cancel --objective N`. Pause and drain let an already running try settle, then block new tries and paid calls. They survive restarts, and `resume` continues either. `--deadline` is absolute and a restart cannot extend it. Different Objectives can run at the same time, each from its own terminal with its own configured concurrency; a second live run of the same Objective is refused.

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

Status names a command only while Factory would accept it; follow the live `Next:` command. In JSON, `repairs.ID.repairable` reports whether an implementation repair is enabled and fits the remaining allowance. `pendingAmendment.replacementRefusal` is null when a replacement is admitted, otherwise `{kind, message}`; automation should branch on `kind` rather than prose. Replacing a rejected amendment requires a paused, settled Objective and a remaining planning allowance. The rejection holds work paused until its replacement is admitted; resume, drain and queue resume do not lift that hold. Limits raised in configuration apply only to a new Objective.

When the configuration changed after an Objective started, a new run refuses it. Status then says to restore the configuration it started with, then `factory run`, or to end it: `factory decide --outcome refuse` while planning, before projection starts; otherwise `factory cancel`. Status compares the configuration live, so restoring it is enough. A run also records `changedSincePlanning` (in `status --json`) when the Objective body or the sources differ from what the plan was made from, and status names the same two commands; restoring them and running again clears it. While planning, a pause or drain comes first (`factory resume`), because a refusal would discard it. Once the final acceptance is sealed, cancel is refused, so only the restore and `factory run` reconcile it. While an owner is running it keeps its loaded configuration, so status keeps naming `resume`, `decide` and `select`.

Observe further with `factory diagnostics --objective N` (the agent timeline; add `--follow` or `--logs ITEM`; `--summary` prints the efficiency report: wall time per stage, operator waits, attempts and tokens per role, and `--summary --json` the same for tools). A quiet timeline means no new provider event. It does not mean done, and missing usage is unknown, not zero. Diagnostics can hold private source, so keep them out of public issues. Timing and capture analysis are in [diagnostic capture and export](#diagnostic-capture-and-export).

## Decisions

Factory stops for a decision only when a human owns it. Show the operator the exact question and evidence, then record the answer. Each command is followed by `factory run --objective N`.

```sh
# Plan question: accept needs --answer; refuse discards the plan so the next run plans again
factory decide --objective N --outcome accept --answer "Specific answer" --reason "Evidence and authority"
factory decide --objective N --outcome refuse --reason "Why"

# Result criterion: --item names a Work Item; omit it for final acceptance
factory decide --objective N --item ITEM --outcome accept|refuse --reason "Reviewed evidence"
```

Decisions read the exact plan or tree from state, apply only to that plan or tree, and never bypass branch protection. Refusing a Work Item result records a failed-result event for the existing bounded correction path; it never turns passing command receipts into failed ones. Review excerpts can be truncated, and a truncated excerpt cannot auto-pass, so inspect the full tree before accepting. Raising `FACTORY_RESULT_REVIEW_TEXT_BUDGET_BYTES` may allow a complete automatic review.

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

An automatic implementation repair must be actionable now: every retained failed command is assessed, its concrete change stays within the Work Item’s ownership, and no unmet or unknown operator prerequisite remains. A conditional correction stops with a concrete question and starts no worker. Establish the operator condition before submitting `factory repair`; a proposal is your declared diagnosis and correction, not a controller receipt proving an external action happened. Automatic diagnosis uses the original command outcomes and actual owned candidate contents. Missing or truncated facts cannot establish readiness. A saved automatic correction without checked readiness remains historical evidence and needs an operator correction before admission.

For an older saved unpublished refusal without a failure event, status exposes its expected `failureDigest` while leaving the event and repairability unknown. Operator repair requires paused or drained, settled ownership and verifies the original refusal against the accepted graph and exact current Git tree. It records a new failure observation before applying the correction, preserving the original decision, time, reason, receipts and spent limits.

- **repair file:** `{"item": "ITEM", "correction": {"kind": "implementation", "failureDigest": "...", "diagnosis": "...", "correction": "...", "actor": "NAME"}}`. The `failureDigest` is `repairs.ITEM.failureDigest` in `status --json`. The correction starts a new attempt from the accepted base and uses the allowance already charged for the failure. `factory-controller` is reserved for automatic diagnosis; operator proposals must use their own actor and omit controller-generated `readiness`.
- **blamed on a merged predecessor:** when the failing file belongs to a merged predecessor (by the accepted graph's `ownedPaths`), the item stops with a decision that names the predecessor, its PR and the file, and no repair is spent, because repairing the dependent cannot fix it. Submit an amendment that adds a Work Item after the predecessor and owns the file, then `factory run` to merge it, `factory retry --objective N --item ITEM` for a new attempt on the integrated head, and `factory run`. `factory status` names whichever step is due. An amendment costs a planning revision (default 1) and is refused when none is left; then only `factory cancel` and a new Objective with a higher `autonomy.allowances.planningRevisions` helps, because limits are fixed when an Objective starts.
- **amendment file:** `scope` (`in-scope` or `backlog`), `reason`, nonempty `evidence`, `ownership` and `acceptance` arrays, `dependencies` (known Work Item IDs), `actor`, and `expectedGraphDigest` (the `graphDigest` in `status --json`). An optional `graph` is a complete proposed replacement. Workers can also stage `.factory-discovery.json`, and Factory reviews it the same way. A worker that needs a path its item does not own names it there and stops; when the amendment is accepted, the item owns the path and starts a new attempt without an implementation repair or a decision. The amendment still consumes a planning revision. Answering an operator plan question without revising the graph consumes none, leaving that revision available for discovery. Previously recorded charges stay spent. While the Objective is stopped, `propose-amendment` takes an in-scope amendment and the next `factory run` reviews and projects it. A backlog discovery needs a running owner.
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

`allowances` cap the Objective and `perPath` caps each original Work Item. Zero is valid, and `repairClasses: []` stops for a human on every failure. `requiredEnvironment` lists worker secrets that must exist before planning; each must also be in `policy.allowedSecretNames`. Only a wrong result or an admitted engineering correction is charged. A planning diagnosis that only asks an operator question consumes no planning revision; the independent diagnosis-call bound and actual usage remain recorded. A transient or configuration failure never is. Each Objective snapshots its limits when it starts, and consumption never resets. Exhausted limits stop for a decision. The optional `scheduling` section sets CPU, memory, review and validation reservations. When concurrency is omitted, defaults come from the host; an explicit concurrency keeps only explicitly declared scheduling. Local setup reports `capacityRecommendation` even with an override: it measures cores/memory, reserves 2 CPUs/4 GiB for the controller and OS, then sizes coding at 2 CPUs/2 GiB, validation at 4 CPUs/4 GiB, and review/delivery at 0.5 CPU/512 MiB. Reservations are capped by available totals. Recommendations never increase configured provider/spending limits or change an existing Objective’s saved capacity. Authorize and configure overrides before starting a new Objective.

## Stopping and recovery

After an interruption, use `factory run` to reconcile the recorded state: Factory finds GitHub issues, pull requests and merges by stable identity and reattaches running workers. Unresolved external mutations stay stopped rather than being blindly repeated. A real failure keeps its evidence and stops until you `retry`, `repair` or `cancel`. Never delete state or start a new root to get past a stop. See [Architecture](ARCHITECTURE.md#state-and-recovery) for the recovery model.

## Safety

Factory checks changed-path ownership, unsafe links and special files, and scans staged content with its packaged Secretlint rules before publishing. A finding names the rule and path, never the value. Review false positives outside the checkout, then point `FACTORY_SECRETLINT_CONFIG` at a reviewed config and retry. Workers get a filtered environment without controller GitHub, Git or SSH credentials. Workers run as your OS user and are not a boundary against hostile code. Follow the [security policy](https://github.com/clockgrove/factory/blob/main/SECURITY.md).

## Diagnostic capture and export

Factory records invocation metadata locally; content capture is off by default. Before planning, add `--capture-content --capture-max-bytes 8388608` to setup, or set `"capture": {"enabled": true, "maxBytesPerInvocation": 8388608}` in the installation config. Capture changes the config digest. The default 8 MiB allowance covers one invocation including provider retries; excess content is marked truncated and may be incomplete JSON.

Capture includes rendered planning/review prompts and schemas, worker prompts/settings and SDK-exposed messages and tool traffic. It does not expose hidden reasoning or provider system prompts, and does not intentionally record credentials, environment or client options. Metadata includes identities, configured/reported models, digests, usage and content availability. Missing usage stays unknown; use the latest cumulative snapshot per attempt rather than adding alternate views. Cost estimates are not bills. Codex SDK error items are nonterminal warnings: terminal outcomes and validation determine success or failure, and incomplete invocations remain incomplete.

Metadata stays in private Objective diagnostics; content is under the state root’s `captures/`, outside the target checkout, in `0600` files and `0700` directories. Secret redaction is best-effort and does not make private source publishable. Nothing is pruned automatically; you own retention. Removing capture files does not change a run. Capture failures appear in diagnostics and cannot accept, reject or retry work.

```sh
factory diagnostics --objective N --summary              # stage time, waits, attempts and tokens
factory diagnostics --objective N --summary --json
factory diagnostics --objective N --captures             # metadata only
factory diagnostics --objective N --captures --content RECORD_ID
factory diagnostics --objective N --analyze --group-by provider --group-by model
factory diagnostics --objective N --analyze --filter phase=implementation --json
factory diagnostics --objective N --analyze --filter runId=RUN_ID --gantt --output /abs/private/existing-dir/timeline.svg
```

Summary stage times count overlapping intervals once; operator waits and time outside a stage appear separately. Analysis reads metadata without captured text or provider calls. Grouping defaults to phase; repeat `--group-by` for combined fields. Filters match exactly (`reportedModel=null` selects missing reported models); unknown fields list allowed choices. Diagnosis uses phase `diagnosis`, graph compilation `compile`. Partial totals are marked; cached/reasoning counters are subsets, and concurrent elapsed times must not be summed. Gantt blue bars are model invocations, amber bars controller operations; validation labels are command indices.

Analysis `--output` creates a new `0600` file in an existing directory outside the target checkout without symlinked parents. `--gantt` requires output and excludes `--json`. API users can call `readInteractionMetadata`, `readInteractionContent` and `analyzeInteractions` from the package root.

Export is an explicit OTLP/HTTP JSON send to an approved collector, never a background action. Metadata is sensitive too. Preview the exact selection and destination, then authorize its digest:

```sh
factory export-captures --objective N --endpoint https://collector.example.com --content metadata
factory export-captures --objective N --endpoint https://collector.example.com --content metadata --send --authorize PREVIEW_DIGEST
```

Use an HTTPS base URL without credentials, query or fragment; Factory appends `/v1/traces`. HTTP is allowed only for loopback collectors. `metadata` reads no captured text; `retained` adds retained redacted content. Repeat `--run ID` and `--invocation ID` to intersect selections; unknown IDs or an empty selection are refused.

Headers come from `OTEL_EXPORTER_OTLP_TRACES_HEADERS`, falling back to `OTEL_EXPORTER_OTLP_HEADERS`, as comma-separated URL-encoded `key=value` pairs. Duplicate or malformed names/values are refused without echo; values are never printed. The preview digest binds selection, endpoint, payload and headers (values are hashed); changes require another preview, except header-name case alone.

Each send makes one request with a 30-second timeout, no redirects or retries and a 4 MiB response cap. Only a full acknowledgement succeeds; other outcomes exit nonzero and discard response text. Re-sends retain trace/span IDs, but collectors may duplicate records: inspect the destination before repeating a send.

## Propose Objectives

Draft from a tracked roadmap section (repeat `--source` for referenced ADRs/runbooks whose complete contents govern the proposal), review/edit the private JSON Objectives and their displayed citation presence (primary-wave sections and supporting context are separate; citations alone do not prove semantic completeness), then approve the exact file digest. Drafting creates no issues or work; without `--output`, its editable file stays under the private proposal state directory. Approval publishes ordinary issues and native dependencies; `--enqueue` additionally authorizes their batch intake. Keep the proposal/source/configuration binding unchanged. Changed sources need a new draft; unknown submitted GitHub mutations refuse replay and retain their evidence. Existing provider limits and independent Objective reviews still apply.

```sh
factory propose --source 'docs/waves/wave.md#Exact heading' --output /private/existing-dir/objectives.json --config /private/factory.json
sha256sum /private/existing-dir/objectives.json
factory propose --file /private/existing-dir/objectives.json --approve REVIEWED_SHA256 --enqueue --config /private/factory.json
```

## Learning and Dream

Learning episodes retain terminal Objective history privately and append-only. Collect an episode explicitly without a model call; nonterminal, unsettled or unknown work is refused. `dream` makes one bounded proposal pass through the configured provider, producing an editable private draft outside the target checkout. Its default active playbook budget is 16 KiB; later proposals retain the existing budget unless you specify `--budget-bytes N`. Dream does not approve its own proposal or start an Objective.

```sh
factory dream --record --objective N --config /private/factory.json
factory dream --config /private/factory.json
# Review/edit the printed draft path, then hash the exact bytes you reviewed
sha256sum /private/learning/proposals/ID.draft.json
factory dream --file /private/learning/proposals/ID.draft.json --approve REVIEWED_SHA256 --config /private/factory.json
# Or reject that exact draft
factory dream --file /private/learning/proposals/ID.draft.json --reject REVIEWED_SHA256 --config /private/factory.json
factory dream --show --config /private/factory.json
```

Use the actual path and next commands printed by Dream; drafts default to the repository's private state `learning/proposals/` directory. Review consolidated entries, source links, dated summaries and contradictions before approval. Merge or retire redundant guidance to fit the budget while preserving original episodes and sources. After editing, recompute the file digest; approval or rejection applies only to those exact bytes. `--show` reads the current approved playbook without a model call.

Only an approved compact version enters subsequent Objective planning and review inputs. Each Objective pins its version: later approval cannot change an active run. Learning is advisory, never command authority, permission or acceptance evidence, and it cannot override pinned Sources or limits. Episodes and drafts stay private locally and may be sent only to the already configured provider when Dream is authorized; review source-derived private text before sharing it.
