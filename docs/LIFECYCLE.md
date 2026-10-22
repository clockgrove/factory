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

| Code                         | Meaning                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------- |
| `objective_not_owned`        | A live service refuses control of an Objective it is not running.                 |
| `owner_settling`             | The service is starting or settling the Objective's run.                          |
| `config_frozen`              | The Objective froze a different configuration than the current one.               |
| `acceptance_sealed`          | Final acceptance is sealed; a run reconciles it.                                  |
| `restoration_held`           | A restored continuation awaits ownership reconciliation.                          |
| `queue_card_archived`        | The Objective's Project card is archived.                                         |
| `coordinator_draining`       | The coordinator was drained or handed off; resume it first.                       |
| `queue_draining`             | The service or queue is draining and admits no new work.                          |
| `unfinished_owned_work`      | The Objective still has owned work; cancel it first.                              |
| `no_factory_state`           | The Objective has no continuation state.                                          |
| `finish_or_cancel_active`    | Another Work Item is still running.                                               |
| `planning_owner_live`        | A live planning owner holds the plan that this command changes.                   |
| `diagnosis_held`             | A planning session still holds the Work Item's diagnosis.                         |
| `rejection_hold`             | A rejected graph amendment holds the Objective paused.                            |
| `controller_owned`           | Another controller already owns the Objective or installation.                    |
| `foreground_owner_live`      | A foreground run owns the installation or cannot take this command.               |
| `no_active_owner`            | No live coordinator owns the Objective to take this command.                      |
| `cancel_unresolved`          | Cessation of owned work is unresolved after a cancellation.                       |
| `objective_complete`         | The Objective is already complete.                                                |
| `objective_not_admitted`     | The Objective has no current queue admission.                                     |
| `owner_endpoint_unavailable` | A live owner holds its record without a control endpoint.                         |
| `active_limit`               | Every dispatch slot holds an unsettled run.                                       |
| `session_unsettled`          | A native agent session still holds resources that cancellation must settle.       |
| `upgrade_draining`           | An upgrade waits while running Objectives finish. This is a result, not an error. |

Add a code here, and to `LIFECYCLE_CODES`, when you add a lifecycle refusal.

## Matrix

The matrix records today's behaviour. These are its owners:

- **none:** no live controller.
- **foreground:** a live, paused `factory run`.
- **service:** a live service that isn't running this Objective.

A plain entry is the expected outcome:

- `ok`: the command passed every lifecycle check.
- `invalid`: a refusal of the command's own input, with no code.
- A code: the refusal code.

An entry marked ✗ is a known gap. The marker names the invariant it breaks and is followed by today's outcome. The suite records the gap as a `todo` test that asserts the target outcome. A fix that closes a gap makes the test pass, and the fix then removes the `todo` marker.

| State                       | Owner      | Behaviour                                                                                  |
| --------------------------- | ---------- | ------------------------------------------------------------------------------------------ |
| Queued, no state            | none       | run ok; retry, decide, cancel and pause `no_factory_state`; queue add and remove ok        |
| Queued, no state            | service    | run `controller_owned`; cancel `no_factory_state`; retry ✗(a) `objective_not_owned`        |
| Planning, owner gone        | none       | run, decide, cancel, pause and resume ok; queue remove `unfinished_owned_work`             |
| Planning, owner gone        | service    | decide and cancel ok; pause and resume ✗(a) `objective_not_owned`                          |
| Plan decision               | none       | run, decide, cancel and resume ok                                                          |
| Plan decision               | service    | decide and cancel ok; resume ✗(a)                                                          |
| Plan decision, paused owner | foreground | cancel ok; refusing the plan ✗(a) `planning_owner_live`; upgrade ✗(b) waits                |
| Items running, owner gone   | none       | run, cancel and pause ok; retry `finish_or_cancel_active`                                  |
| Items running, owner gone   | service    | cancel ok; retry ✗(a)                                                                      |
| Failed                      | none       | run, retry and cancel ok                                                                   |
| Failed                      | service    | cancel ok; retry and resume ✗(a)                                                           |
| Cancel unresolved           | none       | run and cancel ok; retry `cancel_unresolved`                                               |
| Cancel unresolved           | service    | cancel ok; retry ✗(a)                                                                      |
| Diagnosis held              | none       | retry `diagnosis_held`; cancel ✗(a) `session_unsettled`                                    |
| Diagnosis held              | service    | cancel ✗(a) `session_unsettled`                                                            |
| Operator-paused             | none       | run, cancel, pause, drain, resume and upgrade ok                                           |
| Operator-paused             | foreground | run `controller_owned`; cancel, pause and resume ok; upgrade ✗(b) waits                    |
| Operator-paused             | service    | cancel ok; pause and resume ✗(a)                                                           |
| Drained                     | none       | run `coordinator_draining`; resume and cancel ok                                           |
| Drained                     | service    | cancel ok; resume ✗(a), so the only way out is to stop the service                         |
| Rejection hold              | none       | run and cancel ok; retry, repair, drain and resume `rejection_hold`                        |
| Rejection hold              | service    | cancel ok; resume ✗(a)                                                                     |
| Acceptance sealed           | none       | run ok (it reconciles); retry `objective_complete`; cancel `acceptance_sealed`             |
| Restored, held              | none       | run and retry `restoration_held`; start `restoration_held`; cancel ✗(a) `restoration_held` |
| Configuration changed       | none       | run, rereview, repair and start `config_frozen`; cancel ok                                 |
| Cancelled                   | none       | run, cancel, queue remove and queue add ok                                                 |
| Complete                    | none       | run, cancel and queue remove ok; retry `objective_complete`                                |
| Complete, card archived     | none       | queue add ok against the Project fixture                                                   |

**Dispatch isolation.** A failed or cancel-requested queued Objective is skipped with a reason. The service stays up and dispatches the Objectives behind it.

**Bounded time.**

- An operator command ends within its bound beside a real maintenance pass.
- A publication lock that another process holds past the bound still blocks it: ✗(c).

These rows need the service to be actively running the Objective. The suite lists them as `todo` until it has a live-run owner:

- Planning, executing or waiting on CI: upgrade should hand the run off instead of waiting. ✗(b)
- Operator-paused but still active in the service: upgrade waits forever. ✗(b)
- Settling: decide and cancel refuse with `owner_settling`, and settling has no deadline. ✗(a)
