---
name: pendulum-setup
description: "Install Clockgrove Pendulum in the current repository, one step at a time on the user's yes: add .github/workflows/pendulum.yml through a pull request, create the GitHub App, and apply the merge queue, labels, Project board and a read-only default workflow token; or set up local mode on the user's machine. Use when the user asks to set up, install or configure Clockgrove Pendulum for a repository. Not for checking whether it is set up (pendulum-doctor)."
---

# /pendulum:pendulum-setup

Each step changes the repository or its settings: say what it does and wait for a yes. `<plugin root>` is `${CLAUDE_PLUGIN_ROOT}` in Claude Code, elsewhere two directories above this SKILL.md; where `pendulum` is not on PATH (only Claude Code puts the plugin's `bin/` there), run `node <plugin root>/scripts/local.mjs` instead. The plugin's setup script does the work: `node "<plugin root>/scripts/setup.mjs" --repo OWNER/NAME --apply <step> --yes`, one consented step at a time; `<step>` is `workflow`, `app`, `labels`, `project`, `protection` or `default-token`. Without `--yes` it only previews: show that before asking.

## 1. The workflow file (`--apply workflow`)

On a first setup (no `.github/workflows/pendulum.yml` yet) ask only these three, together:

1. **The coding agent and its credential:** `--harness` (`claude`, `codex` or `copilot`) and `--credential` (`api`, or `plan` for Claude without a key); [reference.md](reference.md), Model credentials, names the secret.
2. **The spending caps:** `--max-usd` per job and `--daily-usd` per day.
3. **Auto-merge:** `--auto-merge` on or off.

For a first run, recommend `--preset first-run` as the answer to the caps and auto-merge (it leaves `daily_usd` at $100), one line each:

- `max_usd` 5: a job stops at about $5, so a wrong turn costs little.
- `max_concurrent` 1: one Objective at a time, so each one can be followed.
- `auto_merge` false: Pendulum's pull requests wait for the user's merge, so they read each first.

A flag beside the preset wins; everything else takes its default. Show the rendered file; on yes, write it (After lands it). Then list the defaults it took as "You can change these later", with where, from [reference.md](reference.md), Workflow settings (also re-renders and the cloud sandbox).

## 2. The GitHub App

Never read, print or copy the key. Offer `--apply app`, in the background where you can (it waits up to 30 minutes), and give the user the 127.0.0.1 address it prints; [reference.md](reference.md), The App, has its permissions, `--secret-scope org` and a browser that cannot load the address. The user clicks Create (setup saves `PENDULUM_APP_ID` and `PENDULUM_APP_PRIVATE_KEY`), then installs it on this repository only. Declined or failed: [reference.md](reference.md), The App by hand. Then the user saves the model credential with `gh secret set`.

## 3. GitHub settings

- **Labels** (`--apply labels`) and **Project board** (`--apply project`): as the App when its credentials are exported ([reference.md](reference.md), Labels and board), else as the user's `gh` login.
- **Merge queue and branch protection** (`--apply protection`): the `pendulum` ruleset on the default branch (a merge queue where GitHub offers one, and the required checks its preview names, read from the branch, a recent pull request or the CI workflow; `--ci-checks` overrides), as the user's `gh` login (admin). If the CI workflow lacks `merge_group:` under `on:`, offer to add it.
- **A read-only default workflow token** (`--apply default-token`, never part of `all`): doctor fails while the default `GITHUB_TOKEN` can write. Show the preview: the workflows that would get a read-only token, any called workflow among them that asks for write (it would then fail), and those left alone. One that writes with `GITHUB_TOKEN` needs `permissions:` first: ask. It changes no file.

## 4. Skills in the repository

For vendors' cloud sessions only: offer committed copies per [reference.md](reference.md).

## Local mode

Instead of or beside the Action, on the user's machine: walk [local.md](local.md) in place of steps 1 to 3; never ask for or read the tokens. Then offer `pendulum serve --once` from the clone: it lists anything missing and creates the `pendulum:local` label.

## Several accounts

Several subscriptions or keys of one harness: [reference.md](reference.md).

## After

On a yes, land the workflow file by pull request ([reference.md](reference.md)). Then run the pendulum-doctor skill; show its lines. End with what is left: the user merges it, then says what to build (the pendulum-file skill).
