---
name: factory-setup
description: /factory setup. Install Factory in the current repository on the user's consent: write .github/workflows/factory.yml from the template, walk the Factory GitHub App creation, and apply the merge queue, branch protection, label and Project board. Use when the user asks to set up, install or configure Factory for a repository.
---

# /factory setup

Everything here changes the repository or its GitHub settings, so each step says what it will do and waits for a yes. When `<action>/scripts/setup.mjs` exists, it does the GitHub steps: run `node <action>/scripts/setup.mjs --repo OWNER/NAME --apply <step>` per consented step and render its output; the list below is what it does and the fallback.

## 1. The workflow file

Read `templates/factory.yml` next to this plugin. Ask once for the inputs it needs and fill them: `harness` (claude, codex, copilot), `model`, `subagent_model`, `reviewer_model`, `max_concurrent`, `daily_usd`, `max_usd`, `timeout_minutes` (under 360 on hosted runners), `auto_merge` (default `true`; the file carries the comment that code then lands with no human read, gated by CI on the queue commit, the reviewer and the merge queue), `credential` (`api`, or `plan` for the user's own repository only), `notify`, `runs-on`, `setup`, `validation`. Show the rendered file; on yes, write `.github/workflows/factory.yml` and say it needs a commit on the default branch to start its cron. Never trigger it on `pull_request` and never from a fork.

## 2. The GitHub App

Walk it; never read, print or copy the key.

1. Open `https://github.com/settings/apps/new` (or the organization's `/organizations/<org>/settings/apps/new`). Name it `Factory (<repo>)`, uncheck webhooks, grant repository permissions contents, pull requests, issues and projects as read and write, and nothing else, especially not workflows.
2. Create it, generate a private key, and note the App ID from its page.
3. Install it on this repository only.
4. Save the two secrets: `gh secret set FACTORY_APP_ID` and `gh secret set FACTORY_APP_PRIVATE_KEY < path.pem`, run by the user, with the path they give as text.

Then the model credential: `gh secret set ANTHROPIC_API_KEY` or `CODEX_API_KEY` by the user, or nothing for Copilot and for Claude federation.

## 3. GitHub settings

Each on its own yes, through `gh api`:

- **Merge queue and branch protection** on the default branch: require the merge queue, require the CI workflow's named checks, require branches up to date. If the CI workflow lacks `merge_group:` under `on:`, show the one-line addition and offer to write it.
- **Label** `factory:objective`, and `P0`, `P1`, `P2` when absent.
- **Project board** named Factory with a single-select status of Queued, Running, In review, Blocked, Done, linked to the repository, when the repository has none. Projects v2 is GraphQL: `gh api graphql`.
- **Auto-merge** enabled in the repository settings when `auto_merge` is true.

## 4. Skills in the repository

Offer to commit the Factory skills and agent definitions under `.agents/skills/` and `.claude/skills/` (`--commit-skills`), which the vendors' cloud sessions need and the Action does not. Say that a repository skill of the same name overrides a Factory one.

## After

Run `/factory doctor` and show its lines. End with the one thing left for the user: commit the workflow, then label an issue `factory:objective`.
