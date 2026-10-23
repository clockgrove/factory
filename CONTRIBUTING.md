# Contributing to Factory

Factory welcomes bug reports, documentation fixes, and focused pull requests. Search the [issue tracker](https://github.com/clockgrove/factory/issues) before opening a new issue. For a larger change, describe the outcome and agree on its scope in an issue before implementing it. The [public project](https://github.com/orgs/clockgrove/projects/2) tracks priorities.

Set the native issue type and one priority label as the [issue metadata rules](AGENTS.md#issue-metadata) describe.

This guide is for developers adding features or fixing bugs in Factory itself. To use the plugin on your own repository, follow the [plugin user guide](docs/USER-GUIDE.md).

## Development setup

Use Linux x64, Node.js 22.12 or later, npm, Git, and Git LFS. Node.js 24 matches CI. The source-development tools require a newer Node.js minimum than the published runtime package, which supports Node.js 22.0 or later.

Fork or clone the repository, create a branch, and install its dependencies:

```sh
npm ci
npm run build
```

Keep optional dependencies enabled for source development: TypeScript and notice checks inspect the optional harness SDKs.

Read [AGENTS.md](AGENTS.md) for contributor rules and [the core spec](docs/CORE.md) for the design. Factory must never execute an Objective against its own source repository.

## Run the CLI from a checkout

Use this to run Factory from `main` before a release, on your own repository or while developing. The setup skill and the README run `factory` from the PATH, so put your build there.

```sh
git clone https://github.com/clockgrove/factory.git ~/factory-main
cd ~/factory-main
npm ci
npm run build:core
npm link          # or the wrapper below
factory help
```

Without `npm link`, write a wrapper on your PATH that runs the build:

```sh
printf '#!/bin/sh\nexec node "$HOME/factory-main/core/dist/cli.js" "$@"\n' > ~/.local/bin/factory
chmod +x ~/.local/bin/factory
```

Then run the setup skill, or `factory setup`, as the README describes. Rules:

- `npm run build:core` again after every `git pull`; the CLI runs `core/dist/`, not the source.
- Keep the checkout in place. The link and the wrapper point at it, and a background service keeps running it.
- Never use this checkout as the target repository. Factory refuses to run an Objective against its own source.
- Remove the link with `npm unlink -g @clockgrove/factory`.

## Checks

CI runs these checks. Run only an affected command locally when needed:

```sh
npm run lint
npm run format:check
npm run notices:check
npm run test:core
```

`npm run test:core` builds the core and runs its integration suite against real temporary Git repositories, processes and files, including the packed CLI installed offline. These checks need no provider credentials or live GitHub target.

The [Quality workflow](.github/workflows/quality.yml) runs lint, format and notice checks plus one integration-test job on every pull request and on `main`. The required `package-gate` passes only when both jobs succeed. Release also verifies the exact tarball it publishes.

`npm run lint` uses Biome. `npm run format` applies formatting. Commits do not install hooks or re-stage files; CI enforces the checks.

For an affected integration check after the batch, build and run its file directly:

```sh
npm run build
node --test --test-timeout=120000 core/test/service.test.mjs
```

Keep coverage within the [testing rules](AGENTS.md#testing); CI runs the complete small suite.

Check documentation commands, links and formatting when they change. Use the [release procedure](docs/RELEASING.md) for the release issue’s actual milestone acceptance; do not add per-fix live runs or a separate public-fixture gate. Local CI does not claim live provider or GitHub acceptance.

## Pull requests

Link the issue, explain the user-visible change, and report the checks you ran. Keep each pull request focused on one complete outcome, with adjacent cleanup left out. Describe any remaining limitations and distinguish local test results from live acceptance evidence. Never include credentials, private repository content, raw agent transcripts, or private run details.

Preserve these boundaries:

- Keep Factory configuration, credentials, attempts, and snapshots outside target repositories.
- Preserve exact commit, tree, and GitHub head checks at publication and Objective completion.
- Target repositories own their product requirements, validation commands, access controls, and acceptance.

### Plan checks

When Factory checks something deterministically, it gives the model the facts it checks against, and every refusal says what would pass. A new plan check must put its facts in the planner request, refuse with the allowed alternatives or the exact fix, and be registered in `PLAN_CHECKS`; see [the plan checks](docs/PLANNING.md#plan-checks).

## Contributing versus using Factory

Factory contributors work directly on this repository. To use Factory for work in another repository, follow the [README](README.md) and the installed `director` and `setup` skills. Target owners can copy the [Objective issue form](docs/templates/objective.yml) into their own repository's `.github/ISSUE_TEMPLATE/` directory; it is not a bug-report form for Factory.

For help or bug reports, use the issue tracker and include the Factory version, operating system, command, expected and observed behavior, and a minimal reproduction with redacted output. Keep discussion respectful and private content private. Report suspected vulnerabilities through the [security policy](SECURITY.md). Factory uses the [MIT license](LICENSE).
