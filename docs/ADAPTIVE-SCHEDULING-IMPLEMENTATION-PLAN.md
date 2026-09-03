# Adaptive priority and burst scheduling implementation plan

Status: implementation-ready proposal

Date: 2026-09-03

Scope: Factory v2 Supervisor, local Codex workers, and explicitly authorized paid backends

## Outcome

Factory will remain local-first while using as much local CPU and memory as the host can safely
offer. When local capacity is full, it may admit the highest-priority eligible Work Items to an
explicitly authorized cloud backend, within immutable concurrency and cost ceilings. GitHub remains
the durable control plane; no GitHub Action, workflow, queue, database, or Factory service is added.

Priority changes ordering only. It can never bypass a dependency, repository trust decision,
capability check, isolation requirement, branch policy, validation requirement, backend allowlist,
or budget ceiling.

This plan replaces the current scheduling expression:

```ts
ready(objective).slice(0, policy.maxParallel)
```

with a deterministic admission controller that separates four questions:

1. Is the Work Item dependency-ready?
2. Which ready Work Item should run next?
3. Which permitted backend can run it?
4. Is there capacity and budget to admit it now?

## Non-negotiable invariants

- Dependency readiness is absolute. A blocked Work Item is never ranked or admitted.
- The compiled graph remains immutable for a run. Scheduling does not add, remove, or rewrite Work
  Items or dependencies.
- Local work is preferred for every admission cycle when it satisfies the Work Packet.
- Paid burst is disabled by default and requires all of: `cloudFallback: "explicit"`, the backend in
  `allowedPaidBackends`, a nonzero provider budget, and an enabled `burst` policy.
- An unavailable or malformed priority source falls back or escalates exactly as the immutable run
  policy says. Factory never guesses option meaning from a display name.
- Running attempts are not preempted when priority, load, or memory pressure changes. New information
  affects only future admissions.
- Capacity and paid budget are reserved under the current Director lease before launch. A competing
  Director cannot admit the same attempt or spend the same reservation.
- A temporary lack of capacity is a queued state, not `NoExecutionBackend` and not a failed attempt.
- Polling and capacity measurement are mechanical. They do not invoke a model and do not write a
  GitHub comment on every sample.
- Every admission is reconstructable from GitHub. High-frequency resource samples remain local and
  ephemeral; the sample that justified an admission is summarized in its durable receipt.
- A compiler-provided CPU or memory estimate may narrow where work can run. It cannot expand policy,
  budget, trust, or backend authority.

## Operator policy

Add three optional blocks to `RunPolicySchema`. Lower priority ranks mean higher priority. Backend
IDs and GitHub IDs are pinned values, not names discovered during a run.

```json
{
  "backendOrder": [
    "codex-cli/local-worktree",
    "codex-cli/daytona",
    "codex-cli/vercel-sandbox"
  ],
  "maxParallel": 8,
  "allowedPaidBackends": [
    "codex-cli/daytona",
    "codex-cli/vercel-sandbox"
  ],
  "cloudFallback": "explicit",
  "maxSandboxMinutes": 480,

  "priority": {
    "source": "issue-field-then-subissue-order",
    "issueFieldId": "IIF_lAHO...",
    "optionRanks": {
      "urgent-option-id": 0,
      "high-option-id": 10,
      "medium-option-id": 20,
      "low-option-id": 30
    },
    "unsetRank": 100,
    "onUnavailable": "fallback-to-subissue-order"
  },

  "capacity": {
    "mode": "adaptive-local",
    "local": {
      "maxWorkers": 8,
      "defaultCpu": 1,
      "defaultMemoryMb": 2048,
      "reserveCpu": 0.5,
      "reserveMemoryMb": 1024,
      "minimumFreeMemoryMb": 1024,
      "maxLoadRatio": 0.9,
      "maxMemoryUsageRatio": 0.85,
      "sampleIntervalSeconds": 5,
      "admissionCooldownSeconds": 10
    },
    "backendMaxParallel": {
      "codex-cli/local-worktree": 8,
      "codex-cli/daytona": 2,
      "codex-cli/vercel-sandbox": 2
    }
  },

  "burst": {
    "mode": "queue-or-deadline",
    "backendOrder": [
      "codex-cli/daytona",
      "codex-cli/vercel-sandbox"
    ],
    "maxCloudParallel": 3,
    "queueDelaySeconds": 120,
    "deadlineReserveMinutes": 60,
    "maxPriorityRank": 20
  }
}
```

### Schema semantics

`priority.source` has two values:

- `subissue-order`: all items have `unsetRank`; native sub-issue position determines order.
- `issue-field-then-subissue-order`: read the configured organization issue field, map its stable
  option ID through `optionRanks`, and use sub-issue position as the human-controlled tie-breaker.

`priority.onUnavailable` is `fallback-to-subissue-order` or `escalate`. A missing value on one issue
uses `unsetRank`; an unreadable field, wrong field type, unknown configured option, or unavailable
organization feature follows `onUnavailable`. Option display names are retained only for status
output. They never drive ordering.

`capacity.mode` is `fixed` or `adaptive-local`:

- `fixed` preserves the present worker-count behavior, bounded by `maxParallel` and
  `backendMaxParallel`.
- `adaptive-local` requires both a free worker slot and CPU/memory headroom before admitting a local
  attempt.

`maxParallel` remains the global hard ceiling across execution attempts. Independent validation has
its own existing reservations and is counted while it occupies a runtime. `backendMaxParallel`
provides a second hard ceiling per backend. Missing backend entries inherit `maxParallel`.

The three nested policy objects are strict so a misspelled safety control fails activation. Ranks
are integers from 0 through 1,000; worker and backend counts are 1 through 32; CPU values are 0
through 256, with requested/default CPU greater than zero; memory values use the existing Work
Packet bounds; pressure ratios are greater than zero and at most one; sampling is 1 through 60
seconds; cooldown is 0 through 300 seconds; queue delay is 0 through 86,400 seconds; and deadline
reserve is 0 through the Objective timeout. Cross-field validation happens before the first write.

`burst.mode` is one of:

- `never`: no paid burst.
- `saturation`: eligible immediately when the item cannot fit local capacity in this cycle.
- `queue-delay`: eligible after `queueDelaySeconds` of continuous readiness without admission.
- `deadline`: eligible when the Objective has at most `deadlineReserveMinutes` remaining.
- `queue-or-deadline`: either threshold is enough.

Local saturation is a prerequisite for every burst mode. A cloud backend is not selected merely
because it appears later in `backendOrder`. `burst.maxCloudParallel`, `maxPriorityRank`, per-backend
parallelism, capability matching, and remaining budget all have to pass. `queueDelaySeconds: 0`
means immediate spill after local saturation.

A Work Packet that is permanently incompatible with local execution follows ordinary explicit
capability routing, not burst routing. For example, an `isolated` item may immediately use an allowed
sandbox backend even when `burst.mode` is `never`. It is recorded as `remote-required`, still counts
against `maxCloudParallel` and the backend parallelism ceiling, and still requires explicit
paid-backend and budget authority. All paid execution and validation sessions count toward
`maxCloudParallel`; it is a cost/concurrency ceiling, not merely an overflow counter.

### Compatibility and defaults

- A stored policy without these blocks retains exact legacy behavior: sub-issue order, fixed
  concurrency from `maxParallel`, first compatible backend selection, and no burst.
- Existing active runs keep their stored policy and digest. They are not silently migrated.
- Parsing keeps the external optional shape for digest verification. A separate
  `normalizeSchedulingPolicy()` creates the internal effective defaults after the stored digest has
  been verified; it must not make an old run's policy hash change.
- New-run defaults become adaptive local-only after the conformance matrix in this plan passes.
  Paid burst remains `never` by default.
- The intended new local default is `maxWorkers: 8`, one CPU and 2 GiB per unannotated Work Item,
  0.5 CPU and 1 GiB reserved for the host, 1 GiB minimum observed free memory, 90% load ceiling, and
  85% memory-use ceiling. The effective worker count can be lower, including zero while the host is
  under pressure.
- Policy parsing rejects a burst backend that is absent from `backendOrder`, absent from
  `allowedPaidBackends`, not a paid backend, or missing a nonzero compatible budget.

## Priority model

### GitHub inputs

The existing Objective GraphQL snapshot remains one read per cycle. Extend each sub-issue selection
with:

```graphql
issueFieldValues(first: 100) {
  totalCount
  nodes {
    ... on IssueFieldSingleSelectValue {
      optionId
      name
      field {
        ... on IssueFieldSingleSelect { id name dataType }
      }
    }
  }
}
```

The live GitHub schema exposes `Issue.issueFieldValues`, `Issue.subIssues`,
`IssueFieldSingleSelectValue.optionId`, and `IssueFieldSingleSelect.id`. Factory therefore does not
need an N+1 REST read. It rejects a truncated value connection rather than treating an omitted value
as unset. The array index in the ordered `subIssues` connection becomes `subIssuePosition` after
confirming the ordering behavior in the live conformance test below.

When issue-field priority is enabled, activation also resolves the configured field once through
the repository owner's `Organization.issueFields` connection. It paginates until the pinned field
ID is found, verifies that it is a single-select field owned by that organization, and verifies every
configured option ID. That definition is immutable run-policy preflight data; per-cycle reads only
need the values attached to each issue.

Add a read-only `factory priority-fields OWNER/REPO` CLI command and matching MCP inspection tool.
It queries `Organization.issueFields`, prints the field node ID and each single-select option ID,
name, and GitHub option position, and emits a ready-to-paste policy fragment. It never enables the
feature or changes a value.

The implementation uses GitHub's organization issue fields, not Projects. Reordering a native
sub-issue remains the zero-configuration priority mechanism.

### Deterministic comparator

For the dependency-ready set with issue-field priority, sort by:

1. mapped issue-field rank ascending;
2. remaining critical-path length descending;
3. number of unfinished downstream items descending;
4. native sub-issue position ascending;
5. issue number ascending.

With `subissue-order`, native sub-issue position is the human priority and sorts first, followed by
critical-path length, downstream count, and issue number. This avoids claiming sub-issue ordering is
a priority control while silently allowing an automated graph score to overrule it.

Critical-path and downstream values are pure functions of the unfinished immutable DAG. They help
Factory start work that unlocks the most delivery progress without overruling an explicit human
priority.

There is no time-based rank aging in the first implementation. The graph is finite, retries are
bounded, and the work-conserving admission scan described below prevents a large high-priority item
from blocking every smaller item. Removing wall-clock aging also keeps ordering reproducible.

If a higher-ranked Work Item cannot currently fit any authorized backend, the controller records
the reason and continues scanning lower-ranked items. That is a resource-fit bypass, not a priority
change. The higher-ranked item is reconsidered first on the next cycle.

### Mid-run edits

A human may change an issue-field value or native sub-issue order while a run is active. The next
complete GitHub snapshot changes future admission order. It does not cancel or move an active
attempt. The `AttemptReserved` receipt records the rank, option ID, sub-issue position, and graph
score that the Director actually observed, so the decision remains auditable after later edits.

## Local capacity model

Add `src/scheduling/resource-sampler.ts` with an injectable `ResourceSampler` interface and a
Linux/WSL implementation. One sample contains:

```ts
interface ResourceSnapshot {
  measuredAt: string;
  logicalCpu: number;
  effectiveCpu: number;
  loadRatio: number;
  totalMemoryMb: number;
  availableMemoryMb: number;
  memoryUsageRatio: number;
  source: "cgroup-v2" | "cgroup-v1" | "host";
}
```

Measurement order:

1. Read cgroup v2 `cpu.max`, `memory.max`, and `memory.current` when finite.
2. Fall back to cgroup v1 CPU quota/period and memory limit/usage files.
3. Fall back to `os.availableParallelism()`, `os.totalmem()`, `os.freemem()`, and
   `os.loadavg()[0]`.
4. When both cgroup and host values exist, use the more restrictive effective CPU and memory.

`loadRatio` is one-minute load divided by effective CPU. It is a pressure gate, not subtracted from
resource reservations; doing both would double-count active work. Memory admission uses both a
reservation ceiling and observed free memory.

For a Work Packet with omitted resource requirements, use `defaultCpu` and `defaultMemoryMb`. For an
annotated packet, use its declared `requirements.cpu` and `requirements.memoryMb`. Normalize values
once and include them in the admission receipt.

A local admission must satisfy all of:

```text
active local workers + planned local workers < local.maxWorkers
reserved CPU + requested CPU <= effective CPU - reserveCpu
reserved memory + requested memory <= effective total memory - reserveMemoryMb
observed available memory - memory planned this cycle >= requested memory + minimumFreeMemoryMb
loadRatio <= maxLoadRatio
memoryUsageRatio <= maxMemoryUsageRatio
global active + planned active < maxParallel
```

The sampler is cached for `sampleIntervalSeconds`. After a pressure rejection, local admissions wait
for `admissionCooldownSeconds` before trying again. Active work continues. If adaptive measurement
fails, Factory admits no new local worker until a valid sample exists; it does not spend cloud money
solely because the sampler failed. Normal queue/deadline burst rules may still become true later.

Local worktrees do not provide a hard kernel resource boundary, so these are conservative admission
controls, not CPU or memory enforcement. Daytona and Vercel resource limits remain provider-enforced.

## Capacity and burst admission

Add a `CapacityLedger` that derives durable active reservations from nonterminal attempts and keeps
the current process's not-yet-visible planned reservations in memory. It exposes atomic
`tryReserve`, `release`, and `reconcile` operations. It is not a second database.

Add an `AdmissionController.plan()` pure boundary. Its inputs are the immutable policy, one complete
Objective snapshot, derived DAG, backend capability/probe results, immutable budget/capacity state,
one resource sample, and GitHub server time. Its output is a list of immutable admission proposals
plus queued reasons:

```ts
interface Admission {
  workItem: number;
  backendId: string;
  admissionClass: "local" | "remote-required" | "burst";
  admissionReason:
    | "local-capacity"
    | "capability-required"
    | "local-saturated"
    | "queue-delay"
    | "deadline";
  requirements: { cpu: number; memoryMb: number };
  priority: {
    rank: number;
    fieldId?: string;
    optionId?: string;
    subIssuePosition: number;
    criticalPathLength: number;
    unfinishedDownstream: number;
  };
  capacity: {
    measuredAt: string;
    effectiveCpu: number;
    availableMemoryMb: number;
    loadRatio: number;
    memoryUsageRatio: number;
  };
}
```

Each Supervisor cycle performs this sequence:

1. Read one complete GitHub snapshot and derive state.
2. Recover or reconcile every nonterminal prior attempt before admitting new work.
3. Compute the dependency-ready queue and deterministic priority scores.
4. Read budget usage and active attempt reservations from durable events.
5. Probe configured backends through a short-TTL probe cache.
6. Take or reuse one local resource sample.
7. Scan the entire sorted ready queue against a provisional copy of capacity. Propose every
   compatible local admission that fits.
8. Route items that cannot ever satisfy local capabilities to explicitly allowed compatible
   backends, without misclassifying them as overflow burst.
9. For local-compatible items not admitted locally, evaluate the configured burst trigger, rank
   threshold, cloud concurrency, backend capability, credentials, trust, and remaining budget.
   Propose eligible cloud admissions in priority order.
10. Under the current Director lease, create the attempt ref and budget reservation for each planned
   admission. The mutable `CapacityLedger` rechecks and reserves immediately before each commit. A
   changed capacity generation or lost CAS race removes that admission before launch and sends the
   item back through planning.
11. Launch the committed admissions concurrently and reconcile capacity and budget in `finally` and
    during restart recovery.

Local admission is attempted before cloud admission for each item and every cycle. Once a cloud
attempt starts it is allowed to finish; when local capacity opens, the next queued work prefers
local.

The Supervisor maintains an `activeExecutions` map instead of awaiting an entire fixed wave. After
committing all currently valid proposals, it waits for the first of: an active execution settling,
the next poll/capacity-sample deadline, cancellation, or lease loss. It then removes settled work,
reconstructs a fresh snapshot, and immediately refills every safe slot. One slow Work Item therefore
cannot leave the other local or cloud slots idle. Promise outcomes are captured in the map so a
rejection cannot become unhandled while the Supervisor is polling.

### Durable queue time

Add a `WorkItemQueued` scheduling event. It is written once when a Work Item is first continuously
dependency-ready but cannot be admitted. Its GitHub server timestamp is the queue-delay clock. A
later `AttemptReserved` event or loss of readiness ends that queue episode; no separate dequeue
write is needed. Repeated polling produces no new event.

This event is stored on the Work Item as a trusted Factory envelope. It does not count as an
implementation attempt or consume retry budget. Recovery reconstructs queue time without trusting
the local clock.

### Backend evaluation

Refactor `BackendRegistry.select()` into two layers:

- `evaluate()` returns every backend in policy order with its capabilities, cached probe, cost
  class, and permanent rejection reasons.
- the admission controller chooses the local or burst candidate and applies temporary capacity and
  budget conditions.

Keep `select()` as a compatibility wrapper until all callers migrate. Introduce a distinct
`BackendAtCapacity` queued reason. Permanent incompatibility or missing authority may escalate;
temporary saturation, cooldown, a queue-delay threshold not yet reached, or a currently exhausted
parallelism slot must wait.

Probe cache entries expire after 30 seconds by default. Authentication and availability failures are
reported in queued/status evidence and retried with bounded backoff. A probe never creates a paid
resource.

### Atomicity and recovery

Extend `AttemptReserved` with optional scheduling fields rather than adding a second admission
comment:

```text
admissionClass, admissionReason
requestedCpu, requestedMemoryMb
priorityRank, priorityFieldId, priorityOptionId, subIssuePosition
criticalPathLength, unfinishedDownstream
capacityMeasuredAt, effectiveCpu, availableMemoryMb, loadRatio, memoryUsageRatio
```

Old receipts remain valid because the fields are optional. New admissions always populate them.
Capacity reservations use the attempt identity and phase as their idempotency key. Execution
capacity is held from `AttemptReserved` until worker cleanup has completed and `AttemptCollected` is
recorded, or until an earlier terminal event. If cleanup is ambiguous, capacity stays reserved for
recovery. Fresh isolated validation acquires a separate backend-capacity reservation before it
starts and releases it at `ValidationRecorded` or validation reconciliation. Add `CapacityReserved`
and `CapacityReconciled` events for the validation phase; the execution reservation itself remains
derivable from the attempt lifecycle. `AttemptDeferred` releases execution capacity and still does
not burn retry budget.

The new event shapes are deliberately small:

```text
Scheduling/WorkItemQueued:
  workItem, directorEpoch, policyDigest, reason, observedPriorityRank,
  observedSubIssuePosition

Capacity/CapacityReserved | Capacity/CapacityReconciled:
  workItem, attempt, phase, backend, requestedCpu, requestedMemoryMb,
  directorEpoch, policyDigest, reason?
```

Their shared event envelope supplies run ID, sequence, Objective, and GitHub server timestamp.
`CapacityReconciled` is idempotent by run, Work Item, attempt, phase, and backend.

On restart, Factory first reconciles every nonterminal attempt. It treats a prior local process group
as possibly live and uses the deterministic attempt identity to terminate or prove it absent before
release. A provider-backed attempt is observed or cancelled using its provider resource ID before
its reservation is released. No new capacity is admitted from a possibly stale ledger.

Budget reservation stays coupled to the attempt reservation under the same lease. Ambiguous provider
launches retain their reservation until observation/reconciliation proves the outcome. Capacity or
budget exhaustion never widens policy and never silently switches providers.

## File-level implementation

### 1. Protocol and policy

Modify:

- `src/protocol/policy.ts`
- `src/protocol/events.ts`
- `src/protocol/worker-packet.ts`
- `src/types.ts`

Add strict schemas for `priority`, `capacity`, and `burst`; preserve the external policy shape for
digest verification; normalize legacy policies into a separate effective internal form; validate
cross-field paid-backend invariants; add scheduling/capacity events and optional admission receipt
fields; and expose normalized resource requests. Keep the external v2 envelope compatible.

Tests:

- `test/policy.test.ts`
- `test/v2-protocol.test.ts`
- `test/worker-packet.test.ts`

Acceptance: every invalid cross-field combination fails before `FactoryRunStarted`; old stored
policies and receipts still parse; a checked-in legacy-policy fixture retains its exact pre-change
digest; and policy digests remain stable for identical input.

### 2. GitHub priority ingestion and inspection

Modify:

- `src/github.ts`
- `src/cli.ts`
- `src/mcp-server.ts`

Add:

- `src/scheduling/github-priority.ts`

Extend the single GraphQL snapshot, enforce complete pagination bounds, normalize matching
single-select values by field ID and option ID, capture sub-issue position, and add the read-only
priority-field inspection command/tool.

Tests:

- GraphQL fixtures for no feature, unset value, expected value, unknown option, wrong data type,
  truncated connections, and reordered sub-issues.

Acceptance: a priority edit changes the next snapshot's ready ordering without any GitHub write from
Factory; default sub-issue ordering works in a repository with no organization issue fields.

### 3. Pure priority and graph scoring

Add:

- `src/scheduling/priority.ts`
- `src/scheduling/graph-score.ts`

Implement rank normalization, the exact comparator above, longest remaining DAG path, downstream
count, and resource-fit bypass evidence. Keep these modules free of I/O and wall-clock reads.

Tests:

- Deterministic tie-breaking, diamond and disconnected DAGs, retries, closed descendants, explicit
  priority overriding graph score, sub-issue reordering, and a large item not blocking smaller work.

Acceptance: randomized input order produces identical output; blocked items can never appear in the
ranked ready set.

### 4. Linux/WSL resource sampling

Add:

- `src/scheduling/resource-sampler.ts`
- `src/scheduling/cgroup.ts`

Implement cgroup v2, cgroup v1, and host fallbacks behind injectable file and OS readers. All parsing
is side-effect-free and unit-testable. Do not shell out during polling.

Tests:

- Quota `max`, fractional CPU quotas, finite and unlimited memory, malformed files, WSL-style host
  fallback, pressure ceilings, cache expiry, and cooldown.

Acceptance: the effective values always choose the tighter observable limit; malformed or missing
measurements fail closed for new local admissions without terminating active work.

### 5. Capacity ledger and backend candidates

Add:

- `src/scheduling/capacity-ledger.ts`

Modify:

- `src/execution/registry.ts`
- `src/control/budget.ts`
- `src/control/attempts.ts`

Implement backend candidate evaluation, probe caching, global/per-backend/resource reservations, and
idempotent reconstruction from attempt events. Distinguish permanent incompatibility from temporary
capacity.

Tests:

- Concurrent reservations, release in every terminal state, restart reconstruction, stale provider
  attempts, global and backend ceilings, no double spend, and probe-cache expiry.

Acceptance: two concurrent commit attempts cannot both reserve the last slot; a proposal made from
a stale capacity generation is rejected before launch; temporary saturation does not create an
attempt or consume its retry budget.

### 6. Admission controller

Add:

- `src/scheduling/admission.ts`

Implement the full work-conserving scan, local-first selection, every burst mode, priority threshold,
budget checks, and structured queued reasons. The core planner takes injected snapshots and returns
data; it does not write GitHub or launch workers.

Tests:

- Table tests across priority, dependency, capacity, queue time, deadline, budget, trust, and
  backend capability dimensions.
- A fixture with eight ready items, three safe local slots, two cloud slots, and a zero-second burst
  delay must admit the first three compatible items locally, the next two eligible items to cloud,
  and leave the rest queued.
- The same fixture with a 120-second delay must launch only local-compatible work until the durable
  delay expires.

Acceptance: no plan can exceed any hard ceiling; with burst disabled, the controller never returns a
paid backend for a local-compatible item merely because local capacity is zero. Capability-required
remote work still follows its explicit backend and budget policy.

### 7. Supervisor integration and recovery

Modify:

- `src/supervisor.ts`
- `src/control/v2-state.ts`
- `src/control/receipts.ts`
- `src/state.ts`

Replace fixed waves with admission planning and a continuously refilled `activeExecutions` map.
Write queue transitions only when state changes. Commit attempt and budget reservations under the
lease before launch. Pass a pinned backend into execution instead of reselecting it. Release
in-memory reservations in `finally`; rebuild durable state before new admissions after restart.

Tests:

- Lease loss between plan and commit, stale capacity generation, CAS collision, crash after attempt
  reservation but before launch, ambiguous provider launch, cancellation, `AttemptDeferred`,
  priority edit between cycles, local pressure rising after launch, and one straggler while other
  slots repeatedly drain and refill.

Acceptance: every launched worker has exactly one preceding durable reservation and every terminal
attempt releases capacity exactly once.

### 8. Status and operator documentation

Modify:

- `src/cli.ts`
- `src/mcp-server.ts`
- `README.md`
- `docs/DESIGN.md`
- `docs/CONFORMANCE.md`
- `skills/director/SKILL.md`

Status output must show the ready queue in effective order; configured and effective local capacity;
active slots by backend; each queued reason and `queuedSince`; observed priority source; burst
trigger state; and reserved/remaining paid budget. It must never expose credentials or dump provider
responses.

Acceptance: an operator can answer “why is #42 not running?” and “why did #43 use Daytona?” from one
status call and the durable receipt.

### 9. Live conformance and default flip

Run these gates in disposable repositories and paid provider accounts with explicit spend approval:

1. Reorder native sub-issues through GitHub, verify the GraphQL order changes, and verify the next
   Factory admission follows it.
2. Enable the organization Priority field, change an option while Factory runs, and verify the next
   admission observes its stable field/option IDs.
3. Run CPU- and memory-heavy local fixtures on WSL2 and native Linux under host-only, cgroup v2, and
   constrained cgroup configurations. Verify admissions stop before configured headroom is crossed.
4. Kill and restart the Supervisor with local and provider attempts in each lifecycle phase. Verify
   no duplicate worker, slot, attempt, or budget reservation.
5. Burst a bounded Objective to Daytona and Vercel separately. Verify local-first placement, provider
   concurrency, TTL, egress, credential brokerage, cost reconciliation, and cleanup.
6. Exhaust sandbox minutes and cloud concurrency while local is full. Verify work remains queued and
   later returns to local rather than escalating or spending past the ceiling.
7. Run two Directors against the same Objective. Verify the lease and attempt refs admit each Work
   Item once.

Only after all seven pass does `DEFAULT_RUN_POLICY` switch new runs to `adaptive-local`. The default
continues to contain no paid backend and `burst.mode: "never"`.

## Implementation dependency graph

```text
Policy/events ───────┬── GitHub priority ingestion ── Priority/graph scoring ──┐
                     │                                                         │
                     ├── Resource sampler ──────── Capacity ledger ────────────┤
                     │                                                         ▼
                     └── Backend candidate API ─────────────────────── Admission controller
                                                                                 │
                                                                                 ▼
                                                                   Supervisor + recovery
                                                                                 │
                                                                                 ▼
                                                                     Status + conformance
```

Work may proceed in parallel only where the graph permits, but the Supervisor integration does not
start until the pure controller, capacity ledger, and receipt schemas are complete.

## Definition of done

This feature is done when all of the following are true:

- Dependency-ready work is deterministically ordered by configured GitHub priority with native
  sub-issue position as the zero-config fallback.
- Local concurrency adapts downward and upward from effective Linux/WSL CPU and memory without
  exceeding the immutable global or per-backend caps.
- Optional cloud burst starts only after its configured trigger and only inside explicit provider,
  trust, concurrency, and budget authority.
- Temporary capacity never burns an implementation attempt or causes a false escalation.
- Admission, restart, cancellation, lease-race, provider-ambiguity, and budget fault tests pass.
- One live WSL/Linux local matrix and one real run on each claimed burst provider pass.
- `npm run typecheck`, the full test suite, package verification, production audit, and clean-install
  MCP startup pass.
- The conformance document records measured evidence and the draft release remains draft until the
  live gates are complete.

## Explicitly out of scope

- GitHub Actions or repository workflows as a scheduler.
- A Factory-hosted service, database, or queue.
- Priority-based preemption of a running coding or validation session.
- Automatic purchase, credential creation, provider signup, or budget increases.
- Compiler-selected paid execution or compiler-selected priority authority.
- Kernel-enforced limits for local worktrees. Use an explicitly authorized sandbox backend when a
  hard isolation or resource boundary is required.

## GitHub references

- [REST API for sub-issues](https://docs.github.com/en/rest/issues/sub-issues) documents relative
  sub-issue reprioritization.
- [Managing issue fields in an organization](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/managing-issue-fields-in-your-organization)
  documents the organization Priority field and its customizable options.
- [Adding and managing issue fields](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-and-managing-issue-fields)
  documents issue-field values on issues and API access independent of a Factory workflow.
- [GraphQL issues reference](https://docs.github.com/en/graphql/reference/issues) documents the
  issue-field and native sub-issue surfaces used by the snapshot.
