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
- **Work Item:** one unit of work, delivered as one PR.
- **Step:** one unit of progress, such as "plan", "run the worker for item 3" or "merge item 3".
- **Hold:** a step that needs a person. It's a question posted on the issue. A Work Item's hold stops only that item and the items that depend on it; a hold about the whole Objective stops every step.
- **Run log:** an append-only record of what happened, for status and analysis. It never drives progress.

## Process model

There is one process, `factory serve`, per installation, run by systemd. It is the only writer of state.

- **Lock.** `serve` binds a Linux abstract socket named for the installation. The kernel releases it when the process dies, so there are no owner records, PID proofs or handoffs. A second `serve` exits at once with "already running".
- **The lock is per network namespace.** A host CLI asks whether the service runs by connecting to that socket, and abstract sockets belong to a network namespace. So the CLI can't see a service inside another one (a container, `pasta`, `unshare --net`): it says "isn't running", and its request file still applies, because files are shared. Run the CLI in the service's namespace to see it.
- **CLI.** Commands that read (`status`, `log`, `dream --show`, `dream --preview`) read the state files, or the knowledge store read-only, directly. Commands that change something (`answer`, `cancel`, `retry`, `reset`, `pause`, `drain`, `resume`, `queue`, and `dream`'s writes) write one request file to `requests/`. A refusal prints `{"kind":"lifecycle-refusal","code":"..."}` on stderr with a stable code, then the message. The service picks it up within a second and deletes it when the request is applied. If the service isn't running, the request waits there and the CLI says so; a `dream` write is refused instead (`service_not_running`), before any model call.
- **Dream.** `factory dream` reads the store and makes its model call in the CLI, so the service's loop never waits on a model; the call's start and end (with its proposal), `--record` (whose records the CLI reads from Git) and an approval or rejection reach the service as requests, which it applies to the store (knowledge/dream.ts applyDream). Each applies again harmlessly after a crash; a refusal is `dream_refused`.
- **`factory run N`** queues one Objective and follows it to the end, with the old exit codes. The service does the work, so there is only one code path.
- **One installation per repository.** Two machines serving one queue are not supported.
- **Upgrade.** Stop the service, install, start. Restart is the normal recovery path, so an upgrade needs nothing more.

## State

Each Objective has one JSON file: `objectives/<issue>.json` under the installation's state directory. Once a finished Objective's cleanup and final sync are done and no observation of it is in flight, the file moves to `objectives/finished/<issue>.json`. Startup never reads the finished states (rule 6); it reads only `finished/*.observe.json`, the settled observations that haven't landed (see Capabilities). A request, a re-queue or `status` reads a file there when it names the Objective, and a later save writes the active file again until it moves back.

```jsonc
{
  "version": 4,
  "issue": 123,
  "status": "checking | planning | building | finishing | holding | resetting | done | cancelled",
  "base": "<default-branch SHA the plan was made against>",
  "plan": { "items": [/* id, title, contract, owned paths, deps, commands */] },
  "items": {
    "<id>": {
      "step": "waiting | working | validating | reviewing | delivering | merged | failed | skipped",
      "attempt": 1,
      "branch": "factory/123/<id>",
      "pr": 456,
      "repairs": 0,
      "lastError": null,
    },
  },
  "frozen": { "provider", "selectedBy", "digest", "config": {/* see Frozen configuration */} },
  "holds": [], // open questions, oldest first: { "id", "step", "item"?, "question", "answers": [...], "recommended", "cause", "needsText"?, "askedAt" }
  // each hold also has "shownAt" (its comment's GitHub time) and "shortForm" once posted
  "lastShownAt": "<latest GitHub time any question's comment was shown>",
  "retries": { "<step key>": { "count": 2, "nextAt": "<time>", "wait"?: { "kind": "error | reset | gate" } } },
  "asking": { "<step key>": { "question", "answers": [...], "recommended", "scope"? } }, // saved questions, asked before the step runs
  "modules": {/* per-capability state, see Capabilities */},
  "ended": { "at": "<first save at a terminal status>", "by": "<who cancelled>" },
}
```

- **Saved after every step**, by writing a temporary file, calling `fsync`, then renaming it. A crash leaves either the old file or the new one.
- **Trusted.** The state belongs to the installation's user, as do Factory's code and credentials. There are no digests, seals, witnesses or tamper checks.
- **Small.** Large bodies (prompts, worker transcripts, review packets) go in the run log directory, never in state.
- **Rebuildable.** `factory reset N` rebuilds the state from GitHub: the plan comment (and its `plan-data` continuations), the PRs whose head is a Work Item branch, and the report comment. It's how a corrupt file, an incompatible version or a new machine is recovered. The service saves a resetting record at once (status `resetting`; the old state kept inside it), and one step, `rebuild`, reads GitHub and replaces the record with the rebuilt state, so its deadline, retries and questions are the engine's and cancel (either form) replaces it at once. The old run's steps are stopped, and the rebuild starts only once they have ended (each by its deadline at the latest), so an effect already in flight (a merge) can't land after the rebuild read GitHub. A reset that replaces a run still waiting this way waits for the same steps, and a dequeue meanwhile withdraws only once they have ended; a cancel meanwhile doesn't wait. What it finds is bound to the current run and plan: only comments by Factory's own login count; the plan data only from Factory's own data block at the end of the plan comment, or the continuations it names (anything else refuses with `plan_unreadable`); a PR counts only if it was opened after the plan comment was last written and names no other run (Factory marks its run in its PR bodies and its report marker; the newest wins); the report only if it is newer than the plan comment; and the plan comment only if the old state, when readable, had accepted a plan. Merged items stay merged; every other item starts fresh on the current start. The operator's pause or drain, a provider switch, the card and the comment cursor carry over. A reset with no state, plan comment or card is refused (`no_factory_state`), and one that would create an Objective follows the queue's mode (`queue_not_running`). A refused reset restores the old state; the request is answered when the rebuild lands.
- **One version.** If the file's version isn't the current one, or it doesn't parse, the Objective holds with the answers `reset` and `cancel`. The hold is posted on the issue and shown as "Needs you" like any other, and `/factory reset` or `/factory cancel` answers it. The question belongs to one incident: its marker names the unreadable file's digest, and only comments created after that question count, so an earlier incident's question and its `/factory cancel` never act on a later one. Nothing overwrites the file except that answer. There are no migrations. The version 5 state (one `refused` and one `diagnosis` fact per Work Item; 4 brought a hold's cause, the error wait class and the `ended` record; 3 one `frozen` configuration) makes every earlier file unreadable; `reset` rebuilds it. A read that fails for a moment (EMFILE, EIO) is tried again every tick, never taken as unreadable.

### Frozen configuration

An Objective runs on the configuration it was admitted with. `frozen` holds its provider (and what chose it: `defaultProvider`, `--provider` or `switch`), the effective configuration and that configuration's SHA-256 `digest`. The configuration is frozen whole, with every adapter default filled in (selection.ts `resolvedProvider`, which the planner and worker are built from too), less an explicit list of operational keys (providers/selection.ts `OPERATIONAL`), never an allow-list, so a key added later is frozen too. The Objective's own provider's settings stand in for `providers` and `defaultProvider`, which only choose a new Objective's provider.

- **Operational keys** may change under a running Objective: they operate the host or present the run, never decide the work. They are the derived secret values (never written to state), `queue` (polling, slots, the Project fields), `execution.concurrency`, `execution.workers`, `execution.validations`, `sandbox.limits`, `sandbox.packageStore`, `reviewArtifacts`, `validation.commandTimeoutSeconds`, and a worker's `timeoutSeconds`, `idleSeconds` and `settings.maxTurns`.
- **A change holds once.** The service reads its configuration at start. When it differs from an Objective's frozen configuration in any other key, the Objective holds, and the question names the changed keys and both digests. `adopt` freezes the configuration as it is now and continues; `switch NAME` freezes it on another configured provider; `cancel` ends it. To keep the frozen values, restore them, restart the service and answer `adopt`. `adopt` freezes only the configuration its question named: after a further change and restart it is refused (`stale_question`) and the question is asked again with the current changes. A frozen provider the configuration no longer names offers `switch NAME`, `retry` (after restoring it and restarting) and `cancel`.
- `status` shows the provider, `selectedBy` and the digest.

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
check → plan → plan review → [hold: plan question?]
  → per Work Item, in dependency order:
      prepare → work → validate → review → deliver (push, PR) → wait for CI → merge
  → final validation → final review → report → done
```

Every step returns exactly one outcome:

| Outcome                 | Meaning                                                                                            | What the core does                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `done(data)`            | The step finished.                                                                                 | Save the data and move on.                                                                             |
| `retry(reason, after?)` | A wait classed by its cause, an error among them (see [Waits](#waits)).                            | Back off (30 s doubling to 15 min, or the reset time) and run the step again.                          |
| `repair(finding)`       | The work is wrong: validation, review or CI failed.                                                | Run the item's work step again with the finding, until the repair budget is spent.                     |
| `hold(question)`        | Only a person can decide (cause `question`), or the step can't succeed as it is (cause `failure`). | Post the question on the issue, set Status to "Needs you", and wait (see [Holds](#holds-and-answers)). |

A failure is a hold with the cause `failure`: errors in a row, a repair budget spent, a crash-loop suspect, a call too large for the model, or a result the step can't produce. Where the workflow can plan again (a planning round before acceptance; a Work Item, final, final review or report step after it), the engine adds `replan` to its answers.

A step that kept its progress and goes on at once (captured media to collect, a staged repair, one rerun of a flaky command, an approval or an accepted edit) returns `retry` with `progress`: that is not a wait, so it ends the step's run of retries and no status note or wait clock counts it. A repair consumes the answer of the step that returned it, so the step never acts on that answer again. Past the repair budget, the step that would repair asks before it runs again; `retry` lets that repair run.

`replan` is the workflow's, never a step's: the engine applies it from one place (`Workflow.replan`) instead of running the step that asked. Before the plan is accepted it records the operator's decision on the planning round, and a new planning generation re-reads the issue. After acceptance it forgets the plan and the build and checks the Objective again (a repair of `check` whose cleared steps' repair history goes with them). A replan never counts against a repair budget, `check`'s included, and the answer is spent once applied.

An exception that escapes a step is classified in one place (workflow.ts `errorOutcome`, called from the engine's catch): a full disk and the checkout's Git refusal (an origin that no longer names the target) hold for the whole Objective, a provider's classified failure and GitHub's answers map as [Waits](#waits) says, and anything else is an error, as are a missed deadline, an idle model and an invalid model answer. After three errors in a row on the same step, it becomes a failure hold: the error, plus `retry` and `cancel`. Cleanup after cancel never asks (a step flag): any outcome but done, a Git refusal included, retries in the background. A step can't crash the service, block another Objective, or leave an Objective without an answer that works.

### Interrupted steps

A step the service's death cut off (a crash, an OOM kill, a reboot) is not that step's error. Each saved attempt names the service run that started it, and after a restart the step runs again at once, with no backoff and no error count, cleanup after cancel included. Crash-loop protection is the service's:

- **Crash loop.** `service.json` keeps the starts of the current crash streak: a start continues it when the run before died, without a clean stop, within 10 min of resuming its steps. From the third start in a streak, interrupted steps resume after 30 s, doubling to 30 min; other steps run as usual. `factory status` shows the deaths in a row and the resume time. A clean stop ends the streak.
- **A step that kills the service.** `service.json` also keeps the last three deaths: the steps running at each (the open attempts that run started), and whether that run finished any step (its heartbeat count, or an Objective's state saved with a step's outcome naming that run, so a death right after a step still counts). When steps finished in the runs between them, every step that was running at all three holds, each with its own question: "The service died 3 times in a row while step … ran", with `retry` and `cancel` (a second question in the same scope is saved and asked after the first). So a crash streak ends in questions within three deaths however many steps keep being interrupted together. The evidence is then spent, so another hold needs three more deaths. Cleanup after cancel never holds; the crash loop's delay covers it.

### Waits

Any other retry is a wait. Waiting more than a few hours is never right, so a wait is classed by its cause, not by how long it has gone on:

| Cause                            | Examples                                                                                                                                                                                                                | What the core does                                                                                                                                                                                                                                                                                           |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Fatal until a person acts        | An expired or invalid gh or provider login; GitHub 401 or a 403 refusal; a missing repository or issue (404); a full disk; a required check with no run or status 15 min after the push; a workflow that didn't trigger | Hold at once, with a question naming the fix.                                                                                                                                                                                                                                                                |
| A known reset time               | A GitHub rate limit; a provider usage limit that reports its reset                                                                                                                                                      | Wait until the reset when it is at most 3 h away. Further away or unknown (a weekly limit): hold with `wait` (keep waiting until it resets), `switch NAME` (run this Objective on another configured provider, which becomes its frozen provider; plain `switch` when there is only one other) and `cancel`. |
| A human gate Factory doesn't own | An environment approval; a review the branch requires                                                                                                                                                                   | Wait with no deadline. Status shows "waiting on" the gate, and one reminder comment follows after 24 h.                                                                                                                                                                                                      |
| An unknown transient cause       | The network down; 5xx or an outage at GitHub or the provider; 409, 410, 422 or a GraphQL error from GitHub; CI queued or running                                                                                        | Retry with backoff. After 1 h, post one status note on the issue (edited in place). After 3 h, hold with a question naming the cause and the last error: `wait` (another 3 h), `retry` and `cancel`.                                                                                                         |

A problem on the host counts as fatal when it is certain (disk, login) and as transient otherwise. Times are wall-clock times saved in the state, so a restart doesn't reset a budget, and the question comes only after the step ran again and still had to wait.

- **An open question pauses the clocks of the steps it stops.** While a question is open, no step it stops starts (see [Holds](#holds-and-answers) for its scope), so their waits don't count; other items' clocks run on. When the question closes, each waiting step it stopped moves its wait start and any granted `wait` forward by the time it was due but blocked, up to when another open question that also stops it was asked (that one's close moves the rest), so overlapping questions never count the same time twice. A human gate's start stays: it never times out, and its one reminder is keyed to that start. No status note or gate reminder is posted for a step an open question stops. A step that asks while a question covering its scope is open doesn't wait past the answer: its retry comes due at once, so it runs again right after the answer and asks then, even when its own wait (a reset hours away) would end later.

- **One budget per class.** A step's wait start, first cause, backoff and any granted `wait` belong to one run of one class: a reset, a gate, or an unknown cause (errors count as unknown). When the class changes, they start again, so eight hours on a review never spend the transient budget. The error count covers one run of consecutive errors; any other outcome resets it.
- **Only a real rate limit is a reset.** A 429, or a 403 rate limit, waits for its reset. A 5xx is an unknown transient even when it carries rate-limit headers; its `retry-after` only sets the backoff. A reset at or before now (a skewed clock) still waits at least the normal backoff.
- **Required checks before gates.** A required check with no run or status counts as pending whatever GitHub's readiness says, and it holds 15 min after the push. A review the branch requires is a gate only once every required check is there.
- **Deadlines of a wait are the engine's.** A step that waits on something GitHub may not show yet (a merge it made, a PR state) retries with a question for later; the engine asks it once the run of retries has gone on 2 min. A required check that never registers is asked about the same way, 15 min from the push (or from when Factory began waiting, when GitHub doesn't say). A module never reads the engine's retry records.

### Idempotence

Every step is safe to run again. Before it does anything with an outside effect, it looks for that effect on GitHub:

| Effect        | How the step finds it                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch        | Fixed name: `factory/<issue>/<item>`.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| PR            | Open or merged PR whose head is that branch.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Merge         | That PR's merged state.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Comment       | A hidden marker, `<!-- factory:<issue>:<kind>:<id> -->`, in a comment by Factory's own login (anyone else's marked comment is ignored). An existing comment is edited, not posted again. The report's marker names the run (`report:<run>`, the run being its admission time, state.ts `runOf`), so a later run of the same issue posts its own report and checks for edits again. A plan too large for one comment continues in numbered `plan-data` comments. |
| Issue close   | The issue's state.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Branch delete | The branch's absence. After its PR merges (a native stack's layers once the whole unit merged), and on cancel, a branch is deleted only when Factory made every commit it has beyond the default branch (GitHub's update-branch merges from the item's base count, a stack layer's predecessor branch included), by a push with a lease on the head it read.                                                                                                    |
| Project field | Written every time; it is a display.                                                                                                                                                                                                                                                                                                                                                                                                                            |

So an effect whose result was lost is never "unknown". The next run of the step finds it on GitHub and carries on.

A model call has no outside effect. If the process dies mid-call, the call runs again. A worker's worktree is kept and reused on the base the item kept, so a repeated work step continues from its files. A worktree from an attempt that never kept its base (it died before its outcome) is reset onto the base the rerun picks.

A step's kept facts (`state.kept`) outlive repairs. A step forgets one by keeping `null`, and the engine then removes it, so a reader never sees `null`.

### Deadlines

| Wait                   | Deadline                                           | At the deadline               |
| ---------------------- | -------------------------------------------------- | ----------------------------- |
| GitHub request         | 60 s                                               | retry                         |
| Plan, plan review      | 45 min each, 15 min idle                           | retry; hold after 3           |
| Worker turn            | 2 h total, 15 min idle (Copilot: `idleSeconds`)    | retry; hold after 3           |
| One validation command | `validation.commandTimeoutSeconds` (30 min)        | repair                        |
| Validation step        | its commands × the command timeout, + 15 min       | retry; hold after 3           |
| Final validation       | its commands × the command timeout, + 30 min       | retry; hold after 3           |
| Result or final review | 45 min, 15 min idle                                | retry; hold after 3           |
| CI on a PR             | a needed check registers within 15 min of the push | hold                          |
| CI queued or running   | 3 h of transient waiting (see [Waits](#waits))     | hold with `wait`              |
| Hold                   | none: it waits for a person                        | a reminder comment after 24 h |

Step deadlines are fixed in the code, with two configured bounds: `validation.commandTimeoutSeconds` (default 1800) limits each validation command and sets the validation deadlines above, so a plan with many commands never outlasts its step, and a Copilot provider's `worker.idleSeconds` (default 900) is its worker's idle bound. The engine's limits take shorter test timings from the environment (`FACTORY_DEADLINE_MS`, `FACTORY_WAIT_MS`, `FACTORY_NOTE_MS`, `FACTORY_REMIND_MS`, `FACTORY_BACKOFF_MS`).

## Queue

The GitHub Project is the source of truth for what is queued.

- **Queued** means the item's Status field equals the configured "queued" option. **Order** comes from the Project's configured number field, then issue number.
- **Read-only, and retried.** Every 30 s the service reads the Project's queued cards, filtered by GitHub (the items `query`, `<field>:"<queued option>"`, closed issues included), plus, from the issue side, the issues it already knows and the most recently updated open issues, since the Project's item list can lag. So a read costs one page per 100 queued cards, not per card ever added; past 1,000 queued cards the rest wait for a later read, and the log says how many. A known issue GitHub no longer has here (deleted, transferred, converted) is dropped from later reads with a log line; an issue read by number that comes back from another repository, or with another number, is gone too. The rest of the read stands. Any other failed or partial read keeps the last good view and tries again. A read failure never fails a run.
- **Status is a display.** The service sets Status as the run moves, from the tick it admits the Objective: Queued (while it is checked and until it has a slot), Planning, Building, Needs you, Done, Cancelled (the `Failed` option may stay configured; no status shows it). Every sync job (a card, a comment, a reply, the queue read) runs in the background, one at a time per job and Objective. A failed one is logged and tried again after a backoff of its own, doubling to 10 min, so one Objective's bad card never spends the rate limit the others need; one past its 10 min deadline is aborted and counts as failed. A run that is replaced or let go of drops its jobs and their backoffs, except a reply already being posted, which still lands. A finished Objective stays in memory, across restarts too, until its final Status and its replies are written. An issue that any sync job finds gone here (404, 410, or a redirect while the repository still answers under its configured name: moved; see Security: No redirects) gets no more card, comment or reply writes, whether or not a queue read still asks for it; a finished one's unsent replies are dropped with a `reply-dropped` log line, and its sync settles.
- **Edges, not levels.** Factory writes the queued option itself, so a card that reads queued means nothing alone. A finished Objective queues again only when its option was set after Factory's own last Status write for that run, by GitHub's clock: Factory saves when it wrote (`shownAt`) and when the card was queued for this run (`queuedAt`), and compares the option's `updatedAt`. An unfinished one dequeues on a change from queued to anything else, cleared or off the Project included, against the option Factory last saw on the card or wrote (`seen`, saved in state). A read that started before Factory's last write is skipped for that card. A stale card never re-admits a run that was cancelled, finished, already admitted or withdrawn: a withdrawn run keeps its last queued time, and only a queue set after it admits the issue again.
- **Never over the operator.** Factory reads the card before each Status write and writes only over what it last saw or wrote itself. Someone else's change is the operator's input: from queued, it dequeues an Objective that hasn't started; any other change stands until the Objective's status moves on. Factory saves the option it is about to write, so after a crash a card showing it still reads as Factory's own.
- **Operator controls:** set an item's Status to the queued option to queue it (again, for a finished Objective: set it after its final Status shows), move it out of the queued option to dequeue it if it hasn't started, and set the order number to reorder. Dequeuing before planning starts withdraws the Objective: its state is removed, as if it was never admitted, so queuing it again checks it afresh. A dequeue while the check runs, or once a re-run's cleanup has begun, is saved (`withdrawing`): nothing past them starts, Factory writes no Status and asks nothing for it, so the operator's option stands, and the Objective is withdrawn as soon as they end. A re-run's cleanup that hasn't begun never runs (the earlier run's finished record stands), and one that holds or errors is withdrawn at once instead of asking. Order is read on every queue read until the Objective starts. There is no control card and no managed metadata field.
- **Several at once.** Up to `queue.maxActiveObjectives` Objectives plan or build at once (default 3), in queue order. An Objective builds only when no Objective whose plan was accepted earlier, and that is unfinished, owns an overlapping path; planning never waits. An Objective whose open holds stop every step it could start, one whose every remaining step waits on a human gate or a hold, and one waiting on another's paths take no slot; a gated or holding Objective still owns its paths. Host-wide caps limit worker runs and validations (`execution.workers` and `execution.validations`, sized from the host), and checks and re-run cleanups (`github`, `queue.maxActiveObjectives` at once). Every fetch in the shared checkout runs one at a time: a caller joins the fetch that starts after the running one, shared by everyone who asked meanwhile, because concurrent fetches fail against each other when the default branch moves.
- **Again.** Queuing a finished Objective again stops its old run (its steps, saves and GitHub jobs) once its cleanup is done, and starts a new one. The new run first reopens the issue if it is closed (the earlier run closed it, or the Project's "Auto-close issue" workflow closed it again); if GitHub refuses, it holds with `retry` and `cancel`. Just before that reopen, and only then, Factory touches the Project's built-in single-select "Status" field (not its own queue field): if the card's Status reads "Done", Factory moves it to "In Progress", else "Todo", else the first option not named "Done", because that workflow closes an issue whose Status reads Done. The check that follows reads the issue again: if something closed it again anyway, it holds with a question naming who closed it, with `retry` and `cancel`, and never plans on a closed issue. A closed issue that never ran isn't queued. The new run then closes the old run's open PRs and removes its worktrees, as `replan` does after a plan was accepted. Factory resets a Work Item branch only when it made every commit the branch has beyond the default branch: each is committed as Factory (Factory commits with a clean Git environment as `factory@users.noreply.github.com`; an amend, rebase or cherry-pick by anyone else changes the committer), or is GitHub's update-branch merge from the default branch or the item's base (a stack layer's predecessor branch). Otherwise it holds with `retry` (after moving the commits off), `reset` (replace the branch anyway) and `cancel`.
- **No approval step.** A clean, reviewed plan runs straight away. Factory asks only when review finds a decision for the operator.

## Check at queue time

When the service first sees a queued Objective, it runs the Objective checks at once, whether or not a slot is free, within the host-wide `github` cap (`queue.maxActiveObjectives` checks and re-run cleanups at once, in queue order): template sections, pinned Sources that resolve at the default branch, no duplicate headings, and declarations that parse. Planning uses the same function. A checked Objective then waits for a slot.

A failed check is a hold. It names each problem and how to fix it, and Status goes to "Needs you". Edit the issue and answer `recheck` to check it again.

## Holds and answers

A hold is a question with named answers:

```jsonc
{
  "id": "plan-1",
  "question": "...",
  "answers": ["answer", "replan", "cancel"],
  "recommended": "answer",
}
```

- **Scope.** A hold outcome declares its scope, `item` (the default) or `objective`. An `item` hold from a Work Item's step (`item:<id>:…`) stops only that item, the items that depend on it (they aren't runnable until it merges), and the native-stack layers above it (they run once the layer below is published, so the workflow names a layer's predecessors and their holds stop it too: work/steps.ts `layersBelow`). Other items keep starting and finishing. An `objective` hold stops every step. A cause that is installation-, account- or provider-wide is `objective` wherever it is raised: the issue closed or edited after planning, a non-writer's Objective awaiting approval, a full disk, repository or origin access (a GitHub login, permission or missing-repository refusal, a push the login or the repository refuses, merge commits or native stacks the repository doesn't allow, the checkout's Git refusal or origin problem), a provider's login, billing, quota or model, its setup or missing SDK package, running as root, the package or offline-install environment, an unavailable sandbox, the installation's configuration (reviewArtifacts, delivery kind, Secretlint), and a limit that resets too far away (`wait`/`switch`: the limit is the account's). Provider holds are classified in one place, for every provider: a `PlannerError` that holds is Objective-wide unless the cause is one Work Item's own (its files, review images or session budget: `PlannerError.itemHold`), and `providerOutcome` maps it for the planner and every worker (providers/planner.ts). Every hold from a step that isn't a Work Item's stops the Objective too: planning, final, final review, report, cleanup and unreadable state. Final and report wait until every item is settled, so they wait for every item hold. The engine's error and transient-wait questions, the repair-budget and crash-loop suspect questions, and media, select, revalidate, review and secret-scan questions take the scope of the step that asks.
- **Several at once.** At most one hold per Work Item and one for the Objective are open. A step that asks while a hold covering its scope is open (the Objective's, or its own item's) opens nothing; its retry comes due at once, so it runs again right after that answer and asks then if the cause remains, so an Objective-wide cause is asked once. A question that running the step again wouldn't ask (a repair over budget, a crash-loop suspect) is saved for the step in `asking`, apart from its retry, so no change to a retry (a `switch`, a done step, a repair) drops it. It is asked as soon as no open hold stops the step, before it runs, and dropped only when asked or when a repair or replan clears the step. Answering `wait` to a limit grants the wait to every step waiting on that limit; `switch` runs every step waiting on a provider's limit again at once on the new provider. Each hold has its own id, question and answers. The Objective shows `holding` (Status "Needs you") while any hold is open. A held Objective takes no queue slot only when its holds stop every step it could start.
- **Saved.** Open holds are in the state file, so a restart restores them. A repair that clears a held step drops its hold (the question is about work that is gone); cancel drops them all.
- Each hold is posted as one issue comment with its own marker, and it lists the answers.
- **Answering:** a comment `/factory <answer> [--question <id>] [text]` from a user with write access to the repository, or `factory answer <issue> <answer> --question <id> [--text ...]`. An answer must never land on a question its author didn't read:
  - The CLI always names the question. `factory retry <issue> --question <id>` answers `retry` to it. Without `--question`, `factory retry` never answers a hold: it runs now the waiting steps no open hold stops, and is refused while an Objective hold is open (or when every waiting step waits on a hold).
  - A bound answer (`--question <id>`) is checked against nothing else: the id names one asking, and a re-ask gets a new id.
  - A comment that names no question applies only when exactly one hold is open, its comment showed the short form before the answer comment was written, and no other question's comment was shown after it. Otherwise it is refused, and the reply lists the open question ids and the bound form. Every time compared is GitHub's: the answer comment's `created_at`, the hold's `shownAt` (the `created_at` or `updated_at` of the question comment Factory posted or edited), and `lastShownAt`. A host clock never enters, so skew can neither misapply nor refuse an answer. Until GitHub shows a hold's comment, only the bound form answers it.
  - A hold's comment shows the short form `/factory <answer>` only while it is the one open hold. When another opens, or another question's comment was shown after it (so its short form would be refused), Factory edits the comment to show `/factory <answer> --question <id>`.
  - An answer that names a hold that isn't open is refused, naming the open ones. `factory status` lists every open hold with its id and the command that answers it.
- **Comments are read by GitHub's clock.** A run reads comments from when its card was queued (the option's `updatedAt`), and an unreadable state's from its question; the cursor only moves forward. GitHub's `since` filters on `updated_at`, so only a comment created at or after the cursor counts: an earlier run's comment, or an old one edited later, never acts.
- The service checks for comments every 30 s while it is holding. If someone without write access answers (or the user doesn't exist), that's ignored and logged. A comment whose author's access GitHub can't report now waits in a list of up to 20 per Objective and is checked again with backoff; the comments after it go on.
- **In an agent host.** The director skill shows each open hold with the host's question tool (Claude Code's AskUserQuestion, or its Codex equivalent): the question, each answer with the recommended one first, and a one-line consequence for each. That gives the operator an app notification. The chosen answer runs `factory answer`. `factory status --json` lists open holds in this shape so the skill needs no parsing.
- An answer that doesn't match its hold gets a reply naming the valid answers. Nothing else changes. So does an answer the hold says needs text (`needsText`, such as planning's `answer` and `allow`) when it has none.
- `cancel` is valid at every hold and at any time.
- **Provider model.** A model the provider's login can't serve holds with `switch NAME` and `cancel`. Copilot checks its model list before it opens a session, so this hold costs no request, and it also offers `retry`: the retry reads the list again before any session, so it bills nothing and succeeds once an admin enables the model. A session that served another model offers no `retry`, because each one bills a request. The operator sets the model and restarts the service, then answers `switch` with the same provider's name, which re-freezes its changed configuration, or with another configured provider's name.
- **Configuration changed.** An Objective whose frozen configuration differs from the service's holds once with `adopt`, `switch NAME` and `cancel` (see Frozen configuration). The `switch` targets are the ones the engine accepts (engine.ts switchTargets): every other configured provider, and this one when its configuration changed, which `switch` re-freezes.
- **Final review.** `retry` to final review's refusal means the default branch was fixed: final validation runs again on the new head, then the review. A `retry` to an error or wait question on final review only runs the review again.
- **Edited during planning.** `continue` to the question about an Objective edited while it was planned keeps the plan and accepts the text GitHub shows then, so building asks again only after a later edit.
- **Configuration.** The service reads its configuration once at start. A hold that asks for a configuration change says to restart the service before answering.
- **Media selection.** The select question's answer is a candidate set id, then optionally `bind ITEM...` (direct dependents that get the set as read-only input), then any text: the text is recorded with the selection as the operator's reason and shown to review.
- **Repair diagnosis.** When diagnosing a refused result needs a decision, the work step holds with `answer <decision>` (a correction for the worker), `retry` (diagnose again) and `cancel`. While the refused result is kept, still exists on the item's base and (for media) its selection stands, it also offers `revalidate`: the result was correct and Factory's check was at fault. The work step then finishes with that same result, without the worker or collection, and the selection, validation, review and delivery run again. It isn't counted as a repair, and a rerun after a crash does the same. Only a repair that refuses the result itself (validate, review, CI, merge, a secret the result writes) records it as refused, so the next result must differ. A select or publish media repair (new candidates, a selection that couldn't be written, missing LFS objects) records nothing: its correct fix may leave the tracked tree unchanged.

## Delivery

`delivery.kind` in the installation's configuration picks how Work Items reach the default branch. The service reads it once at start.

- **`regular`** (default): one PR per Work Item, merged with a merge commit once its checks pass.
- **`native-stack`**: each linear chain of the plan is one GitHub native stack. Each layer's PR targets the branch below it, and the top layer's merge step merges the whole stack with one shared merge commit. An item off a chain is an ordinary PR. When the layer below moves (GitHub updates it with the default branch, or it is repaired), GitHub merges its new head into the layer above, with no worker; only a conflict is that layer's repair.
- **Strict protection.** A PR BEHIND the default branch is updated by GitHub (update-branch), not by a worker; a conflict is the item's repair. A repair that only replays the refused change onto a moved base, and applies cleanly, runs no worker either.
- **`accept`.** A stack that merged by other means (layer by layer, or with different merge commits) is a question with `accept`, `retry` and `cancel`. `accept` takes the unit as delivered once every layer is merged at Factory's head with its merge commit on the default branch; otherwise the question names what is missing.
- **Changing it.** A plan is split by the setting it ran with, so a retry never switches it. To deliver an Objective without native stacks: cancel it, set `delivery.kind` to `regular`, restart the service and queue it again.

## Cancel

`/factory cancel` or `factory cancel <issue>`:

1. Abort the Objective's running steps. This kills the process groups the service started for those steps; it tracks them in memory, and they die with the service anyway.
2. Close every open Factory PR of the Objective (each branch under `factory/<issue>/`, whatever plan made it) with a comment, delete those branches Factory made (see [Idempotence](#idempotence)), close the issue as not planned, and set Status to Cancelled.
3. Mark the state cancelled, recording who cancelled and when (`ended`).

Cancel reads only the Objective's state file and its open PRs, so its cost doesn't depend on history. It can't be refused. If closing a PR fails, the close is retried in the background; it never blocks the cancel. An issue GitHub no longer has here (404 or 410: deleted; a redirect, while the repository itself has not moved: transferred away) has nothing to close: the PRs, branches and work files still go, and the Objective settles.

## Run log

Each run appends to `logs/<issue>/<run>.jsonl`: step start and end, outcome, durations, tokens, cost, errors, and references to body files in the same directory.

- `factory status` reads the state file plus the end of the log.
- Diagnostics, capture export, accounting, scorecards and analysis read logs. They never write state.
- The service keeps the last 20 runs per Objective and 2 GB in total, deleting the oldest first.

## Capabilities

A capability is a module that plugs into one of these seams:

| Seam               | Used by                                           | Examples                                                                                              |
| ------------------ | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `Planner`          | plan, plan review, repair diagnosis, final review | Codex and Claude planning                                                                             |
| `Worker`           | the work step                                     | Codex, Claude, Copilot local; OpenAI Agents, Claude Managed Agents                                    |
| `Reviewer`         | result and final review                           | Codex and Claude                                                                                      |
| `Delivery`         | deliver, wait for CI, merge                       | regular PRs, native linear stacks, LFS assets                                                         |
| `Planning options` | the plan step                                     | discovery, adaptive workflow, recipes, quality checkpoint, package-manager update, splits, amendments |
| `Knowledge`        | plan and work prompts                             | curated playbook, repository memory, Dream proposals                                                  |
| `Observers`        | the run log                                       | diagnostics, accounting, scorecard, capture export                                                    |

Rules for modules:

- A module returns step outcomes. It never writes state directly, takes a lock, starts a background loop, or keeps its own archive.
- A module keeps its data in `modules.<name>` of the state file, or in the run log.
- A module validates its input once, where the input enters, and doesn't re-verify it later.
- **Configuration** is checked once, when it loads, by one helper (checked.ts `section`): each section lists its known keys with their types and defaults. An unknown key is refused by name, and a key an earlier configuration used names what replaced it. All problems are reported in one message. The configuration file and the state directory must lie outside the target checkout.

Review and knowledge see what the worker saw:

- **Review inputs.** Result review and final review get a controller input receipt for each item: every read-only input its worker got (source assets and bound selections) with kind, path, visibility, media type, size and sha256, and Factory's digest-checked copy under `inputs/` in the evidence root, within the candidate copy bounds.
- **Best effort for the lifecycle.** Admission, withdrawal and retirement never open the knowledge store, so a store that can't open or is slow (no `node:sqlite`, a corrupt or unwritable database) never holds them back. A run's end (its records, its episode once terminal, and the release of its playbook pin) is its settled observation: for a run that settles, or that a re-queue or a withdrawal replaces, one that hasn't landed is kept and retried in the background with backoff, and logged: an episode may be recorded late, but the queue never waits. Each is saved as `finished/<issue>@<run>.observe.json` (before the state file moves, for a retirement) and removed once it lands, and startup lists and retries these files, so a restart never loses one.
- **Bounded store.** The store keeps the newest 1,000 episodes and the newest 10,000 other memory records; a write past either cap drops the oldest. Dream reads the newest episodes first and planning bounds what it shows, so neither reaches the dropped ones. An episode a Dream approval still checks stays past the cap: every episode given to the newest playbook or to an undecided proposal.
- **Repository memory** shows a record that cites any path inside the planning selectors, with only its admitted paths; its staleness still comes from every cited file's digest, and a changed file outside the selectors is counted, not named. A reference record carries its Source's text, so it needs every path admitted. An episode counts a native stack's lower layer as merged when the stack merged.
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
- **Origin binding.** Every remote Git call (fetch, push, ls-remote, LFS transfer) goes through git.ts remoteGit, which first checks that origin's fetch and push URLs, after insteadOf, name the configured repository and that LFS uses origin's default route. A changed origin fetches and pushes nothing: the step holds for the whole Objective with the fix.
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

## Migration

Pre-release, with no compatibility layer:

1. Stop the old service.
2. Cancel and clear the old Objective state.
3. Install the new core and run setup.
4. Queue Objectives again.

The old source tree is deleted once every capability is ported.
