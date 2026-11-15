# Install, tune, upgrade, uninstall

What Factory adds to a repository, how to set it up and check it, the inputs that tune cost, and how to upgrade or remove it. The README has the short version; [USAGE.md](USAGE.md) covers filing and following Objectives, and [LOCAL.md](LOCAL.md) covers local mode.

## Requirements

- A GitHub repository you administer (rulesets need admin), with a CI workflow that runs on `pull_request`.
- The `gh` CLI, logged in, and Node 22 or newer on the machine you run setup from.
- A model credential for the harness you choose: Claude Code, Codex or GitHub Copilot (the table below).
- A merge queue is used where GitHub offers one: repositories an organization owns, public ones and private ones on Enterprise Cloud. Elsewhere Factory runs on strict required checks (the table below), and setup makes the ruleset without a queue.

## Where Factory runs

Every stage runs behind three interfaces: trigger, sandbox and gate (`plugin/scripts/lib/backend.mjs`). GitHub holds every Objective's state on every backend: the branch, the PR, the issue's comments and labels, the board and the usage artifact. The cloud sandbox keeps only its sandbox, its id and tags, and its snapshots at the vendor.

- **Actions (the default):** every job runs on a GitHub-hosted runner, fresh for each job, unless you name your own runner (`--runs-on`). On your own runner Factory installs no packages and loads no AppArmor profile, but it does create a `factory-agent` user, add it to `/etc/cron.deny` and `/etc/at.deny`, and make the runner's home and temp directory mode 700; those outlast the job. It installs the adopter's toolchain, runs the harness, pushes, waits for the required checks, and is discarded. The install is this Action plus the App's two secrets.
- **Local mode:** the same worker and reviewer on a developer's own machine, started by `factory serve` or `factory run <issue>` (the plugin's `bin/`; `/factory:factory-serve` and `/factory:factory-run` in a session). The harness runs on its own login. Every command the model runs, and every command Factory runs on the clone, goes through a sandbox; Factory's own push and Git LFS upload run outside it, from a mirror no sandbox can write. That means no credential stores, writes only in the Objective's clone, the stage's temp directory and its package caches (and, for the harness, the parts of its own state its run needs), and the network limited to GitHub and an allow-list. Its GitHub reach is one fine-grained token for this repository (plus, optionally, the Factory App's key for Blocked and Question notices). An Objective labelled `factory:local` is the local loop's, and the Action leaves it alone. Linux and WSL2 with Claude Code, Codex and Copilot; macOS with Claude Code and Codex only (no Copilot), sandbox verified, not run end to end. See [LOCAL.md](LOCAL.md).
- **Cloud sandbox (opt-in):** one pausable cloud sandbox per Objective on Vercel Sandbox, started from an image built by the adopter's own setup command. Short Action jobs start each stage in it on GitHub events and exit within about thirty seconds; the sandbox stops at every wait between stages, and its cost is booked in a vendor-cost comment on the issue, beside the stage's progress comment, and counts toward `daily_usd`. Turn it on with setup's `--sandbox vercel` and the `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID` secrets. Limits: a stage runs in one sandbox session, which Factory asks to be `timeout_minutes` plus about 16 minutes; Vercel Pro grants up to 24 hours, and on a plan that caps sessions lower the stage is cut to the session granted and Blocks naming the cap if it outruns it; Claude Code, Copilot and Codex (through the Vercel AI Gateway) are proven there. See [ADAPTERS.md](ADAPTERS.md).

The rest of this page is the Actions route; the other two have their own pages.

## Install footprint

| Added | What |
| --- | --- |
| `.github/workflows/factory.yml` | About 190 lines (about 350 with the cloud sandbox), written by `/factory:factory-setup` from the plugin's `workflow-template.yml`: a `dispatch` job, a `queue-watch` job, a `wake` job, a `work` job matrixed over ready Objectives and a `review` job (on the sandbox route, launch, image and sweep jobs instead of work and review, with two short wake jobs for the sweep). Triggers: a `*/10` cron as the backstop, manual dispatch, an issue opened or labelled `factory:objective` or any issue closed, `pull_request` (the App labels a PR `factory:review`, a human marks a Question draft ready, a Factory PR merges, the merge queue drops one), and CI finishing on a `factory/` branch (`workflow_run`, `check_suite`). The worker, review and launch jobs fire the next dispatch at their end, and a `wake` job sleeps to the next deadline only time ends; on the sandbox route the sweep arms its own wakes of minutes and the dispatcher's tick runs an owed image build (docs/PLAN.md). Never from a fork. |
| A Factory GitHub App | Two secrets, `FACTORY_APP_ID` and `FACTORY_APP_PRIVATE_KEY`. Permissions, one list: contents, pull requests, issues, projects: write; checks, commit statuses: read; actions: read, optional (cloud-sandbox logs and session restore); nothing else, never workflows. Checks and commit statuses are how Factory reads required checks; actions read lets a cloud-sandbox stage, which has no job token, read a red job's log. Every push, PR, label, board move and enqueue uses its short-lived installation token, minted for this one repository. |
| A model credential | Claude: `ANTHROPIC_API_KEY` (or workload identity federation with `id-token: write`). Codex: `FACTORY_CODEX_GATEWAY_KEY`, a Vercel AI Gateway key passed as `codex_gateway_key` (Codex then runs through the gateway and bills its credits; it wins over `CODEX_API_KEY`), or `CODEX_API_KEY`; either passed only to the harness step. Copilot: `COPILOT_GITHUB_TOKEN`, a fine-grained token with only the Copilot Requests permission from a user with a Copilot seat, passed as `copilot_github_token` to the harness step only and billed to that seat; doctor checks it cannot write to the repository. `credential: plan` with `CLAUDE_CODE_OAUTH_TOKEN` is allowed for your own repository only. |
| Merge queue, branch protection, label, Project board | GitHub settings, not files. `node <factory clone>/plugin/scripts/setup.mjs --repo OWNER/NAME --yes --ci-checks "<your CI check names>"`, run in your repository's clone, applies them with your `gh` login (rulesets need admin) and creates the labels and, on a repository an organization owns, the board (five columns). GitHub offers a merge queue only on repositories an organization owns (public ones, and private ones on Enterprise Cloud); elsewhere setup makes the ruleset without one and Factory runs on strict required checks. There, a PR that only fell behind is brought up to date by GitHub's update-branch, with no worker run, and one that conflicts goes back to the worker for a rebase each time other PRs merged since its last one, under the Merge rules in PLAN.md. |
| A CI workflow on `pull_request` and `merge_group` | Most repositories have one; add `merge_group:` under `on:` if yours lacks it. |

What each credential can do:

- **The job token:** `contents: read`, `issues: write`, `actions: read` (usage artifacts and the CI workflow's triggers), and on the jobs that tick the dispatcher `actions: write` (work and review also use it to rerun flaky CI jobs); it never writes code. Set your repository's default workflow token to read-only: doctor requires it.
- **The harness:** it holds no GitHub write access: on Actions it runs as its own uid with a read-only token (the runner needs passwordless sudo, as GitHub's hosted runners have); Factory makes every write.
- **Secrets:** they are scrubbed from every non-harness child and masked in the uploaded event log.
- **Cost:** it is capped by `max_usd` per job ($25 by default) and `daily_usd` per day ($100 by default); `max_concurrent` is 3 and `timeout_minutes` 240 unless set; Claude (`--max-budget-usd`) and Copilot (`--max-ai-credits`) enforce the per-job cap inside the run; Codex is checked after each run.
- **What persists:** the worker runs on an ephemeral runner; what persists is the branch, the PR, the plan comment and a usage artifact.

## Set it up

With the plugin, ask a session in your repository's clone to set up Factory (the factory-setup skill, `/factory:factory-setup`): it walks every step below, waits for a yes before each change, and opens the pull request that adds the workflow file. Without it, the steps are:

1. **The workflow file and the GitHub settings.** Clone Factory at its latest release, then run setup in your repository's clone:

   ```sh
   git clone --depth 1 --branch "$(gh release view --repo clockgrove/factory --json tagName --jq .tagName)" \
     https://github.com/clockgrove/factory.git <factory clone>

   node <factory clone>/plugin/scripts/setup.mjs --repo OWNER/NAME --ci-checks "<your CI check names>"        # preview: prints each step, changes nothing
   node <factory clone>/plugin/scripts/setup.mjs --repo OWNER/NAME --ci-checks "<your CI check names>" --yes  # apply
   ```

   It writes `.github/workflows/factory.yml` pinned to the latest release, and creates the labels, the Project board (on a repository an organization owns) and the `factory` ruleset with your `gh` login. `--apply labels|project|protection|workflow` runs one step; repeat it (or give `a,b`) for several. If your CI workflow lacks `merge_group:` under `on:`, add it.
2. **The GitHub App.** Open `https://github.com/settings/apps/new` (or your organization's `/organizations/<org>/settings/apps/new`). Uncheck webhooks and grant exactly the permissions in the table above: projects is under Organization permissions, the rest under Repository permissions. On a repository a user owns, skip projects: no GitHub App can reach a personal account's board, so setup makes none and the labels carry each Objective's state. Create it, generate a private key, note its App ID, and install it on this repository only.
3. **The secrets.** `gh secret set FACTORY_APP_ID`, `gh secret set FACTORY_APP_PRIVATE_KEY < path.pem`, and your model credential from the table above.
4. **Land the workflow file.** Commit `.github/workflows/factory.yml` on a branch and merge it to the default branch through a pull request; its cron and triggers start then.

## The plugin and the Action are one tree

`plugin/` holds the skills the worker and reviewer follow, the agent definitions (model pinned for Claude Code and Codex; Copilot's only when `subagent_model` or `reviewer_model` is set), the task card, the scripts and the workflow template. The Action (`action.yml` at the repository root) runs those scripts from beside it; `/factory:factory-run <issue>` in your own Claude Code or Codex session runs the same worker on your login. Install the plugin with `claude plugin marketplace add https://github.com/clockgrove/factory.git` then `claude plugin install factory@clockgrove` (Codex: `codex plugin marketplace add clockgrove/factory`, `codex plugin add factory@clockgrove`; GitHub Copilot CLI: `copilot plugin marketplace add clockgrove/factory`, `copilot plugin install factory@clockgrove`). Commands: `/factory:factory-file`, `/factory:factory-stop`, `/factory:factory-restart`, `/factory:factory-run`, `/factory:factory-serve`, `/factory:factory-review`, `/factory:factory-score`, `/factory:factory-queue`, `/factory:factory-doctor`, `/factory:factory-setup`. The marketplaces install the plugin from `main`, so a session's commands follow `main`, not the tag your Action pins.

## Check and run

```sh
# in your repository's clone
node <factory clone>/plugin/scripts/doctor.mjs --repo OWNER/NAME --checkout .   # PASS/WARN/FAIL per check with the fix; changes nothing
node <factory clone>/plugin/scripts/setup.mjs  --repo OWNER/NAME --yes --ci-checks "quality"   # GitHub fixes and the workflow file
gh workflow run factory.yml -f issue=811                              # one Objective now; the cron and the ticks do the rest
```

Each job uploads `factory-usage-<issue>` (and `factory-usage-<issue>-review`) with `events.jsonl` and `result.json` (`{harness, harnessVersion, model, ran: {worker, subagent, reviewer, labels}, usd, tokens: {input, output, cached, written}, models, basis, exit, turns, …}`, `ran` being the three models the stage ran on and the harness and model labels that chose them); `bench/score.mjs` turns them, the progress comments and the PR into the scorecard: walk-away, quality, operator minutes, cost by component, minutes per phase, turns, runs and sessions.

## Inputs that tune cost

`harness`, `model`, `subagent_model` and `reviewer_model` (`FACTORY_HARNESS` and the three `FACTORY_*_MODEL` settings in the workflow's env block) are the repository's defaults. An Objective overrides any of them for itself with a label (`factory:harness:<name>`, `factory:model:<id>`, `factory:subagent-model:<id>`, `factory:reviewer-model:<id>`), so a small change can run on a cheaper model and a hard one on the strongest without editing the workflow: [USAGE.md](USAGE.md), Choose the harness and models.

Seven more optional inputs on the Action; each row gives its default. Every Claude call also shares one cached system-prompt prefix across runs.

| Input | What it does |
| --- | --- |
| `effort` | The worker's effort level, for every harness, its answer pass after the review included; pinned to `medium` for Claude so a CLI default change cannot move cost silently. |
| `reviewer_effort` | The reviewer's effort level, passed on every reviewer call except Claude's rerun after a missed review, which always runs on `claude-opus-5-5` at `xhigh`; `high` for Codex as its reviewer agent file says, Claude and Copilot keep their CLI default unless you set one; the job log says `reviewer on <model> at <effort>` and the run's event record carries it. |
| `compaction_window` | The context size in tokens at which the worker and reviewer sessions compact; Claude and Codex, since Copilot has no such setting; the CLI default when empty, a measured lever for large Objectives. |
| `resume_policy` | `fresh` by default: a review fix pass, an answer pass and a conflicting rebase start a fresh session; `fix-passes` resumes the worker's saved session for them, which on Objectives of about 30 turns cost three to seven times more at equal outcomes, so it is for adopters measuring larger ones; every harness, on Actions and in local mode. |
| `prompt_cache_ttl` | Claude only; `off`, the CLI default, until measured: `auto` asks Claude Code for a one-hour prompt cache on the main conversation when the run bills an API key, which otherwise gets five minutes and so re-writes the prefix after every CI wait; `1h` or `5m` force one; the usage record's `cache` shows the writes after each wait, see bench/README.md. |
| `harness_version` | The npm version of the harness CLI; `latest` by default, and the version actually installed is recorded in the usage record. It pins the repository's harness only: another harness an Objective's label chooses installs its latest. |
| `allowed_domains` | The hosts the harness's sandboxed commands (Claude Code, Codex or Copilot) may reach on Actions and in a cloud sandbox beyond GitHub and the npm and Yarn registries, comma or space separated, `*.example.com` for its subdomains: the counterpart of local mode's `FACTORY_LOCAL_DOMAINS`; PLAN.md, Credentials and billing. |

## Upgrade

1. Read the release notes between your tag and the new one.
2. Re-render the workflow with that release's setup: in your repository's clone, `node <factory clone at vX.Y.Z>/plugin/scripts/setup.mjs --repo OWNER/NAME --apply workflow --action clockgrove/factory@vX.Y.Z --yes`. It keeps your settings, moves the pin and brings the template's jobs to that release. Re-render on every upgrade: the template belongs to its release, and an older file misses jobs the new Action expects (doctor names some, such as `merge ticks`).
3. Commit the file on the default branch, then run doctor. Until then the file lacks the newer jobs' events: a file from before the lifecycle labels, for one, ticks the dispatcher on a removed `factory:objective`, an applied `factory:restart` or a changed `factory:draft` only on its ten-minute cron.
4. If you accepted setup's offer to commit Factory's skills into the repository, copy them again from the new release: committed copies never update, and they override the plugin's.

## Uninstall

Delete `.github/workflows/factory.yml`, the App and its two secrets, and any model key. Optionally delete the `factory` ruleset, the labels and the Project. For local mode, also delete `~/.config/factory` (the tokens), `~/.cache/factory`, the `.factory/` directory in each clone that ran it, and the `factory:local` label. For the cloud sandbox, also delete the three `VERCEL_*` secrets, the Vercel project's sandboxes and snapshots, the image issue and the `factory:image` label. If you accepted setup's offer to commit Factory's skills, delete them too (`.agents/skills/`, `.claude/skills/`, and `.claude/agents/`, `.codex/agents/` or `.github/agents/`), and on your own runner remove the `factory-agent` user. Nothing else is installed.
