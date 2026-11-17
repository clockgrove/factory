# Clockgrove Pendulum

Label a GitHub issue, walk away, come back to merged work.

[![Release](https://img.shields.io/github/v/release/clockgrove/pendulum)](https://github.com/clockgrove/pendulum/releases)
[![Quality](https://github.com/clockgrove/pendulum/actions/workflows/quality.yml/badge.svg)](https://github.com/clockgrove/pendulum/actions/workflows/quality.yml)
[![License: MIT](https://img.shields.io/github/license/clockgrove/pendulum)](LICENSE)

Pendulum turns an issue into a merged pull request with no one watching. You write the goal and what "done" means. A coding agent (Claude Code, Codex or GitHub Copilot) plans and builds the change, a second one reviews it, and by default Pendulum merges it once your own CI is green. Your CI is the only test of whether the change is correct: with no tests, Pendulum merges whatever your CI lets through, except changes to protected files such as your workflows, which it refuses, and decisions it hands back to you as Questions.

> **Free and open source (MIT).** Pendulum charges nothing and has no paid tier or hosted service. What you pay for is your own: the model your coding agent uses, your CI runners, and a cloud sandbox if you choose one.

> **Status:** 0.10.x, the release candidate for 1.0. Run it on real work; there is no stability promise until 1.0 ([Versioning](#versioning)).

## How it works

1. **You label an issue `pendulum:objective`.** That issue is now an Objective. Write everything the work needs into it: the worker reads it as the whole specification.
2. **A worker plans and builds.** The worker is the coding agent. It writes a plan and the code, and Pendulum posts the plan on the issue and opens one pull request (PR). A large Objective arrives as up to six PRs, one at a time.
3. **Your CI decides.** The worker waits for your required checks on the PR. If one fails, the worker gets one try to fix it, and in a few cases one more, for example when only your CI, not the worker's own run of your commands, found the failure.
4. **A reviewer comments once.** The reviewer is a separate agent run that compares the change with the issue. The worker answers each comment once.
5. **Pendulum merges** the commit that was reviewed, once your required checks are green on it, through your merge queue when your repository has one. Without a queue, a PR that only fell behind your default branch is brought up to date by GitHub, and that update is what merges.

A run that goes well needs nothing from you. When one needs you, Pendulum does all the work it can first and then hands the Objective back to you in one of two states. Your other Objectives keep running meanwhile.

- **Blocked:** Pendulum could not finish, for example because a check still fails or a spending cap was reached. One comment on the issue gives the reason, and the PR, if it opened one, becomes a draft. Fix the cause, then label the issue `pendulum:objective` again: it continues from its branch and PR.
- **Question:** the work depends on a decision that should be yours, such as changing a public interface. The worker finishes everything else and asks what it needs decided in the draft PR's body. You answer in a comment and mark the PR ready, and Pendulum continues from there. A Question about working in another repository comes earlier, on the issue itself, before any code (below).

## Will it work for you?

- **You need CI that runs on pull requests.** Pendulum waits for your required checks and merges on them. A repository with no CI yet needs that first.
- **Private repositories need GitHub Pro, Team or Enterprise Cloud.** Pendulum requires at least one required check on your default branch, and GitHub Free offers branch rules on public repositories only. A merge queue is used where GitHub offers one (repositories owned by an organization: public ones, and private ones on Enterprise Cloud); elsewhere Pendulum uses strict required checks.
- **You need a model credential that GitHub Actions can use:**
  - Claude Code: an Anthropic API key, billed per use. On a repository of your own you can use your Claude subscription instead (the `plan` credential, [docs/INSTALL.md](docs/INSTALL.md#claude-on-your-subscription)).
  - Codex: an OpenAI API key or a Vercel AI Gateway key, billed per use. On Actions there is no subscription option for Codex; your ChatGPT plan works in local mode only.
  - GitHub Copilot: a token from an account with a Copilot seat. Runs are billed to that seat as AI credits, like your own Copilot use.

  [Local mode](#run-it-on-your-own-machine-instead) runs Claude Code and Codex on the login you already have, with no API key; Copilot still needs its token there.
- **You need admin rights on the repository**, the [`gh` CLI](https://cli.github.com) logged in, and Node 22 or newer.

## What it costs, and how to stay in control

Pendulum itself is free. Every cost goes to a provider you already pick and pay directly:

- **Your coding agent's model:** your Anthropic, OpenAI or Copilot account, or your Vercel AI Gateway key.
- **Your CI runners:** GitHub Actions minutes, or your own machine in local mode.
- **A cloud sandbox,** only if you opt in: your Vercel account.

Pendulum never handles a payment, and no bill comes from Clockgrove. To keep those costs in check:

- **Model usage is capped twice:** `max_usd` for each worker or reviewer job ($25 unless you change it) and `daily_usd` for each day ($100). A small change costs a dollar or a few; a large Objective can reach the job cap. Setup asks for both caps. Two exceptions: a Codex model missing from Pendulum's price table runs uncapped (doctor warns about it), and a run inside your own agent session (`/pendulum:pendulum-run --here`) is neither capped nor counted.
- **To run one Objective on a cheaper or a stronger model,** or another coding agent, label its issue (`pendulum:model:<id>`, `pendulum:harness:<name>`, and sub-agent and reviewer labels): the workflow's coding agent and models stay the defaults for the rest ([docs/USAGE.md](docs/USAGE.md), Choose the harness and models).
- **Several subscriptions or keys of one coding agent work as one pool.** Declare them as accounts, and with automatic choice on, each worker or reviewer run starts on the free one with the most quota left, as Claude Code and Codex report it on each run: a usage limit sets aside only the account that met it, runs go on on the others, and that account comes back into use on its own. Set it up for your machine in [docs/LOCAL.md](docs/LOCAL.md) (Accounts), for GitHub Actions and the cloud sandbox in [docs/INSTALL.md](docs/INSTALL.md) (Several accounts).
- **Runs take from about ten minutes to a few hours.** `timeout_minutes` bounds each job (240 by default), and up to three Objectives run at once (`max_concurrent`). Starting one by hand (`gh workflow run pendulum.yml -f issue=<number>`) runs it even when that limit is reached.
- **On a private repository the jobs use your Actions minutes**, including a short scheduled check every ten minutes.
- **For your first runs, start small:** when setup asks, set a low `max_usd`, `max_concurrent` of 1, and auto-merge off. With auto-merge off, Pendulum stops at a ready-for-review PR and you merge it yourself.
- **With auto-merge on, which is the default, nobody reads the code before it lands.** What stands between a change and your default branch is your required checks; the reviewer only comments, and the worker has to answer each comment.
- **To stop one Objective,** remove its `pendulum:objective` label or close its issue, or ask "Stop Clockgrove Pendulum Objective 12". A worker or reviewer run in progress ends within about two minutes with its spend recorded, its PR becomes a draft, and nothing picks it up again until you re-apply the label; your other Objectives keep running ([docs/USAGE.md](docs/USAGE.md), An Objective's lifecycle).
- **To restart one from its current text,** in any state, label its issue `pendulum:restart`, or ask "Restart Clockgrove Pendulum Objective 12". A run in progress stops first; the earlier PR is closed with a comment, its branch deleted, and the run starts over from the default branch.
- **To stop everything,** disable the workflow (`gh workflow disable pendulum.yml`) and cancel any run in the Actions tab. With the cloud sandbox, also stop the Objective's sandboxes in your Vercel project: a run already going there is not an Actions run. In local mode, stop `pendulum serve` with Ctrl-C. [docs/INSTALL.md](docs/INSTALL.md) has the full uninstall.

## What it can touch

- **Wherever Pendulum runs (GitHub Actions, local mode, the cloud sandbox), the worker and the reviewer cannot write to GitHub.** The worker only changes files in its own checkout, and Pendulum's scripts make every push, PR, comment and merge. On GitHub Actions they act as a GitHub App that you create for this one repository; in local mode, with a token you create for this one repository (and, if you add the App's key, as the App for Blocked and Question notices).
- **The commands a worker runs are sandboxed** there and see none of your credentials unless you choose to share one. The exceptions are the commands that run inside your own agent session, `/pendulum:pendulum-run --here` and `/pendulum:pendulum-review` ([docs/USAGE.md](docs/USAGE.md)): they are not among the places Pendulum runs and work as you, unsandboxed, with your own GitHub login.
- **Only people you trust can start a run.** Pendulum acts on an issue only when its author can push to the repository or is a maintainer you name during setup, so a stranger's issue cannot instruct the worker.
- **One repository per Objective.** An Objective that needs a change in another repository stops before any code is written, with a Question on the issue.
- **Your data goes only to the services you configure,** and Pendulum has no telemetry. [Data and privacy](docs/PRIVACY.md) says what goes to your model provider, to GitHub, and to the optional AI Gateway and cloud sandbox, and what stays on your machine.

## Quick start

**1. Install the plugin** in the coding agent you use:

```sh
# Claude Code
claude plugin marketplace add https://github.com/clockgrove/pendulum.git
claude plugin install pendulum@clockgrove

# Codex
codex plugin marketplace add clockgrove/pendulum
codex plugin add pendulum@clockgrove

# GitHub Copilot CLI
copilot plugin marketplace add clockgrove/pendulum
copilot plugin install pendulum@clockgrove
```

The plugin follows Pendulum's `main` branch. The workflow it writes for your repository pins the latest release tag.

**2. Ask it to set Clockgrove Pendulum up.** Open a session in your clone of the repository and say:

> Set up Clockgrove Pendulum for this repository.

Use the full name in requests like this one: it is what Pendulum's skills answer to, and a bare "Pendulum" can mean something else to your agent, such as the Python date-time library of that name.

The session follows Pendulum's `pendulum-setup` skill. It asks a few questions first; the ones that matter on day one are the cost caps and auto-merge, and the defaults are fine for the rest. Then it shows each change and waits for your yes. It:

- writes Pendulum's workflow file, `.github/workflows/pendulum.yml`, which holds the jobs that run your Objectives, and opens a pull request that adds it;
- creates a GitHub App for this one repository from a pre-filled definition, a few clicks in your browser, and saves its two secrets (or walks you through GitHub's settings by hand): on GitHub Actions, Pendulum writes to your repository as that App rather than as you;
- has you save your model credential;
- creates the labels and, on a repository an organization owns, a GitHub Project board that shows each Objective's state, requires your CI's checks on the default branch, adds a merge queue where GitHub offers one, and sets squash merges to use each PR's title and body.

Merge that pull request when you are ready. Pendulum starts once the workflow file is on your default branch.

**3. Ask it to check the setup.**

> Is Clockgrove Pendulum set up correctly here?

The session runs Pendulum's doctor, which changes nothing. Each line it prints is PASS, WARN or FAIL, with the fix. Expect a FAIL or two the first time, for example when your repository's default workflow token can write; fix what it names and ask again.

**4. Tell it what to build.**

> File a Clockgrove Pendulum Objective: `mytool --version` should print the version from package.json.

The session writes the issue in the shape Pendulum reads, shows it to you, and asks whether to start it now, save it as a draft, or keep discussing. Started, it carries the `pendulum:objective` label, which starts the run. A draft carries `pendulum:draft` instead, which Pendulum never runs: say "Let's keep working on Clockgrove Pendulum Objective 12" to refine it in a later session (changes are saved to the issue on your yes), and "Start Clockgrove Pendulum Objective 12" when it is ready. The issue looks like this:

```markdown
## Goal

`mytool --version` prints the version.

## Acceptance

- `mytool --version` prints the version from package.json and exits 0.
- A test covers it.
```

While the run goes, one comment on the issue shows its progress and the issue's labels show its state. You come back to a merged PR; with auto-merge off, to a PR ready for you to merge; or to the issue handed back as Blocked or with a Question. [docs/USAGE.md](docs/USAGE.md) covers writing Objectives yourself, following a run, what to do when one is Blocked or has a Question, and the slash command behind each of these requests. Its [glossary](docs/USAGE.md#glossary) defines the terms Pendulum's docs use.

### Without the plugin

The same setup runs as scripts from a clone of Pendulum, with no coding agent involved: [docs/INSTALL.md](docs/INSTALL.md), Set it up.

### Run it on your own machine instead

Local mode runs the same worker and reviewer on your machine. Claude Code and Codex run on the login you already have; Copilot uses the same seat token as on Actions. It needs no GitHub App and no secrets stored in GitHub, but more machine setup: Linux or WSL2 (macOS partly, below), a few sandbox packages, and a GitHub token for this one repository. It reads its settings (models, caps, validation commands) from the workflow file on your default branch and runs on defaults without one, so say "Set up Clockgrove Pendulum in local mode" and the pendulum-setup skill sets up both. The local loop (`pendulum serve`) takes the Objectives labelled `pendulum:local`. Where no Action runs (GitHub lists no active `pendulum.yml` workflow for the repository), it takes every Objective, `pendulum:objective` alone included, and labels each `pendulum:local` as it picks it. With the Action active, an Objective without `pendulum:local` is the Action's, and `serve` says how many it leaves to it: add `pendulum:local` to run one on your machine. macOS support is partial: Claude Code and Codex only, and not yet proven on a full run. See [docs/LOCAL.md](docs/LOCAL.md).

### Local quick start

On Linux or WSL2, with the plugin installed (step 1) and Claude Code or Codex logged in:

1. **Install the sandbox:** `npm i -g @anthropic-ai/sandbox-runtime`, then `sudo apt-get install -y bubblewrap socat ripgrep`. Ubuntu 24.04 and later also need an AppArmor change ([docs/LOCAL.md](docs/LOCAL.md), Set it up, step 1).
2. **Create a GitHub token for this one repository** and save it as [docs/LOCAL.md](docs/LOCAL.md) (Set it up, step 2) says.
3. **Check the machine:** in your clone, ask "Is Clockgrove Pendulum set up for local mode here?" and fix what it names.
4. **Start the loop:** say "Start the Clockgrove Pendulum local loop", or run `pendulum serve` in your clone and leave it running.
5. **File an Objective** ("File a Clockgrove Pendulum Objective: ..."). With no Pendulum workflow active on GitHub, the loop takes it as filed and labels it `pendulum:local`. With one active, add `pendulum:local` beside `pendulum:objective`: the loop runs it on your machine, and GitHub Actions leaves it alone.

## Skills

Pendulum is a plugin of [Agent Skills](https://agentskills.io): one folder per skill under [`plugin/skills/`](plugin/skills/), each a `SKILL.md` that Claude Code, Codex and GitHub Copilot CLI load the same way. Ask in plain words with the full name, Clockgrove Pendulum. In Claude Code each skill is also a slash command, `/pendulum:<skill>`; Codex and Copilot list them among their own skills.

| Skill | Say | What it does |
| --- | --- | --- |
| [`pendulum-setup`](plugin/skills/pendulum-setup/SKILL.md) | "Set up Clockgrove Pendulum for this repository." | Installs Pendulum one consented step at a time and opens the pull request that adds the workflow file |
| [`pendulum-doctor`](plugin/skills/pendulum-doctor/SKILL.md) | "Is Clockgrove Pendulum set up correctly here?" | Checks the repository, its settings, the credential and the runner; changes nothing |
| [`pendulum-file`](plugin/skills/pendulum-file/SKILL.md) | "File a Clockgrove Pendulum Objective: ..." | Writes what you describe as an Objective issue, shows it, and creates it on your yes, started or as a draft |
| [`pendulum-draft`](plugin/skills/pendulum-draft/SKILL.md) | "Let's keep working on Clockgrove Pendulum Objective 12." | Loads the draft from GitHub to refine it with you, and saves the changes back on your yes |
| [`pendulum-start`](plugin/skills/pendulum-start/SKILL.md) | "Start Clockgrove Pendulum Objective 12." | Starts a draft on your yes, after the trust check: takes `pendulum:draft` off and applies `pendulum:objective` |
| [`pendulum-stop`](plugin/skills/pendulum-stop/SKILL.md) | "Stop Clockgrove Pendulum Objective 12." | Removes the Objective's label on your yes: its run in progress ends and nothing picks it up again |
| [`pendulum-restart`](plugin/skills/pendulum-restart/SKILL.md) | "Restart Clockgrove Pendulum Objective 12." | Applies `pendulum:restart` on your yes: the Objective starts over from the issue's current text |
| [`pendulum-run`](plugin/skills/pendulum-run/SKILL.md) | "Run Clockgrove Pendulum Objective 42 here." | Runs one Objective on this machine, in local mode or in the session itself |
| [`pendulum-review`](plugin/skills/pendulum-review/SKILL.md) | "Review Clockgrove Pendulum PR 57." | Runs the reviewer on one Pendulum PR in your session |
| [`pendulum-serve`](plugin/skills/pendulum-serve/SKILL.md) | "Start the Clockgrove Pendulum local loop." | Starts the loop that runs Objectives on this machine ([docs/LOCAL.md](docs/LOCAL.md)) |
| [`pendulum-queue`](plugin/skills/pendulum-queue/SKILL.md) | "Start the Clockgrove Pendulum queue." | Starts the unattended scheduler for the repository |
| [`pendulum-handover`](plugin/skills/pendulum-handover/SKILL.md) | "Apply the Clockgrove Pendulum workflow hand-over for Objective 12." | Puts the workflow change Pendulum handed over on a new branch and shows it; pushes it and opens its PR only after you read it and say yes |
| [`pendulum-score`](plugin/skills/pendulum-score/SKILL.md) | "Show the Clockgrove Pendulum scorecard." | Prints the scorecard: whether each Objective merged with no one stepping in, quality, operator minutes, cost |

Six more are loaded for you. The worker follows [`pendulum-objective-plan`](plugin/skills/pendulum-objective-plan/SKILL.md), [`pendulum-implement-split`](plugin/skills/pendulum-implement-split/SKILL.md), [`pendulum-prove-acceptance`](plugin/skills/pendulum-prove-acceptance/SKILL.md) and [`pendulum-deliver-pr`](plugin/skills/pendulum-deliver-pr/SKILL.md), in that order; the reviewer follows [`pendulum-review-pr`](plugin/skills/pendulum-review-pr/SKILL.md); and `pendulum-score` loads [`pendulum-scoring`](plugin/skills/pendulum-scoring/SKILL.md).

Install Pendulum as a plugin (Quick start, step 1). Skill-only installers such as `npx skills add` and `gh skill install` copy the skill folders but not the plugin's scripts, which the setup, doctor, run, serve, queue, review, handover and score skills run, so those skills do not work installed that way.

## What Pendulum adds to your repository

- **One workflow file**, `.github/workflows/pendulum.yml`.
- **A GitHub App** that you create and install on this one repository. Its ID and private key are two secrets. Its permissions: contents, pull requests, issues, projects: write; checks, commit statuses: read; actions: read, optional (cloud-sandbox logs and session restore); nothing else, never workflows. Projects is under Organization permissions in the App's settings, and a repository a user owns needs none; the rest are Repository permissions.
- **A model credential**, saved as a secret and handed only to the worker's and the reviewer's own process.
- **GitHub settings:** the `pendulum:` labels, a Project board (on a repository an organization owns; elsewhere the labels carry each Objective's state), a ruleset named `pendulum` that requires your CI's checks (and adds the merge queue where GitHub offers one), and squash merges that take each PR's title and body.

Nothing else is added unless you accept it: setup offers to commit Pendulum's skills to the repository, which the agents' cloud sessions need. [docs/INSTALL.md](docs/INSTALL.md) has the full footprint, the cost inputs, and how to upgrade and uninstall.

## Where it runs

- **GitHub Actions (the default):** each job runs on a fresh GitHub-hosted runner, unless you name a runner of your own.
- **Local mode:** your own machine, started by `pendulum serve` or `pendulum run <issue>` ([docs/LOCAL.md](docs/LOCAL.md)).
- **Cloud sandbox (opt-in):** one pausable sandbox per Objective on Vercel Sandbox ([docs/ADAPTERS.md](docs/ADAPTERS.md)).

Wherever it runs, Pendulum keeps each Objective's state in GitHub: the branch, the PR, the issue's comments and labels, the board and a usage record for each job. There is no server or database to host.

## Documentation

| Page | What it covers |
| --- | --- |
| [docs/USAGE.md](docs/USAGE.md) | A glossary of Pendulum's terms, writing an Objective, following a run, what to do when one is Blocked or has a Question, the commands |
| [docs/INSTALL.md](docs/INSTALL.md) | The install footprint, credentials, cost inputs, upgrade and uninstall |
| [docs/LOCAL.md](docs/LOCAL.md) | Local mode: platforms, setup, sandboxes, settings |
| [docs/ADAPTERS.md](docs/ADAPTERS.md) | The cloud sandbox and the other third-party adapters |
| [docs/PRIVACY.md](docs/PRIVACY.md) | Data and privacy: what goes to the model provider, GitHub, the AI Gateway and the cloud sandbox, and what stays local |
| [docs/PLAN.md](docs/PLAN.md) | The design: rules, contracts, security, the 1.0 bar |
| [bench/README.md](bench/README.md) | The scorecard: how Pendulum measures whether runs finish unattended, and what they cost |
| [Releases](https://github.com/clockgrove/pendulum/releases) | Release notes for every tag |

## Versioning

Pendulum is at 0.10.x, the release candidate for 1.0: run it on real work, but there is no stability promise until 1.0.

- **Pin an exact tag** (`clockgrove/pendulum@vX.Y.Z`); setup does this for you. Pendulum publishes no floating tag (no `v0`, no `v1`), and release tags cannot be moved or deleted, so what your workflow runs does not change until you upgrade. The plugin in your coding agent follows `main` instead, and with it the setup, doctor and file skills.
- **Names may still change before 1.0.** A 0.10.x release may rename an input, a label or a job as the exception, and its release notes call the change out. [docs/PLAN.md](docs/PLAN.md) (The 1.0 bar) lists what freezes at 1.0 and what Pendulum must prove to get there.
- **Releases come often:** until 1.0, Pendulum ships small patch releases often rather than large ones rarely, and every tag gets release notes on the [Releases](https://github.com/clockgrove/pendulum/releases) page.
- **Supported:** the latest 0.10.x release gets security fixes; older tags do not ([SECURITY.md](SECURITY.md)).

## Help and contributing

- **Bugs, questions and ideas:** [open an issue](https://github.com/clockgrove/pendulum/issues). [CONTRIBUTING.md](CONTRIBUTING.md) says what helps in a report.
- **Security problems:** report them privately ([SECURITY.md](SECURITY.md)), never in a public issue.
- **Pull requests:** Pendulum is not taking outside pull requests yet.

## License

[MIT](LICENSE) © Clockgrove
