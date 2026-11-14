# Using Factory

How to write an Objective, what you see while it runs, and what to do when Factory hands one back to you Blocked or with a Question. [INSTALL.md](INSTALL.md) covers setup; [PLAN.md](PLAN.md) has the full contracts.

## Write an Objective

An Objective is a GitHub issue with the `factory:objective` label. The issue is the whole specification: write everything the work needs into it. The worker asks you something only when the work depends on a decision that should be yours (a Question, below). Ask a session to file one for you ("File a Clockgrove Factory Objective: ...", the factory-file skill), which starts it or saves it as a draft to refine and start later (An Objective's lifecycle, below), or write the issue yourself:

- **State the goal and what must be true when it is done.** Put the acceptance entries in a list under a heading such as `Acceptance` (`Done when`, `Definition of done`, `Must be true` and `Criteria` are read the same way). The reviewer judges each entry, met or not, with the line that shows it. Without such a section, the reviewer names the entries from the issue text itself.
- **Say what you have decided.** Where the issue admits more than one reading, the worker takes the simplest one that satisfies every acceptance entry and records it as an assumption in its plan and in the PR.
- **File it yourself, or have someone who can push file it.** Factory acts on an issue only when its author and, once the body was edited, its last editor can push to the repository or are maintainers the workflow names. Otherwise the run Blocks before any model sees the text. A maintainer labelling someone else's issue is not enough: who applies the label is not checked, and the author is checked on every run, so such an issue needs refiling by someone who can push.
- **Keep it to one repository** (below).

```markdown
## Goal

`mytool --version` prints the version.

## Acceptance

- `mytool --version` prints the version from package.json and exits 0.
- A test covers it.
```

Ready Objectives start in priority order (`P0` to `P2`, then the lowest issue number), up to `max_concurrent` at once; one started by hand with `gh workflow run factory.yml -f issue=<number>` runs even when that limit is reached. An Objective too large for one session is delivered as up to six pull requests in sequence, one open at a time.

## Choose the harness and models

The workflow file's `FACTORY_HARNESS`, `FACTORY_MODEL`, `FACTORY_SUBAGENT_MODEL` and `FACTORY_REVIEWER_MODEL` are the repository's defaults, and doctor lists them. A label on the issue overrides one of them for that Objective alone; an issue with none runs on the defaults.

| Label | Overrides |
| --- | --- |
| `factory:harness:<name>`: `claude`, `codex` or `copilot` | `FACTORY_HARNESS`. The models no label names become that harness's own defaults, as with any switch of harness. |
| `factory:model:<id>` | `FACTORY_MODEL`: the worker, and its fix and answer passes. |
| `factory:subagent-model:<id>` | `FACTORY_SUBAGENT_MODEL`: the implementer sub-agents. |
| `factory:reviewer-model:<id>` | `FACTORY_REVIEWER_MODEL`: the reviewer. |

- **Apply them when you file the issue,** with `factory:objective` (`gh issue create … --label factory:objective --label factory:model:claude-sonnet-5-5`; `gh label create <name>` first makes a label the repository lacks). The factory-file skill offers them.
- **Who applied a label counts.** Factory acts on one only when the person who last applied it, by the issue's timeline, can push or is a maintainer the workflow names, since GitHub lets anyone with triage access apply labels. Otherwise the Objective Blocks before any spend, naming the label.
- **A choice it cannot run Blocks before any spend,** naming the label and the fix: two labels of one kind, a harness Factory does not run, or a model the harness cannot run. Claude Code runs Claude models (a `claude-` id, or its aliases `fable`, `opus`, `sonnet` and `haiku`). Codex runs a model with a row in Factory's Codex price table (`plugin/scripts/lib/codex-prices.json`), since without one `max_usd` could not stop its runs; a provider prefix (`openai/`) is taken only with the AI Gateway key, and Factory adds it itself. Copilot's model names come from its own catalog, which varies by account and which Factory cannot read before a run, so Factory checks only the form (no provider prefix or spaces): a name the account's Copilot does not offer is not caught before Copilot starts. `max_usd` and `daily_usd` apply whatever the model.
- **GitHub caps a label name at 50 characters,** so an id fits in 36 characters after `factory:model:` and in 27 after `factory:subagent-model:` or `factory:reviewer-model:`. Every model in Factory's price tables and defaults fits; GitHub refuses a longer name, so use the model's id without its date suffix, or make it the repository's default.
- **Every route honours it.** The Action's work and review jobs read the harness label before they install a harness, and install that one; the workflow hands each job every harness's secret, so the chosen harness needs its own secret (a missing one Blocks the Objective, naming it). The cloud-sandbox launcher hands the stage that harness's credential, and Blocks before any sandbox call when the launch job holds none. Local mode (`factory serve`, `factory run`) runs another harness than its own when this machine can (its CLI and its sandbox, and for Copilot its token, as `factory serve` checks its own at start), else Blocks the Objective, and the loop's log names what is missing. A stage that finds its labels name another harness than the one its job, sandbox or loop prepared for Blocks; re-apply `factory:objective`. `/factory:factory-run --here` runs in your own session, on its harness and model, whatever the labels say.
- **A manual run's `harness` input** (`gh workflow run factory.yml -f issue=<number> -f harness=codex`) overrides the default for that run; a harness label on the issue wins over it.
- **A label added, removed or changed after the plan is an edit** (Edit an Objective, below): the next stage Blocks, re-applying `factory:objective` plans again on the new choice, and `factory:restart` starts over with it.
- **What ran is on the record:** the progress comment's harness line, the usage record's `ran` and the scorecard's Harness column name the harness, the worker, sub-agent and reviewer models, and the labels that chose them.

## What you see on the issue

While a job runs, one comment on the issue (edited in place, one per run) carries a bold status line and the phases with clocks: setup, install, harness, each validation pass, reviewer, answer pass, exit. The status line comes from the harness's own event stream, not from its prose: elapsed minutes, turns, tool calls, the sub-agents running and what each was asked to do, when the last event arrived, tokens so far, the last tool it ran. A harness that prints nothing for 30 minutes is killed and retried once, and the line says so. The labels (`factory:running`, `factory:in-review`, `factory:blocked`, `factory:question`) and the board column are the state; the plan comment is the harness's own checklist, ticked as it goes; the PR carries the validation marker and the review.

## An Objective's lifecycle

Each step is one action on GitHub. Where a skill is named, a plain-words request to your agent takes that action after asking you.

- **Draft.** An issue with the `factory:draft` label is a draft: Factory never runs it, on any route, even with `factory:objective` on it too (the draft label wins: the dispatcher's log lists it as a draft, and a launch, `factory run` or a session's `factory issue` refuses it). Nothing is dispatched, claimed or spent for it. The factory-file skill offers it beside starting at once: it shows the issue and asks whether to start it now, save it as a draft, or keep discussing. "Let's keep working on Clockgrove Factory Objective #12" (the factory-draft skill) loads the draft from GitHub to refine it with you and saves the changes back to the issue only on your yes. Edit a draft freely: before its first plan, an edit is simply the text the run starts from.

- **Start.** Applying `factory:objective` starts the Objective: the dispatcher picks it up on the label's own event, else on its ten-minute cron, and in local mode on `factory serve`'s next tick. To start a draft, take `factory:draft` off and apply `factory:objective`, or ask "Start Clockgrove Factory Objective #12" (the factory-start skill): on your yes it does both, after the trust check a new Objective gets (its author and its last editor can push, or are maintainers the workflow names; otherwise it refuses and says who). Starting a draft counts as re-applying the label, whichever way it is done: an edit made while it was a draft, even after an earlier plan, is planned from. A draft started, then edited, follows the edit rules below once its plan exists.

- **Edit.** Edit the issue freely until the first work stage reads it. After its plan, an edit Blocks the Objective at its next stage, and re-applying `factory:objective` plans again from the new text (Edit an Objective, below).

- **Restart.** Apply `factory:restart` to start over from the issue's current text, in any state: Queued, Running, In review, Blocked or a Question ("Restart Clockgrove Factory Objective #12", the factory-restart skill, applies it on your yes). Only someone who can push, or a maintainer the workflow names, restarts an Objective: anyone else's label is taken off with a comment (a running stage may already have stopped on seeing it; re-applying `factory:objective` resumes the Objective). A running stage stops first, as for a stop, its spend so far recorded, and nothing merges or starts meanwhile. Then the dispatcher writes a restart record on the issue (when the label was applied, who applied it, the earlier PR and the deleted branch's last commit, which `git push origin <sha>:refs/heads/factory/<issue>` restores), deletes the `factory/<issue>` branch, closes the earlier PR with a comment linking the record (its commits and review stay readable on it), sets the earlier plan and a split's part record aside, removes the state labels and the restart label, and queues the Objective; it starts from the default branch, and comments made before the label was applied do not feed it. When a ruleset keeps GitHub from deleting the branch, the Objective is Blocked with the fix instead: nothing is discarded, and its earlier PR, plan and comments stay as they were. The retry and rebase counts start over, and the scorecard counts the restart as a human action. On a stopped Objective the restart waits until `factory:objective` is back. A workflow file rendered before this release sees a restart only on the ten-minute cron until it is re-rendered ([INSTALL.md](INSTALL.md), Upgrade). To go on after a fix or an answer instead, re-apply `factory:objective`: that continues from the branch and PR.

- **Stop.** Remove the `factory:objective` label, or close the issue ("Stop Clockgrove Factory Objective #12", the factory-stop skill, removes the label on your yes). No dispatcher tick, local loop or sandbox launch picks up a stopped Objective, and your other Objectives keep running. What happens depends on its state:
  - **Running, or a review running:** the stage reads its issue once a minute. On the stop it ends its harness run, records the spend so far in its usage record (locally and in a cloud sandbox also in its progress comment's spend line, as every stage does) and exits, normally within two minutes; its progress comment's last line reads `exit: stopped`. Its PR, if it has one, becomes a draft without the `factory:review` label; its state label comes off and its card goes back to Queued. With the cloud sandbox the launcher then stops the sandbox. A Running Objective whose stage died before it saw the stop is tidied the same way by the dispatcher, ten minutes after the label came off.
  - **In review with no stage running:** on its next tick the dispatcher takes the PR out of the merge queue, makes it a draft without the `factory:review` label, removes the state label and moves the card to Queued, so neither a review nor the merge queue takes it. On Actions the label's removal ticks it (a workflow file rendered before this release waits for the ten-minute cron until it is re-rendered: [INSTALL.md](INSTALL.md), Upgrade); locally `factory serve` ticks every 30 seconds.
  - **Queued, Blocked or a Question:** it stays as it is.

  Applying `factory:draft` to an Objective stops it the same way, whatever its state, and keeps it a draft until it is started again.

  Re-apply the label to start it again: it continues from its branch and PR, as after a Block. Closing the issue stops it the same way and then counts as done: the dispatcher's Done pass removes its state label, moves its card to Done and makes a PR it left open a draft, and with the cloud sandbox the sweep destroys its sandbox.

## Edit an Objective

Edit the issue as much as you like until the worker reads it: the first work stage makes its plan from the title, the body and the harness and model labels as they are when it starts. After that, the plan and the code follow that text, and an edit to the title or body, or a harness or model label added, removed or changed, does not reach the run halfway:

- The stage running when you edit finishes on the text it read. The next one (the review, the merge, or a work stage Factory starts on its own, such as a rebase) stops the Objective as Blocked, saying the Objective changed after its plan was made, and the PR, if there is one, becomes a draft. A PR already in the merge queue is taken out of it. Nothing goes on with a plan made from one text and an issue that says another.
- Saving the issue without changing it is no edit: line endings and trailing spaces do not count. That needs the record of its text Factory keeps on the plan comment: a plan comment without one (an older plan) gets it at the next work stage, and until then any save after the plan counts as an edit.
- Re-apply `factory:objective` to work from the new text: the work stage that starts after it makes its plan again from the text as it then is, on the same branch and PR. An edit made while the Objective is Blocked or has a Question is used the same way once you re-apply the label. Only the label counts: starting the Objective by hand (`gh workflow run factory.yml -f issue=<number>`, or `factory run <number>` in local mode) after such an edit Blocks it again. To start over from the new text instead, with the earlier PR closed and a new branch from the default one, apply `factory:restart` (An Objective's lifecycle, above).
- Comments are not edits. A comment that answers a Question, or records a decision, leaves the plan as it is.
- An edit is checked like the text you first wrote: when its editor cannot push and is not a maintainer the workflow names, the run Blocks (above).

## Blocked and Question

A run that goes well needs nothing from you. When one needs you, Factory does all the work it can first and then hands the Objective back to you in one of two states. Neither holds up the queue: your other Objectives keep running.

- **Blocked** means Factory could not finish. One comment on the issue gives the reason, the issue's card moves to the Blocked column (on a repository a user owns there is no board; the `factory:blocked` label says it), and the PR, if it opened one, becomes a draft.
- **Question** means the work depends on a decision that should be yours: one that would change or remove an existing public contract, contradict a recorded decision or grant new access. The worker takes the simplest reading, finishes everything else, and leaves a draft PR whose body asks what a human must decide. A Question about working in another repository comes earlier, on the issue itself, with no PR (One repository per Objective, below).

What to do with each:

- **Blocked:** fix what the comment names, then re-apply `factory:objective` to run the Objective again. When your fix was an edit to the issue, the worker makes its plan again from the new text.
- **Question:** comment the decision on the issue or the PR (a review or a line comment works too) and mark the PR ready: the review job applies it, and with no answer since the question the PR goes back to a Question rather than merging. Re-applying `factory:objective` instead reruns the worker with it.

A comment counts when its author has write access to the repository or is a maintainer the workflow names (`notify`, and the optional `maintainers` list), since an App cannot always see an organization member's access.

## Factory merges on its own

Code lands with no human read. The gate is your CI workflow's checks on the reviewed head and the integrated commit, the comment-only reviewer pass, and the merge queue's own re-run where you have one. Set `FACTORY_AUTO_MERGE: false` for ready-for-review PRs instead.

## Siblings that touch the same files

Two Objectives running at once that edit the same lines can conflict: when one merges, the other goes back to its worker for a rebase, an extra run that costs model time. Without a merge queue, a PR that only fell behind is brought up to date by GitHub's update-branch, with no worker run. When you know two Objectives share an area, say so: add the GitHub issue dependency (`blocked_by`) and the dispatcher orders them; or set `max_concurrent: 1` for the stretch. Factory does not guess file overlap from prose.

## One repository per Objective

Factory works in one repository per Objective. An Objective that needs a change in another repository stops with a Question on the issue before any code is written (after its plan, or before the worker starts when the issue names another repository on a `Factory-Repository:` line): split it into one Objective per repository and re-apply the label. When the Question came from the plan, you can instead answer on the issue how to do the work in this repository alone.

## Commands

With the plugin installed in Claude Code, Codex or GitHub Copilot CLI, ask in plain words and use the full name, Clockgrove Factory: each request below loads the Factory skill that does it, and the full name keeps your agent from picking up another product called Factory. Where your agent offers skills as slash commands, the command works too.

| Say | Command | What it does |
| --- | --- | --- |
| "Set up Clockgrove Factory for this repository." | `/factory:factory-setup` | Installs Factory one consented step at a time, and opens the pull request that adds the workflow file |
| "Is Clockgrove Factory set up correctly here?" | `/factory:factory-doctor` | Checks the repository, its settings, the credential and the runner; changes nothing |
| "File a Clockgrove Factory Objective: ..." | `/factory:factory-file` | Writes what you describe as an Objective issue, shows it, and on your yes creates it started (`factory:objective`) or as a draft (`factory:draft`) |
| "Let's keep working on Clockgrove Factory Objective 12." | `/factory:factory-draft <issue>` | Loads the draft from GitHub to refine it with you, and saves the changes back on your yes |
| "Start Clockgrove Factory Objective 12." | `/factory:factory-start <issue>` | Starts a draft on your yes, after the trust check: takes `factory:draft` off and applies `factory:objective` |
| "Stop Clockgrove Factory Objective 12." | `/factory:factory-stop <issue>` | Removes the Objective's label on your yes: its running stage ends and nothing picks it up again (An Objective's lifecycle, above) |
| "Restart Clockgrove Factory Objective 12." | `/factory:factory-restart <issue>` | Applies `factory:restart` on your yes: the Objective starts over from the issue's current text (An Objective's lifecycle, above) |
| "Run Clockgrove Factory Objective 42 here." | `/factory:factory-run <issue>` | Runs one Objective on this machine, in local mode or in the session itself |
| "Review Clockgrove Factory PR 57." | `/factory:factory-review <pr>` | Runs the reviewer on one Factory PR in your session |
| "Start the Clockgrove Factory local loop." | `/factory:factory-serve` | Starts the local loop ([LOCAL.md](LOCAL.md)) |
| "Start the Clockgrove Factory queue." | `/factory:factory-queue` | Starts the unattended scheduler for the repository |
| "Show the Clockgrove Factory scorecard." | `/factory:factory-score` | Prints the scorecard: walk-away, quality, operator minutes, cost |

On the command line, `gh workflow run factory.yml -f issue=<number>` starts one Objective now, and local mode has `factory serve`, `factory run <issue>` and `factory review <pr>` ([LOCAL.md](LOCAL.md), Run it).
