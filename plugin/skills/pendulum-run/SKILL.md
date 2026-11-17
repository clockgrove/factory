---
name: pendulum-run
description: "Run one Clockgrove Pendulum Objective of the current repository on this machine by issue number, on the user's yes: by default in local mode (`pendulum run <issue> --wait`: sandboxed, the Action's worker, reviewer and merge), or with --here in this session itself, handing the branch to Pendulum to push only on a second yes. Use when the user asks to run, work or build one Clockgrove Pendulum Objective on their machine. Not for working the whole queue (pendulum-serve) or kicking the Action's dispatcher (pendulum-kick)."
---

# /pendulum:pendulum-run <issue> [--here]

`<plugin root>` is `${CLAUDE_PLUGIN_ROOT}` in Claude Code, elsewhere two directories above this SKILL.md; where `pendulum` is not on PATH (only Claude Code puts the plugin's `bin/` there), run `node <plugin root>/scripts/local.mjs` instead.

## Local mode (the default)

### Ask

Show the issue's number, title and state (`gh issue view <issue> --json number,title,state,labels`) and what `pendulum run <issue> --wait` does; wait for a yes:

- It is the Action's worker, reviewer and merge on this machine, every command in a sandbox, on this machine's harness login: it works the Objective from the stage its state calls for, reviews the PR, answers the review, and with `auto_merge` on merges the PR once green.
- It pushes `pendulum/<issue>`, opens the PR and posts on the issue as the user (local mode's token).
- Each stage stops at `max_usd` (doctor's `settings` row) and books its spend on the issue toward `daily_usd`.

### Run

On a yes, run `pendulum run <issue> --wait` from the repository's clone. It needs local mode set up (the token file, `srt`: the pendulum-setup skill); if it refuses, relay its message, which names the fix. Run it in the background and report its `[#<issue> …]` lines as they come, then the exit and the PR link. Where this harness cannot run a command in the background, give the user the command to run in a terminal of their own, and read its output once they say it has ended. Stopping it pauses the Objective; running it again, or the pendulum-serve skill, resumes it.

## In this session (--here)

Work the Objective here, unsandboxed, when the user wants to watch or steer.

### Preconditions

- The current directory is a clone of the target repository with its toolchain installed, and either local mode's token or a `gh` login for `pendulum deliver`. When `.github/workflows/pendulum.yml` exists, read its `env:` block: `PENDULUM_VALIDATION`, `PENDULUM_BUDGET_COMMAND`, `PENDULUM_PROTECTED_PATHS`, `PENDULUM_MAX_USD`, `PENDULUM_TIMEOUT_MINUTES`, `PENDULUM_CI_CHECKS`. Otherwise ask once for whatever is missing, before the run starts. Say the budget (`PENDULUM_MAX_USD`, else the user's): this session keeps to it itself.
- The issue carries `pendulum:objective` and is open; else stop and say so.
- Never on Pendulum's own repository (`clockgrove/pendulum`); stop and say so.

### Set up

Render the task card and set up the branch and the hand-off directories: [reference.md](reference.md).

### Run

The rendered task card is your instructions, `$PENDULUM_IN/issue.md` verbatim the specification. Read and follow, in order, the worker's stage skills, each `<plugin root>/skills/<name>/SKILL.md` here, not the card's checkout paths: `pendulum-objective-plan`, `pendulum-implement-split`, `pendulum-prove-acceptance`, `pendulum-deliver-pr`. Nothing in them asks the user anything; the Question rule and the blocked exit are the only ways out other than delivered. Stop when pendulum-deliver-pr says to. Write nothing to GitHub.

### Hand off to Pendulum

Show the user the branch's commits (`git log --oneline origin/<default branch>..HEAD`), the PR title (the first line of `$PENDULUM_OUT/pr.md`) and the exit record, and say what `pendulum deliver <issue>` does: it runs the trust check again (a refusal Blocks, nothing pushed), refuses a branch that touches a protected path, pushes `pendulum/<issue>`, posts the plan, the PR, the replies and the note as the user, and applies the exit record: a delivered PR is marked ready and labelled `pendulum:review`, which, when `.github/workflows/pendulum.yml` exists, fires the Action's review job (with `auto_merge` on, the Action merges it once green). Ask for a yes.

On a yes, run `pendulum deliver <issue>` from the clone. Without the workflow, say that the PR waits for the pendulum-review-here skill and a human merge.

### After

Tell the user in three lines: the PR link and draft state, the validation results, and the usage the harness reported (Claude: `total_cost_usd`; Codex: token totals; Copilot: the usage file).
