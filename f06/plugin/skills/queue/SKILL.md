---
name: queue
description: /factory:queue. Start the unattended Factory scheduler for the current repository: dispatch the Action's workflow when .github/workflows/factory.yml exists, otherwise explain the harness-cloud scheduled-task path for this harness. Use when the user asks to queue, start, kick or run the Factory queue unattended.
---

# /factory:queue

Start unattended work. Nothing here runs an Objective in this session; it starts the scheduler that does.

## When the workflow exists

`.github/workflows/factory.yml` present means the Action is installed. Kick it now rather than waiting for its cron:

```sh
gh workflow run factory.yml            # the dispatcher picks what is ready
gh workflow run factory.yml -f issue=N # one Objective, state and blocking rules still apply
```

Then `gh run list --workflow factory.yml --limit 3` and show the user the run link. The dispatcher picks ready Objectives (labelled, not blocked by an open issue, not Running, Blocked, Question or In review), orders them `P0`, `P1`, `P2`, then issue number, starts up to `max_concurrent` and stops at `daily_usd`. A run that starts nothing says why in its log; show that line.

Never run the plugin's `scripts/dispatch.mjs` from this session except as `node "${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.mjs" --repo OWNER/NAME --dry-run` to preview what the next tick would pick: a real local run marks issues Running on the board and no worker job exists outside the workflow to run them.

If `/factory:doctor` has not run on this repository in this session, run it first; a misconfigured repository Blocks every Objective with the same one-line reason and spends a runner minute each.

## When the workflow is absent

Say that the Action is the primary path and `/factory:setup` installs it in about three minutes, then explain the cloud path for this harness, which bills the user's plan:

- **Claude Code.** Claude's cloud sessions load committed `.claude/` directories but not repository-declared plugins, so the skills and agent definitions must be committed under `.claude/skills/` and `.claude/agents/` first (see `/factory:setup`, step 4). Create a scheduled task in Claude's cloud whose prompt is the rendered task card for `/factory:run <issue>` and whose setup script installs the toolchain (the repository's `setup` command); the cloud proxy blocks GraphQL, so the prompt must say to use `gh api` REST calls, not `gh pr` or `gh issue`.
- **Codex.** Commit the skills under `.agents/skills/` and the agents under `.codex/agents/`. Create a Codex cloud task from the same task card with network enabled for the agent phase (it is offline by default) and the toolchain in its setup script.
- **Copilot.** Commit the skills under `.agents/skills/` (Copilot reads it) and the agents under `.github/agents/`. Assign the issue to the Copilot coding agent with the task card as the first comment; its session is an Actions job capped at 59 minutes, so an Objective that needs more must be split per `implement-split`.

In each case the merge path (App token, merge queue, reviewer) still needs the Action, so a cloud run ends at an open PR unless the workflow is installed. Say that plainly.
