# Clockgrove Factory

Label a GitHub issue, walk away, come back to merged work.

[![Release](https://img.shields.io/github/v/release/clockgrove/factory)](https://github.com/clockgrove/factory/releases)
[![Quality](https://github.com/clockgrove/factory/actions/workflows/quality.yml/badge.svg)](https://github.com/clockgrove/factory/actions/workflows/quality.yml)
[![License: MIT](https://img.shields.io/github/license/clockgrove/factory)](LICENSE)

Factory turns an issue into a merged pull request with no one watching. You write the goal and what "done" means. A coding agent (Claude Code, Codex or GitHub Copilot) plans the work, builds it and answers one review, and Factory merges it once your own CI is green.

> **Status:** 0.9.x, the release candidate for 1.0. Run it on real work; there is no stability promise until 1.0 ([Versioning](#versioning)).

## How it works

1. **You label an issue `factory:objective`.** The issue is the whole specification.
2. **A worker plans and builds.** It posts its plan as a comment on the issue, implements with sub-agents and opens one PR.
3. **Your CI decides.** The worker waits for your required checks on the PR, and gets a bounded number of passes to fix a red.
4. **A reviewer comments once.** A second model call reads the diff against the issue, and the worker answers each comment once.
5. **Factory merges** exactly the reviewed commit once your required checks are green on it, through your merge queue when you have one.

Nothing asks you a question along the way. A run that cannot finish ends in one of two states, and neither holds up your other Objectives:

- **Blocked:** a draft PR and one comment with the reason.
- **Question:** a draft PR whose body asks the one thing a person must decide.

## Know before you start

- **Factory merges on its own by default.** Code lands with no human read. The gate is your CI, the reviewer pass and your merge queue. Set `FACTORY_AUTO_MERGE: false` to get ready-for-review PRs instead.
- **It spends money on model usage.** `max_usd` caps each job and `daily_usd` caps each day.
- **The agent never holds GitHub write access.** Factory makes every push, PR, comment and merge from the files the agent leaves. The agent's commands run in a sandbox, with no credential in their environment unless you opt one in ([docs/PLAN.md](docs/PLAN.md), Credentials and billing).
- **It works in one repository per Objective**, and acts only on an issue whose author can push to the repository or is a maintainer you name.

## Quick start

You need:

- a GitHub repository you administer, with a CI workflow on pull requests;
- the [`gh` CLI](https://cli.github.com), logged in, and Node 22 or newer;
- a model credential: an Anthropic API key, an OpenAI key or Vercel AI Gateway key for Codex, or a GitHub Copilot seat.

**1. Install the plugin** in Claude Code or Codex:

```sh
# Claude Code
claude plugin marketplace add https://github.com/clockgrove/factory.git
claude plugin install factory@clockgrove

# Codex
codex plugin marketplace add clockgrove/factory
codex plugin add factory@clockgrove
```

**2. Set up your repository.** Open a session in your repository's clone and run:

```
/factory:setup
```

It shows each change and waits for your yes. It writes `.github/workflows/factory.yml`, walks you through creating a GitHub App for this one repository, has you save the secrets, and applies the labels, the Project board and the merge queue.

**3. Check it.** Each line is PASS, WARN or FAIL with the fix; it changes nothing:

```
/factory:doctor
```

**4. File your first Objective.** Commit the workflow file to your default branch. Then open an issue like this one and add the `factory:objective` label:

```markdown
## Goal

`mytool --version` prints the version.

## Acceptance

- `mytool --version` prints the version from package.json and exits 0.
- A test covers it.
```

One comment on the issue shows the run's progress, and the labels show its state. [docs/USAGE.md](docs/USAGE.md) covers writing Objectives, following a run and answering a Question.

### Without the plugin

The same setup runs as scripts from a clone of Factory:

```sh
git clone --depth 1 --branch "$(gh release view --repo clockgrove/factory --json tagName --jq .tagName)" \
  https://github.com/clockgrove/factory.git ~/factory

# in your repository's clone
node ~/factory/plugin/scripts/setup.mjs  --repo OWNER/NAME --ci-checks "<your CI check names>"        # preview: prints each step
node ~/factory/plugin/scripts/setup.mjs  --repo OWNER/NAME --ci-checks "<your CI check names>" --yes  # apply
node ~/factory/plugin/scripts/doctor.mjs --repo OWNER/NAME --checkout .
```

The scripts do not create the GitHub App or save secrets: [docs/INSTALL.md](docs/INSTALL.md) lists both.

### Try it on your own machine first

Local mode runs the same worker and reviewer on your machine, on your own harness login, with no GitHub App: `factory serve`. It needs Linux or WSL2; on macOS it runs Claude Code and Codex only, with the sandbox verified but not run end to end. See [docs/LOCAL.md](docs/LOCAL.md).

## What Factory adds to your repository

- **One workflow file**, `.github/workflows/factory.yml`.
- **A GitHub App** you create and install on this one repository, with two secrets. Its permissions, one list: contents, pull requests, issues, projects: write; checks, commit statuses: read; actions: read, optional (cloud-sandbox logs and session restore); nothing else, never workflows.
- **A model credential**, saved as a secret and passed to the agent's process only.
- **GitHub settings:** the `factory:` labels, a Project board and a `factory` ruleset (merge queue and required checks).

Nothing else is installed. [docs/INSTALL.md](docs/INSTALL.md) has the full footprint, the cost inputs, and how to upgrade and uninstall.

## Where it runs

- **GitHub Actions (the default):** every job is a fresh hosted runner.
- **Local mode:** your own machine, started by `factory serve` or `factory run <issue>` ([docs/LOCAL.md](docs/LOCAL.md)).
- **Cloud sandbox (opt-in):** one pausable sandbox per Objective on Vercel Sandbox ([docs/ADAPTERS.md](docs/ADAPTERS.md)).

GitHub is the only state on every route: the branch, the PR, the issue's comments and labels, the board and the usage artifact. There is no server or database to host.

## Documentation

| Page | What it covers |
| --- | --- |
| [docs/USAGE.md](docs/USAGE.md) | Writing an Objective, following a run, Blocked and Question, the commands |
| [docs/INSTALL.md](docs/INSTALL.md) | The install footprint, credentials, cost inputs, upgrade and uninstall |
| [docs/LOCAL.md](docs/LOCAL.md) | Local mode: platforms, setup, sandboxes, settings |
| [docs/ADAPTERS.md](docs/ADAPTERS.md) | The cloud sandbox and the other third-party adapters |
| [docs/PLAN.md](docs/PLAN.md) | The design: rules, contracts, security, the 1.0 bar |
| [bench/README.md](bench/README.md) | The scorecard: walk-away, quality, operator minutes, cost |
| [Releases](https://github.com/clockgrove/factory/releases) | Release notes for every tag |

## Versioning

Factory is at 0.9.x, the release candidate for 1.0: run it on real work. The surface below is expected to hold, and 0.9.x releases are expected to be fixes underneath it, but there is no stability promise until 1.0.

- **Pin an exact tag** (`clockgrove/factory@vX.Y.Z`). Factory publishes no floating tag (no `v0`, no `v0.9`, no `v1`), and a ruleset keeps release tags from being moved or deleted. Reason: a run's behaviour is its tag's code, so nothing changes under you between runs.
- **Proposed to freeze at 1.0:** the Action's input names, the labels (`factory:objective`, `factory:running`, `factory:in-review`, `factory:question`, `factory:blocked`, `factory:review`, `factory:local`, `factory:image`, `P0` to `P2`), the markers Factory writes on issues and PRs, the App's permission set (above) and the workflow template's jobs (`dispatch`, `queue-watch`, `work`, `review`; on the sandbox route `launch`, `launch-gate`, `launch-event`, `launch-tick`, `image`, `sweep`). From 1.0, a 1.x release renames or removes none of them and asks the App for no new permission; it may add an optional input. Before 1.0, a 0.9.x release may still change one of them as the exception, and its release notes call the change out.
- **What makes 1.0:** five consecutive real Objectives merged with zero operator input, pooled across `clockgrove/clockgrove`, `clockgrove/assetgrove` and `clockgrove/raccoon-world` (never the scratch drill repositories), ordered by when each ended, on any harness; any miss on any of them resets it. One scorer command counts it: [docs/PLAN.md](docs/PLAN.md) (The 1.0 bar).
- **Supported:** the latest 0.9.x release gets security fixes; older tags do not.

## Help and contributing

- **Bugs, questions and ideas:** [open an issue](https://github.com/clockgrove/factory/issues). [CONTRIBUTING.md](CONTRIBUTING.md) says what helps in a report.
- **Security problems:** report them privately ([SECURITY.md](SECURITY.md)), never in a public issue.
- **Pull requests:** Factory takes no outside pull requests until its owner opens the repository to them; reaching 1.0 does not.

## License

[MIT](LICENSE) © Clockgrove
