---
name: doctor
description: /factory:doctor. Check that this repository, its GitHub settings, its model credential and its runner are ready for unattended Factory runs, and name the fix for each failure. Use when the user asks whether Factory is set up, why Objectives Block at the first step, or before enabling the workflow.
---

# /factory:doctor

Run every check, print one line per check (`PASS`, `WARN` or `FAIL`, then the fix), and stop. Change nothing; `/factory:setup` applies fixes on consent. Run the plugin's `scripts/doctor.mjs` and render its output:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs" --repo OWNER/NAME --checkout . --json [--probe] [--run-setup] [--local]
```

The GitHub checks need the App's installation token: the user exports `FACTORY_APP_TOKEN`, or `FACTORY_APP_ID` and `FACTORY_APP_PRIVATE_KEY="$(cat <path>.pem)"`, in their own shell. Without one, doctor checks the secrets by name and reads GitHub with the user's `gh` login; inside a job, every GitHub line FAILs with "no installation token". `--probe` makes the one-call harness probe; `--run-setup` executes the repository's `setup` command instead of only finding it. `--local` adds local mode's checks: a repository that uses Postgres needs `FACTORY_LOCAL_DB=1` there. The list below is what the script checks.

## Credentials

- The harness's credential is present and is an API credential: Claude `ANTHROPIC_API_KEY` or workload identity federation (`id-token: write` on the job and the Anthropic organization linked); Codex `FACTORY_CODEX_GATEWAY_KEY` (through the Vercel AI Gateway; `--probe` checks the key against the gateway's free model list) or `CODEX_API_KEY`; Copilot `copilot_github_token`, which a probe shows cannot write to the repository. Fix: add the secret the workflow names.
- Warn when `CLAUDE_CODE_OAUTH_TOKEN` is set: plan limits assume ordinary individual use, and a present API key silently wins. Fix: `credential: plan` only on your own repository.
- With `--probe`, a one-call probe through the worker's own harness command reports the resolved model and that usage output is present. Fix: install or log in to the CLI; for Codex confirm the key is on the step, not the job.

## GitHub

- The App's installation token mints with its permission list on this repository (README; a missing read FAILs) and nothing more. Fix: create or reinstall the App (`/factory:setup`).
- The workflow checks read `.github/workflows/factory.yml` from the default branch on GitHub, which is what runs use; a local copy that differs is a warning. Fix: pull the default branch.
- The job token is read-only on code (`permissions: contents: read`, plus `actions: read` for the usage artifacts). Fix: edit the workflow's `permissions:`.
- The merge queue is on for the default branch with the CI workflow's checks required, and that workflow listens on `pull_request` and `merge_group`. Fix: setup's protection step; add `merge_group:` to the CI workflow's `on:`.
- The `factory:objective` label exists; the Project board has Queued, Running, In review, Blocked and Done; `notify` resolves to a collaborator. Fix: setup creates the label and board.

## Repository

- `setup` is present (runs clean with `--run-setup`); each validation command names a script in `package.json` or a binary that exists; a lockfile is recognised (or `install` is set); the protected paths exist and cover every repository file the `setup` command names (it runs beside the App's key; a file those read, such as a `Makefile` for `make setup` or `package.json` for `npm run setup`, is not detected, so protect it yourself); repository skills under `.agents/skills/` parse (frontmatter `name` and `description`) and fit one page; when `.gitattributes` routes files through Git LFS, `git-lfs` is installed. Fix: named per failure.

## Runner

- The harness CLI, `gh` and `git` are on PATH; `timeout_minutes` fits the runner's ceiling (360 hosted, 7200 self-hosted). Fix: lower the timeout or move to self-hosted.

## After

End with one line: `ready` when nothing failed, else the count of failures and `run /factory:setup to apply the GitHub fixes`. These same checks are the first step of every worker job, which Blocks with the failing line.
