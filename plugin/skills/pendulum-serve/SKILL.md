---
name: pendulum-serve
description: "Supervise Pendulum's local queue and leave implementation to its dispatched worker. Use when asked to keep the queue moving, use spare capacity, pick up eligible work, or run `pendulum serve` locally on the user's yes. Not for admitting an issue (pendulum-file), running one Objective (pendulum-run), or kicking Actions."
---

# /pendulum:pendulum-serve

The loop checks the current repository every 30 seconds. It resumes this machine's paused Objectives first, then reviews, then new work, within the machine's capacity and `PENDULUM_LOCAL_MAX_CONCURRENT`. `<plugin root>` is `${CLAUDE_PLUGIN_ROOT}` in Claude Code, elsewhere two directories above this SKILL.md; where `pendulum` is not on PATH (only Claude Code puts the plugin's `bin/` there), run `node <plugin root>/scripts/local.mjs` instead.

## Supervise the queue

- Use pendulum-status and the loop's output. For a draft or an [open dependency](../pendulum-file/reference.md#start-a-draft), name what keeps the issue ineligible and look for eligible work. Use pendulum-file for requested admission. `pendulum:local` selects the route.
- Leave eligible work with the existing dispatcher. Cite a recorded stage start, Pendulum run or current progress comment, or verified active claim before reporting that work began. A tick pick or Running label can precede the claim. Follow active work or use the supported lifecycle operation for paused work.
- Limit supervision to issue and queue operations. Leave source discovery, branches, edits and delegation to the worker with a rendered task card. Use pendulum-run for an explicit single-Objective run, including `--here` when the user selects it and its preconditions pass.

## Start

1. The current directory is a clone of the target repository, never `clockgrove/pendulum` itself. Stop and say so otherwise.
2. Ask: say what `pendulum serve` takes: the Objectives labelled `pendulum:local` and, where no Action is active, every Objective, which it labels. Add `--all` only when the user wants all Objectives here and no Action running any: with an active Action, both race for unlabelled ones. Say that it works, reviews and, with `auto_merge` on, merges them as the Action does, pushing and posting as the user (local mode's token), and its spend caps: each stage stops at `max_usd` and nothing new starts once the day's spend passes `daily_usd` (doctor's `settings` row names both). Wait for a yes.
3. On a yes, run `pendulum serve`. It runs until stopped: start it in the background. Where this harness cannot run a command in the background, give the user the command to run in a terminal of their own and work from the lines they paste.
4. Read its first lines. It refuses with one line naming the fix when local mode is not set up (the token file, `srt`, a harness login, the platform): relay that line, and offer the pendulum-setup skill's local mode. Do not work around a refusal.
5. Tell the user in three lines: that it is running and how many it runs at once, what the first tick did (picks, reviews, resumes, spend today), and how to stop it.

## While it runs

Report `[#<issue> …]` exits and PR links when the user asks, from its output. Never start a second `serve` for the same clone.

When you supervise the queue for the user, wait on it rather than on `serve`'s log: run `pendulum wait --on blocked,question,merged,closed,drained` in the background. It exits 0 with one JSON line per event (`event`, `issue`, `url`, `cursor`), 3 on `--timeout`. Handle each line (read a Blocked or Question issue's Pendulum comment before acting), then start it again with `--since <cursor>` from its last line, so nothing between the two runs is missed. Its lines are decided on labels and PR state; act on `event` and `issue`, never on the title.

## Usage limits and accounts

A usage limit pauses a stage rather than failing it; moving a paused Objective to another account, automatic choice and lifting a hold: [reference.md](reference.md).

## Stop

Stop it with Ctrl-C, or by ending that process. Stopping pauses its Objectives: they stay Running with their claims, and the next `pendulum serve` on this machine resumes them first. The dispatcher Blocks one after `claim_pause_hours` away (a day by default).
