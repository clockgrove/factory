# Issue admission and historical compatibility

Execution admission is a CAS chain at
`refs/clockgrove-factory/admission/work-item-<issue-number>`. The stored issue node ID
must agree with the number. Current sub-issue parentage does not create authority.
A transition binds the owning Objective, accepted run and policy, immutable graph
and projection commits, original Director generation, immutable reservation
metadata, backend/resource identity, and capacity/budget reservation identities.
Attempt numbers increase across the issue's entire history. Per-run attempt and
budget limits still apply separately.

The issue ref is the single new admission arbiter. Metadata commits keep their
original `AttemptReserved` envelope and base parent. The ledger retains those
commits, prior revisions, settlement evidence and accepted transfer evidence as
Git parents, so message pointers are not their only reachability. Its bounded
4096-entry history fails closed at capacity; it does not discard liabilities.
This is not a general event database. Authenticated comments remain the lifecycle,
accounting and command journals.

| Disposition | Meaning |
| --- | --- |
| prepared | Durable intent; backend dispatch has not been permitted. |
| dispatching | A single transition permitted dispatch; delivery may be unknown. |
| terminal | A terminal execution receipt exists; cleanup/accounting may remain open. |
| reconciled | Exact producer, resource, capacity and accounting settlement evidence exists. |
| released | Settlement allows the next distinct attempt; the old identity cannot dispatch again. |

`dispatchPossible` is monotonic, including after terminal outcomes. A lost CAS
response is not proof that a provider request was sent or was not sent. The
Supervisor does not replay a dispatch transition. Provider-supported idempotency,
deterministic original resource identities, exact session recovery, and unknown
accounting gates remain necessary.

## Permanent compatibility bridge

The bridge closes both entry points of supported historical writers:

1. Conditionally replace the historical permanent issue-claim head with a marker
   the old claim parser rejects. Retain the original claim as its Git parent and
   bind its original Objective. A fresh issue creates that marker atomically.
2. For a historical owner, verify the retained contiguous attempt history and
   create an incompatible next-slot reservation ref. If an old writer wins that
   slot, retain its reservation and try the next slot. Never overwrite or remove
   an old reservation or the final barrier.
3. Import consistent original graph/run/resource identities as occupied
   `dispatching` entries. Missing or conflicting authenticated evidence blocks
   admission and preserves the original records for recovery.

An old caller before claim creation loses to the marker. A caller already past
claim validation either sees the incompatible attempt record and fails parsing,
loses a reservation slot to the barrier, or has already won a retained slot. A
caller holding an earlier complete attempt snapshot can only target an occupied
or sealed slot. Missing historical slots, orphaned attempt histories without an original claim, and
conflicting Objective namespaces fail closed. The barrier is permanent,
including after reassignment; it is never made executable again.

An already-reserved old caller may still dispatch. Neither the marker, controller
election, lease expiry/release, nor an absent process proves it has stopped.
Imported entries therefore remain occupied until exact reconciliation. Resource
absence alone cannot release a suspended original producer. The supported
Supervisor's original-generation pipeline-end receipt can prove its finite launch
path has closed; a successor-created deferred receipt cannot manufacture that
proof. Recorded local producer/scope evidence supplies the alternative existing
recovery contract. Unknown or unsupported histories remain blocked for explicit
evidence-preserving recovery of the original run.

Readers resolve logical historical attempt locators through `attempt-readers.ts`.
They combine consistent retained legacy metadata with ledger pointers and exclude
only exact supported barriers. New attempts do not create redundant legacy attempt
refs. Recovery plans, artifacts, publications and accounting keep their original
reservation OIDs and logical locators; history is not relabelled as a new run.

## Release and reassignment

Normal release occurs only after the owning worker pipeline has closed, exact
cleanup succeeded, applicable capacity was released, and authenticated accounting
is complete. A retained artifact awaiting continuation is not a released attempt.
Definitive non-execution requires a never-dispatched original identity and positive
closure evidence; missing native or model usage is never inferred to be zero.

A different run/graph cannot use ordinary admission. Transfer requires explicit
accepted new-run authority, settled prior work/accounting, no original producer or
resource liability, released capacity, and an issue-ref CAS. Existing successor
recovery is the production authorization route. Reparenting, a new activation by
itself, or an arbitrary graph replacement is not a transfer request. The original
graph and policy remain immutable. A conflicting or unknown transfer fails closed.

## Focused evidence and cost limits

`issue-admission.test.ts`, `issue-admission-manager.test.ts`,
`admission-compatibility.test.ts`, `admission-settlement.test.ts` and
`attempt-readers.test.ts` cover contention, delayed legacy writers, lost responses,
stale epochs, immutable identity spoofing, unknown liabilities and monotonic retry.
Recovery-reader and actual synthetic Supervisor fixtures exercise the consumers.
These are component proofs, not installed or live-provider qualification.

`admission-call-cost.test.ts` freezes a legacy two-stage storage-port baseline and
reports initial, steady retry and migration profiles separately. The measured
legacy profile is eight storage calls and two fence assertions; the new initial
profile is thirteen calls and seven assertions, and steady retry is fifteen calls
and six assertions. Importing one historical attempt is eighteen calls and eight
assertions, measured separately. A fixed two-millisecond assertion clock is
synthetic fence time, not network latency. Graph authentication, dispatch transport,
resource reconciliation and HTTP caching affect production costs. These fixtures
do not establish a call-count, live cost or throughput improvement.
