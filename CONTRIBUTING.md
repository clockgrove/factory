# Contributing to Factory

Factory welcomes bug reports, documentation fixes, and focused pull requests. Search the [issue tracker](https://github.com/clockgrove/factory/issues) before opening a new issue. For a larger change, describe the outcome and agree on its scope in an issue before implementing it. The [public project](https://github.com/orgs/clockgrove/projects/2) tracks priorities.

Set the native issue type and one priority label as the [issue metadata rules](AGENTS.md#issue-metadata) describe.

This guide is for developers adding features or fixing bugs in Factory itself. To use the plugin on your own repository, follow the [plugin user guide](docs/USER-GUIDE.md).

## Development setup

Use Linux x64, Node.js 22.13 or later, npm, Git, and Git LFS. Node.js 24 matches CI.

Fork or clone the repository, create a branch, and install its dependencies:

```sh
npm ci
npm run build
```

Keep optional dependencies enabled for source development: TypeScript and notice checks inspect the optional harness SDKs.

Read [AGENTS.md](AGENTS.md) for contributor rules and [the design](docs/DESIGN.md) for how Factory works. Factory must never execute an Objective against its own source repository.

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

`npm run test:core` builds Factory and runs its CI tests against real temporary Git repositories, processes and files, including the packed CLI installed offline. They use no mocks and no GitHub, need no provider credentials, and take about 3 minutes.

The [Quality workflow](.github/workflows/quality.yml) runs lint, format and notice checks plus one CI-test job on every pull request and on `main`. The required `package-gate` passes only when both jobs succeed. Release also verifies the exact tarball it publishes.

`npm run lint` uses Biome. `npm run format` applies formatting. Commits do not install hooks or re-stage files; CI enforces the checks.

For an affected CI test after the batch, build and run its file directly:

```sh
npm run build:core
node --test core/test/holds.test.mjs
```

Keep coverage within the [coverage rules](AGENTS.md#testing); CI runs the complete small suite.

### Integration tests

[Integration tests](integration/README.md) run real Objectives with real providers against the scratch repository `clockgrove/factory-drill`, and never run in CI. They crash the service at every crash point, cut the network and stop models mid-turn. Run them on demand, as bounded groups:

```sh
npm run build:core
npm run integration -- --dry-run          # groups, expected minutes and preconditions
npm run integration -- --only queue
```

A plan expected to take over 60 minutes needs the maintainer's approval, then `--approved-long`.

Check documentation commands, links and formatting when they change. Use the [release procedure](docs/RELEASING.md) for the release issue’s actual milestone acceptance; do not add per-fix live runs or a separate public-fixture gate. Local CI does not claim live provider or GitHub acceptance.

## Pull requests

Link the issue, explain the user-visible change, and report the checks you ran. Land through the merge queue, in stacks where changes build on each other, and push with `scripts/land-prep.sh`; see [Landing changes](docs/LANDING.md). Keep each pull request focused on one complete outcome, with adjacent cleanup left out. Describe any remaining limitations and distinguish local test results from live acceptance evidence. Never include credentials, private repository content, raw agent transcripts, or private run details.

Preserve these boundaries:

- Keep Factory configuration, credentials, attempts, and snapshots outside target repositories.
- Preserve exact commit, tree, and GitHub head checks at publication and Objective completion.
- Target repositories own their product requirements, validation commands, access controls, and acceptance.

### Plan checks

When Factory checks something deterministically, it gives the model the facts it checks against, and every refusal says what would pass. A new plan check must put its facts in the planner request, refuse with the allowed alternatives or the exact fix, and run from `checkPlan` in `core/src/planning/checks.ts`; see [the plan checks](docs/PLANNING.md#plan-checks).

## Contributing versus using Factory

Factory contributors work directly on this repository. To use Factory for work in another repository, follow the [README](README.md) and the installed `director` and `setup` skills. Target owners can copy the [Objective issue form](docs/templates/objective.yml) into their own repository's `.github/ISSUE_TEMPLATE/` directory; it is not a bug-report form for Factory.

For help or bug reports, use the issue tracker and include the Factory version, operating system, command, expected and observed behavior, and a minimal reproduction with redacted output. Keep discussion respectful and private content private. Report suspected vulnerabilities through the [security policy](SECURITY.md). Factory uses the [MIT license](LICENSE).
