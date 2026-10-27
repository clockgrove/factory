<img src="https://raw.githubusercontent.com/clockgrove/factory/main/plugin/assets/factory-mark.svg" alt="Factory mark" width="72" height="72">

# Factory

Turn a GitHub issue into a reviewed plan, coordinated coding work, and validated pull requests.

Factory is an open-source plugin for Codex and Claude Code, built for developers working with coding agents. It reads your repository's requirements, breaks an Objective into dependency-linked Work Items, runs independent work concurrently, and validates the results before delivering them through GitHub.

- **Plan from your sources.** A reviewed plan grounded in the repository at its default branch: Work Items with owned paths, dependencies and validation commands.
- **Run agents in parallel.** Codex by default; Claude and GitHub Copilot as named providers. Independent Work Items run at once, within host-sized limits.
- **Validate and deliver.** Every result is validated in an OS sandbox and reviewed against its acceptance, then delivered as regular pull requests or native linear stacks under your branch rules.
- **Crash-safe.** One service owns the state. A crash, a reboot or a killed model resumes where it stopped, with no duplicate pull request, comment or merge. Anything it can't decide becomes a question with answers that work.

**Status:** Factory is early, pre-1.0 software. Start with a disposable repository and supervise the first Objectives. See [release notes](https://github.com/clockgrove/factory/releases) for what each version contains.

You queue Objectives on a GitHub Project and answer Factory's questions from the CLI, your agent conversation, or a `/factory` comment on the issue. GitHub shows each Objective's progress, its pull requests and its report.

## Requirements

- Linux x64, including WSL2, with Node.js 22.13 or later.
- **Tools:**
  - Git 2.31 or later, and Git LFS for media;
  - bubblewrap (`bwrap`) for the command sandbox, and passt (`pasta`) if dependency installs need the network;
  - your target's build and validation tools.
- **Logins:**
  - Factory's own GitHub App, registered and installed as setup's first step: Factory acts on GitHub as the App, so its holds notify you (see [GitHub identity](docs/reference/setup.md#github-identity));
  - the GitHub CLI logged in with access to the target repository and its Project, for your own commands and setup's;
  - a Codex login for the default provider, or a Claude Code or GitHub Copilot login for those providers.
- **A trusted target repository.** Workers run under your OS account inside the sandbox; the sandbox isn't a boundary against hostile code.

Planning, review and workers use your providers' quota. An idle service makes no model calls.

## Install

Install the plugin, then run its setup skill. Factory has two parts, and both come from one release:

- **The plugin** gives your agent host the `setup` and `director` skills.
- **The CLI** gives you `factory` and the bundled default Codex runtime. It works the same under any host. The setup skill installs it for you.

### Plugin

Install the plugin for your host. Both hosts load the same skills.

**Codex:**

```sh
codex plugin marketplace add clockgrove/factory
codex plugin add factory@clockgrove
```

**Claude Code**:

```sh
claude plugin marketplace add clockgrove/factory
claude plugin install factory@clockgrove
```

In Claude Code the skills appear as `factory:setup` and `factory:director`.

The marketplace follows this repository's `main`, whose entry always names the latest release's tag, so you get the latest release. The plugin is that release's `plugin` directory: its manifests, skills and logo, with no npm package, so neither host installs packages for it. The skills run the `factory` CLI that setup installs.

#### Upgrade the plugin

Refresh the marketplace and update the plugin, then run setup again (see [Upgrade](docs/USER-GUIDE.md#upgrade)):

```sh
codex plugin marketplace upgrade clockgrove && codex plugin add factory@clockgrove      # Codex
claude plugin marketplace update clockgrove && claude plugin update factory@clockgrove  # Claude Code
```

Restart Claude Code afterwards to load the new skills. Codex's `marketplace upgrade` usually updates the plugin itself; `plugin add` installs the marketplace's release when it didn't. In the minutes a new release is being tagged, the update can fail and leave your release installed; run it again later. Setup reports a release whose files aren't published yet as `unpublished`, and asks you to try again in a few minutes.

**Installed before 0.5.2?** Earlier releases added the marketplace at a release tag (`clockgrove/factory#vX.Y.Z` or `--ref vX.Y.Z`). A host keeps that tag, so the commands above leave the plugin where it is, and it refuses the same marketplace without the tag. Move once: remove the marketplace, which also removes the plugin (it keeps no data), then add it without a tag and install:

```sh
# Codex
codex plugin marketplace remove clockgrove
codex plugin marketplace add clockgrove/factory
codex plugin add factory@clockgrove
# Claude Code
claude plugin marketplace remove clockgrove
claude plugin marketplace add clockgrove/factory
claude plugin install factory@clockgrove
```

To stay on one release instead, add the marketplace at its tag, as those releases did. A pinned marketplace doesn't upgrade; moving it to another release takes the same remove and add.

**Set up before 0.5.2?** Factory acts as its own GitHub App by default now, and setup is blocked on a configuration that names neither the App nor the GitHub CLI's login, until you register the App ([Use the plugin](#use-the-plugin), step 2) and give it to setup, or keep the login with `--github-login`. See [Upgrade](docs/USER-GUIDE.md#upgrade).

### Run setup

In Codex or Claude Code, ask Factory to set up your target (see [Use the plugin](#use-the-plugin)), or run `factory:setup` in Claude Code. Before anything else, setup installs the CLI of the plugin's own release when it is missing or another version:

1. It downloads that release's `clockgrove-factory-VERSION.tgz` and `SHA256SUMS` into a fresh directory.
2. It checks the tarball's SHA-256 and its build provenance with `gh attestation verify`, and stops with nothing installed if either fails.
3. It installs the tarball with npm, together with the SDKs the Claude and Copilot providers need, into `~/.local/share/clockgrove-factory/VERSION` (under `XDG_DATA_HOME` when set), or into an absolute directory you name.
4. It points the launcher `~/.local/share/clockgrove-factory/bin/factory` (`bin/factory` in a directory you name) at that CLI, replacing the link in one step, and runs it for the rest of setup. When that `bin` isn't on your PATH, it offers to add the one line that puts it there to your shell's startup file. The line names no version, so it stays right at the next release; replace any line an earlier setup gave you that names a versioned `clockgrove-factory/VERSION/bin`. That `bin` holds only Factory's launcher, which Factory keeps off its workers' PATH. The launcher never goes back to an older release on its own: setup from a plugin older than the release the launcher runs (say, Codex's plugin a release behind Claude Code's) installs its release beside it, leaves the launcher where it is and names the plugin to update; the installer's `--downgrade` moves it back on purpose.

It needs the GitHub CLI logged in and network access. The installer is `skills/setup/install-cli.mjs` in the plugin; `node` runs it on its own too, and it prints JSON with the CLI's path.

### Install the CLI by hand

This is the fallback when setup can't install the CLI. Set `VERSION` to your plugin's release (the latest, as below, unless you pinned one), then download the tarball and verify it:

```sh
VERSION=$(gh release view --repo clockgrove/factory --json tagName --jq .tagName | sed 's/^v//')
gh release download "v$VERSION" --repo clockgrove/factory \
  --pattern "clockgrove-factory-$VERSION.tgz" --pattern SHA256SUMS
gh attestation verify "clockgrove-factory-$VERSION.tgz" --repo clockgrove/factory
sha256sum --check SHA256SUMS
```

`gh attestation verify` proves the tarball was built by this repository's [release workflow](https://github.com/clockgrove/factory/blob/main/docs/RELEASING.md) from the tagged source. Do not install a tarball that fails verification. Releases before v0.1.75 predate attestations; see the [release history](https://github.com/clockgrove/factory/blob/main/docs/RELEASING.md#history).

Choose an absolute installation directory outside your target repository and credential, configuration or state roots (including `CODEX_HOME`):

```sh
npm install --offline --prefix /absolute/private/factory-prefix \
  "./clockgrove-factory-$VERSION.tgz"
export PATH="/absolute/private/factory-prefix/node_modules/.bin:$PATH"
factory help
```

The offline install leaves out the optional SDKs that the Claude and Copilot providers need. To use them, install the same verified tarball again with network access, then check that they're there:

```sh
npm install --prefix /absolute/private/factory-prefix "./clockgrove-factory-$VERSION.tgz"
npm list --prefix /absolute/private/factory-prefix @anthropic-ai/claude-agent-sdk @github/copilot-sdk
```

Keep that CLI on the PATH of the terminal or agent that will operate Factory, and reload your agent host if needed to load the installed skills. Factory excludes its authenticated installation bin from worker PATH when it contains only a Factory launcher (a `factory` link to Factory's CLI, of any version, or the setup skill's launcher whose release directory was deleted, which readiness warns of); controller discovery and validation commands retain the original PATH. Other protected PATH entries still require correction. Factory is distributed through GitHub Releases, not the npm registry.

### Check the installation

Setup checks this for you. To check by hand that the CLI and the plugin come from one release, list the plugin (its `version`) and, with `VERSION` that release, the CLI's installation directory (setup's default below, or the one you chose):

```sh
command -v factory
npm list --offline --prefix "$HOME/.local/share/clockgrove-factory/$VERSION" @clockgrove/factory --depth=0
codex plugin list --marketplace clockgrove --json  # Codex host
claude plugin list --json                        # Claude Code host
```

Use the listing for your host. `factory help` lists the installed commands. A package check doesn't prove provider access or worker readiness; setup checks those.

## Use the plugin

1. **Prepare the target.** Make a clone of the target repository that only Factory uses. On the target's GitHub Project, add a single-select field `Factory` with the options Queued, Planning, Building, Needs you, Done and Cancelled, and a number field `Factory order`.
2. **Register Factory's GitHub App.** A required preflight step, before the repository is configured: ask Factory to set up your target (step 3) and the setup skill walks you through it first, or, with the CLI installed, run it yourself. `factory setup --repo OWNER/NAME --github-app-link` prints the link that registers a private App with the permissions Factory needs prefilled: in the organization's settings for an organization's repository, in your own otherwise. Create the App, generate its private key, and install it on All repositories: Factory reads every repository of the queue's Project, and All repositories also covers one added later. Keep the App's ID and the key's path; Factory never needs the key's content in a chat. See [GitHub identity](docs/reference/setup.md#github-identity).
3. **Set up.** In Codex or Claude Code, ask:

   > Use Factory to set up OWNER/NAME with the clone at /absolute/clone and Project PVT_..., acting as GitHub App ID with its private key at /absolute/key.pem, and me (LOGIN) as operator. Do not start work.

   The setup skill installs the CLI if it needs to (see [Run setup](#run-setup)), writes the configuration (`factory setup --repo OWNER/NAME --checkout … --project-id … --github-app-id ID --github-app-key PATH --operator LOGIN`) and reports a readiness checklist with the fix for anything missing. To run Objectives in the background, ask it to install the background service. See [setup](docs/USER-GUIDE.md#set-up).

   Factory acts as the App; your GitHub CLI login still runs your own commands. To have Factory act as that login instead, say so: setup records the choice with `--github-login`, and holds then notify no one when the login is yours.

4. **Write an Objective.** Create an issue in the target from the [Objective template](docs/templates/objective.md): a goal, observable Acceptance bullets, and optional Context, Sources and Constraints. See [writing an Objective](docs/USER-GUIDE.md#write-an-objective).
5. **Run it.** Set the issue's `Factory` field to Queued, or ask:

   > Use Factory to run Objective #123.

   Factory checks the issue, plans, reviews the plan, runs the Work Items, validates and reviews each result, and merges the pull requests. A question it can't settle stops only what it covers, until you answer.

6. **Follow it.** Ask "Use Factory to show the status of Objective #123", or run `factory status 123 --repo OWNER/NAME`.

Configuration and state live outside the target checkout. Factory refuses its own repository.

## Build Factory

To add features or fix bugs **in Factory itself**, use a source checkout and follow [Contributing](https://github.com/clockgrove/factory/blob/main/CONTRIBUTING.md). That developer workflow has its own dependency installation, tests, and release procedures. Installing the plugin does not require building Factory from source.

## Documentation and community

| I want to…                                     | Read                                                                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Set up, run, answer questions, recover         | [User guide](https://github.com/clockgrove/factory/blob/main/docs/USER-GUIDE.md)                                                            |
| Know exactly how Factory behaves               | [Design](https://github.com/clockgrove/factory/blob/main/docs/DESIGN.md)                                                                    |
| Report a bug or ask for help                   | [Issue tracker](https://github.com/clockgrove/factory/issues)                                                                               |
| Build from source or contribute                | [Contributing](https://github.com/clockgrove/factory/blob/main/CONTRIBUTING.md)                                                             |
| Inspect release changes or the release process | [Releases](https://github.com/clockgrove/factory/releases) · [Releasing](https://github.com/clockgrove/factory/blob/main/docs/RELEASING.md) |

Factory is [MIT licensed](https://github.com/clockgrove/factory/blob/main/LICENSE) and maintained by Clockgrove. Report vulnerabilities through the [security policy](https://github.com/clockgrove/factory/blob/main/SECURITY.md).
