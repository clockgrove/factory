---
name: factory-serve
description: "/factory:factory-serve. Start Clockgrove Factory's local loop for the current repository on this machine (`factory serve`): it takes the Objectives labelled factory:local (or all with --all), works and reviews them in sandboxes on this machine's harness login, and resumes its own paused work first. Use when the user asks to run Clockgrove Factory locally, serve, or work the queue on their machine."
---

# /factory:factory-serve

Start local mode's loop for the repository whose clone is the current directory. It applies the dispatcher's rules every 30 seconds (order, caps, blocking, send-backs, Done) and runs the picks here, at most `FACTORY_LOCAL_MAX_CONCURRENT` at once, reviews before new work and this machine's paused Objectives before both (docs/LOCAL.md).

## Start

1. The current directory is a clone of the target repository, never `clockgrove/factory` itself (Factory is not a consumer of Factory). Stop and say so otherwise.
2. Run `factory serve` (the plugin's `bin/` is on PATH; else `node <plugin root>/scripts/local.mjs serve`). Add `--all` only when the user asked for every Objective, not just those labelled `factory:local`. It runs until stopped: start it in the background, not in the foreground of this session.
3. Read its first lines. It refuses with one line naming the fix when local mode is not set up (the token file, `srt`, a harness login, the platform): relay that line, and point to docs/LOCAL.md "Set it up". Do not work around a refusal.
4. Tell the user in three lines: that it is running and how many it runs at once, what the first tick did (picks, reviews, resumes, spend today), and how to stop it.

## While it runs

Report `[#<issue> …]` exits and PR links when the user asks, from its output. Do not start a second `serve` for the same clone.

When you supervise the queue for the user, wait on it rather than on `serve`'s log: run `factory wait --on blocked,question,merged,closed,drained` in the background (else `node <plugin root>/scripts/local.mjs wait ...`). It exits 0 with one JSON line per event (`event`, `issue`, `url`, `cursor`), 3 on `--timeout`. Handle each line (read a Blocked or Question issue's Factory comment before acting), then start it again with `--since <cursor>` from its last line, so nothing between the two runs is missed. Its lines are decided on labels and PR state; act on `event` and `issue`, never on the title.

## Stop

Stop it with Ctrl-C, or by ending that process. Stopping pauses its Objectives: they stay Running with their claims, and the next `factory serve` on this machine resumes them first. The dispatcher Blocks one only after a day away.
