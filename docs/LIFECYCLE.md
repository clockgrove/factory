# Objective lifecycle

This page defines how operator commands behave in each Objective state. `test/lifecycle-conformance.test.mjs` checks it, and #1714 tracks the redesign.

## Invariants

1. **An exit from every state.** Every non-terminal state has a supported operator exit, at least `cancel`.
2. **Upgrade never blocks on idle work.** An upgrade or restart never waits on an Objective that isn't executing. A run that can be handed off is handed off.
3. **No housekeeping on the operator path.** Archive verification, packing, reclaim and projection never run on, or block, an operator command. They run bounded, in the background.

## Refusal codes

Every lifecycle refusal is a `LifecycleRefusal` with a stable `code` (`src/lifecycle-refusal.ts`), and the message is for people. Tools decide on the code, never the message.

- The code crosses the control endpoint, so a refusal from a live owner keeps its code.
- The CLI prints `{"kind":"lifecycle-refusal","code":"..."}` on stderr before the message.
- An upgrade that waits returns `code: "upgrade_draining"` in its result.

| Code                         | Meaning                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| `objective_not_owned`        | A live service refuses a non-lifecycle action on an Objective it is not running.            |
| `owner_settling`             | The service is starting or settling the Objective's run.                                    |
| `config_frozen`              | The Objective froze a different configuration than the current one.                         |
| `acceptance_sealed`          | Final acceptance is sealed; a run reconciles it.                                            |
| `restoration_held`           | A restored continuation awaits ownership reconciliation.                                    |
| `queue_card_archived`        | The Objective's Project card is archived.                                                   |
| `coordinator_draining`       | The coordinator was drained or handed off; resume it first.                                 |
| `queue_draining`             | The service or queue is draining and admits no new work.                                    |
| `unfinished_owned_work`      | The Objective still has owned work; cancel it first.                                        |
| `no_factory_state`           | The Objective has no continuation state.                                                    |
| `finish_or_cancel_active`    | Another Work Item is still running.                                                         |
| `planning_owner_live`        | A live planning owner holds the plan that this command changes.                             |
| `diagnosis_held`             | A planning session still holds the Work Item's diagnosis.                                   |
| `rejection_hold`             | A rejected graph amendment holds the Objective paused.                                      |
| `controller_owned`           | Another controller already owns the Objective or installation.                              |
| `foreground_owner_live`      | A foreground run owns the installation or cannot take this command.                         |
| `no_active_owner`            | No live coordinator owns the Objective to take this command.                                |
| `cancel_unresolved`          | Cessation of owned work is unresolved after a cancellation.                                 |
| `objective_complete`         | The Objective is already complete.                                                          |
| `objective_not_admitted`     | The Objective has no current queue admission.                                               |
| `owner_endpoint_unavailable` | A live owner holds its record without a control endpoint.                                   |
| `active_limit`               | Every dispatch slot holds an unsettled run.                                                 |
| `session_unsettled`          | A native agent session still holds resources that cancellation must settle.                 |
| `publication_lock_held`      | Another process held the archive publication lock past the bound; run it again.             |
| `upgrade_draining`           | An upgrade waits while runs finish their step and hand off. This is a result, not an error. |

Add a code here, and to `LIFECYCLE_CODES`, when you add a lifecycle refusal.

## Matrix

The matrix records today's behaviour. These are its owners:

- **none:** no live controller.
- **foreground:** a live, paused `factory run`.
- **service:** a live service that isn't running this Objective.
- **live:** a live service running this Objective.

A plain entry is the expected outcome:

- `ok`: the command passed every lifecycle check.
- `invalid`: a refusal of the command's own input, with no code.
- A code: the refusal code.

An entry marked ✗ is a known gap. The marker names the invariant it breaks and is followed by today's outcome. The suite records the gap as a `todo` test that asserts the target outcome. A fix that closes a gap makes the test pass, and the fix then removes the `todo` marker.

| State                       | Owner      | Behaviour                                                                                  |
| --------------------------- | ---------- | ------------------------------------------------------------------------------------------ |
| Queued, no state            | none       | run ok; retry, decide, cancel and pause `no_factory_state`; queue add and remove ok        |
| Queued, no state            | service    | run `controller_owned`; retry and cancel `no_factory_state`                                |
| Planning, owner gone        | none       | run, decide, cancel, pause and resume ok; queue remove `unfinished_owned_work`             |
| Planning, owner gone        | service    | decide, cancel, pause and resume ok                                                        |
| Plan decision               | none       | run, decide, cancel and resume ok                                                          |
| Plan decision               | service    | decide, cancel and resume ok                                                               |
| Plan decision, paused owner | foreground | cancel and upgrade ok; refusing the plan ok (the owner hands off)                          |
| Items running, owner gone   | none       | run, cancel and pause ok; retry `finish_or_cancel_active`                                  |
| Items running, owner gone   | service    | cancel ok; retry `finish_or_cancel_active`                                                 |
| Failed                      | none       | run, retry and cancel ok                                                                   |
| Failed                      | service    | retry, cancel and resume ok                                                                |
| Failed, not admitted        | service    | cancel ok; retry `objective_not_admitted`                                                  |
| Cancel unresolved           | none       | run and cancel ok; retry `cancel_unresolved`                                               |
| Cancel unresolved           | service    | cancel ok; retry `cancel_unresolved`                                                       |
| Diagnosis held              | none       | retry `diagnosis_held`; cancel ✗(a) `session_unsettled`                                    |
| Diagnosis held              | service    | cancel ✗(a) `session_unsettled`                                                            |
| Operator-paused             | none       | run, cancel, pause, drain, resume and upgrade ok                                           |
| Operator-paused             | foreground | run `controller_owned`; cancel, pause, resume and upgrade ok                               |
| Operator-paused             | service    | cancel, pause and resume ok                                                                |
| Drained                     | none       | run `coordinator_draining`; resume and cancel ok                                           |
| Drained                     | service    | resume and cancel ok                                                                       |
| Rejection hold              | none       | run and cancel ok; retry, repair, drain and resume `rejection_hold`                        |
| Rejection hold              | service    | cancel ok; resume `rejection_hold`                                                         |
| Acceptance sealed           | none       | run ok (it reconciles); retry `objective_complete`; cancel `acceptance_sealed`             |
| Restored, held              | none       | run and retry `restoration_held`; start `restoration_held`; cancel ✗(a) `restoration_held` |
| Configuration changed       | none       | run, rereview, repair and start `config_frozen`; cancel ok, without `--provider`           |
| Configuration changed       | service    | cancel and resume ok                                                                       |
| Cancelled                   | none       | run, cancel, queue remove and queue add ok                                                 |
| Complete                    | none       | run, cancel and queue remove ok; retry `objective_complete`                                |
| Complete, card archived     | none       | queue add `queue_card_archived` (restore the card first)                                   |

**Cancel exits.**

- **Configuration changed.** Without `--provider`, cancel picks the one configured provider whose adapters cover every adapter the Objective recorded. If none or several fit, it asks for `--provider`.
- **Archived card.** An admission's approved writes include no unarchive, so `queue add` refuses with `queue_card_archived` and names the remedy: restore the card from the Project's archive, then add it again. The refused admission still leaves its queue operation unsettled, which holds later queue mutations: a known follow-up.

**One control plane.** A live service runs every lifecycle command on an Objective it isn't running: decide, cancel, retry, repair, rereview, select, amendments, pause, drain and resume. Commands that let work start (retry, resume, select, repair, rereview, propose-amendment) need a current queue admission, else `objective_not_admitted`; decide, cancel, pause, drain and decline-discovery work for any Objective. It runs the foreground implementation as the installation owner, under the Objective's lock and on the configuration the Objective froze. While it starts or settles the Objective's run, it refuses with `owner_settling`. A live paused planning owner hands its Objective off to take a plan refusal, which then lands where the Objective stopped.

**Explicit holds.** An operator's pause, an operator's drain and the service's drain are distinct states. A handoff stops a live run at its safe point and turns only a running coordinator into a drain, which carries `drainedBy: "service"` when the service asked for it. An operator's pause or drain stays as it is, beneath a rejection hold too, where the mode the operator asked for (`requestedMode`) returns with the replacement. Only the service's own drain resumes automatically. The suite checks that a pause survives a handoff, and a handoff under a rejection hold.

**Dispatch isolation.** A failed or cancel-requested queued Objective is skipped with a reason. The service stays up and dispatches the Objectives behind it.

**Bounded time.**

- An operator command ends within its bound beside a real maintenance pass.
- A publication lock that another live process holds past 3 s refuses an operator command (every mutating command but `run`, queue commands included) with `publication_lock_held`, naming the holder. The 3 s covers all of the command's publications. A lock whose holder is gone is taken; a live holder's lock is never broken. Maintenance pauses between pack batches, so the command waits at most one batch behind it.

**Restart means handoff.** An upgrade (`finish`) stops new dispatch and asks every run to hand off at its safe point. A service run's handoff is the service's own drain, which resumes after the restart. A foreground run is asked through its control; it ends, and `factory resume` continues it (the upgrade result lists it under `handedOff`). Only a run executing a step is waited for: the upgrade returns `upgrade_draining` naming it at once, and the run hands off when the step ends.

**Settle deadline.** A run settles after its last step: final progress projection, queue claim settlement, the split parent's update and the final checkpoint admission. Settling ends within 30 s (`SETTLE_DEADLINE_MS`; `FACTORY_SETTLE_DEADLINE_MS` overrides it, as the suite does). Past it, the run stops at its last saved state and releases its slot and lock. A handed-off run's next owner settles its claim; any other run ends with `SettleDeadlineElapsed`, naming the unfinished steps, and the service holds the Objective until `factory cancel` finishes settling it. A `decide` or `cancel` that reaches a settling run waits for it to end, then applies.

The suite runs these rows under a live service whose model, worker and delivery calls never answer:

| State                           | Owner | Behaviour                                                      |
| ------------------------------- | ----- | -------------------------------------------------------------- |
| Waiting on CI                   | live  | upgrade ok: the run hands off                                  |
| Operator-paused, active         | live  | upgrade ok: the run hands off                                  |
| Settling                        | live  | cancel ok once settling ends at its deadline                   |
| Planning call in flight         | live  | upgrade `waits`, returning at once; the run hands off after it |
| Items running, a step executing | live  | upgrade `waits`, returning at once; the run hands off after it |
