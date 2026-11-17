---
name: pendulum-doctor
description: "Check that this repository, its GitHub settings, its model credential and its runner are ready for unattended Pendulum runs, and name the fix for each failure; changes nothing. Use when the user asks whether Pendulum is set up, why Objectives Block at the first step, or before enabling the workflow. Not for applying the fixes (pendulum-setup)."
---

# /pendulum:pendulum-doctor

Print one line per check (`PASS`, `WARN` or `FAIL`, then the fix), and stop. Change nothing; the pendulum-setup skill applies fixes on consent. `<plugin root>` is `${CLAUDE_PLUGIN_ROOT}` in Claude Code, elsewhere two directories above this SKILL.md; where `pendulum` is not on PATH (only Claude Code puts the plugin's `bin/` there), run `node <plugin root>/scripts/local.mjs` instead. Run the plugin's doctor and render its output:

```sh
node "<plugin root>/scripts/doctor.mjs" --repo OWNER/NAME --checkout . --json [--probe] [--run-setup] [--local]
```

The GitHub checks need the App's token: the user exports `PENDULUM_APP_TOKEN`, or `PENDULUM_APP_ID` and `PENDULUM_APP_PRIVATE_KEY="$(cat <path>.pem)"`, in their own shell. Flags, reads without a token, and settings: [reference.md](reference.md).

## Credentials

- The harness's credential is present and is an API credential: Claude `ANTHROPIC_API_KEY` or workload identity federation (`id-token: write` on the job and the Anthropic organization linked); Codex `PENDULUM_CODEX_GATEWAY_KEY` (a Vercel AI Gateway key; `--probe` checks it against the gateway's free model list) or `CODEX_API_KEY`; Copilot `copilot_github_token`, which a probe shows cannot write to the repository. Fix: add the secret the workflow names.
- `credential: plan` runs Claude on `CLAUDE_CODE_OAUTH_TOKEN` alone, the user's subscription: a warning, as plan limits assume ordinary individual use on their own repository. Fix: the secret if missing.
- Accounts: `PENDULUM_ACCOUNTS` parses, matches the rendered workflow, and each account's secret exists; `PENDULUM_AUTO_ACCOUNT` is `1` or `0`, and with it on, one locked holds issue; `--local`: one `account <name>` row per declared account. Fix: per row (pendulum-setup's reference.md, Several accounts).
- With `--probe`, a one-call probe through the worker's harness command reports the resolved model and that usage output is present. Fix: install or log in to the CLI; for Codex confirm the key is on the step, not the job.

## GitHub

- The App's installation token mints with pendulum-setup's permission list on this repository (a missing read FAILs) and nothing more. Fix: create or reinstall the App (`/pendulum:pendulum-setup`).
- The workflow checks read the default branch's `.github/workflows/pendulum.yml` on GitHub, as runs do; a differing local copy is a warning. Fix: pull the default branch.
- The job token is read-only on code (`permissions: contents: read`, plus `actions: read` for the usage artifacts). Fix: edit the workflow's `permissions:`.
- No `secrets[...]` lookup, which sends the runner every secret. Fix: re-render.
- The default branch requires checks (none FAILs). Its merge queue: off is a warning while required checks gate merges (concurrent Objectives are then not re-tested on the integrated head; GitHub offers no queue on a repository a user owns), a FAIL with none. Workflows on `pull_request` and, with the queue on, `merge_group` (parsed `on:`) make each required check (unread, or unmade: a warning). Fix: setup's protection step; add the missing event to that workflow's `on:`.
- The `pendulum:objective` label exists; the Project board has Queued, Running, In review, Blocked and Done; `notify` is a collaborator. Fix: setup creates the label and board.

## Repository

- `setup` and validation parse, their first command exists (else a warning), an `npm|pnpm run` script exists; `--run-setup` runs `setup`; a lockfile is recognised (or `install` is set); the protected paths exist and cover every repository file the `setup` command names, each literally (no variable or glob; a `Makefile` those read is not followed: protect it yourself); repository skills under `.agents/skills/` parse (frontmatter `name` and `description`) and fit one page; when `.gitattributes` routes files through Git LFS, `git-lfs` is installed. Fix: named per failure.

## Runner

- The harness CLI, `gh` and `git` are on PATH; `timeout_minutes` fits the runner's ceiling (360 hosted, 7200 self-hosted). Fix: lower the timeout or self-host.

## After

End with one line: `ready`, then next: say what to build, and the pendulum-file skill files it as an Objective; or the failure count and `run the pendulum-setup skill to apply the GitHub fixes`. Every worker job runs these checks first, Blocking on a FAIL.
