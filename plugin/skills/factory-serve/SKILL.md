---
name: factory-serve
description: "/factory:factory-serve. Start Clockgrove Factory's local loop for the current repository on this machine (`factory serve`): it takes the Objectives labelled factory:local (every one where no Action is active), works and reviews them in sandboxes on this machine's harness login, and resumes its own paused work first. Use when the user asks to run Clockgrove Factory locally, serve, or work the queue on their machine."
---

# /factory:factory-serve

Start local mode's loop for the repository whose clone is the current directory. It applies the dispatcher's rules every 30 seconds (order, caps, blocking, send-backs, Done) and runs the picks here, as many as the machine's stage budget, its load and `FACTORY_LOCAL_MAX_CONCURRENT` allow, reviews before new work and this machine's paused Objectives before both (docs/LOCAL.md).

## Start

1. The current directory is a clone of the target repository, never `clockgrove/factory` itself. Stop and say so otherwise.
2. Run `factory serve` (the plugin's `bin/` is on PATH; else `node <plugin root>/scripts/local.mjs serve`). Where no Action is active, it takes and labels every Objective. Add `--all` only when the user wants all Objectives here and no Action running any: with an active Action, both race for unlabelled ones. It runs until stopped: start it in the background.
3. Read its first lines. It refuses with one line naming the fix when local mode is not set up (the token file, `srt`, a harness login, the platform): relay that line, and point to docs/LOCAL.md "Set it up". Do not work around a refusal.
4. Tell the user in three lines: that it is running and how many it runs at once, what the first tick did (picks, reviews, resumes, spend today), and how to stop it.

## While it runs

Report `[#<issue> …]` exits and PR links when the user asks, from its output. Never start a second `serve` for the same clone.

When you supervise the queue for the user, wait on it rather than on `serve`'s log: run `factory wait --on blocked,question,merged,closed,drained` in the background (else `node <plugin root>/scripts/local.mjs wait ...`). It exits 0 with one JSON line per event (`event`, `issue`, `url`, `cursor`), 3 on `--timeout`. Handle each line (read a Blocked or Question issue's Factory comment before acting), then start it again with `--since <cursor>` from its last line, so nothing between the two runs is missed. Its lines are decided on labels and PR state; act on `event` and `issue`, never on the title.

## Usage limits and accounts

Each stage runs on one account of its harness for its whole run (docs/LOCAL.md, Accounts; the user declares several in `~/.config/factory/accounts.json`: never open it). A usage limit is no crash: a reset within fifteen minutes is waited out in place; further out the stage pauses, keeps its claim, and the loop posts one pause notice on the issue naming the account, its reset, and the free accounts to move it to (with automatic choice, that it moves by itself). The limit holds only that account, for every `serve` here, until its reset; stages on the others go on.

- **Move it:** the label `factory:account:<name>`, applied by someone who can push (or a maintainer the workflow names), moves a paused Objective to that account at once when it is free, and pins every later stage there; a running stage finishes where it started. Apply it only on the user's yes.
- **Automatic choice:** with `FACTORY_LOCAL_AUTO_ACCOUNT=1` in the shell that starts `serve`, an unlabelled stage starts on the free account with the most quota left (as its provider reports it; else in turn), and a paused Objective moves by itself. It waits only while every account is held.
- **Lift a hold:** when quota is back, `factory hold list` shows holds; `factory hold release <account>` (as listed; `--repo OWNER/NAME` for Actions and the cloud sandbox) lifts one, on the user's yes. An older `serve` sees it only after a restart on this release. Never delete hold files.

## Stop

Stop it with Ctrl-C, or by ending that process. Stopping pauses its Objectives: they stay Running with their claims, and the next `factory serve` on this machine resumes them first. The dispatcher Blocks one after `claim_pause_hours` away (a day by default).
