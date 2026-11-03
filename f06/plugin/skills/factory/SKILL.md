---
name: factory
description: /factory <issue>. Run the Factory worker in this session on one Objective issue of the current repository: render the task card, then follow objective-plan, implement-split, prove-acceptance and deliver-pr in order. Use when the user asks to run, work or build a Factory Objective by issue number in their own session.
---

# /factory <issue>

Work one Objective in this session, on this machine, on the user's own login. This is the same worker the Action runs; only the sandbox differs.

## Preconditions

- The current directory is a clone of the target repository with its toolchain installed and `gh` logged in. If `.github/workflows/factory.yml` or a Factory config exists, read the validation commands, budget command, protected paths and budget from it; otherwise ask once for whatever is missing, since this is the one interactive path.
- The issue carries `factory:objective` and is open. Stop and say so if not.
- Never run on Factory's own repository.

## Render the task card

Read `templates/task-card.md` next to this plugin and fill the placeholders:

| Placeholder | Value |
| --- | --- |
| `{{issue}}` | the issue number |
| `{{usd}}`, `{{hours}}` | the budget; defaults `max_usd` and `timeout_minutes / 60` from the workflow, else what the user said |
| `{{validation}}` | the repository's validation commands, comma-separated |
| `{{budget_command}}` | the test-budget command, or `none` |
| `{{protected_paths}}` | `.github/`, CODEOWNERS, CI and merge-queue config, the skills and agent directories, the budget file, plus the repository's own list |
| `{{branch}}` | `factory/<issue>` |

Then check out the default branch, create `factory/<issue>` from it, fetch the issue body with `gh issue view <issue> --json title,body,labels` and write the agent definitions from `agents/` into the checkout if they are not already there (`.claude/agents/`, `.codex/agents/`, `.github/agents/`, whichever this harness reads).

## Run

Treat the rendered task card as your instructions and the issue body verbatim as the specification. Load and follow, in order: `objective-plan`, `implement-split`, `prove-acceptance`, `deliver-pr`. Nothing in them asks the user anything; the Question rule and the blocked exit are the only ways out other than delivered. Stop when deliver-pr says to.

## After

Tell the user in three lines: the PR link and whether it is a draft, the validation results, and the usage the harness reported (Claude: `total_cost_usd`; Codex: token totals; Copilot: none). The `factory-score` skill turns that into a scorecard row later.
