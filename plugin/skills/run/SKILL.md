---
name: run
description: "/factory:run <issue> [--here]. Run one Clockgrove Factory Objective of the current repository on this machine: by default in local mode (`factory run <issue>`, sandboxed, the Action's worker and reviewer); with --here, in this session itself. Use when the user asks to run, work or build a Clockgrove Factory Objective by issue number on their machine."
---

# /factory:run <issue> [--here]

## Local mode (the default)

Run `factory run <issue> --wait` from the repository's clone (the plugin's `bin/` is on PATH; else `node <plugin root>/scripts/local.mjs run <issue> --wait`). It is the Action's worker, reviewer and merge, on this machine's harness login, every command in a sandbox (docs/LOCAL.md). It needs local mode set up (the token file, `srt`); if it refuses, relay its message, which names the fix. Run it in the background and report its `[#<issue> …]` lines as they come, then the exit and the PR link. Stopping it pauses the Objective; running it again, or `/factory:serve`, resumes it.

## In this session (--here)

Work the Objective here, unsandboxed, when the user wants to watch or steer: the Action's worker otherwise.

### Preconditions

- The current directory is a clone of the target repository with its toolchain installed, and either local mode's token (docs/LOCAL.md) or a `gh` login for `factory deliver`. When `.github/workflows/factory.yml` exists, read its `env:` block: `FACTORY_VALIDATION`, `FACTORY_BUDGET_COMMAND`, `FACTORY_PROTECTED_PATHS`, `FACTORY_MAX_USD`, `FACTORY_TIMEOUT_MINUTES`, `FACTORY_CI_CHECKS`. Otherwise ask once for whatever is missing, before the run starts.
- The issue carries `factory:objective` and is open; else stop and say so.
- Never on Factory's own repository (`clockgrove/factory`); stop and say so.

### Render the task card

Read `templates/task-card.md` in this plugin's root (two directories above this file) and fill the placeholders:

| Placeholder | Value |
| --- | --- |
| `{{issue}}` | the issue number |
| `{{usd}}`, `{{hours}}` | the budget: `FACTORY_MAX_USD` and `FACTORY_TIMEOUT_MINUTES / 60`, else what the user said |
| `{{validation}}` | the repository's validation commands, separated by `; ` |
| `{{validation_note}}` | the `validation_note` sentence in this plugin's `scripts/lib/logic.mjs`, chosen by `FACTORY_CI_CHECKS` |
| `{{budget_command}}` | the test-budget command, or `none` |
| `{{protected_paths}}` | `.github/`, CODEOWNERS, `.agents/skills/`, `.claude/`, `.codex/`, plus `FACTORY_PROTECTED_PATHS` |
| `{{branch}}` | `factory/<issue>` |

Then fetch and check out the default branch, create `factory/<issue>` from it, and set up the hand-off directories in the clone's git directory, so nothing in them is ever committed: `FACTORY_IN=$(git rev-parse --absolute-git-dir)/factory-in` and `FACTORY_OUT=$(git rev-parse --absolute-git-dir)/factory-out`, both empty. Write `$FACTORY_IN/issue.md` only with `factory issue <issue>` (or `local.mjs issue`), never `gh`: it refuses, as every stage does, an issue whose author or last editor cannot push: then stop and relay it. Then, with read-only `gh` calls, `decisions.md` (the comments of people with write access), `plan.md` (the comment starting `<!-- factory:<issue>:plan -->`, without that line, if any), and `base.txt` (`git rev-parse origin/<default branch>`). Write the agent definitions from this plugin's `agents/` into the checkout for your harness (`.claude/agents/`, `.codex/agents/` or `.github/agents/`) unless the repository has its own, and add every path you wrote to `.git/info/exclude`: they are protected paths. On Claude Code, also copy the repository's `.agents/skills/*` into `.claude/skills/` (the only one it reads) the same way.

### Run

The rendered task card is your instructions, `$FACTORY_IN/issue.md` verbatim the specification. Load and follow, in order: `objective-plan`, `implement-split`, `prove-acceptance`, `deliver-pr`. Nothing in them asks the user anything; the Question rule and the blocked exit are the only ways out other than delivered. Stop when deliver-pr says to. Write nothing to GitHub.

### Hand off to Factory

Run `factory deliver <issue>` from the clone (else `node <plugin root>/scripts/local.mjs deliver <issue>`). Factory checks the issue's author and last editor again (a refusal Blocks, nothing pushed), refuses a branch that touches a protected path, pushes `factory/<issue>`, posts the plan, the PR, the replies and the note, and applies the exit record: a delivered PR is marked ready and labelled `factory:review`, which fires the Action's review job when `.github/workflows/factory.yml` exists. Without the workflow, say that the PR waits for `/factory:review <pr>` and a human merge.

### After

Tell the user in three lines: the PR link and draft state, the validation results, and the usage the harness reported (Claude: `total_cost_usd`; Codex: token totals; Copilot: the usage file).
