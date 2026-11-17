<p align="center">
  <img src="assets/brand/pendulum/web/mark-240.png" width="120" height="120" alt="The Pendulum mark: a brass pendulum in an arched wooden clock case">
</p>

<h1 align="center">Clockgrove Pendulum</h1>

<p align="center"><strong>Label a GitHub issue, walk away, come back to a merged pull request.</strong></p>

<p align="center">
  <a href="https://github.com/clockgrove/pendulum/releases"><img src="https://img.shields.io/github/v/release/clockgrove/pendulum" alt="Release"></a>
  <a href="https://github.com/clockgrove/pendulum/actions/workflows/quality.yml"><img src="https://github.com/clockgrove/pendulum/actions/workflows/quality.yml/badge.svg" alt="Quality"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/clockgrove/pendulum" alt="License: MIT"></a>
</p>

<p align="center"><em>Pendulum: the part that keeps a clock running while no one is watching.</em></p>

For maintainers of a GitHub repository with CI. You write an issue that says what you want and what "done" means, and label it `pendulum:objective`. A coding agent (Claude Code, Codex or GitHub Copilot CLI) plans and builds the change and opens a pull request, a second agent run reviews it, and Pendulum merges it once your own CI is green. It runs on GitHub Actions or on your own machine, keeps its state in GitHub, and is free and open source (MIT). To start, install the plugin in your coding agent and ask it to set Pendulum up ([Quick start](#quick-start)). Version 0.10.x is the release candidate for 1.0 ([Versioning](#versioning)).

## A real run

<img src="docs/img/example-run.png" width="760" alt="Issue 3 on clockgrove/pendulum-scratch: labelled pendulum:objective at 02:23 UTC, Pendulum's progress comment ending in 'exit: delivered; usd 0.35637', then pull request 4: the reviewer's comment at 02:26 UTC, added to the merge queue at 02:26 UTC and merged via the queue at 02:27 UTC, 16 checks passed">

[Issue #3](https://github.com/clockgrove/pendulum-scratch/issues/3) on the public scratch repository asked for a `multiply(a, b)` function with a test and a README entry. Pendulum ran it on GitHub Actions with Claude Code, and [pull request #4](https://github.com/clockgrove/pendulum-scratch/pull/4) merged with no one touching it after the label.

| Step | Time (UTC, 2026-11-17) |
| --- | --- |
| Issue filed and labelled `pendulum:objective` | 02:23:41 |
| Pull request opened | 02:25:40 |
| Reviewer's comment | 02:26:39 |
| Merged through the merge queue | 02:27:36, 3 min 55 s after filing |

The model cost was **$0.52**: $0.36 for the worker (`claude-opus-5-5`, with `claude-sonnet-5-5` sub-agents) and $0.16 for the reviewer (`claude-fable-5-2`), on an Anthropic API key, as Claude Code reported them in the `usd` lines of the issue's two progress comments and the runs' usage artifacts. It was a small change: [What it costs](#what-it-costs-and-how-to-stay-in-control) covers caps and larger Objectives. [bench/README.md](bench/README.md) explains how Pendulum scores every run: whether it merged with no one stepping in, solution quality, operator minutes and dollars.

## Quick start

In your clone of the repository, with Claude Code:

```sh
claude plugin marketplace add https://github.com/clockgrove/pendulum.git
claude plugin install pendulum@clockgrove
```

then, in a Claude Code session: **"Set up Clockgrove Pendulum for this repository."**

- **Codex:** `codex plugin marketplace add clockgrove/pendulum && codex plugin add pendulum@clockgrove`
- **GitHub Copilot CLI:** `copilot plugin marketplace add clockgrove/pendulum && copilot plugin install pendulum@clockgrove`

Setup asks three questions (your coding agent, the spending caps, auto-merge), shows each change and waits for your yes, and opens a pull request that adds Pendulum's workflow; Pendulum starts once you merge it. Check first that [it will work for you](#will-it-work-for-you); [Set it up, step by step](#set-it-up-step-by-step) has the details. To run on your own machine on the Claude Code or Codex login you already have, say "Set up Clockgrove Pendulum in local mode" instead ([local mode](#run-it-on-your-own-machine-instead)).

## How it differs

| | Pendulum | Copilot coding agent and Agent Merge | claude-code-action | OpenHands on GitHub |
| --- | --- | --- | --- | --- |
| **What starts the work** | The `pendulum:objective` label on an issue | Assigning the issue to Copilot, or an automation (a schedule, a new issue or PR); Agent Merge: "Watch and fix" on a PR | A label you name, `@claude`, or assignment | The `openhands` label on an issue, or `@openhands` |
| **Review** | A separate reviewer run on every PR, whose comments the worker answers | Copilot code review of its own changes, before it opens the PR | A separate review workflow you add | A separate review workflow you add |
| **Coding agent** | Claude Code, Codex or Copilot CLI | Copilot, or the Claude and Codex agents GitHub runs | Claude Code | OpenHands' own agent, with any LLM |
| **Where it runs** | GitHub Actions or your own machine; all state in GitHub, no server | GitHub's cloud | Your GitHub Actions runner | OpenHands Cloud |
| **How the PR lands** | Pendulum merges it on your required checks, through your merge queue where you have one | With auto-merge on, GitHub merges it once its requirements are met; Agent Merge fixes failing checks and conflicts | It pushes a branch and links a pre-filled PR form | It opens a PR |

Each cell is from the tool's own documentation; [docs/COMPARISON.md](docs/COMPARISON.md) quotes and links the source of each.

## How it works

1. **You label an issue `pendulum:objective`.** That issue is now an Objective. Write everything the work needs into it: the worker reads it as the whole specification.
2. **A worker plans and builds.** The worker is the coding agent. It writes a plan and the code, and Pendulum posts the plan on the issue and opens one pull request (PR). A large Objective arrives as up to six PRs, one at a time.
3. **Your CI decides.** The worker waits for your required checks on the PR. If one fails, the worker gets one try to fix it, and in a few cases one more, for example when only your CI, not the worker's own run of your commands, found the failure.
4. **A reviewer comments once.** The reviewer is a separate agent run that compares the change with the issue. The worker answers each comment once.
5. **Pendulum merges** the commit that was reviewed, once your required checks are green on it, through your merge queue when your repository has one. Without a queue, a PR that only fell behind your default branch is brought up to date by GitHub, and that update is what merges.

Your CI is the only test of whether the change is correct: with no tests, Pendulum merges whatever your CI lets through, except changes to protected files such as your workflows, which it refuses, and decisions it hands back to you as Questions.

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

Pendulum itself is free: it has no paid tier or hosted service. Every cost goes to a provider you already pick and pay directly:

- **Your coding agent's model:** your Anthropic, OpenAI or Copilot account, or your Vercel AI Gateway key.
- **Your CI runners:** GitHub Actions minutes, or your own machine in local mode.
- **A cloud sandbox,** only if you opt in: your Vercel account.

Pendulum never handles a payment, and no bill comes from Clockgrove. To keep those costs in check:

- **Model usage is capped twice:** `max_usd` for each worker or reviewer job ($25 unless you change it) and `daily_usd` for each day ($100). A small change can cost under a dollar (the [real run](#a-real-run) above: $0.52), and a large Objective can reach the job cap. Setup asks for both caps. Two exceptions: a Codex model missing from Pendulum's price table runs uncapped (doctor warns about it), and a run inside your own agent session (`/pendulum:pendulum-run --here`) is neither capped nor counted.
- **To run one Objective on a cheaper or a stronger model,** or another coding agent, label its issue (`pendulum:model:<id>`, `pendulum:harness:<name>`, and sub-agent and reviewer labels): the workflow's coding agent and models stay the defaults for the rest ([docs/USAGE.md](docs/USAGE.md), Choose the harness and models).
- **Several subscriptions or keys of one coding agent work as one pool:** each run starts on the account with the most quota left, and a usage limit sets aside only the account that met it ([docs/LOCAL.md](docs/LOCAL.md), Accounts; [docs/INSTALL.md](docs/INSTALL.md), Several accounts).
- **Runs take from a few minutes to a few hours.** `timeout_minutes` bounds each job (240 by default), and up to three Objectives run at once (`max_concurrent`). Starting one by hand (`gh workflow run pendulum.yml -f issue=<number>`) runs it even when that limit is reached.
- **On a private repository the jobs use your Actions minutes**, including a short scheduled check every ten minutes.
- **For your first runs, start small:** setup recommends its first-run preset, `max_usd` 5, `max_concurrent` 1 and auto-merge off, and says how to raise each later. With auto-merge off, Pendulum stops at a ready-for-review PR and you merge it yourself.
- **With auto-merge on, which is the default, nobody reads the code before it lands.** What stands between a change and your default branch is your required checks; the reviewer only comments, and the worker has to answer each comment.
- **To stop one Objective,** remove its `pendulum:objective` label or close its issue, or ask "Stop Clockgrove Pendulum Objective 12". A worker or reviewer run in progress ends within about two minutes with its spend recorded, its PR becomes a draft, and nothing picks it up again until you re-apply the label; your other Objectives keep running ([docs/USAGE.md](docs/USAGE.md), An Objective's lifecycle).
- **To restart one from its current text,** in any state, label its issue `pendulum:restart`, or ask "Restart Clockgrove Pendulum Objective 12". A run in progress stops first; the earlier PR is closed with a comment, its branch deleted, and the run starts over from the default branch.
- **To stop everything,** disable the workflow (`gh workflow disable pendulum.yml`) and cancel any run in the Actions tab. With the cloud sandbox, also stop the Objective's sandboxes in your Vercel project: a run already going there is not an Actions run. In local mode, stop `pendulum serve` with Ctrl-C. [docs/INSTALL.md](docs/INSTALL.md) has the full uninstall.

## What it can touch

- **Wherever Pendulum runs (GitHub Actions, local mode, the cloud sandbox), the worker and the reviewer cannot write to GitHub.** The worker only changes files in its own checkout, and Pendulum's scripts make every push, PR, comment and merge. On GitHub Actions they act as a GitHub App that you create for this one repository; in local mode, with a token you create for this one repository (and, if you add the App's key, as the App for Blocked and Question notices).
- **The commands a worker runs are sandboxed** there and see none of your credentials unless you choose to share one. The exceptions are the commands that run inside your own agent session, `/pendulum:pendulum-run --here` and `/pendulum:pendulum-review-here` ([docs/USAGE.md](docs/USAGE.md)): they are not among the places Pendulum runs and work as you, unsandboxed, with your own GitHub login.
- **Only people you trust can start a run.** Pendulum acts on an issue only when its author can push to the repository or is a maintainer you name during setup, so a stranger's issue cannot instruct the worker.
- **One repository per Objective.** An Objective that needs a change in another repository stops before any code is written, with a Question on the issue.
- **Your data goes only to the services you configure,** and Pendulum has no telemetry. [Data and privacy](docs/PRIVACY.md) says what goes to your model provider, to GitHub, and to the optional AI Gateway and cloud sandbox, and what stays on your machine.

## Set it up, step by step

**1. Install the plugin** in the coding agent you use, with the commands in the [Quick start](#quick-start).

The plugin follows Pendulum's `main` branch. The workflow it writes for your repository pins the latest release tag.

**2. Ask it to set Clockgrove Pendulum up.** Open a session in your clone of the repository and say:

> Set up Clockgrove Pendulum for this repository.

Use the full name in requests like this one: it is what Pendulum's skills answer to, and a bare "Pendulum" can mean something else to your agent, such as the Python date-time library of that name.

The session follows Pendulum's `pendulum-setup` skill. It asks three questions first: which coding agent (Claude Code, Codex or Copilot CLI) and its credential, the spending caps, and whether Pendulum merges its own pull requests. For a first run it recommends a preset: about $5 per job, one Objective at a time, and auto-merge off, so you read each pull request before it lands. Everything else takes its default, and it lists those afterwards with how to change them later. Then it shows each change and waits for your yes. It:

- writes Pendulum's workflow file, `.github/workflows/pendulum.yml`, which holds the jobs that run your Objectives, and opens a pull request that adds it;
- creates a GitHub App for this one repository from a pre-filled definition, a few clicks in your browser, and saves its two secrets (or walks you through GitHub's settings by hand): on GitHub Actions, Pendulum writes to your repository as that App rather than as you;
- has you save your model credential;
- creates the labels and, on a repository an organization owns, a GitHub Project board that shows each Objective's state, requires your CI's checks on the default branch, adds a merge queue where GitHub offers one, and sets squash merges to use each PR's title and body;
- offers, as a step of its own, to make your repository's default workflow token read-only, after naming your workflows that rely on that default.

Merge that pull request when you are ready. Pendulum starts once the workflow file is on your default branch.

**3. Ask it to check the setup.**

> Is Clockgrove Pendulum set up correctly here?

The session runs Pendulum's doctor, which changes nothing. Each line it prints is PASS, WARN or FAIL, with the fix. Expect a FAIL or two the first time; fix what it names and ask again.

**4. Tell it what to build.**

> File a Clockgrove Pendulum Objective: `mytool --version` should print the version from package.json.

The session writes the issue in the shape Pendulum reads, shows it to you, and asks whether to start it now (the `pendulum:objective` label starts the run), save it as a draft (`pendulum:draft`, which Pendulum never runs; [docs/USAGE.md](docs/USAGE.md#commands) has the requests that refine and start one), or keep discussing. The issue looks like this:

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

Local mode runs the same worker and reviewer on your machine: Claude Code and Codex on the login you already have, Copilot on the same seat token as on Actions. It needs no GitHub App and no secrets stored in GitHub, but more machine setup: Linux or WSL2 (macOS partly: Claude Code and Codex only, not yet proven on a full run), a few sandbox packages, and a GitHub token for this one repository. It reads its settings (models, caps, validation commands) from the workflow file on your default branch and runs on defaults without one, so say "Set up Clockgrove Pendulum in local mode" and the pendulum-setup skill sets up both. The local loop (`pendulum serve`) takes the Objectives labelled `pendulum:local`, and every Objective where no Pendulum Action runs ([docs/LOCAL.md](docs/LOCAL.md#routing), Routing).

### Local quick start

On Linux or WSL2, with the plugin installed (step 1) and Claude Code or Codex logged in:

1. **Install the sandbox:** `npm i -g @anthropic-ai/sandbox-runtime`, then `sudo apt-get install -y bubblewrap socat ripgrep`. Ubuntu 24.04 and later also need an AppArmor change ([docs/LOCAL.md](docs/LOCAL.md), Set it up, step 1).
2. **Create a GitHub token for this one repository** and save it as [docs/LOCAL.md](docs/LOCAL.md) (Set it up, step 2) says.
3. **Check the machine:** in your clone, ask "Is Clockgrove Pendulum set up for local mode here?" and fix what it names.
4. **Start the loop:** say "Start the Clockgrove Pendulum local loop", or run `pendulum serve` in your clone and leave it running.
5. **File an Objective** ("File a Clockgrove Pendulum Objective: ..."). Where a Pendulum workflow is active on GitHub, add `pendulum:local` beside `pendulum:objective` to run it on your machine.

## Skills

Pendulum is a plugin of [Agent Skills](https://agentskills.io) that Claude Code, Codex and GitHub Copilot CLI load the same way. Ask in plain words with the full name, Clockgrove Pendulum; [docs/USAGE.md](docs/USAGE.md#commands) lists every request, its slash command and its skill.

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
| [docs/COMPARISON.md](docs/COMPARISON.md) | How Pendulum differs from Copilot coding agent and Agent Merge, claude-code-action and OpenHands, with a source for each claim |
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
