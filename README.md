# Clockgrove Factory

Label a GitHub issue, walk away, come back to merged work.

[![Release](https://img.shields.io/github/v/release/clockgrove/factory)](https://github.com/clockgrove/factory/releases)
[![Quality](https://github.com/clockgrove/factory/actions/workflows/quality.yml/badge.svg)](https://github.com/clockgrove/factory/actions/workflows/quality.yml)
[![License: MIT](https://img.shields.io/github/license/clockgrove/factory)](LICENSE)

Factory turns an issue into a merged pull request with no one watching. You write the goal and what "done" means. A coding agent (Claude Code, Codex or GitHub Copilot) plans and builds the change, a second one reviews it, and Factory merges it once your own CI is green.

> **Status:** 0.9.x, the release candidate for 1.0. Run it on real work; there is no stability promise until 1.0 ([Versioning](#versioning)).

## How it works

1. **You label an issue `factory:objective`.** That issue is now an Objective. Its text is the whole specification: nobody is asked for more detail later.
2. **A worker plans and builds.** The worker is the coding agent. It posts its plan as a comment on the issue, writes the code and opens one pull request (PR).
3. **Your CI decides.** The worker waits for your required checks on the PR. If one fails, it gets a limited number of tries to fix it.
4. **A reviewer comments once.** The reviewer is a separate agent run that compares the change with the issue. The worker answers each comment once.
5. **Factory merges** exactly the commit that was reviewed, once your required checks are green on it. It uses your merge queue when you have one.

A run never pauses halfway to wait for you. When it cannot merge on its own, it ends in one of two states and says why, and your other Objectives keep going:

- **Blocked:** the run could not get there, for example because a check still fails or a spending cap was reached. You get a draft PR and one comment with the reason.
- **Question:** the work depends on a decision that should be yours, such as changing a public interface. The worker finishes everything else, leaves the PR as a draft and asks the question in its body. You answer in a comment and mark the PR ready, and Factory carries on from there.

## Know before you start

- **Factory merges on its own by default.** Nobody reads the code before it lands. A change has to pass your CI, the reviewer and your merge queue. To read changes yourself first, set `FACTORY_AUTO_MERGE: false` in the workflow file: Factory then stops at a ready-for-review PR.
- **It spends money on model usage.** You set two caps: `max_usd` for each worker or reviewer job, and `daily_usd` for each day.
- **The worker and the reviewer cannot write to GitHub.** The worker only changes files in its own checkout, and Factory's scripts make every push, PR, comment and merge. The commands a worker runs are sandboxed and see none of your credentials unless you opt one in ([docs/PLAN.md](docs/PLAN.md), Credentials and billing).
- **Only people you trust can start a run.** Factory acts on an issue only when its author can push to the repository or is a maintainer you name, so a stranger's issue cannot instruct the worker.
- **One repository per Objective.** An Objective that needs a change in another repository ends with a Question before any work starts.

## Quick start

You need:

- a GitHub repository you administer, with a CI workflow that runs on pull requests;
- the [`gh` CLI](https://cli.github.com), logged in, and Node 22 or newer;
- a credential for the coding agent you choose:
  - Claude Code: an Anthropic API key;
  - Codex: an OpenAI API key or a Vercel AI Gateway key;
  - GitHub Copilot: a token from an account with a Copilot seat.

**1. Install the plugin** in Claude Code or Codex:

```sh
# Claude Code
claude plugin marketplace add https://github.com/clockgrove/factory.git
claude plugin install factory@clockgrove

# Codex
codex plugin marketplace add clockgrove/factory
codex plugin add factory@clockgrove
```

**2. Set up your repository.** Open a Claude Code or Codex session in your clone of the repository and run:

```
/factory:setup
```

It shows each change and waits for your yes. It:

- writes the workflow file, `.github/workflows/factory.yml`;
- walks you through creating a GitHub App for this one repository;
- has you save the App's two secrets and your model credential;
- creates the labels and the Project board, and turns on required checks and, where GitHub offers one, the merge queue.

**3. Check the setup.** This command changes nothing. Each line it prints is PASS, WARN or FAIL, with the fix:

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

While the run goes, one comment on the issue shows its progress and the issue's labels show its state. You come back to a merged PR, or to a draft PR that says what it needs. [docs/USAGE.md](docs/USAGE.md) covers writing Objectives, following a run, and what to do when one is Blocked or has a Question.

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

The scripts do not create the GitHub App or save the secrets. [docs/INSTALL.md](docs/INSTALL.md) walks through both.

### Try it on your own machine first

Local mode runs the same worker and reviewer on your machine, under your own Claude Code, Codex or Copilot login, with no GitHub App. You start it with `factory serve`. It needs Linux or WSL2. macOS support is partial: Claude Code and Codex only, and not yet proven on a full run. See [docs/LOCAL.md](docs/LOCAL.md).

## What Factory adds to your repository

- **One workflow file**, `.github/workflows/factory.yml`.
- **A GitHub App** that you create and install on this one repository. Its ID and private key are two secrets. Its repository permissions: contents, pull requests, issues, projects: write; checks, commit statuses: read; actions: read, optional (cloud-sandbox logs and session restore); nothing else, never workflows.
- **A model credential**, saved as a secret and handed only to the worker's and the reviewer's own process.
- **GitHub settings:** the `factory:` labels, a Project board, and a ruleset named `factory` that turns on your required checks and the merge queue.

Nothing else is installed. [docs/INSTALL.md](docs/INSTALL.md) has the full footprint, the cost inputs, and how to upgrade and uninstall.

## Where it runs

- **GitHub Actions (the default):** each job runs on a fresh runner.
- **Local mode:** your own machine, started by `factory serve` or `factory run <issue>` ([docs/LOCAL.md](docs/LOCAL.md)).
- **Cloud sandbox (opt-in):** one pausable sandbox per Objective on Vercel Sandbox ([docs/ADAPTERS.md](docs/ADAPTERS.md)).

Wherever it runs, Factory keeps all its state in GitHub: the branch, the PR, the issue's comments and labels, the board and a usage artifact. There is no server or database to host.

## Documentation

| Page | What it covers |
| --- | --- |
| [docs/USAGE.md](docs/USAGE.md) | Writing an Objective, following a run, what to do when one is Blocked or has a Question, the commands |
| [docs/INSTALL.md](docs/INSTALL.md) | The install footprint, credentials, cost inputs, upgrade and uninstall |
| [docs/LOCAL.md](docs/LOCAL.md) | Local mode: platforms, setup, sandboxes, settings |
| [docs/ADAPTERS.md](docs/ADAPTERS.md) | The cloud sandbox and the other third-party adapters |
| [docs/PLAN.md](docs/PLAN.md) | The design: rules, contracts, security, the 1.0 bar |
| [bench/README.md](bench/README.md) | The scorecard: walk-away, quality, operator minutes, cost |
| [Releases](https://github.com/clockgrove/factory/releases) | Release notes for every tag |

## Versioning

Factory is at 0.9.x, the release candidate for 1.0: run it on real work. The names and permissions listed below are expected to hold, and 0.9.x releases are expected to be fixes underneath them, but there is no stability promise until 1.0.

- **Pin an exact tag** (`clockgrove/factory@vX.Y.Z`). Factory publishes no floating tag (no `v0`, no `v0.9`, no `v1`), and a ruleset keeps release tags from being moved or deleted. Reason: a run's behaviour is its tag's code, so nothing changes under you between runs.
- **Proposed to freeze at 1.0:** the Action's input names, the labels (`factory:objective`, `factory:running`, `factory:in-review`, `factory:question`, `factory:blocked`, `factory:review`, `factory:local`, `factory:image`, `P0` to `P2`), the markers Factory writes on issues and PRs, the App's permission set (above) and the workflow template's jobs (`dispatch`, `queue-watch`, `work`, `review`; on the sandbox route `launch`, `launch-gate`, `launch-event`, `launch-tick`, `image`, `sweep`). From 1.0, a 1.x release renames or removes none of them and asks the App for no new permission; it may add an optional input. Before 1.0, a 0.9.x release may still change one of them as the exception, and its release notes call the change out.
- **What makes 1.0:** five consecutive real Objectives merged with no human input after the label, counted together across `clockgrove/clockgrove`, `clockgrove/assetgrove` and `clockgrove/raccoon-world` (never the scratch drill repositories), ordered by when each ended, on any harness; any miss on any of them resets it. One scorer command counts it: [docs/PLAN.md](docs/PLAN.md) (The 1.0 bar).
- **Supported:** the latest 0.9.x release gets security fixes; older tags do not.

## Help and contributing

- **Bugs, questions and ideas:** [open an issue](https://github.com/clockgrove/factory/issues). [CONTRIBUTING.md](CONTRIBUTING.md) says what helps in a report.
- **Security problems:** report them privately ([SECURITY.md](SECURITY.md)), never in a public issue.
- **Pull requests:** Factory takes no outside pull requests for now. Its owner will say when that changes; reaching 1.0 does not change it by itself.

## License

[MIT](LICENSE) © Clockgrove
