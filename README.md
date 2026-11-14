# Clockgrove Factory

Label a GitHub issue, walk away, come back to merged work.

[![Release](https://img.shields.io/github/v/release/clockgrove/factory)](https://github.com/clockgrove/factory/releases)
[![Quality](https://github.com/clockgrove/factory/actions/workflows/quality.yml/badge.svg)](https://github.com/clockgrove/factory/actions/workflows/quality.yml)
[![License: MIT](https://img.shields.io/github/license/clockgrove/factory)](LICENSE)

Factory turns an issue into a merged pull request with no one watching. You write the goal and what "done" means. A coding agent (Claude Code, Codex or GitHub Copilot) plans and builds the change, a second one reviews it, and by default Factory merges it once your own CI is green. Your CI is the only test of whether the change is correct: with no tests, Factory merges whatever your CI lets through, except changes to protected files such as your workflows, which it refuses, and decisions it hands back to you as Questions.

> **Free and open source (MIT).** Factory charges nothing and has no paid tier or hosted service. What you pay for is your own: the model your coding agent uses, your CI runners, and a cloud sandbox if you choose one.

> **Status:** 0.9.x, the release candidate for 1.0. Run it on real work; there is no stability promise until 1.0 ([Versioning](#versioning)).

## How it works

1. **You label an issue `factory:objective`.** That issue is now an Objective. Write everything the work needs into it: the worker reads it as the whole specification.
2. **A worker plans and builds.** The worker is the coding agent. It writes a plan and the code, and Factory posts the plan on the issue and opens one pull request (PR). A large Objective arrives as up to six PRs, one at a time.
3. **Your CI decides.** The worker waits for your required checks on the PR. If one fails, the worker gets one try to fix it, and in a few cases one more, for example when only your CI, not the worker's own run of your commands, found the failure.
4. **A reviewer comments once.** The reviewer is a separate agent run that compares the change with the issue. The worker answers each comment once.
5. **Factory merges** the commit that was reviewed, once your required checks are green on it, through your merge queue when your repository has one. Without a queue, a PR that only fell behind your default branch is brought up to date by GitHub, and that update is what merges.

A run that goes well needs nothing from you. When one needs you, Factory does all the work it can first and then hands the Objective back to you in one of two states. Your other Objectives keep running meanwhile.

- **Blocked:** Factory could not finish, for example because a check still fails or a spending cap was reached. One comment on the issue gives the reason, and the PR, if it opened one, becomes a draft. Fix the cause, then label the issue `factory:objective` again: it continues from its branch and PR.
- **Question:** the work depends on a decision that should be yours, such as changing a public interface. The worker finishes everything else and asks what it needs decided in the draft PR's body. You answer in a comment and mark the PR ready, and Factory continues from there. A Question about working in another repository comes earlier, on the issue itself, before any code (below).

## Will it work for you?

- **You need CI that runs on pull requests.** Factory waits for your required checks and merges on them. A repository with no CI yet needs that first.
- **Private repositories need GitHub Pro, Team or Enterprise Cloud.** Factory requires at least one required check on your default branch, and GitHub Free offers branch rules on public repositories only. A merge queue is used where GitHub offers one (repositories owned by an organization: public ones, and private ones on Enterprise Cloud); elsewhere Factory uses strict required checks.
- **You need a model credential that GitHub Actions can use:**
  - Claude Code: an Anthropic API key, billed per use. On a repository of your own you can use your Claude subscription instead (the `plan` credential, [docs/INSTALL.md](docs/INSTALL.md)).
  - Codex: an OpenAI API key or a Vercel AI Gateway key, billed per use. On Actions there is no subscription option for Codex; your ChatGPT plan works in local mode only.
  - GitHub Copilot: a token from an account with a Copilot seat. Runs are billed to that seat as AI credits, like your own Copilot use.

  [Local mode](#run-it-on-your-own-machine-instead) runs Claude Code and Codex on the login you already have, with no API key; Copilot still needs its token there.
- **You need admin rights on the repository**, the [`gh` CLI](https://cli.github.com) logged in, and Node 22 or newer.

## What it costs, and how to stay in control

Factory itself is free. Every cost goes to a provider you already pick and pay directly:

- **Your coding agent's model:** your Anthropic, OpenAI or Copilot account, or your Vercel AI Gateway key.
- **Your CI runners:** GitHub Actions minutes, or your own machine in local mode.
- **A cloud sandbox,** only if you opt in: your Vercel account.

Factory never handles a payment, and no bill comes from Clockgrove. To keep those costs in check:

- **Model usage is capped twice:** `max_usd` for each worker or reviewer job ($25 unless you change it) and `daily_usd` for each day ($100). A small change costs a dollar or a few; a large Objective can reach the job cap. Setup asks for both caps. Two exceptions: a Codex model missing from Factory's price table runs uncapped (doctor warns about it), and a run inside your own agent session (`/factory:factory-run --here`) is neither capped nor counted.
- **To run one Objective on a cheaper or a stronger model,** or another harness, label its issue (`factory:model:<id>`, `factory:harness:<name>`, and sub-agent and reviewer labels): the workflow's harness and models stay the defaults for the rest ([docs/USAGE.md](docs/USAGE.md), Choose the harness and models).
- **Runs take from about ten minutes to a few hours.** `timeout_minutes` bounds each job (240 by default), and up to three Objectives run at once (`max_concurrent`). Starting one by hand (`gh workflow run factory.yml -f issue=<number>`) runs it even when that limit is reached.
- **On a private repository the jobs use your Actions minutes**, including a short scheduled check every ten minutes.
- **For your first runs, start small:** when setup asks, set a low `max_usd`, `max_concurrent` of 1, and auto-merge off. With auto-merge off, Factory stops at a ready-for-review PR and you merge it yourself.
- **With auto-merge on, which is the default, nobody reads the code before it lands.** What stands between a change and your default branch is your required checks; the reviewer only comments, and the worker has to answer each comment.
- **To stop one Objective,** remove its `factory:objective` label or close its issue, or ask "Stop Clockgrove Factory Objective 12". A running stage ends within about two minutes with its spend recorded, its PR becomes a draft, and nothing picks it up again until you re-apply the label; your other Objectives keep running ([docs/USAGE.md](docs/USAGE.md), An Objective's lifecycle).
- **To restart one from its current text,** in any state, label its issue `factory:restart`, or ask "Restart Clockgrove Factory Objective 12". A running stage stops first; the earlier PR is closed with a comment, its branch deleted, and the run starts over from the default branch.
- **To stop everything,** disable the workflow (`gh workflow disable factory.yml`) and cancel any run in the Actions tab. With the cloud sandbox, also stop the Objective's sandboxes in your Vercel project: a stage already running there is not an Actions run. In local mode, stop `factory serve` with Ctrl-C. [docs/INSTALL.md](docs/INSTALL.md) has the full uninstall.

## What it can touch

- **On every route Factory runs (GitHub Actions, local mode, the cloud sandbox), the worker and the reviewer cannot write to GitHub.** The worker only changes files in its own checkout, and Factory's scripts make every push, PR, comment and merge. On GitHub Actions they act as a GitHub App that you create for this one repository; in local mode, with a token you create for this one repository (and, if you add the App's key, as the App for Blocked and Question notices).
- **The commands a worker runs are sandboxed** there and see none of your credentials unless you choose to share one. The exceptions are the commands that run inside your own agent session, `/factory:factory-run --here` and `/factory:factory-review` ([docs/USAGE.md](docs/USAGE.md)): they are not Factory's routes and work as you, unsandboxed, with your own GitHub login.
- **Only people you trust can start a run.** Factory acts on an issue only when its author can push to the repository or is a maintainer you name during setup, so a stranger's issue cannot instruct the worker.
- **One repository per Objective.** An Objective that needs a change in another repository stops before any code is written, with a Question on the issue.

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

**2. Ask it to set Clockgrove Factory up.** Open a session in your clone of the repository and say:

> Set up Clockgrove Factory for this repository.

Use the full name in requests like this one: it is what Factory's skills answer to, and it keeps your agent from picking up another product called Factory.

The session follows Factory's `factory-setup` skill. It asks a few questions first; the ones that matter on day one are the cost caps and auto-merge, and the defaults are fine for the rest. Then it shows each change and waits for your yes. It:

- writes Factory's workflow file, `.github/workflows/factory.yml`, which holds the jobs that run your Objectives, and opens a pull request that adds it;
- walks you through creating a GitHub App for this one repository, a few minutes in GitHub's settings: on GitHub Actions, Factory writes to your repository as that App rather than as you;
- has you save the App's two secrets and your model credential;
- creates the labels and, on a repository an organization owns, a GitHub Project board that shows each Objective's state, requires your CI's checks on the default branch, adds a merge queue where GitHub offers one, and sets squash merges to use each PR's title and body.

Merge that pull request when you are ready. Factory starts once the workflow file is on your default branch.

**3. Ask it to check the setup.**

> Is Clockgrove Factory set up correctly here?

The session runs Factory's doctor, which changes nothing. Each line it prints is PASS, WARN or FAIL, with the fix. Expect a FAIL or two the first time, for example when your repository's default workflow token can write; fix what it names and ask again.

**4. Tell it what to build.**

> File a Clockgrove Factory Objective: `mytool --version` should print the version from package.json.

The session writes the issue in the shape Factory reads, shows it to you, and asks whether to start it now, save it as a draft, or keep discussing. Started, it carries the `factory:objective` label, which starts the run. A draft carries `factory:draft` instead, which Factory never runs: say "Let's keep working on Clockgrove Factory Objective 12" to refine it in a later session (changes are saved to the issue on your yes), and "Start Clockgrove Factory Objective 12" when it is ready. The issue looks like this:

```markdown
## Goal

`mytool --version` prints the version.

## Acceptance

- `mytool --version` prints the version from package.json and exits 0.
- A test covers it.
```

While the run goes, one comment on the issue shows its progress and the issue's labels show its state. You come back to a merged PR; with auto-merge off, to a PR ready for you to merge; or to the issue handed back as Blocked or with a Question. [docs/USAGE.md](docs/USAGE.md) covers writing Objectives yourself, following a run, what to do when one is Blocked or has a Question, and the slash command behind each of these requests.

### Without the plugin

The same setup runs as scripts from a clone of Factory, with no coding agent involved: [docs/INSTALL.md](docs/INSTALL.md), Set it up.

### Run it on your own machine instead

Local mode runs the same worker and reviewer on your machine. Claude Code and Codex run on the login you already have; Copilot uses the same seat token as on Actions. It needs no GitHub App and no secrets stored in GitHub, but more machine setup: Linux or WSL2 (macOS partly, below), a few sandbox packages, and a GitHub token for this one repository. It reads its settings (models, caps, validation commands) from the workflow file on your default branch and runs on defaults without one, so say "Set up Clockgrove Factory in local mode" and the factory-setup skill sets up both. macOS support is partial: Claude Code and Codex only, and not yet proven on a full run. See [docs/LOCAL.md](docs/LOCAL.md).

## Skills

Factory is a plugin of [Agent Skills](https://agentskills.io): one folder per skill under [`plugin/skills/`](plugin/skills/), each a `SKILL.md` that Claude Code, Codex and GitHub Copilot CLI load the same way. Ask in plain words with the full name, Clockgrove Factory. In Claude Code each skill is also a slash command, `/factory:<skill>`; Codex and Copilot list them among their own skills.

| Skill | Say | What it does |
| --- | --- | --- |
| [`factory-setup`](plugin/skills/factory-setup/SKILL.md) | "Set up Clockgrove Factory for this repository." | Installs Factory one consented step at a time and opens the pull request that adds the workflow file |
| [`factory-doctor`](plugin/skills/factory-doctor/SKILL.md) | "Is Clockgrove Factory set up correctly here?" | Checks the repository, its settings, the credential and the runner; changes nothing |
| [`factory-file`](plugin/skills/factory-file/SKILL.md) | "File a Clockgrove Factory Objective: ..." | Writes what you describe as an Objective issue, shows it, and creates it on your yes, started or as a draft |
| [`factory-draft`](plugin/skills/factory-draft/SKILL.md) | "Let's keep working on Clockgrove Factory Objective 12." | Loads the draft from GitHub to refine it with you, and saves the changes back on your yes |
| [`factory-start`](plugin/skills/factory-start/SKILL.md) | "Start Clockgrove Factory Objective 12." | Starts a draft on your yes, after the trust check: takes `factory:draft` off and applies `factory:objective` |
| [`factory-stop`](plugin/skills/factory-stop/SKILL.md) | "Stop Clockgrove Factory Objective 12." | Removes the Objective's label on your yes: its running stage ends and nothing picks it up again |
| [`factory-restart`](plugin/skills/factory-restart/SKILL.md) | "Restart Clockgrove Factory Objective 12." | Applies `factory:restart` on your yes: the Objective starts over from the issue's current text |
| [`factory-run`](plugin/skills/factory-run/SKILL.md) | "Run Clockgrove Factory Objective 42 here." | Runs one Objective on this machine, in local mode or in the session itself |
| [`factory-review`](plugin/skills/factory-review/SKILL.md) | "Review Clockgrove Factory PR 57." | Runs the reviewer on one Factory PR in your session |
| [`factory-serve`](plugin/skills/factory-serve/SKILL.md) | "Start the Clockgrove Factory local loop." | Starts the local loop ([docs/LOCAL.md](docs/LOCAL.md)) |
| [`factory-queue`](plugin/skills/factory-queue/SKILL.md) | "Start the Clockgrove Factory queue." | Starts the unattended scheduler for the repository |
| [`factory-handover`](plugin/skills/factory-handover/SKILL.md) | "Apply the Clockgrove Factory workflow hand-over for Objective 12." | Puts the workflow change Factory handed over on a new branch and shows it; pushes it and opens its PR only after you read it and say yes |
| [`factory-score`](plugin/skills/factory-score/SKILL.md) | "Show the Clockgrove Factory scorecard." | Prints the scorecard: walk-away, quality, operator minutes, cost |

Six more are loaded for you. The worker follows [`factory-objective-plan`](plugin/skills/factory-objective-plan/SKILL.md), [`factory-implement-split`](plugin/skills/factory-implement-split/SKILL.md), [`factory-prove-acceptance`](plugin/skills/factory-prove-acceptance/SKILL.md) and [`factory-deliver-pr`](plugin/skills/factory-deliver-pr/SKILL.md), in that order; the reviewer follows [`factory-review-pr`](plugin/skills/factory-review-pr/SKILL.md); and `factory-score` loads [`factory-scoring`](plugin/skills/factory-scoring/SKILL.md).

Install Factory as a plugin (Quick start, step 1). Skill-only installers such as `npx skills add` and `gh skill install` copy the skill folders but not the plugin's scripts, which the setup, doctor, run, serve, queue, review, handover and score skills run, so those skills do not work installed that way.

## What Factory adds to your repository

- **One workflow file**, `.github/workflows/factory.yml`.
- **A GitHub App** that you create and install on this one repository. Its ID and private key are two secrets. Its permissions: contents, pull requests, issues, projects: write; checks, commit statuses: read; actions: read, optional (cloud-sandbox logs and session restore); nothing else, never workflows. Projects is under Organization permissions in the App's settings, and a repository a user owns needs none; the rest are Repository permissions.
- **A model credential**, saved as a secret and handed only to the worker's and the reviewer's own process.
- **GitHub settings:** the `factory:` labels, a Project board (on a repository an organization owns; elsewhere the labels carry each Objective's state), a ruleset named `factory` that requires your CI's checks (and adds the merge queue where GitHub offers one), and squash merges that take each PR's title and body.

Nothing else is added unless you accept it: setup offers to commit Factory's skills to the repository, which the agents' cloud sessions need. [docs/INSTALL.md](docs/INSTALL.md) has the full footprint, the cost inputs, and how to upgrade and uninstall.

## Where it runs

- **GitHub Actions (the default):** each job runs on a fresh GitHub-hosted runner, unless you name a runner of your own.
- **Local mode:** your own machine, started by `factory serve` or `factory run <issue>` ([docs/LOCAL.md](docs/LOCAL.md)).
- **Cloud sandbox (opt-in):** one pausable sandbox per Objective on Vercel Sandbox ([docs/ADAPTERS.md](docs/ADAPTERS.md)).

Wherever it runs, Factory keeps each Objective's state in GitHub: the branch, the PR, the issue's comments and labels, the board and a usage record for each job. There is no server or database to host.

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

- **Pin an exact tag** (`clockgrove/factory@vX.Y.Z`); setup does this for you. Factory publishes no floating tag (no `v0`, no `v1`), and release tags cannot be moved or deleted, so what your workflow runs does not change until you upgrade. The plugin in your coding agent follows `main` instead, and with it the setup, doctor and file skills.
- **Names may still change before 1.0.** A 0.9.x release may rename an input, a label or a job as the exception, and its release notes call the change out. [docs/PLAN.md](docs/PLAN.md) (The 1.0 bar) lists what freezes at 1.0 and what Factory must prove to get there.
- **Supported:** the latest 0.9.x release gets security fixes; older tags do not.

## Help and contributing

- **Bugs, questions and ideas:** [open an issue](https://github.com/clockgrove/factory/issues). [CONTRIBUTING.md](CONTRIBUTING.md) says what helps in a report.
- **Security problems:** report them privately ([SECURITY.md](SECURITY.md)), never in a public issue.
- **Pull requests:** Factory is not taking outside pull requests yet.

## License

[MIT](LICENSE) © Clockgrove
