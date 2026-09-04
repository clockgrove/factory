# Continuing an escalated Objective

Status: implementation in progress; successor execution is not yet available.

## Available inspection

Use `factory_recovery_plan` through MCP or `factory recovery-plan OWNER/REPO#NUMBER` through the
CLI to inspect graph/projection bindings, attempt reservations, observed PR identities, and
historical accounting. This is a bounded read-only assessment, not an immutable approved recovery
plan. It grants no execution authority. Missing source identity, changed evidence, and unavailable
observations remain blockers; provider resource cleanup is not inferred from terminal receipts.

The accounting report aggregates the explicitly inspected history, not an authorized predecessor
chain. It retains source run/usage identities and distinguishes recorded subtotals from unknown
usage. Successor requests, increased allowance, adoption, and actual resource reconciliation remain
implementation tasks below.

The current classifier conservatively blocks multi-parent artifact ancestry and merged publications
whose historical base identity cannot be proved. An exact rebase review checkpoint may establish
semantic evidence without requiring a duplicate acceptance receipt. Static blocker codes explain
missing evidence without returning issue bodies, review prose, or raw provider errors. The report's
read counter measures cached logical evidence operations, not total HTTP requests; snapshot
hydration has its own bounded inspection mode.

Native-stack selection does not require independent sibling PRs to have a stack number. The
assessment reconstructs delivery units from the immutable graph and authenticated selection:
sibling units use ordinary trunk-base checks, while actual stack units require exact membership.

## Implemented authorization foundations

The immutable recovery-plan document binds the proposed successor, exact predecessor terminal,
source-history prefix, graph/projection, item evidence, accepted policy, explicit allowance
increments, and any unknown-usage acknowledgement. Its content-addressed ref is a durable proposal,
not execution authority. Changed source evidence requires a different acknowledged plan.

`RecoveryRequested`, `RecoveryConsumed`, and `RecoveryAdoptionCompleted` have a separate event kind. Successor start records name
the exact request, plan digest, and predecessor; authenticated reader bindings reject a changed
actor, terminal, repository, provenance, policy, or base. The cumulative chain verifier requires
explicit prior-plan links and independently observed immutable consumption claims. It includes
graph-only historical failures, preserves original usage identities, and never returns execution
authority. Plan metadata and full source-event prefixes have separate digests so a missing budget
receipt cannot be hidden by unchanged run boundaries.

Immutable claims bind one predecessor to one exact acknowledged plan and transaction seed. Their
commit parent binds the immutable plan; every mutation rechecks the lease. Lost responses are
reconciled by reading the same ref, not replacing a claim. The persisted timestamp, sequence, and
evidence digests reconstruct the same start, consumption, and adoption-completion envelopes after
a restart. A pure replay inspector accepts only an exact ordered transaction prefix: missing
earlier receipts, conflicting retries, late source receipts, or unexpected successor effects block
replay. Its next-event result is descriptive, never permission to write or launch.

A read-only evidence resolver independently reloads plan, graph/projection, claim, original
reservation, validation, review, and publication identities. It keeps source attempts separate
from the controlling run and observes changed heads/bases without rewriting historical receipts.
Even verified source bindings do not prove resource cleanup or authorize execution.

The internal adoption coordinator now composes the immutable loaders, exact-prefix inspection,
chain verifier, source resolver, cumulative accounting gate, and resource observations. It checks
both repository and Objective leases before every mutation and reloads prerequisites between
adoption steps. Lost responses are reconciled against the exact persisted envelopes. A changed
source, competing request, unresolved write, missing reservation, or lease loss leaves a blocked or
pending transaction; it never fabricates a terminal successor or rewrites its predecessor.

The accounting gate evaluates prospective demand against cumulative native-unit usage. A zero-model
adoption does not consume tokens or reset an exhausted model ceiling. Outstanding reservations,
unknown usage without its exact acknowledgement, and unrelated accounting errors remain blockers.

New CLI/SDK local handles record an application-specific hash of Linux machine/user/boot/namespace
identity, persisted in the started receipt. A bounded read-only process observer can distinguish a
matching active worker from absence on that exact host under the trusted-local, marker-preserving
execution contract. Raw machine IDs and process environments are never returned or persisted.
Old unbound receipts, changed boots/namespaces, reused PIDs, unreadable or changing process views,
and validation processes without their own identity remain unknown. This is not proof of sandbox
or managed-agent cleanup, nor does it release an outstanding billable reservation.

These contracts are not yet a supported continuation command. Validation/provider reconciliation
and integration of the coordinator and resolver into scheduling, publication, accounting, and
state reconstruction remain below. The ordinary run manager explicitly rejects successor
execution until those pieces are connected. Pending claims must be reconciled to an evidenced
outcome; they must not be deleted or overwritten to try another plan.
Validation and budget writers reject reservations from a different run, Objective, policy, or
future lease epoch; successor effects cannot be appended to terminal predecessor history.

## Outcome and observed gap

An operator can resolve an escalation and explicitly continue the same Objective, retaining its
Work Items, valid artifacts, PRs, and complete accounting. Factory then runs unattended to closure
or the next evidenced boundary. Restarting must not recompile completed work, duplicate a PR,
reinterpret an old validation receipt, or silently replenish a budget.

The installed conformance run reached independently validated PRs and escalated on an external
check. A new run can copy its graph, but publication, reservation, and integration recovery select
only the current run's receipts. Resume and retry correctly reject terminal runs. Ordinary
activation is therefore not evidence-preserving continuation of executed work.

The containment change rejects that activation before creating its run/budget ledger. It checks
Objective and child receipts, existing PRs, completed issues, managed-agent assignment history,
and reservation refs whose comments may be missing. It repeats inspection under the lease to
catch changed startup state, including a formerly active run becoming terminal. Apparent fresh
Objectives are inspected too: a deleted start can hide its authenticated comments without removing
its reservation refs. Graph-only retries without execution remain possible. This guard
does not implement adoption or close the recovery gate.

## Boundaries

- Keep the predecessor terminal and immutable. Same-run crash restart and bounded retry retain
  their existing meanings. Replanning a different graph is separate.
- Require an authenticated operator request; repaired checks or available credentials are not
  authority. No automatic budget increases, model changes, or paid-provider selection.
- Never rewrite source run IDs or fabricate successor attempts from predecessor receipts.
- Bind repository, Objective, terminal receipt, graph/projection, policy, resource identities,
  artifact, and current PR head/base before admitting work.
- Reconstruct everything authoritative from GitHub. Local caches remain optional.
- Retain prior observed usage and unavailable-usage boundaries. Empty successor ledgers do not
  imply unspent Objective allowance.
- Changed heads/bases invalidate affected validation and semantic review. Every merge rechecks
  current branch policy, checks, mergeability, topology, and leases.

## Implementation tasks

### 1. Read-only recovery assessment

Implement a shared bounded assessment for chat/MCP and CLI inspection. Classify each Work Item:
already integrated, reusable publication, recoverable artifact, unfinished, resources requiring
reconciliation, or blocked with a precise reason. Assessment grants no execution authority.

Read all relevant history, not just the latest empty failure. Authenticate run actors and receipts
with existing reader rules. Load graph/projection refs and bound blobs; verify exact issue-node
mappings, packets, scope, and dependencies. Enumerate reservation refs by Objective, including
children no longer visible in the projection. Missing or altered identities are errors.

Resolve current PR repository/node identity, head/base/tree, merged/closed state, stack membership,
linked issue, and original publication. Observe resources without cancelling or creating them.
Unavailable reads must not be interpreted as absence.

Acceptance: fixtures cover every classification, removed/replaced children, forged receipts,
missing refs, changed heads/bases, executed runs followed by empty failures, and unknown resources.
No writes or model calls are allowed.

### 2. Successor authority and cumulative accounting

Define a versioned immutable recovery plan and authenticated request naming the predecessor and
terminal-event identity, plan digest, expected base, graph/projection digests, accepted policy,
request ID, and activating actor. Changed assessment requires a new acknowledgement. Reusing a
request ID with different semantics fails closed.

Use cumulative Objective allowances across the acknowledged predecessor chain. Carry observed
usage and outstanding reservations by original `(runId, usageId)` identity: duplicates do not
double-charge and identical usage IDs in different runs do not collapse. Preserve unknown usage.
Unchanged ceilings are the default; an increase requires explicit authority recording the increment
and resulting total. Carry implementation attempt counts; continuation cannot bypass retry limits.
Cleanup and independent validation require their own remaining native-unit authority.

Acceptance: exhaustion blocks the next invocation; concurrent in-flight usage remains accounted;
repeated requests and multi-successor chains cannot multiply allowance. Test old records with absent
breakdowns without inventing zeros, and reject ambiguous or cyclic predecessor chains.

### 3. Fenced adoption transaction and shared evidence resolution

Under repository and Objective leases, re-read the request, terminal predecessor, graph, current
heads, policy, and remaining allowance. Stale plans require acknowledgement, not automatic replans.
Fence competing requests so exactly one successor consumes the acknowledged predecessor and
request retries find that successor.

Persist the immutable plan before execution. Adoption receipts reference source run, attempt,
reservation, artifact, validation, and publication identities without changing source records.
Implement one evidence-resolution layer shared by state derivation, publication, ordinary/native
stack integration, summaries, and replay. Do not scatter permissive cross-run searches across them.

Acceptance: inject lost responses and process death around every plan/ref/request/start/adoption
write. Restart reconstructs identical bindings, creates no duplicate attempt or PR, and admits
nothing until adoption and accounting agree. Test competing controllers and recovery requests.

### 4. Resource and delivery reconciliation

Find predecessor local process groups and provider resources through authenticated deterministic
identities. Confirm terminal/cleanup state before replacement or capacity release. Cancellation
acknowledgement alone is insufficient. Retain reservations for unknown or billable resources;
a terminated Supervisor is not evidence that a paid resource stopped.

Reuse unchanged artifacts/publications through the shared evidence resolver. Already merged work
must still match acceptance and issue identity; lost integration receipts are repaired idempotently.
Closed-unmerged or foreign PRs require an explicit supported action, not implicit reopening or
replacement. Changed heads/bases follow the existing scope, independent-validation, and semantic
review pipeline. Do not launch a worker to reconstruct an available verified artifact.

Acceptance: ordinary and native-stack fixtures cover partial publication, merged-but-unrecorded
work, stale descendants, vanished resources, cancellation, failed checks, conflict, and external
edits. Cleanup is bounded and cannot target another run's or operator's resources.

### 5. Installed-product qualification

Build and install through the documented plugin flow, then use the supported recovery command on
the private disposable Objective. Do not imitate the missing command with hand-written GitHub
mutations. Obtain explicit additional allowance before exceeding the accepted ceiling; fixing
provider access alone does not authorize another invocation.

Prove existing publications are reconciled without duplicate implementation, the dependent join
runs only when dependencies are safely available, all validated work merges, and Factory closes
the Objective. Repeat interruption during adoption and integration, reconstruct status/economics
in a fresh process, and verify no orphan process, resource, lease, or billable reservation remains.

Sanitize evidence and bind it to the exact installed commit/bundle digests. Record observed tokens,
available input/cache/output breakdowns, model-call counts, attempts, elapsed execution, and
validation/integration time. Compare reuse against observed prior evidence, not estimated savings.

## Parallel execution and completion

Assessment and accounting fixtures may proceed independently after agreeing the request/plan
contract. Transaction and evidence-resolution changes share that contract and integrate together.
Resource reconciliation and delivery tests can then run in parallel. Installed live qualification
follows deterministic and fault tests.

This closes only the terminal-recovery portion of the [delivery plan](DELIVERY-PLAN.md).
Daytona burst, both managed agents, native-stack/host matrices, publication, and published
installation remain obligations in [CONFORMANCE.md](CONFORMANCE.md).
