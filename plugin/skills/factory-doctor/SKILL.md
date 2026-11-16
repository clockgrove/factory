---
name: factory-doctor
description: /factory:factory-doctor. Check that this repository, its GitHub settings, its model credential and its runner are ready for unattended Clockgrove Factory runs, and name the fix for each failure. Use when the user asks whether Clockgrove Factory is set up, why Objectives Block at the first step, or before enabling the workflow.
---

# /factory:factory-doctor

Run every check, print one line each (`PASS`, `WARN` or `FAIL`, then the fix), and stop. Change nothing; `/factory:factory-setup` applies fixes on consent. Run the plugin's `scripts/doctor.mjs` and render its output:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs" --repo OWNER/NAME --checkout . --json [--probe] [--run-setup] [--local]
```

The GitHub checks need the App's installation token: the user exports `FACTORY_APP_TOKEN`, or `FACTORY_APP_ID` and `FACTORY_APP_PRIVATE_KEY="$(cat <path>.pem)"`, in their own shell. Without one, doctor checks the secrets by name and reads GitHub with the user's `gh` login; inside a job, every GitHub line FAILs with "no installation token". `--run-setup` runs `setup`, not only finds it. `--local` adds local mode's checks (a Postgres repository needs `FACTORY_LOCAL_DB=1` there). Off Actions the settings (harness, models, credential) are the workflow's env block: without `--checkout`, the default branch's copy on GitHub (unreadable, a warning names the harness assumed); with it, that checkout's (`--local`: its default branch's). Repository `FACTORY_*` variables go over it (`--local`: read with the local token), and this shell's win; `settings` names each layer. Unknown flags exit 64.

## Credentials

- The harness's credential is present and is an API credential: Claude `ANTHROPIC_API_KEY` or workload identity federation (`id-token: write` on the job and the Anthropic organization linked); Codex `FACTORY_CODEX_GATEWAY_KEY` (a Vercel AI Gateway key; `--probe` checks it against the gateway's free model list) or `CODEX_API_KEY`; Copilot `copilot_github_token`, which a probe shows cannot write to the repository. Fix: add the secret the workflow names.
- Warn when `CLAUDE_CODE_OAUTH_TOKEN` is set: plan limits assume ordinary individual use, and a present API key silently wins. Fix: `credential: plan` only on your own repository.
- Accounts: `FACTORY_ACCOUNTS` parses, matches the rendered workflow, and each account's secret exists; `FACTORY_AUTO_ACCOUNT` is `1` or `0`, and with it on, one locked holds issue; `--local`: one `account <name>` row per declared account. Fix: per row (docs/INSTALL.md, Several accounts).
- With `--probe`, a one-call probe through the worker's harness command reports the resolved model and that usage output is present. Fix: install or log in to the CLI; for Codex confirm the key is on the step, not the job.

## GitHub

- The App's installation token mints with its permission list on this repository (README; a missing read FAILs) and nothing more. Fix: create or reinstall the App (`/factory:factory-setup`).
- The workflow checks read the default branch's `.github/workflows/factory.yml` on GitHub, as runs do; a differing local copy is a warning. Fix: pull the default branch.
- The job token is read-only on code (`permissions: contents: read`, plus `actions: read` for the usage artifacts). Fix: edit the workflow's `permissions:`.
- No `secrets[...]` lookup, which sends the runner every secret. Fix: re-render.
- The default branch has the merge queue on, the CI workflow's checks required, and its parsed `on:` lists `pull_request` and `merge_group` (unreadable: a warning). Fix: setup's protection step; add `merge_group:` to the CI workflow's `on:`.
- The `factory:objective` label exists; the Project board has Queued, Running, In review, Blocked and Done; `notify` is a collaborator. Fix: setup creates the label and board.

## Repository

- `setup` and validation parse, their first command exists (else a warning), an `npm|pnpm run` script exists; `--run-setup` runs `setup`; a lockfile is recognised (or `install` is set); the protected paths exist and cover every repository file the `setup` command names, each literally (no variable or glob; a `Makefile` those read is not followed: protect it yourself); repository skills under `.agents/skills/` parse (frontmatter `name` and `description`) and fit one page; when `.gitattributes` routes files through Git LFS, `git-lfs` is installed. Fix: named per failure.

## Runner

- The harness CLI, `gh` and `git` are on PATH; `timeout_minutes` fits the runner's ceiling (360 hosted, 7200 self-hosted). Fix: lower the timeout or self-host.

## After

End with one line: `ready`, or the failure count and `run /factory:factory-setup to apply the GitHub fixes`. Every worker job runs these checks first, Blocking on a FAIL.
