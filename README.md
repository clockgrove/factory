<img src="https://raw.githubusercontent.com/clockgrove/factory/main/assets/factory-mark.svg" alt="Factory mark" width="72" height="72">

# Factory

Turn a GitHub issue into a reviewed plan, coordinated coding work, and validated pull requests.

Factory is an open-source plugin for Codex and Claude Code, built for developers working with coding agents. It reads your repository's requirements, breaks an Objective into dependency-linked Work Items, runs independent work concurrently, and validates the results before delivering them through GitHub.

- **Plan from your sources.** Review a plan grounded in committed requirements, owned paths, dependencies, and validation commands.
- **Run local agents.** Use your existing Codex account and machine, with an explicit concurrency limit. Optional local Claude and Copilot harnesses are available separately.
- **Validate and deliver.** Check exact result trees, independently review acceptance, and integrate regular pull requests or native linear stacks under your repository's rules.
- **Handle assets.** Review complete candidate asset sets and deliver selected bytes using the repository's Git LFS policy.

**Status:** Factory is early, pre-1.0 software. Start with a disposable repository and supervise initial Objectives, and follow the [recovery guidance](https://github.com/clockgrove/factory/blob/main/docs/USER-GUIDE.md#stopping-and-recovery) when work stops. See [release notes](https://github.com/clockgrove/factory/releases) for what each version contains.

## Requirements

- Linux x64, including a Linux environment under WSL2; Node.js 22 or later for the published bundled Codex path.
- Git 2.31 or later, authenticated GitHub CLI access to your target repository, and authenticated access for your configured providers: a Codex login for the default Codex planning and worker path, or a Claude Code login when planning, review or work use Claude (see the [user guide](docs/USER-GUIDE.md#models-network-and-delivery)). The plugin requires Codex or Claude Code with plugin support.
- Your target's build and validation tools; Git LFS for LFS-backed media work.
- A trusted repository with committed instructions and requirements. Local workers run under your OS account; they are not a security boundary for hostile code.

Planning, review, and workers consume your provider's usage. Different Objectives can run in parallel, each from its own foreground run, while the background service queue stays sequential. Factory runs with a configured local harness or compile-time assigned local execution profiles. [Remote execution](https://github.com/clockgrove/factory/blob/main/docs/USER-GUIDE.md#managed-execution) (Claude and OpenAI managed agents) is not yet live-qualified. See [local harnesses](https://github.com/clockgrove/factory/blob/main/docs/USER-GUIDE.md#local-providers) for optional-provider requirements and boundaries.

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

**Claude Code** (releases after v0.1.75):

```sh
claude plugin marketplace add "clockgrove/factory#v$VERSION"
claude plugin install factory@clockgrove
```

In Claude Code the skills appear as `factory:setup` and `factory:director`.

### CLI

Download the tarball and verify it:

```sh
gh release download "v$VERSION" --repo clockgrove/factory \
  --pattern "clockgrove-factory-$VERSION.tgz" --pattern SHA256SUMS
gh attestation verify "clockgrove-factory-$VERSION.tgz" --repo clockgrove/factory
sha256sum --check SHA256SUMS
```

`gh attestation verify` proves the tarball was built by this repository's [release workflow](https://github.com/clockgrove/factory/blob/main/docs/RELEASING.md) from the tagged source. Do not install a tarball that fails verification. Releases before v0.1.75 predate attestations; their verification is linked in the [historical release record](https://github.com/clockgrove/factory/blob/1ce1758836c6a249540d6c4bbddf1d01236ac0d7/CHANGELOG.md).

Choose an absolute installation directory outside your target repository and credential, configuration or state roots (including `CODEX_HOME`):

```sh
npm install --offline --prefix /absolute/private/factory-prefix \
  "./clockgrove-factory-$VERSION.tgz"
export PATH="/absolute/private/factory-prefix/node_modules/.bin:$PATH"
factory help
```

Keep that CLI on the PATH of the terminal or agent that will operate Factory, and reload your agent host if needed to load the installed skills. Factory excludes its authenticated installation bin from worker PATH when it contains only its own launcher; controller discovery and validation commands retain the original PATH. Other protected PATH entries still require correction. Factory is distributed through GitHub Releases, not the npm registry.

Verify the installed CLI package and the enabled plugin both report the release you selected:

```sh
command -v factory
npm list --offline --prefix /absolute/private/factory-prefix @clockgrove/factory --depth=0
codex plugin list --marketplace clockgrove --json  # Codex host
claude plugin list --json                        # Claude Code host
```

Use the listing for your host. Check that `factory` on PATH belongs to that installation; an older wrapper or another prefix can select a different CLI. `factory help` lists the installed commands. A successful package check does not establish provider access or worker readiness.

## Use the plugin

Open your target repository in Codex or Claude Code after loading the matching plugin, and ask:

> Use Factory to set up this repository with a concurrency limit of two. Do not start work.

Factory's setup skill binds the checkout and reports the configuration. For background operation, ask:

> Use Factory to set up this repository and keep watching for explicitly approved Objectives, with a concurrency limit of two.

On a supported Linux/WSL user-service host, the guided setup configures Factory, registers and starts its background service, and verifies the actual service-owned GitHub observation in one flow. An idle watcher makes no model calls. It checks every 30 seconds by default and starts only explicitly authorized Objective IDs; discovered issues and labels grant no execution authority. Add later approved batches with `factory queue add N` while the service is idle or running. The service must be able to run on this machine; shutdown, sleep and user-manager lifetime still apply.

The target must be a trusted GitHub repository with committed requirements and available validation tools. Factory cannot run against its own source repository.

Create an Objective issue **in the target repository** with four sections: Outcome, Acceptance, Sources and Constraints. You can copy the [Objective issue form](https://github.com/clockgrove/factory/blob/main/docs/templates/objective.yml) into that repository. Then ask:

> Use Factory to inspect Objective #123 and its committed sources. Explain any missing prerequisites or unclear acceptance. Do not run it yet.

This inspects the issue and repository without starting Factory. The installed CLI has no plan-only command: `factory run` plans and independently reviews, then executes a clean plan. When you authorize execution, ask:

> Use Factory to run Objective #123.

The director skill runs the Objective through Factory. A planning question stops for your decision; otherwise execution creates Work Item issues, runs agents, and publishes and integrates accepted changes under your repository's permissions and branch rules. To inspect progress, ask:

> Use Factory to show the status of Objective #123 and explain anything waiting for my input.

Configuration and state stay outside the target checkout. Installation refuses an existing binding or repository state; the agent should inspect it rather than delete it to start over. The [plugin user guide](https://github.com/clockgrove/factory/blob/main/docs/USER-GUIDE.md) explains setup, media decisions, recovery limits, and the underlying CLI commands.

## Build Factory

To add features or fix bugs **in Factory itself**, use a source checkout and follow [Contributing](https://github.com/clockgrove/factory/blob/main/CONTRIBUTING.md). That developer workflow has its own dependency installation, tests, and release procedures. Installing the plugin does not require building Factory from source.

## Documentation and community

| I want to…                                                          | Read                                                                                                                                            |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Configure models, inspect progress, review media, or handle a pause | [User guide](https://github.com/clockgrove/factory/blob/main/docs/USER-GUIDE.md)                                                                |
| Capture, analyze or export model usage                              | [Capture and analysis](https://github.com/clockgrove/factory/blob/main/docs/USER-GUIDE.md#diagnostic-capture-and-export)                        |
| Select or implement a local agent harness                           | [Local harnesses](https://github.com/clockgrove/factory/blob/main/docs/USER-GUIDE.md#local-providers)                                           |
| Report a bug or ask for help                                        | [Issue tracker](https://github.com/clockgrove/factory/issues)                                                                                   |
| Build from source or contribute                                     | [Contributing](https://github.com/clockgrove/factory/blob/main/CONTRIBUTING.md)                                                                 |
| Understand the architecture and roadmap                             | [Architecture](https://github.com/clockgrove/factory/blob/main/docs/ARCHITECTURE.md) · [Project](https://github.com/orgs/clockgrove/projects/2) |
| Inspect release changes or the release process                      | [Releases](https://github.com/clockgrove/factory/releases) · [Releasing](https://github.com/clockgrove/factory/blob/main/docs/RELEASING.md)     |

Factory is [MIT licensed](https://github.com/clockgrove/factory/blob/main/LICENSE) and maintained by Clockgrove. Report vulnerabilities through the [security policy](https://github.com/clockgrove/factory/blob/main/SECURITY.md).
