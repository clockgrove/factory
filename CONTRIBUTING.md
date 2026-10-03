# Contributing to Factory

Factory welcomes bug reports, documentation fixes, and focused pull requests. Search the [issue tracker](https://github.com/clockgrove/factory/issues) before opening a new issue. For a larger change, describe the outcome and agree on its scope in an issue before implementing it. The [public project](https://github.com/orgs/clockgrove/projects/2) tracks priorities.

This guide is for developers adding features or fixing bugs in Factory itself. To use the plugin on your own repository, follow the [plugin user guide](docs/USER-GUIDE.md).

## Development setup

Use Linux x64, Node.js 22.12 or later, npm, Git, and Git LFS. Node.js 24 matches CI. The source-development tools require a newer Node.js minimum than the published runtime package, which supports Node.js 22.0 or later.

Fork or clone the repository, create a branch, and install its dependencies:

```sh
npm ci
npm run build
```

Keep optional dependencies enabled for source development: TypeScript and notice checks inspect the optional harness SDKs.

Read [AGENTS.md](AGENTS.md) for contributor rules and the [architecture](docs/ARCHITECTURE.md) for how Factory works and its safety invariants. Factory must never execute an Objective against its own source repository.

## Checks

Before submitting a code change, run:

```sh
npm run lint
npm run format:check
npm run notices:check
npm test
```

`npm test` type-checks and builds the project with `tsc`, then runs deterministic tests, including temporary Git and LFS repositories. These checks do not require provider credentials or a live GitHub target. The [Quality workflow](.github/workflows/quality.yml) runs the same checks on every pull request and on `main`. `npm run lint` applies Biome's recommended rules plus the deviations in `biome.json`; `npm run format` applies formatting.

During development, run an affected test directly after building:

```sh
npm run build
node --import ./test/support/isolated-state.mjs --test test/acceptance.test.mjs
```

Compare planner prompt, model or provider changes with [planning evals](docs/PLANNING-EVALS.md). Add a regression test for a concrete bug. For documentation-only changes, check the relevant commands, links, and formatting. Live acceptance is separate from deterministic testing: changes to GitHub delivery, process lifecycle, or binary content may also need a live run on a disposable target; minor releases are qualified that way under the [release procedure](docs/RELEASING.md).

## Pull requests

Link the issue, explain the user-visible change, and report the checks you ran. Keep each pull request focused on one complete outcome, with adjacent cleanup left out. Describe any remaining limitations and distinguish local test results from live acceptance evidence. Never include credentials, private repository content, raw agent transcripts, or private run details.

Preserve these boundaries:

- Keep Factory configuration, credentials, attempts, and snapshots outside target repositories.
- Preserve exact commit, tree, and GitHub head checks at publication and Objective completion.
- Target repositories own their product requirements, validation commands, access controls, and acceptance.

## Contributing versus using Factory

Factory contributors work directly on this repository. To use Factory for work in another repository, follow the [README](README.md) and the installed `director` and `setup` skills. Target owners can copy the [Objective issue form](docs/templates/objective.yml) into their own repository's `.github/ISSUE_TEMPLATE/` directory; it is not a bug-report form for Factory.

See the [governance policy](GOVERNANCE.md), [code of conduct](CODE_OF_CONDUCT.md), [support guide](SUPPORT.md), and [security policy](SECURITY.md) for participation and reporting. Factory uses the [MIT license](LICENSE).
