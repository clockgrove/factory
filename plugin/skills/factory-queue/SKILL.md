---
name: factory-queue
description: "/factory:factory-queue. Start the unattended Clockgrove Factory scheduler for the current repository: dispatch the Action's workflow when .github/workflows/factory.yml exists, otherwise explain the harness-cloud path; name the three off-machine routes (the Action, the cloud sandbox, the harness cloud) and how an Objective moves between local mode and the Action. Use when the user asks to queue, start, kick or run the Clockgrove Factory queue unattended, or what running off this machine takes."
---

# /factory:factory-queue

Start unattended work: this starts the scheduler, never an Objective in this session.

## When the workflow exists

The Action is installed. Kick it rather than wait for its cron:

```sh
gh workflow run factory.yml            # the dispatcher picks what is ready
gh workflow run factory.yml -f issue=N # one Objective, state and blocking rules still apply
```

Show the run link from `gh run list --workflow factory.yml --limit 3`. The dispatcher picks ready Objectives (labelled, not blocked by an open issue, not Running, Blocked, Question or In review), orders them `P0`, `P1`, `P2`, then issue number, starts up to `max_concurrent` and stops at `daily_usd`. A run that starts nothing says why in its log; show that line.

Never run the plugin's `scripts/dispatch.mjs` from this session except as `node "${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.mjs" --repo OWNER/NAME --dry-run` to preview the next tick's picks: a real run here marks issues Running with no worker job to run them.

If `/factory:factory-doctor` has not run here this session, run it first: a misconfigured repository Blocks every Objective with one reason, a runner minute each.

## Routes off this machine

Asked what running off this machine takes, name all three:

- **The Action.** `.github/workflows/factory.yml` from `/factory:factory-setup`, the App's two secrets and a model credential. Jobs run on GitHub's runners (`timeout_minutes` under 360 on hosted ones) and open the PR; `--auto-merge` lands it, through a merge queue where GitHub offers one. Tests needing the user's machine (a database, a GPU) need a self-hosted runner (`--runs-on`) or local mode.
- **The cloud sandbox.** The same, rendered with `setup --sandbox vercel`, plus the `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID` secrets. Each Objective gets a Vercel sandbox from an image the repository's `setup` command builds (no Dockerfile, no systemd); short Action jobs start each stage there; PRs land as on the Action. A stage's session is `timeout_minutes` plus about 16 minutes, up to the plan's cap (24 hours on Vercel Pro). Vercel bills the team; Factory books each stage's sandbox cost on the issue toward `daily_usd` and `max_usd` (docs/ADAPTERS.md).
- **The harness cloud.** A scheduled session of the user's harness on their plan; it opens no PR (below).

## Moving an Objective between local and the Action

The `factory:local` label routes it: with it `factory serve` takes the Objective and the Action leaves it alone; without it the Action's next tick takes it (`gh workflow run factory.yml` for now). Move it between stages, not while one runs.

## When the workflow is absent

Say `/factory:factory-setup` installs the Action and local mode (`/factory:factory-serve`) needs none; then explain the harness cloud for this harness:

- **Claude Code.** Claude's cloud sessions load committed `.claude/` directories, not repository-declared plugins: commit the skills and agents under `.claude/skills/` and `.claude/agents/` first (`/factory:factory-setup`, step 4). Create a scheduled task in Claude's cloud whose prompt is the rendered task card for `/factory:factory-run <issue>` and whose setup script installs the toolchain (the repository's `setup` command).
- **Codex.** Commit the skills under `.agents/skills/` and the agents under `.codex/agents/`. Create a Codex cloud task from the same task card, network enabled for the agent phase (offline by default), the toolchain in its setup script.
- **Copilot.** Commit the skills under `.agents/skills/` (Copilot reads it) and the agents under `.github/agents/`. Assign the issue to the Copilot coding agent with the task card as the first comment; its session is an Actions job capped at 59 minutes, so split a longer Objective per `factory-implement-split`.

In each case the session only commits and leaves its hand-off files: the task card forbids GitHub writes and nothing in the vendor's cloud runs `factory deliver`, so a harness-cloud run opens no PR. For a merged PR, use the Action, the cloud sandbox or local mode; say that plainly.
