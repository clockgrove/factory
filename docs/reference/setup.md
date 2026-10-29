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
  - the setup skill's `factory` launcher, on the PATH or at `~/.local/share/clockgrove-factory/bin` (under `XDG_DATA_HOME` when set), still links to an installed release; one whose release directory was deleted is `warn`, fixed by running the plugin's setup again, with the installer's `--prefix` for a launcher in one (worktree.ts `danglingLauncher`; workers never get it either way);
  - with mise managing the checkout (see [Toolchain from mise](#toolchain-from-mise)), `mise toolchain` says which tools came from mise and from which file. A configuration mise doesn't trust is `warn` with `mise trust FILE` as its fix, and a pinned tool that isn't installed is `warn` with `mise install` in the checkout. mise's shims directory on the PATH is `warn` too;
  - node satisfies the checkout's Node pin, the first exact version or semver range in `.nvmrc`, `.node-version`, `.tool-versions` or `package.json` `engines.node` (an alias such as `lts/*` is passed over); a mismatch is `warn`, because the Objective check holds on it. With mise managing the checkout, its fix (and the Objective check's) is `mise install` in the checkout, then `factory setup --background`;
  - a final command that needs the network is flagged.
- **Providers:** each planner's and worker's SDK is installed and its login is present. Codex and Copilot logins are checked by presence. Claude's is the login the Claude SDK resolves, asked of it once per setup with no model call and a 30-second bound. A keychain, token, profile or cloud-provider login counts. An expired login whose refresh the server rejects is `blocked`, but one whose refresh fails for network reasons still reads `ok`. No answer is `warn`. Like any Claude client, the probe may refresh the operator's login and update `~/.claude.json`. A credential the background service loads at start counts by name, and one it can't read is `blocked` with the file to restore. Copilot's tokens and keys may be service credentials too (`--credential-file`), and its endpoint settings carry over from the setup shell. Account access is first known at the first call. A Codex worker's sandbox is tried under the worker's own permission profile, with `codex sandbox` and no model: a command must write its worktree, be refused outside it, and read the first `sandbox.readOnlyPaths` entry.
- **Repository:**
  - Factory's identity (see [GitHub identity](#github-identity)): with neither `github.app` nor `github.login`, the `GitHub App` check is `blocked`, naming the preflight step, its registration link and the opt-out, and no other repository check runs;
  - with a GitHub App: its private key is there, its installation covers the repository and isn't suspended, a token can be minted, and the installation grants every permission Factory needs, each missing one named (Actions: write among them; the organization's Projects only for an organization's repository). An origin that isn't https is a warning: its pushes use the host's SSH login, not the App's;
  - Factory's login (the GitHub CLI's, or the App's) can read the repository and push to it;
  - a login's Actions access is not checked: a fine-grained token needs Actions: read for failed checks' job logs, failed steps and artifacts, and to wait on a workflow run under way for a required check it has yet to create (without it, such a check is asked about 15 min after the push; see [Waits](steps.md#waits)), and Actions: write to rerun a failed job once before a repair and to run `delivery.baseRerun`'s workflow (see [Delivery](delivery.md#delivery)); a `gh` login's `repo` scope covers both;
  - with `delivery.baseRerun` set, the `base rerun` check reads the default branch's workflows at its head (fetched into the checkout). It is `ok` when the named workflow runs on `workflow_dispatch` with no required input and nothing that runs after it would run for a dispatched run, and names the checks it reports. It is `warn` when GitHub would refuse to dispatch it (no such file, unparsable, no `workflow_dispatch`, an input it requires with no default), so failed checks are compared with the default branch's pass however old; and `warn` when another workflow runs after it (`on: workflow_run` naming it), because every run Factory dispatches starts that one too, unless every job of it is certainly skipped for such a run. GitHub starts a workflow that runs after such a follower for every completed run of it too, even one whose every job was skipped, so readiness reads those in turn, the same way, and warns of any that would run. Readiness reads each job's `if` knowing only that `github.event_name` is `workflow_run` and `github.event.workflow_run.event` is `workflow_dispatch` (for a follower of a follower, `workflow_run`) (planning/dispatch-guard.ts `skipsDispatchedRuns`): a job is skipped when its `if` is then false whatever else holds, or when it needs a skipped job and its `if` calls no status function (`always()`, `success()`, `failure()`, `cancelled()`). An `if` it can't read counts as running. Clockgrove's "Guarded release", which follows Quality, releases only from a push (its first job's `if` requires `github.event.workflow_run.event == 'push'`, and the others need it), so it is named in the `ok` detail as skipping a dispatched run. For a follower that would run: give each job such an `if` (or a `needs` on such a job), name a workflow nothing runs after, or remove the setting. Without the setting there is no such check: Factory runs nothing on the default branch;
  - operators (`operators`): none is a warning, since holds then notify nobody, and so is Factory's own login among them, since GitHub doesn't notify an account of its own comments; that fix gives the App registration link;
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
| `--base-rerun-workflow FILE`                                                                   | `delivery.baseRerun.workflow`                              |
| `--sandbox-network off\|package-install\|host`, `--package-store DIR`                          | `sandbox.network`, `sandbox.packageStore`                  |
| `--read-only-path DIR`..., `--sandbox-env NAME=VALUE`...                                       | `sandbox.readOnlyPaths`, `sandbox.environment`             |
| `--format-command CMD`                                                                         | `validation.formatCommand`                                 |
| `--required-command CMD`..., `--ci-only-command CMD`...                                        | `finalValidation.*`                                        |
| `--allowed-secret NAME`...                                                                     | `policy.allowedSecretNames`                                |
| `--github-app-id ID`, `--github-app-installation ID`                                           | `github.app.id`, `github.app.installationId`               |
| `--github-login`                                                                               | `github.login`                                             |
| `--operator LOGIN`...                                                                          | `operators`                                                |

An option marked `...` repeats, and the values given replace the whole list. `--github-app-key PATH` sets no key: see [GitHub identity](#github-identity).

`--format-command CMD` names the repository's formatter, such as `pnpm exec biome check --write .` (off by default: nothing is formatted). Factory runs it on every Work Item's result before validation and commits what it changes, so no model formats by hand (see [Steps](steps.md)). Name the tool itself rather than a package script: a script is read from the result, so the worker could change what it runs. It is frozen with each Objective: a change holds a running one once, as any frozen key does (see [Frozen configuration](state.md#frozen-configuration)).

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

### GitHub identity

Factory acts on GitHub as its own GitHub App (github-app.ts), `github.app.id`. Registering and installing it is setup's required preflight step, before a repository is configured: register, generate the key, install, then set up with the App. As an App, Factory is `<slug>[bot]`, its holds notify the operators it mentions, on the web, by email and in GitHub's mobile app, where a `/factory` comment answers them, and its installation tokens last an hour and carry only the permissions below. The GitHub CLI's login is still needed on the host for the operator's own commands and setup's; Factory acts as the App.

The opt-out is the GitHub CLI's login (or `FACTORY_GITHUB_TOKEN`): `--github-login` records it as `github.login: true`. GitHub doesn't notify an account of its own comments, so while Factory acts as your account its holds reach you only on the Project, and readiness warns of it. A configuration takes one of the two: one with both doesn't load, `--github-login` drops `github.app`, a `--github-app-id` drops `github.login`, and `--github-login` with any App option is a usage error. Recording the opt-out removes the App's key copy from the installation's state, unread (`changed` names `FACTORY_GITHUB_APP_KEY`); while the background unit loads that copy, `--background` removes it once it has rewritten the unit without it. With neither, as a configuration from 0.5.1 or earlier, it loads, but nothing acts as the login no one chose until the configuration names one:

- readiness's `GitHub App` check is `blocked` (and the other repository checks aren't read) with this preflight step and the opt-out as its fix, so setup reports `blocked` and `--background` starts nothing;
- `factory serve`, in a terminal or as the background unit (an earlier release's, restarted after an upgrade, included), refuses to start with exit 78, as for a configuration that doesn't load, so the unit doesn't restart, naming the preflight step: register the App (`factory setup --repo OWNER/NAME --github-app-link`), then `factory setup --repo OWNER/NAME --github-app-id N --github-app-key PATH --operator LOGIN`, or opt out with `factory setup --repo OWNER/NAME --github-login`;
- `factory status` shows the same as `Not ready`, and in `--json` as `setup.identity`.

- **Register.** `factory setup --repo OWNER/NAME --github-app-link` (with `--json` only; it needs no configuration) prints the link that registers a private App for the repository's owner, an organization's settings or your own, with no webhook and the permissions Factory needs prefilled (GitHub's registration URL parameters): Contents, Issues, Pull requests, Workflows and Actions write (Actions to rerun a flaky run's failed jobs); Checks, Metadata and Commit statuses read; and the organization's Projects write, for the queue. It asks for no Administration access, so it can't read classic branch protection: readiness then sees only rulesets for required reviews, review threads and linear history, and may call whether a branch must be up to date unknown; a PR a classic rule blocks on unresolved review threads waits like any blocked PR instead of holding at once with them named. The service reads classic protection until GitHub first refuses it (403, for the App or a login without admin), logs that once (`branch-protection-unreadable`, see [Run log](run-log.md#run-log)) and reads it no more until it restarts: each later read takes its fallback at once (required checks from rulesets and the branch read, which shows them; the other classic rules unseen), instead of a refused request on every CI poll (#2174; Clockgrove #800 made 113). Create the App, generate a private key on its page and install it: on an organization, on All repositories; at the least, on the repository and on every other repository of the queue's Project. Its token reaches only the repositories it is installed on, so the [one installation per Project](process.md#process-model) check can't read a record, or a Project item, in any other, and All repositories also covers a repository added to the Project later.
- **Set up.** `factory setup --repo OWNER/NAME --checkout PATH --project-id PVT_... --github-app-id ID --github-app-key PATH --operator LOGIN` creates the configuration with the App, and `--github-app-installation ID` names the installation instead of finding the repository's. An existing configuration takes the App's options without `--checkout` and `--project-id`. Setup reads the key once, checks that it loads, never shows it, and keeps it as an owner-only copy (0600) in the installation's state directory, which the sandbox seals; the configuration names only the App. A changed key is in `changed` as `FACTORY_GITHUB_APP_KEY`. `--background` binds that copy as the service's credential `FACTORY_GITHUB_APP_KEY` (LoadCredential), so readiness checks the key the service loads; `--credential-file` doesn't take that name. Factory reads the key from the service's credential, else from `FACTORY_GITHUB_APP_KEY` in the environment (the PEM itself), else from the copy.
- **Tokens.** Factory signs a JWT with the key (RS256, issued 60 s back, expiring in 9 min), reads the installation (`GET /repos/{owner}/{repo}/installation`, or `github.app.installationId`'s) and mints an installation token (`POST /app/installations/{id}/access_tokens`). It keeps the token until 15 min before it expires and mints another then, or after a 401. Its login is `<slug>[bot]`, which its own-comment, own-issue and own-PR checks match, and a refusal holds with the App's fix (its id, installation, permissions or key) rather than `gh auth login`.
- **Git.** Each fetch, push, ls-remote and LFS transfer gets the token as that one Git call's configuration (`GIT_CONFIG_*` in its environment: github.com's credential helpers and extra headers cleared, then an `Authorization` header), so nothing is written to a Git configuration file and no worker or sandboxed command gets it. An SSH origin pushes with the host's SSH login. The commits Factory makes are authored by the App's bot (`<id>+<slug>[bot]@users.noreply.github.com`) and committed as Factory.
- **Switch.** Every check for what Factory made (its plan, status, hold and report comments, its Work Item issues and PRs) is bound to its current login, so an Objective in flight under another one would make them again, and `factory reset` rebuilds only from the current login's comments and PRs. Switch with the queue drained (`factory queue drain`, then wait until no Objective runs): setup refuses a `--github-app-id` that changes the App (or sets the first, an upgraded configuration's included) and a `--github-login` that drops it while any Objective has state. Recording `--github-login` where no App was set changes no identity, so it isn't refused: on an upgraded configuration with Objectives in flight, it lets the service start and finish them, drained, before the App. `github` is operational ([State](state.md#frozen-configuration)), so a hand edit holds nothing: drain first there too.
- **Operators.** `--operator LOGIN`... (`operators`) names who answers holds. A hold's question comment, the report and the cancel comment end with their @mentions, posted once each, so GitHub notifies them. The live status comment, a waiting note, a reminder, the plan comment and PR bodies mention no one, so editing them notifies nobody.

### Background service

The service runs as a systemd user unit (systemd.ts), one per installation. Each mode takes `--repo` and `--json`.

- **`--background`:** setup as above, checked as the service will run (setup.ts `setup`): its readiness counts the credentials the unit will load and leaves out the logins the unit doesn't keep from the setup shell (systemd.ts `unkeptLogins`): `CODEX_API_KEY`, `OPENAI_API_KEY`, `FACTORY_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, `FACTORY_GITHUB_APP_KEY` and the credential names below. So the service's Codex login is `codex login`'s auth.json and its GitHub login is the one `gh auth login` stored, or its GitHub App's key. Only once its status is `configured` does it write the unit and enable and start it, then wait up to 30 s for the service to take its lock.
  - The unit runs this Factory's `node cli.js serve --repo`. It carries the setup shell's PATH, HOME, `FACTORY_CONFIG`, `FACTORY_STATE_DIR`, login locations, Copilot endpoint settings (`COPILOT_API_URL`, `COPILOT_PROVIDER_BASE_URL`, `COPILOT_PROVIDER_TYPE`) and proxies. With mise managing the checkout, the checkout's pinned tools come first on that PATH (see [Toolchain from mise](#toolchain-from-mise)).
  - It restarts on failure, except on exit 2 (usage) and 78 (a configuration that doesn't load, or names no GitHub identity).
  - `KillMode=mixed`: the service stops at its next tick, and then its children are killed.
  - Repeated with nothing changed, it leaves the running service alone. The service reads its configuration and credentials once, so it restarts when the unit changed (an upgrade, or a changed environment or credential list), when setup changed the configuration or the App's key, or when `--credential-file` is given.
  - A service that exits or restarts before taking its lock blocks `--background` and names the journal.
- **`--credential-file NAME=FILE`...** (with `--background`): each is a LoadCredential. NAME is one Factory reads from the service's credentials: `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, with Copilot configured `COPILOT_GITHUB_TOKEN`, `GITHUB_COPILOT_API_TOKEN`, `COPILOT_PROVIDER_API_KEY` or `COPILOT_PROVIDER_BEARER_TOKEN`, or a managed worker's credential variable. A GitHub App's key is setup's copy, which `--background` binds itself. FILE is an absolute path to a regular file, not a link, that only its owner can read, in a directory no one else can write. Setup never reads it, and readiness counts it as present. Without the option, the unit keeps its credentials, which are checked again.
- **`--check`:** the unit's enabled and active state, whether the service holds its lock, the credential names, and whether the unit is current: the unit setup would write with the node and environment the unit records, so a checking shell whose PATH or node differs from the service's doesn't count. A unit for another Factory (an upgrade), or whose node is gone (`missingNode`), is a warning. Exit 0 only when it is running.
- **`--stop`:** stop the service and disable it, so it doesn't start at the next login. `--background` starts it again.
- **`--uninstall`:** stop the service and remove its unit. The configuration and state stay.

Setup never touches a unit it didn't write: its first line is Factory's marker. A `factory serve` that's already running outside the unit blocks `--background`. Lingering off is a warning, because the service then stops at logout.

### Toolchain from mise

mise manages the checkout when the checkout has a mise configuration (`mise.toml`, `.mise.toml`, `mise.local.toml`, `.mise.local.toml`, `.config/mise.toml`, `.config/mise/config.toml`, `.config/mise/conf.d/`, `.mise/config.toml`, `mise/config.toml` or `.tool-versions`) and `mise` is on the setup shell's PATH. Then setup (toolchain.ts) runs `mise ls --current --json` in the checkout, and `mise bin-paths TOOL@VERSION` for each installed tool a file in the checkout pins; a pin from the global configuration or a parent directory is the operator's own and doesn't count, and a `system` pin leaves that tool to the PATH. `--background` puts those bin directories first on the unit's PATH, so the service, its validation and its workers run exactly the versions the repository pins, and readiness checks that PATH. Factory itself still runs on the node that ran setup.

- **Untrusted:** mise refuses a configuration that can run code until it is trusted. Readiness names `mise trust FILE`, and the PATH stays the shell's.
- **Not installed:** readiness names `mise install` in the checkout; the other pinned tools still come first.
- **The pin moves:** setup reads the checkout's working tree, so bring the checkout up to date with the default branch, run `mise install` there, then `factory setup --background`. The unit's PATH changes, so the service restarts. Until then, readiness and the Objective check flag a node that misses the Node pin, and their fix says so.
- **Without mise:** no mise on the PATH, or no configuration in the checkout, changes nothing.

Factory never runs `mise install` or `mise trust`, and runs mise only in the configured checkout, with `MISE_YES=0` (see [Security](security.md#security)). mise trusts a path, not its contents, so review a change to the checkout's mise configuration before you bring the checkout up to date: setup runs it. Keep mise's shims directory, and `mise activate`, off the shell that runs `--background`: a shim picks its version from the directory a command runs in, a worktree a worker writes.

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
   - first, register and install Factory's GitHub App (see [GitHub identity](#github-identity));
   - `factory setup --repo OWNER/NAME --checkout … --project-id … --github-app-id … --github-app-key … --operator …` with your limits, delivery, sandbox and final commands, until it reports `configured`;
   - `--provider NAME …` for each provider;
   - optionally, turn on "require branches to be up to date" as readiness recommends.
6. **Start the service** with `factory setup --repo OWNER/NAME --background`, then queue one small Objective as a canary. It passes when its PRs merge with no duplicate PR, comment or merge, every hold had an answer that worked, and the issue closes with its report.
7. **Queue the rest.**

Rollback: `factory setup --uninstall`, then reinstall the old release and set it up from scratch: its state was deleted, so there is none to carry back.
