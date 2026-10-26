# Setup and migration

Part of [the design](../DESIGN.md).

## Setup

`factory setup --repo OWNER/NAME [options]` writes the configuration file (mode 0600) and checks it the same way the service does. Then it checks the target: the checkout exists and its origin names the repository, and the queue's Project has the `queue.field` single-select field with every option, plus the `queue.orderField` number field. Factory never creates either field.

- **Create:** give `--checkout PATH` and `--project-id PVT_...`. Every other key has a default.
- **Repeat:** the same command changes nothing and reports `changed: []`. Without a service mode, setup is `--config-only` (accepted, not required).
- **Bindings:** `--checkout`, `--project-id`, `--field` and `--order-field` never change an existing value, defaults included. A different value is refused, because it would move running Objectives to another target. Edit the file by hand when nothing runs.
- **Refusal:** a value the configuration refuses leaves the file as it was. The report names every problem.
- **Report:** `--json` prints `{status, config, created, changed, defaultProvider, problems, readiness}`. `status` is `configured` (exit 0), `blocked` (the file is saved but the target isn't ready, or a readiness check is blocked; exit 1) or `refused` (nothing saved; exit 1).

**Readiness** (readiness.ts) is one checklist, made with no model call and no change to the target or its settings (the Codex probe writes only its own temporary directories). Each check is `ok`, `warn` (it runs, but see the detail) or `blocked` (the service would hold on it), and every check that isn't `ok` names its fix.

- **Host:**
  - bubblewrap starts a sandbox, and with `package-install`, pasta is there; with `host`, the detail says what commands reach;
  - `sandbox.environment` paths are covered, and `sandbox.packageStore` is a directory;
  - with `sandbox.network` `off` and commands sandboxed, a checkout with a bootstrap's lockfile (`pnpm-lock.yaml` or `package-lock.json`) has a `sandbox.packageStore` that isn't empty; otherwise it is `warn`, because validation's dependency install runs offline and the Objective holds on it;
  - git, git lfs, node and each final command's program are on the PATH;
  - node satisfies the checkout's Node pin, the first exact version or semver range in `.nvmrc`, `.node-version`, `.tool-versions` or `package.json` `engines.node` (an alias such as `lts/*` is passed over); a mismatch is `warn`, because the Objective check holds on it;
  - a final command that needs the network is flagged.
- **Providers:** each planner's and worker's SDK is installed and its login is present. Codex and Copilot logins are checked by presence. Claude's is the login the Claude SDK resolves, asked of it once per setup with no model call and a 30-second bound. A keychain, token, profile or cloud-provider login counts. An expired login whose refresh the server rejects is `blocked`, but one whose refresh fails for network reasons still reads `ok`. No answer is `warn`. Like any Claude client, the probe may refresh the operator's login and update `~/.claude.json`. A credential the background service loads at start counts by name, and one it can't read is `blocked` with the file to restore. Copilot's tokens and keys may be service credentials too (`--credential-file`), and its endpoint settings carry over from the setup shell. Account access is first known at the first call. A Codex worker's sandbox is tried under the worker's own permission profile, with `codex sandbox` and no model: a command must write its worktree, be refused outside it, and read the first `sandbox.readOnlyPaths` entry.
- **Repository:**
  - the GitHub CLI login can read the repository and push to it;
  - Actions access is not checked: a fine-grained token needs Actions: read for failed checks' job logs and Actions: write to rerun a failed job once before a repair (see [Delivery](delivery.md#delivery)); a `gh` login's `repo` scope covers both;
  - PRs into the default branch may merge with a merge commit;
  - required status checks exist. None is a warning: a PR then merges once Factory's own validation passes and any checks that register on it pass.
  - no ruleset or classic protection requires an approving review (`warn`: every Factory PR waits for someone else to approve it). A bypass for the login doesn't help: GitHub still reports the PR `BLOCKED` with `REVIEW_REQUIRED` to that login, so delivery waits all the same. Classic protection counts only when the login may read it. The fix is no required reviews.
  - no ruleset or classic protection requires review threads to be resolved (`warn`: a Factory PR with an unresolved review thread holds with a question naming it until someone resolves it; see [Waits](steps.md#waits)). Classic protection counts only when the login may read it. The fix is resolving review threads on Factory PRs, or no required thread resolution.
- **Branch protection:** setup recommends "require branches to be up to date", and Factory never changes repository settings.
- **Validation environment:** `readiness.validationEnvironment` says how validation differs from hosted CI: the network, the sandbox, the bootstrap install, `sandbox.environment`'s names, the final and CI-only commands, and the package scripts that need a network validation lacks.

Installation options, each setting one key:

| Option                                                                                         | Key                                                        |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `--poll-seconds`, `--max-active`                                                               | `queue.pollSeconds`, `queue.maxActiveObjectives`           |
| `--concurrency`, `--workers`, `--validations`, `--planners`, `--memory-mib`                    | `execution.*` (`memoryMiB`)                                |
| `--worker-mib`, `--validation-mib`, `--planner-mib`                                            | `execution.reservations.*`                                 |
| `--planning-revisions`, `--implementation-repairs`, `--per-path-repairs`, `--result-rereviews` | `autonomy.allowances.*`                                    |
| `--objective-tokens`, `--objective-cents`, `--day-tokens`, `--day-cents`                       | `autonomy.spend.perObjective.*`, `autonomy.spend.perDay.*` |
| `--required-env NAME`...                                                                       | `autonomy.requiredEnvironment`                             |
| `--delivery regular\|native-stack`                                                             | `delivery.kind`                                            |
| `--sandbox-network off\|package-install\|host`, `--package-store DIR`                          | `sandbox.network`, `sandbox.packageStore`                  |
| `--read-only-path DIR`..., `--sandbox-env NAME=VALUE`...                                       | `sandbox.readOnlyPaths`, `sandbox.environment`             |
| `--required-command CMD`..., `--ci-only-command CMD`...                                        | `finalValidation.*`                                        |
| `--allowed-secret NAME`...                                                                     | `policy.allowedSecretNames`                                |

An option marked `...` repeats, and the values given replace the whole list.

Provider options need `--provider NAME`. They add the provider or change it:

- `--planner codex|claude|copilot` and `--worker codex|claude|copilot`. Changing a kind drops that kind's settings.
- `--default`. The first provider is the default until `--default` moves it.
- Model choices: `--planner-model`, `--planner-effort`, `--reviewer-model` and `--reviewer-effort`. One given alone keeps the other half of the choice in effect, or the planner kind's default.
- Codex worker settings: `--codex-network`, `--codex-model`, `--codex-effort` and `--codex-service-tier`.
- Claude worker settings: `--claude-model`, `--claude-effort`, `--claude-max-turns`, `--claude-tools`, `--claude-allowed-tools`, `--claude-permission-mode` and `--claude-setting-sources`.
- Copilot worker settings: `--copilot-model`, `--copilot-effort`, `--copilot-tools` and `--copilot-timeout-seconds` (`worker.idleSeconds`, how long a turn may be silent).

Tool and source lists are comma-separated. A worker option for another worker kind is refused. Managed workers, `sandbox.required: false` (see [Security](security.md#security)), `reviewArtifacts` (see [Review artifacts](capabilities.md#review-artifacts)) and `media.localAssetRoots` are written by hand.

`planning.context` is written by hand too, and every key is optional. It sets what every Objective's planning context, repository memory and planner lookups may read:

- `selectors`: 1–64 literal repository files or directory prefixes ending in `/`. Absent: all tracked paths.
- `memory`: `true` by default. `false` turns repository memory off in every role, and the planner's memory lookups with it; the planning context and the other lookups stay.
- `bounds`: `maxRounds` (4), `maxRequestsPerRound` (8), `maxResults` (64), `maxBytes` (262144), `maxElapsedMs` (30000) and `maxProviderCalls` (5).

### Background service

The service runs as a systemd user unit (systemd.ts), one per installation. Each mode takes `--repo` and `--json`.

- **`--background`:** setup as above, checked as the service will run (setup.ts `setup`): its readiness counts the credentials the unit will load and leaves out the logins the unit doesn't keep from the setup shell (systemd.ts `unkeptLogins`): `CODEX_API_KEY`, `OPENAI_API_KEY`, `FACTORY_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN` and the credential names below. So the service's Codex login is `codex login`'s auth.json and its GitHub login is the one `gh auth login` stored. Only once its status is `configured` does it write the unit and enable and start it, then wait up to 30 s for the service to take its lock.
  - The unit runs this Factory's `node cli.js serve --repo`. It carries the setup shell's PATH, HOME, `FACTORY_CONFIG`, `FACTORY_STATE_DIR`, login locations, Copilot endpoint settings (`COPILOT_API_URL`, `COPILOT_PROVIDER_BASE_URL`, `COPILOT_PROVIDER_TYPE`) and proxies.
  - It restarts on failure, except on exit 2 (usage) and 78 (a configuration that doesn't load).
  - `KillMode=mixed`: the service stops at its next tick, and then its children are killed.
  - Repeated with nothing changed, it leaves the running service alone. The service reads its configuration and credentials once, so it restarts when the unit changed (an upgrade, or a changed environment or credential list), when setup changed the configuration, or when `--credential-file` is given.
  - A service that exits or restarts before taking its lock blocks `--background` and names the journal.
- **`--credential-file NAME=FILE`...** (with `--background`): each is a LoadCredential. NAME is one Factory reads from the service's credentials: `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, with Copilot configured `COPILOT_GITHUB_TOKEN`, `GITHUB_COPILOT_API_TOKEN`, `COPILOT_PROVIDER_API_KEY` or `COPILOT_PROVIDER_BEARER_TOKEN`, or a managed worker's credential variable. FILE is an absolute path to a regular file, not a link, that only its owner can read, in a directory no one else can write. Setup never reads it, and readiness counts it as present. Without the option, the unit keeps its credentials, which are checked again.
- **`--check`:** the unit's enabled and active state, whether the service holds its lock, the credential names, and whether the unit is current: the unit setup would write with the node and environment the unit records, so a checking shell whose PATH or node differs from the service's doesn't count. A unit for another Factory (an upgrade), or whose node is gone (`missingNode`), is a warning. Exit 0 only when it is running.
- **`--stop`:** stop the service and disable it, so it doesn't start at the next login. `--background` starts it again.
- **`--uninstall`:** stop the service and remove its unit. The configuration and state stay.

Setup never touches a unit it didn't write: its first line is Factory's marker. A `factory serve` that's already running outside the unit blocks `--background`. Lingering off is a warning, because the service then stops at logout.

**An unconfigured serve is visible.** Without a configuration file, serve applies requests only:

- it logs `unconfigured`;
- it prints the path;
- `status` shows the problem.

A configuration that doesn't load prints its problems without a stack trace and exits 78.

## Migration

From an earlier version of Factory to this one: start clean, with no compatibility layer and no importer. The configuration is about 40 lines, and the setup options cover it.

1. **Stop the old service** (`systemctl --user disable --now <old unit>`). Close or cancel the Objectives it was running.
2. **Delete the old state and configuration**, after copying anything you still need from the old configuration by hand (paths such as `sandbox.readOnlyPaths`). An unknown key is refused by name, so a copied old configuration won't load.
3. **Install this release** (README#Install). `factory help` lists every command.
4. **Prepare the target:**
   - a clone that only Factory uses;
   - the Project fields `Factory` (single select, with the six options) and `Factory order` (number);
   - removal of the old control card and metadata field, which nothing reads now.
5. **Set up** (see [Setup](#setup)):
   - `factory setup --repo OWNER/NAME --checkout … --project-id …` with your limits, delivery, sandbox and final commands, until it reports `configured`;
   - `--provider NAME …` for each provider;
   - optionally, turn on "require branches to be up to date" as readiness recommends.
6. **Start the service** with `factory setup --repo OWNER/NAME --background`, then queue one small Objective as a canary. It passes when its PRs merge with no duplicate PR, comment or merge, every hold had an answer that worked, and the issue closes with its report.
7. **Queue the rest.**

Rollback: `factory setup --uninstall`, then reinstall the old release and set it up from scratch: its state was deleted, so there is none to carry back.
