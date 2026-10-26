<img src="https://raw.githubusercontent.com/clockgrove/factory/main/assets/factory-mark.svg" alt="Factory mark" width="72" height="72">

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
  - the GitHub CLI logged in with access to the target repository and its Project;
  - a Codex login for the default provider, or a Claude Code or GitHub Copilot login for those providers.
- **A trusted target repository.** Workers run under your OS account inside the sandbox; the sandbox isn't a boundary against hostile code.

Planning, review and workers use your providers' quota. An idle service makes no model calls.

## Install

Factory has two parts, and both come from one release:

- **The plugin** gives your agent host the `setup` and `director` skills.
- **The CLI tarball** gives you `factory` and the bundled default Codex runtime. It works the same under any host.

Pick the latest release:

```sh
VERSION=$(gh release view --repo clockgrove/factory --json tagName --jq .tagName | sed 's/^v//')
```

### Plugin

Install the plugin for your host. Both hosts load the same skills.

**Codex:**

```sh
codex plugin marketplace add clockgrove/factory --ref "v$VERSION"
codex plugin add factory@clockgrove
```

**Claude Code**:

```sh
claude plugin marketplace add "clockgrove/factory#v$VERSION"
claude plugin install factory@clockgrove
```

In Claude Code the skills appear as `factory:setup` and `factory:director`.

Claude Code may report that the plugin's packages were not installed, naming a `package-lock.json` entry that is a bundled copy. This is expected and harmless. The plugin is this repository at the release tag, so it carries the CLI's `package.json` and lockfile, and Claude Code [installs a plugin's packages](https://code.claude.com/docs/en/plugins/loading#node-js-package-dependencies) only when none of them is bundled or linked. The skills need none of them: they run the `factory` CLI that you install from the tarball below.

### CLI

Download the tarball and verify it:

```sh
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

Keep that CLI on the PATH of the terminal or agent that will operate Factory, and reload your agent host if needed to load the installed skills. Factory excludes its authenticated installation bin from worker PATH when it contains only its own launcher; controller discovery and validation commands retain the original PATH. Other protected PATH entries still require correction. Factory is distributed through GitHub Releases, not the npm registry.

### Check the installation

Check that the CLI and the plugin come from the release you selected:

```sh
command -v factory
npm list --offline --prefix /absolute/private/factory-prefix @clockgrove/factory --depth=0
codex plugin list --marketplace clockgrove --json  # Codex host
claude plugin list --json                        # Claude Code host
```

Use the listing for your host. `factory help` lists the installed commands. A package check doesn't prove provider access or worker readiness; setup checks those.

## Use the plugin

1. **Prepare the target.** Make a clone of the target repository that only Factory uses. On the target's GitHub Project, add a single-select field `Factory` with the options Queued, Planning, Building, Needs you, Done and Cancelled, and a number field `Factory order`.
2. **Set up.** In Codex or Claude Code, ask:

   > Use Factory to set up OWNER/NAME with the clone at /absolute/clone and Project PVT_.... Do not start work.

   The setup skill writes the configuration and reports a readiness checklist with the fix for anything missing. To run Objectives in the background, ask it to install the background service. See [setup](docs/USER-GUIDE.md#set-up).

3. **Write an Objective.** Create an issue in the target from the [Objective template](docs/templates/objective.md): a goal, observable Acceptance bullets, and optional Context, Sources and Constraints. See [writing an Objective](docs/USER-GUIDE.md#write-an-objective).
4. **Run it.** Set the issue's `Factory` field to Queued, or ask:

   > Use Factory to run Objective #123.

   Factory checks the issue, plans, reviews the plan, runs the Work Items, validates and reviews each result, and merges the pull requests. A question it can't settle stops only what it covers, until you answer.

5. **Follow it.** Ask "Use Factory to show the status of Objective #123", or run `factory status 123 --repo OWNER/NAME`.

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
