# Objective authority and mutation boundaries

This is the production locking audit for [#219](https://github.com/clockgrove/factory/issues/219),
not evidence of installed throughput or a substitute for live qualification.

## Conflict scopes

| Resource / old outer assertion | Resulting authority |
| --- | --- |
| Foreground Objective lifetime (`runForegroundObjective`) | Objective lease only; no service election held around execution. |
| Supervisor admission, lifecycle, attempts, comments, cancellation acknowledgements and recovery | Captured Objective/run/holder/epoch/policy identity, checked at dispatch. No repository lease. |
| Graph commits, projection receipts, issue creation and dependency links | Objective authority plus immutable graph/projection identities. Related issue writes replay idempotently; conflicting relationships fail closed rather than holding two issue locks. |
| Review, durable-session, merge-candidate, native-rebase and sibling-refresh checkpoints | Objective authority and exact immutable checkpoint/attempt binding. Original producer epoch remains distinct from the current recovery writer. |
| PR creation, work branches and publication | Objective authority; branch/ref creation or expected-before-SHA CAS protects the exact branch. No default-branch claim until integration. |
| Work Item assignment across Objectives | Existing per-Work-Item claim ref CAS; no repository exclusion. |
| Default-branch integration | Short destination-branch claim, expected validated base/head/tree, current rules and GitHub merge semantics. Independent execution and publication continue. |
| Global worker, backend, path and resource reservations | Shared capacity ledger CAS; retry a losing reservation update. No lock is held for worker execution or ordinary GitHub mutations. |
| Service controller lease acquisition, renewal and retirement | Retained for discovery leader election. Election loss retires discovery/configuration, not otherwise-current Objective execution or data. |
| First import of historical capacity / explicit service ceiling changes | Short scheduler-ownership fence around genuine shared-state initialization or configuration. Existing resource liabilities are imported, never freed merely by timeout. |
| RecoveryCoordinator legacy optional repository guard | Compatibility-only explicit caller contract. Production adoption uses Objective ownership at the queued mutation boundary. |

`controlRepositoryControls.fence` is an Objective fence despite its name; it must remain.
Quota admission, the bounded HTTP concurrency limiter and GitHub's primary/secondary backoff also
remain. None grants data ownership. Quota admission releases when transport begins rather than
waiting for an unrelated request's HTTP response.

Repository-election retirement and execution stop are separate signals. A proven election loss
prevents fresh discovery, activation/recovery dispatch, leader observations and explicit shared
configuration, then awaits the existing Supervisor cohort without lending it the old controller
generation. Those Supervisors continue only through their own current Objective writer epoch. An
explicit shutdown or cancellation still reaches its intended execution, and credential, account,
quota, circuit or other platform-safety failures preserve their existing stop/backoff propagation.
Neither election expiry nor takeover releases a shared-capacity claim or proves a producer stopped.

## Writes and delayed actors

Normal writes capture authority before their first queue wait and check it immediately before
transport. A scoped capacity or integration transaction supplies its own immutable Objective fence;
the configured fence is not checked a second time. Standalone stores without a guaranteed
dispatch-time fence retain manager preflight checks.

GitHub comment retries are not exactly-once HTTP delivery. Receipt identities and sequences collapse
exact duplicates and reject contradictory payloads. Application command request IDs remain
idempotency keys and authenticated user commands do not wait for a Director lease. Multi-issue graph
application uses stable identities and optimistic reconciliation, not nested Objective locks.

The comment API has no atomic lease-and-append precondition. Dispatch fencing cannot retract an
in-flight request. Writer generation must therefore fence fresh control authority independently of
the original attempt generation; delayed old-owner acknowledgements cannot settle a newer owner.
Historical artifact and accounting evidence is preserved for explicit reconciliation, not silently
discarded or treated as zero usage.

## Remaining shared-state boundaries

- A capacity reservation atomically checks all retained claims against global and run-specific
  ceilings. Expiry, a missing process, or absence from one snapshot does not release a claim.
  Shared-capacity v2 compacts only explicit releases into exact hash-sharded Git-tree tombstones at
  the 3,072-record maintenance threshold. The capacity-ref CAS publishes the tombstones and active
  snapshot together, so a crash cannot expose pruning without anti-replay evidence. Retired identity
  lookup has fixed depth, stale epochs retain their Objective fence, and 3,840 active claims expose
  an explicit reconciliation action before the unchanged 4,096-record hard bound. Durable retired
  storage grows with history and remains subject to GitHub repository limits; it is not described as
  unlimited retention. See [#220](https://github.com/clockgrove/factory/issues/220).
- A first-time capacity import reconstructs worker reservations from authenticated original
  graphs, Work Items and ownership history, keeping those resource claims occupied. Missing worker
  history can block that one-time migration. Unknown management-model usage remains an Objective
  accounting concern, not a repository capacity lock; an unrelated absent process batch proves
  nothing about that invocation. Once the shared ledger exists, normal sessions do not consult or
  wait for the service election lease.
- An integration claim covers only mechanical final integration, never model execution or
  validation. A prepared claim can be recovered only by the exact Objective's higher fenced epoch.
  A dispatched claim needs exact GitHub merge proof; age alone cannot prove that a request will not
  complete. Unresolved native asynchronous or regular merge dispatch blocks that destination
  branch's integration until reconciliation, not unrelated Objective mutations.
- GitHub regular merge supports an expected head SHA, not expected base CAS. Revalidation plus
  post-merge parent/tree proof detects an external-writer race; it does not pretend to prevent it.
  [GitHub merge API](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request).

## Remote work removed and observable costs

The former normal mutation path performed an outer repository assertion plus an Objective assertion,
often after one or more manager preflights. It now performs one Objective assertion at dispatch.
For an unchanged cached lease, that is one current-ref read instead of the outer-plus-inner two.
A changed ref may require reading its new lease commit; the telemetry records the actual requests.

Lifecycle and attempt comment helpers no longer add their earlier duplicate check. Multi-step graph,
review, session and checkpoint publication likewise rely on dispatch fencing for each actual write,
not repeated outer-plus-inner assertions around every small step. Lease creation/renewal/release
remain protected by their own ref CAS. Capacity and final integration still incur genuine shared
state reads and CAS writes; those are not described as removed costs.

Publication additionally removes eight redundant per-write preflight call sites while retaining
phase assertions. The focused one-file publication fixture goes from five preflights to one phase
assertion, plus the actual transport fences. This is a deterministic component comparison, not a
claim about historical live-run quota or end-to-end throughput.

`FactorySupervisor.mutationOperationTelemetry()` exposes a bounded process-local record stream:
operation and resource scope, queue time, fence time, lease assertions, actual read/write fetch
attempts, fence-only reads, unclassified fetches, elapsed time and outcome. Dropped record counts
make retention limits explicit. Diagnostic sink failure cannot invalidate a successful write.
These measurements are not GitHub account quota attribution, provider billing or durable authority.

## Deterministic acceptance

| Requirement | Focused evidence |
| --- | --- |
| Independent Objectives mutate concurrently | `mutation-fencing.test.ts`: one HTTP write remains pending while another Objective completes its write. |
| Same Objective has one owner | `v2-control.test.ts`: simultaneous observed-OID contenders, authenticated contention and epoch takeover. |
| Stale Objective cannot dispatch a queued write or settle a newer owner | `v2-control.test.ts`, `mutation-fencing.test.ts`, `controller-recovery-transport.test.ts`, `writer-generation.test.ts`: captured epoch rejection, same-epoch renewal, isolated shared-transaction fences and delayed lifecycle receipt rejection. |
| Concurrent integration detects a changed base and revalidates | `integration-admission.test.ts`, regular/native Supervisor binding tests: claim contention, advanced-base validation and exact resulting parent/tree. |
| Controller failure does not block unrelated Objectives | Controller/foreground tests: no election acquisition on an initialized independent session, Objective-local failure isolation. |
| Global capacity survives multiple sessions and crashes | `shared-capacity.test.ts`: CAS contention, limits, retained liabilities and explicit release/reconciliation. |
| Fencing cost is visible per operation | `mutation-fencing.test.ts`: exact fetch/read counts, fence timing, no unrelated-read attribution and nonfatal diagnostics. |

Run the focused suite on the integrated source candidate and retain its exact identity. Ordinary
throughput qualification must contain no manufactured lease-expiry delays or compounded failures.
Fault-injection evidence is separate, and an earlier failed run never becomes a pass because code
or acceptance logic changed.

### Focused verification of this change

On production source `d2dfc49e1b16d5e452ef71e2ab8756f8830d20b0`, the final acceptance set
passed 179 tests across 13 files. Five additional actual-Supervisor concurrent integration and
stale-evidence cases passed separately, including the original stale-base timeout and assertions.
Typecheck and changed-file lint/format checks passed. Subsequent documentation and fixture formatting
do not constitute a new installed artifact or a release qualification.

The first broader component run failed on outdated lease test doubles and exposed a real candidate
base-metadata ordering defect. The doubles and source defect were corrected; affected suites were
rerun rather than repeating unrelated checks. A full successor-file run was interrupted and is not
claimed as passed; its ordinary regular/native and deadline-only writer recovery cases passed
separately. Full integrated release checks and installed/live qualification remain with the candidate
gate, not this component evidence.
