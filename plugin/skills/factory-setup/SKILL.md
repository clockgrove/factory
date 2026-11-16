---
name: factory-setup
description: "/factory:factory-setup. Install Clockgrove Factory in the current repository on the user's consent: add .github/workflows/factory.yml through a pull request, walk the GitHub App creation, and apply the merge queue, branch protection, labels and Project board; or set up local mode on the user's own machine. Use when the user asks to set up, install or configure Clockgrove Factory for a repository."
---

# /factory:factory-setup

Each step changes the repository or its settings: say what it does and wait for a yes. The plugin's `scripts/setup.mjs` does the work: `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" --repo OWNER/NAME --apply <step> --yes` (the plugin root: two directories up), one consented step at a time; `<step>` is `workflow`, `labels`, `project` or `protection`. Without `--yes` it only previews: show that before asking.

## 1. The workflow file (`--apply workflow`)

Ask once for the template's flags: `--harness` (claude, codex, copilot), `--model`, `--subagent-model`, `--reviewer-model`, `--max-concurrent`, `--daily-usd`, `--max-usd`, `--timeout-minutes` (under 360 on hosted runners), `--auto-merge` (default `true`: code lands unread, gated by CI, the reviewer and the merge queue), `--credential` (`api`; offer `plan` when Claude has no key: [reference.md](reference.md)), `--notify`, `--runs-on` (default: the CI's runner), `--setup`, `--validation`, `--budget-command`, `--protected-paths`, `--ci-checks`. Show the rendered file; on yes, write it (After lands it). A re-render keeps the file's settings: pass only changes (`--name=` clears one); show the kept and changed lines. It never triggers from a fork.

`--sandbox vercel` writes the cloud-sandbox jobs instead ([Cloud sandbox](https://github.com/clockgrove/factory/blob/v0.9.37/docs/ADAPTERS.md#cloud-sandbox)). The user saves `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID` with `gh secret set`; only the launcher reads them. A stage's session is `timeout_minutes` plus about 16 minutes, up to the plan's cap (24 hours on Pro). Vercel bills the team for active CPU, provisioned memory, creations and snapshot storage; Factory books each stage's cost on the issue toward `daily_usd` and `max_usd`.

## 2. The GitHub App

Walk it; never read, print or copy the key.

1. Open `https://github.com/settings/apps/new` (an organization's: `/organizations/<org>/settings/apps/new`). Name it `Factory (<repo>)`, uncheck webhooks, grant exactly these repository permissions: contents, pull requests, issues, projects: write; checks, commit statuses: read; actions: read, optional (cloud-sandbox logs and session restore); nothing else, never workflows.
2. Create it, generate a private key, note the App ID.
3. Install it on this repository only.
4. The user saves the two secrets: `gh secret set FACTORY_APP_ID` and `gh secret set FACTORY_APP_PRIVATE_KEY < path.pem`, the path given as text.

Then the user's model credential (`gh secret set`): `ANTHROPIC_API_KEY` (`CLAUDE_CODE_OAUTH_TOKEN` with `plan`; none for federation), `FACTORY_CODEX_GATEWAY_KEY` (an AI Gateway key) or `CODEX_API_KEY`, or `COPILOT_GITHUB_TOKEN` (only the Copilot Requests permission; doctor fails without it).

## 3. GitHub settings

- **Labels** (`--apply labels`) and **Project board** (`--apply project`): as the App when the user exported `FACTORY_APP_TOKEN`, or `FACTORY_APP_ID` and `FACTORY_APP_PRIVATE_KEY="$(cat <path>.pem)"`, else as their `gh` login; never read the key.
- **Merge queue and branch protection** (`--apply protection`): the `factory` ruleset on the default branch (a merge queue where GitHub offers one, required checks from `--ci-checks`, no deletion or force push) and squash commits from the PR's title and body. It needs admin: it runs as the user's `gh` login. If the CI workflow lacks `merge_group:` under `on:`, offer to add it.

## 4. Skills in the repository

Committed copies of the skills and agents, for vendors' cloud sessions only: offer them per [reference.md](reference.md).

## Local mode, instead of or beside the Action

On the user's machine, walk [local.md](local.md) instead of steps 1 to 3: no App, no model secret, and WSL2 only on Windows. The user creates and saves the tokens with its commands; never ask for or read them. Then offer `node "${CLAUDE_PLUGIN_ROOT}/scripts/local.mjs" serve --once` from the clone: it lists anything missing and creates the `factory:local` label. Objectives with that label, and every one where no Action is active, are the local loop's.

## Several accounts

Several subscriptions or keys of one harness: offer them as accounts; automatic choice spreads stages across their quota ([reference.md](reference.md)).

## After

On a yes, land the workflow file by pull request ([reference.md](reference.md)). Then run the factory-doctor skill; show its lines. End with what is left: the user merges it, then says what to build (the factory-file skill).
