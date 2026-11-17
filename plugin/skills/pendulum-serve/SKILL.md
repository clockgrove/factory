---
name: pendulum-serve
description: "Start Clockgrove Pendulum's local loop for the current repository on this machine (`pendulum serve`) on the user's yes: it takes the Objectives labelled pendulum:local (every one where no Action is active), works, reviews and merges them in sandboxes on this machine's harness login, and resumes its own paused work first; also supervises the queue with `pendulum wait`. Use when the user asks to run Clockgrove Pendulum locally, serve, or work the queue on their machine. Not for one Objective by number (pendulum-run) or kicking the Action's dispatcher (pendulum-kick)."
---

# /pendulum:pendulum-serve

Start local mode's loop for the repository whose clone is the current directory. `<plugin root>` is `${CLAUDE_PLUGIN_ROOT}` in Claude Code, elsewhere two directories above this SKILL.md; where `pendulum` is not on PATH (only Claude Code puts the plugin's `bin/` there), run `node <plugin root>/scripts/local.mjs` instead. It applies the dispatcher's rules every 30 seconds (order, caps, blocking, send-backs, Done) and runs the picks here, as many as the machine's stage budget, its load and `PENDULUM_LOCAL_MAX_CONCURRENT` allow, reviews before new work and this machine's paused Objectives before both.

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
