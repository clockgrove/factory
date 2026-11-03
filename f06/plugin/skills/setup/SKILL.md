---
name: setup
description: /factory:setup. Install Factory in the current repository on the user's consent: write .github/workflows/factory.yml from the Action's template, walk the Factory GitHub App creation, and apply the merge queue, branch protection, labels and Project board. Use when the user asks to set up, install or configure Factory for a repository.
---

# /factory:setup

Everything here changes the repository or its GitHub settings, so each step says what it will do and waits for a yes. The work is done by `<action>/scripts/setup.mjs` in the Factory action checkout (`gh repo clone clockgrove/factory` into a scratch directory if it is not local): `node <action>/scripts/setup.mjs --repo OWNER/NAME --apply <step> --yes`, one consented step at a time, where `<step>` is `workflow`, `labels`, `project` or `protection`. Without `--yes` the script only prints what it would do; use that as the preview before asking.

## 1. The workflow file (`--apply workflow`)

Ask once for the inputs the template needs and pass them as flags: `--harness` (claude, codex, copilot), `--model`, `--subagent-model`, `--reviewer-model`, `--max-concurrent`, `--daily-usd`, `--max-usd`, `--timeout-minutes` (under 360 on hosted runners), `--auto-merge` (default `true`; the file carries the comment that code then lands with no human read, gated by CI on the queue commit, the reviewer and the merge queue), `--credential` (`api`, or `plan` for the user's own repository only), `--notify`, `--runs-on`, `--setup`, `--validation`, `--budget-command`, `--protected-paths`, `--ci-checks`. Show the rendered `.github/workflows/factory.yml` (from `<action>/workflow-template.yml`); on yes, write it and say it needs a commit on the default branch to start its cron. It triggers on cron, manual dispatch, and `pull_request` only for the `factory:review` label the App applies; never from a fork.

## 2. The GitHub App

Walk it; never read, print or copy the key.

1. Open `https://github.com/settings/apps/new` (or the organization's `/organizations/<org>/settings/apps/new`). Name it `Factory (<repo>)`, uncheck webhooks, grant repository permissions contents, pull requests, issues and projects as read and write, and nothing else, especially not workflows.
2. Create it, generate a private key, and note the App ID from its page.
3. Install it on this repository only.
4. Save the two secrets: `gh secret set FACTORY_APP_ID` and `gh secret set FACTORY_APP_PRIVATE_KEY < path.pem`, run by the user, with the path they give as text.

Then the model credential: `gh secret set ANTHROPIC_API_KEY` or `CODEX_API_KEY` by the user, or nothing for Copilot and for Claude federation.

## 3. GitHub settings

- **Labels** (`--apply labels`) and **Project board** (`--apply project`, Projects v2 by GraphQL): these act as the App, so the user first exports an installation token as `FACTORY_APP_TOKEN` (for example `gh api` with their App, or `--app-id` and `--app-private-key <path>` passed to the script); you never read the key.
- **Merge queue and branch protection** (`--apply protection`): the `factory` ruleset on the default branch (merge queue, required checks from `--ci-checks`, no deletion or force push) and the repository's Allow auto-merge. Rulesets need admin, which the App does not have, so this step runs as the user's own `gh` login. If the CI workflow lacks `merge_group:` under `on:`, show the one-line addition and offer to write it.

## 4. Skills in the repository

Offer to commit the Factory skills and agent definitions, which the vendors' cloud sessions need and the Action does not: copy this plugin's `skills/*` to `.agents/skills/` and `.claude/skills/`, and `agents/<harness>/*` to `.claude/agents/`, `.codex/agents/` or `.github/agents/`, then commit. Say that a committed Factory skill is thereafter a repository override: it pins that version until the user updates it.

## After

Run `/factory:doctor` and show its lines. End with the one thing left for the user: commit the workflow, then label an issue `factory:objective`.
