---
name: factory-setup
description: "/factory:factory-setup. Install Clockgrove Factory in the current repository on the user's consent: add .github/workflows/factory.yml through a pull request, walk the GitHub App creation, and apply the merge queue, branch protection, labels and Project board; or set up local mode on the user's own machine. Use when the user asks to set up, install or configure Clockgrove Factory for a repository."
---

# /factory:factory-setup

Each step changes the repository or its GitHub settings: say what it will do and wait for a yes. The plugin's `scripts/setup.mjs` does the work: `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" --repo OWNER/NAME --apply <step> --yes` (the plugin root: two directories up), one consented step at a time, where `<step>` is `workflow`, `labels`, `project` or `protection`. Without `--yes` it only prints what it would do: preview before asking.

## 1. The workflow file (`--apply workflow`)

Ask once for the template's inputs, as flags: `--harness` (claude, codex, copilot), `--model`, `--subagent-model`, `--reviewer-model`, `--max-concurrent`, `--daily-usd`, `--max-usd`, `--timeout-minutes` (under 360 on hosted runners), `--auto-merge` (default `true`: code lands with no human read, gated by CI, the reviewer and the merge queue), `--credential` (`api`, or `plan` for the user's own repository only), `--notify`, `--runs-on` (default: the CI workflow's runner), `--setup`, `--validation`, `--budget-command`, `--protected-paths`, `--ci-checks`. Show the rendered file; on yes, write it (After lands it). A re-render keeps the file's settings: pass only changes (`--name=` clears one); show the kept and changed lines. It never triggers from a fork.

`--sandbox vercel` writes the cloud-sandbox jobs instead (docs/ADAPTERS.md). The user saves `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID` with `gh secret set`; only the launcher reads them. A stage's session is `timeout_minutes` plus about 16 minutes, up to the plan's cap (24 hours on Vercel Pro). Vercel bills the team for active CPU, provisioned memory, creations and snapshot storage; Factory books each stage's cost on the issue toward `daily_usd` and `max_usd`.

## 2. The GitHub App

Walk it; never read, print or copy the key.

1. Open `https://github.com/settings/apps/new` (or the organization's `/organizations/<org>/settings/apps/new`). Name it `Factory (<repo>)`, uncheck webhooks, grant exactly these repository permissions: contents, pull requests, issues, projects: write; checks, commit statuses: read; actions: read, optional (cloud-sandbox logs and session restore); nothing else, never workflows.
2. Create it, generate a private key, note its App ID.
3. Install it on this repository only.
4. Save the two secrets: `gh secret set FACTORY_APP_ID` and `gh secret set FACTORY_APP_PRIVATE_KEY < path.pem`, run by the user, the path given as text.

Then the model credential, by the user (`gh secret set`): `ANTHROPIC_API_KEY` (none for Claude federation), `FACTORY_CODEX_GATEWAY_KEY` (an AI Gateway key) or `CODEX_API_KEY`, or `COPILOT_GITHUB_TOKEN` (only the Copilot Requests permission; doctor fails without it).

## 3. GitHub settings

- **Labels** (`--apply labels`) and **Project board** (`--apply project`): as the App when the user exported `FACTORY_APP_TOKEN`, or `FACTORY_APP_ID` and `FACTORY_APP_PRIVATE_KEY="$(cat <path>.pem)"`, else as their `gh` login; never read the key.
- **Merge queue and branch protection** (`--apply protection`): the `factory` ruleset on the default branch (a merge queue where GitHub offers one, required checks from `--ci-checks`, no deletion or force push) and squash commits from the PR's title and body. Rulesets need admin, so this runs as the user's `gh` login. If the CI workflow lacks `merge_group:` under `on:`, offer to add it.

## 4. Skills in the repository

Committed copies of the skills and agents, for vendors' cloud sessions only: offer them per [reference.md](reference.md).

## Local mode, instead of or beside the Action

On the user's own machine, walk `docs/LOCAL.md` instead of steps 1 to 3: no App, no model secret, and WSL2 only on Windows. The user creates a fine-grained token for this one repository (Contents, Issues and Pull requests read and write; Actions read), and for Copilot a Copilot Requests token. They save them with that page's command; never ask for or read a token. Then offer `node "${CLAUDE_PLUGIN_ROOT}/scripts/local.mjs" serve --once` from the clone: it lists anything missing and creates the `factory:local` label. Objectives with that label are the local loop's; the Action leaves them alone.

## After

On a yes, land the workflow file through a pull request ([reference.md](reference.md)). Then run the factory-doctor skill and show its lines. End with what is left: the user merges it, then says what to build (the factory-file skill).
