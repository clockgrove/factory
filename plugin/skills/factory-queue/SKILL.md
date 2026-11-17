---
name: factory-queue
description: "Start the unattended Clockgrove Factory scheduler for the current repository on the user's yes: preview what the Action's dispatcher would start and its spend caps, then dispatch the workflow when .github/workflows/factory.yml exists; otherwise explain the harness-cloud path for this harness. Also names the three off-machine routes and how an Objective moves between local mode and the Action. Use when the user asks to queue, start, kick or run the Clockgrove Factory queue unattended, or what running off this machine takes. Not for working Objectives on this machine (factory-serve, factory-run)."
---

# /factory:factory-queue

Start unattended work: this starts the scheduler, never an Objective in this session. `<plugin root>` is `${CLAUDE_PLUGIN_ROOT}` in Claude Code, elsewhere two directories above this SKILL.md; where `factory` is not on PATH (only Claude Code puts the plugin's `bin/` there), run `node <plugin root>/scripts/local.mjs` instead.

## When the workflow exists

The Action is installed. If the factory-doctor skill has not run here this session, run it first: a misconfigured repository Blocks every Objective with one reason, a runner minute each.

### Ask

A dispatch starts paid work, so show what it will do and wait for a yes:

- The caps: the dispatcher starts up to `max_concurrent` at once and nothing once the day's spend (UTC) passes `daily_usd`; each stage stops at `max_usd`. Read them from the committed workflow's env block (`FACTORY_MAX_CONCURRENT`, `FACTORY_DAILY_USD`, `FACTORY_MAX_USD`; the default branch's `.github/workflows/factory.yml` in the clone, or `gh api repos/OWNER/NAME/contents/.github/workflows/factory.yml --jq .content | base64 -d`), with any repository variable of the same name (`gh variable list`) over it. One set nowhere is its default: say so (3 at once, $100 a day, $25 a stage).
- What it would start: [reference.md](reference.md), Preview the picks. The dispatcher picks ready Objectives (labelled, not blocked by an open issue, not Running, Blocked, Question or In review), orders them `P0`, `P1`, `P2`, then issue number.
- With an issue number, it dispatches that one Objective alone; its state and blocking rules still apply.

### Dispatch

On a yes, run one of:

```sh
gh workflow run factory.yml            # the dispatcher picks what is ready
gh workflow run factory.yml -f issue=N # one Objective
```

Show the run link from `gh run list --workflow factory.yml --limit 3`. A run that starts nothing says why in its log; show that line. Supervise with `factory wait` (the factory-serve skill).

Asked what running off this machine takes, or how an Objective moves between local mode and the Action: [reference.md](reference.md).

## When the workflow is absent

Say the factory-setup skill installs the Action and local mode (the factory-serve skill) needs none; then explain the harness cloud for this harness:

- **Claude Code.** Claude's cloud sessions load committed `.claude/` directories, not repository-declared plugins: commit the worker skills and agents under `.claude/skills/` and `.claude/agents/` first (the factory-setup skill, step 4). Create a scheduled task in Claude's cloud whose prompt is the task card the factory-run skill renders for `--here` and whose setup script installs the toolchain (the repository's `setup` command).
- **Codex.** Commit the worker skills under `.agents/skills/` and the agents under `.codex/agents/` (step 4 as well). Create a Codex cloud task from the same task card, network enabled for the agent phase (offline by default), the toolchain in its setup script.
- **Copilot.** Commit the worker skills under `.agents/skills/` (Copilot reads it) and the agents under `.github/agents/` (step 4 as well). Assign the issue to the Copilot coding agent with the task card as the first comment; its session is an Actions job capped at 59 minutes, so split a longer Objective per `factory-implement-split`.

In each case the session only commits and leaves its hand-off files: the task card forbids GitHub writes and nothing in the vendor's cloud runs `factory deliver`, so a harness-cloud run opens no PR. For a merged PR, use the Action, the cloud sandbox or local mode; say that plainly.
