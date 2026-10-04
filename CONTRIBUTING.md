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

`npm test` runs `tsc` (type-check and build), then the deterministic tests, including temporary Git and LFS repositories. These checks need no provider credentials or live GitHub target.

The [Quality workflow](.github/workflows/quality.yml) runs these on every pull request and on `main`:

- Setup builds with `tsc`, so a type error fails every job.
- `checks` runs `npm run lint`, `npm run format:check` and `npm run notices:check`.
- `tests` runs the test files in 8 shards instead of `npm test`.
- `installed` packs and installs the package and tests the result (`node scripts/test-shards.mjs --installed`). It runs on `main` and at release, not on pull requests.

`npm run lint` is Biome's recommended rules plus the few deviations in `biome.json`, then `scripts/check-ts-directives.mjs`, which refuses `@ts-nocheck`, `@ts-ignore`, triple-slash references and `@ts-expect-error` without a reason in `src`. `npm run format` applies formatting.

`npm ci` installs a pre-commit hook (`.githooks/pre-commit`). It formats staged `.ts`, `.mts`, `.js`, `.mjs` and `.json` files with Biome, re-stages them, and runs `biome lint` on them. It does not run `tsc`, the directive check, or Prettier (Markdown, YAML, `package-lock.json`), so run the commands above before you push.

During development, run an affected test directly after building:

```sh
npm run build
node --import ./test/support/isolated-state.mjs --test test/acceptance.test.mjs
```

Compare planner prompt, model or provider changes with [planning evals](docs/PLANNING-EVALS.md). Add a regression test for a concrete bug. For documentation-only changes, check the relevant commands, links, and formatting. Live acceptance is separate from deterministic testing: changes to GitHub delivery, process lifecycle, or binary content may also need a live run on a disposable target; minor releases are qualified that way under the [release procedure](docs/RELEASING.md).

## Live crash-restart check

The fault tests run against a fake GitHub, which encodes our own assumptions about GitHub. `scripts/live-check.mjs` checks them against the real thing: it runs a three-item Objective in the private scratch repository `clockgrove/factory-smoke`, kills the controller at four points (after an issue, a PR and a merge are created, and mid final review), restarts it each time, and counts the result from GitHub alone. Its header lists the commands and kill points. Build first (`npm run build`).

`--worker scripted` swaps in the test harness's scripted planner, reviewer and worker, so a run makes no model calls and costs only GitHub time. Use it for any repeatable check; the default `real` worker is for qualification with real models. The run exits 1 unless the last launch completed, every kill point was reached, and GitHub holds one issue per Work Item, one PR per branch, one merge per PR and a closed Objective.

```sh
node scripts/live-check.mjs run --worker scripted --delivery regular
node scripts/live-check.mjs run --worker scripted --delivery native-stack
node scripts/live-check.mjs reset --objective N   # close what that run left
```

### Nightly run

[`.github/workflows/live-check.yml`](.github/workflows/live-check.yml) runs both deliveries with the scripted worker at 10:07 UTC every day, and on demand from the Actions tab. Runs never overlap (one concurrency group). It resets the fixture afterwards. On failure it opens, or comments on, the one open issue labelled `live-check`, with the per-delivery report in the body and the full reports as the `live-check-reports` workflow artifact. A pass comments on that issue only if one is open; close it once you understand the failure.

The workflow needs one repository secret, `FACTORY_SMOKE_TOKEN`: a fine-grained personal access token whose only repository is `clockgrove/factory-smoke`, with Contents, Issues and Pull requests read/write plus Checks and Commit statuses read. _Because_ the run merges and deletes branches, and nothing else should be reachable if the token leaks. Create it once, put an expiry reminder on it, and run `node scripts/live-check.mjs setup` once by hand (repository admin) to install the fixture's CI workflow and required check. Without the secret the first step fails and the issue says so.

## Pull requests

Link the issue, explain the user-visible change, and report the checks you ran. Keep each pull request focused on one complete outcome, with adjacent cleanup left out. Describe any remaining limitations and distinguish local test results from live acceptance evidence. Never include credentials, private repository content, raw agent transcripts, or private run details.

Preserve these boundaries:

- Keep Factory configuration, credentials, attempts, and snapshots outside target repositories.
- Preserve exact commit, tree, and GitHub head checks at publication and Objective completion.
- Target repositories own their product requirements, validation commands, access controls, and acceptance.

## Contributing versus using Factory

Factory contributors work directly on this repository. To use Factory for work in another repository, follow the [README](README.md) and the installed `director` and `setup` skills. Target owners can copy the [Objective issue form](docs/templates/objective.yml) into their own repository's `.github/ISSUE_TEMPLATE/` directory; it is not a bug-report form for Factory.

See the [governance policy](GOVERNANCE.md), [code of conduct](CODE_OF_CONDUCT.md), [support guide](SUPPORT.md), and [security policy](SECURITY.md) for participation and reporting. Factory uses the [MIT license](LICENSE).
