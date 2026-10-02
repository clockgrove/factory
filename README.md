<img src="https://raw.githubusercontent.com/clockgrove/factory/main/assets/factory-mark.svg" alt="Factory mark" width="72" height="72">

# Factory

Turn a GitHub issue into a reviewed plan, coordinated coding work, and validated pull requests.

Factory is an open-source Codex plugin for developers working with coding agents. It reads your repository's requirements, breaks an Objective into dependency-linked Work Items, runs independent work concurrently, and validates the results before delivering them through GitHub.

- **Plan from your sources.** Review a plan grounded in committed requirements, owned paths, dependencies, and validation commands.
- **Run local agents.** Use your existing Codex account and machine, with an explicit concurrency limit. Optional local Claude and Copilot harnesses are available separately.
- **Validate and deliver.** Check exact result trees, independently review acceptance, and integrate regular pull requests or native linear stacks under your repository's rules.
- **Handle assets.** Review complete candidate asset sets and deliver selected bytes using the repository's Git LFS policy.

**Status:** Candidate v0.1.69 corrects grounded planning, native field validation, read-only baseline qualification, dirty-result evidence, issue context and diagnosis metadata. [Independent distribution acceptance](https://github.com/clockgrove/factory/issues/466) is required before using this candidate. Published v0.1.68 retains its [original distribution evidence](https://github.com/clockgrove/factory/issues/451#issuecomment-5946087196). [Live public qualification](https://github.com/clockgrove/factory/issues/448) and [adopter rollout](https://github.com/clockgrove/factory/issues/445) retain separate acceptance gates.

Factory is early software. Supervise initial Objectives and follow the [recovery guidance](https://github.com/clockgrove/factory/blob/main/docs/USER-GUIDE.md#stopping-and-recovery) when work stops. [Release artifact records](https://github.com/clockgrove/factory/blob/main/docs/BUILD-STATUS.md) retain the evidence and limits of earlier versions.

## Requirements

- Linux x64, including a Linux environment under WSL2; Node.js 22 or later for the published bundled Codex path.
- Git, authenticated GitHub CLI access to your target repository, and an authenticated Codex environment. The plugin also requires a Codex host with plugin support.
- Your target's build and validation tools; Git LFS for LFS-backed media work.
- A trusted repository with committed instructions and requirements. Local workers run under your OS account; they are not a security boundary for hostile code.

Planning, review, and workers consume your provider's usage. Factory currently runs one active Objective per installation, with a configured local harness or compile-time assigned local execution profiles. The release includes provider-neutral [sandbox application composition](docs/SANDBOX-EXECUTION.md) and an optional Daytona adapter for public sources. Private-source authentication and live hosted execution remain unqualified. See [local harnesses](https://github.com/clockgrove/factory/blob/main/docs/AGENT-HARNESSES.md) for optional-provider requirements and boundaries.

## Install

The Codex plugin supplies the setup and director skills. The matching GitHub Release tarball supplies the CLI and bundled default Codex runtime. Install both from the same published version. The commands below select v0.1.69 once its [independent public verification](https://github.com/clockgrove/factory/issues/466) has completed. Compare the exact archive fingerprint recorded there before installation.

```sh
codex plugin marketplace add clockgrove/factory --ref v0.1.69
codex plugin add factory@clockgrove

gh release download v0.1.69 --repo clockgrove/factory \
  --pattern clockgrove-factory-0.1.69.tgz --pattern SHA256SUMS
sha256sum --check SHA256SUMS
```

Before installing, compare the tarball's SHA-256 with the independently recorded prepublication digest for that same version in the [prepublication fingerprint](https://github.com/clockgrove/factory/issues/451#issuecomment-5946059666), or the [release artifact record](https://github.com/clockgrove/factory/blob/main/docs/BUILD-STATUS.md). A checksum downloaded beside the tarball is not the independent record. The owning release issue records the independent public archive and pinned-plugin verification result.

Choose an absolute installation directory outside your target repository:

```sh
npm install --offline --prefix /absolute/private/factory-prefix \
  ./clockgrove-factory-0.1.69.tgz
export PATH="/absolute/private/factory-prefix/node_modules/.bin:$PATH"
factory help
```

Keep that CLI on the PATH of the terminal or agent that will operate Factory, and reload your Codex host if needed to load the installed skills. This distribution uses GitHub Release assets; an npm registry install is not the documented release path.

## Use the plugin

Open your target repository in Codex after loading the matching plugin, and ask:

> Use Factory to set up this repository with a concurrency limit of two. Do not start work.

Factory's setup skill binds the checkout and reports the configuration. For background operation, ask:

> Use Factory to set up this repository and keep watching for explicitly approved Objectives, with a concurrency limit of two.

On a supported Linux/WSL user-service host, the guided setup configures Factory, registers and starts its background service, and verifies the actual service-owned GitHub observation in one flow. An idle watcher makes no model calls. It checks every 30 seconds by default and starts only explicitly authorized Objective IDs; discovered issues and labels grant no execution authority. Later approved batches use the supported intake refill operation while idle. The service must be able to run on this machine; shutdown, sleep and user-manager lifetime still apply.

The target must be a trusted GitHub repository with committed requirements and available validation tools. Factory cannot run against its own source repository.

Create an Objective issue **in the target repository** describing the outcome, acceptance checks, allowed changes, and canonical sources. You can copy the [Objective issue form](https://github.com/clockgrove/factory/blob/main/docs/templates/objective.yml) into that repository. Then ask:

> Use Factory to plan Objective #123. Show me the plan and any unresolved questions before running it.

Planning uses Codex compilation and review, but does not start workers or create Work Item issues. Inspect the scope, dependencies, and validation commands. Resolve any specific review question, then ask:

> Use Factory to run the accepted plan for Objective #123.

The director skill runs the accepted plan through Factory. Execution creates Work Item issues, runs agents, and publishes and integrates accepted changes under your repository's permissions and branch rules. To inspect progress, ask:

> Use Factory to show the status of Objective #123 and explain anything waiting for my input.

Configuration and state stay outside the target checkout. Installation refuses an existing binding or repository state; the agent should inspect it rather than delete it to start over. The [plugin user guide](https://github.com/clockgrove/factory/blob/main/docs/USER-GUIDE.md) explains setup, media decisions, recovery limits, and the underlying CLI commands.

## Build Factory

To add features or fix bugs **in Factory itself**, use a source checkout and follow [Contributing](https://github.com/clockgrove/factory/blob/main/CONTRIBUTING.md). That developer workflow has its own dependency installation, tests, and release procedures. Installing the plugin does not require building Factory from source.

## Documentation and community

| I want to…                                                          | Read                                                                                                                                                                       |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configure models, inspect progress, review media, or handle a pause | [User guide](https://github.com/clockgrove/factory/blob/main/docs/USER-GUIDE.md)                                                                                           |
| Compare local usage, time and outcomes                              | [Local analysis](https://github.com/clockgrove/factory/blob/main/docs/LOCAL-ANALYSIS.md)                                                                                   |
| Select or implement a local agent harness                           | [Local harnesses](https://github.com/clockgrove/factory/blob/main/docs/AGENT-HARNESSES.md)                                                                                 |
| Report a bug or ask for help                                        | [Support](https://github.com/clockgrove/factory/blob/main/SUPPORT.md)                                                                                                      |
| Build from source or contribute                                     | [Contributing](https://github.com/clockgrove/factory/blob/main/CONTRIBUTING.md)                                                                                            |
| Understand the architecture and roadmap                             | [Implementation plan](https://github.com/clockgrove/factory/blob/main/docs/IMPLEMENTATION-PLAN.md) · [Project](https://github.com/orgs/clockgrove/projects/2)              |
| Inspect release changes or qualification                            | [Changelog](https://github.com/clockgrove/factory/blob/main/CHANGELOG.md) · [Release checklist](https://github.com/clockgrove/factory/blob/main/docs/RELEASE-CHECKLIST.md) |

Factory is [MIT licensed](https://github.com/clockgrove/factory/blob/main/LICENSE) and maintained by Clockgrove. Contributions follow the [code of conduct](https://github.com/clockgrove/factory/blob/main/CODE_OF_CONDUCT.md). Report vulnerabilities through the [security policy](https://github.com/clockgrove/factory/blob/main/SECURITY.md).
