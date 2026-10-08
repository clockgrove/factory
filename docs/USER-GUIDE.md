# Factory user guide

Factory turns one Objective, a GitHub issue in your target repository, into reviewed pull requests: it plans, runs coding agents, validates, delivers and checks the integrated result. The target repository owns requirements and branch rules. Factory's configuration and state stay outside it.

Agents operate Factory through the `setup` and `director` skills, and the skills run the commands below. `factory help` lists every command and option of the installed version and is the authority if this guide differs. Install with the [README](../README.md#install). To change Factory itself, see [Contributing](https://github.com/clockgrove/factory/blob/main/CONTRIBUTING.md).

## Prerequisites

- Linux x64 (WSL2 works), Node.js 22 or later, Git 2.31 or later, an authenticated `gh`, and logins for the selected planning, review and worker providers. Defaults require a Codex login; Claude choices and other providers are in [local providers](#local-providers).
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

Structured planning and review calls time out after two minutes without observed provider events through `medium` reasoning, and five minutes for `high` and higher supported efforts. Native event streams may omit ongoing reasoning, so event inactivity does not establish provider inactivity. Observed active tools retain their fifteen-minute limit, and implementation workers keep their existing limits. Timeout reports identify model waiting versus an observed active tool, the last event and elapsed event inactivity; overall deadlines and retry allowances remain unchanged.

A timed-out Codex model invocation can retry twice, after its owned process group has stopped, with one- and two-second delays. Response and review-capacity retries share one allowance; a tighter explicit allowance still applies. Unproved cessation (including Claude SDK timeout cleanup), active-tool inactivity or exhausted response retries stops without automatic replay; retained faults identify the required decision or correction. Failed calls and available usage stay recorded; missing usage remains unknown.

Choose these at setup. Defaults: `gpt-6.1-sol` for planner, reviewer and worker, with `high` reasoning for planner and reviewer and `medium` for the worker.

Your agent host loads the skills; it does not select Factory's providers. These defaults also apply when you use the plugin in Claude Code. Select Claude planning and/or workers explicitly when that is the intended configuration. Check the [CLI and plugin identities](../README.md#cli) before setup; their releases can differ even when both are installed.

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

New pull requests lead with the published Work Item goal, link the Work Item and Objective, and list actual file changes and the candidate commit/tree. Passing commands come from controller receipts bound to that tree and the exact command definitions; missing or stale receipts remain unavailable. Both delivery modes use this description without another model call or publishing worker/reviewer logs.

If a PR creation response is lost, Factory retains the exact request before dispatch and stops repeated creation. A later run or retry can only look for a PR matching that request; an empty lookup remains unknown and cannot trigger another branch/LFS push or PR POST. A positive matching observation lets ordinary delivery continue while keeping the original response uncertainty. An unpublished run created before this publication contract cannot infer that nothing was sent and fails closed. Preserve its evidence; do not edit state or use diagnostics to reconstruct an outcome. The retained request history is limited to 64 entries per Work Item and is never cleared to permit another creation. This transport bound grants no extra repair, provider or spending attempts.

Remote execution (`execution.kind: "managed-agent"`) runs Work Items in a provider-hosted session. It is implemented, not yet qualified against live providers; see [managed execution](#managed-execution).

## Local providers

The harness executes Work Items; `--planning` selects the separate planner and reviewer. Codex is the default. Factory never falls back to another provider. Local logins must belong to the OS user running the controller; on WSL2, log in inside that distribution.

| Harness              | Setup requirements                                              | Login                                                | Worker network  |
| -------------------- | --------------------------------------------------------------- | ---------------------------------------------------- | --------------- |
| `codex-sdk`          | No extra flags                                                  | `codex login`                                        | `host` or `off` |
| `claude-agent-sdk`   | `--worker-model MODEL --claude-max-turns N`                     | `claude auth login`, or supported Claude credentials | `host`          |
| `github-copilot-sdk` | `--worker-model MODEL --copilot-timeout-seconds N`; Node 22.12+ | `copilot`, or supported Copilot credentials          | `host`          |

For example, add `--harness claude-agent-sdk --worker-model MODEL --claude-max-turns 12` to setup. Claude and Copilot SDKs are optional dependencies, outside the bundled Codex path. An offline install needs them in the npm cache and can finish without them; `--omit=optional` leaves Codex and registered adapters. Before selecting an optional provider, check its SDK in the same prefix with `npm list --offline --prefix /absolute/private/factory-prefix @anthropic-ai/claude-agent-sdk --depth=1` or the corresponding `@github/copilot-sdk` command. If absent, install the same verified Factory tarball in that prefix with network access and optional dependencies enabled, then recheck. Claude planning also requires `--planning-model` and `--review-model`. It supports the local Claude login, `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`, without settings files; Bedrock, Vertex and `apiKeyHelper` are unsupported. Factory stores no tokens in its configuration. A missing login stops the attempt; status names the login command and the retry command.

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

### OpenAI Agents API

This provider uses the [OpenAI Agents API](https://developers.openai.com/api/docs/guides/agents-api/quickstart) and an OpenAI-hosted sandbox. API billing is [separate from ChatGPT subscriptions](https://help.openai.com/en/articles/9039756-managing-billing-for-chatgpt-and-the-api-platform); a Codex login does not provide its application API key.

1. Sign in to [OpenAI Platform](https://platform.openai.com/), select the intended organization and project, and confirm that the project can use Agents API and the selected model. Set up [API billing](https://platform.openai.com/settings/organization/billing/overview) and record the account's actual resource and spending limits; credentials alone do not establish access or available credit.
2. In the project's **API Keys**, select **Create new secret key**. For a user-owned application key, choose restricted permissions with `api.agents.read`, `api.agents.write` and `api.responses.write`, as required by the [Agents quickstart](https://developers.openai.com/api/docs/guides/agents-api/quickstart). Save the displayed key in an owner-private file outside the target checkout; do not put it in Factory JSON, an issue, a prompt or chat. See [project/key management](https://help.openai.com/en/articles/9186755-managing-projects-in-the-api-platform) and [key permissions](https://help.openai.com/en/articles/8867743-assign-api-key-permissions).
3. Choose the model and container under those limits. The current quickstart uses `gpt-6-astra`; `medium` reasoning, a `small` container and a 600-second timeout are a starting configuration. Confirm model availability in the selected project. Factory creates a fresh hosted environment for each attempt; no saved OpenAI agent or environment ID is required.
4. Replace the installation's `execution` object with the following. `apiKeyEnv` names the controller variable holding the key; it is not the key itself. The key's Platform project supplies the account binding—Factory accepts no additional `projectId` or `organizationId` fields here.

```json
{
  "kind": "managed-agent",
  "provider": "openai-agents",
  "concurrency": 1,
  "config": {
    "model": "gpt-6-astra",
    "reasoningEffort": "medium",
    "containerSize": "small",
    "apiKeyEnv": "FACTORY_OPENAI_API_KEY",
    "timeoutSeconds": 600
  }
}
```

All five `execution.config` fields are required; `timeoutSeconds` must be a positive integer. Reasoning is `low|medium|high`; container size is `small|medium|large`. Input is limited to 5 MiB, output to 200 MiB. Extra turns, subagents, networking, extra tools, plugins and credentials are refused. Factory supplies the required `OpenAI-Beta: agents=v1` header.

For a foreground controller, load the private key file into `FACTORY_OPENAI_API_KEY` before running Factory. For a supervised controller, use `factory setup --background --config /absolute/config.json --credential-file FACTORY_OPENAI_API_KEY=/absolute/private/openai-key` after configuring and approving that installation; this starts the service. The file must be owned by the operator, have no group/other permissions (for example `0600`), and stay outside the checkout. The shared credential and readiness rules below apply.

Provisioning does not establish live qualification. The current adapter holds completion and cancellation while authenticated physical cleanup cannot be proved; a successful task or deleted API resource cannot release that hold. Resolve the supported cleanup proof and complete bounded public qualification before claiming this provider is ready for delivery.

### Anthropic Claude Managed Agents

This is the hosted [Claude Managed Agents API](https://platform.claude.com/docs/en/managed-agents/overview), using Factory's bundled `@anthropic-ai/sdk` 0.129.0 and beta `managed-agents-2026-04-01`. A Claude Pro/Max subscription or `claude auth login` does not authenticate or pay for it: [API billing is separate](https://support.claude.com/en/articles/9876003-i-have-a-paid-claude-subscription-pro-max-team-or-enterprise-plans-why-do-i-have-to-pay-separately-to-use-the-claude-api-and-console). Managed Agents access is currently enabled by default for API accounts; that does not establish your account's billing or capacity.

1. Sign in to the [Claude Console](https://platform.claude.com/), arrange [API billing](https://support.claude.com/en/articles/8977456-how-do-i-pay-for-my-claude-api-usage), and select the API workspace in [Settings → Workspaces](https://platform.claude.com/settings/workspaces). Record its ID and approved spend/rate limits. A workspace admin sets limits; a developer can use the API. The Limited Developer role cannot download files, which Factory needs for results. [Workspace roles and limits](https://platform.claude.com/docs/en/manage-claude/workspaces)
2. Open [Settings → API keys](https://platform.claude.com/settings/keys), click **Create key**, and scope it to that workspace. Use a personal key for your own controller or a service account key for a shared service. Store it outside the checkout using the controller credential instructions below. Copy the workspace ID from the Workspaces ID column into `workspaceId`; Factory requires it even with a workspace-scoped key. [Key creation and scoping](https://platform.claude.com/docs/en/manage-claude/authentication#create-and-use-a-key)
3. [Create a dedicated agent](https://platform.claude.com/docs/en/managed-agents/agent-setup) with your approved supported model. Disable the default `agent_toolset_20260401` toolset; enable only `bash`, `read`, `write`, `edit`, `glob` and `grep`, each with `always_allow` permission. `bash` is required. Use no MCP servers, skills or subagents. Save its ID, positive version and **complete resolved response**, including model defaults, as `agentId`, `agentVersion` and `agent`. A partial request or placeholder is not the resolved snapshot Factory compares with each session.
4. [Create a cloud environment](https://platform.claude.com/docs/en/managed-agents/environments) with the networking settings below. **Omit `packages` from the CREATE request**: specifying it requires package-manager networking, which Factory forbids. Retrieve the resulting environment; bind its ID as `environmentId` and its complete resolved `config` as `environment`. Its resolved empty package arrays are included below. Environments are not versioned; Factory refuses drift.

```json
{
  "type": "cloud",
  "networking": {
    "type": "limited",
    "allowed_hosts": [],
    "allow_mcp_servers": false,
    "allow_package_managers": false
  },
  "packages": {
    "type": "packages",
    "apt": [],
    "cargo": [],
    "gem": [],
    "go": [],
    "npm": [],
    "pip": []
  }
}
```

5. Set `execution.kind` to `managed-agent`, `execution.provider` to `claude-managed-agents` and an approved `execution.concurrency`. Put the fields above in `execution.config`, plus `credentialEnv: "FACTORY_ANTHROPIC_API_KEY"`. `timeoutSeconds` defaults to 900. Optional `budgetCents` is a positive whole-cent string; the in-flight request can finish past the threshold, so leave its margin inside your spending allowance. [Session budgets](https://platform.claude.com/docs/en/managed-agents/budgets)

Factory creates and exclusively owns its sessions; do not create one manually for it. It keeps the reusable agent/environment and deletes owned sessions and uploads after retaining evidence. Account/key/workspace setup and a credential-presence check are not live qualification. Record actual resource/spending limits before running; token totals and unknown usage do not prove compliance with a bill.

The named API key belongs in the foreground controller environment, never the config or model input. Local CLI logins do not supply it. For background operation, put only the key in an owner-private `0600` file outside the target checkout and pass `--credential-file NAME=/absolute/private/file`. This requires systemd `LoadCredential`; restart the service after rotation. A missing service credential stops execution without ambient fallback. Readiness checks presence without a provider call, so they do not establish account access, billing or hosted support.

The timeout bounds the entire attempt; cleanup gets a fresh window of the same length. Factory checkpoints calls, reconciles lost responses where possible and reattaches collection after transient failures. Nontransient failures require the old resource to stop before a fresh attempt or repair. OpenAI session deletion and an environment GET 404 establish only API disappearance: [physical cleanup can continue asynchronously](https://developers.openai.com/api/docs/guides/agents-api/sessions/manage#delete-a-session). Factory has no authenticated physical-cessation receipt for this hosted API, so it holds the attempt and any collected result with an unanswered cleanup question, including after restart. Never start replacement work beside an unresolved old resource.

`factory diagnostics` records `possible-orphan` resources with attempt ID and time. For Claude lost uploads, inspect and delete unreferenced uploads from that interval. For an OpenAI lost session creation, find sessions tagged `factory_attempt=<attempt ID>` and request deletion; API disappearance alone does not resolve physical cleanup or release Factory's ownership fence. Token counters are not a bill; absent counters stay unknown.

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

There is no plan-only CLI command. To inspect an Objective before authorizing execution, ask your agent to read the issue and committed Sources without running Factory. A planning review that needs a human stops; a clean review proceeds to execution without another approval step.

Running is the consent to execute that Objective. `run` plans if needed, saves the plan and its independent review, executes a clean plan, and exits:

| Exit | Meaning                                                   |
| ---- | --------------------------------------------------------- |
| 0    | The Objective completed; final validation passed.         |
| 2    | It needs you. The message names the decision and command. |
| 1    | It failed or was cancelled. The message says why.         |

Supply exact setup and probe commands, their required order and resources in the Objective’s authoritative sources. Factory selects only declared preimplementation prerequisites before a readiness probe; it does not run all acceptance checks as setup. Every fresh checkout prepares its own ignored runtime resources. A setup receipt or an earlier successful checkout does not prove readiness in the worker or final validator, and does not satisfy implementation acceptance. Unsupported worker-environment preparation stops for a source decision.

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

Observe further with `factory diagnostics --objective N` (the agent timeline; add `--follow` or `--logs ITEM`; `--summary` prints the efficiency report: wall time per stage, operator waits, attempts and tokens per role, and `--summary --json` the same for tools). A quiet timeline means no new provider event. It does not mean done, and missing usage is unknown, not zero. Diagnostics can hold private source, so keep them out of public issues. Timing and capture analysis are in [diagnostic capture and export](#diagnostic-capture-and-export). A successful latest attempt or final acceptance does not prove that earlier formal attempts succeeded. Prospective observer closure checks retained history continuity; prompt-cache availability and billing completeness remain separate facts. Historical logs without closure remain unknown.

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
# Request validation and review again on the same retained result. Accepts nothing.
factory retry --objective N --item ITEM --rereview

# Start a failed or cancelled Work Item's new attempt, or answer the stopped step that status names
factory retry --objective N [--item ITEM]

# Record a diagnosed correction for a failed Work Item
factory repair --objective N --proposal /abs/repair.json

# Submit a graph amendment, or a replacement for a rejected one
factory propose-amendment --objective N --proposal /abs/proposal.json
```

`retry --rereview` admits an unpublished pending result, or a retained failed-validation command capture whose candidate stayed clean and unchanged and whose owned work settled. Use it after diagnosing a validation-environment failure when the implementation needs no change. It preserves the exact commit/tree and implementation attempt, archives the original failure and receipts, and spends one existing Objective/per-path `resultRereviews` allowance for each admitted request. The subsequent `factory run` performs real validation and automatic review again; the request itself calls no model and supplies no passing evidence. Refused acceptance, terminal/accepted results, changed graph/configuration, uncertain resources, candidate mutations and selected-LFS captures without complete byte binding are refused. A repeated failure remains failed; the consumed allowance is not refunded.

An automatic implementation repair must be actionable now: every retained failed command is assessed, its concrete change stays within the Work Item’s ownership, and no unmet or unknown operator prerequisite remains. A conditional correction stops with a concrete question and starts no worker. Establish the operator condition before submitting `factory repair`; a proposal is your declared diagnosis and correction, not a controller receipt proving an external action happened. Command failures require their original failed-command capture. A semantic acceptance refusal after passing commands instead requires the explicitly retained rejected review or operator decision, exact candidate tree, separate passing command receipts and complete relevant owned candidate contents. Missing command evidence never establishes a semantic refusal. Both paths retain the original failure and use its existing bounded repair charge; neither accepts the result. Missing or truncated facts cannot establish readiness. A saved automatic correction without checked readiness remains historical evidence and needs an operator correction before admission.

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

New controller runs and planning previews retain an observer session ID, monotonic sequence and closure with write/loss counters. Formal step bodies, diagnostic spans and model calls have paired attempt identities; pending worker or CI polls are distinct from failures. Invalid answers, semantic review refusals and lost workers remain recorded when later work succeeds. The exported `summarizeFormalHistory(events, expected)` checks an independently authenticated session selection against exact repository, Objective, configuration and installed observer source digests. It reports unknown completeness for missing sessions, terminals or observations. The caller must also prove coverage of the actual required graph, deadlines and acceptance; a continuous log alone proves none of those, and does not prove complete billing. Historical logs without this prospective contract remain unknown.

Trusted local worker processes retain `XDG_STATE_HOME` so their capture writers use the same state root as the controller’s readers. The isolated native Codex environment does not inherit that variable or gain access to Factory state.

```sh
factory diagnostics --objective N --summary              # stage time, waits, attempts and tokens
factory diagnostics --objective N --summary --json
factory diagnostics --objective N --captures             # metadata only
factory diagnostics --objective N --captures --content RECORD_ID
factory diagnostics --objective N --analyze --group-by provider --group-by model
factory diagnostics --objective N --analyze --filter phase=implementation --json
factory diagnostics --objective N --analyze --filter runId=RUN_ID --gantt --output /abs/private/existing-dir/timeline.svg
```

Codex capture also reads a bounded history snapshot from the **owned private Codex home** before disposal. It selects the observed thread and authenticated descendants, checks private ownership and file identity, refuses symlink traversal, and shares the bounded snapshot budget described below. Planning reads after its existing native process settlement; successful workers read after the pinned SDK's natural EOF awaits native child exit. Early/failed SDK returns leave the new view unavailable. This is observational capture, not proof of outer worker-group cessation, a sealed daemon stream or complete requests. Capture failures do not affect execution or acceptance.

The native view retains [per-completed-response usage records](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/protocol/src/protocol.rs#L2264), deduplicated by exact thread/response identity. Conflicting response records are excluded from numerical subtotals and leave coverage partial; duplicate checkpoints and repeated `token_count` events are never added. Per-response subtotals are alternate views of parent invocation usage, with separate reconciliation against the latest response-record thread counter, `token_count` total and parent invocation counter, **never additional tokens**. Counter mismatches remain visible and partial; the observer does not select or repair a preferred origin. The count describes observed completed response records, not all requests, retries or missing usage responses. Optional Codex zero counters remain ambiguous. Child/inherited histories, incomplete records, bounds and changing snapshots leave coverage partial; child cost, endpoints, full provider wire and upstream optional-detail/billing coverage remain unavailable.

Native descendants are discovered from persisted parent-bound `item_completed` records. V1 `CollabAgentToolCall` records identify receivers and child-specific `agents_states`. V2 `SubAgentActivity` started records must match an observed `spawn_agent` call before selecting the child; a completed activity reports completion only for that authenticated child. Started activity, unmatched or missing records and generic completed spawn/wait tools do not prove child completion or resource cessation. Unmatched activity leaves coverage partial. Child history must authenticate both the header parent and subagent source against that edge. The pinned Codex 0.160.0 Paginated writer distinguishes fresh child history from inherited forks: copied context requires its literal ordinal boundary, while missing or unsupported provenance stays partial. Exact child-thread/session response usage can remain available when context provenance is missing. Parent and child counters stay separate; whether parent totals include children and their accounting union remain unknown. Selection shares an 8 MiB/4,094-event budget, at most 128 directory entries, 16 descendants and four descendant levels; missing or bounded-out child history is unavailable.

Native visible-byte metadata separates base instruction text, messages by their **reported** role, tool calls/output and compaction/replacement history. Base instructions do not prove a wire system-role assignment. Replacement history is a context snapshot, not new authored text or additional tool output. Byte counts and exact content digests expose volume/repetition without claiming a tokenizer, hidden instructions, per-request context replay or billed role-token attribution. Raw selected content stays under the existing private capture policy, redaction and per-invocation byte budget. Author-owned request metadata reports exact rendered prompt, schema and supplied evidence bytes; these components can overlap, and finer role/preamble/task splits remain unclassified when the producer does not supply them. This instrumentation does not change rendered prompts, settings or model behavior.

Summary stage times count overlapping intervals once; operator waits and time outside a stage appear separately. Analysis reads metadata without captured text or provider calls. Grouping defaults to phase; repeat `--group-by` for combined fields. Filters match exactly (`reportedModel=null` selects missing reported models); unknown fields list allowed choices. Diagnosis uses phase `diagnosis`, graph compilation `compile`. Partial totals are marked; cached/reasoning counters are subsets, and concurrent elapsed times must not be summed. Gantt blue bars are model invocations, amber bars controller operations; validation labels are command indices.

`nativeToolActivity` reports parent model-visible native function/custom tool calls by invocation, phase, Work Item and tool name. The existing `native.tools` and aggregate `nativeTools` summaries project the same facts. Authenticated descendant scopes keep their own `native.descendants.children[].tools` summaries; their accounting union with parents remains unknown. Exact call IDs join calls to observed outputs and deduplicate repeated native observations. SDK shell/file-change callbacks are alternate observations and are excluded; compaction replacement calls are snapshots and are excluded too. A native `exec` call may run several nested commands or checks: one model-visible call is not one process. Missing identities, conflicting observations, inherited/child history and incomplete capture leave coverage partial or unavailable. `callRounds` groups calls using observed completed-response usage boundaries; it does not count every upstream request or retry. Zero calls require an explicit current-producer `toolMetadata: "available"` marker, complete retained native history and no call records; legacy missing metadata or absent identities stay unavailable.

The existing `native.tools` and per-name `byName` fields retain `observedOutputs`, `reportedFailures`, `missingOutputs`, `observedRounds` and `observedDurationMs`. Their `observedRounds` counts distinct recorded session/turn identities (`roundMethod: "native-turn-identities"`); `observedResponseBoundaryRounds` adds the separately labelled response-boundary count. `observedDurationMs` stays unavailable unless every selected call has a valid timing pair; the additive `sumObservedIntervalsMs` and `durationCoverage` describe partial timing evidence.

Call-to-output timings use explicitly recorded native timestamps, never the later capture-write timestamp. They cover call creation through observed output, including transport and harness work, and can overlap. Missing or reversed timestamps remain unavailable. An observed output establishes returned transport, not success of each nested command. Explicit native failure/status fields are reported separately; absence of a failure field proves no success. Repeated-read, repeated-validation and nested command/process counts stay unavailable unless the producer supplies those structured facts. Analysis does not guess them from shell text, tool names or error strings.

New capture metadata retains only sanitized native call IDs, names, status and timestamps. Arguments, paths, output and error text stay under the existing private-content policy and budget. For older captures, explicitly opt in to reading only complete, unredacted, digest-authenticated retained native tool payloads:

```sh
factory diagnostics --objective N --analyze --filter phase=implementation --native-tool-content --json
```

API callers use `analyzeInteractions(records, observations, { includeNativeToolContent: true })`. Filters apply before these reads. The option extracts the same sanitized facts and returns no raw payloads; truncated, redacted, missing or digest-mismatched content stays unavailable. Default analysis and scorecards remain metadata-only; scorecard `nativeTelemetry` includes the same tool summary for Factory invocations and selected raw Codex native captures. This read does not call providers, change model inputs or execution, or authorize external export.

For a delivery batch or an early Codex comparison, use `factory diagnostics --scorecard /abs/private/selection.json --json`, optionally with `--output /abs/private/existing-dir/scorecard.json`. This reads retained observations without provider calls or lifecycle changes. The selection is reporting input, outside the target, with a finite window and explicit packets; it is not another execution ledger. For example:

```json
{
  "schemaVersion": 1,
  "window": {
    "startedAt": "2026-10-07T00:00:00Z",
    "endedAt": "2026-10-08T00:00:00Z"
  },
  "packets": [
    {
      "id": "packet-1",
      "task": "Pinned task identity",
      "route": "factory",
      "scope": "adopter",
      "factoryObjectives": [10, 12],
      "bindings": {
        "sourceDigest": "SHA256_OF_PINNED_TASK_INPUTS",
        "baseCommit": "EXACT_BASE_COMMIT",
        "acceptanceReference": "LOCAL_ACCEPTANCE_RECEIPT",
        "environmentReference": "LOCAL_TOOLS_NETWORK_HOST_ASSESSMENT"
      },
      "acceptance": { "outcome": "unfinished" }
    }
  ]
}
```

Group every failed/cancelled predecessor and its replacement into the same packet; list separate failed and unfinished tasks as their own packets. Select whole observations inside the window. Accepted Factory outcomes, run/config/base/result identities and acceptance time come from the continuation snapshot; the selection cannot override them. Capture metadata supplies historical Factory/adapter versions, provider/model/reasoning and source/prompt identities. Missing historical bindings remain unavailable; the current installation does not fill them in.

For the direct route, set `route` to `codex-direct` and replace `factoryObjectives` with `codexSessions`. Each entry selects a new private `0600` newline-terminated output file from the [normal `codex exec --json` workflow](https://developers.openai.com/codex/noninteractive), with `path`, matching `sessionId` from `thread.started`, `freshThread: true`, `freshThreadReference`, externally observed `startedAt`, `endedAt`, `outcome` (`completed`, `failed`, `cancelled`, `unfinished`), `role` (`setup`, `authoring`, `implementation`, `review`, `recovery`), `cliVersion`, `provider`, `model`, `reasoningEffort` and `configDigest`. Select an unmodified native CLI stream from one fresh-thread invocation per file; postprocessed SDK streams can synthesize counters and are not direct-route evidence. Verify a fresh `codex exec` launch without `resume` using retained launch arguments/receipts, and cite them in `freshThreadReference`. `thread.started` alone does not prove freshness; this attestation is external evidence for independent assessment, not a parser-authenticated fact. Missing/false freshness, resumed/unknown starting counters and duplicate selected thread IDs are refused. The [pinned native producer](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/exec/src/event_processor_with_jsonl_output.rs) emits **thread-cumulative** `turn.completed.usage` counters, not turn deltas: only the latest completed snapshot contributes once. Missing categories in that latest snapshot stay unavailable; a prior snapshot cannot fill them in. The pinned native CLI also emits all-zero default usage when no accounting arrived, so wholly zero snapshots stay unavailable. Native and SDK aggregation lose [upstream optional-detail presence](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/codex-api/src/sse/responses.rs) and default missing cached-input, cache-write and reasoning counters to zero; those ambiguous zeros stay unavailable even alongside positive input/output. Positive counters remain reported native measurements, without proving complete upstream category presence or billing coverage. A later failed/open turn or unfinished/cancelled stream leaves retained known counters partial. A native-completed but substantively failed task retains its actual reported usage. Private session-history files and alternate usage payloads are not parsed. Receipt digests hash canonical complete JSON records, without retaining raw messages in the report; direct captures with unterminated final records are refused.

Direct acceptance requires an external substantive assessment, `acceptance.at`, and exact `bindings.resultCommit` and `bindings.resultTree`. References identify receipts for independent assessment; their presence alone does not prove quality. Factory packets can also select direct captures for setup, authoring, review or recovery overhead outside Objective execution. Keep Factory-development work separate with `scope: "factory-development"`. Do not omit failed sessions or surrounding harness/human work to improve a result.

Optional packet `workflow: {"startedAt": "ISO_TIMESTAMP", "endedAt": "ISO_TIMESTAMP"}` records externally observed bounds for the whole process, including human setup, authoring, assessment and recovery that have no Codex capture. Bounds must lie inside the selection window and contain all selected receipts and acceptance. Only these bounds produce total `wallMs` and `timeToAcceptedMs`; without them both stay null, including paired total-time deltas. `capturedStartedAt`, `capturedEndedAt` and `capturedWallMs` preserve the receipt envelope separately. The operator must substantiate the external timings; the parser cannot prove that no work occurred outside them. Do not fabricate a Codex setup session to account for human work.

A direct session may additionally select `nativeCapturePath`: a private `0600`, newline-terminated metadata file from `CaptureWriter` using the same fresh native thread/configuration and `home.nativeCapture(threadId, callback)` after the launcher’s existing subprocess settlement and before `home.dispose()`. Emit this analysis input outside Factory diagnostics/progress so it does not enter Factory accounting. Selection bounds this metadata to 8 MiB/8,192 records and validates schema, exact thread, response identities and configuration. `nativeTelemetry` exposes that alternate response/history view; the original CLI receipt remains the sole direct parent-token source. Missing native selection stays null, and optional native observations do not make absent parent usage available.

Optional packet `observations` record externally measured `operatorEffortMs`, `interventions`, `scopeRedirections`, `outOfScopeChanges`, `rework` and `postDeliveryCorrections`; correction counts also require `postDeliveryWindowEndedAt`. Absent measurements are null, including operator attention: elapsed operator waits do not measure attention. JSON includes per-Objective stage times, worker attempts/repairs, model calls by phase, repeated exact prompt digests, cache components, category completeness and batch known tokens per accepted packet including selected failed work. Cached input and reasoning output are subset counters, never extra tokens or invented subscription/dollar costs. Historical Codex SDK cache-write zeros may have been synthesized; they do not prove provider-reported zero usage. Batch packet wall/wait sums are named as sums and can overlap during parallel work; use the separate window elapsed time for throughput.

`cacheEffectiveness` reports weighted input-cache hit rate, matched reported input/cached counts and `reportedInputMinusCachedTokens`, contributing versus eligible invocations, unobserved worker attempts and availability for each packet and route batch. `cacheByRole` separates workers, planning/review models and selected direct-session roles; each Factory Objective also exposes `cacheByPhase`. The rate is the sum of cached input divided by the sum of input **from the same invocation snapshots**, rather than an average of invocation percentages or a ratio of independently incomplete totals. Partial results describe only the matched subset. Availability measures selected outer invocation-receipt coverage; `upstreamCategoryAndBillingCoverage` remains unknown. The input-minus-cache residual is at most an upper bound within reported input, not proof of actual uncached work or an all-in bound when whole usage responses are missing. Missing counters and ambiguous Codex optional zeros stay unavailable; authentic zeros from other adapters remain zero, and zero observed input leaves the rate undefined. Historical Codex summaries use retained provider/adapter identity, including matching capture metadata when old worker records omitted it; original receipts remain unchanged.

Cache counters validate observed reuse, while repeated prompt digests show only identical rendered prompts. The [provider caching contract](https://developers.openai.com/api/docs/guides/prompt-caching) depends on identical prefixes, including request content not necessarily exposed by the harness. Neither a repeated prefix nor a high cache hit rate attributes individual hits to Factory prompt layout or establishes billed savings. Cached input remains a subset of input; apply current provider/model/account rates separately if actually available. Subscription consumption and uncaptured caller/coordinator cost remain unknown.

Before calls, precommit equivalent scope, pinned inputs, acceptance/quality checks, models/effort, tools/network/resources, separate workspaces, order/carryover controls, finite attempts/deadline and a practical improvement criterion. Put its reference in optional `comparison.planReference`, alongside `practicalImprovementCriterion` and `limitations`. Give the two packets the same `pairId`, task/source/base and independently assessed `environmentReference`. Matched accepted packets produce per-metric absolute/percentage deltas; incomplete token or attention dimensions remain null. Unmatched batches stay observational. The report does not decide superiority or validate referenced assessments: apply the declared criterion to independently checked evidence and report gain, loss or inconclusive with sample size and limitations.

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
