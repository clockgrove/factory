# Factory core

This is the specification for the rebuilt Factory core. Everything that works today keeps working; the rebuild changes how runs are owned, saved, retried and recovered. Once the core ships, this page replaces the state and recovery parts of [the architecture](ARCHITECTURE.md), and [the lifecycle](LIFECYCLE.md).

## Why a new core

Factory should behave like a simple scheduler that runs unattended: take an Objective from the queue, plan it, build it, deliver it, report. The current core has become fragile:

- Code fails closed with no way out, so an error becomes a hold that no command clears.
- Two writers, the CLI and the service, hand ownership back and forth through claims and bindings.
- The GitHub Project sits on the critical path, so one missed card read fails a run.
- Work grows with history: cancel and restart verify a whole Git archive.
- Timeouts turn into human decisions instead of retries.
- The rule "unknown stays unknown, never replay" leaves every uncertain effect as a permanent fence.

The new core replaces those mechanisms. Every capability stays and is ported onto it.

## Stability rules

Each rule has a test (see [Testing](#testing)).

1. **Contained.** A failure affects only its own Objective. The service and the queue keep running.
2. **Deadlines.** Every wait has a deadline. It ends in progress, an automatic retry, or a hold.
3. **Actionable holds.** Every hold is a question with named answers, and each answer works. Cancel always works and takes effect at once.
4. **Crash-only.** The service can be killed at any instruction. On restart it continues on its own from the last saved step, without duplicating any GitHub effect.
5. **GitHub is retried.** A GitHub error, timeout or partial read never fails a run.
6. **Bounded.** Cost follows active work. Nothing reads history to make progress.
7. **Checked once.** An Objective is checked when it's first seen in the queue, with the same checks planning uses.

## Concepts

- **Objective:** a GitHub issue that follows the Objective template, and an item in the configured GitHub Project.
- **Plan:** the Work Items for an Objective, with their dependencies. It's posted on the issue.
- **Work Item:** one unit of work, delivered as one PR. From slice 5B it is also tracked by one issue, which only displays progress and never drives it.
- **Step:** one unit of progress, keyed in state, such as `plan`, `item:3:work` or `item:3:merge`.
- **Hold:** a step that needs a person. It's a question posted on the issue. A Work Item's hold stops only that item and the items that depend on it; a hold about the whole Objective stops every step.
- **Run log:** an append-only record of what happened, for status and analysis. It never drives progress.

## Process model

There is one process, `factory serve`, per installation, run by systemd. It is the only writer of state.

- **Lock.** `serve` binds a Linux abstract socket named for the installation. The kernel releases it when the process dies, so there are no owner records, PID proofs or handoffs. A second `serve` exits at once with "already running".
- **The lock is per network namespace.** A host CLI asks whether the service runs by connecting to that socket, and abstract sockets belong to a network namespace. So the CLI can't see a service inside another one (a container, `pasta`, `unshare --net`): it says "isn't running", and its request file still applies, because files are shared. Run the CLI in the service's namespace to see it.
- **CLI.** Commands that read (`status`, `log`, `watch`, `queue list`, `dream --show`, `dream --preview`, `recipe --file`) read the state files, GitHub, the checkout or the knowledge store read-only, directly. `setup` writes the configuration, never state. Commands that change something (`run`, `answer`, `cancel`, `retry`, `reset`, `pause`, `drain`, `resume`, `queue`, and `dream`'s writes) write one request file to `requests/`. A refusal prints `{"kind":"lifecycle-refusal","code":"..."}` on stderr with a stable code, then the message. The service picks it up within a second and deletes it when the request is applied. If the service isn't running, the request waits there and the CLI says so; a `dream` write is refused instead (`service_not_running`), before any model call.
- **Dream.** `factory dream` reads the store and makes its model call in the CLI, so the service's loop never waits on a model; the call's start and end (with its proposal), `--record` (whose records the CLI reads from Git) and an approval or rejection reach the service as requests, which it applies to the store (knowledge/dream.ts applyDream). Each applies again harmlessly after a crash; a refusal is `dream_refused`. Only a call's end skips the `service_not_running` check: it waits in `requests/` for the service, so a finished model call is never lost to a restart. A call still submitted past its 45-minute deadline is marked interrupted when the next call starts; `--show` lists running and interrupted calls.
- **`factory run N [--provider NAME] [--deadline WHEN]`** is a request plus a follower. The service sets the issue's card to the queued option (adding the issue to the Project, or unarchiving its card, when it has none there; queue.ts `queueIssue`) and reads the queue at once, so the normal queue admission admits it: the card's level, the check, a slot. The request file stays until that admission, which takes its provider (frozen with `selectedBy: "--provider"`) and its deadline (an ISO time, or a duration the CLI turns into one: state.ts `deadlineAt`'s `requested`) in place of the defaults; a restart reads it again. An Objective already running answers at once: no second admission. The operator's latest action wins: a dequeue of the card before the admission (a later queue read, or, after a restart, a card moved off queued after the request, to an option other than the one Factory last showed) drops the request (`superseded`), and so does a cancel, which also moves a card still reading queued to Cancelled. A paused or draining queue refuses (`queue_not_running`), as do a closed issue Factory never ran (`issue_closed`), a missing one (`no_such_issue`) a provider the service lacks (`unknown_provider`), a `--deadline` that passed before the admission (`deadline_passed`), and an older `run` of the same issue once a newer one waits (`superseded`). The CLI then follows the new run log events until the Objective ends (exit 0 done, 1 cancelled), needs a person (exit 2: a question is open, its state can't be read, or the service isn't running; it prints the next command), or Ctrl-C, which stops only the following (130). With the service stopped, the request waits in `requests/` and the CLI exits 2. The service does the work, so there is only one code path and no foreground run.
- **One installation per repository.** Two machines serving one queue are not supported.
- **Upgrade.** Stop the service, install, start. Restart is the normal recovery path, so an upgrade needs nothing more.

## State

Each Objective has one JSON file: `objectives/<issue>.json` under the installation's state directory. Once a finished Objective's cleanup and final sync are done and no observation of it is in flight, the file moves to `objectives/finished/<issue>.json`. Startup never reads the finished states (rule 6); it reads only `finished/*.observe.json`, the settled observations that haven't landed (see Capabilities). A request, a re-queue or `status` reads a file there when it names the Objective, and a later save writes the active file again until it moves back.

```jsonc
{
  "version": 6,
  "issue": 123,
  "status": "checking | planning | building | finishing | holding | resetting | done | cancelled",
  "frozen": { "provider", "selectedBy", "digest", "config": {/* see Frozen configuration */} },
  "done": { "<step key>": "<its result>" }, // finished steps; the check's result holds the base, `plan` the accepted plan
  "kept": { "<fact key>": "<value>" }, // facts that outlive repairs, such as item:<id>:base and item:<id>:pushed
  "attempts": { "<step key>": { "startedAt", "run" } }, // started, not finished; `run` is the service run
  "retries": { "<step key>": { "count", "attempts", "since", "nextAt", "lastError", "cause", "wait"?, "grantedUntil"? } },
  "repairs": { "<target step>": { "count", "findings": [...] } },
  "answers": { "<step key>": { "holdId", "question", "answer", "text"?, "by", "at" } },
  "holds": [], // open questions, oldest first: { "id", "step", "item"?, "question", "options": [...], "cause", "askedAt", "shownAt"?, "shortForm"? }
  "lastShownAt": "<latest GitHub time any question's comment was shown>",
  "asking": { "<step key>": { "question", "options": [...], "scope"?, "cause"? } }, // saved questions, asked before the step runs
  "appliedRequests": [/* the latest applied requests, so none applies twice */],
  "control": { "mode": "paused | draining", "by", "at" }, // optional: the operator's pause or drain
  "withdrawing": true, // optional: dequeued while its check or a re-run's cleanup ran
  "modules": { "github": {/* the card and the comment cursor */} },
  "startedAt": "<admission time: with the issue, it names the run>",
  "deadline": "<optional: the absolute deadline, saved at admission; nothing moves it>",
  "finishedRun": "<the service run that last finished a step>",
  "updatedAt": "<time>",
  "ended": { "at": "<first save at a terminal status>", "by": "<who cancelled; `deadline` at the deadline>", "source"?: "github" },
}
```

- **A step store.** The state records steps, not Work Items. A Work Item's progress is its step keys, `item:<id>:<phase>`, in `done`, `attempts` and `retries`. What it keeps across repairs (its base, pushed heads, the refused result) is the kept facts `item:<id>:<name>`. The plan in force is read only through planning/plan.ts `currentPlan`: the newest accepted amendment's plan, else `done.plan`.
- **Saved after every step**, by writing a temporary file, calling `fsync`, then renaming it. A crash leaves either the old file or the new one.
- **Trusted.** The state belongs to the installation's user, as do Factory's code and credentials. There are no digests, seals, witnesses or tamper checks.
- **Small.** Large bodies (prompts, worker transcripts, review packets) go in the run log directory, never in state.
- **Rebuildable.** `factory reset N` rebuilds the state from GitHub: the plan comment (and its `plan-data` continuations), the PRs whose head is a Work Item branch, and the report comment. It's how a corrupt file, an incompatible version or a new machine is recovered. The service saves a resetting record at once (status `resetting`; the old state kept inside it), and one step, `rebuild`, reads GitHub and replaces the record with the rebuilt state, so its deadline, retries and questions are the engine's and cancel (either form) replaces it at once. The old run's steps are stopped, and the rebuild starts only once they have ended (each by its deadline at the latest), so an effect already in flight (a merge) can't land after the rebuild read GitHub. A reset that replaces a run still waiting this way waits for the same steps, and a dequeue meanwhile withdraws only once they have ended; a cancel meanwhile doesn't wait. What it finds is bound to the current run and plan: only comments by Factory's own login count; the plan data only from Factory's own data block at the end of the plan comment, or the continuations it names (anything else refuses with `plan_unreadable`); a PR counts only if it was opened after the plan comment was last written and names no other run (Factory marks its run in its PR bodies and its report marker; the newest wins); the report only if it is newer than the plan comment; and the plan comment only if the old state, when readable, had accepted a plan. Merged items stay merged; every other item starts fresh on the current start. The operator's pause or drain, a provider switch, the card, the comment cursor and the operator's criterion decisions (`accept <n>`, `refuse <n>`, re-keyed to the rebuilt plan; each still applies only on its own tree) carry over. A reset with no state, plan comment or card is refused (`no_factory_state`), and one that would create an Objective follows the queue's mode (`queue_not_running`). A refused reset restores the old state; the request is answered when the rebuild lands.
- **One version.** If the file's version isn't the current one, or it doesn't parse, the Objective holds with the answers `reset` and `cancel`. The hold is posted on the issue and shown as "Needs you" like any other, and `/factory reset` or `/factory cancel` answers it. The question belongs to one incident: its marker names the unreadable file's digest, and only comments created after that question count, so an earlier incident's question and its `/factory cancel` never act on a later one. Nothing overwrites the file except that answer. There are no migrations. The version 6 state (a hold's answers as `options`; 5 brought one `refused` and one `diagnosis` fact per Work Item, 4 a hold's cause, the error wait class and the `ended` record; 3 one `frozen` configuration) makes every earlier file unreadable; `reset` rebuilds it. A read that fails for a moment (EMFILE, EIO) is tried again every tick, never taken as unreadable.

### Frozen configuration

An Objective runs on the configuration it was admitted with. `frozen` holds its provider (and what chose it: `defaultProvider`, `--provider` or `switch`), the effective configuration and that configuration's SHA-256 `digest`. The configuration is frozen whole, with every adapter default filled in (selection.ts `resolvedProvider`, which the planner and worker are built from too), less an explicit list of operational keys (providers/selection.ts `OPERATIONAL`), never an allow-list, so a key added later is frozen too. The Objective's own provider's settings stand in for `providers` and `defaultProvider`, which only choose a new Objective's provider.

- **Operational keys** may change under a running Objective: they operate the host or present the run, never decide the work. They are the derived secret values (never written to state), `queue` (polling, slots, the Project fields), `execution.concurrency`, `execution.workers`, `execution.validations`, `execution.planners`, `execution.memoryMiB`, `execution.reservations`, `sandbox.limits`, `sandbox.packageStore`, `reviewArtifacts`, `validation.commandTimeoutSeconds`, and a worker's `timeoutSeconds`, `idleSeconds` and `settings.maxTurns`.
- **A change holds once.** The service reads its configuration at start. When it differs from an Objective's frozen configuration in any other key, the Objective holds, and the question names the changed keys and both digests. `adopt` freezes the configuration as it is now and continues; `switch NAME` freezes it on another configured provider; `cancel` ends it. To keep the frozen values, restore them, restart the service and answer `adopt`. `adopt` freezes only the configuration its question named: after a further change and restart it is refused (`stale_question`) and the question is asked again with the current changes. A frozen provider the configuration no longer names offers `switch NAME`, `retry` (after restoring it and restarting) and `cancel`.
- **Execution profiles** freeze with it: each `execution.profiles.<id>` with its provider's resolved settings as `settings`, the same operational keys excluded. A change to a profile, or to the provider it names, holds like any change. A profile the current plan runs on that the configuration no longer names offers only `retry` (after restoring it and restarting) and `cancel`, since `adopt` or `switch` would freeze a configuration without it; this is asked before a removed provider's question, and a `switch NAME` answer to a configuration without it is refused. A removed profile the plan doesn't use (or an Objective still planning) holds like any change, with `adopt`.
- `status` shows the provider, `selectedBy` and the digest.

### Allowances

How much an Objective may correct itself unattended is `autonomy.allowances` (allowances.ts), frozen with the rest of its configuration. The defaults are the old Factory's repair caps:

| Allowance               | Default | What it counts                                                                                                       |
| ----------------------- | ------- | -------------------------------------------------------------------------------------------------------------------- |
| `planningRevisions`     | 4       | Planning revision rounds of one generation, and amendments of the accepted plan.                                     |
| `implementationRepairs` | 6       | Repairs of Work Items' work, across the Objective; a mechanical merge conflict counts only against `perPath`.        |
| `perPath`               | 3       | Repairs of one repair path: one target step, such as a Work Item's work or its publish.                              |
| `resultRereviews`       | 1       | `revalidate` answers across the Objective: a refused result checked again, unchanged (see Result rereview in Holds). |

- **Running out holds.** A repair past `perPath` or `implementationRepairs` asks before the step that would repair runs again: the engine reads the counts (`state.repairs`), and keeps only the question's id, so its `more` is the engine's. An interrupted attempt passed the check when it started, so it runs again without asking. Its cause is `failure`, with `more`, `replan` and `cancel`. Past the Objective's allowance the question is Objective-wide, so every step waits and it is asked once. The engine also charges each `revalidate` against `resultRereviews` when the answer lands, against the live state, so two at once can't both pass; past it, the step holds the same way instead of taking the answer, and that `more` grants as much again and revalidates. Planning past `planningRevisions` asks from its decide step, with `more` among its answers.
- **`more` grants as much again** (at least one) of each allowance the question names, recorded with the counts in `state.kept`. The engine applies `more` to its own repair questions, and the step never sees it; any other `more` is its step's (a planning round, a rereview, a managed worker's spend).
- **A blamed repair is free.** When the diagnosis blames a predecessor (see Predecessor blame in Holds), the predecessor's repair counts as usual, and the blamed item's repair counts against neither `perPath` nor `implementationRepairs` (the repair outcome's `free`, kept in `state.repairs`).
- **A replan starts afresh.** It clears the repairs, the grants and the rereview counts with the plan.
- `status` shows each allowance as used/allowed, with grants, and repairs per repair path.
- **`autonomy.requiredEnvironment`** names operator variables (each also in `policy.allowedSecretNames`, and none starting `GH_`, `GITHUB_`, `GIT_` or `SSH_`, which workers never receive) that must be set, non-empty, in the service's environment before planning. The check step tests them first; a missing one holds the whole Objective, naming only the missing names, with `retry` (after setting it and restarting the service) and `cancel`. Values are never read past that test, logged or shown.

### Execution profiles

`execution.profiles.<id> = {provider, description, selectionHints?}` names a configured provider's worker the planner may assign to a Work Item. The planner and the plan review are offered the ids with their descriptions (planning/steps.ts `offeredProfiles`, from the same list a recipe's `eligibleProfileIds` are checked against), and every work item gets one with a reason. The item's worker runs on that provider's worker settings; planning, reviews and the rest stay on the Objective's provider, and a usage-limit `switch` moves only those, so a limit on a provider the Objective doesn't run on (a profile's) offers only `wait` and `cancel`. Without profiles every item runs on the Objective's provider.

A profile may add two things to its provider's worker, both frozen with the profile, so a change holds a running Objective:

- **`instructions`**: the operator's standing instructions (at most 8,000 characters, no secret value), appended to the worker prompt for its items (work/prompt.ts) as subordinate to Factory's rules and the Work Item, granting nothing.
- **`worktreeRead: true`**: a Claude worker also gets `read_file`, an in-process MCP tool that reads one regular file in its worktree as text (at most 256 KiB). It applies Read's path check (no escape, no `.git`, links only inside), then opens the resolved path by held descriptors with no link followed, and both permission callbacks check it. It needs a Claude worker with `Read` in its tools and allowedTools, so it reads nothing Read couldn't.

## Steps

The service loop:

```text
every second:   apply request files
every 30 s:     read the queue (on failure, keep the last good view)
for each active Objective (up to queue.maxActiveObjectives):
    pick the next runnable steps (up to execution.concurrency at once)
    run each step with its deadline → outcome → save state → log
```

The steps:

```text
predecessors → check → per planning round g:n: plan:g:n → review:g:n → decide:g:n [hold: plan question?]
  → plan (accept, post the plan comment) → build:units (or build:split)
  → while an amendment is pending: amend:<id>:plan → amend:<id>:review → amend:<id> (accept, post the plan comment)
  → per Work Item, in dependency order:
      item:<id>:work → select (media items) → validate → review → publish (push, PR) → ci → merge
  → final (final validation) → final-review → report → done
```

Other steps: `cancel:cleanup` after cancel, `rerun:cleanup` before a re-run, `config` when the frozen configuration no longer matches, and `rebuild` for `factory reset`.

Every step returns exactly one outcome:

| Outcome                 | Meaning                                                                                            | What the core does                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `done(data)`            | The step finished.                                                                                 | Save the data and move on.                                                                             |
| `retry(reason, after?)` | A wait classed by its cause, an error among them (see [Waits](#waits)).                            | Back off (30 s doubling to 15 min, or the reset time) and run the step again.                          |
| `repair(finding)`       | The work is wrong: validation, review or CI failed.                                                | Run the item's work step again with the finding, within the [allowances](#allowances).                 |
| `hold(question)`        | Only a person can decide (cause `question`), or the step can't succeed as it is (cause `failure`). | Post the question on the issue, set Status to "Needs you", and wait (see [Holds](#holds-and-answers)). |
| `replace(build)`        | Only `factory reset`'s `rebuild` step: the state rebuilt from GitHub.                              | Stop the old record's steps and save the rebuilt state whole.                                          |

A failure is a hold with the cause `failure`: errors in a row, an allowance spent, a crash-loop suspect, a call too large for the model, or a result the step can't produce. Where the workflow can plan again (a planning round before acceptance; a Work Item, final, final review or report step after it), the engine adds `replan` to its answers.

A step that kept its progress and goes on at once (captured media to collect, a staged repair, one rerun of a flaky command, an approval or an accepted edit) returns `retry` with `progress`: that is not a wait, so it ends the step's run of retries and no status note or wait clock counts it. A repair consumes the answer of the step that returned it, so the step never acts on that answer again. Past a repair allowance, the step that would repair asks before it runs again (see [Allowances](#allowances)).

`replan` is the workflow's, never a step's: the engine applies it from one place (`Workflow.replan`) instead of running the step that asked. Before the plan is accepted it records the operator's decision on the planning round, and a new planning generation re-reads the issue. After acceptance it forgets the plan and the build and checks the Objective again (a repair of `check` whose cleared steps' repair history goes with them). A replan never counts against a repair allowance, `check`'s included, and the answer is spent once applied.

An exception that escapes a step is classified in one place (workflow.ts `errorOutcome`, the workflow's `outcomeOf`, which the engine calls when a step throws): a full disk and the checkout's Git refusal (an origin that no longer names the target) hold for the whole Objective; a planning or review call too large for the model is a failure hold for the whole Objective, with `replan` (`refuse` for an amendment), `retry` and `cancel`; a provider's other classified failures (providers/planner.ts `providerOutcome`) and GitHub's answers (github.ts `githubOutcome`) map as [Waits](#waits) says; anything else is an error, as are a missed deadline, an idle model and an invalid model answer. After three errors in a row on the same step, it becomes a failure hold: the error, plus `retry` and `cancel` (and `replan` where the workflow can plan again). Cleanup after cancel never asks (the step flag `neverAsks`): any outcome but done, a Git refusal included, retries in the background. A step can't crash the service, block another Objective, or leave an Objective without an answer that works.

### Interrupted steps

A step the service's death cut off (a crash, an OOM kill, a reboot) is not that step's error. Each saved attempt names the service run that started it, and after a restart the step runs again at once, with no backoff and no error count, cleanup after cancel included. Crash-loop protection is the service's:

- **Crash loop.** `service.json` keeps one list of the latest deaths (`deaths`, at most 20; a clean stop empties it). Each death records how long that run lived after resuming its steps, the steps running when it died, and whether it finished any step. The crash streak is the trailing deaths that lived less than 10 min. From the third start in a streak (two deaths), interrupted steps resume after 30 s, doubling to 30 min; other steps run as usual. `factory status` shows the deaths in a row and the resume time. A clean stop ends the streak.
- **A step that kills the service.** The last three deaths are the evidence: the steps running at each (the open attempts that run started), and whether that run finished any step (its heartbeat count, or an Objective's state saved with a step's outcome naming that run, so a death right after a step still counts). When steps finished in the runs between them, every step that was running at all three holds, each with its own question: "The service died 3 times in a row while step … ran", with `retry` and `cancel` (a second question in the same scope is saved and asked after the first). So a crash streak ends in questions within three deaths however many steps keep being interrupted together. The evidence is then spent (each death is marked `spent`), so another hold needs three more deaths. Cleanup after cancel never holds; the crash loop's delay covers it.

### Waits

Any other retry is a wait. Waiting more than a few hours is never right, so a wait is classed by its cause, not by how long it has gone on:

| Cause                            | Examples                                                                                                                                                                                                                | What the core does                                                                                                                                                                                                                                                                                           |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Fatal until a person acts        | An expired or invalid gh or provider login; GitHub 401 or a 403 refusal; a missing repository or issue (404); a full disk; a required check with no run or status 15 min after the push; a workflow that didn't trigger | Hold at once, with a question naming the fix.                                                                                                                                                                                                                                                                |
| A known reset time               | A GitHub rate limit; a provider usage limit that reports its reset                                                                                                                                                      | Wait until the reset when it is at most 3 h away. Further away or unknown (a weekly limit): hold with `wait` (keep waiting until it resets), `switch NAME` (run this Objective on another configured provider, which becomes its frozen provider; plain `switch` when there is only one other) and `cancel`. |
| A human gate Factory doesn't own | An environment approval; a review the branch requires; a predecessor Objective (see [Predecessors](#predecessors))                                                                                                      | Wait with no deadline. Status shows "waiting on" the gate, and one reminder comment follows after 24 h.                                                                                                                                                                                                      |
| An unknown transient cause       | The network down; 5xx or an outage at GitHub or the provider; 409, 410, 422 or a GraphQL error from GitHub; CI queued or running                                                                                        | Retry with backoff. After 1 h, post one status note on the issue (edited in place). After 3 h, hold with a question naming the cause and the last error: `wait` (another 3 h), `retry` and `cancel`.                                                                                                         |

A problem on the host counts as fatal when it is certain (disk, login) and as transient otherwise. Times are wall-clock times saved in the state, so a restart doesn't reset a budget, and the question comes only after the step ran again and still had to wait.

- **An open question pauses the clocks of the steps it stops.** While a question is open, no step it stops starts (see [Holds](#holds-and-answers) for its scope), so their waits don't count; other items' clocks run on. When the question closes, each waiting step it stopped moves its wait start and any granted `wait` forward by the time it was due but blocked, up to when another open question that also stops it was asked (that one's close moves the rest), so overlapping questions never count the same time twice. A human gate's start stays: it never times out, and its one reminder is keyed to that start. No status note or gate reminder is posted for a step an open question stops. A step that asks while a question covering its scope is open doesn't wait past the answer: its retry comes due at once, so it runs again right after the answer and asks then, even when its own wait (a reset hours away) would end later.

- **One budget per class.** A step's wait start, first cause, backoff and any granted `wait` belong to one run of one class: a reset, a gate, or an unknown cause (errors count as unknown). When the class changes, they start again, so eight hours on a review never spend the transient budget. The error count covers one run of consecutive errors; any other outcome resets it.
- **Only a real rate limit is a reset.** A 429, or a 403 rate limit, waits for its reset. A 5xx is an unknown transient even when it carries rate-limit headers; its `retry-after` only sets the backoff. A reset at or before now (a skewed clock) still waits at least the normal backoff.
- **Required checks before gates.** A required check with no run or status counts as pending whatever GitHub's readiness says, and it holds 15 min after the push. A review the branch requires is a gate only once every required check is there.
- **Deadlines of a wait are the engine's.** A step that waits on something GitHub may not show yet (a merge it made, a PR state) retries with a question for later; the engine asks it once the run of retries has gone on 2 min. A required check that never registers is asked about the same way, 15 min from the push (or from when Factory began waiting, when GitHub doesn't say). A module never reads the engine's retry records.

### Idempotence

Every step is safe to run again. Before it does anything with an outside effect, it looks for that effect on GitHub:

| Effect          | How the step finds it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch          | Fixed name: `factory/<issue>/<item>`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| PR              | Open or merged PR whose head is that branch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Merge           | That PR's merged state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Comment         | A hidden marker, `<!-- factory:<issue>:<kind>:<id> -->`, in a comment by Factory's own login (anyone else's marked comment is ignored). An existing comment is edited, not posted again. The report's marker and the live status comment's name the run (`report:<run>`, `status:<run>`, the run being its admission time, state.ts `runOf`), so a later run of the same issue posts its own report and status and checks for edits again. A plan too large for one comment continues in numbered `plan-data` comments. |
| Issue close     | The issue's state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Work Item issue | The marker on its body's first line, on an issue by Factory's own login: looked up among the Objective's sub-issues and, only while a creation isn't recorded in state (`creating` is saved, with its time, before the create), Factory's `factory:work-item` issues updated since that creation began.                                                                                                                                                                                                                 |
| Issue link      | The issue's sub-issues or blocked-by links, read before one is added.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Branch delete   | The branch's absence. After its PR merges (a native stack's layers once the whole unit merged), and on cancel, a branch is deleted only when Factory made every commit it has beyond the default branch (GitHub's update-branch merges from the item's base count, a stack layer's predecessor branch included), by a push with a lease on the head it read.                                                                                                                                                            |
| Project field   | Read before each write, and written only over the option Factory last saw or wrote (see [Queue](#queue)); it is a display.                                                                                                                                                                                                                                                                                                                                                                                              |

So an effect whose result was lost is never "unknown". The next run of the step finds it on GitHub and carries on.

A model call has no outside effect. If the process dies mid-call, the call runs again. A worker's worktree is kept and reused on the base the item kept, so a repeated work step continues from its files. A worktree from an attempt that never kept its base (it died before its outcome) is reset onto the base the rerun picks.

A step's kept facts (`state.kept`) outlive repairs. Every read and write goes through one typed helper (work/facts.ts `fact` and `facts`), which builds the keys (`item:<id>:<name>`, or an Objective step's own name) and types the values. A step forgets one by keeping `null`, and the engine then removes it, so a reader never sees `null`. A replan after acceptance forgets them all.

### Deadlines

| Wait                   | Deadline                                           | At the deadline        |
| ---------------------- | -------------------------------------------------- | ---------------------- |
| GitHub request         | 60 s                                               | retry                  |
| Plan, plan review      | 45 min each, 15 min idle                           | retry; hold after 3    |
| Worker turn            | 2 h total, 15 min idle (Copilot: `idleSeconds`)    | retry; hold after 3    |
| Worker's own Validate  | silent up to the item's validation deadline        | retry; hold after 3    |
| One validation command | `validation.commandTimeoutSeconds` (30 min)        | repair                 |
| Validation step        | its commands × the command timeout, + 15 min       | retry; hold after 3    |
| Final validation       | its commands × the command timeout, + 30 min       | retry; hold after 3    |
| Result or final review | 45 min, 15 min idle                                | retry; hold after 3    |
| CI on a PR             | a needed check registers within 15 min of the push | hold                   |
| CI queued or running   | 3 h of transient waiting (see [Waits](#waits))     | hold with `wait`       |
| Hold                   | none: it waits for a person                        | nothing yet (slice 5B) |
| Objective              | `queue.objectiveDeadlineSeconds` from admission    | cancel                 |

The Objective deadline is optional (no default) and absolute: admission saves it in the state as a time (`deadline`), so a restart, a reset or a later configuration never moves it (`factory run N --deadline` sets its own time in place of the default). On every tick, for every Objective, whatever it waits on (a question, a pause, a human gate, a slot), the engine checks it (engine.ts `expire`); past it, it cancels through the normal cancel, recording `ended.by: "deadline"`, so cleanup runs; a restart past it cancels at once. Status shows the deadline and the time left, and a question asked within its last hour says when it falls. Crash points `engine:deadline:before-cancel` and `engine:deadline:cancelled` bracket the save.

Step deadlines are fixed in the code, with two configured bounds: `validation.commandTimeoutSeconds` (default 1800) limits each validation command and sets the validation deadlines above, so a plan with many commands never outlasts its step, and a Copilot provider's `worker.idleSeconds` (default 900) is its worker's idle bound. A managed worker's `timeoutSeconds` (default 3600, at most 6000) fits inside the worker deadline. Idle bounds are the adapter's: 15 min for Codex planning and workers (5 min for a Codex review at medium effort or lower), 2 or 5 min by effort for a Claude call, and 45 min while a model's tool runs; a Claude or Copilot worker's running Validate or shell command may be silent for the item's whole validation deadline, if longer, still inside the 2 h turn. The only reminders after 24 h are a human gate's (see [Waits](#waits)) and an open question's (see [Holds](#holds-and-answers)). The engine's limits take shorter test timings from the environment (`FACTORY_DEADLINE_MS`, `FACTORY_WAIT_MS`, `FACTORY_NOTE_MS`, `FACTORY_REMIND_MS`, `FACTORY_BACKOFF_MS`).

## Queue

The GitHub Project is the source of truth for what is queued.

- **Queued** means the item's Factory field (`queue.field`, default `Factory`; called Status below) equals the configured "queued" option. **Order** comes from the Project's number field (`queue.orderField`, default `Factory order`), then issue number.
- **Read-only, and retried.** Every 30 s the service reads the Project's queued cards, filtered by GitHub (the items `query`, `<field>:"<queued option>"`, closed issues included), plus, from the issue side, the issues it already knows and the most recently updated open issues, since the Project's item list can lag. So a read costs one page per 100 queued cards, not per card ever added; past 1,000 queued cards the rest wait for a later read, and the log says how many. A known issue GitHub no longer has here (deleted, transferred, converted) is dropped from later reads with a log line; an issue read by number that comes back from another repository, or with another number, is gone too. The rest of the read stands. Any other failed or partial read keeps the last good view and tries again. A read failure never fails a run.
- **Status is a display.** The service sets Status as the run moves, from the tick it admits the Objective: Planning, Building, Needs you, Done, Cancelled; while it is checked, and while it waits for its first slot, Factory writes nothing and the operator's Queued stands. After a hold is answered, an Objective that waits for a slot shows its status (Planning or Building). The list of options is Queued (the operator's), Planning, Building, Needs you, Done, Cancelled (the `Failed` option may stay configured; no status shows it). Every sync job (a card, a comment, a reply, the queue read) runs in the background on the one keyed job runner (jobs.ts `Jobs`, which the knowledge observations use too), one at a time per job and Objective. A failed one is logged and tried again after a backoff of its own (from 10 s, doubling to 10 min), so one Objective's bad card never spends the rate limit the others need; one past its 10 min deadline is aborted and counts as failed. A run that is replaced or let go of drops its jobs and their backoffs, except a reply already being posted, which still lands. A finished Objective stays in memory, across restarts too, until its final Status and its replies are written. An issue that any sync job finds gone here (404, 410, or a redirect while the repository still answers under its configured name: moved; see Security: No redirects) gets no more card, comment or reply writes, whether or not a queue read still asks for it; a finished one's unsent replies are dropped with a `reply-dropped` log line, and its sync settles.
- **Levels.** Factory never writes the queued option on its own: only `factory run N` sets it, as the operator's request. So a card that reads queued is always the operator's input. An unfinished Objective dequeues on a change from queued to anything else, cleared or off the Project included, against the option Factory last saw on the card or wrote (`seen`, saved in state). A finished Objective queues again once all of these hold:
  - its final Status is on the card: Factory wrote it, or stood back from someone else's change, and an operator's re-queue before Factory wrote it counts;
  - its replies are written;
  - a read that began after Factory's last write shows the card queued, with an option time (GitHub's clock) later than the queue that started the run (`queuedAt`).

  So a stale or lagging read of the first queue never runs a finished, cancelled or withdrawn run again. A read that started before Factory's last write is skipped for that card.

- **Never over the operator.** Factory reads the card before each Status write and writes only over what it last saw or wrote itself. Someone else's change is the operator's input: from queued, it dequeues an Objective that hasn't started; any other change stands until the Objective's status moves on. Factory saves the option it is about to write, so after a crash a card showing it still reads as Factory's own.
- **Operator controls:** set an item's Factory field to the queued option to queue it (again, for a finished Objective: set it after its final Status shows), move it out of the queued option to dequeue it if it hasn't started, and set the order number to reorder. Dequeuing before planning starts withdraws the Objective: its state is removed, as if it was never admitted, so queuing it again checks it afresh. A dequeue while the check runs, or once a re-run's cleanup has begun, is saved (`withdrawing`): nothing past them starts, Factory writes no Status and asks nothing for it, so the operator's option stands, and the Objective is withdrawn as soon as they end. A re-run's cleanup that hasn't begun never runs (the earlier run's finished record stands), and one that holds or errors is withdrawn at once instead of asking. Order is read on every queue read until the Objective starts. There is no control card and no managed metadata field.
- **Several at once.** Up to `queue.maxActiveObjectives` Objectives plan or build at once (default 3), in queue order. An Objective builds only when no Objective whose plan was accepted earlier, and that is unfinished, owns an overlapping path; planning never waits. An Objective whose open holds stop every step it could start, one whose every remaining step waits on a human gate or a hold, and one waiting on another's paths take no slot; a gated or holding Objective still owns its paths. Host-wide caps limit, across every Objective (capacity.ts, engine.ts HostLimiter):
  - worker runs (`execution.workers`, default half the CPUs);
  - validations (`execution.validations`, a quarter of the CPUs);
  - planner calls, meaning planning rounds and reviews (`execution.planners`, two per worker);
  - checks and re-run cleanups (`queue.maxActiveObjectives` at once).

  Each running step also reserves memory, and a step starts only when its slot and its reservation both fit within `execution.memoryMiB` (default: the host's memory less 4 GiB). Default reservations, in `execution.reservations`: a worker 1536 MiB and a validation 3584 MiB. A planner call reserves nothing by default. Steps at once are bounded by `queue.maxActiveObjectives` × `execution.concurrency` (24 by default), so at most 6 planner calls (about 3.3 GiB) run beside 12 workers and 6 validations, within the spare memory. A planner reservation the operator sets takes only memory that no free worker or validation slot needs, so memory never holds workers and validations below their caps. They come from measurements on a 24-thread, 46 GiB host against a TypeScript monorepo:
  - a full test suite peaked at 6.8 GiB on about 3 cores;
  - a package's tests used 0.5 to 1.5 GiB;
  - an agent process used 0.4 to 0.7 GiB.

  At the defaults, every worker and validation fits at once, and memory makes the next step wait instead of letting the kernel kill one. `status --capacity` shows the slots and memory in use, and how the configured capacity fits the host. Setup reports the same recommendation, and neither changes it. Every fetch in the shared checkout runs one at a time: a caller joins the fetch that starts after the running one, shared by everyone who asked meanwhile, because concurrent fetches fail against each other when the default branch moves.

- **Again.** Queuing a finished Objective again stops its old run (its steps, saves and GitHub jobs) once its cleanup is done, and starts a new one. The new run first reopens the issue if it is closed (the earlier run closed it, or the Project's "Auto-close issue" workflow closed it again); if GitHub refuses, it holds with `retry` and `cancel`. Just before that reopen, and only then, Factory touches the Project's built-in single-select "Status" field (not its own queue field): if the card's Status reads "Done", Factory moves it to "In Progress", else "Todo", else the first option not named "Done", because that workflow closes an issue whose Status reads Done. The check that follows reads the issue again: if something closed it again anyway, it holds with a question naming who closed it, with `retry` and `cancel`, and never plans on a closed issue. A closed issue that never ran isn't queued. The new run then closes the old run's open PRs and removes its worktrees, as `replan` does after a plan was accepted. Factory resets a Work Item branch only when it made every commit the branch has beyond the default branch: each is committed as Factory (Factory commits with a clean Git environment as `factory@users.noreply.github.com`; an amend, rebase or cherry-pick by anyone else changes the committer), or is GitHub's update-branch merge from the default branch or the item's base (a stack layer's predecessor branch). Otherwise it holds with `retry` (after moving the commits off), `reset` (replace the branch anyway) and `cancel`.
- **No approval step.** A clean, reviewed plan runs straight away. Factory asks only when review finds a decision for the operator.

## Check at queue time

When the service first sees a queued Objective, it waits for its predecessors (see [Predecessors](#predecessors)), then runs the Objective checks at once (first, that every `autonomy.requiredEnvironment` variable is set: see [Allowances](#allowances)), whether or not a slot is free, within the host-wide `github` cap (`queue.maxActiveObjectives` checks and re-run cleanups at once, in queue order): template sections, pinned Sources that resolve at the default branch, no duplicate headings, and declarations that parse. Planning uses the same function. A checked Objective then waits for a slot.

A failed check is a hold. It names each problem and how to fix it, and Status goes to "Needs you". Edit the issue and answer `recheck` to check it again.

## Predecessors

An Objective issue can be blocked by other Objective issues through GitHub's native blocked-by links. The `predecessors` step (planning/predecessors.ts) runs before the check, so the check and planning read a default branch that has the predecessors' work (a Source a predecessor adds resolves). Each run reads the links again:

- **Wait.** While a blocker is open, or closed as completed while its Objective isn't done here, the Objective waits with no question. It is a gate wait (see [Waits](#waits)): no deadline, no slot (like the check, it runs slot or not, within the `github` cap), status shows "Waiting on predecessor #N (why)", and one reminder follows after 24 h. A dequeue while it waits withdraws it, as before the check.
- **Ended.** A blocker closed as not planned or duplicate, one whose Objective was cancelled, one closed that Factory never ran here, one in another repository, and one whose issue (title or body) was edited after Factory accepted it hold the Objective with `replan` (read the links again, after editing them), `ignore N <reason>` (go on without that predecessor; `owner/repo#N` names another repository's issue, and an ignore matches only that repository's issue; the reason is kept with the answer's author and time) and `cancel`.
- **Cycle.** A cycle of open blocked-by links through the Objective holds, naming it, with `retry` (after removing a link), `ignore N <reason>` and `cancel`.
- **Evidence.** Once every predecessor is done or ignored, each done one's accepted result (its title as accepted, the commit final validation and review passed on, its tree, its final commands, and each Work Item's PR and merge commit) is saved as the step's result. The check (and a replan's re-read) checks it against Git: the commit must exist with that tree, and it and every merge must be on the base planning reads; otherwise it holds with `retry` and `cancel`. Planning, plan review and amendments get it as the native prerequisites.

A replan after acceptance runs the step again. A state checked before this step existed doesn't.

## Holds and answers

A hold is a question with named answers. Each answer is an option, core data that says what it does:

```jsonc
{
  "id": "plan-1",
  "question": "...",
  "options": [
    {
      "answer": "answer",
      "family": "answer",
      "consequence": "Sends your decision back to the planner.",
      "needsText": true,
      "recommended": true,
    },
    {
      "answer": "switch",
      "family": "switch",
      "arg": "claude",
      "consequence": "Runs this Objective on provider claude from now on.",
    },
    {
      "answer": "cancel",
      "family": "cancel",
      "consequence": "Ends the Objective at once and closes its PRs and the issue.",
    },
  ],
}
```

- **Options.** `answer` is the literal token (`/factory <answer>`); `arg` is what follows it for a parameterized answer (`switch NAME`); `family` groups options (retry, replan, cancel, wait, switch, adopt, accept, refuse, select, answer, repair, retire, reset); `consequence` is one short sentence; `needsText` marks an answer that needs text after it; exactly one option is `recommended`. Every place that raises a hold supplies its options through one helper (engine.ts `hold`), which writes the consequences of the common answers (retry, replan, cancel, wait, switch, adopt, answer, fresh) once. The engine expands `switch` into one option per configured provider, this Objective's own included (it re-freezes that provider to its current configuration), and names those options in the question, so the text and the options can't disagree; a limit's hold offers only the other providers. A recommended `switch` with several targets recommends the Objective's own provider, else the next other answer, never an arbitrary provider. The engine adds `cancel`, `replan` to a failure where the workflow can plan again, `fresh` to a Work Item's question (see Fresh start), and `revalidate` where the item has a refused result to check again (see Result rereview).

- **Scope.** A hold outcome declares its scope, `item` (the default) or `objective`. An `item` hold from a Work Item's step (`item:<id>:…`) stops only that item, the items that depend on it (they aren't runnable until it merges), and the native-stack layers above it (they run once the layer below is published, so the workflow names a layer's predecessors and their holds stop it too: work/steps.ts `layersBelow`). Other items keep starting and finishing. An `objective` hold stops every step. A cause that is installation-, account- or provider-wide is `objective` wherever it is raised: the issue closed or edited after planning, a non-writer's Objective awaiting approval, a full disk, repository or origin access (a GitHub login, permission or missing-repository refusal, a push the login or the repository refuses, merge commits or native stacks the repository doesn't allow, the checkout's Git refusal or origin problem), a provider's login, billing, quota or model, its setup or missing SDK package, running as root, the package or offline-install environment, an unavailable sandbox, the installation's configuration (reviewArtifacts, delivery kind, Secretlint), and a limit that resets too far away (`wait`/`switch`: the limit is the account's). Provider holds are classified in one place, for every provider: a `PlannerError` that holds is Objective-wide unless the cause is one Work Item's own (its files, review images or session budget: `PlannerError.itemHold`), and `providerOutcome` maps it for the planner and every worker (providers/planner.ts). Every hold from a step that isn't a Work Item's stops the Objective too: planning, final, final review, report, cleanup and unreadable state. Final and report wait until every item is settled, so they wait for every item hold. The engine's error and transient-wait questions, the per-path repair allowance and crash-loop suspect questions, and media, select, revalidate, review and secret-scan questions take the scope of the step that asks; the Objective's implementation repairs question is Objective-wide.
- **Several at once.** At most one hold per Work Item and one for the Objective are open. A step that asks while a hold covering its scope is open (the Objective's, or its own item's) opens nothing; its retry comes due at once, so it runs again right after that answer and asks then if the cause remains, so an Objective-wide cause is asked once. A question that running the step again wouldn't ask (a crash-loop suspect) is saved for the step in `asking`, apart from its retry, so no change to a retry (a `switch`, a done step, a repair) drops it. It is asked as soon as no open hold stops the step, before it runs, and dropped only when asked or when a repair or replan clears the step. Answering `wait` to a limit grants the wait to every step waiting on that limit; `switch` runs every step waiting on a provider's limit again at once on the new provider. Each hold has its own id, question and answers. The Objective shows `holding` (Status "Needs you") while any hold is open. A held Objective takes no queue slot only when its holds stop every step it could start.
- **Saved.** Open holds are in the state file, so a restart restores them. A repair that clears a held step drops its hold (the question is about work that is gone); cancel drops them all.
- Each hold is posted as one issue comment with its own marker (`hold:<id>`), and it lists the options, each with its consequence. Its text is redacted with the configuration's secrets and escaped, and only then measured: a question over 20,000 characters loses its middle, never its last 4,000 (where the engine's notes are: the switch answers and the deadline), and the cut names `factory status N` and never splits an escape. If GitHub refuses the comment (a 4xx, such as a 422 for its size) or it fails three times in a row other than transiently, it is written compact from then on (the question cut to 4,000 the same way, logged as `question-compacted`) and keeps retrying, so a hold is never left unshown.
- **Failures.** A hold with the cause `failure` is that same one comment, opening with the failed step and its Work Item, then the question (which says what failed), then its evidence when the step errored before it asked: the count of errors in a row, since when, and the first and last error, each redacted and cut to 1,000 characters. A failed Work Item's live comment on its own issue says so and points to the Objective, where it is answered. With `progress.enabled: false` it reads like any other question.
- **Reminder.** A question shown on the issue and still open 24 h after it was asked gets one reminder comment that links its question comment (marker `remind:hold:<id>`). The hold's id carries its step and `askedAt`, so a restart never posts it twice and a question asked again is a new one with its own day. `FACTORY_REMIND_MS` shortens the 24 h for tests, as for a human gate. None while `progress.enabled` is false. Crash points: `sync:remind:before` and `sync:remind:after`.
- **Answering:** a comment `/factory <answer> [--question <id>] [--review-artifacts N]... [arg] [text]` from a user with write access to the repository, or `factory answer <issue> <answer> [arg] --question <id> [--text ... | --text-file PATH] [--review-artifacts N]...` (an absolute path to a regular UTF-8 file, opened once without following a link). An answer's text is at most 64 KiB (a comment's limit), however it comes: the engine refuses a longer one (`invalid_answer`). `fresh` isn't offered on a merge step's question, which may come after GitHub merged the PR, nor on an aggregate, QA or discovery item's, which keep no worker result or worktree (their `retry` checks or observes again). `arg` names the option of a parameterized answer (`switch NAME`): the CLI passes it apart from the text, and in a comment it is the first word after the answer; plain `switch` works when it has one option. The engine applies the option's own `arg`. An answer must never land on a question its author didn't read:
  - The CLI always names the question. `factory retry <issue> --question <id>` answers `retry` to it. Without `--question`, `factory retry` never answers a hold: it runs now the waiting steps no open hold stops, and is refused while an Objective hold is open (or when every waiting step waits on a hold).
  - A bound answer (`--question <id>`) is checked against nothing else: the id names one asking, and a re-ask gets a new id.
  - A comment that names no question applies only when exactly one hold is open, its comment showed the short form before the answer comment was written, and no other question's comment was shown after it. Otherwise it is refused, and the reply lists the open question ids and the bound form. Every time compared is GitHub's: the answer comment's `created_at`, the hold's `shownAt` (the `created_at` or `updated_at` of the question comment Factory posted or edited), and `lastShownAt`. A host clock never enters, so skew can neither misapply nor refuse an answer. Until GitHub shows a hold's comment, only the bound form answers it.
  - A hold's comment shows the short form `/factory <answer>` only while it is the one open hold. When another opens, or another question's comment was shown after it (so its short form would be refused), Factory edits the comment to show `/factory <answer> --question <id>`.
  - An answer that names a hold that isn't open is refused, naming the open ones. `factory status` lists every open hold with its id and the command that answers it.
- **Comments are read by GitHub's clock.** A run reads comments from when its card was queued (the option's `updatedAt`), and an unreadable state's from its question; the cursor only moves forward. GitHub's `since` filters on `updated_at`, so only a comment created at or after the cursor counts: an earlier run's comment, or an old one edited later, never acts.
- The service checks for comments every 30 s while it is holding. If someone without write access answers (or the user doesn't exist), that's ignored and logged. A comment whose author's access GitHub can't report now waits in a list of up to 20 per Objective and is checked again with backoff; the comments after it go on.
- **In an agent host.** The director skill shows each open hold with the host's question tool (Claude Code's AskUserQuestion, or its Codex equivalent): the question, and each option with the recommended one first and its consequence. A hold with more than 4 options (the tool's limit) is asked in two steps: the family, then the option. That gives the operator an app notification. The chosen answer runs `factory answer`. `factory status --json` lists open holds in this shape, so the skill needs no answer table and no parsing; the text status lists the options too.
- An answer that matches none of its hold's options gets a reply naming the valid answers. Nothing else changes. So does an answer whose option needs text (`needsText`, such as planning's `answer` and `allow`) when it has none.
- `cancel` is valid at every hold and at any time.
- **Fresh start.** A Work Item's question also offers `fresh` (the workflow's, like `replan`: work/steps.ts `freshable`), except an allowance's question, whose way past is `more`. It discards the item's result and work: its base, refused result, finding, diagnosis and media selection go, and the next attempt starts a fresh worktree on the current base, with no repair context. It is a repair (work/steps.ts `repairOutcome`), so it counts against `perPath` and `implementationRepairs`, and the native-stack layers above move onto its new head. The engine applies it from one place, in the same save that spends the answer, so its hold id takes effect once.
- **Provider model.** A model the provider's login can't serve holds with `switch NAME` and `cancel`. Copilot checks its model list before it opens a session, so this hold costs no request, and it also offers `retry`: the retry reads the list again before any session, so it bills nothing and succeeds once an admin enables the model. A session that served another model offers no `retry`, because each one bills a request. The operator sets the model and restarts the service, then answers `switch` with the same provider's name, which re-freezes its changed configuration, or with another configured provider's name.
- **Configuration changed.** An Objective whose frozen configuration differs from the service's holds once with `adopt`, `switch NAME` (when another provider is configured) and `cancel` (see Frozen configuration). The `switch` options are then every configured provider: another one moves the Objective there, and this one re-freezes its changed configuration.
- **Final review.** `retry` to final review's refusal means the default branch was fixed: final validation runs again on the new head, then the review. A `retry` to an error or wait question on final review only runs the review again.
- **Criterion decisions.** A result, QA or final review that asks about criteria it can't judge (needs-human) holds with `accept <n> <reason>` and `refuse <n> <reason>` for each one, n being the criterion's number in the question, from 1 (the option's `arg`); final review's refusal also offers `accept <n> <reason>` for each criterion it refused. There is no cap: more than 4 options are asked in two steps. The reason is required. Each answer decides one criterion and is kept by the review step (`item:<id>:decisions`, `final-review:decisions`), keyed by its question's id so a rerun records it once, and tied to the accepted plan, so a replan drops it (a reset carries it to the rebuilt plan). A decision applies only to reviews of the exact tree it was made on, as the old Factory's: `accept` counts the criterion as passed there, and a later tree (after a repair, or a new integrated result) judges it again, with the earlier decision as evidence. `refuse` counts it as unmet on that tree: a Work Item's result goes to repair with the refusal as its finding (a repair like any other, counted against the allowances), a QA item holds as refused, and final review takes its refusal path. While open criteria remain, the step asks again about only those. The review the operator is answering is kept (`held`), so its verdicts on the same tree stand and the reviewer is called again only for criteria neither it nor the operator decided: once every open criterion is accepted, the step goes on with no model call. Every review sees the decisions as a controller row; final review sees the Work Items' as evidence and decides with its own. The report and status (`Decided:` lines; `decisions` in `--json`) list each with its reason and tree (planning/plan.ts `decisionsOf`), and repository memory records each as a human decision with its criterion, outcome, reason, tree and item.
- **Edited during planning.** `continue` to the question about an Objective edited while it was planned keeps the plan and accepts the text GitHub shows then, so building asks again only after a later edit.
- **Configuration.** The service reads its configuration once at start. A hold that asks for a configuration change says to restart the service before answering.
- **Media selection.** The select question's answer is a candidate set id, then optionally `bind ITEM...` (direct dependents that get the set as read-only input), then any text: the text is recorded with the selection as the operator's reason and shown to review.
- **Repair diagnosis.** When diagnosing a refused result needs a decision, the work step holds with `answer <text>`, `retry` (diagnose again) and `cancel`. The text reaches the next attempt as the operator's guidance, framed as the operator's words, never as Factory's diagnosis. It is keyed by its question's id: the correction it becomes is saved with that id, so a rerun or a replayed answer never applies it twice, and a newer answer replaces it. It also offers `revalidate` (see Result rereview). Only a repair that refuses the result itself (validate, review, CI, merge, a secret the result writes) records it as refused, so the next result must differ. A select or publish media repair (new candidates, a selection that couldn't be written, missing LFS objects) records nothing: its correct fix may leave the tracked tree unchanged.
- **Predecessor blame.** The diagnosis may decide `predecessor` (repair.ts): the failure comes from the result of a Work Item this one builds on, not its own work. It names that predecessor and one of its owned files, with the evidence and the predecessor's correction; the diagnosis also gets the predecessors' files the failure names, the review cites or it asks for. A conditional item settled as skipped can't be blamed. Like a repair, a blame never repeats a correction that already failed for the same failure: the blame joins the blamed item's tried corrections, and one the predecessor already tried asks instead. A native-stack layer below, not yet merged, is repaired with that correction as its saved diagnosis (work/steps.ts `blameOutcome`): its repair counts, the layers above move onto its new head as for any layer repair, and the blamed item keeps its change to replay there, with its own repair `free`. A merged predecessor is never reopened: the item holds with the evidence, offering `amend` (recommended, while a planning revision is left), `replan`, `answer <text>`, `retry` (diagnose again) and `cancel`; that repair already counted, and the answer that follows spends it. `amend` proposes amendment `blame-<item>-<repair>`: a Work Item after the predecessor that owns the blamed file and makes its correction (see Amendments).
- **Amendments.** A proposal of work the accepted plan lacks becomes an amendment (planning/amendments.ts): the planner revises the current plan, Factory's plan checks and the amendment fence check it, an independent review judges it, and an accepted one is the plan from then on, posted as the plan comment (crash points `amend:post:*`, and `amend:data:*` for a plan in parts). Each proposal is kept as `amend:<id>:proposal` and charges one `planningRevisions`, shared with the plan's own revision rounds, never refunded. While one is pending, or rejected and not yet settled, no other step starts (workflow.ts); the steps after it read the amended plan, so an item it widened runs with its new owned paths and dependencies. One is in flight at a time: one that lands together with another is rejected at once, and each rejection stays open until its own answer settles it. The fence is checked again at acceptance, against the state then. A plan `factory reset` rebuilt has no planner answer to revise, so proposals are refused there. Every amendment step offers `refuse` on its questions, its errors-in-a-row question included (`Step.redo`). Proposals come from:
  - a worker's in-scope `.factory-discovery.json` (checked by `workDiscoveryProblem`, as at intake): it is proposed at once as `worker-<item>-<attempt>`, as in the old Factory, and the item waits for the amendment's outcome with no question. `factory decline-discovery N --item ITEM --reason R` is the operator's override while it is pending, until its review is done: the amendment settles as declined (still charged), its planning steps' open questions go, and the item carries on with its result as collected, the reason recorded. Only when intake refuses the proposal (no planning revision left) does the item ask, offering `decline-discovery <reason>` and `cancel`. A backlog discovery is only logged;
  - a merged predecessor's blame answered `amend` (see Predecessor blame);
  - `factory propose-amendment N --file F`, a JSON file with the six discovery fields, checked by the service where it enters and refused with `amendment_refused` naming each problem; there is no comment form.

  The item that proposed starts a new attempt once its amendment is accepted: a repair counted against no allowance (`free`), with its correction saved so no diagnosis runs, moved onto the current start with its change so far replayed. A rejected amendment holds the Objective with `replace <correction>` (a replacement that repeats its discovery, with the rejection as its diagnosis; it charges a revision and is reviewed again), `continue` (the plan runs without it; the item that proposed carries on as if declined) and `cancel`.

- **Result rereview.** `revalidate` says a refused result was correct and Factory's check was at fault. The engine offers it on a Work Item's question wherever the workflow can check a refused result again (work/steps.ts `revalidatable`): on a coding item's work step while its refused result is kept and (for media) its selection stands, while no finished worker run waits for collection and no replay onto a new start is due, and until a work-step question finds it can no longer be checked (gone, off its base, or its selection gone: the refused fact is marked `unrecheckable`), which covers the repair diagnosis question, the repair allowance question and the work step's other questions after a refusal; and on a read-only QA item's question after its review refused. A coding item's work step then finishes with that same result, unchanged, if it still sits on the item's base (else it asks `retry` or cancel), without the worker or collection, and selection, validation, review and delivery run again. A QA item validates and reviews again on the default-branch commit as it is now. It isn't a repair and counts against no repair allowance: it is charged against `resultRereviews` when the answer lands (see Allowances); past the allowance it holds with `more`, which grants as much again and checks the result. A rerun after a crash does the same. `--review-artifacts N` (repeatable) changes what this rereview's validation captures: the configured `reviewArtifacts` selectors numbered N, from 1, or `none` alone; anything else is refused (`invalid_answer`) with the configured list. It goes with `revalidate`, or the `more` that revalidates; past the allowance, that `more` reuses what `revalidate` gave. The numbers are resolved to the selectors when the answer lands, so a restart with a changed configuration captures only those still configured. The choice is kept on the item's result (`rereview`), recorded on its validation result and shown in status, and the next repair, or a repair of the stack layer below, clears it. The plan's own selectors are still checked against the configuration.
- **Retire.** A question about a refusal offers retirements, each with a required reason:
  - `retire <n> <reason>` for each refused criterion n (numbered from 1, as the question lists it) that is a Work Item acceptance criterion, an Objective criterion or a coverage obligation (never an integration question). Offered on the repair diagnosis question after a result review refusal, on the repair-allowance question when a review refusal drives the repairs, and on final review's refusal.
  - `retire-command <n> <reason>` for the command n a validation failed on (its position, from 1, in the sequence that ran). Offered on the repair diagnosis question and the repair-allowance question after an item's validation failure, and on final validation's failure. It never retires a command the installation requires (`finalValidation.requiredCommands`), a readiness probe or preparation command, or a validation's last command; the question names why instead, and an answer that names one anyway holds with the reason.

  A retirement is recorded like an amendment, against the plan accepted then and keyed by the question's id, so a rerun records it once: the step that asked keeps it (work/facts.ts `retired`, `final:retired`, `final-review:retired`), and currentPlan (planning/plan.ts) returns it in the plan's `retired`, where reviews and validation read it. A Work Item's criterion no longer counts for that item or at final review; final review's for the Objective and every item. A Work Item's retired criteria and commands leave the item as its worker, collector and review see it (planning/plan.ts `runnableItem`), so criterion indices agree; its command no longer runs in its validation or its worker's, and an obligation that command proved is judged by the item's review instead (it reads the proof kind); final validation's no longer runs in final validation. After a Work Item's retirement its refused result is checked again unchanged when nothing it was refused on still counts (no repair or rereview is charged), else what still counts is diagnosed. On the repair-allowance question the engine runs the step once past the allowance to record the retirement (`Workflow.unspent`), and a further repair asks for `more` again. After final validation's or final review's, the same head is validated or reviewed again. Final review gets two controller rows: retired criteria, which never count as unmet, and retired commands, which only no longer run (what they proved is still judged on other evidence). The report and status list each with its reason, and for a command the obligations it proved, now judged by review. Only a real check counts as one left: a readiness probe, its preparation or a package bootstrap doesn't. A reset keeps the retirements of a readable saved state.

## Delivery

`delivery.kind` in the installation's configuration picks how Work Items reach the default branch. The service reads it once at start.

- **`regular`** (default): one PR per Work Item, merged with a merge commit once its checks pass.
- **`native-stack`**: each linear chain of the plan is one GitHub native stack. Each layer's PR targets the branch below it, and the top layer's merge step merges the whole stack with one shared merge commit. An item off a chain is an ordinary PR. When the layer below moves (GitHub updates it with the default branch, or it is repaired), GitHub merges its new head into the layer above, with no worker; only a conflict is that layer's repair.
- **Strict protection.** A PR BEHIND the default branch is updated by GitHub (update-branch), not by a worker; a conflict is the item's repair. A repair that only replays the refused change onto a moved base, and applies cleanly, runs no worker either.
- **`accept`.** A stack that merged by other means (layer by layer, or with different merge commits) is a question with `accept`, `retry` and `cancel`. `accept` takes the unit as delivered once every layer is merged at Factory's head with its merge commit on the default branch; otherwise the question names what is missing.
- **Changing it.** A plan is split by the setting it ran with, so a retry never switches it. To deliver an Objective without native stacks: cancel it, set `delivery.kind` to `regular`, restart the service and queue it again.

## Cancel

`/factory cancel`, `factory cancel <issue>`, or the Objective's deadline (see [Deadlines](#deadlines)):

1. Abort the Objective's running steps. This kills the process groups the service started for those steps; it tracks them in memory, and they die with the service anyway.
2. Close every open Factory PR of the Objective (each branch under `factory/<issue>/`, whatever plan made it) with a comment, delete those branches Factory made (see [Idempotence](#idempotence)), close the issue as not planned, and set Status to Cancelled.
3. Mark the state cancelled, recording who cancelled and when (`ended`).
4. Post one closing comment on the issue (github-sync.ts, marker `cancelled:<run>`): who cancelled it, or that its deadline passed. Only a `/factory cancel` comment's author is named (`ended.source: github`); a CLI cancel says "the operator", never the host's user name. A cancelled Objective settles once it is posted, or GitHub refused it (`cancel-comment-given-up`). None for a dequeued run withdrawn before it started, or while `progress.enabled` is false. Crash points: `sync:cancel:before` and `sync:cancel:after`.

Cancel reads only the Objective's state file and its open PRs, so its cost doesn't depend on history. It can't be refused. If closing a PR fails, the close is retried in the background; it never blocks the cancel. An issue GitHub no longer has here (404 or 410: deleted; a redirect, while the repository itself has not moved: transferred away) has nothing to close: the PRs, branches and work files still go, and the Objective settles.

## Run log

Each service run appends to `logs/<issue>/<run id>.jsonl`: step start and end, outcome, durations, one `model-usage` event per model call, errors, and references to capture files. Issue 0 holds the service's own events.

- **Run ids.** A run id is the run's start time and process id (`2026-10-23T04-12-09-125Z-4242`, log.ts `newRunId`): ids sort by start time. The service, its GitHub sync and every Objective share the run's id, so one service run is one file per issue. A `factory dream` call is a run of its own. Readers (`factory log --json`, watch, status) mark each event with `run`, from its file's name.
- **Formal history** (log.ts RunLog). Each run file starts with a `run-header` event: `factoryVersion` (the nearest package.json's version) and `sourceDigest` (sha256 over the running build's JavaScript files). Every line carries `seq`, consecutive per file from 1, so a missing number is a lost line. A write that fails (a full disk) is counted, never retried; the next line that lands is followed by a `log-health` event (`emitted`, `failed`: failed line and capture writes, `lost`: lines). At a clean stop each run file gets `run-end` (`outcome`: `stopped`, or `handed-off` for an Objective still unfinished, which the next run carries on) and a last `log-health`; a `factory dream` run ends `stopped`. A start that finds the last run died appends `run-end` with `outcome: "crashed"` and `detectedBy` (the new run) to the dead run's files of the service and the Objectives it loaded. Step `start`, `outcome` and every event a step logs carry `attemptId` (`<step>#<n>`, the step's nth attempt, counted in the state's `stepRuns`); a `start` carries `parentAttemptId` when it continues another attempt: a continuation (`retry` with `progress`), the repair that sent the step back, or the interrupted attempt it reruns.
- **GitHub transport.** Each sync job's GitHub requests are counted (github.ts `transport`), never their bodies: a `github-call` event per job key, at most once a minute (at once after a failed run, and when its Objective is forgotten), with `runs`, `ms`, `calls`, `retries` (a 401 re-sent with a fresh login, and a run after a failed one), `rateLimited`, `failed` and `bytes` (request bodies and response content-length).
- `factory status` reads the state file plus the end of the log. `status --issue N` (or the issue's URL) takes an Objective's issue or a Work Item issue and shows its Objective, naming the Work Item: it resolves N from local state only (the tracked items), with no GitHub call, and refuses an issue no state names (`no_factory_state`).
- `factory watch [ISSUE]` follows the log like `log --follow` and shows one row per Work Item: its step, its last outcome or hold, and its worker's activity. It reads the log only.
- `factory diagnostics ISSUE` (diagnostics.ts) shows what a run did: a timeline of steps with durations, waits, repairs (with their target), holds (the engine logs a `hold` event with the question's id once saved) and the answers to them, model calls and each step's worker activity, relative to the run's start. `--follow` streams new lines, `--logs ITEM` shows one Work Item's events with their fields, including each validation command's output tail and each model call's capture file; `--show-captures` prints the captured request and response (redacted as stored, and again with the current secrets), and with capture off it says full requests and responses are kept only with `capture.enabled` (see [Content capture](#content-capture)). And `--summary` totals model calls, tokens, cost (when known) and time per role and per phase (a planner call's `phase`, else its step's), with repairs per item, holds and their wait, the observed critical path (walking back from the step that ended last, each time to the step that ended last before it started; the log has no dependency edges) and the slowest steps. The latest run, `--run ID` or `--all-runs`; `--json` in every mode. It streams each run file in chunks and redacts every event as it reads it.
- `factory diagnostics ISSUE --captures` (analysis.ts) lists the run's captured model calls (id, role and phase, item, provider and model, size, path); `--content ID` prints one, from any run, read without following links and redacted again. `--analyze` shows where the time went (steps, retry waits, holds, idle, model calls and validation, each a union so overlaps count once), steps per phase with their outcomes, retries by wait class, continuations, repairs per item and target, holds and their answers, validation commands, worker activity, and the step-attempt history (each start paired with its outcome, failed and unfinished attempts, each run's last lifecycle event); and per group (`--group-by FIELD`, default `phase`; `--filter FIELD=VALUE`, `null` for a missing value; fields `run`, `item`, `phase`, `role`, `provider`, `model`, `effort`, `outcome`, `tokenSource`, `hedge`, `reportedModel`, `stage`, `sessionMode`, `currency`) the model calls' tokens with how many calls reported each count, cache effectiveness (cached over input of the calls that report both), `nativeToolActivity` and `sdkOperations` as separate views, native tool rounds, outputs, failures and time, outcomes with failure stages and semantic refusals, reported models (and calls whose model differs from the one asked for), request bytes by prompt part, distinct prompt, schema and source digests, sessions, time to first token, image outputs, cost currency, hedges and efficiency (time, tokens and cost per call, output tokens per minute). The history adds, per run, its Factory version and source digest, its line count and sequence gaps, its log health and its `run-end`; and the attempts that continue another. GitHub requests are summed from `github-call`. `--gantt` draws each Work Item's steps over time, one lane per item and phase, with waits, holds, model calls and validation commands; `--json` gives each bar's start and end. The engine's `outcome` event carries a retry's `wait` class (`error`, `reset`, `gate`) and `progress: true` for a continuation, which is not a wait.
- `factory diagnostics --scorecard ABSOLUTE_FILE [--json]` (scorecard.ts) compares Factory with codex-direct baselines, the old scorecard's selection format: the file names packets (a task done by one route), each a `factory` packet with `factoryObjectives` or a `codex-direct` packet with `codexSessions`, the private (`0600`) stream of a fresh `codex exec --json` thread with its externally observed times, outcome, role and configuration. A Factory Objective is read from its state (outcome, base, final commit and tree, repairs) and from the runs of its latest admission (model calls, tokens, cost, cache, holds and their waits, first-try planning and delivery; its runs' Factory versions and build digests from their `run-header`, its calls' distinct prompt digests, and `nativeUsage`: calls with a `providerUsage` view and Codex child threads' usage, never added to the tokens); a session from its stream (the latest `turn.completed` usage, which is the thread's total; zero cached or reasoning counts are unknown). It reports per packet, per scope and route, and per `pairId` pair the deltas of time, attempts and tokens, only when both are accepted, bound to the same task, source, base and environment, and a comparison plan is declared. Each Objective reports `N of M runs available`: a run rotated away leaves its counts partial, its first-try verdicts unknown and its pair not comparable. Read-only and redacted. The old optional `nativeCapturePath` (capture metadata of the old format) is refused, and `--output` is replaced by stdout.
- `factory export-captures ISSUE` (capture-export.ts) turns the run's model calls into OpenTelemetry spans (OTLP/HTTP JSON): one root span per `model-usage` event in a trace per run, with its role, phase, provider, model, outcome, item, tokens and cost as `factory.*` attributes, and with `--content retained` the captured request and response (each cut to 512 KiB head and tail). It reads like `--captures`, redacting every event and capture as it reads them and every exported string again. The latest run, `--run ID` or `--all-runs`; `--invocation ID` (repeatable) keeps only those model calls, by the span id or capture id the preview lists, and an id that matches none is refused. By default it is a preview that sends nothing: it prints the counts, batches, endpoint, header names and each selected call (`--json` the same as JSON), and `--output ABSOLUTE_FILE` writes the OTLP requests to a new `0600` file, one per line. With `--endpoint URL` (a base URL, HTTPS or HTTP to a loopback host, no credentials, query or fragment; Factory appends `/v1/traces`) the preview prints a digest that binds the endpoint, the content, the `--invocation` selection, every batch and the headers. `--send --endpoint URL --authorize DIGEST` sends only when the export still has that digest, else refuses with `export_refused`. Headers come from `OTEL_EXPORTER_OTLP_TRACES_HEADERS`, else `OTEL_EXPORTER_OTLP_HEADERS` (comma-separated URL-encoded `key=value`); values are never printed, and a malformed one is refused without echo. Batches are at most 512 spans and 3 MiB; each is one POST with a 30-second timeout, no redirects or retries and a 4 MiB response cap, in order, and the first one not fully acknowledged stops the send (exit 1, with its receipt). Span ids are stable, so a repeat send may duplicate spans at the collector.
- Diagnostics, capture export, accounting, scorecards and analysis read logs. They never write state.
- **Retention.** A run is its log file and its capture directory, kept or deleted together. The service keeps the last 20 runs per Objective and 2 GB in total, deleting the oldest first. It never deletes its own run, or a run whose files changed in the last 10 minutes (a `factory dream` call still running); they still count toward both bounds. Before it deletes a run it appends `{run, lastAt}` to `logs/<issue>/rotated`, so the scorecard can say how many runs are gone (log.ts `rotatedRuns`).

### Model usage

Every model call writes one `model-usage` event when it ends, whatever its outcome: planning, plan and result review, final review, diagnosis, semantic discovery, Dream and every worker run. The shape is the same for Codex, Claude, Copilot and managed workers (providers/usage.ts). A count the provider doesn't report is `null`, never 0. Diagnostics, analysis and the scorecard (wave 5) read this event.

```json
{
  "at": "...",
  "step": "item:a:work",
  "event": "model-usage",
  "role": "worker",
  "provider": "codex",
  "model": "gpt-6.1-sol",
  "effort": "high",
  "item": "a",
  "outcome": "finished",
  "ms": 81234,
  "tokens": {
    "input": 993817,
    "output": 2974,
    "cached": 936192,
    "reasoning": 752,
    "total": 996791
  },
  "tokenSource": "sdk",
  "costUsd": null,
  "sdkOperations": {
    "total": 14,
    "byName": { "command_execution": 11, "file_change": 3 }
  },
  "nativeToolActivity": { "total": 16, "byName": { "exec": 16 } },
  "cacheEffectiveness": { "hitRate": 0.942, "uncachedInput": 57625 },
  "capture": "4f0c..."
}
```

- `role`: `planner`, `reviewer`, `worker`, `discovery` or `dream`. A planner-seam call also has `phase` (`plan`, `graph-review`, `result-review`, `objective-review`, `diagnosis`, `discovery`, `dream`) and `tools` (it could read a tree); a worker has `item`.
- `outcome`: a planner call's `done`, `retry`, `hold`, `fail` or `error` (with `error`); a worker's result kind (`finished`, `retry`, `hold`) or `error`. `ms` is the call's wall time. A hedged second call (planner.ts HedgedPlanner) logs its own event with `hedge: 1`.
- `tokens`: `input` includes `cached`; `output` includes `reasoning`; `total` is input plus output, or the provider's own total when it reports no split (managed workers). Claude and Copilot report no reasoning count; a Claude worker sums its queries, credential retries included.
- `tokenSource` (Codex only): `sdk`, from the SDK's `turn.completed`, or `native`, from Codex's session record when the stream ended before it.
- `costUsd`: list cost when the provider reports it (Claude, Claude managed), else `null`.
- `sdkOperations`: the SDK's own operation items, each item id once across its started, updated and completed events (Codex: command executions, file changes, MCP calls, web searches, to-do lists); `null` where the SDK has no such view (Claude, Copilot, managed).
- `nativeToolActivity`: the model-visible tool calls by name, each call id once (Codex: from its session record, providers/codex-telemetry.ts; Claude: `tool_use` blocks; Copilot: tool executions); `null` where unseen. One call can run many commands. `nativePartial: true` when the Codex record was past its 8 MiB read bound.
- `cacheEffectiveness`: this call's `hitRate` (cached over input, 4 places; `null` with no input) and `uncachedInput` (input minus cached); `null` when either count is unknown. Aggregates weight by input; never average hit rates.
- `callId`: the call's id; a `model-refused` event (or a `diagnosis-rejected` or `discovery-rejected` one) with `stage: "semantic"` names it when Factory's checks refused a well-formed answer.
- `reportedModel`: the model as the provider reported it (Claude's init and messages, Codex's session record, Copilot's usage events, a managed agent's), else `null`.
- `promptDigest`, `schemaDigest`, `sourceDigest`: sha256 of the prompt, of the answer schema (planner calls) and over the source bodies the call was given (a worker's pinned sources, the Objective's sources for planning and plan review); `null` when there is none. `requestBytes`: prompt, schema and images as sent; `promptComponents`: bytes of `prompt`, `schema`, `images`, and `sections`, the prompt's parts as its builder rendered them (the worker prompt, planning and plan review).
- `stage`: where a failed call failed: `provider` (the default), `parse` (an answer that isn't JSON) or `protocol` (an answer that breaks its schema or contract).
- `timeToFirstTokenMs`: from the call's start to its first model output, where the SDK streams (not managed agents, which are polled). `sessionTurn` and `sessionMode`: the turn's ordinal in its provider session and `fresh` or `resumed`.
- `nativeTools`: `rounds` (responses that asked for a tool), `outputs`, `failures` (reported failed), `missingOutputs` and `ms`; with capture on the tool outputs go to the capture file. `imageOutputs`: images the model produced.
- `providerUsage`: the provider's own usage breakdown, numbers only: Claude's `usage` and per-model `modelUsage` (subagents included), Codex's turn usage, its session record's last `token_count` and its child threads' (`descendants`), Copilot's per-model usage (with its `totalNanoAiu` billing units), managed spend.
- `currency`: `USD` beside a known `costUsd`, else `null`.
- `capture`: the id of the call's capture file, only when capture is on and the file was written.
- An adapter adds its own fields: `session` or `thread`, `turns`, `stopReason`, `finalTreeValidated`, managed `key` and `spend`.

**Codex native telemetry.** Each Codex call runs in a private `CODEX_HOME`. Before it is removed, providers/codex-telemetry.ts reads the thread's session record (`sessions/YYYY/MM/DD/rollout-*-<thread>.jsonl`, its last 8 MiB): the last `token_count` gives the thread's counts (reasoning included), and the `function_call`, `custom_tool_call`, `local_shell_call` and `web_search_call` items give `nativeToolActivity`. Unreadable or missing, it adds nothing.

### Content capture

Off by default. With `"capture": {"enabled": true}` in the configuration, the request and response bodies of each model call go to `logs/<issue>/<run id>.captures/<id>.json`, and the call's `model-usage` event names the file by `capture`. Bodies never enter the run log itself.

- A capture file is `{id, run, request, response, tools, truncated}`: the request is the prompt the call sent (a worker's whole prompt), the response its answer or final message, `tools` the native tool outputs in order (`{name, output}`); a call with no answer has no `response`.
- Each body is redacted (log.ts `redact`, with the configuration's secrets), then cut to half of `capture.maxBytesPerCall` (with tool outputs: two fifths each, and a quarter for the outputs together) (default 8 MiB, at least 1 KiB, at most 256 MiB); `truncated` says a body was cut. Redaction is best effort.
- Files are `0600` in a `0700` directory and rotate with their run. A capture that can't be written is skipped; the call and its event are unaffected.
- Capture is operational, never frozen with an Objective: turning it on or off applies from the next service start and changes no run.

### Worker activity

Every worker (Codex, Claude, Copilot, managed) reports what it is doing through one hook, `WorkerInput.activity` (work/worker.ts): a tool started or finished (its name), a file edited (its path), a command run (its command line), a command failed, or a model turn. The adapters write no other per-tool lines. `ActivityLog` writes it to the run log as one event, at most one per Work Item per 5 s: the first report after a quiet interval at once, the rest coalesced, and what is pending when the run ends. The shape is stable: the live status comment and other log readers build on it.

```json
{
  "at": "...",
  "step": "item:a:work",
  "event": "worker-activity",
  "item": "a",
  "counts": {
    "toolsStarted": 4,
    "toolsFinished": 3,
    "edits": 2,
    "commands": 1,
    "commandsFailed": 0,
    "turns": 2
  },
  "tools": ["Edit", "Bash"],
  "paths": ["src/a.ts"],
  "command": "npm test"
}
```

- `counts`: what happened since the previous event; every field is always present. `commandsFailed` counts commands that ended with a non-zero exit, a signal or their time limit (Codex's shell, Claude's Factory shell).
- `tools`: the distinct tools started in that window, at most 8; `paths`: the distinct files edited, relative to the worktree when inside it, at most 8.
- `command`: the last command started in the window, on one line and cut to 200 characters; absent when none ran.
- Every string is redacted (log.ts `redact`, with the configuration's secrets) before it is cut. File contents, tool output and model text are never reported.

### Live status comment

Each Objective run has one live status comment on its issue (progress.ts), posted once and then edited in place. Its marker names the run (`status:<run>`). github-sync.ts writes it as a background job, so it never blocks a step, and a failed write retries with the job's backoff.

- **Body.** The `factory status` model (status.ts `statusOf`), redacted with the configuration's secrets before it is rendered: the phase and the next action, the Work Item table, each running item's worker (active, or quiet for 5 min or more, from its latest `worker-activity` event), waits, open questions with their answers, the decisions taken (planning decisions and step answers), and run details: admission, provider, the frozen configuration's digest and the model calls so far (`model-usage` events, by role, with their reported tokens). Times are UTC ISO, with "N min ago" as of the edit. It lists the first 50 Work Items, 20 questions and the newest 20 decisions, then "+N more" and `factory status N`, and cuts whole lines to stay under the plan comment's size limit. Untrusted text is escaped: inline code takes a fence longer than any backtick run inside (markdown.ts `code`), and prose escapes `<`, `>` and `@` (`prose`); the hold comments use the same helpers.
- **Edits.** At most one per Objective per 60 s, and only when the body's stable part changed, by its hash. The stable part leaves out the ages, the edit time and each worker's last report and counts, so liveness moves only with the 10 min refresh while a step runs. Edits share an installation-wide budget of 300 an hour; over it an edit waits, except the one that shows a finished Objective's final status. The run log is read forward from where the last render stopped, and files last written before the run began are skipped.
- **Settling.** A finished Objective settles only once the comment shows its final status. A lasting refusal (a 4xx that isn't a rate limit), or any other failure three times in a row (a render that keeps throwing), gives the comment up for the run (`statusGivenUp`, logged as `status-given-up`), and it then counts as shown.
- **Questions.** `progress.includeQuestions` (default true) lists the open questions with their answers. False shows only how many are open and `factory status N`; the question comments still post.
- **Off.** `progress.enabled: false` turns off Factory's progress comments: this one, a failure's evidence and the open-question reminder (see [Holds](#holds-and-answers)), the status note and gate reminder (see [Waits](#waits)) and the cancel comment (see [Cancel](#cancel)). Question comments and replies always post, because they are how a question is answered on GitHub. The section is operational, so changing it never holds a started Objective.
- Crash points: `sync:status:before` and `sync:status:after`.

### Work Item issues

Each Work Item of the plan in force (`currentPlan`) gets one display-only issue (tracking.ts): a sub-issue of the Objective, with the `factory:work-item` label, the Objective's priority labels (`P<n>`), `tracking.issueType.workItem` as its native type (default `Task`), a card on the Project the Objective's card is on, blocked-by links that mirror the item's dependencies, and one live comment (marker `item-status:<item>`) showing its phase, PR, repairs and open question. Questions and answers stay on the Objective; the issue never drives anything, and the queue never takes a Work Item issue as an Objective: the Project items query leaves out the `factory:work-item` label, and an issue read by number is skipped when its body starts with Factory's item marker.

- **Roles.** github-roles.ts makes the role labels `factory:objective` and `factory:work-item` once per installation, found by name before one is created, and resolves each role's type against the types the repository offers. It never changes repository settings or creates a type: a type the repository doesn't offer is a setup prerequisite (`factory setup` readiness warns), the run logs `issue-type-missing`, and the issues go without it. Once per run, the first tracking pass gives the Objective issue the `factory:objective` label and `tracking.issueType.objective` (default `Feature`) when it has no type yet (a type someone set is kept), and reads its `P<n>` labels: its items get those labels, and a priority dropped from the Objective is removed from them. These are the only labels Factory adds.
- **Cards.** Each item's issue is added to the Project the Objective's card is on, with no option set, so it never reaches the queue (the items query leaves out the Work Item label). The Project returns the card an issue already has, so a replay adds none. A refused card is logged (`item-card-refused`) and not tried again this run.
- **Written in the background.** github-sync.ts runs one tracking job per Objective on the keyed job runner, with its backoff and deadline: at most once per 60 s while the Objective runs, at once after it ends, and only when the state shows a write is due. What was written (issue numbers, body and comment hashes, links, closed) is kept in `modules.github.tracking`, so an unchanged plan costs no GitHub call, and a lookup (one sub-issue list, not one per item, plus one label list only while a creation isn't recorded) runs only when an item has no issue recorded. A run again of the same Objective keeps the issues recorded by the run before, so it finds them and their links (even one created but never linked), and reopens an issue whose item is planned again once its plan is accepted.
- **Text.** The body is the marker, then the item's goal, acceptance and dependencies; the title is the item's title. Model text is escaped (markdown.ts `prose`, `code`; `[` and `]` too), so nothing in an issue or its comment is hidden but Factory's marker. Everything is redacted on its way to GitHub.
- **Closing.** A merged item's issue closes as completed: the PR body says `Closes #N` once the issue exists, and the job closes it otherwise (a native-stack layer). An item that is skipped, leaves the plan (replan or amendment) or is left when the Objective is cancelled or finishes closes as not planned, its comment first naming why. A finished Objective settles only once every item issue shows its end, or GitHub refused its close (it is never counted closed).
- **Refusals.** A native type the repository refuses is logged (`item-issue-untyped`) and not tried again this run. A refusal of a write to one item's issue (deleted, locked, transferred; a 4xx that isn't a rate limit) is kept on that item (`item-issue-refused`): its other writes stop for the run, its close is still tried, and every other item's issue is still written and closed. Only a refusal of the Objective-wide calls (the lists, a create: issues off, no access, repository gone), or three other failures in a row, gives tracking up for the run (`tracking-given-up`); it then counts as shown.
- **Off.** `tracking.enabled: false` creates nothing. Like `progress`, the section is operational.
- Crash points: `sync:item-issue:<create|edit|label|card|link|comment|reopen|close>:<before|after>`, `sync:objective-role:<before|after>` and `sync:roles:label:<before|after>`.

## Capabilities

A capability is a module that plugs into one of these seams:

| Seam               | Used by                                                             | Examples                                                                                              |
| ------------------ | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `Planner`          | plan, plan review, result and final review, repair diagnosis, Dream | Codex, Claude and Copilot; a review is a call in the `reviewer` role (providers/planner.ts)           |
| `Worker`           | the work step                                                       | Codex, Claude, Copilot local; OpenAI Agents, Claude Managed Agents (parked: not live-qualified)       |
| `Delivery`         | publish, ci, merge                                                  | regular PRs, native linear stacks, LFS assets                                                         |
| `Planning options` | the plan step                                                       | discovery, adaptive workflow, recipes, quality checkpoint, package-manager update, splits, amendments |
| `Knowledge`        | plan and work prompts, and review                                   | curated playbook, repository memory, Dream proposals, peers' notes                                    |
| `Observers`        | the run log                                                         | diagnostics, accounting, scorecard, capture export                                                    |

`Planner` (providers/planner.ts) and `Worker` (work/worker.ts) are interfaces with one adapter per provider; a custom adapter is a new `Worker` in providers/, not a runtime registration. The other seams are modules.

Rules for modules:

- A module returns step outcomes. It never writes state directly, takes a lock, starts a background loop, or keeps its own archive.
- A step keeps its result in `done` and what must outlive a repair in `kept`, under its own step or item keys (work/facts.ts). Only the GitHub sync keeps module data (`modules.github`). Large bodies go in the run log.
- A module validates its input once, where the input enters, and doesn't re-verify it later.
- **Configuration** is checked once, when it loads, by one helper (checked.ts `section`): each section lists its known keys with their types and defaults. An unknown key is refused by name, and a key an earlier configuration used names what replaced it. All problems are reported in one message. The sections are `repository`, `checkout`, `queue`, `providers` and `defaultProvider` (providers/config.ts), `planning` (with `planning.context`, knowledge/settings.ts), `execution`, `policy`, `validation`, `finalValidation`, `delivery`, `reviewArtifacts`, `sandbox` and `media`. The configuration file, the state directory and `policy.secretlintConfig` must lie outside the target checkout, and the configuration must not name Factory's own repository.

Review and knowledge see what the worker saw:

- **Review inputs.** Result review and final review get a controller input receipt for each item: every read-only input its worker got (source assets and bound selections) with kind, path, visibility, media type, size and sha256, and Factory's digest-checked copy under `inputs/` in the evidence root, within the candidate copy bounds.
- **Peers' notes.** A worker gets the advisory notes of accepted earlier items it depends on, that name it as a consumer or that touch its owned paths (planning/schedule.ts `peerNotes`), with each cited path in its checkout or staged read-only. Result review gets those notes beside the item's own, and final review every accepted item's notes (`objectiveNotes`; review/result.ts `knowledgeRows`), each cited path compared with the reviewed commit.
- **Worker Validate.** A Claude or Copilot worker can run the item's declared validation commands itself before it hands off (work/self-validate.ts, one implementation for both; Copilot serves it as the tool `run_validation`): on a snapshot commit in a fresh checkout, through the sandbox. It is the worker's check only: the validate step still runs every command.
- **Best effort for the lifecycle.** Admission, withdrawal and retirement never open the knowledge store, so a store that can't open or is slow (no `node:sqlite`, a corrupt or unwritable database) never holds them back. A run's end (its records, its episode once terminal, and the release of its playbook pin) is its settled observation: for a run that settles, or that a re-queue or a withdrawal replaces, one that hasn't landed is kept and retried in the background with backoff, and logged: an episode may be recorded late, but the queue never waits. Each is saved as `finished/<issue>@<run>.observe.json` (before the state file moves, for a retirement) and removed once it lands, and startup lists and retries these files, so a restart never loses one.
- **Bounded store.** The store keeps the newest 1,000 episodes and the newest 10,000 other memory records; a write past either cap drops the oldest. Dream reads the newest episodes first and planning bounds what it shows, so neither reaches the dropped ones. An episode a Dream approval still checks stays past the cap: every episode given to the newest playbook, to an undecided proposal, or to a Dream call still running within its deadline.
- **Repository memory** shows a record that cites any path inside the planning selectors, with only its admitted paths; its staleness still comes from every cited file's digest, and a changed file outside the selectors is counted, not named. A reference record carries its Source's text, so it needs every path admitted. An episode counts a native stack's lower layer as merged when the stack merged.
- **Memory in every role.** Planning, the worker, the repair diagnosis, result review and final review read repository memory through one query (memory.ts queryMemory): a role, the paths it works on and a byte bound per role (knowledge/index.ts roleMemory), only for an Objective whose Adaptive workflow is enabled on an installation whose planning context turns `memory` on. The worker and its result review ask the same query, so review sees what the worker saw. Memory is a header that frames it as advisory data, never instructions, then the records as one JSON array, the whole text within the role's byte bound. Review gets it as an incomplete `memory` row: it never supports a pass, and a finding that cites only it is invalid. The read is one read transaction; a store that can't be read, or is busy past a second, gives empty memory and a log line, never a hold.
- **Planner lookups.** For the same Objectives, the planner (and the amendment planner) may answer with context lookups instead of a plan, on every provider: a memory search (the same query, memoryLookup), a tracked file or one of its sections, or the tracked paths under a prefix, all read-only at the base and inside the planning selectors (planning/lookup.ts). Factory answers them in a structured turn, keeps the round in `state.kept` with the base and issue digest it was answered for (a re-read that moved either starts fresh) until the step is done or replanned, and asks again with every answer, so a crash re-asks only the planner call. The frozen `planning.context.bounds` cap it: rounds at min(`maxRounds`, `maxProviderCalls`), `maxRequestsPerRound` requests a round and `maxBytes` of answers per step. A request past them, outside the selectors or with traversal is refused to the planner with its reason (requests past the per-round cap as one entry, echoed fields cut to 256 characters); answers are redacted of secret values and framed as data.
- Provider APIs stay inside their adapter.

## Security

These carry over unchanged:

- Credentials stay with the service. Workers never see them.
- Workers run in the OS sandbox with the configured network policy.
- Secrets are named by reference. The configuration derives the secret values once: those named in `policy.allowedSecretNames` and each managed provider's credential (`apiKeyEnv`, `credentialEnv`, from the environment or a service credential). Everything Factory writes to GitHub, Dream input and the Codex worker's reported commands and errors are redacted of them. Only the named ones reach a worker's environment.
- Deploys stay in the target's own GitHub Actions, behind environment approvals.

Added after the 2026-10-23 security review:

- **Issue bodies.** Factory reads an Objective from GitHub's rendering of the issue (`body_html`, read with the body, full+json), never from its Markdown; nothing GitHub doesn't show reaches a model or a check. shown.ts parses it once with a real HTML parser (hast-util-from-html) and gives two views of the shown tree. **Structure** (`blocks`) comes from the elements: sections are GitHub's headings (`h1`–`h6`, text content, a `<br>` read as a space), bullets are its `li` elements, Goal and other prose are paragraph text, and backticked commands, paths and pins are `code` elements. Every check reads it: Goal, Acceptance (a list item that is exactly one code element is a final command, carried on its coverage obligation as `source.command`; a paragraph, quote, struck or bold code span or math is never one), Sources, and the Package manager update, Quality checkpoint, Workspace package additions and Adaptive workflow declarations (objective.ts checkObjective, validate.ts declarationProblems); so does command authority from the Objective (its shown lines and inline code elements). Shown text is text with its emphasis markers: strong is written `__text__`, emphasis `_text_` and struck text `~~text~~`, so an unbackticked path reads as written (`src/_internal.ts`, `pkg/__init__.py`, `src/__tests__/a.ts`, `docs/A&B.md`; a `**` or `*` in a path comes back as `__` or `_`, so backtick it), a heading anchor keeps its markers (Sources heading matching treats `*` and `_` as one marker, so `#Step *y*` finds `Step *y*` or `Step _y_`), and a struck criterion stays visibly struck. A writer's inline math is text (`$…$`), never code. A paragraph line that reads ``- `cmd` `` is never a bullet. A blank issue-form field (`<p><em>No response</em></p>`) is an empty entry. **The planner text** (`body`) is the same tree as GFM Markdown (hast-util-to-mdast, mdast-util-to-markdown, default escapes): prose for a model, never parsed. Both keep text, headings, lists and task lists, tables, code blocks and links as their text plus href; an image or video is `[image: <file name>]`, a diagram other than mermaid `[<type> diagram]`. An approver sees only a diagram's drawing, so mermaid and math sources stay as code only when the author can write; a non-writer's mermaid diagram is `[mermaid diagram]`and each math block`[math]`. Every other attribute (alt, title, data-*), every comment, invisible characters and whatever GitHub's sanitizer removed are gone. Footnotes stay as GitHub's rendered section. Factory's own split-child marker is read from the raw body by its exact pattern, as structure, never as text. A non-empty body without `body_html` is a transient error and retries; the raw body never stands in. Edit detection (planning and build) and the author approval compare one digest of the structure and the planner text (shownDigest), stable between reads. When the issue's author has no write access, the check holds once: approve or cancel; the question names the digest and says diagram and math sources aren't planner input. The approval is kept against that digest, so any later edit asks again. Until then nothing in the body counts. Queue consent stays the Project field.
- **Write access** (`/factory` answers, issue authors) is asked of GitHub again after 10 minutes.
- **No redirects.** The GitHub client never follows a redirect (`redirect: "manual"`). GitHub redirects an issue transferred to another repository, and a renamed repository; following would act outside the configured repository (a PATCH keeps its method and body on a 301). A redirect is an answer, and a 301 under the repository is first told apart from a moved repository by its identity: `GET /repos/{owner}/{repo}`, never redirected, read at service start and on every such 301; a 301 there, or a GraphQL `repository { nameWithOwner }` (the queue, the re-run's Status move) that differs from the configuration, means the repository was renamed or transferred. Then no issue is gone: the client refuses every request, the service runs no step and no sync job (no card, comment, reply, close, push or merge) and settles nothing, steps keep their state, `status` shows "repository <old> is now <new>; update the configuration's repository and restart", and the run log says so once; after that fix and a restart, everything resumes. While the repository still answers under its configured name, an issue redirected away is gone: cancel cleanup and the sync count it as gone, and any other step holds with `cancel` (recommended) and `retry`, naming the move. Reads that resolve an issue by number over GraphQL check its repository and number. An Actions job log, which GitHub serves from a signed storage link, is read from that link without Factory's login and with no further redirect.
- **GitHub attachments** are fetched with the service's token sent only to the attachment URL. Redirects may go to github.com, `*.githubusercontent.com` and GitHub's own S3 buckets for user, repository and release files, by exact bucket name; any other host is refused. The size bound and the digest apply wherever the bytes come from.
- **Local source assets** come only from directories listed in `media.localAssetRoots` (empty by default: off), by real path, and never from anything the sandbox seals: HOME as a whole, logins, Factory's config and state, runtime sockets or shared temporary directories. The plan check and the copy both check.
- **Pushed content.** Before publish pushes, every blob the result adds or changes, and every LFS object it uploads, is searched for the secret values, as written and base64: each whole value of 8 or more characters, and the pieces of a multi-line secret that are key material (16 or more characters, high entropy, never PEM armor or lowercase JSON keys and URLs). Redaction still hides values from 4 characters. A match pushes nothing and holds with `repair`, `publish` and `cancel`. `publish` lets exactly that finding on that commit through: its digest is kept when the hold is raised and the answer is checked against that, never against the question's text, which quotes worker-chosen paths.
- **Workers.** A Claude worker never loads project or local settings (their hooks would run on the host). A Codex worker's shell gets proxy URLs without credentials (a URL without a scheme is read as http://, and one that doesn't parse is left out), or none when it has no network. A managed worker's archive is read without following links.
- **Origin binding.** Every remote Git call (fetch, push, ls-remote, `remote set-head`, LFS transfer) first passes one origin check (git.ts `originBound`; `remoteGit` wraps it, and delivery and media call it before their call's `try`), which checks that origin's fetch and push URLs, after insteadOf, name the configured repository and that LFS uses origin's default route. A changed origin fetches and pushes nothing: the step holds for the whole Objective with the fix.
- **Not on itself.** Factory refuses its own repository, by name or by a checkout in a Factory clone, checked at the checkout and at its Git top level (read from Factory's own package.json): the configuration doesn't load, so setup and the service refuse, and the check at admission holds.
- **Factory's branches.** A web-flow merge counts as Factory's only when its first parent is Factory's head, its second is on the PR's base, and its tree is what `git merge-tree` makes of the two.

A same-user process is trusted, as decided for the archive: it can already change Factory's code and credentials.

## Lean code

Code is judged by how well it does the job, not by its size.

- **One implementation per job.** No duplicated helpers, and no two ways of doing the same thing.
- **No dead code.** Code that nothing calls is deleted.
- **Tests prove behavior.** A test proves a stability rule or real behavior. There are no unit tests of private helpers.

Every milestone ends with a sweep for duplication, dead code and unneeded tests.

## Testing

No mocks, fake services, fake providers or scripted responses.

- **Crash points.** Product code calls `crashPoint("<step>:<moment>")` at each step boundary, before and after each outside effect and after each save. When `FACTORY_CRASH_AT` names that point, the process sends itself SIGKILL. It is a no-op otherwise. `FACTORY_COMMENT_LIMIT` (tests only, off by default; 1,000 to 65,000 characters) lowers the comment size limit, so a small plan's data goes in continuation comments and the `plan:data:*` points are reached.
- **CI** runs the real `factory serve` on real Git repositories and files for everything that needs no GitHub or model: state saves, step order, restart at every crash point, request files, cancel, deadlines, log rotation.
- **Drill.** At each milestone, a small real Objective runs on a scratch GitHub repository with real providers. The drill kills the service at every crash point and restarts it. It also cuts the network for a minute and stops a model mid-turn. It passes when the Objective finishes with no duplicate PR, comment or merge, and every hold had an answer that worked.

## Setup

`factory setup --repo OWNER/NAME [options]` writes the configuration file (mode 0600) and checks it the same way the service does. Then it checks the target: the checkout exists and its origin names the repository, and the queue's Project has the `queue.field` single-select field with every option, plus the `queue.orderField` number field. Factory never creates either field.

- **Create:** give `--checkout PATH` and `--project-id PVT_...`. Every other key has a default.
- **Repeat:** the same command changes nothing and reports `changed: []`. Without a service mode, setup is `--config-only` (accepted, not required).
- **Bindings:** `--checkout`, `--project-id`, `--field` and `--order-field` never change an existing value, defaults included. A different value is refused, because it would move running Objectives to another target. Edit the file by hand when nothing runs.
- **Refusal:** a value the configuration refuses leaves the file as it was. The report names every problem.
- **Report:** `--json` prints `{status, config, created, changed, defaultProvider, problems, readiness}`. `status` is `configured` (exit 0), `blocked` (the file is saved but the target isn't ready, or a readiness check is blocked; exit 1) or `refused` (nothing saved; exit 1).

**Readiness** (readiness.ts) is one checklist, made with no model call and no change to the target or its settings (the Codex probe writes only its own temporary directories). Each check is `ok`, `warn` (it runs, but see the detail) or `blocked` (the service would hold on it), and every check that isn't `ok` names its fix.

- **Host:**
  - bubblewrap starts a sandbox, and with `package-install`, pasta is there;
  - `sandbox.environment` paths are covered, and `sandbox.packageStore` is a directory;
  - git, git lfs, node and each final command's program are on the PATH;
  - a final command that needs the network is flagged.
- **Providers:** each planner's and worker's SDK is installed and its login is present. Account access is first known at the first call. A Codex worker's sandbox is tried under the worker's own permission profile, with `codex sandbox` and no model: a command must write its worktree and be refused outside it.
- **Repository:**
  - the GitHub CLI login can read the repository and push to it;
  - PRs into the default branch may merge with a merge commit;
  - required status checks exist.
- **Branch protection:** setup recommends "require branches to be up to date", and Factory never changes repository settings.
- **Validation environment:** `readiness.validationEnvironment` says how validation differs from hosted CI: the network, the sandbox, the bootstrap install, `sandbox.environment`'s names, the final and CI-only commands, and the package scripts that need a network validation lacks.

Installation options, each setting one key:

| Option                                                                                         | Key                                              |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `--poll-seconds`, `--max-active`                                                               | `queue.pollSeconds`, `queue.maxActiveObjectives` |
| `--concurrency`, `--workers`, `--validations`, `--planners`, `--memory-mib`                    | `execution.*` (`memoryMiB`)                      |
| `--worker-mib`, `--validation-mib`, `--planner-mib`                                            | `execution.reservations.*`                       |
| `--planning-revisions`, `--implementation-repairs`, `--per-path-repairs`, `--result-rereviews` | `autonomy.allowances.*`                          |
| `--required-env NAME`...                                                                       | `autonomy.requiredEnvironment`                   |
| `--delivery regular\|native-stack`                                                             | `delivery.kind`                                  |
| `--sandbox-network off\|package-install`, `--package-store DIR`                                | `sandbox.network`, `sandbox.packageStore`        |
| `--read-only-path DIR`..., `--sandbox-env NAME=VALUE`...                                       | `sandbox.readOnlyPaths`, `sandbox.environment`   |
| `--required-command CMD`..., `--ci-only-command CMD`...                                        | `finalValidation.*`                              |
| `--allowed-secret NAME`...                                                                     | `policy.allowedSecretNames`                      |

An option marked `...` repeats, and the values given replace the whole list.

Provider options need `--provider NAME`. They add the provider or change it:

- `--planner codex|claude|copilot` and `--worker codex|claude|copilot`. Changing a kind drops that kind's settings.
- `--default`. The first provider is the default until `--default` moves it.
- Model choices: `--planner-model`, `--planner-effort`, `--reviewer-model` and `--reviewer-effort`.
- Codex worker settings: `--codex-network`, `--codex-model`, `--codex-effort` and `--codex-service-tier`.
- Claude worker settings: `--claude-model`, `--claude-effort`, `--claude-max-turns`, `--claude-tools`, `--claude-allowed-tools`, `--claude-permission-mode` and `--claude-setting-sources`.
- Copilot worker settings: `--copilot-model`, `--copilot-effort` and `--copilot-tools`.

Tool and source lists are comma-separated. A worker option for another worker kind is refused. Managed workers and `sandbox.required: false` are written by hand.

### Background service

The service runs as a systemd user unit (systemd.ts), one per installation. Each mode takes `--repo` and `--json`.

- **`--background`:** setup as above. Only once its status is `configured` does it write the unit and enable and start it, then wait up to 30 s for the service to take its lock.
  - The unit runs this Factory's `node cli.js serve --repo`. It carries the setup shell's PATH, HOME, `FACTORY_CONFIG`, `FACTORY_STATE_DIR`, login locations and proxies.
  - It restarts on failure, except on exit 2 (usage) and 78 (a configuration that doesn't load).
  - `KillMode=mixed`: the service stops at its next tick, and then its children are killed.
  - Repeated with nothing changed, it leaves the running service alone. The service reads its configuration and credentials once, so it restarts when the unit changed (an upgrade, or a changed environment or credential list), when setup changed the configuration, or when `--credential-file` is given.
  - A service that exits or restarts before taking its lock blocks `--background` and names the journal.
- **`--credential-file NAME=FILE`...** (with `--background`): each is a LoadCredential. NAME is one Factory reads from the service's credentials: `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, or a managed worker's credential variable. FILE is an absolute path to a regular file, not a link, that only its owner can read, in a directory no one else can write. Setup never reads it, and readiness counts it as present. Without the option, the unit keeps its credentials, which are checked again.
- **`--check`:** the unit's enabled and active state, whether the service holds its lock, the credential names, and whether the unit is current. Exit 0 only when it is running.
- **`--stop`:** stop the service and disable it, so it doesn't start at the next login. `--background` starts it again.
- **`--uninstall`:** stop the service and remove its unit. The configuration and state stay.

Setup never touches a unit it didn't write: its first line is Factory's marker. A `factory serve` that's already running outside the unit blocks `--background`. Lingering off is a warning, because the service then stops at logout.

**An unconfigured serve is visible.** Without a configuration file, serve applies requests only:

- it logs `unconfigured`;
- it prints the path;
- `status` shows the problem.

A configuration that doesn't load prints its problems without a stack trace and exits 78.

## Migration

From the old Factory to this core: start clean, with no compatibility layer and no importer. The configuration is about 40 lines, and the setup options cover it.

1. **Stop the old service** (`systemctl --user disable --now <old unit>`). Close or cancel the Objectives it was running.
2. **Delete the old state and configuration**, after copying anything you still need from the old configuration by hand (paths such as `sandbox.readOnlyPaths`). Old keys are refused by name, each with what replaced it, so a copied old configuration won't load.
3. **Install the core release** (README#Install). `factory help` lists `serve`, `setup`, `run`, `status`, `queue`, `log` and `reset`.
4. **Prepare the target:**
   - a clone that only Factory uses;
   - the Project fields `Factory` (single select, with the seven options) and `Factory order` (number);
   - removal of the old control card and metadata field, which nothing reads now.
5. **Set up** (see [Setup](#setup)):
   - `factory setup --repo OWNER/NAME --checkout … --project-id …` with your limits, delivery, sandbox and final commands, until it reports `configured`;
   - `--provider NAME …` for each provider;
   - optionally, turn on "require branches to be up to date" as readiness recommends.
6. **Start the service** with `factory setup --repo OWNER/NAME --background`, then queue one small Objective as a canary. It passes when its PRs merge with no duplicate PR, comment or merge, every hold had an answer that worked, and the issue closes with its report.
7. **Queue the rest.**

Rollback: `factory setup --uninstall`, then reinstall the old release and set it up from scratch: its state was deleted, so there is none to carry back.
