# Factory

Label a GitHub issue `factory:objective`, walk away, come back to merged work.

A worker job checks out your default branch, reads the issue as the whole specification, plans in a comment, implements with pinned sub-agents, runs your validation commands, and opens one PR on `factory/<issue>`. A reviewer job posts one comment-only pass of line-tied findings; the worker answers each once. Then the PR goes to GitHub's merge queue, which re-runs your CI on the integrated head and merges. Dozens of Objectives run at once; you read the Project board's Blocked column when you choose.

## Auto-merge is on

Code lands with no human read. That is the point: the gate is your CI workflow's checks on the merge queue's commit, the comment-only reviewer pass, and the merge queue's own re-run. The reviewer has no verdict and no refuse path; its findings stay visible on the merged PR, answered or rebutted. Set `FACTORY_AUTO_MERGE: false` in the workflow to get ready-for-review PRs instead.

Nothing asks a question. Two exits stop one Objective and never the queue: **Blocked** (validation red after Factory's second pass, reviewer findings unaddressed, dollar or time cap, worker died twice) converts the PR to a draft, moves the card to Blocked and posts one @mention; **Question** (an assumption that would change a public contract or a recorded decision) opens the PR as a draft with the question in its body and requests you as reviewer. Fix either by pushing to the branch or editing the issue, then re-apply `factory:objective`; mark a Question draft ready and the reviewer runs.

## Install footprint

| Added | What |
| --- | --- |
| `.github/workflows/factory.yml` | About 90 lines calling `clockgrove/factory@v1` three times (dispatch, work, review). Cron every 10 minutes and manual. Never from a fork. `/factory setup` writes it; or copy `workflow-template.yml`. |
| A Factory GitHub App | Two secrets, `FACTORY_APP_ID` and `FACTORY_APP_PRIVATE_KEY`. Permissions: contents, pull requests, issues, projects (read and write); nothing else, especially not workflows. Required: a PR opened or enqueued with the job token gets no merge-queue run, and the job token cannot move a Project card. Factory never creates an App; `/factory setup` walks you through creating one in three minutes and then verifies it. |
| A model credential | Claude: `ANTHROPIC_API_KEY`, or none with workload identity federation (`id-token: write`). Codex: `CODEX_API_KEY`, passed to the harness step only. Copilot: none; the job token with `copilot-requests: write`. Unattended runs bill API credentials, never a subscription. |
| Merge queue, branch protection, label, Project board | GitHub settings, not files. `node scripts/setup.mjs --repo OWNER/NAME --yes --ci-checks "<your CI check names>"` applies them: the `factory` ruleset (merge queue, required checks, no force push), the labels, the Factory Project with Queued, Running, In review, Blocked, Done, and Allow auto-merge. |
| A CI workflow on `pull_request` and `merge_group` | The queue needs checks on its own commit. Most repositories have this; add `merge_group:` under `on:` if yours lacks it. `/factory doctor` says. |

The job token gets `contents: read` and `issues: write`; every write to code goes through the App's short-lived installation token, scoped to the repository. `.github/`, CODEOWNERS, the skills and agent directories and your `protected_paths` are refused at commit time by a hook and at push time by branch protection. Cost is capped three times in the file: `daily_usd` on the dispatcher, `max_usd` per Objective (Claude's own `--max-budget-usd` enforces it inside the run), `timeout_minutes` as the time cap.

## Check and run

```sh
node scripts/doctor.mjs --repo OWNER/NAME          # PASS/WARN/FAIL per check with the fix; changes nothing
node scripts/setup.mjs  --repo OWNER/NAME --yes    # applies the GitHub fixes and writes the workflow
node scripts/dispatch.mjs --repo OWNER/NAME --issue 811   # start one Objective now instead of waiting for cron
```

Each worker job uploads `factory-usage-<issue>` with `events.jsonl` (the harness's raw output) and `result.json` (`{harness, model, usd, tokens, basis, started, ended}`); `usd` is `null` when the run is unmetered (Copilot) and the basis says where the dollars came from (harness-reported, priced from a dated table, or billing window).

## Uninstall

Delete `.github/workflows/factory.yml`, the App and its two secrets, and any model key. Optionally delete the `factory` ruleset, the labels and the Project. Nothing is installed anywhere else.
