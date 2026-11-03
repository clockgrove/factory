---
name: factory-doctor
description: /factory doctor. Check that this repository, its GitHub settings, its model credential and its runner are ready for unattended Factory runs, and name the fix for each failure. Use when the user asks whether Factory is set up, why Objectives Block at the first step, or before enabling the workflow.
---

# /factory doctor

Run every check, print one line per check (`ok`, `warn` or `fail`, then the fix), and stop. Change nothing; `/factory setup` applies fixes on consent. When `<action>/scripts/doctor.mjs` exists (the Factory action checkout), run `node <action>/scripts/doctor.mjs --repo OWNER/NAME --json` and render its output; the list below is what it checks and is the fallback when the script is absent.

## Credentials

- The harness's credential is present and is an API credential: Claude `ANTHROPIC_API_KEY` or workload identity federation (`id-token: write` on the job and the Anthropic organization linked); Codex `CODEX_API_KEY`; Copilot `copilot-requests: write` on the job and the org policy allowing CLI billing. Fix: add the secret or permission the workflow names.
- Warn when `CLAUDE_CODE_OAUTH_TOKEN` is set: plan limits assume ordinary individual use, and a present API key silently wins. Fix: `credential: plan` only on your own repository.
- A one-call probe (`claude -p 'reply ok' --output-format json`, `codex exec --json 'reply ok'`, `copilot -p 'reply ok'`) reports the resolved model and that usage output is present. Fix: install or log in to the CLI; for Codex confirm the key is on the step, not the job.

## GitHub

- `FACTORY_APP_ID` and `FACTORY_APP_PRIVATE_KEY` mint an installation token with contents, pull requests, issues and projects on this repository and nothing more. Fix: create or reinstall the App (`/factory setup`).
- The job token is read-only on code (`permissions: contents: read`). Fix: edit the workflow's `permissions:`.
- The merge queue is on for the default branch with the CI workflow's checks required, and that workflow listens on `pull_request` and `merge_group`. Fix: branch protection via setup; add `merge_group:` to the CI workflow's `on:`.
- The `factory:objective` label exists; the Project board has Queued, Running, In review, Blocked and Done; `notify` resolves to a user with access. Fix: setup creates the label and board.

## Repository

- `setup` runs clean; each validation command exists in the repository's scripts; `pnpm`/`npm`/`cargo` installs offline from the lockfile; the protected paths exist; repository skills under `.agents/skills/` parse (frontmatter `name` and `description`) and fit one page. Fix: named per failure.

## Runner

- `runs-on` resolves; the harness CLI installs on it; `timeout_minutes` fits the runner's ceiling (360 hosted, 7200 self-hosted). Fix: lower the timeout or move to self-hosted.

## After

End with one line: `ready` when nothing failed, else the count of failures and `run /factory setup to apply the GitHub fixes`. These same checks are the first step of every worker job, which Blocks with the failing line.
