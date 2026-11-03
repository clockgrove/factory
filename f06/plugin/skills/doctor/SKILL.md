---
name: doctor
description: /factory:doctor. Check that this repository, its GitHub settings, its model credential and its runner are ready for unattended Factory runs, and name the fix for each failure. Use when the user asks whether Factory is set up, why Objectives Block at the first step, or before enabling the workflow.
---

# /factory:doctor

Run every check, print one line per check (`PASS`, `WARN` or `FAIL`, then the fix), and stop. Change nothing; `/factory:setup` applies fixes on consent. When `<action>/scripts/doctor.mjs` exists (the Factory action checkout), run it and render its output:

```sh
node <action>/scripts/doctor.mjs --repo OWNER/NAME --checkout . --json [--probe] [--run-setup]
```

The GitHub checks need the App's installation token: the user exports `FACTORY_APP_TOKEN`, or passes `--app-id` and `--app-private-key <path>`; without one every GitHub line FAILs with "no installation token". `--probe` makes the one-call harness probe; `--run-setup` executes the repository's `setup` command instead of only finding it. The list below is what the script checks and the fallback when it is absent.

## Credentials

- The harness's credential is present and is an API credential: Claude `ANTHROPIC_API_KEY` or workload identity federation (`id-token: write` on the job and the Anthropic organization linked); Codex `CODEX_API_KEY`; Copilot `copilot-requests: write` on the job and the org policy allowing CLI billing. Fix: add the secret or permission the workflow names.
- Warn when `CLAUDE_CODE_OAUTH_TOKEN` is set: plan limits assume ordinary individual use, and a present API key silently wins. Fix: `credential: plan` only on your own repository.
- With `--probe`, a one-call probe (`claude -p 'reply ok' --output-format json`, `codex exec --json 'reply ok'`, `copilot -p 'reply ok'`) reports the resolved model and that usage output is present. Fix: install or log in to the CLI; for Codex confirm the key is on the step, not the job.

## GitHub

- The App's installation token mints with contents, pull requests, issues and projects on this repository and nothing more. Fix: create or reinstall the App (`/factory:setup`).
- The job token is read-only on code (`permissions: contents: read`, plus `actions: read` for the usage artifacts). Fix: edit the workflow's `permissions:`.
- The merge queue is on for the default branch with the CI workflow's checks required, Allow auto-merge is on, and that workflow listens on `pull_request` and `merge_group`. Fix: setup's protection step; add `merge_group:` to the CI workflow's `on:`.
- The `factory:objective` label exists; the Project board has Queued, Running, In review, Blocked and Done; `notify` resolves to a collaborator. Fix: setup creates the label and board.

## Repository

- `setup` is present (runs clean with `--run-setup`); each validation command names a script in `package.json` or a binary that exists; the lockfile installs offline; the protected paths exist; repository skills under `.agents/skills/` parse (frontmatter `name` and `description`) and fit one page. Fix: named per failure.

## Runner

- The harness CLI, `gh` and `git` are on PATH; `timeout_minutes` fits the runner's ceiling (360 hosted, 7200 self-hosted). Fix: lower the timeout or move to self-hosted.

## After

End with one line: `ready` when nothing failed, else the count of failures and `run /factory:setup to apply the GitHub fixes`. These same checks are the first step of every worker job, which Blocks with the failing line.
