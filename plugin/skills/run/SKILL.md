---
name: run
description: /factory:run <issue>. Run the Factory worker in this session on one Objective issue of the current repository: render the task card, then follow objective-plan, implement-split, prove-acceptance and deliver-pr in order. Use when the user asks to run, work or build a Factory Objective by issue number in their own session.
---

# /factory:run <issue>

Work one Objective in this session, on this machine, on the user's own login. This is the same worker the Action runs; only the sandbox differs.

## Preconditions

- The current directory is a clone of the target repository with its toolchain installed and `gh` logged in. When `.github/workflows/factory.yml` exists, read its `env:` block: `FACTORY_VALIDATION`, `FACTORY_BUDGET_COMMAND`, `FACTORY_PROTECTED_PATHS`, `FACTORY_MAX_USD`, `FACTORY_TIMEOUT_MINUTES`. Otherwise ask once for whatever is missing; this is the one interactive path, before the run starts.
- The issue carries `factory:objective` and is open. Stop and say so if not.
- Never on Factory's own repository (`clockgrove/factory`): Factory is not a consumer of Factory. Stop and say so.

## Render the task card

Read `templates/task-card.md` in this plugin's root (`${CLAUDE_PLUGIN_ROOT}` in Claude Code; `~/.codex/plugins/cache/<marketplace>/factory/<version>/` in Codex) and fill the placeholders:

| Placeholder | Value |
| --- | --- |
| `{{issue}}` | the issue number |
| `{{usd}}`, `{{hours}}` | the budget: `FACTORY_MAX_USD` and `FACTORY_TIMEOUT_MINUTES / 60`, else what the user said |
| `{{validation}}` | the repository's validation commands, separated by `; ` |
| `{{budget_command}}` | the test-budget command, or `none` |
| `{{protected_paths}}` | `.github/`, CODEOWNERS, `.agents/skills/`, `.claude/`, `.codex/`, plus `FACTORY_PROTECTED_PATHS` |
| `{{branch}}` | `factory/<issue>` |

Then check out the default branch, create `factory/<issue>` from it, and fetch the issue body with `gh issue view <issue> --json title,body,labels`. Write the agent definitions from this plugin's `agents/` into the checkout for the harness you are (`.claude/agents/`, `.codex/agents/` or `.github/agents/`) unless the repository has its own, and append every path you wrote to `.git/info/exclude`: those directories are protected paths and must never be committed. On Claude Code, also copy the repository's `.agents/skills/*` into `.claude/skills/` the same way, since Claude Code reads only the latter.

## Run

Treat the rendered task card as your instructions and the issue body verbatim as the specification. Load and follow, in order: `objective-plan`, `implement-split`, `prove-acceptance`, `deliver-pr`. Nothing in them asks the user anything; the Question rule and the blocked exit are the only ways out other than delivered. Stop when deliver-pr says to.

## Hand the PR to the Action

When `.github/workflows/factory.yml` exists, the Action's review job takes it from here: after deliver-pr has opened the PR, apply the `factory:review` label to it (`gh pr edit <pr> --add-label factory:review`; a label applied by a user fires the review job as the App's does). The review job posts the one review pass, runs the answer pass and validation, and enables auto-merge. Without the workflow, say that the PR waits for `/factory:review <pr>` and a human merge.

## After

Tell the user in three lines: the PR link and whether it is a draft, the validation results, and the usage the harness reported (Claude: `total_cost_usd`; Codex: token totals; Copilot: the usage file). The `score` skill (`/factory:score`) turns that into a scorecard row later.
