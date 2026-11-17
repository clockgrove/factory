---
name: pendulum-setup
description: "Install Clockgrove Pendulum in the current repository, one step at a time on the user's yes: add .github/workflows/pendulum.yml through a pull request, walk the GitHub App creation, and apply the merge queue, branch protection, labels and Project board; or set up local mode on the user's own machine. Use when the user asks to set up, install or configure Clockgrove Pendulum for a repository. Not for checking whether it is set up (pendulum-doctor)."
---

# /pendulum:pendulum-setup

Each step changes the repository or its settings: say what it does and wait for a yes. `<plugin root>` is `${CLAUDE_PLUGIN_ROOT}` in Claude Code, elsewhere two directories above this SKILL.md; where `pendulum` is not on PATH (only Claude Code puts the plugin's `bin/` there), run `node <plugin root>/scripts/local.mjs` instead. The plugin's setup script does the work: `node "<plugin root>/scripts/setup.mjs" --repo OWNER/NAME --apply <step> --yes`, one consented step at a time; `<step>` is `workflow`, `app`, `labels`, `project` or `protection`. Without `--yes` it only previews: show that before asking.

## 1. The workflow file (`--apply workflow`)

Ask once for the template's flags: `--harness` (claude, codex, copilot), `--model`, `--subagent-model`, `--reviewer-model`, `--max-concurrent`, `--daily-usd`, `--max-usd`, `--timeout-minutes` (under 360 on hosted runners), `--auto-merge` (default `true`: code lands unread, gated by CI, the reviewer and the merge queue), `--publish-transcripts` (reference.md), `--credential` (`api`; offer `plan` when Claude has no key: [reference.md](reference.md)), `--notify`, `--runs-on` (default: the CI's runner), `--setup`, `--validation`, `--budget-command`, `--protected-paths`, `--ci-checks`. Show the rendered file; on yes, write it (After lands it). A re-render keeps the file's settings: pass only changes (`--name=` clears one); show the kept and changed lines. It never triggers from a fork.

`--sandbox vercel` writes the cloud-sandbox jobs instead: [reference.md](reference.md), Cloud sandbox.

## 2. The GitHub App

Never read, print or copy the key. Offer `--apply app` first (`--secret-scope org`: organization secrets for this repository only). It waits up to 30 minutes, so run it in the background where you can, and give the user the 127.0.0.1 address it prints and opens. That page posts a pre-filled App, `Pendulum (<repo>)`, webhook off, with exactly: contents, pull requests, issues, projects: write; checks, commit statuses: read; actions: read, optional (cloud-sandbox logs and session restore); nothing else, never workflows. The user clicks Create; setup saves `PENDULUM_APP_ID` and `PENDULUM_APP_PRIVATE_KEY` and opens the install page: this repository only. If the browser cannot then load 127.0.0.1, `curl` the address it shows from setup's shell. Declined or failed: [reference.md](reference.md), The App by hand.

Then the user's model credential (`gh secret set`): `ANTHROPIC_API_KEY` (`CLAUDE_CODE_OAUTH_TOKEN` with `plan`; none for federation), `PENDULUM_CODEX_GATEWAY_KEY` (an AI Gateway key) or `CODEX_API_KEY`, or `COPILOT_GITHUB_TOKEN` (only the Copilot Requests permission; doctor fails without it).

## 3. GitHub settings

- **Labels** (`--apply labels`) and **Project board** (`--apply project`): as the App when the user exported `PENDULUM_APP_TOKEN`, or `PENDULUM_APP_ID` and `PENDULUM_APP_PRIVATE_KEY="$(cat <path>.pem)"`, else as their `gh` login; never read the key.
- **Merge queue and branch protection** (`--apply protection`): the `pendulum` ruleset on the default branch (a merge queue where GitHub offers one, required checks from `--ci-checks`, no deletion or force push) and squash commits from the PR's title and body. It needs admin: it runs as the user's `gh` login. If the CI workflow lacks `merge_group:` under `on:`, offer to add it.

## 4. Skills in the repository

Committed copies of the skills workers load and the agents, for vendors' cloud sessions only: offer them per [reference.md](reference.md).

## Local mode, instead of or beside the Action

On the user's machine, walk [local.md](local.md) instead of steps 1 to 3: no App, no model secret, and WSL2 only on Windows. The user creates and saves the tokens with its commands; never ask for or read them. Then offer `pendulum serve --once` from the clone: it lists anything missing and creates the `pendulum:local` label. Objectives with that label, and every one where no Action is active, are the local loop's.

## Several accounts

Several subscriptions or keys of one harness: offer them as accounts; automatic choice spreads stages across their quota ([reference.md](reference.md)).

## After

On a yes, land the workflow file by pull request ([reference.md](reference.md)). Then run the pendulum-doctor skill; show its lines. End with what is left: the user merges it, then says what to build (the pendulum-file skill).
