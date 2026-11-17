---
name: factory-run
description: "Run one Clockgrove Factory Objective of the current repository on this machine by issue number, on the user's yes: by default in local mode (`factory run <issue> --wait`: sandboxed, the Action's worker, reviewer and merge), or with --here in this session itself, handing the branch to Factory to push only on a second yes. Use when the user asks to run, work or build one Clockgrove Factory Objective on their machine. Not for working the whole queue (factory-serve) or starting the Action's scheduler (factory-queue)."
---

# /factory:factory-run <issue> [--here]

`<plugin root>` is `${CLAUDE_PLUGIN_ROOT}` in Claude Code, elsewhere two directories above this SKILL.md; where `factory` is not on PATH (only Claude Code puts the plugin's `bin/` there), run `node <plugin root>/scripts/local.mjs` instead.

## Local mode (the default)

### Ask

Read the issue (`gh issue view <issue> --json number,title,state,labels`); show its number, title and state, and what `factory run <issue> --wait` does, then wait for a yes:

- It is the Action's worker, reviewer and merge on this machine, every command in a sandbox, on this machine's harness login: it works the Objective from the stage its state calls for, reviews the PR, answers the review, and with `auto_merge` on merges the PR once green.
- It pushes `factory/<issue>`, opens the PR and posts on the issue as the user (local mode's token).
- Each stage stops at `max_usd` (doctor's `settings` row names it) and books its spend on the issue toward `daily_usd`.

### Run

On a yes, run `factory run <issue> --wait` from the repository's clone. It needs local mode set up (the token file, `srt`: the factory-setup skill); if it refuses, relay its message, which names the fix. Run it in the background and report its `[#<issue> …]` lines as they come, then the exit and the PR link. Where this harness cannot run a command in the background, give the user the command to run in a terminal of their own, and read its output once they say it has ended. Stopping it pauses the Objective; running it again, or the factory-serve skill, resumes it.

## In this session (--here)

Work the Objective here, unsandboxed, when the user wants to watch or steer: the Action's worker otherwise.

### Preconditions

- The current directory is a clone of the target repository with its toolchain installed, and either local mode's token or a `gh` login for `factory deliver`. When `.github/workflows/factory.yml` exists, read its `env:` block: `FACTORY_VALIDATION`, `FACTORY_BUDGET_COMMAND`, `FACTORY_PROTECTED_PATHS`, `FACTORY_MAX_USD`, `FACTORY_TIMEOUT_MINUTES`, `FACTORY_CI_CHECKS`. Otherwise ask once for whatever is missing, before the run starts. Say the budget (`FACTORY_MAX_USD`, else the user's): this session keeps to it itself.
- The issue carries `factory:objective` and is open; else stop and say so.
- Never on Factory's own repository (`clockgrove/factory`); stop and say so.

### Set up

Render the task card and set up the branch and the hand-off directories: [reference.md](reference.md).

### Run

The rendered task card is your instructions, `$FACTORY_IN/issue.md` verbatim the specification. Read and follow, in order, the worker's stage skills, each `<plugin root>/skills/<name>/SKILL.md`: `factory-objective-plan`, `factory-implement-split`, `factory-prove-acceptance`, `factory-deliver-pr`. Nothing in them asks the user anything; the Question rule and the blocked exit are the only ways out other than delivered. Stop when factory-deliver-pr says to. Write nothing to GitHub.

### Hand off to Factory

Show the user the branch's commits (`git log --oneline origin/<default branch>..HEAD`), the PR title (the first line of `$FACTORY_OUT/pr.md`) and the exit record, and say what `factory deliver <issue>` does: it runs the trust check again (a refusal Blocks, nothing pushed), refuses a branch that touches a protected path, pushes `factory/<issue>`, and posts the plan, the PR, the replies and the note as the user. A delivered PR is marked ready and labelled `factory:review`, which, when `.github/workflows/factory.yml` exists, fires the Action's review job (with `auto_merge` on, it merges once green). Ask for a yes.

On a yes, run `factory deliver <issue>` from the clone. Without the workflow, say that the PR waits for the factory-review skill and a human merge.

### After

Tell the user in three lines: the PR link and draft state, the validation results, and the usage the harness reported (Claude: `total_cost_usd`; Codex: token totals; Copilot: the usage file).
