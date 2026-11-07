# Factory

Label a GitHub issue `factory:objective`, walk away, come back to merged work.

A worker job checks out your default branch, reads the issue as the whole specification, plans in a comment on it, implements with pinned sub-agents, opens one PR, and waits for your required checks on it (or runs your validation commands when you have no required checks). A review job posts one comment-only review, the worker answers each comment once, validation runs again, and auto-merge hands the PR to your merge queue (or, without one, to your required checks). Nothing asks a question; the only stops are **Blocked** (a draft PR, the card in the Blocked column, one comment with the reason) and **Question** (a draft PR whose body asks the one thing a human must decide), and neither stops the queue.

## What you see on the issue

While a job runs, one comment on the issue (edited in place, one per run) carries a bold status line and the phases with clocks: setup, install, harness, each validation pass, reviewer, answer pass, exit. The status line comes from the harness's own event stream, not from its prose: elapsed minutes, turns, tool calls, the sub-agents running and what each was asked to do, when the last event arrived, tokens so far, the last tool it ran. A harness that prints nothing for 30 minutes is killed and retried once, and the line says so. The labels (`factory:running`, `factory:in-review`, `factory:blocked`, `factory:question`) and the board column are the state; the plan comment is the harness's own checklist, ticked as it goes; the PR carries the validation marker and the review.

## Siblings that touch the same files

Two Objectives running at once that edit the same files cost a rebase run each time one merges (ten minutes, a dollar or a few) and, without a merge queue, strict checks refuse the one left behind until the worker rebases it. When you know two Objectives share an area, say so: add the GitHub issue dependency (`blocked_by`) and the dispatcher orders them; or set `max_concurrent: 1` for the stretch. Factory does not guess file overlap from prose.

## Auto-merge is on

Code lands with no human read. The gate is your CI workflow's checks on the integrated commit, the comment-only reviewer pass, and the merge queue's own re-run where you have one. Set `FACTORY_AUTO_MERGE: false` for ready-for-review PRs instead.

## Install footprint

| Added | What |
| --- | --- |
| `.github/workflows/factory.yml` | About 115 lines, written by `/factory:setup` from the plugin's `workflow-template.yml`: a `dispatch` job, a `work` job matrixed over ready Objectives, a `review` job. Triggers: a cron sweep, manual dispatch, an issue opened or labelled `factory:objective`, and `pull_request` when the App labels a PR `factory:review` or a human marks a Question draft ready. The worker and review jobs each fire the next dispatch at their end. Never from a fork. |
| A Factory GitHub App | Two secrets, `FACTORY_APP_ID` and `FACTORY_APP_PRIVATE_KEY`. Permissions: contents, pull requests, issues, projects (read and write), nothing else and never workflows. Every push, PR, label, board move and enqueue uses its short-lived installation token, minted for this one repository. |
| A model credential | Claude: `ANTHROPIC_API_KEY` (or workload identity federation with `id-token: write`). Codex: `CODEX_API_KEY`, passed only to the harness step. Copilot: `COPILOT_GITHUB_TOKEN`, a fine-grained token with the Copilot Requests permission from a user with a Copilot seat, passed as `copilot_github_token` to the harness step only and billed to that seat; or none, with the job token's `copilot-requests: write`, which needs your organization's Copilot CLI billing policy on. `credential: plan` with `CLAUDE_CODE_OAUTH_TOKEN` is allowed for your own repository only. |
| Merge queue, branch protection, label, Project board | GitHub settings, not files. `node scripts/setup.mjs --repo OWNER/NAME --yes --ci-checks "<your CI check names>"` applies them with your `gh` login (rulesets need admin) and creates the board (five columns) and the labels. Private repositories outside Enterprise Cloud cannot have a merge queue; Factory runs them on strict required checks and sends a PR that fell behind or conflicts back to the worker once. |
| A CI workflow on `pull_request` and `merge_group` | Most repositories have one; add `merge_group:` under `on:` if yours lacks it. |

The job token gets `contents: read`, `issues: write`, `actions: read` (usage artifacts and the CI workflow's triggers), and on the work and review jobs `actions: write` for the dispatch tick; it never writes code. The worker runs on an ephemeral runner; what persists is the branch, the PR, the plan comment and a usage artifact. Cost is capped by `max_usd` per job and `daily_usd` per day; Claude enforces its cap inside the run. Secrets are scrubbed from every non-harness child and masked in the uploaded event log.

## The plugin and the Action are one tree

`plugin/` holds the skills the worker and reviewer follow, the agent definitions (model pinned per harness), the task card, the scripts and the workflow template. The Action (`action.yml` at the repository root) runs those scripts from beside it; `/factory:run <issue>` in your own Claude Code or Codex session runs the same worker on your login. Install the plugin with `claude plugin marketplace add https://github.com/clockgrove/factory.git` then `claude plugin install factory@clockgrove` (Codex: `codex plugin marketplace add clockgrove/factory`, `codex plugin add factory@clockgrove`). Commands: `/factory:run`, `/factory:review`, `/factory:score`, `/factory:queue`, `/factory:doctor`, `/factory:setup`.

## Check and run

```sh
node plugin/scripts/doctor.mjs --repo OWNER/NAME --checkout .        # PASS/WARN/FAIL per check with the fix; changes nothing
node plugin/scripts/setup.mjs  --repo OWNER/NAME --yes --ci-checks "quality"   # GitHub fixes and the workflow file
gh workflow run factory.yml -f issue=811                              # one Objective now; the cron and the ticks do the rest
```

Each job uploads `factory-usage-<issue>` (and `factory-usage-<issue>-review`) with `events.jsonl` and `result.json` (`{harness, harnessVersion, model, usd, tokens: {input, output, cached, written}, models, basis, exit, turns, …}`); `bench/score.mjs` turns them, the progress comments and the PR into the scorecard: walk-away, quality, operator minutes, cost by component, minutes per phase, turns, runs and sessions.

## Inputs that tune cost

Four optional inputs on the Action, all off or at the harness default unless set: `effort` (the worker's effort level, for every harness; pinned to `medium` for Claude so a CLI default change cannot move cost silently), `compaction_window` (the context size in tokens at which the worker and reviewer sessions compact; Claude and Codex, since Copilot has no such setting; the CLI default when empty, a measured lever for large Objectives), `resume_policy` (`fresh` by default: a review fix pass, an answer pass and a conflicting rebase start a fresh session; `fix-passes` resumes the worker's saved session for them, which on Objectives of about 30 turns cost three to seven times more at equal outcomes, so it is for adopters measuring larger ones; every harness, on Actions and in local mode), and `harness_version` (the npm version of the harness CLI; `latest` by default, and the version actually installed is recorded in the usage record). Every Claude call also shares one cached system-prompt prefix across runs.

## Where Factory runs, and where it is going

Today every job is a fresh hosted runner: it installs the adopter's toolchain, runs the harness, pushes, waits for the required check, and is discarded. The branch, the PR, the issue's comments and labels, the board and the usage artifact are the only state; GitHub is the database, and the install is this Action plus the App's two secrets. Measured on a real adopter, an Objective's active minutes are about three quarters model time, a sixth waiting on CI, and under a tenth setup, so Factory's work on cost goes to turns first.

The direction, opt-in and under measurement on the scratch adopter before it ships: five stages (dispatch, build, validate, review and fix, merge) behind three interfaces (trigger, sandbox, gate), with GitHub as the only state on every backend. First a local backend: the same worker in a git worktree on a developer's own box, started by `factory run` or `factory serve`, needing git, `gh`, a harness CLI and a plan login, and no App, vendor or API key. Then a sandbox backend: each Objective gets one pausable sandbox from an image built by the adopter's own setup command, so the toolchain survives between stages; it needs an API key and the vendor's token, and the Action stays its only controller. Neither exists yet. On every backend a re-entry starts a fresh session by default (factory#2437), and the runner-only path stays the default.

## Uninstall

Delete `.github/workflows/factory.yml`, the App and its two secrets, and any model key. Optionally delete the `factory` ruleset, the labels and the Project. Nothing is installed on anyone's machine.
