---
name: setup
description: /factory:setup. Install Factory in the current repository on the user's consent: write .github/workflows/factory.yml from the Action's template, walk the Factory GitHub App creation, and apply the merge queue, branch protection, labels and Project board; or set up local mode on the user's own machine. Use when the user asks to set up, install or configure Factory for a repository.
---

# /factory:setup

Everything here changes the repository or its GitHub settings, so each step says what it will do and waits for a yes. The work is done by the plugin's `scripts/setup.mjs`: `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" --repo OWNER/NAME --apply <step> --yes`, one consented step at a time, where `<step>` is `workflow`, `labels`, `project` or `protection`. Without `--yes` the script only prints what it would do; use that as the preview before asking.

## 1. The workflow file (`--apply workflow`)

Ask once for the inputs the template needs and pass them as flags: `--harness` (claude, codex, copilot), `--model`, `--subagent-model`, `--reviewer-model`, `--max-concurrent`, `--daily-usd`, `--max-usd`, `--timeout-minutes` (under 360 on hosted runners), `--auto-merge` (default `true`: code then lands with no human read, gated by CI on the queue commit, the reviewer and the merge queue), `--credential` (`api`, or `plan` for the user's own repository only), `--notify`, `--runs-on` (default: the CI workflow's runner), `--setup`, `--validation`, `--budget-command`, `--protected-paths`, `--ci-checks`. Show the rendered `.github/workflows/factory.yml`; on yes, write it and say it needs a commit on the default branch to start its cron. A re-render keeps the file's settings: pass only changes (`--name=` clears one); show the kept and changed lines. It never triggers from a fork. `--sandbox vercel` writes the cloud-sandbox jobs instead (docs/ADAPTERS.md).

## 2. The GitHub App

Walk it; never read, print or copy the key.

1. Open `https://github.com/settings/apps/new` (or the organization's `/organizations/<org>/settings/apps/new`). Name it `Factory (<repo>)`, uncheck webhooks, and grant exactly these repository permissions: contents, pull requests, issues, projects: write; checks, commit statuses: read; actions: read, optional (cloud-sandbox logs); nothing else, never workflows.
2. Create it, generate a private key, note its App ID.
3. Install it on this repository only.
4. Save the two secrets: `gh secret set FACTORY_APP_ID` and `gh secret set FACTORY_APP_PRIVATE_KEY < path.pem`, run by the user, with the path they give as text.

Then the model credential, by the user (`gh secret set`): `ANTHROPIC_API_KEY` (none for Claude federation), `CODEX_API_KEY`, or `COPILOT_GITHUB_TOKEN` (only the Copilot Requests permission; doctor fails without it).

## 3. GitHub settings

- **Labels** (`--apply labels`) and **Project board** (`--apply project`, Projects v2 by GraphQL): as the App when the user exported `FACTORY_APP_TOKEN`, or `FACTORY_APP_ID` and `FACTORY_APP_PRIVATE_KEY="$(cat <path>.pem)"`, else as their `gh` login; never read the key.
- **Merge queue and branch protection** (`--apply protection`): the `factory` ruleset on the default branch (merge queue, required checks from `--ci-checks`, no deletion or force push) and squash commits from the PR's title and body. Rulesets need admin, which the App does not have, so this step runs as the user's own `gh` login. If the CI workflow lacks `merge_group:` under `on:`, offer to add the line.

## 4. Skills in the repository

Offer to commit the Factory skills and agent definitions, which the vendors' cloud sessions need and the Action does not: copy this plugin's `skills/*` to `.agents/skills/` and `.claude/skills/`, and `agents/<harness>/*` to `.claude/agents/`, `.codex/agents/` or `.github/agents/`, then commit. Say a committed Factory skill then overrides the plugin's, pinned at that version until updated.

## Local mode, instead of or beside the Action

For Factory on the user's own machine, walk `docs/LOCAL.md` instead of steps 1 to 3: no App, no model secret, and WSL2 only on Windows. The user creates a fine-grained token for this one repository (Contents, Issues and Pull requests read and write; Actions read), and for Copilot a Copilot Requests token. They save the tokens themselves with the command in that page; never ask for or read a token. Then offer `node "${CLAUDE_PLUGIN_ROOT}/scripts/local.mjs" serve --once` from the clone, which lists anything missing and creates the `factory:local` label. An Objective with that label is the local loop's, and the Action leaves it alone.

## After

Run `/factory:doctor` and show its lines. End with the one thing left for the user: commit the workflow, then label an issue `factory:objective`.
