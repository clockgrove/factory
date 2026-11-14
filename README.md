# Clockgrove Factory

Label a GitHub issue, walk away, come back to merged work.

[![Release](https://img.shields.io/github/v/release/clockgrove/factory)](https://github.com/clockgrove/factory/releases)
[![Quality](https://github.com/clockgrove/factory/actions/workflows/quality.yml/badge.svg)](https://github.com/clockgrove/factory/actions/workflows/quality.yml)
[![License: MIT](https://img.shields.io/github/license/clockgrove/factory)](LICENSE)

Factory turns an issue into a merged pull request with no one watching. You write the goal and what "done" means. A coding agent (Claude Code, Codex or GitHub Copilot) plans and builds the change, a second one reviews it, and Factory merges it once your own CI is green. That makes Factory exactly as safe as your CI: with no tests, it merges whatever builds.

> **Free and open source (MIT).** Factory charges nothing and has no paid tier or hosted service. What you pay for is your own: the model your coding agent uses, your CI runners, and a cloud sandbox if you choose one.

> **Status:** 0.9.x, the release candidate for 1.0. Run it on real work; there is no stability promise until 1.0 ([Versioning](#versioning)).

## How it works

1. **You label an issue `factory:objective`.** That issue is now an Objective. Its text is the whole specification: nobody is asked for more detail later.
2. **A worker plans and builds.** The worker is the coding agent. It posts its plan as a comment on the issue, writes the code and opens one pull request (PR).
3. **Your CI decides.** The worker waits for your required checks on the PR. If one fails, it gets a small fixed number of tries to fix it, normally two.
4. **A reviewer comments once.** The reviewer is a separate agent run that compares the change with the issue. The worker answers each comment once.
5. **Factory merges** exactly the commit that was reviewed, once your required checks are green on it. It goes through your merge queue when your repository has one.

A run never pauses halfway to wait for you. When it cannot merge on its own, it ends in one of two states and says why, and your other Objectives keep going:

- **Blocked:** the run could not get there, for example because a check still fails or a spending cap was reached. You get a draft PR and one comment with the reason.
- **Question:** the work depends on a decision that should be yours, such as changing a public interface. The worker finishes everything else, leaves the PR as a draft and asks the question in its body. You answer in a comment and mark the PR ready, and Factory carries on from there.

## Will it work for you?

- **You need CI that runs on pull requests.** Factory waits for your required checks and merges on them. A repository with no CI yet needs that first.
- **Private repositories need a GitHub plan with branch rules** (Pro, Team or Enterprise). Factory requires at least one required check on your default branch, and GitHub Free offers those on public repositories only. A merge queue is used where GitHub offers one (public repositories and Enterprise Cloud); elsewhere Factory uses strict required checks.
- **On GitHub Actions the agent bills an API key**, not your chat subscription: an Anthropic API key for Claude Code, an OpenAI API key or a Vercel AI Gateway key for Codex, or a token from an account with a Copilot seat for GitHub Copilot. Two ways use the subscription you already pay for: [local mode](#try-it-on-your-own-machine-first), and for Claude on your own repository, the `plan` credential ([docs/INSTALL.md](docs/INSTALL.md)).
- **You need admin rights on the repository**, the [`gh` CLI](https://cli.github.com) logged in, and Node 22 or newer.

## What it costs, and how to stay in control

Factory itself is free. Every cost goes to a provider you already pick and pay directly:

- **Your coding agent's model:** your Anthropic, OpenAI or Copilot account, or your Vercel AI Gateway key.
- **Your CI runners:** GitHub Actions minutes, or your own machine in local mode.
- **A cloud sandbox,** only if you opt in: your Vercel account.

Factory never handles a payment, and no bill comes from Clockgrove. To keep those costs in check:

- **Model usage is capped twice:** `max_usd` for each worker or reviewer job ($25 unless you change it) and `daily_usd` for each day ($100). A small change costs a dollar or a few; a large Objective can reach the job cap. Setup asks for both caps.
- **Runs take from about ten minutes to a few hours.** `timeout_minutes` bounds each job (240 by default), and up to three Objectives run at once (`max_concurrent`).
- **On a private repository the jobs use your Actions minutes**, including a short scheduled check every ten minutes.
- **For your first runs, start small:** when setup asks, set a low `max_usd`, `max_concurrent` of 1, and auto-merge off. With auto-merge off, Factory stops at a ready-for-review PR and you merge it yourself.
- **With auto-merge on, which is the default, nobody reads the code before it lands.** A change has to pass your required checks and the reviewer.
- **To stop everything,** disable the workflow (`gh workflow disable factory.yml`) and cancel any run in the Actions tab. [docs/INSTALL.md](docs/INSTALL.md) has the full uninstall.

## What it can touch

- **The worker and the reviewer cannot write to GitHub.** The worker only changes files in its own checkout, and Factory's scripts make every push, PR, comment and merge. On GitHub Actions they act as a GitHub App that you create for this one repository, not as you.
- **The commands a worker runs are sandboxed** and see none of your credentials unless you choose to share one.
- **Only people you trust can start a run.** Factory acts on an issue only when its author can push to the repository or is a maintainer you name during setup, so a stranger's issue cannot instruct the worker.
- **One repository per Objective.** An Objective that needs a change in another repository ends with a Question before any work starts.

## Quick start

**1. Install the plugin** in the coding agent you use:

```sh
# Claude Code
claude plugin marketplace add https://github.com/clockgrove/factory.git
claude plugin install factory@clockgrove

# Codex
codex plugin marketplace add clockgrove/factory
codex plugin add factory@clockgrove

# GitHub Copilot CLI
copilot plugin marketplace add clockgrove/factory
copilot plugin install factory@clockgrove
```

The plugin follows Factory's `main` branch. The workflow it writes for your repository pins the latest release tag.

**2. Ask it to set Factory up.** Open a session in your clone of the repository and say:

> Set up Factory for this repository.

The session follows Factory's setup skill. It asks a few questions first; the ones that matter on day one are the cost caps and auto-merge, and the defaults are fine for the rest. Then it shows each change and waits for your yes. It:

- writes Factory's workflow file, `.github/workflows/factory.yml`, which holds the jobs that run your Objectives, and opens a pull request that adds it;
- walks you through creating a GitHub App for this one repository, a few minutes in GitHub's settings: Factory writes to your repository as that App, never as you;
- has you save the App's two secrets and your model credential;
- creates the labels and a GitHub Project board that shows each Objective's state, and turns on required checks and, where GitHub offers one, the merge queue.

Merge that pull request when you are ready. Factory starts once the workflow file is on your default branch.

**3. Ask it to check the setup.**

> Is Factory set up correctly here?

The session runs Factory's doctor, which changes nothing. Each line it prints is PASS, WARN or FAIL, with the fix. Expect a FAIL or two the first time, for example when your repository's default workflow token can write; fix what it names and ask again.

**4. Tell it what to build.**

> File a Factory Objective: `mytool --version` should print the version from package.json.

The session writes the issue in the shape Factory reads, shows it to you, and on your yes creates it with the `factory:objective` label. That label starts the run. The issue looks like this:

```markdown
## Goal

`mytool --version` prints the version.

## Acceptance

- `mytool --version` prints the version from package.json and exits 0.
- A test covers it.
```

While the run goes, one comment on the issue shows its progress and the issue's labels show its state. You come back to a merged PR, or to a draft PR that says what it needs. [docs/USAGE.md](docs/USAGE.md) covers writing Objectives yourself, following a run, what to do when one is Blocked or has a Question, and the slash command behind each of these requests.

### Without the plugin

The same setup runs as scripts from a clone of Factory, with no coding agent involved: [docs/INSTALL.md](docs/INSTALL.md), Set it up.

### Try it on your own machine first

Local mode runs the same worker and reviewer on your machine, under the Claude Code, Codex or Copilot login you already have, with no GitHub App and no API key. It takes more machine setup instead: Linux or WSL2, a few sandbox packages, and a GitHub token for this one repository. It still reads its settings from the workflow file on your default branch. macOS support is partial: Claude Code and Codex only, and not yet proven on a full run. See [docs/LOCAL.md](docs/LOCAL.md).

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

Wherever it runs, Factory keeps all its state in GitHub: the branch, the PR, the issue's comments and labels, the board and a usage record for each job. There is no server or database to host.

## Documentation

| Page | What it covers |
| --- | --- |
| [docs/USAGE.md](docs/USAGE.md) | Writing an Objective, following a run, what to do when one is Blocked or has a Question, the commands |
| [docs/INSTALL.md](docs/INSTALL.md) | The install footprint, credentials, cost inputs, upgrade and uninstall |
| [docs/LOCAL.md](docs/LOCAL.md) | Local mode: platforms, setup, sandboxes, settings |
| [docs/ADAPTERS.md](docs/ADAPTERS.md) | The cloud sandbox and the other third-party adapters |
| [docs/PLAN.md](docs/PLAN.md) | The design: rules, contracts, security, the 1.0 bar |
| [bench/README.md](bench/README.md) | The scorecard: how Factory measures whether runs finish unattended, and what they cost |
| [Releases](https://github.com/clockgrove/factory/releases) | Release notes for every tag |

## Versioning

Factory is at 0.9.x, the release candidate for 1.0: run it on real work, but there is no stability promise until 1.0.

- **Pin an exact tag** (`clockgrove/factory@vX.Y.Z`); setup does this for you. Factory publishes no floating tag (no `v0`, no `v1`), and release tags cannot be moved or deleted, so nothing changes under you between runs.
- **Names may still change before 1.0.** A 0.9.x release may rename an input, a label or a job as the exception, and its release notes call the change out. [docs/PLAN.md](docs/PLAN.md) (The 1.0 bar) lists what freezes at 1.0 and what Factory must prove to get there.
- **Supported:** the latest 0.9.x release gets security fixes; older tags do not.

## Help and contributing

- **Bugs, questions and ideas:** [open an issue](https://github.com/clockgrove/factory/issues). [CONTRIBUTING.md](CONTRIBUTING.md) says what helps in a report.
- **Security problems:** report them privately ([SECURITY.md](SECURITY.md)), never in a public issue.
- **Pull requests:** Factory is not taking outside pull requests yet.

## License

[MIT](LICENSE) © Clockgrove
