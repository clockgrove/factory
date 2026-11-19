# In-session readiness

Check that the issue is open, carries `pendulum:objective`, and has neither `pendulum:draft` nor an [open dependency](../pendulum-file/reference.md#start-a-draft). Removing Draft releases it to the dispatcher. For a draft or unlabelled issue, report its state and use pendulum-file only if the user wants that dispatcher handoff.

Check issue state with pendulum-status and the configured route's dispatcher records. Follow an active or paused run. If the configured loop or Action can pick up the issue during this session, leave it to that dispatcher. An eligible issue with no recorded claim yet can still be picked up. In-session setup does not reserve the Objective.

## Render the task card and the hand-off directories

Read `<plugin root>/templates/task-card.md` and fill the placeholders:

| Placeholder | Value |
| --- | --- |
| `{{issue}}` | the issue number |
| `{{usd}}`, `{{hours}}` | the budget: `PENDULUM_MAX_USD` and `PENDULUM_TIMEOUT_MINUTES / 60`, else what the user said |
| `{{validation}}` | the repository's validation commands, separated by `; ` |
| `{{validation_note}}` | the `validation_note` sentence in `<plugin root>/scripts/lib/logic.mjs`, chosen by `PENDULUM_CI_CHECKS` |
| `{{budget_command}}` | the test-budget command, or `none` |
| `{{protected_paths}}` | `.github/`, CODEOWNERS, `.agents/skills/`, `.claude/`, `.codex/`, plus `PENDULUM_PROTECTED_PATHS` |
| `{{branch}}` | `pendulum/<issue>` |

Then fetch and check out the default branch, create `pendulum/<issue>` from it, and set up the hand-off directories in the clone's git directory, so nothing in them is ever committed: `PENDULUM_IN=$(git rev-parse --absolute-git-dir)/pendulum-in` and `PENDULUM_OUT=$(git rev-parse --absolute-git-dir)/pendulum-out`, both empty. Write `$PENDULUM_IN/issue.md` and `plan.md` only with `pendulum issue <issue>` (where `pendulum` is not on PATH, `node <plugin root>/scripts/local.mjs issue <issue>`), never `gh`: it refuses, as every stage does, an issue whose author, last editor or latest title renamer cannot push: then stop and relay it. No `plan.md` (none yet, or the issue changed): plan anew. Then, with read-only `gh` calls, `decisions.md` (the comments of people with write access) and `base.txt` (`git rev-parse origin/<default branch>`). Write the agent definitions from `<plugin root>/agents/` into the checkout for your harness (`.claude/agents/`, `.codex/agents/` or `.github/agents/`) unless the repository has its own, and add every path you wrote to `.git/info/exclude`: they are protected paths. On Claude Code, also copy the repository's `.agents/skills/*` into `.claude/skills/` (the only one it reads) the same way.

