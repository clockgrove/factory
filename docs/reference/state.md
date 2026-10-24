# State

Part of [the design](../DESIGN.md).

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

- **Running out holds.** A repair past `perPath` or `implementationRepairs` asks before the step that would repair runs again: the engine reads the counts (`state.repairs`), and keeps only the question's id, so its `more` is the engine's. An interrupted attempt passed the check when it started, so it runs again without asking. A Work Item's work step whose pending repair isn't diagnosed yet runs once first (`diagnoseFirst`): a diagnosis that blames a predecessor spends no repair, so the blame is decided before `more` is asked; any other diagnosis is saved, the step goes on (`progress`), and the question follows, and `more` then reuses the saved diagnosis. Its cause is `failure`, with `more`, `replan` and `cancel`. Past the Objective's allowance the question is Objective-wide, so every step waits and it is asked once. The engine also charges each `revalidate` against `resultRereviews` when the answer lands, against the live state, so two at once can't both pass; past it, the step holds the same way instead of taking the answer, and that `more` grants as much again and revalidates. Planning counts every round of a generation against `planningRevisions`, whatever started it: a plan problem, an answer to a planner or review question, or a `more`. Past it, the decide step asks before the next round, with `more` among its answers. An `answer` or `allow` that would start that round never passes the check: the step keeps it (`decide:g:n:answered`, saved with the question) and asks, and `more` grants as much again and sends it. The count comes from the saved rounds, and a crash before the step saves its outcome runs the same check again with the same answer, so no round is counted twice or skips the check.
- **`more` grants as much again** (at least one) of each allowance the question names, recorded with the counts in `state.kept`. The engine applies `more` to its own repair questions, and the step never sees it; any other `more` is its step's (a planning round, a rereview, a managed worker's spend).
- **A blamed repair is free.** When the diagnosis blames a predecessor (see Predecessor blame in Holds), the predecessor's repair counts as usual, and the blamed item's repair counts against neither `perPath` nor `implementationRepairs` (the repair or hold outcome's `free`, kept in `state.repairs`).
- **A replan starts afresh.** It clears the repairs, the grants and the rereview counts with the plan.
- `status` shows each allowance as used/allowed, with grants, and repairs per repair path.
- **`autonomy.requiredEnvironment`** names operator variables (each also in `policy.allowedSecretNames`, and none starting `GH_`, `GITHUB_`, `GIT_` or `SSH_`, which workers never receive) that must be set, non-empty, in the service's environment before planning. The check step tests them first; a missing one holds the whole Objective, naming only the missing names, with `retry` (after setting it and restarting the service) and `cancel`. Values are never read past that test, logged or shown.

### Execution profiles

`execution.profiles.<id> = {provider, description, selectionHints?}` names a configured provider's worker the planner may assign to a Work Item. The planner and the plan review are offered the ids with their descriptions (planning/steps.ts `offeredProfiles`, from the same list a recipe's `eligibleProfileIds` are checked against), and every work item gets one with a reason. The item's worker runs on that provider's worker settings; planning, reviews and the rest stay on the Objective's provider, and a usage-limit `switch` moves only those, so a limit on a provider the Objective doesn't run on (a profile's) offers only `wait` and `cancel`. Without profiles every item runs on the Objective's provider.

A profile may add two things to its provider's worker, both frozen with the profile, so a change holds a running Objective:

- **`instructions`**: the operator's standing instructions (at most 8,000 characters, no secret value), appended to the worker prompt for its items (work/prompt.ts) as subordinate to Factory's rules and the Work Item, granting nothing.
- **`worktreeRead: true`**: a Claude worker also gets `read_file`, an in-process MCP tool that reads one regular file in its worktree as text (at most 256 KiB). It applies Read's path check (no escape, no `.git`, links only inside), then opens the resolved path by held descriptors with no link followed, and both permission callbacks check it. It needs a Claude worker with `Read` in its tools and allowedTools, so it reads nothing Read couldn't.
