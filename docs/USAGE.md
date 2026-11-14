# Using Factory

How to write an Objective, what you see while it runs, and what to do when Factory hands one back to you Blocked or with a Question. [INSTALL.md](INSTALL.md) covers setup; [PLAN.md](PLAN.md) has the full contracts.

## Write an Objective

An Objective is a GitHub issue with the `factory:objective` label. The issue is the whole specification: write everything the work needs into it. The worker asks you something only when the work depends on a decision that should be yours (a Question, below). Ask a session to file one for you ("File a Clockgrove Factory Objective: ...", the factory-file skill), or write the issue yourself:

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

## What you see on the issue

While a job runs, one comment on the issue (edited in place, one per run) carries a bold status line and the phases with clocks: setup, install, harness, each validation pass, reviewer, answer pass, exit. The status line comes from the harness's own event stream, not from its prose: elapsed minutes, turns, tool calls, the sub-agents running and what each was asked to do, when the last event arrived, tokens so far, the last tool it ran. A harness that prints nothing for 30 minutes is killed and retried once, and the line says so. The labels (`factory:running`, `factory:in-review`, `factory:blocked`, `factory:question`) and the board column are the state; the plan comment is the harness's own checklist, ticked as it goes; the PR carries the validation marker and the review.

## An Objective's lifecycle

Each step is one action on GitHub. Where a skill is named, a plain-words request to your agent takes that action after asking you.

<!-- Draft: filing an Objective without starting it. #204 adds this part. -->

- **Start.** Applying `factory:objective` starts the Objective: the dispatcher picks it up on the label's own event, else on its ten-minute cron, and in local mode on `factory serve`'s next tick.

- **Edit.** Edit the issue freely until the first work stage reads it. After its plan, an edit Blocks the Objective at its next stage, and re-applying `factory:objective` plans again from the new text (Edit an Objective, below).

- **Restart.** Apply `factory:restart` to start over from the issue's current text, in any state: Queued, Running, In review, Blocked or a Question ("Restart Clockgrove Factory Objective #12", the factory-restart skill, applies it on your yes). A running stage stops first, as for a stop, its spend so far recorded. Then the dispatcher closes the earlier PR with a comment linking the restart (its commits and review stay readable on it), deletes the `factory/<issue>` branch, sets the earlier plan and a split's part record aside, removes the state labels and the restart label, and queues the Objective; it starts from the default branch, and comments from before the restart do not feed it. The retry and rebase counts start over, and the scorecard counts the restart as a human action. On a stopped Objective the restart waits until `factory:objective` is back. To go on after a fix or an answer instead, re-apply `factory:objective`: that continues from the branch and PR.

- **Stop.** Remove the `factory:objective` label, or close the issue ("Stop Clockgrove Factory Objective #12", the factory-stop skill, removes the label on your yes). No dispatcher tick, local loop or sandbox launch picks up a stopped Objective, and your other Objectives keep running. What happens depends on its state:
  - **Running, or a review running:** the stage reads its issue once a minute. On the stop it ends its harness run, records the spend so far in its usage record (locally and in a cloud sandbox also in its progress comment's spend line, as every stage does) and exits, normally within two minutes; its progress comment's last line reads `exit: stopped`. Its PR, if it has one, becomes a draft without the `factory:review` label; its state label comes off and its card goes back to Queued. With the cloud sandbox the launcher then stops the sandbox. A Running Objective whose stage died before it saw the stop is tidied the same way by the dispatcher, ten minutes after the label came off.
  - **In review with no stage running:** on its next tick the dispatcher takes the PR out of the merge queue, makes it a draft without the `factory:review` label, removes the state label and moves the card to Queued, so neither a review nor the merge queue takes it. On Actions the label's removal ticks it (a workflow file rendered before this release waits for the ten-minute cron until it is re-rendered: [INSTALL.md](INSTALL.md), Upgrade); locally `factory serve` ticks every 30 seconds.
  - **Queued, Blocked or a Question:** it stays as it is.

  Re-apply the label to start it again: it continues from its branch and PR, as after a Block. Closing the issue stops it the same way and then counts as done: the dispatcher's Done pass removes its state label, moves its card to Done and makes a PR it left open a draft, and with the cloud sandbox the sweep destroys its sandbox.

## Edit an Objective

Edit the issue as much as you like until the worker reads it: the first work stage makes its plan from the title and body as they are when it starts. After that, the plan and the code follow that text, and an edit to the title or body does not reach the run halfway:

- The stage running when you edit finishes on the text it read. The next one (the review, the merge, or a work stage Factory starts on its own, such as a rebase) stops the Objective as Blocked, saying the Objective changed after its plan was made, and the PR, if there is one, becomes a draft. A PR already in the merge queue is taken out of it. Nothing goes on with a plan made from one text and an issue that says another.
- Saving the issue without changing it is no edit: line endings and trailing spaces do not count. That needs the record of its text Factory keeps on the plan comment: a plan comment without one (an older plan) gets it at the next work stage, and until then any save after the plan counts as an edit.
- Re-apply `factory:objective` to work from the new text: the work stage that starts after it makes its plan again from the text as it then is, on the same branch and PR. An edit made while the Objective is Blocked or has a Question is used the same way once you re-apply the label. Only the label counts: starting the Objective by hand (`gh workflow run factory.yml -f issue=<number>`, or `factory run <number>` in local mode) after such an edit Blocks it again.
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
| "File a Clockgrove Factory Objective: ..." | `/factory:factory-file` | Writes what you describe as an Objective issue, shows it, and creates it with the label on your yes |
| "Stop Clockgrove Factory Objective 12." | `/factory:factory-stop <issue>` | Removes the Objective's label on your yes: its running stage ends and nothing picks it up again (An Objective's lifecycle, above) |
| "Restart Clockgrove Factory Objective 12." | `/factory:factory-restart <issue>` | Applies `factory:restart` on your yes: the Objective starts over from the issue's current text (An Objective's lifecycle, above) |
| "Run Clockgrove Factory Objective 42 here." | `/factory:factory-run <issue>` | Runs one Objective on this machine, in local mode or in the session itself |
| "Review Clockgrove Factory PR 57." | `/factory:factory-review <pr>` | Runs the reviewer on one Factory PR in your session |
| "Start the Clockgrove Factory local loop." | `/factory:factory-serve` | Starts the local loop ([LOCAL.md](LOCAL.md)) |
| "Start the Clockgrove Factory queue." | `/factory:factory-queue` | Starts the unattended scheduler for the repository |
| "Show the Clockgrove Factory scorecard." | `/factory:factory-score` | Prints the scorecard: walk-away, quality, operator minutes, cost |

On the command line, `gh workflow run factory.yml -f issue=<number>` starts one Objective now, and local mode has `factory serve`, `factory run <issue>` and `factory review <pr>` ([LOCAL.md](LOCAL.md), Run it).
