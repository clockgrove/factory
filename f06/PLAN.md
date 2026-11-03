# Factory reset: 0.6

Nov 2, 2026 · @Kirk Marple

## Decision

Factory 0.6 is a GitHub Action, a harness plugin and a bench, sharing one set of skills and a short task card. The TypeScript service at 0.5.20, planner and compiler included, is archived whole. A developer adds one workflow file, a GitHub App for the repository and a model credential, labels an issue `factory:objective`, and a worker builds it, a reviewer comments on it, and the merge queue merges it. Dozens of Objectives run at once with nobody watching; the human reads the Project board's Blocked column and, when they choose, the merged diffs.

What is dropped, and why: the planner, graph review, the compiler, Work Items, result review, repair diagnosis, amendments, allowances, spend ceilings, the config freeze, predecessor state, tiers and escalation, and every hold but one. The overnight job-one test ran #815 and #807 from the same base commits as Factory's recorded runs: a stock harness with the brief merged-ready work in 70–132 minutes with zero stops, where Factory took 12.6 and 27.7 hours with 10 and 14 holds, and 66 of the 68 holds across four Objectives were about Factory's own machinery. A blind judge ranked the harness result above Factory's on both. The planner did not change the solution; the compiler refused nothing the harness did. The knowledge loop (episodes, dreaming, the playbook) is also dropped, deliberately: the north star asked for a Factory that learns from its mistakes, and 0.6 answers that with skills people edit and a bench that scores each edit, not with accumulated memory. If a correction repeats across adopters it becomes a line in a Factory skill; if it repeats for one adopter it goes in a skill in their repository.

What is kept is what the test showed earning its keep: the sandboxed validation, the GitHub delivery semantics, crash recovery, the worker sessions on the harness SDKs, and the bench. Everything beyond what the test exercised is marked hypothesis in Risks and is gated before any deletion lands; the Nov 2 research settled the merge-queue mechanics, the credential rules and the metering shape, and left harness-cloud scheduling, Copilot's session and the cheap sub-agent tier for the gates.

Billing changes with the form, and that is a decision in its own right. Unattended runs bill on API credentials, never on a subscription or OAuth token: Anthropic's current terms limit plan OAuth to ordinary individual use of its own clients and have been enforced in 2026, OpenAI documents API keys as the recommended CI path, and Factory as a product may never store, broker or pool a subscription token. The shape per harness: Claude through workload identity federation (the job's OIDC token exchanged for a short-lived Anthropic credential, no stored secret) or `ANTHROPIC_API_KEY`; Codex through `CODEX_API_KEY` scoped to the single step that runs it, never a job-level variable; Copilot through the job's own `GITHUB_TOKEN` with `copilot-requests: write`, billed to the organization in org repositories and to the owner's seat in personal ones, so Copilot needs no secret at all. The engine is the same on a key as on a login; only who is billed changes. This is deliberate: fire-and-forget at dozens of Objectives on a quota exhausts it on the first busy night, while API billing makes `max_usd` and `daily_usd` real numbers. The subscriptions keep their place in the plugin path, where `/factory <issue>` runs in the developer's own session on their own login, and in the vendors' own cloud products, which `/factory queue` uses and which bill the plan as each vendor allows. Development has a fallback: the worker run locally uses whatever the CLI is logged in as, and a developer's own repository may run the Action with credential: plan and their own long-lived Claude Code token, which Anthropic's docs bless for CI; doctor warns that plan limits assume ordinary individual use and that a present API key silently wins, and the README says it is for your own repositories only. Codex's plan path needs a refreshed auth file written back after every job, so its dev fallback is a local run. Factory never stores, brokers or defaults to a plan token.

## Job one and how 0.6 is measured

Job one: file an Objective, walk away, and come back to correct, merged work at a reasonable cost. 0.6 is judged on four numbers per Objective, taken by the bench from the issue, the PR, the job log and the harness's usage output, the same four as the job-one test.

| Measure | Job-one part | Taken from |
| --- | --- | --- |
| Walk-away: merged with zero human input after the label | Operator walks away | Binary. Any human push, comment or edit on the branch or issue after the label breaks it; a Blocked card is a miss. |
| Solution quality | Correct work | The bench's blind pairwise judge where there is a comparison; the owner's read of the merged diff when they choose to read it; escapes found after merge count against it. |
| Operator minutes | Operator walks away | Minutes spent on Blocked cards and on re-filing, from a stopwatch; zero on a clean merge. |
| Dollars per merged Objective | Reasonable cost | Per harness: Claude's headless output carries total\_cost\_usd and per-model usage with sub-agents included; Codex's JSONL carries token counts per turn, priced from a table, with sub-agent totals possibly folded in; Copilot reports nothing per run and bills in GitHub AI Credits rather than dollars, so its column is credits from the org's billing data attributed by time window, converted at GitHub's rate, or marked unmetered when the billing data cannot attribute a run. Runner minutes beside it. Wall time reported, never alone. |

The standing scorecard is one row per Objective, kept by the bench. 0.6.0 ships when a batch of independent Objectives runs through the Action with every one merged or Blocked for a reason the owner agrees with and no human input. 1.0.0 ships when five consecutive real Objectives merge with zero operator input.

## The product

Four pieces, one set of skills. The worker is the only one with logic worth the name; the rest is wiring to GitHub and to the harnesses.

| Piece | Form | What it does |
| --- | --- | --- |
| Worker | A script on the harness SDKs: the Claude, Codex and Copilot worker sessions Factory already has, cut free of the service | Takes an issue number and the brief; plans in a comment on the issue, implements with pinned sub-agents, rebases, validates with the repository's commands, opens one PR. Runs wherever it is started: a runner, a vendor's cloud sandbox, or the developer's own session. |
| Action | `clockgrove/factory@v1`, called from one workflow file in the adopter's repository | Three jobs. Dispatcher (cron every 5–10 minutes and manual): finds labeled, unblocked, not-running issues, orders them by priority, starts up to `max_concurrent` worker jobs under `daily_usd`. Worker job: one per Objective, with `setup`, `timeout_minutes` and `max_usd`. Reviewer job: on the PR, one comment-only review, then one worker pass, then ready for the merge queue. |
| Plugin | Claude Code marketplace, and the same `SKILL.md` folder for Codex, agent definitions for Copilot | `/factory <issue>` runs the worker in the developer's session on their machine. `/factory review <pr>`, `/factory score`. `/factory queue` starts the unattended scheduler: the Action if the workflow is present, otherwise a scheduled task in the harness vendor's cloud. `/factory setup` writes the workflow, names the secret and applies the GitHub settings, on consent; /factory doctor checks keys, GitHub settings, repository and runner and names each fix. |
| Bench | `bench/ in the Factory repository; its private home stays in clockgrove/internal` | The scorecard, the blind pairwise judge, the auto-grader, the review replay set. Every change to a skill is scored here before it ships. |

One worker, two schedulers. The schedulers differ only in where the sandbox lives: the runner (hosted or self-hosted, a line in the file) or the vendor's cloud sandbox for the plugin's `/factory queue`. All three vendor clouds take a setup script that can install a toolchain (Claude's ships PostgreSQL 16 and a network allowlist to extend; Codex's agent phase is offline unless enabled; Copilot's is an Actions job capped at 59 minutes), all three bill the plan rather than an API key, and Claude's cloud ignores repository-declared plugins but loads committed `.claude/` directories, which is why the skills are committed in the repository and not only installed by the plugin. There is no local loop, no daemon and no state directory. State lives in the issue, the PR, the Project card and the job log.

## How an Objective flows

1. **File.** A writer opens an issue with the Objective form (goal, acceptance, sources, context, recorded decisions) and a maintainer applies `factory:objective`. The Project card is Queued. Blocked-by relations on the issue are the only dependency graph; an issue closed by any route counts as done.
2. **Dispatch.** The cron job picks ready Objectives by priority label and starts worker jobs up to `max_concurrent`, stopping at `daily_usd`. The card moves to Running.
3. **Work.** The worker job checks out the default branch, runs `setup` (the repository's toolchain command, if any), installs offline from the lockfile, renders the brief, and starts the harness session with the issue text verbatim. The worker posts its plan on the issue, implements with pinned sub-agents, rebases on the default branch, runs the validation commands, and opens one PR on `factory/<issue>`. The card moves to In review.
4. **Review.** The reviewer job posts findings as PR review comments. The worker gets them once, addresses or rebuts each in the PR, pushes, and the validation commands run again.
5. **Merge.** The PR enters the merge queue. The queue re-runs CI on the integrated head and merges. A conflict or a red integrated run goes back to the worker once; a second failure is Blocked. The card moves to Done, the issue closes.
6. **Blocked.** The PR becomes a draft, the card moves to Blocked, one comment states the reason (validation failed twice, reviewer findings unaddressed, dollar or time cap reached, worker died twice, integration failed twice). The queue does not wait. A human fixes it by pushing to the branch or editing the issue and re-applying the label.

Nothing in the flow asks a question. The one exception is in the worker contract: an assumption that would change a public contract opens the PR as a draft with the question in its body, and the queue moves on.

## The task card and the skills

The worker's instructions are a short task card plus skills, not one page of prose. The task card is the run's contract and is rendered per run: issue number, budget, the three exits, what to post where, do not ask. Everything procedural is a skill the plugin ships, loaded when its step is reached: `objective-plan` (the plan comment, assumptions, the Question rule), `implement-split` (implementer sub-agents, disjoint-file parallelism, sequential PRs for large Objectives), `prove-acceptance` (real-path proof, no weakened tests, the base-failure rule, the budget command), `deliver-pr` (rebase, the PR body, the design checklist, reviewer replies), `review-pr` (the reviewer's own skill) and `score`. Skills are harness-native: all three harnesses read the Agent Skills format, Claude Code from `.claude/skills/`, Codex from `.agents/skills/`, and Copilot from `.github/skills/`, `.claude/skills/` and `.agents/skills/`, so the plugin ships one tree at `.agents/skills/` and mirrors it to `.claude/skills/`. They load only when needed, version one at a time, and can be scored with skill evals. Agent definitions are the one thing written three ways from one source: Markdown with a `model` field for Claude Code (`.claude/agents/`) and Copilot (`.github/agents/`, with `model-policy: required`), TOML with a `model` field for Codex (`.codex/agents/`); the model is always pinned in the file, never passed at spawn time, because Codex drops a spawn-time model for role agents. An adopter overrides any skill by placing one of the same name in their repository, and adds their own: Clockgrove's test-budget rule, design checklist and runbook pointers become a `clockgrove-objective` skill in `clockgrove/clockgrove`, and `clockgrove/skills` already works this way.

The cap moves with the content: each skill is at most a page, versioned in the bench, and no line is added without a replay-set run and a scored Objective. Factory's 0.5 rubric was 516 lines grown one reasonable line at a time; the cap is per skill so the same growth cannot hide across six files. The Action installs the plugin into the runner and runs the worker with it, so the Action and `/factory <issue>` are one source.

The task card:

```
You are completing GitHub issue #N in this repository, unattended. No one will answer questions. The issue text, including the owner's recorded decisions, is the whole specification. Your budget is $X and H hours; sub-agents count.

Use the objective-plan, implement-split, prove-acceptance and deliver-pr skills, in that order. Validation commands: <validation commands>. Budget command: <budget command>. Protected paths: <list>.

Outputs: one plan comment on the issue, edited as you go; commits on factory/N; one PR against the default branch titled with the issue number; replies to each reviewer comment, once.

If an assumption would change a public contract or a recorded decision, open the PR as a draft with the question in its body and finish the rest. If you are blocked beyond recovery, post what blocked you on the issue, open the PR as a draft with what you have, and stop. Never print a token or a secret.
```

## The worker contract

|  |  |
| --- | --- |
| Inputs | The rendered brief (validation and budget commands, base commit, issue number, dollar and time budget filled in); the issue body verbatim; the repository at the default branch with `setup` run and dependencies installed offline; `gh` authenticated with the App's installation token; the pinned implementer and reviewer agent definitions written into the checkout. |
| Outputs | The plan comment and its edits; commits on `factory/<issue>`; one PR with the body the brief specifies; the usage record the harness emits, which the job uploads as an artifact for the scorecard. |
| Allowed | Any file not on the protected list (`.github/`, CODEOWNERS, CI and merge-queue config, the skills and agent definitions, the budget file, plus the repository's additions). Any command the runner allows. Sub-agents on the pinned model. Network as the runner has it. |
| Not allowed | Asking. Editing a test to pass it unless the issue asks. Touching a protected path (the job refuses the commit; branch protection refuses the push). Posting anything but the plan comment, its edits, the PR and PR replies. |
| Exit: delivered | PR open and not a draft; validation green; reviewer pass done. The merge queue takes it. |
| Exit: question | The worker hit an assumption that would change a public contract or a recorded decision. PR opens as a draft with the question in its body; everything else is finished. The card moves to In review with a question marker; the queue continues. A human answers in the PR, marks it ready, and the reviewer job runs. |
| Exit: blocked | Validation red after Factory's second pass; reviewer findings unaddressed after the one pass; integration failed twice; dollar or time cap reached; worker process died twice. Draft PR, card to Blocked, one comment with the reason. |

The question exit is the one hold-like thing in 0.6, and it differs from a 0.5 hold in the two ways that matter: it does not stop the Objective's other work or the queue, and it costs the worker nothing to raise, so it is raised only when the brief's test is met.

## Review and merge

Auto-merge is on. The gate for merging an Objective is CI green on the integrated head, the reviewer's one pass done, and the merge queue's own re-run; no human reads the diff before it lands. This is a decision, not a default: the point of the product is to take the human out of the loop, and the overnight evidence is that the reviewer plus the sandbox catch what a human would have caught in a PR read, at a fraction of the human's time. The owner reads merged diffs when they choose, and the bench's judge samples them. An adopter who wants a human merge sets `auto_merge: false` and gets ready-for-review PRs. On is the public default too: the README leads with it and states the gate, because the point of Factory is automation and the README says so rather than hedging it.

The reviewer is one model call per PR on the top model, after validation passes. It gets the Objective text, the diff and the PR body, and it posts review comments tied to lines, each naming the acceptance entry or repository rule it concerns, with assumptions that change behaviour flagged explicitly. It has no verdict and no refuse path: 0.5.19's replay set showed 50–65% false refusals before #2344 and 0–18% after, and a reviewer that can stop a run turns every false positive into a hold. The worker gets the comments once, addresses or rebuts each, pushes, and validation runs again; rebutted findings stay visible on the merged PR.

The merge queue is GitHub's. It serializes merges and re-runs CI on the integrated head, which is what makes dozens of concurrent workers safe without owned paths: a PR that was green on its branch and conflicts after a sibling merges is caught there, sent back to its worker once with the conflict, then Blocked. Two mechanics decide how it is wired. First, a PR opened, pushed or enqueued with the job's `GITHUB_TOKEN` gets no `merge_group` workflow run, so its required checks never report and the queue evicts it at the timeout; every push, PR creation and `gh pr merge --auto` therefore uses an installation token from the adopter's Factory GitHub App, and the job token stays read-only. Second, the queue needs its checks reported on the queue's own commit, so the repository's CI is a separate workflow triggered on `pull_request` and `merge_group`, never a step inside the worker job; the worker job's own validation run is the worker's feedback, and the CI workflow is the gate. Branch protection requires the queue and those checks, so neither a worker nor a stray push bypasses them. A required check that is skipped counts as passed, so aggregator jobs use `always()`.

## Scale

The design target is dozens of Objectives queued and in flight with nobody watching. Everything that follows is what that needs and the sequential test did not.

- **The dispatcher is the only scheduler logic.** Ready = labeled, not blocked by an open issue, not Running, not Blocked, not Question. Order = `P0`, `P1`, `P2`, then issue number. Start up to `max_concurrent`; stop for the day at `daily_usd`, summed from uploaded usage artifacts. About 100 lines; the one piece of Factory logic that survives as code.
- **Workers do not know about each other.** Coordination is the rebase in the brief plus the merge queue. Two Objectives that keep conflicting on one file produce two Blocked cards with the same reason, which is the signal to re-file them, not a reason for a planner.
- **Cost is the only cap.** There is no cap on merges or on Objectives per day; the budget buys whatever it buys. Dollars are capped twice, both in the file: `daily_usd` on the dispatcher and `max_usd` on each worker job, with `timeout_minutes` as the time cap beside them. Runner minutes are visible in Actions' own billing. `max_concurrent` is a runner-capacity and conflict-pressure control, not a form of restraint; raise it until conflicts or runner limits say otherwise. Mechanically it is a matrix with `max-parallel` over the ready issues, since an Actions concurrency group holds one running and one pending job and cannot cap at N; each issue also gets its own concurrency group so a repeat trigger dedupes rather than cancels a sibling. Hosted runners cap a job at 6 hours and self-hosted at 5 days; `timeout_minutes` sits under that.
- **The board is the dashboard.** Queued, Running, In review (with a question marker), Blocked, Done, moved by the jobs. Fire-and-forget means reading the Blocked column. An optional daily digest comment on a standing issue lists merges, blocks, questions and spend.
- **No stop but Blocked and Question, and neither stops the queue.** At this scale a hold is multiplied by the queue; the 68 holds of the test, spread over dozens of Objectives, would be hundreds of unattended stops.
- **Runner choice is a line in the file.** Hosted by default; self-hosted where an adopter wants their own toolchain or hardware, with `setup` as the only place a toolchain is named.

## Install footprint

What a developer adds to their repository is the whole of the public product, so it is small, legible and safe by construction.

| Added | Required | What it is |
| --- | --- | --- |
| `.github/workflows/factory.yml` | yes | About 30 lines calling `clockgrove/factory@v1`. Triggers: cron, and `workflow_dispatch` with an issue number. Never on `pull_request`, never from a fork. Inputs: `harness`, `model`, `subagent_model`, `max_concurrent`, `daily_usd`, `max_usd`, `timeout_minutes`, `auto_merge` (default `true`), reviewer\_model, credential (api, the default, or plan for a developer's own repository), `notify`, `runs-on`, `setup`, `validation`. |
| A Factory GitHub App for the repository, as two secrets (`FACTORY_APP_ID`, `FACTORY_APP_PRIVATE_KEY`) | yes | Created by the adopter in about three minutes; `/factory setup` walks it. The job mints a short-lived installation token from it for every push, PR, review request, Project card move and `gh pr merge --auto`. Required, not optional: a PR opened or enqueued with the job's own token gets no merge-queue run and is evicted at the timeout, and the job's own token cannot write a Project board at all. Permissions: contents, pull requests, issues, projects; nothing else. |
| Model credential | depends on harness | Claude: none stored, if the adopter links their Anthropic organization for workload identity federation (`id-token: write` on the job); otherwise `ANTHROPIC_API_KEY`. Codex: `CODEX_API_KEY`, used only in the step that runs it. Copilot: none; the job token with `copilot-requests: write`, billed to the organization or the owner's seat. |
| Merge queue and branch protection on the default branch | yes | GitHub settings, not files: require the queue and the CI workflow's checks. `/factory setup` applies them on consent, and creates the Factory Project board with its five columns if the repository has none; the board is required, and the App's projects permission is what moves the cards. |
| A CI workflow triggered on `pull_request` and `merge_group` | yes, if the repository has none | The queue needs checks on its own commit. Most repositories already have this; `/factory doctor` says if the triggers are missing. |
| Skills under `.agents/skills/` | no | Repository-specific procedure that overrides or extends Factory's; read by all three harnesses. |

What the file makes visible, and what is true:

- `permissions:` grants the job's own token `contents: read`, `issues: write` and, for Claude federation, `id-token: write`; writes to code go through the App's installation token, scoped to that repository. No org scope, no PAT, no stored subscription token, ever.
- The worker runs in the job's ephemeral runner and ends with it. Nothing persists in the repository but the branch, the PR and the plan comment; nothing is installed on anyone's machine.
- `.github/` is on the protected list, so the Action refuses to commit a workflow change; the App is not granted the workflows permission, so a push that touched one would be refused by GitHub as well.
- Auto-merge on means code lands without a human read; the file says so in a comment above the input, and the gate (CI on the queue commit, the reviewer, the merge queue) is listed beside it.
- Cost is capped in the file at three levels, and Claude's own `--max-budget-usd` enforces the per-Objective cap inside the run.
- The prompt-injection surface is the Objective text, which only a writer can author, and the label, which only a maintainer can apply. Secrets are masked in logs; the task card forbids printing them; the Codex key is step-scoped so repository code never sees it.
- Uninstall is deleting one file, one App and its two secrets, and any model key.

Notifications. GitHub Mobile notifies on subscriptions, so a comment on an issue the owner authored, or a PR they are requested on or @mentioned in, reaches their phone whichever identity posted it; with the App, comments and PRs carry the App's name. `notify` names the handle, and the jobs use it in three places only: the Blocked comment @mentions it, a Question draft PR requests it as reviewer, and the daily digest @mentions it. Merges and plan comments stay quiet unless the owner watches the repository. Whether a bot actor's @mention triggers a push is undocumented, so step 3's gate confirms it on the owner's phone.

Why the App is in the footprint at all: it is the one thing GitHub makes unavoidable. Workflows do not run on events the job token causes, and the merge queue attributes its run to whoever enqueued, so an App (or a PAT, which Factory does not support) is the only identity that both triggers CI on the PR and gets a merge-queue run. The cost is one setup screen and two secrets; the gain is that the adopter's existing CI runs on Factory's PRs unchanged, and commits carry the App's name.

Doctor. The same checks run as `/factory doctor` from the plugin before the workflow is enabled and as the first step of every worker job, so a misconfigured repository Blocks with a one-line reason instead of spending a run. Credentials: the harness's credential is present and is an API credential, not a plan token (a one-call probe reports the resolved model and that usage output is available; for Claude, that federation or the key works; for Codex, that the key is step-scoped; for Copilot, that `copilot-requests: write` is set and the org policy allows CLI billing). GitHub: the App's installation token mints and has contents, pull requests, issues and projects on this repository and nothing more; the job token is read-only on code; the merge queue and required checks are on the default branch and the CI workflow listens on `pull_request` and `merge_group`; the `factory:objective` label; the five Project columns; `notify` resolving to a user with access. Repository: `setup` runs clean, the validation commands exist, the lockfile installs offline, protected paths are present, repository skills parse and fit the cap. Runner: `runs-on` resolves, the harness CLI installs, `timeout_minutes` fits the runner's ceiling (6 hours hosted). Each failure names its fix, and `/factory setup` offers to apply the GitHub ones.

## Cost tiers and parallelism

The planner-high, worker-medium split survives one level down. The worker session runs on the strong model and does the planning, the integration and the PR; each checklist item goes to an implementer sub-agent on the cheaper model, pinned by the agent definition the job writes into the checkout (`.claude/agents/implementer.md` with `model: claude-sonnet-5-5`; the Codex and Copilot equivalents) so the worker cannot drift up. Where the harness reports sub-agent usage (Claude does; Codex folds it in; Copilot reports none), the caps and the scorecard see it. The strong model stays in the loop for the whole Objective instead of handing a compiled brief to a weaker one and leaving.

Whether the tier saves anything is the first thing the sequence measures, not an assumption: the overnight runs reported 0.26–0.35M tokens per Objective from the agent runner, a figure whose basis is unknown. If a real run on a runner costs a few dollars, the tier buys little and a single model is simpler; if it costs tens, the tier is where the saving lives.

Parallelism has two levels and the brief owns the inner one: implementers for items on disjoint files run at the same time, then one integration and one validation. The outer level is the dispatcher's `max_concurrent`. Factory's Work Item graph was the structural version of the inner level and achieved none of it on #815 or #807, where every item waited on the one before it and the serial chain was most of the machine time. A worker that sees the whole Objective can tell which parts are independent without a graph review to say so.

## Clockgrove as an adopter

Clockgrove is an adopter, not a special case. No Clockgrove code path exists in Factory; everything it needs goes through the two inputs every repository has: `runs-on` and `setup: scripts/ci/toolchain.sh`, which provisions PostgreSQL 18.6, pgvector and Playwright Chromium exactly as its CI does. Hosted runners are the default; a self-hosted runner is a one-line change if hosted minutes become the constraint. If Clockgrove ever needs something those two lines cannot express, that is a Factory bug. Factory's own repository runs its Objectives through the same workflow on hosted runners, as the standing proof that the footprint is complete.

Transition:

- Compiled Work Items are scrubbed, not carried: #808 is cancelled on 0.5.20 now, its open Work Item issues #1013–#1020 and any other open factory:work-item issue close as superseded, and #808 is queued fresh on 0.6 with the rest. Its one merged piece, PR #1021 (world-directory), stays on main and the Objective text notes it as done so the fresh plan does not redo it. No 0.5 Objective or Work Item is resumed by 0.6.
- `factory/<issue>/<item>` branches are deleted with the scrub; 0.6 uses `factory/<issue>`.
- The 0.5 service is stopped and uninstalled; its state directory and config are left in place, unread.
- The `clockgrove-objective` skill is added under `.agents/skills/` by a direct PR with Clockgrove's test-budget rule, design-checklist pointer and testing-runbook pointer, so the plugin run by hand and the Action load the same skills.
- The merge queue is turned on for `main` with the Quality workflow as the required check, and Quality listens on pull\_request and merge\_group; the Factory App is created for the repository, as every adopter does.

The 0.5 archive: the `clockgrove/factory` default branch is reset to the new tree. The 0.5.20 tree, its docs (PLANNING.md, DESIGN.md, the PRD, the templates) and its tests move whole to `clockgrove/internal/archive/factory-0.5/` under the preserve-first rule, with the release tags left in place. Nothing is deleted from history. The bench stays in the Factory repository; the published tag packages only what the Action needs.

## Sequence

Each step has a gate that must pass before the next starts. The deletions in the last step wait for every gate before them; until then 0.5.20 stays installed and untouched.

| Step | Work | Gate |
| --- | --- | --- |
| 1. Worker script | Cut the Claude, Codex and Copilot worker sessions out of `providers/` into a standalone script that takes an issue number and a task card; the plugin's `/factory <issue>` skill wraps it. Add the `clockgrove-objective` skill to Clockgrove. | #810 run with `/factory 810` in a session on a machine with the toolchain merges with the PostgreSQL and browser suites green and no human push. Real usage recorded; the cost-tier question is answered here. |
| 2. Worker job | The Action's worker job: checkout, `setup`, offline install, render the brief, run the script, upload usage, move the card. Reviewer job as one comment-only call. | #811 runs through the Action on a hosted runner (self-hosted if minutes bind) and reaches a PR with the validation job green and reviewer comments posted. |
| 3. Merge path | Merge queue and branch protection on Clockgrove's `main`; auto-merge on; every push, PR and enqueue through the App's installation token; Quality on pull\_request and merge\_group. | #811's PR merges through the queue with no human input, with a merge\_group run visibly recorded; the notify @mention and review request are confirmed to reach the owner's phone. |
| 4. Dispatcher | The cron job, priority order, `max_concurrent`, `daily_usd`, Blocked and Question handling, the board moves, the digest. | Two independent Objectives (#812 and #816) queued together both merge or Block with reasons the owner agrees with, no human input. |
| 5. Conflict test | Named as a stress test, not a gate: queue #809 and #813 together, which share Wave 4 web-client files. | Expected: one merges, the other rebases through the queue and merges or Blocks on a conflict. Either is a correct result; what is read is whether the Blocked reason is accurate. |
| 6. Plugin and bench | Marketplace entry with `/factory`, `/factory review`, `/factory score`, `/factory queue`, `/factory setup`, /factory doctor; the scorecard reading the uploaded usage artifacts; skills v1 recorded in the bench. | `/factory score` reports the four numbers for every Objective above; the scorecard is the standing one. |
| 7. Reset | Archive 0.5 to `clockgrove/internal`, reset the Factory default branch to the Action, plugin and docs; README for adopters; tag 0.6.0. | Factory's own repository has run one Objective through its own workflow. |

After 0.6.0 nothing changes in Factory for a week except a bug with a demonstrated failure. 1.0.0 is five consecutive real Objectives merged with zero operator input, counted from the first Objective after 0.6.0.

## Risks and hypotheses

The decision to drop the planner rests on evidence. The design on the far side of it rests on reasoning, and these are the parts no run has yet exercised.

| Risk or hypothesis | What it would look like | What covers it |
| --- | --- | --- |
| The harness result only looked good because its tests ran against fakes | Step 1: #810's PostgreSQL or browser suites fail on the harness branch | The `prove-acceptance` skill's real-path rule; the sandbox makes those suites run; the reviewer names fake-only proofs as findings. |
| Merge queue with job-token PRs (settled Nov 2, against the earlier draft) | A PR opened or enqueued with `GITHUB_TOKEN` gets no `merge_group` run and is evicted at the queue timeout | The App's installation token does every push, PR and enqueue; CI is a separate workflow on `pull_request` and `merge_group`; the job token is read-only. Confirmed empirically in step 3 before anything is deleted. |
| Subscription tokens in unattended runs (settled Nov 2) | Plan limits hit on the first busy night; vendor enforcement; a product that brokers tokens | API credentials only in the Action; Factory never stores or proxies a plan token; the plugin path and the vendors' clouds are where plans run. Anthropic's plan-credit rules changed twice in 2026, so doctor re-checks the live docs rather than a cached answer. |
| Per-run metering is uneven (settled Nov 2) | Copilot reports nothing per run; Codex reports tokens but not dollars | Claude from `total_cost_usd` and `modelUsage`; Codex priced from a table; Copilot in AI Credits from org billing, attributed by time window, converted at GitHub's rate, or marked unmetered. The scorecard shows the unit and basis per row. |
| Harness-cloud scheduling for `/factory queue` (hypothesis) | Step 6: the vendor's scheduled task cannot reach the repository or run the toolchain | All three clouds take a setup script; Claude's blocks GraphQL (REST only) and ignores repo-declared plugins, so skills are committed and `gh api` is used. The Action stays primary; the cloud path ships for repositories whose toolchain the setup script can install. |
| Copilot sessions in the standalone worker (hypothesis) | Step 1: the Copilot CLI's headless mode or its usage reporting falls short | `copilot -p` with `--allow-tool` is documented for Actions and bills to the org through the job token; it ships when it passes the #810 gate like the others. |
| The cheap sub-agent tier (hypothesis) | Step 1: real cost is a few dollars and the tier adds complexity for nothing | One input; models pinned in the agent files for all three harnesses; the gate's usage record decides the default. |
| Auto-merge lands a real defect | A merged PR has a defect the reviewer flagged and the worker rebutted, or missed | Visible on the PR; the bench judge samples merged diffs; a repeated class becomes a reviewer-skill change scored on the replay set. The owner chose this trade. |
| Silent assumptions at scale | Dozens of plan comments with assumptions nobody reads | The Question exit for contract-changing assumptions; the daily digest lists the rest; the reviewer flags behaviour-changing assumptions. |
| Objectives too large for one session | A worker runs out of context or time | The `implement-split` skill's sequential-PRs rule; `timeout_minutes` under the 6-hour hosted ceiling ends it as Blocked with a reason rather than a half-finished branch. |
| Concurrent Objectives on one hot file | Repeated Blocked cards with the same conflict reason | The signal to re-file; not a planner. |
| Skills grow into the rubric | Lines added without measurement | One-page cap per skill; versioned in the bench; no change without a replay-set run and a scored Objective. |
| Mobile notifications from a bot actor (undocumented) | A Blocked @mention or a review request from the App never reaches the phone | Step 3's gate tests it on the owner's phone before `notify` is relied on; the fallback is the owner watching the repository. |
| Dollars higher than the runner-reported tokens suggested | Step 1's real figure is a multiple of the overnight estimate | The caps make it visible per Objective and per day; if a harness Objective costs more than Factory's run did, the test doc is reopened on cost before 1.0.0. |

What would prove the decision wrong: a live Objective on 0.6 that Blocks for a reason a planner would have caught before code was written, twice. One is a brief line; two reopens this document.

## Decisions

Taken (Nov 2):

- Drop the planner and compiler; Factory is an Action, a plugin and a bench.
- Auto-merge on, for Clockgrove and as the public default; the gate is CI, the comment-only reviewer and the merge queue; the README leads with it.
- Fire-and-forget at dozens of Objectives is the design target; the only stops are Blocked and Question, and neither stops the queue.
- Clockgrove is an adopter with no special code path; runner and toolchain are lines in the file.
- Copilot is a worker exactly like Claude and Codex: same task card, same skills, its own token.
- The knowledge loop is dropped; the brief plus the bench is how Factory learns.
- Each skill is capped at one page and versioned in the bench; the task card is the only per-run prompt.
- Unattended runs bill on API credentials, never a subscription or OAuth token, and Factory never stores or brokers one; the plugin path and the vendors' clouds stay on the developer's login.
- Compiled Work Items are scrubbed; every Objective runs fresh on 0.6, #808 included.
- The Factory GitHub App is required, not optional: it is the only identity that gets a merge-queue run and triggers the repository's CI on Factory's PRs.
- No subscription or OAuth token anywhere a remote agent runs; Factory never stores or brokers one.
- A GitHub Project board is required as the dashboard; `/factory setup` creates it if the repository has none.

Still open:

- [ ] The `daily_usd` and `max_usd` values for Clockgrove, once step 1 has a real figure.
- [ ] Worker default after steps 1–4: Opus high, Fable high, or per-Objective by size.
- [ ] Whether the cheap sub-agent tier stays on by default, from step 1's usage record.

## Amendments (Nov 3, 2026)

Taken during the first live runs on the scratch adopter `clockgrove/factory-scratch`, where steps 1–6 were proven. Each changes the text above where it conflicts.

1. **Factory never builds itself** (Kirk, Nov 2). The first adopter and every gate run on a scratch repository; Clockgrove enters at the dispatcher's gate, only through the Action. Step 7's gate becomes: the scratch adopter's standing scorecard shows a batch merged with no human input. The `run` skill refuses Factory's own repository.
2. **Merge queues need a public organization repository or Enterprise Cloud.** A private adopter runs without a queue: strict required checks plus the dispatcher's integration-failure exit, which sends an In-review PR that is behind or conflicting back to the worker once (a clean rebase runs no model; a conflict goes to the harness) and Blocks it the second time. With a queue, the same exit handles a PR the queue evicted. Clockgrove runs this way until it is public.
3. **GitHub's cron is not a scheduler.** None fired in hours on the scratch repository. The dispatcher ticks on an Objective opened or labelled `factory:objective`, at the end of every worker job and every review job (a conflicting PR fires no `pull_request` run, so the worker's own tick matters), serialized by a concurrency group; the cron stays as the sweep. The job token gains `actions: read` (usage artifacts, the CI workflow's triggers) and, on the work and review jobs only, `actions: write` for the tick; it stays read-only on code.
4. **The footprint is larger than promised.** The workflow is about 115 lines (three jobs with permissions, the matrix, artifact uploads, ticks), not 30. The plugin is self-contained: skills, agents, task card, scripts and the workflow template in one tree; the Action runs the plugin's scripts from beside it, so `/factory:…` in a session and the Action are one source.
5. **Command names** are `/factory:run <issue>`, `/factory:review <pr>`, `/factory:score`, `/factory:queue`, `/factory:doctor`, `/factory:setup` (Claude Code qualifies a plugin's skills as `/plugin:skill`).
6. **Credentials.** `credential: login` is the developer's-machine mode (the CLI's own login; refused inside Actions) and is what `api` falls back to locally when no key is present. The scratch repository runs on the plan opt-in. Copilot does report usage (`--usage-output-file`: tokens, premium requests, AIU); its CLI under Actions needs the organization policy that allows Copilot CLI billing, which blocked the gate.
7. **Models.** Worker Opus 5.5 at high, implementers Sonnet 5.5, reviewer Fable 5.1, with Opus 5.5 at xhigh when Fable's quota is refused; per-harness defaults in the Action.
8. **Mechanics learned.** The branch's own commits are measured from the current merge-base (the worker rebases); the review job keeps the merge path for an already-reviewed PR (a Question draft marked ready); a worker rebase of an unreviewed PR relabels so the review job fires; the App's installation token is minted for the one repository; `events.jsonl` is masked before upload; a reviewer pass with no findings runs no answer pass.
9. **Bench.** Skills are versioned by hash (`bench/skills.json`, digest on every scorecard row; the one-page cap is enforced there); `bench/review-replay.mjs` replays the private set with the 0.6 reviewer and scores recall over labelled and seeded defects and noise per record; rows carry the owner's read (`--read`).
10. **Still open.** The Copilot gate (organization policy), the App's extra `actions:write` and `workflows:write`, phone delivery of the App's @mention, `daily_usd`/`max_usd` for Clockgrove and step 7, parked until a real-sized Objective is on the scorecard.
