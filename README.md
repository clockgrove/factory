# Factory

Label a GitHub issue `factory:objective`, walk away, come back to merged work.

A worker job checks out your default branch, reads the issue as the whole specification, plans in a comment on it, implements with pinned sub-agents, opens one PR, and waits for your required checks on it (or runs your validation commands when you have no required checks). A review job posts one comment-only review, the worker answers each comment once, validation runs again, and Factory merges exactly the reviewed head once your required checks are green on it (through your merge queue when you have one). The harness itself writes nothing to GitHub: Factory makes every push, PR, comment and merge from the files it leaves. Nothing asks a question; the only stops are **Blocked** (a draft PR, the card in the Blocked column, one comment with the reason) and **Question** (a draft PR whose body asks the one thing a human must decide), and neither stops the queue. To answer a Question, comment the decision on the issue or the PR (a review or a line comment works too) and mark the PR ready: the review job applies it, and with no answer since the question the PR goes back to a Question rather than merging. Re-applying `factory:objective` instead reruns the worker with it. A comment counts when its author has write access to the repository or is a maintainer the workflow names (`notify`, and the optional `maintainers` list), since an App cannot always see an organization member's access.

## What you see on the issue

While a job runs, one comment on the issue (edited in place, one per run) carries a bold status line and the phases with clocks: setup, install, harness, each validation pass, reviewer, answer pass, exit. The status line comes from the harness's own event stream, not from its prose: elapsed minutes, turns, tool calls, the sub-agents running and what each was asked to do, when the last event arrived, tokens so far, the last tool it ran. A harness that prints nothing for 30 minutes is killed and retried once, and the line says so. The labels (`factory:running`, `factory:in-review`, `factory:blocked`, `factory:question`) and the board column are the state; the plan comment is the harness's own checklist, ticked as it goes; the PR carries the validation marker and the review.

## Siblings that touch the same files

Two Objectives running at once that edit the same files cost a rebase run each time one merges (ten minutes, a dollar or a few) and, without a merge queue, strict checks refuse the one left behind until the worker rebases it. When you know two Objectives share an area, say so: add the GitHub issue dependency (`blocked_by`) and the dispatcher orders them; or set `max_concurrent: 1` for the stretch. Factory does not guess file overlap from prose.

## One repository per Objective

Factory works in one repository per Objective. An Objective that needs a change in another repository stops after its plan with a Question on the issue, before any work: split it into one Objective per repository and re-apply the label, or answer on the issue how to do the work in this repository alone.

## Factory merges on its own

Code lands with no human read. The gate is your CI workflow's checks on the reviewed head and the integrated commit, the comment-only reviewer pass, and the merge queue's own re-run where you have one. Set `FACTORY_AUTO_MERGE: false` for ready-for-review PRs instead.

## Install footprint

| Added | What |
| --- | --- |
| `.github/workflows/factory.yml` | About 190 lines (about 350 with the cloud sandbox), written by `/factory:setup` from the plugin's `workflow-template.yml`: a `dispatch` job, a `queue-watch` job, a `wake` job, a `work` job matrixed over ready Objectives and a `review` job (on the sandbox route, launch, image and sweep jobs instead of work and review, with two short wake jobs for the sweep). Triggers: a `*/10` cron as the backstop, manual dispatch, an issue opened or labelled `factory:objective` or any issue closed, `pull_request` (the App labels a PR `factory:review`, a human marks a Question draft ready, a Factory PR merges, the merge queue drops one), and CI finishing on a `factory/` branch (`workflow_run`, `check_suite`). The worker, review and launch jobs fire the next dispatch at their end, and a `wake` job sleeps to the next deadline only time ends; on the sandbox route the sweep arms its own wakes of minutes and the dispatcher's tick runs an owed image build (docs/PLAN.md). Never from a fork. |
| A Factory GitHub App | Two secrets, `FACTORY_APP_ID` and `FACTORY_APP_PRIVATE_KEY`. Permissions, one list: contents, pull requests, issues, projects: write; checks, commit statuses: read; actions: read, optional (cloud-sandbox logs); nothing else, never workflows. Checks and commit statuses are how Factory reads required checks; actions read lets a cloud-sandbox stage, which has no job token, read a red job's log. Every push, PR, label, board move and enqueue uses its short-lived installation token, minted for this one repository. |
| A model credential | Claude: `ANTHROPIC_API_KEY` (or workload identity federation with `id-token: write`). Codex: `CODEX_API_KEY`, passed only to the harness step. Copilot: `COPILOT_GITHUB_TOKEN`, a fine-grained token with only the Copilot Requests permission from a user with a Copilot seat, passed as `copilot_github_token` to the harness step only and billed to that seat; doctor checks it cannot write to the repository. `credential: plan` with `CLAUDE_CODE_OAUTH_TOKEN` is allowed for your own repository only. |
| Merge queue, branch protection, label, Project board | GitHub settings, not files. `node <factory clone>/plugin/scripts/setup.mjs --repo OWNER/NAME --yes --ci-checks "<your CI check names>"`, run in your repository's clone, applies them with your `gh` login (rulesets need admin) and creates the board (five columns) and the labels. Private repositories outside Enterprise Cloud cannot have a merge queue; Factory runs them on strict required checks and sends a PR that fell behind or conflicts back to the worker once. |
| A CI workflow on `pull_request` and `merge_group` | Most repositories have one; add `merge_group:` under `on:` if yours lacks it. |

The job token gets `contents: read`, `issues: write`, `actions: read` (usage artifacts and the CI workflow's triggers), and on the jobs that tick the dispatcher `actions: write` (work and review also use it to rerun flaky CI jobs); it never writes code. The worker runs on an ephemeral runner; what persists is the branch, the PR, the plan comment and a usage artifact. Cost is capped by `max_usd` per job and `daily_usd` per day; Claude (`--max-budget-usd`) and Copilot (`--max-ai-credits`) enforce the per-job cap inside the run; Codex is checked after each run. Secrets are scrubbed from every non-harness child and masked in the uploaded event log. The harness holds no GitHub write access: on Actions it runs as its own uid with a read-only token (the runner needs passwordless sudo, as GitHub's hosted runners have); Factory makes every write. Set your repository's default workflow token to read-only: doctor requires it.

## The plugin and the Action are one tree

`plugin/` holds the skills the worker and reviewer follow, the agent definitions (model pinned for Claude Code and Codex; Copilot's only when `subagent_model` or `reviewer_model` is set), the task card, the scripts and the workflow template. The Action (`action.yml` at the repository root) runs those scripts from beside it; `/factory:run <issue>` in your own Claude Code or Codex session runs the same worker on your login. Install the plugin with `claude plugin marketplace add https://github.com/clockgrove/factory.git` then `claude plugin install factory@clockgrove` (Codex: `codex plugin marketplace add clockgrove/factory`, `codex plugin add factory@clockgrove`). Commands: `/factory:run`, `/factory:serve`, `/factory:review`, `/factory:score`, `/factory:queue`, `/factory:doctor`, `/factory:setup`. The marketplaces install the plugin from `main`, so a session's commands follow `main`, not the tag your Action pins.

## Check and run

```sh
# in your repository's clone
node <factory clone>/plugin/scripts/doctor.mjs --repo OWNER/NAME --checkout .   # PASS/WARN/FAIL per check with the fix; changes nothing
node <factory clone>/plugin/scripts/setup.mjs  --repo OWNER/NAME --yes --ci-checks "quality"   # GitHub fixes and the workflow file
gh workflow run factory.yml -f issue=811                              # one Objective now; the cron and the ticks do the rest
```

Each job uploads `factory-usage-<issue>` (and `factory-usage-<issue>-review`) with `events.jsonl` and `result.json` (`{harness, harnessVersion, model, usd, tokens: {input, output, cached, written}, models, basis, exit, turns, …}`); `bench/score.mjs` turns them, the progress comments and the PR into the scorecard: walk-away, quality, operator minutes, cost by component, minutes per phase, turns, runs and sessions.

## Inputs that tune cost

Seven optional inputs on the Action, all off or at the harness default unless set: `effort` (the worker's effort level, for every harness, its answer pass after the review included; pinned to `medium` for Claude so a CLI default change cannot move cost silently), `reviewer_effort` (the reviewer's effort level, passed on every reviewer call; `high` for Codex as its reviewer agent file says, Claude and Copilot keep their CLI default unless you set one; the job log says `reviewer on <model> at <effort>` and the run's event record carries it), `compaction_window` (the context size in tokens at which the worker and reviewer sessions compact; Claude and Codex, since Copilot has no such setting; the CLI default when empty, a measured lever for large Objectives), `resume_policy` (`fresh` by default: a review fix pass, an answer pass and a conflicting rebase start a fresh session; `fix-passes` resumes the worker's saved session for them, which on Objectives of about 30 turns cost three to seven times more at equal outcomes, so it is for adopters measuring larger ones; every harness, on Actions and in local mode), `prompt_cache_ttl` (Claude only; `off`, the CLI default, until measured: `auto` asks Claude Code for a one-hour prompt cache on the main conversation when the run bills an API key, which otherwise gets five minutes and so re-writes the prefix after every CI wait; `1h` or `5m` force one; the usage record's `cache` shows the writes after each wait, see bench/README.md), `harness_version` (the npm version of the harness CLI; `latest` by default, and the version actually installed is recorded in the usage record), and `allowed_domains` (the hosts Claude Code's sandboxed commands may reach on Actions and in a cloud sandbox beyond GitHub and the npm and Yarn registries, comma or space separated, `*.example.com` for its subdomains: the counterpart of local mode's `FACTORY_LOCAL_DOMAINS`; docs/PLAN.md, Credentials and billing). Every Claude call also shares one cached system-prompt prefix across runs.

## Where Factory runs

Every stage runs behind three interfaces: trigger, sandbox and gate (`plugin/scripts/lib/backend.mjs`). GitHub is the only state on every backend: the branch, the PR, the issue's comments and labels, the board and the usage artifact.

- **Actions (the default):** every job is a fresh hosted runner. It installs the adopter's toolchain, runs the harness, pushes, waits for the required checks, and is discarded. The install is this Action plus the App's two secrets.
- **Local mode:** the same worker and reviewer on a developer's own machine, started by `factory serve` or `factory run <issue>` (the plugin's `bin/`; `/factory:serve` and `/factory:run` in a session). The harness runs on its own login, and every command the model or Factory runs goes through a sandbox. That means no credential stores, writes only in the Objective's clone, and the network limited to GitHub and an allow-list. Its GitHub reach is one fine-grained token for this repository (plus, optionally, the Factory App's key for Blocked and Question notices). An Objective labelled `factory:local` is the local loop's, and the Action leaves it alone. Linux and WSL2 with Claude Code, Codex and Copilot; macOS with Claude Code and Codex only (no Copilot), sandbox verified, not run end to end. See [docs/LOCAL.md](docs/LOCAL.md).
- **Cloud sandbox (opt-in):** one pausable cloud sandbox per Objective on Vercel Sandbox, started from an image built by the adopter's own setup command. Short Action jobs start each stage in it on GitHub events and exit within about thirty seconds; the sandbox stops at every wait between stages, and its cost is booked beside the model's on the progress comment. Turn it on with setup's `--sandbox vercel` and the `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID` secrets. Limits: a stage runs in one sandbox session, which Factory asks to be `timeout_minutes` plus about 16 minutes; Vercel Pro grants up to 24 hours, and on a plan that caps sessions lower the stage is cut to the session granted and Blocks naming the cap if it outruns it; Claude Code and Copilot are proven there, Codex in the sandbox is not yet proven. See [docs/ADAPTERS.md](docs/ADAPTERS.md).

## Versioning

Factory is at 0.9.x, the release candidate for 1.0: run it on real work. The surface below is expected to hold, and 0.9.x releases are expected to be fixes underneath it, but there is no stability promise until 1.0.

- **Pin an exact tag** (`clockgrove/factory@vX.Y.Z`). Factory publishes no floating tag (no `v0`, no `v0.9`, no `v1`), and a ruleset keeps release tags from being moved or deleted. Reason: a run's behaviour is its tag's code, so nothing changes under you between runs.
- **Proposed to freeze at 1.0:** the Action's input names, the labels (`factory:objective`, `factory:running`, `factory:in-review`, `factory:question`, `factory:blocked`, `factory:review`, `factory:local`, `factory:image`, `P0` to `P2`), the markers Factory writes on issues and PRs, the App's permission set (Install footprint) and the workflow template's jobs (`dispatch`, `queue-watch`, `work`, `review`; on the sandbox route `launch`, `launch-gate`, `launch-event`, `launch-tick`, `image`, `sweep`). From 1.0, a 1.x release renames or removes none of them and asks the App for no new permission; it may add an optional input. Before 1.0, a 0.9.x release may still change one of them as the exception, and its release notes call the change out.
- **What makes 1.0:** five consecutive real Objectives merged with zero operator input, pooled across `clockgrove/clockgrove`, `clockgrove/assetforge` and `clockgrove/raccoon-world` (never the scratch drill repositories), ordered by when each ended, on any harness; any miss on any of them resets it. How to count it with the per-repository scorer is in [docs/PLAN.md](docs/PLAN.md) (The 1.0 bar).
- **Supported:** the latest 0.9.x release gets security fixes; older tags do not. Report privately ([SECURITY.md](SECURITY.md)).

## Upgrade

1. Read the release notes between your tag and the new one.
2. Re-render the workflow with that release's setup: in your repository's clone, `node <factory clone at vX.Y.Z>/plugin/scripts/setup.mjs --repo OWNER/NAME --apply workflow --action clockgrove/factory@vX.Y.Z --yes`. It keeps your settings, moves the pin and brings the template's jobs to that release. Re-render on every upgrade: the template belongs to its release, and an older file misses jobs the new Action expects (doctor names some, such as `merge ticks`).
3. Commit the file on the default branch, then run doctor.

## Contributing

No outside pull requests until the owner opens the repository to them (reaching 1.0 does not); issues and private security reports are welcome ([CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md)).

## Uninstall

Delete `.github/workflows/factory.yml`, the App and its two secrets, and any model key. Optionally delete the `factory` ruleset, the labels and the Project. For local mode, also delete `~/.config/factory` (the tokens), `~/.cache/factory`, the `.factory/` directory in each clone that ran it, and the `factory:local` label. For the cloud sandbox, also delete the three `VERCEL_*` secrets, the Vercel project's sandboxes and snapshots, the image issue and the `factory:image` label. Nothing else is installed.
