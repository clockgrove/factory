# Factory

Label a GitHub issue `factory:objective`, walk away, come back to merged work.

A worker job checks out your default branch, reads the issue as the whole specification, plans in a comment on it, implements with pinned sub-agents, runs your validation commands, and opens one PR. A review job posts one comment-only review, the worker answers each comment once, validation runs again, and auto-merge hands the PR to your merge queue (or, without one, to your required checks). Nothing asks a question; the only stops are **Blocked** (a draft PR, the card in the Blocked column, one comment with the reason) and **Question** (a draft PR whose body asks the one thing a human must decide), and neither stops the queue.

## Auto-merge is on

Code lands with no human read. The gate is your CI workflow's checks on the integrated commit, the comment-only reviewer pass, and the merge queue's own re-run where you have one. Set `FACTORY_AUTO_MERGE: false` for ready-for-review PRs instead.

## Install footprint

| Added | What |
| --- | --- |
| `.github/workflows/factory.yml` | About 115 lines, written by `/factory:setup` from the plugin's `workflow-template.yml`: a `dispatch` job, a `work` job matrixed over ready Objectives, a `review` job. Triggers: a cron sweep, manual dispatch, an issue opened or labelled `factory:objective`, and `pull_request` when the App labels a PR `factory:review` or a human marks a Question draft ready. The worker and review jobs each fire the next dispatch at their end. Never from a fork. |
| A Factory GitHub App | Two secrets, `FACTORY_APP_ID` and `FACTORY_APP_PRIVATE_KEY`. Permissions: contents, pull requests, issues, projects (read and write), nothing else and never workflows. Every push, PR, label, board move and enqueue uses its short-lived installation token, minted for this one repository. |
| A model credential | Claude: `ANTHROPIC_API_KEY` (or workload identity federation with `id-token: write`). Codex: `CODEX_API_KEY`, passed only to the harness step. Copilot: none; the job token with `copilot-requests: write`, which needs your organization's Copilot CLI billing policy on. `credential: plan` with `CLAUDE_CODE_OAUTH_TOKEN` is allowed for your own repository only. |
| Merge queue, branch protection, label, Project board | GitHub settings, not files. `node scripts/setup.mjs --repo OWNER/NAME --yes --ci-checks "<your CI check names>"` applies them with your `gh` login (rulesets need admin) and creates the board (five columns) and the labels. Private repositories outside Enterprise Cloud cannot have a merge queue; Factory runs them on strict required checks and sends a PR that fell behind or conflicts back to the worker once. |
| A CI workflow on `pull_request` and `merge_group` | Most repositories have one; add `merge_group:` under `on:` if yours lacks it. |

The job token gets `contents: read`, `issues: write`, `actions: read` (usage artifacts and the CI workflow's triggers), and on the work and review jobs `actions: write` for the dispatch tick; it never writes code. The worker runs on an ephemeral runner; what persists is the branch, the PR, the plan comment and a usage artifact. Cost is capped by `max_usd` per job and `daily_usd` per day; Claude enforces its cap inside the run. Secrets are scrubbed from every non-harness child and masked in the uploaded event log.

## The plugin and the Action are one tree

`plugin/` holds the skills the worker and reviewer follow, the agent definitions (model pinned per harness), the task card, the scripts and the workflow template. The Action (`action/action.yml`) runs those scripts from beside it; `/factory:run <issue>` in your own Claude Code or Codex session runs the same worker on your login. Install the plugin with `claude plugin marketplace add https://github.com/clockgrove/factory.git` then `claude plugin install factory@clockgrove` (Codex: `codex plugin marketplace add clockgrove/factory`, `codex plugin add factory@clockgrove`). Commands: `/factory:run`, `/factory:review`, `/factory:score`, `/factory:queue`, `/factory:doctor`, `/factory:setup`.

## Check and run

```sh
node plugin/scripts/doctor.mjs --repo OWNER/NAME --checkout .        # PASS/WARN/FAIL per check with the fix; changes nothing
node plugin/scripts/setup.mjs  --repo OWNER/NAME --yes --ci-checks "quality"   # GitHub fixes and the workflow file
gh workflow run factory.yml -f issue=811                              # one Objective now; the cron and the ticks do the rest
```

Each job uploads `factory-usage-<issue>` (and `factory-usage-<issue>-review`) with `events.jsonl` and `result.json` (`{harness, model, usd, tokens, basis, exit, …}`); `bench/score.mjs` turns them into the scorecard's four numbers per Objective.

## Uninstall

Delete `.github/workflows/factory.yml`, the App and its two secrets, and any model key. Optionally delete the `factory` ruleset, the labels and the Project. Nothing is installed on anyone's machine.
