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

`npm run test:core` builds Factory and runs its integration suite against real temporary Git repositories, processes and files, including the packed CLI installed offline. These checks need no provider credentials or live GitHub target. `npm test` runs the old implementation's suite until it is removed.

The [Quality workflow](.github/workflows/quality.yml) runs lint, format and notice checks plus one integration-test job on every pull request and on `main`. The required `package-gate` passes only when both jobs succeed. Release also verifies the exact tarball it publishes.

`npm run lint` uses Biome. `npm run format` applies formatting. Commits do not install hooks or re-stage files; CI enforces the checks.

For an affected integration check after the batch, build and run its file directly:

```sh
npm run build
node --import ./test/isolate-env.mjs --test test/git-registry-lock.test.mjs
```

Keep coverage within the [coverage rules](AGENTS.md#coverage-and-model-contracts); CI runs the complete small suite.

### Recovery end-to-end test

`scripts/recovery-e2e.mjs` stops, times out and crashes real runs on a Project-queue installation, then recovers them only through `factory run`, `retry`, `decide`, `cancel`, `queue` and `status --json`. It asserts exit codes and JSON fields, never output text. It runs on demand and is not part of `npm test` or any release gate: it needs a Claude login and an authenticated `gh`, and it spends real model calls (the cheapest capable model at `low` effort by default).

| Scenario | Fault                                                | Recovery it proves                                                                                 |
| -------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `s1`     | controller SIGKILL while the compile call runs       | the next run settles the abandoned turn and completes                                              |
| `s2a`    | the queue's Objective deadline passes during compile | the run exits 1 cancelled, a repeated `cancel` reconciles and `decide --outcome refuse` is refused |
| `s2b`    | SIGSTOP of the planner until its inactivity timeout  | `retry` and the next run re-plan and complete                                                      |
| `s3`     | plan revision                                        | skipped: no supported way forces one; each row reports the revisions it used                       |
| `s4`     | controller SIGKILL while a worker attempt runs       | a run while the worker lives is held without effects; after it ends, a run collects and completes  |
| `s5`     | controller SIGKILL during result review              | the stopped run hands off after the collected result and completes                                 |
| `s6`     | a command in the run's control-socket exit window    | the `retry` sent there (during `s2b`) waits for the exiting owner and succeeds                     |
| `s7`     | `cancel` of a queued Objective while its worker runs | the worker stops, claims settle and the next queued Objective runs and completes                   |

After each scenario it checks the `status --json` phase, settled agent sessions, one Work Item issue and at most one recorded PR per item, settled Project queue owner claims, an acknowledged checkpoint with no pending changes, and that none of its processes is left running.

Every run uses a new isolated installation under `--root`: its own `XDG_STATE_HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME` and `XDG_CACHE_HOME`, a fresh checkout, the worktree's `dist/cli.js`, a new archive ref and a new queue control card. It signals only processes whose environment names its own state root, and it never reads or writes your installed Factory configuration, state or service. It installs no systemd unit: `supervisor serve` needs the registration from `setup --background`, so `s7` dispatches the next queued Objective with a foreground run, which takes the same Project claim. `s2a` sets `queue.objectiveDeadlineSeconds` for its own Objective, then removes it, re-authorizing the queue with `queue resume` each time.

Prepare a disposable fixture once. Use a private repository you own that holds only test content, because each run resets it:

1. A private repository with a small Node.js project whose README declares `npm test`, and a tag (for example `fixture-base`) on its initial commit. Each run closes its open issues and pull requests and force-resets `main` to that tag.
2. A separate empty private repository for the checkpoint archive.
3. An organization Project linked to the repository, with a TEXT field named `Factory metadata` and a NUMBER field named `Factory order`. Each run deletes its items and adds a new control card.

Then describe it in a private JSON file and run the test from a built checkout:

```json
{
  "repository": "OWNER/fixture",
  "baseRef": "fixture-base",
  "project": { "owner": "OWNER", "number": 6 },
  "archive": "https://github.com/OWNER/fixture-archive.git",
  "model": "claude-sonnet-5-5",
  "effort": "low"
}
```

```sh
npm run build
node scripts/recovery-e2e.mjs --fixture /abs/fixture.json --root /abs/scratch [--scenarios s1,s4]
```

It prints one row per scenario with its result, minutes, tokens and model calls, writes every check and note to `report.json` in the run directory, and exits 1 when any check fails. Controller logs are in the run directory's `logs/`. A failure that shows a Factory defect is filed as its own bug.

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
