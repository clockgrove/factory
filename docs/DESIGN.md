# Factory — Design

This document describes Factory's architecture, execution model, and safety boundaries.
See the [delivery plan](DELIVERY-PLAN.md) for implementation tasks and
[`CONFORMANCE.md`](CONFORMANCE.md) for verification results and remaining gaps.

## Product contract

Factory is a catalyst and multiplier for an indie developer or small trusted team. It turns one
developer, one computer, and the AI agents they already use into a coordinated software studio. It
does not replace a coding agent: it compiles a human Objective into native GitHub Work Item
sub-issues, records dependencies with native `blocked by` relationships, schedules ready work,
executes it through policy-approved agent backends, independently validates the result, publishes
and integrates acceptable pull requests, and releases newly unblocked work until the Objective is
done.

Factory optimizes validated progress per dollar and per hour. It saves frontier-model cost first by
improving decomposition, bounding repeated context, avoiding conflicting work, reusing durable
evidence, and making semantic calls only at judgment boundaries. Model downgrading is an optional
policy lever, not the product premise.

The contract is:

- GitHub is the durable, versioned control plane: Objectives, Work Items, dependencies, authenticated
  request/event comments, control refs, leases, pull requests, checks, and audit evidence.
- Factory has no required private database, queue, lease service, webhook receiver, or hosted
  control plane.
- The installed plugin and an explicitly started local process are sufficient. The target unattended
  runtime is one deliberately installed repository controller on one laptop or desktop. Factory
  orchestration never requires a Factory GitHub Action or repository-specific Factory
  configuration. An explicitly selected GitHub-managed coding agent may consume GitHub Actions
  minutes under the provider's runtime and billing boundary; that is not a Factory scheduler
  workflow.
- Trusted local compute is the default. Paid sandboxes and GitHub-managed coding agents are opt-in.
- Agent chat through skills and MCP tools is the Factory human interface. GitHub supplies the visual
  issue, diff, evidence, review, and merge surface; Factory adds no custom UI.
- Native GitHub stacked pull requests are the preferred delivery shape for linear code dependencies.
  Independent work remains sibling PRs, and multi-parent joins wait and start a new stack.
- Unchanged-state polling is mechanical and model-free. Model calls occur only for compilation and
  semantic review; retry and escalation boundaries remain mechanically policy-bounded.
- Workers are untrusted producers of artifacts. They never own GitHub publication, integration, run
  state, budget state, or Director authority.
- Minimal human involvement is the goal, but escalation is correct when policy, safety, budget,
  platform constraints, or evidence prevent safe autonomous progress.

## Scope

Factory targets Linux. Its environment matrix is:

- native Linux on a laptop, desktop, or developer workstation;
- a Linux distribution under Windows WSL2, with Factory state and repositories in the Linux
  filesystem; and
- a Linux guest hosted by macOS, with the controller and workers running inside that guest.

Windows and macOS may host or access the Linux environment, but native Win32 and native Darwin
process management, worktrees, credential handling, and service lifecycle are not supported targets.
Coordinating a pool of multiple local computers is also out of scope.

The product scope includes both the Agent Plugins package and the `@clockgrove/factory` npm
CLI/controller, Codex SDK local execution with Codex CLI fallback, Daytona sandbox burst, GitHub
Copilot and OpenAI Codex managed-agent integration targets, and regular or native stacked
pull-request delivery. Support is capability-specific, not a promise that every provider exposes
identical APIs. The Codex managed profile is currently unavailable: it needs a supported actor and
provider-specific lifecycle binding, not a display name or Copilot API substitution. This limits
that provider; it does not block Factory as a whole. Paid backends always require explicit immutable
authority and budgets; inclusion in the package never makes cloud execution the default.

Factory is an open-source orchestrator, not a reseller or billing service. Users retain their own
paid-provider accounts and relationships. Unsupported provider features are documented, handled by
a supported workaround, or exposed as a specific human action. An unavailable interface cannot be
reported as implemented or qualified. Missing credentials are configuration requirements, not
evidence that a provider interface is unsupported. Claimed execution capabilities still require
their corresponding qualification evidence.

Durable App Server sessions are a supported explicit local route and retain required WSL2
qualification. They do not replace the SDK/CLI default chain. The
[session contract](CODEX-APP-SERVER-SESSIONS.md) specifies exact terminal recovery and the pinned
provider's unavailable cold-repair accounting subscription.

Labs contains Vercel Sandbox and additional harness/provider experiments. Labs
adapters may reuse the production contracts and tests, but they are not release blockers and must not
be selected implicitly. The boundary and its rationale are recorded in
[`decisions/0007-product-scope.md`](decisions/0007-product-scope.md).

## Component map

```text
                            GitHub
      Objective / Work Items / dependencies / run and attempt events
                  refs / commits / pull requests / checks
                               ▲
                               │ durable, versioned control state
                               │
               Local Factory repository controller
      discover / lease / schedule / budget / retry / recover / integrate
                     │                    │
                     │ judgment           │ execution
                     ▼                    ▼
             Management Backend     Execution Backend registry
             compile / review        capability-checked bundles
                                             │
                                    ┌────────┼──────────────┐
                                    │        │              │
                           local worktree  sandbox     GitHub managed
                           harness or CLI  + CLI       coding agent
```

The Supervisor owns deterministic control. A Management Backend is invoked only for a bounded
semantic decision. Execution backends are tested capability bundles, not arbitrary agent/runtime
cross-products.

## Activation and restart

The target unattended entry point is one controller per local checkout:

```text
factory controller run OWNER/REPO --repo /absolute/path/to/repository
```

An explicit chat/MCP activation writes a durable request and returns; the controller discovers it,
acquires the Objective lease, and continues without holding the chat turn open. The
controller shares one CPU, memory, backend, and GitHub-rate-limit pool across active Objectives.
The immutable controller ceiling defaults to two Objectives (configurable 1–32); fair admission
allows dependency-ready regular or native-stack workers to run concurrently within shared limits.
Activations beyond that ceiling remain durable and queued. Plugin installation never starts or installs the controller;
service installation is a separate explicit user action.

The unattended service uses a repository lease only to elect its discovery scheduler. Its identity
is an observation, not permission for an Objective mutation. Independent foreground sessions acquire
their own Objective leases and share atomic capacity reservations with the service. A crashed service
does not prevent those sessions from starting unrelated Objectives. Process-local queues and cursors
never survive as authority.

Losing that election retires discovery, new activation and recovery dispatch, election-scoped
observations, and explicit shared-capacity configuration. It does not abort an already-dispatched
Objective whose own current writer epoch still authorizes execution. The retired controller awaits
every such Supervisor through completion, failure and cleanup; a successor may immediately discover
other eligible Objectives, while Objective lease CAS and the shared-capacity ledger prevent duplicate
ownership or capacity release by inference. Explicit service shutdown and user cancellation still
propagate to their scoped execution. Credential, account, quota, circuit and other platform-safety
failures retain their stop or backoff behavior rather than being treated as election handoff.

The foreground compatibility entry point remains:

```text
factory run OWNER/REPO#OBJECTIVE --until-terminal
```

It uses the same application services for one Objective and remains useful for diagnostics, one-off
runs, and clients that cannot install a local service.

While the controller is alive, no scheduler outside Factory is required. A powered-off host cannot
wake itself. The supported lifecycle uses a user-authorized `systemd` service inside Linux, including
WSL2 or a Linux guest on macOS. Native `launchd` and Windows Task Scheduler lifecycle adapters are
out of scope. A new process reconstructs everything durable from GitHub.

The detailed implementation tasks are in
[`INDIE-FACTORY-IMPLEMENTATION-PLAN.md`](INDIE-FACTORY-IMPLEMENTATION-PLAN.md).

## GitHub quota discipline

Factory treats GitHub API capacity as a shared control-plane budget, not as an implementation-attempt
failure. The complete Objective snapshot remains a bounded GraphQL query because native sub-issue,
dependency, pull-request, and event relationships must be read consistently. A process pays one
small cardinality preflight for an Objective and caches that bound; the detailed query detects a
changed `totalCount` and refreshes the bound before it can return a partial graph.

The detailed query also returns its own primary GraphQL cost, remaining balance, and reset time.
Before acquiring a run lease and again before launching a wave, the Supervisor requires a
conservative reserve for snapshots, exact-CAS lease renewals, publication/recovery mutations, and a
full Work Item timeout. Insufficient headroom raises a retryable platform-unavailable result before
new work is admitted; it never consumes an implementation attempt.

High-volume lifecycle and budget receipts are written through the GitHub issue-comments REST API,
whose destination issue number is derived from the validated Factory event envelope. Exact custom-ref
fencing remains on GraphQL `updateRefs` because the REST ref API does not provide equivalent CAS.
Already-adjacent budget reconciliations for one lease, attempt, and destination may share one comment;
each retained envelope keeps its exact sequence and idempotency identity.
Both API surfaces still share Factory's circuit breaker, concurrency limiter, content-creation pacer,
and secondary-rate-limit handling. Unchanged idle state is polled no more often than once per minute
by default, while active local-worker cancellation uses the cheaper REST comments path.

Primary quota observations come from GitHub's response headers and are cached per credential and
resource; Factory does not poll `/rate_limit` to reconstruct a fresher-looking answer. GitHub does
not expose remaining secondary content-generation quota, so that plane is reported separately as a
local estimate with explicit confidence. The estimate counts only actual transport attempts,
smooths admission below GitHub's documented outer ceiling, reduces throughput after real 403/429
secondary feedback, and recovers gradually after successful transports. Octokit's internal retries
are disabled so every retry returns through Factory's shared pacing and circuit controls.
Process-local mutation counters include their scheduler-lifetime measurement window and remain
outside durable run economics. A reader process cannot attribute its own counters to a reconstructed
run; without durable run-bound evidence, that historical measurement is explicitly unavailable.

Recovery may retain bounded immutable Git content by exact object identity across repeated proof
calls. It never caches mutable refs, authenticated event snapshots, PR/base state, leases, physical
absence or an admission decision. A cache hit saves a content read, not an authority check; failures
and misses are not retained, and cached response timestamps are not fresh server-time evidence.

Within one complete authenticated repository read, recovery does build a bounded event observation:
it safely materializes every envelope, applies the full protocol and persisted-material validation,
canonicalizes and digests it once, and deeply freezes the parsed result. Nested chain, accounting,
evidence, publication, outcome, resource, and sibling proofs share that observation or an attenuated
view of its members. Membership is snapshot-local and non-authoritative: structurally equal clones,
independent trailers and events from any later repository read must be fully validated again. The
observation is discarded as a unit on abort or integrity failure and is never global, persisted, or
used to skip a fresh authority read.

A classified quota refusal imposes a shared retry boundary, including during controller bootstrap,
discovery and lease retirement. An in-flight success cannot clear a later retry deadline. After
settling the current generation, the same process waits abortably and reconstructs ownership; it
does not reuse a stale lease or rely on service restarts to retry. Authentication and invariant
failures remain errors. The controller honors GitHub's [rate-limit response headers](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#exceeding-the-rate-limit),
not a contradictory later balance from another observation.

Local Codex model-provider quota refusals are a separate plane from GitHub REST/GraphQL rate limits
and Factory's own model-token allowance. After a durable model-dispatch marker, only captured narrow
Copilot entitlement messages may produce an invocation-bound `ProviderQuotaBlocked` event. The
durable event and backend contract are provider-neutral: they carry a bounded provider identity,
canonical redacted message and optional HTTPS action URL. The GitHub Copilot adapter alone owns the
captured-message classifier and maps those diagnostics to its provider identity, safe summaries and
supported settings URL. Provider-reported usage is reconciled exactly once against its own invocation
when present and otherwise remains unknown. The run stops without retry. Until terminal drain is
durable, status/explain retain monitoring so admitted attempts and resources cannot be abandoned;
after the terminal receipt they tell the initiating operator to stop monitoring until quota is
restored and an explicit recovery is requested. Pre-dispatch preparation failures and transient
transport errors do not create this gate.

The selected model is a provider-neutral durable gate populated by provider adapters. Keeping
Copilot literals in the shared event was rejected because every additional model provider would
require a protocol and lifecycle edit; treating quota text as an ordinary backend failure was also
rejected because it loses the non-retryable, human-action state. New adapters may emit the shared
gate only after converting captured diagnostics into bounded canonical metadata; they must not pass
through arbitrary provider output.

Model quota is protected at retry boundaries as well. After an artifact has passed host scope,
secret, clean-apply, and sensitive-path checks, the running Supervisor may retain it in a bounded
32 MiB in-memory cache, with at most 512 MiB of separately leased file-backed payload content.
Parallel pipelines retain independent content leases; completing one does not delete another's
active content. Pending durable-transfer recovery data is separate from this optimization cache.
A retry at the same base SHA is seeded with that complete patch and receives
the bounded failure diagnostic, so it repairs prior work instead of recreating it. This cache is a
non-authoritative optimization: it cannot change derived state, is lost on restart, is never used by
a provider-managed publication backend, and every resulting complete patch is independently
revalidated from the pinned base.

The shared local CLI/SDK worker prompt also carries the compiler's bounded context manifest:
initial read paths and search hints, not preloaded file contents. These are untrusted navigation
guidance, not extra edit authority or executable commands. Workers are directed to batch needed
initial reads and expand exploration only when the task or observed evidence requires it. This
removes a dropped-context gap; its effect on live token consumption must be measured rather than
asserted from prompt changes alone.

## Versioned GitHub protocol

Every current machine-readable control record contains at least:

```json
{
  "protocol": "clockgrove.factory/v2",
  "kind": "run|lease|graph|attempt|validation|budget",
  "objective": 166,
  "runId": "opaque-random-id",
  "sequence": 1
}
```

Issue and pull-request records use a human-readable comment plus an HTML-comment JSON envelope.
Control commits use a human-readable subject plus a `Factory-Event` trailer. Unknown future fields
are ignored; unknown protocol versions fail closed.

Authenticated Objective comments are the single atomic application-request journal. GitHub binds
each comment to its actor; Factory accepts only comments that pass the protocol's actor and
repository checks. A request ID is the cross-process idempotency key, and every transport uses one
central semantic normalizer when comparing it. GitHub may commit a comment while its response is
lost, so a retry can append an identical comment. Replay tolerates those at-least-once duplicates and
applies the command once; reuse of the same request ID for a different normalized command fails
closed. There is no secondary journal, private queue, or projection repair path whose weaker
attribution could authorize a command.

Starting an Objective records non-secret accepted policy: backend preference, trust, concurrency,
timeouts, retry limits, paid-runtime limits, fallback rules, management backend, activating identity,
and timestamp. Restart resumes the latest supported non-terminal run without broadening its policy.
The recorded policy wins over new command defaults on resume; a different policy requires a new run,
not a silent mid-run mutation.

Before a fresh activation records `FactoryRunStarted`, the Director re-reads the Objective under its
acquired Objective lease and classifies the complete child-issue state with the same bounded,
side-effect-free check exposed by `factory_doctor`. The only startable states are no Work Items,
authenticated graph input, or the exact adoptable legacy shape described below. Invalid or mixed
input records `ActivationRejected` without delivery selection, model invocation, Work Item mutation,
or worker admission. A human edit after that observation is still detected by the later immutable
compilation and projection fences; the lease fences Factory writers, not arbitrary GitHub editors.

Before the first sub-issue write, the activating Director stores the complete validated graph as a
blob reachable from an immutable per-run custom ref, then writes an authenticated `GraphCompiled`
receipt containing the graph digest, size, ref, and blob OID. Each compiled Work Item also carries a
`clockgrove.factory/graph-v1` envelope with the digest, stable compiler ID, graph size/order, and
dependency IDs. Replaying the durable graph repairs a crash during issue or dependency creation
without duplicates and without asking a model to reproduce prior output. Once graph application is
complete, the Director stores a second immutable, graph-commit-bound projection mapping every
compiler ID to its GitHub issue node ID and number. The Director first stages the projection blob,
then writes an authenticated `GraphProjected` Objective receipt naming the exact graph digest, size,
projection ref, and blob OID, and only then creates the immutable ref. Execution starts only after
both records agree. Every later Objective snapshot must match its exact issue cardinality, mapping,
title, body, metadata, and blocker edges; a removed, replaced, or swapped sub-issue fails closed
rather than inheriting another Work Item's attempt history. Any divergent ref, receipt, projection,
or per-item envelope fails closed.

A narrow recovery bootstrap covers an Objective whose Work Items were created before any
authenticated graph receipt. Factory accepts only the historical six-section Work Item shape and
binds the Objective compilation input plus the complete issue node IDs, numbers, titles, core
sections, order, and native blocker topology into the immutable recovery plan. That plan must
describe an effect-free graphless predecessor and every item as unstarted execution; existing
attempts, capacity, validation, publication, graph, or non-management budget effects refuse
adoption. After explicit recovery authorization and any required unknown-usage acknowledgement, the
compiler receives those fields as authenticated constraints and may add only execution metadata.
Factory updates the same issue bodies in place; it does not create Work Items or dependency edges.
Mixed raw and upgraded bodies reconstruct the same constraint digest after a lost response. A
successor compiler dispatch marker without exact usage closure remains unknown and prevents another
compiler or worker session, just like every other unresolved model invocation. Once `GraphCompiled`
and `GraphProjected` agree, ordinary immutable graph recovery applies and no later retry recompiles
it.

If that adopted successor reaches an authoritative terminal after its management usage is fully
reconciled but before either graph ref exists, another explicit recovery may continue the same
bootstrap. The chain verifier retains the original Objective-input, constraint, projection-binding,
policy, cumulative allowance, history, and unknown-usage acknowledgements, while binding the new
graph and projection refs to the newly requested successor. It permits this authority handoff only
when the prior successor has no attempt, scheduling, capacity, validation, publication, source-delivery,
integration, graph, non-management budget, or unresolved model-invocation effects. The Objective and
every legacy Work Item must still reproduce the acknowledged constraints and remain open,
unassigned, and without a linked pull request. A compiled checkpoint without its authenticated
receipts is not absence: a surviving graph or projection ref blocks the handoff.

The deterministic current-run graph ref is not a compiler receipt. Before `GraphCompiled` exists,
restart accepts that ref only when its commit is based on the run's exact base, contains the atomic
compiler invocation/result counters for that graph digest, and the Objective journal contains one
matching dispatch marker followed by its exact actual-usage closure under the run policy. A graph
copied from an authenticated historical receipt must contain no new compilation claim. Similarly, a
`GraphProjected` receipt may repair only its exact staged projection blob; missing or divergent
staged content blocks rather than manufacturing a projection.

Opt-in compiler evaluation uses a different authenticated checkpoint: the complete immutable
draft-stage selection and its linked per-stage actual-usage records. A pre-receipt restart must
validate that workflow-specific evidence before projection; it cannot reinterpret the graph as an
ordinary compilation or use it after its Objective-input binding changes.

The graph is immutable for the lifetime of its run. Factory may retry a Work Item with bounded prior
failure evidence, but it does not silently replace issue scope, dependencies, or budget through a
second compilation. An inadequate durable graph escalates; an explicitly authorized new run is the
boundary for a different graph. See
[`decisions/0002-immutable-graph-recovery.md`](decisions/0002-immutable-graph-recovery.md).

## Objective authority and shared resources

The repository-controller lease elects one unattended discovery service; it is not a repository data
lock. Normal issue, comment, receipt, projection and PR publication writes do not acquire or recheck
it. Independent sessions coordinate capacity using a short custom-ref CAS transaction, not an
execution-long lease. One-time import of older resource reservations and explicit scheduler ceiling
changes are genuine shared-state boundaries. See [the locking audit](OBJECTIVE-AUTHORITY.md).

The shared-capacity v2 snapshot retains every active or unresolved claim plus a bounded recent
release journal. At 3,072 journal entries, a fenced capacity mutation moves explicit releases into
an exact hash-sharded Git-tree tombstone set and atomically publishes that tree with the compacted
snapshot through the existing capacity-ref CAS. The immutable marker path binds the complete owner
and reservation digests; replay of that identity remains released, while changed resources fail
closed. Compaction never examines lease expiry, process presence, or snapshot absence, and it never
removes an active claim. A tombstone lookup takes seven shallow tree reads regardless of retained
history; a compaction publishes one tree, one commit and one CAS update, plus one marker-blob upload
for the first compaction. At 3,840 active claims the retention diagnostic requires reconciliation
and explicit release before the unchanged 4,096-record hard bound.

The tombstone set is durable Git history whose storage grows with genuinely retired identities; this
is bounded per-operation retention, not a claim of unlimited repository storage. The new controller
reads the original v1 snapshot and upgrades on its next write. Once v2 is written, downgrading to a
strict v1 controller is unsupported; controller and plugin upgrades remain coordinated artifacts.

Exactly one Director may schedule or integrate one Objective at a time. The lease is a commit chain
under a custom ref such as `refs/clockgrove-factory/leases/objective-166`.

Lease mutation uses GitHub GraphQL `updateRefs`, not REST `updateRef`. Every update supplies
`beforeOid` and `afterOid`; the stale caller fails atomically if the ref no longer points to the
observed commit. The new commit records holder, run ID, monotonically increasing epoch and sequence,
server-relative expiry, and policy digest. Launch, budget reservation, publication, validation, and
integration recheck current Objective ownership and epoch at their actual mutation boundaries.
Queued operations capture their original Objective generation before waiting. The concrete GitHub
transport checks it after quota admission and immediately before dispatch; control helpers avoid
duplicate preflight reads only when that transport guarantee is present. Same-epoch renewal does
not invalidate an operation. A new epoch cannot be lent to an old queued callback.

Comment and receipt retries retain their idempotency identity and sequence validation. Writer
generation is separate from original attempt or provider-accounting generation. Fresh
Director-authored receipts name a stable writer operation, holder, epoch and policy digest. Readers
observe bounded comments first and the authoritative Objective ref second; a takeover between those
reads can only attenuate the older generation. A released or expired last generation remains
historical terminal evidence until an actual conflicting generation appears. GitHub's comment API
cannot atomically compare a lease and append a comment: an already-dispatched request cannot be
unsent. Delayed receipts must not grant fresh lifecycle control authority after an Objective takeover;
historical outputs and liabilities remain subject to exact recovery and accounting checks.

The default lease lasts ten minutes and renews with two minutes remaining. A renewal advances the
lease commit and sequence but not its fencing epoch, so already-running operations from that same
holder and epoch remain valid after re-reading the current ref. A different holder or epoch is still
rejected. This cadence avoids spending two GitHub mutations roughly every 75 seconds merely to keep
an active Director alive.

This distinction is mandatory. Live conformance established that REST `force=false` prevents
non-fast-forward updates on branch refs but permits sibling rewrites on custom refs. GraphQL
`updateRefs.beforeOid` provides the required compare-and-swap on a custom ref without creating a
branch or triggering branch workflows. See
[`decisions/0001-v2-control-protocol.md`](decisions/0001-v2-control-protocol.md).

If a Director cannot renew, it stops mutations and cancels local children. Takeover advances the
epoch and reconciles resources carrying earlier deterministic tags. Provider TTL bounds paid spend
during a partition; provider-side spend limits remain the absolute cap.

## Attempt reservation and recovery

Before launch, the Supervisor admits one immutable reservation through an issue-scoped
CAS ledger. The record binds the issue node ID/number, owning Objective and immutable
graph/projection, run, original Director epoch, policy, monotonically advancing attempt,
backend/resource, base SHA, and capacity/budget identities. Dispatch is a separate one-shot
transition; uncertain delivery, usage or cleanup retains the original liability. The ledger
retains original metadata and proof commits through Git ancestry. Retries require exact
settlement; reassignment additionally requires explicit accepted new-run authority.

Historical claim and attempt namespaces are permanently sealed against old writers before
import. Already-reserved old work remains occupied until evidenced producer/resource and
accounting reconciliation. Election ownership or lease expiry never establishes drainage.
See [issue admission and compatibility](ISSUE-ADMISSION.md) for the mixed-writer race proof,
logical historical locators and bounded retention contract.

Only after reservation and another lease/budget check may the backend launch. The trusted Supervisor
writes lifecycle events: reserved, started, meaningful progress, succeeded, failed, timed out,
cancelled, infrastructure-deferred, collected, published, validated, and integrated. It opens no
empty pull request. A PR exists only after a meaningful artifact has been inspected, committed, and
pushed by the host.

Crash recovery is reconstruction:

- an admitted immutable reservation without a comment repairs the comment;
- a stale reservation is reconciled and marked infrastructure-deferred unless durable validation
  already proves a real work failure;
- deterministic provider names locate and stop a partially recorded remote launch before replacement;
- orderly local exit kills the worker process group; restart identifies any surviving Linux
  group by its attempt marker and stops it before replacement;
- a pushed branch without a PR is published idempotently;
- a PR without an audit event repairs the event;
- validation reruns against the exact head SHA;
- integration always re-reads current merge and issue state.
- an interrupted graph application repairs only missing issues and dependency edges.
- a specifically authorized graphless adoption upgrades only the same bound Work Item bodies; an
  interrupted compiler invocation or ambiguous agent dispatch blocks replacement rather than being
  treated as unused capacity.

## Provider-neutral Work Item state

State is a pure function of one GitHub snapshot and its server timestamp:

```text
blocked       at least one native blocked-by issue remains open
unstarted     dependencies clear; no active attempt
reserved      attempt ref exists; backend has not started
in_flight     trusted start exists; no terminal attempt event
validating    output collected; independent validation is running
for_review    meaningful diff; validation passed; checks settled
failed        terminal failure, timeout, stale reservation, no-op, or bad validation
escalated     terminal handoff plus human assignment
done          linked pull request merged and Work Item closed
```

An attempt remains pinned to the data format and backend that created it. Inconsistent mixed state
is reported, never guessed into a runnable state.

## Worker and artifact contract

The compiler emits a bounded Worker Packet containing goal, acceptance criteria, allowed paths,
preconditions, exclusions, repository conventions, base SHA, validation commands, trust class,
OS/architecture and resource requirements, required tools/services/network destinations, permitted
secret names, and the output contract.

Platform, CPU, memory, artifact-storage and timeout requirements are trusted-host outputs, not model
facts. The compiler replaces model proposals with matching rules from the pinned repository's
`.factory/execution-requirements.json`, then immutable run-policy values, then named conservative
defaults. A scope-specific rule is the only way equivalent work receives different sizing. Missing
architecture evidence stays portable, ordinary artifact storage remains backend-managed, and the
default platform remains the supported Linux runtime. Repository timeouts above the activated
Work Item limit are capped and record both sources; persisted requirements above that hard limit are
rejected. The Work Packet and rendered issue retain provenance for each of these decisions.
The evidence file is versioned JSON with optional `defaults` and ordered `scopes`; each scope rule
contains concrete repository `paths` plus any evidenced `os`, `architecture`, `cpu`, `memoryMb`,
`diskMb`, or `timeoutMinutes` values. It validates against
[`schemas/execution-requirements.schema.json`](../schemas/execution-requirements.schema.json).

Compiled Work Item array order is semantic: it is dependency-aware, seeds native sub-issue priority
among independent peers, and participates in the immutable graph digest. Worker goals, acceptance,
validation criteria, and conventions stop at the pre-publication artifact boundary. Publication,
integration, issue closure, accounting, and scheduling remain Supervisor-owned lifecycle phases and
are never criteria that the artifact reviewer must prove.

Workers receive no Director, merge, issue-mutation, escalation, or Objective tools. Local workers run
with GitHub credentials removed and credential helpers disabled. Sandbox workers receive no GitHub
write credential. Workers may edit only their isolated workspace and return a content-addressed
artifact plus bounded metadata.

The local boundary is intentionally trusted-local, not hostile-code containment. Factory redirects
conventional home/config paths, strips conventional secret environment variables, and disables Git
credential helpers, but the worker still runs as the operator's OS user. A process that already knows
an absolute path may attempt to read any host file that user and the underlying Codex sandbox permit.
Unknown or adversarial repositories, dependencies, and commands require an authorized hardened
sandbox or escalation.

The normalized artifact identifies its exact base SHA, changed paths, patch or bundle/delta, reported
commands, bounded logs, optional checkpoints, and terminal outcome. The Supervisor rejects bad base
SHAs, forbidden paths, malformed outputs, oversized fields, and suspected secrets before any GitHub
publication.

Local collection computes and validates the changed-path manifest before materializing a potentially
large textual or binary patch. An out-of-scope generated bundle therefore produces a concise path
diagnostic rather than an opaque size failure. Failed authoritative commands retain a secret-scanned,
bounded output tail in validation evidence so the next worker can fix the actual compiler or test
error without another discovery session.

## Independent validation and integration

Worker self-report is never authoritative. The trusted host applies the artifact to a fresh checkout
at the recorded base, rechecks scope and sensitive surfaces, runs the declared validation plan in the
required trust boundary, records evidence bound to exact input and output SHAs, and only then creates
the publication commit and pull request.

Validation commands normally must already be observed at the frozen base. A provider-neutral
repository-capability model handles the narrower case where an immutable graph must refer to an
operation that an ancestor artifact will create. Adapters define the operation grammar, authority
paths, provisioning mode, setup plan, and exact-base resolver. The compiler records typed
provider/requirement bindings and generations derived by Factory; model output cannot mint them.
Bindings are plan provenance, not execution authority. They are canonicalized again when a graph is
loaded or copied, and an integrated-base consumer remains unavailable until its exact provider
generation is complete.

The graph contains only the abstract adapter, platform, release-channel, and contract requirement;
compilation never reads or selects a host runtime. After the graph and its accounting are durable,
the Supervisor selects a content-addressed receipt, materializes the exact protected base, and
resolves every deferred requirement. Active is the default only for a new or unbound generation. An
integrated-base consumer inherits the exact receipt from its provider generation's authenticated
reservation; the provider identity binds the reservation object, receipt, and activation digests.
The mutable issue comment must digest-identically reproduce the complete immutable reservation
trailer; matching only selected reservation fields is not provider authority.
Provider-generation and current-base authority bytes are inspected separately and must remain equal.
Missing or ambiguous historical activation cannot borrow the current active bundle.

`AttemptReserved` binds the selected receipt, activated Worker Packet, proof digests, source ref, and
base commit. Immediately before model or worker launch, the Supervisor rereads the Objective,
protected ref, provider lineage, authority bytes, and receipt components and requires the same
binding. Local execution, clean validation, semantic review, and Daytona all consume that exact
selected receipt; a later active-pointer change cannot move the generation or attempt. A later Work
Item creates a new generation only when it owns the adapter's generation surface and explicitly
validates the operation it promises; write scope alone cannot create authority. Independent ready
Work Items continue while one requirement is unavailable. Missing, corrupt, or hostile ambient
executables cannot substitute for the selected runtime.

Authenticated historical graphs from before the top-level abstract runtime field keep their exact
stored bytes, digest, projection, and Work Item envelope. The existing-graph read path alone may
derive an in-memory abstract pnpm execution requirement from omission. Fresh and issue-only
persistence stays strict; recovery may copy an exact record already authenticated from the durable
graph store. Explicit empty or selected runtime fields are not legacy omissions, and selected runtime
data inside capability bindings is always invalid. This compatibility view never includes an active
selection or receipt and never infers runtime authority for an already-integrated provider that lacks
an authenticated activation. Copying a historical record reuses its authenticated blob object rather
than reserializing it. Issue-only inspection reconstructs every raw Worker Packet field before strict
validation, and foreground completion reapplies a reservation's exact activation to the execution
view before comparing its invocation digest.

The first concrete future-capable adapters are `node-pnpm`, `javascript-bun`, and `python-uv`.
They apply independently of unrelated repository recipes only when their complete root authority is
absent; a partially present authority surface is never bootstrap authority. One dependency-root Work
Item owns the authority and promises every descendant finite operation. At explicit
`factory toolchains provision` time, Factory resolves the latest stable upstream releases, records
their official immutable identities and digests, and retains older bundles.

`node-pnpm` pins the selected pnpm version and exact dependencies; workspace links remain within
enumerated in-scope direct-child packages; registry lock entries carry SHA-512 integrity; and URL,
git, tarball, patch, escaping local sources, lifecycle hooks, and package-manager overrides are
rejected. Selected leaf/Turbo closures use a finite check-only grammar. Its runtime bundle contains
both the official Node executable and pnpm standalone program.

`javascript-bun` pins `packageManager: bun@<exact version>`, `bun.lock`, exact registry dependencies,
and direct-child workspace manifests. It rejects alternate configuration, trusted dependencies,
lifecycle companions, exotic sources and arbitrary Bun commands. Factory provisions the baseline
Linux x64 Bun ZIP and extracts it with a bounded in-process parser, so `unzip` and ambient Bun are not
host requirements. Only finite `bun run <validation-script>` operations are admitted.

`python-uv` pins exact uv and CPython patches through `pyproject.toml`, `.python-version`, and
`uv.lock`. It permits only wheel-backed registry dependencies for a non-installing application/test
profile, rejects source, editable, VCS, path and alternate-index authority, disables automatic Python
downloads and user configuration, and admits only the finite locked/no-sync pytest operation for the
root or an exact declared workspace member. Its bundle contains official uv and
`python-build-standalone` CPython assets. uv configuration discovery is inspected only at the root,
the selected member, and that member's ancestor directories; unrelated package managers, large
subtrees, and symlinks outside this authority do not become uv authority or readiness dependencies.

Every adapter performs one frozen hook-free setup from its declared registry destinations and records
version, setup and validation commands in order. Isolated validation uploads, verifies and directly
executes the same receipt-bound components. npm, Cargo, Go, ambient Python, and uncatalogued runners
have no future-authority adapter; existing observed recipes remain usable, while absent recipes fail
before execution. If a selected bundle is missing or corrupt, recovery fails readiness closed.
`AttemptReserved` retains the complete receipt and upstream origin identity, so an operator can run
`factory toolchains restore RECEIPT.json` to reacquire every historical component without resolving
latest or moving the active pointer. Recovery reuses the same receipt and graph; it does not
recompile or silently select a newer active bundle. Extracted-tree identity hashes canonical
code-unit-ordered relative paths, file bytes, and bounded in-tree symlink targets. Ambient umask modes
are excluded; each declared executable is separately digest-checked and normalized to executable
permissions before the complete tree is accepted.

For an integrated-base consumer, that historical receipt comes from the provider generation's
authenticated `AttemptReserved` event and integration lineage, never from the mutable active
selection. Historical graphs that omit the abstract top-level runtime retain their exact stored
identity and receive only an in-memory compatibility view; fresh persistence remains strict.
Unmanaged isolated validation stops after its first failure, recording only the successful prefix
and that failure, while complete success still executes the full plan.

Execution-affecting artifacts retain two separate gates. Package manifests, lockfiles, registry
configuration, workflows, and actions may never auto-integrate: immediately before merge Factory
derives the exact changed paths from the immutable base/head Git diff and requires a human. Before
publication, a new workflow is permitted without a human only when its parsed YAML has exactly one
push trigger restricted to the protected branch, no `create` or pull-request/chaining trigger,
read-only top-level and job permissions, hosted Ubuntu,
commit-pinned allowlisted actions, checkout credentials disabled, and no secret/token/OIDC surface;
existing workflows plus changed package scripts conservatively require pre-publication approval.
Unsafe workflow bytes are retained behind a durable hold before a ref or pull request exists. After
a human merges the exact authority-changing pull request, explicit Objective recovery reuses the
persisted graph without another compiler invocation and re-resolves descendants against the new
protected base.

Repository CI remains supported but Factory does not impersonate required checks. Preflight reads
branch rules and required checks before spending on implementation. If a required check cannot be
produced without repository configuration, Factory escalates before launch.

### Optional external code review

Factory's independent semantic acceptance review phase is mandatory before publication, but its
acceptance work is criterion-specific: it evaluates only behavior, visual results, or qualitative
judgment that deterministic evidence cannot establish. Exact outputs, file modes, lifecycle facts,
and other machine-verifiable criteria remain bound to repository-grounded deterministic validation
without being duplicated into semantic acceptance. Safety, security, destructive-action,
accounting, and recovery criteria are classified explicitly per criterion, always retain deterministic
gates, and also receive semantic review
when their behavioral or judgment component genuinely requires both tiers. The compiled Work Item
records the risk classification, selected tiers, rationale, and exact command bindings; one evidence
artifact may cover multiple criteria. Malformed, partial, legacy, or ungrounded routing fails closed by
retaining semantic review for any criterion without a valid deterministic binding. An
automatic GitHub Copilot PR review is a separate, optional second opinion, not that acceptance
review and not a requirement for using Factory. Factory does not request Copilot PR reviews by
default or enable automatic-review settings. Repository, organization, or personal GitHub settings
may independently trigger them; opting into the GitHub Copilot execution backend is a different
choice from enabling Copilot PR review.

External review adds its own provider usage and latency. Operators should deliberately choose it
when that second opinion is worth the additional cost. Factory neither changes those settings nor
assumes that a successful external review establishes every Work Item acceptance criterion.

The current integration path observes external check status and GitHub mergeability, but does not
translate external review comments into criterion-bound acceptance or autonomous rework. A failed
observed check still blocks integration, even when no branch ruleset requires it; optional review
does not mean silently ignoring a failed review service. Disabling future automatic reviews does
not clear an existing failed check or revive a terminal run. Any recovery must preserve the recorded
graph, validated artifact identities, branch policy, and budget authority. A future external-review
adapter must explicitly reconcile findings before it can replace or participate in acceptance.

### Pull-request integration

Only branch-rule shapes whose autonomous semantics are proven are allowed. Unknown rule types fail
closed. Human-approval, code-owner, last-push approval, positive path-specific reviewer, and
incompatible merge-method requirements escalate rather than being bypassed. Conversation-resolution,
review-dismissal restrictions, optional path reviewers, and the extra-unattributed-Copilot-approval
flag do not invent an approval requirement when the configured approval count is zero; GitHub's
current mergeability and merge response still enforce any actual unresolved conversation or review.
Regular sibling PRs are the default. Explicit stacked delivery
uses GitHub's pinned REST surface only after an observed repository capability probe; an
unavailable capability produces a durable configured fallback or escalation before publication.
Regular and native-stack delivery both admit independent Work Items concurrently. When an earlier
sibling advances trunk, Factory first proves every intervening commit is an exact, authenticated
integration from this run or an authenticated peer Objective owned by the same repository controller.
Peer proof preserves the original activation, graph, policy, reservation and review identities;
external or unexplained base changes escalate. Clean applicability alone does not authorize
executing changed code.

For siblings, Factory applies the original published patch to a private temporary Git index on that
proved target base and uploads raw Git blobs and the exact proposed tree. Preparation performs no
checkout and executes no repository hooks, filters, setup, tests, or model work. Before changing the
owned Factory branch, it persists an immutable refresh intent binding the original reservation/publication/validation,
exact PR identity, prior head, target base, proposed tree, and planned two-parent commit. Its parents
are the prior owned head followed by the proved target base. The existing non-force atomic GitHub
ref update compares the exact prior OID and advances only to that immutable planned OID. A lost
response is resolved by exact read-back; a third head fails closed. An unapplied update may retry
only that same atomic old/new pair after all current fences are independently revalidated. GitHub's
commit timestamps mean the planned OID is immutable, not assumed reproducible. Unreferenced Git
objects before an intent is durable are neither branch changes nor validation authority.
Preparation has a 120-second total deadline and a 100-MiB per-blob bound. It does not fetch LFS
assets or qualify other existing worktree lifecycle paths as hook-free.

After the exact changed head is observed, Factory reruns the full validation plan in the required
trusted-local or independently isolated boundary and persists its immutable merge-candidate
checkpoint before requesting semantic review. A distinct identity binds the actual refreshed head,
new base, combined tree, artifact, and validation evidence. The original reservation, worker artifact,
publication receipt, and original exact-head validation remain unchanged: they are provenance, not
assertions that the refreshed head has already passed. Candidate validation has its own capacity and
native-usage identity; original attempt completion cannot discharge this new resource liability.
An interrupted validator without an exact completion checkpoint requires resource reconciliation,
not an automatic duplicate launch. A completed checkpoint is reused after restart, including its
original evidence timestamps, and its paid review is accounted once. Completed validation and usage
are preserved before rechecking mutable trunk. Another proved sibling integration creates a new
linked refresh/validation/review identity; neither an old review nor an unexplained external advance
authorizes the next head. Native linear-stack rebase proofs remain separate from sibling refreshes.

Publication repair rereads authenticated history before writing a missing receipt. Equivalent
receipts may still exist after response loss or delayed observation; Factory preserves every audit
envelope and requires all proof fields to agree, ignoring only sequence, timestamp and reason.
New refresh intents select a deterministic original receipt. An existing immutable intent keeps its
exact receipt digest, even when another equivalent envelope is later observed. Conflicting receipts
or ambiguous intent bindings fail closed; independently proved linear-head revisions remain separate.

Publication separates unreachable Git object preparation from authoritative effects. Creating a
bounded, secret-scanned blob, tree or commit still uses the shared mutation scheduler, pacer,
concurrency limiter, circuit breaker and cancellation checks, but does not read an Objective lease
per object. The object grants no authority until an owned ref create/CAS or another authoritative
record publishes it. Ref, comment, issue and pull-request effects capture the Objective generation
before queueing and check it immediately before transport, in addition to endpoint-specific
idempotency and expected-revision conditions.

Before merging, GitHub's current test-merge commit must name the exact target base and actual PR
head, with the same combined tree Factory validated. Stale or absent test-merge metadata waits;
different trees fail closed. The resulting squash commit must have exactly the target base as its
single parent and the validated combined tree. Response-loss recovery requires the pre-merge
candidate and accepted review checkpoints; it never validates a completed merge retrospectively.
These checks do not create a GitHub base-SHA compare-and-swap: an external writer racing the final
merge remains detectable by the post-merge parent/tree check, not atomically preventable by the REST
merge endpoint. Factory serializes its own integrations and preserves the repository/Objective fences.

Native-mode sibling and linear-stack units may use explicitly authorized Daytona execution.
Provider-managed PRs do not acquire native-stack admission from this exception. Factory still applies
and publishes the bounded artifact on the host, but an explicitly
selected isolated validator is always honored, even for a `trusted_local` packet. Candidate validation
uses Daytona whenever the sibling or an intervening same-run integration was non-host. It receives a
distinct resource identity bound to the original run/attempt, policy/epoch, source-head candidate,
target base, and candidate artifact—not a new implementation attempt. Its durable remote capacity and
sandbox budget are reserved before creation. The immutable completion checkpoint retains measured
provider-call duration including provision and cleanup; this is native runtime accounting, not a claim
about the provider's invoice. Restart reuses that completion and accounts it once. Missing completion
or conflicting resource ownership does not establish cleanup or permit another paid invocation.

Backend location is not itself a trust class. Accepted, independently validated `trusted_local`
overflow may become the base of local downstream work under the original policy. Work selected as
`sandbox_untrusted` or with isolated/managed requirements never gains host execution authority merely
because its PR was merged. Paid burst remains opt-in. Regular PRs and native independent siblings
both keep scheduler-authorized execution concurrent; integration alone is serialized. Provider-owned
ordinary PR heads are never rewritten by Factory: their changed-base GitHub test-merge candidate
requires independently authorized validation and an accepted exact checkpoint.

The single-host controller defaults to two active Objectives (configurable 1–32), sharing local,
paid, backend, path, and exclusive-resource limits. Starting cohorts reconstruct every resumed run's
durable capacity before fresh admission. Receipt timestamps seed least-recently-served local
fairness; unused shares are lent and releases wake waiting Supervisors. Historical peer receipts
never activate a terminal run. An exact-commit PR association only discovers candidate Objectives;
authenticated explicit activation/recovery, a shared observed controller generation, immutable
graph/projection, reservation, original acceptance/accounting, and actual exact squash/candidate
proof establish permissible ancestry. Unrelated trunk changes remain a hard stop.
Discovery uses GitHub's documented [Issue parent relationship](https://docs.github.com/en/graphql/reference/issues#issue)
for closing-issue hints; those mutable hints never replace the immutable integration proof.

Within one Supervisor, completed child executions form a single-consumer settlement queue. A progress
wake or a synchronous admission/recovery fence atomically claims the result it surfaces, so final
drain cannot reinterpret the same reconciled failure as a second teardown failure. Drain still waits
for every active child. A human-authority failure that first arrives during drain converts completion,
cancellation, or lease release into the same escalation it would have produced if claimed earlier;
late cleanup, accounting, fencing, or resource-absence uncertainty vetoes the terminal outcome.
Claiming process-local state grants no restart or recovery authority; those decisions continue to
require durable GitHub receipts.

Compilation reads a separate exact Git-object tree and index, not the controller's mutable checkout.
Preparation runs no checkout hooks or filters; verified locally available LFS objects are hydrated
explicitly. Raw trees are bounded to 5,000 regular/executable entries, 100 MiB per raw blob, 256 MiB
aggregate, and a 120-second preparation deadline; symlinks/gitlinks fail closed. Cleanup targets only
the exact owned temporary root, and cleanup failure cannot invalidate a successful paid checkpoint.

Native linear stacks separately provide cascading rebase plus fresh validation and semantic review
after a lower layer changes. A non-host or isolated child is revalidated in a fresh Daytona sandbox,
not on the controller host. Its immutable native-rebase checkpoint binds the original publication,
rewritten head, new base, exact artifact/tree, source reservation policy/epoch, and measured provider
resource lifetime. Each rebase has a separate sandbox capacity and native-budget identity, reserved
before launch. Completion is persisted before paid semantic review and replay reuses those exact
validation timestamps and review identity. Controller and sandbox intervals are checked independently;
clock skew is not interpreted as billing or cleanup evidence. Missing completion leaves the paid
liability unresolved and blocks automatic replacement. A partial rebase publication replays from the
last complete publication binding rather than pairing an old head with a newer validation receipt.
This path requires runtime and fault qualification; current acceptance is tracked in
[GitHub #69](https://github.com/clockgrove/factory/issues/69) and its linked delivery/provider issues.
Immediately before each regular or stacked merge, Factory acquires a short claim for the destination
branch and
rechecks the exact validated head, current stack/base relationship, current branch rules, required
checks, leases, and mergeability. A lower-layer rebase invalidates every affected descendant receipt
before validation is rerun. Parallel workers therefore cannot merge sequentially from the same stale
base. Native stacks are part of the product scope; completion requires their live conformance
matrix.

The claim records preparation with provider-observed time, the one exact dispatch, and its outcome
separately. Preparation has a 120-second bound matching the final mechanical preparation deadline.
After that bound, another
currently fenced and otherwise eligible Objective may replace only the prepared record by
expected-OID CAS. That replacement races the original actor's required prepared-to-dispatched CAS,
so exactly one may proceed to send. The same exact operation may also replace its prepared record
immediately after a higher-epoch takeover. Neither path applies to a dispatched request.

An owned Git ref update uses expected-before-SHA CAS. GitHub's regular PR merge endpoint checks the
head SHA, not an expected default-branch SHA. Factory therefore rechecks the base and exact validation
under its branch claim and verifies the resulting squash parent and tree. An external branch writer
can still race that endpoint; a mismatch is a failure, not successful validated integration. A
single regular request's authoritative HTTP 409, or a native asynchronous request's exact UUID-bound
terminal failure, records confirmed non-execution and releases only that claim nonce by
expected-OID CAS. Native recovery polls only the recorded UUID; it never sends a replacement request.
Any partially merged native member prevents non-execution release. A successful merge records the
exact squash commit chain. Transport timeouts, response loss, missing or expired asynchronous
results, legacy dispatches without an exact request binding, and any possible earlier outstanding
request remain uncertain. A later refusal cannot erase that uncertainty, and no dispatched claim is
released by age. An uncertain merge retains only that branch's reconciliation claim; it grants no
repository-wide exclusion over Objective execution or publication. Model work and validation occur
outside the claim.

Immediately before merge, Factory rechecks lease epoch, policy digest, validated SHA, checks,
mergeability, branch rules, scope, and semantic acceptance. Integration is a reversible squash merge.
Force-push, history rewrite, settings changes, releases, and cross-repository writes are absent from
the autonomous tool surface.

## Execution backends

Every backend exposes capability, availability, launch, observe, cancel, collect, and cleanup
contracts. The planned bundles are:

- `codex-sdk/local-worktree` — preferred programmatic local backend in every supported Linux environment;
- `codex-cli/local-worktree` — supported portable local fallback;
- `codex-cli/daytona` — supported opt-in paid sandbox burst;
- `github-copilot/github-managed` — opt-in Copilot integration with explicit task-identity and
  automatic-cancellation limitations; supported execution claims require live qualification; and
- `openai-codex/github-managed` — bundled unavailable profile, not a working managed adapter; a
  supported provider-specific identity/lifecycle interface is required before enabling it.

`codex-cli/vercel-sandbox` and harness-native child-worker adapters are Labs integrations.
`codex-app-server/local-worktree` is an explicit supported route with durable session acceptance;
its provider restrictions do not turn it into a nonblocking Labs exclusion.
The installed package must still start when optional
credentials or host capabilities are unavailable. The local default/fallback decision is recorded
in [`decisions/0008-codex-sdk-default.md`](decisions/0008-codex-sdk-default.md).

Missing optional credentials or SDK support cannot prevent local plugin or MCP startup.

Capability limitations and execution safety are separate. A missing automatic-stop interface may
require the operator to stop the exact session in the provider UI. Until actual termination can be
observed, the affected attempt retains its resource obligations and cannot be replaced on an
assumption that unassignment or a stop request ended compute. An unavailable provider does not
prevent local startup or qualify as a working backend. Provider limitations do not block developing
or releasing unrelated Factory capabilities.

Local work uses an exact-SHA Git worktree and a killable process group. The preferred route uses the
official Codex SDK as a programmatic boundary; the portable fallback invokes Codex CLI
non-interactively with ephemeral state, ignored user configuration, JSONL output, and a strict output
schema. Both set approval policy to `never`, so sandbox-boundary requests fail instead of waiting for
a human or an automatic reviewer. Management calls are read-only. Workers use `workspace-write` with
command networking disabled by default; a non-empty, policy-approved Work Packet destination list is
translated into an enabled Codex network proxy with exactly those allow-first domain rules. Native
web search remains disabled because it is outside the command-network proxy. The child cannot load
Factory recursively or inherit GitHub credentials. Models and reasoning come from an explicit
profile or the operator's policy; Factory contains no hard-coded model choice.

Sandbox execution uploads source content rather than repository credentials, creates an explicitly
ephemeral resource with hard TTL and deterministic identity, brokers only named model credentials,
restricts egress where the provider can enforce it, collects the artifact, and deletes the resource.
Independent validation runs in a second fresh resource with no model credential, and its tree must
equal the host-applied artifact tree. The sandbox worker CLI package is version-pinned. Daytona and
Labs providers remain separate adapters wherever their real behavior differs. Inside those dedicated
outer sandboxes, Codex uses its documented bypass mode; the provider boundary, TTL, and egress policy
are therefore the security boundary rather than a nested CLI sandbox. A fresh validator with an npm
lockfile runs `npm ci` before the declared checks and includes that setup result in its evidence; it
does not rely on a worker's mutable dependency directory.

The supported Daytona adapter never launches a mutable image tag. Its bundled default is the exact
multi-platform Node image index
`docker.io/library/node@sha256:c601a46abb4d2ab80a9dc3da208d50d1122642d53f17a101926ace71e5a9bf1c`;
an override is accepted only as an `@sha256`-pinned registry reference. The exact identity is carried
in the backend handle, durable `AttemptStarted` receipt, and isolated validation evidence so a later
audit can identify both environments without consulting provider defaults.

## Routing, costs, and budgets

The default policy is local-only:

```json
{
  "backendOrder": ["codex-sdk/local-worktree", "codex-cli/local-worktree"],
  "maxParallel": 2,
  "workItemTimeoutMinutes": 30,
  "objectiveTimeoutMinutes": 720,
  "maxAttemptsPerItem": 3,
  "allowedPaidBackends": [],
  "cloudFallback": "never",
  "maxSandboxMinutes": 0,
  "maxManagedAgentSessions": 0,
  "trust": "explicitly_activated_repo",
  "managementBackend": "codex-cli/local",
  "allowedNetworkDestinations": [
    "registry.npmjs.org",
    "*.npmjs.org",
    "api.openai.com"
  ]
}
```

Routing first ranks dependency-ready work by native sub-issue order or a pinned organization
single-select issue field, then scans the complete queue for safe resource fits. Local admission is
bounded by per-Objective policy, repository-controller ceilings, backend limits, cgroup/host CPU and
memory headroom, and global path/exclusive-resource reservations. Slots refill when any worker
settles; one straggler does not hold a fixed wave open.

New policies default to fixed local concurrency of at most two workers, retaining measured CPU,
memory and shared-resource safety clamps. Explicit adaptive-local policies retain configurable
concurrency. Adaptive default enablement requires the original live prerequisites, not merely
passing source tests or conservative headroom. Existing immutable policies are never rewritten by
a default change.

Paid execution remains explicit immutable authority. Local-compatible work uses a paid burst backend
only after local saturation and the configured burst trigger, priority threshold, provider probe,
native-unit budget, repository concurrency, egress, trust, and TTL gates all pass. Capability-required
remote work is recorded separately from overflow burst. Independent validation is pinned and
budgeted in the same admission plan, but occupies its own phase reservation. The detailed invariants
and remaining live-provider gates are in
[`ADAPTIVE-SCHEDULING-IMPLEMENTATION-PLAN.md`](ADAPTIVE-SCHEDULING-IMPLEMENTATION-PLAN.md).

When `economics.minCloudTimeSavedMinutes` is nonzero, overflow burst also requires an explicit
`requirements.estimatedDurationMinutes` value on the Work Packet at or above that threshold. Factory uses
that duration as a one-local-queue-wave time-saved proxy; it is not an observed completion forecast.
Missing evidence fails this gate closed. The estimate and threshold are preserved in the admission
receipt and exposed as estimates, not provider billing evidence. Capability-required remote work is
not an overflow optimization and does not use the time-saved gate.

Network destinations are also operator policy, not compiler authority. A compiled Work Item may
request only destinations already present in the run's immutable allowlist; the graph fails before
its first issue write otherwise. Arbitrary task-secret injection is not enabled in this release.
Sandbox model authentication uses the backend's dedicated credential broker and never grants a
general GitHub credential.

Attempt events form separate ledgers for model usage, local wall time and concurrency, sandbox time
and resources, managed sessions, retries, and validation. Native execution and validation units are
reserved before launch and reconciled on terminal status. Their separate phase and usage identities
prevent one call from overwriting another.

New requests containing `economics.maxModelTokens` must state their budget intent with
`economics.modelTokenBudgetMode`. `hard` is rejected before model work because no currently supported
model integration provides enforceable aggregate token caps; terminal counters are not enforcement.
An omitted mode on a new request is also rejected rather than silently weakening the contract.
Explicit `observed-stop` selects an observed-usage stop threshold, not a provider-enforced hard cap.
Authenticated historical policies without this field recover with their original semantics and
digests, reported as `legacy-observed-stop`; that compatibility is not permission for a new
mode-less request. Status reports both the intent and `hardCapEnforced: false` separately from balances.
Management and SDK/CLI/App Server workers must return real terminal counters; Factory persists their
input-plus-output total in both the model-token ledger and terminal Attempt receipt. On restart those
receipts reconstruct remaining observed budget. Once the threshold is exhausted, Factory refuses the
next reporting worker, compilation, or semantic review. Already-started concurrent invocations are
not given a provider token limit and can each overshoot the threshold by their terminal usage.
Cached-input tokens are not added again when the provider already includes them in input tokens.

Before a supervised model dispatch, Factory persists an invocation-bound intent. Its zero-valued
budget marker records that dispatch may occur; it is neither a token allocation nor evidence of
zero consumption. Only exact linked actual usage closes it. Live process-owned calls can coexist
under observed-mode admission, but a restarted or ended operation cannot use that ephemeral
ownership to repeat an uncertain call. A retained checkpoint repairs its actual usage receipt;
missing outcomes stay unknown and prevent new model admission. Reports preserve known subtotals
while marking total model usage and remaining threshold unavailable when invocation receipts are
unresolved.

Use matching controller and plugin artifacts for this event extension. Older controllers do not
understand invocation-intent fences; downgrading an active run to them is unsupported. Preserve
original receipts and qualify recovery with the build that implements this contract.

Where supplied by a provider, the existing terminal Attempt and model-token reconciliation receipts
also retain `reportedModelUsage`: input, output, and cached-input counters. Compilation and review
checkpoints preserve the same available breakdown. Cached input is a subset of input, not an
additional charge; these counters never change the scalar budget calculation. Missing counters
remain absent, including when reading receipts written by older builds. No extra GitHub write or
model call is introduced to obtain a breakdown.

Status, replay, and run summaries expose `economics.modelTokenBreakdown`. Each component is a
reported subtotal with counts of model-token reconciliation receipts that do and do not supply it.
Aggregation uses the scalar ledger's deduplicated latest-per-usage identity, not the duplicate
Attempt copy. Coverage is limited to recorded model-token calls: it does not imply that a managed
provider reported usage, or that a missing receipt consumed zero tokens. Neither raw nor cached
token totals establish dollar cost or a subscription's remaining quota.

This development data-format extension is backward-readable by the new build; it does not rewrite old
immutable records to invent missing cache counts. Upgrade the controller and plugin together.
Older builds with strict compilation/review checkpoint schemas cannot read enriched checkpoints,
so downgrading a controller to such a build cannot resume those runs. Stop or drain active work
before changing the installed controller; preserve its recorded policy and recovery evidence.

A rejected compilation or review still consumes model quota. When terminal counters are available,
Factory records failed-call usage even if output validation or checkpoint persistence fails. A
recoverable successful checkpoint takes precedence so the same call is not charged twice. A
failed-call receipt prevents replay of that invocation in the same run; an implementation retry
with a distinct attempt remains subject to the original policy. Missing or ambiguous counters stay
unavailable and are never replaced with an estimate or an assertion of zero consumption.

Daytona, Vercel Sandbox, GitHub Copilot, and OpenAI Codex managed-agent adapters do not currently
return authoritative model-token counters to Factory. Their token use is explicitly unavailable and
does not decrement `maxModelTokens`; sandbox-minute or managed-session reservations remain their
enforceable native bounds. Enabling one of those backends is explicit acceptance of that evidence
boundary. Managed-agent sessions can also consume GitHub Actions minutes outside Factory's own
native-unit receipts; Factory installs no workflow and does not treat the Actions allowance as an
implicit spending authorization.

Factory does not wait for final provider invoice settlement before completing work. Exact execution
termination and native admission accounting remain necessary; proof that the provider will never
adjust a later invoice does not. Report available provider usage/cost with its evidence boundary,
and unavailable values as unavailable, never zero. A managed-session count or sandbox-duration limit
is not a guaranteed currency-denominated spend cap. No billing API or broader account permission is
required merely to prove that already-terminated work has completed.

The `models` contract supports `single-profile` only. Every phase mapping must name the same
profile, whose model and reasoning effort are carried to compile, implement, review, and retry/recover
invocations. GitHub managed agents do not expose model selection, so Factory rejects combining them
with an explicit `models` block. `task-class` is rejected until a durable classifier and mapping are
part of the protocol; it is not accepted as an inert field.

## Management backends

An explicit immutable `compilerEvaluation` policy adds an obligation-first draft stage before
the existing graph commitment. `mode: "auto-repair"` runs extraction, initial compilation,
mechanical grounding, and independent whole-Objective judgment; it permits at most two repairs
by default. The default envelope is seven model invocations and 600 seconds. Optional
`maxRepairs` (0–2), `maxInvocations` (1–7), `timeoutSeconds` (1–3600), and
`maxObservedTokens` configure that bounded envelope. The normal run deadline and observed-token admission
remain additional limits. Observed tokens are not a provider-enforced hard cap. Every phase
uses the already selected compilation model; the judge receives no compiler private reasoning.

`mode: "report-only"` uses the same independently judged draft with no repair and never commits
or projects an execution graph. A completed report-only run means its evaluation purpose ended;
it does not mean the Objective was implemented, and it does not close the Objective issue.
Reports are available through `factory compiler-eval OWNER/REPO#NUMBER [--markdown]` and
`factory_compiler_eval`. These inspection entry points never invoke models or spend historical
allowances. Existing activated graphs are immutable; the source-only fixed-graph evaluation
adapter requires a fresh report-only envelope and cannot authorize issue or worker dispatch.

Draft records use `clockgrove.factory/compiler-draft-v1` in bounded immutable Git objects under
per-Objective/run sequence refs. They retain frozen source evidence, invocation intents,
provider proposals and normalization traces, usage, failed validation, every verdict, lineage,
and the exact final selection. Lease-fenced create-if-absent publication admits one invocation
winner. Missing terminal evidence is unknown accounting and forbids replay; completed results
repair their own idempotent accounting before another call. Contradictory terminal responses,
changed inputs, cycling drafts, repeated blockers, exhausted bounds, and material ambiguity
fail closed. Malformed repair output consumes its attempt. Revisions never emit `GraphCompiled`;
only an accepted exact selection reaches the existing graph commitment/projection transaction.
Changing an Objective before that commitment invalidates its assessment, including on restart.

This is an opt-in policy extension, not a change to existing immutable policies or the current
release candidate's defaults. Runs without the field retain their original compilation path.
Upgrade the plugin and controller together before enabling it; older controllers do not
understand draft-stage authority and cannot safely resume these enabled runs. Default enablement
and quality/efficiency claims require separate measured calibration and comparative evidence.
Historical reports preserve missing originals, unresolved usage and unknown causal attribution;
they cannot reconstruct absent evidence or revive a terminal run. See
[the evaluation contract](EVALUATION-CORPUS.md#independent-draft-review-and-post-mortems).

Mechanical scheduling never calls a model. A Management Backend receives narrow evidence and a
strict output schema for initial compilation and criterion-specific independent semantic review.
The management compiler explicitly classifies each criterion's risk, routes it to the least expensive
sufficient tier, and binds deterministic claims to repository-observed commands. Deterministic
post-validation rejects
unknown commands, unsupported specialized tiers, incomplete criterion coverage, and protected-risk
criteria without a deterministic gate or understated protected risk; absent, incomplete, or
ungrounded routing conservatively retains semantic review.
Bounded retries carry
the previous attempt's sanitized failure evidence as untrusted diagnostic data; the Supervisor never
widens scope, trust, backend permissions, or budget during retry. Structurally invalid compiled graphs
fail before their first GitHub issue write, while exhausted or unsafe work escalates with durable
evidence. In unattended mode the Supervisor invokes a configured CLI; in interactive mode the host
may provide the same judgment contract. Management children are explicitly marked supervised and
cannot recursively start another Supervisor.

Codex JSONL carries progress messages as well as results. Factory selects the last completed agent
message before the single terminal completion, consistent with the Codex SDK's final-response
contract. Earlier prose or JSON is not the final result; malformed final output cannot fall back to
an earlier success-shaped message. Stream failures and messages after completion fail closed, while
unambiguous terminal usage remains available for accounting.

Compilation reads bounded package-script facts before invoking the model and reuses those same facts
for command grounding. Discovery includes the observed `typecheck`, `test`, `lint`, `check`, `verify`,
and `build` npm script entry points. Its Node test-runner profile also recognizes simple observed
`node --test` recipes: a bare recipe may select concrete existing JavaScript test files or new files
inside the Work Item's scope. An already targeted recipe cannot be broadened to different targets.
This is not arbitrary shell-recipe interpretation; extra flags, traversal, unplanned targets, and
unobserved runners do not acquire authority from compiler output.

## Security and activation

Factory processes an Objective only after an authorized operator explicitly starts it, or when a
supported non-terminal run receipt already exists. A label alone never executes code. The run captures
repository, fork status, Objective author, activating identity, base branch, and accepted policy.

Local execution requires trusted repository and Objective provenance. External forks, untrusted
authors, install-script changes, unrestricted network, secret-requiring tasks, and tests of newly
supplied untrusted code route to an explicitly permitted sandbox or escalation.

All GitHub writes continue through the shared circuit breaker, mutation scheduler, content-creation
pacer, and concurrency limiter. Mutations are issued serially; actual transport attempts, including
failed HTTP requests, are priced, while a lease or shutdown fence that stops before transport is not.
Normal traffic is spread predictably across the documented content-generation window instead of
bursting into a fixed local hourly cliff. Lease traffic retains queue priority and can use safe
headroom up to the documented outer windows. A platform refusal stops mutation
under the current lease. On recovery the interrupted
reservation is reconciled and marked `AttemptDeferred`; it remains in the audit and cost ledgers but
does not consume a Work Item implementation attempt. A durable failed validation remains a real
attempt failure.

Immediately before each authoritative publication, the Director re-observes the lease ref and GitHub
server time in one REST request. An unchanged OID reuses the already-validated lease payload; only a
concurrently renewed OID requires a second commit read. Immutable Git object creation is preparation,
not publication, and performs no Objective fence read. Workflow-safety policy is re-observed after
mutation-queue admission and the final authority fence, immediately before feature-ref and
pull-request transport dispatch. An unsafe or unstable observed base fails closed; a stable safe
advance is independently revalidated. This minimizes the ordinary read-to-mutation interval without
describing cooperative dispatch checks as an atomic condition on GitHub's ref or pull-request APIs.
A fully atomic, digest-approved two-phase publication protocol is tracked in
[#301](https://github.com/clockgrove/factory/issues/301).

## Packaging and portability

Factory ships two synchronized artifacts from the same versioned source: an Agent Plugins 1.0
package containing portable skills plus one bundled stdio MCP server, and the
`@clockgrove/factory` npm package containing the `factory` CLI/controller. Provider SDKs used by
shipped adapters are bundled. Installation runs no lifecycle scripts and does not start a daemon or
modify a repository. Client-native workers and startup hooks are optional adapters; the portable MCP
server never assumes it can call back into its host.

The MCP server is the agent-facing command and inspection surface, not the unattended process. A
separately and explicitly installed local repository controller consumes the same GitHub protocol.
No custom UI or hosted endpoint is required. Any future hosted coordinator would be a separate
product and cannot become a dependency of this open-source repository; this design makes no hosted
service or enterprise-support commitment.

Application commands are durable, actor-authenticated receipts scoped to the active Objective/run;
request IDs make retries idempotent. Pause stops new admissions, while drain also releases the lease
after admitted work is reconciled and waits for a same-run Resume. Resume clears pause, drain, and
cloud-pause. Cloud-pause blocks paid execution and validation without blocking local candidates.
The command alone never suppresses crash recovery: Supervisor writes an actor-authenticated
`RunPauseAcknowledged` or `RunDrainCompleted` receipt only after every admitted execution,
validation, and review is reconciled. Discovery remains eligible until that exact command request
is acknowledged, preventing a crash after pause/drain from orphaning either a local or paid worker.
Work Item retry is named, one-shot, and remains inside immutable attempt and budget ceilings; it
cannot revive terminal work or bypass dependency, ownership, or open-pull-request gates. Explicit
priority changes affect only future admission order and never preempt running work. These states and
fenced controller observations are reconstructed from GitHub after restart.

An activation that is permanently rejected before a run starts records `ActivationRejected`, bound
to the exact request, base SHA, policy digest, and activating actor. That receipt suppresses repeated
discovery of only that activation. Classified transient platform failures do not write a rejection;
the repository controller keeps the request eligible and applies a bounded retry-after backoff.

Read-only status always returns a machine-readable `operatorAction`. Accepted queued activations,
non-terminal unpaused runs, and pause/drain requests still reconciling admitted work report
`monitoring: continue`. Inactive, withdrawn, completed, cancelled, acknowledged-paused, rejected, or
escalated states report `monitoring: stop`. Stopped states say plainly that no Factory work is active
and, when authority is required, identify exactly one next action. Recovery proposals use the same
stop contract to distinguish evidence repair, exact unknown usage acknowledgement, and submission
of an already authorized digest-bound request. A client must not turn a terminal or human-authority
gate into recurring status polling.

The activating actor may withdraw a queued activation with `factory_cancel`. Before a run starts,
this writes `ActivationCancellationRequested`, binding the original activation request, repository,
base SHA, policy digest, and actor. It neither invents a run nor records a run terminal. Exact
request-ID replay returns that original cancellation receipt even if startup raced with the first
response. Discovery suppresses only the withdrawn activation; a later distinct explicit activation
is unaffected. Activation replay may repair its structural label but never restores withdrawn
authority. Status reports the activation as `withdrawn` while the run remains `not-started`.

Startup rechecks withdrawal after acquiring its lease. If a matching run start already raced ahead,
that run remains discoverable for ordinary cancellation and cleanup. Activation-bound external
admissions and active-worker cancellation polls check the same immutable withdrawal binding; no
different activation or successor inherits it. Once a run is already active when `factory_cancel`
is observed, the existing actor-authenticated run cancellation protocol applies. Terminal history
does not become a new pending activation.

The target environment is Linux: native Linux, Windows WSL2, or a Linux guest hosted by macOS.
Codex SDK is the preferred local route and Codex CLI is its supported portable fallback. Daytona and
available managed-provider capabilities extend local execution under explicit paid-backend policies.
Qualify a provider before claiming execution support; document unsupported capabilities instead of
requiring unavailable APIs to pass a global release gate. The managed-provider capability-boundary
gate still requires evidence that declarations, admission refusal and supported claims agree.
Recovery preserves the original recorded policy.

Release evidence and open gates are listed in
[`CONFORMANCE.md`](CONFORMANCE.md). Optional host restart configuration is documented in
[`HOST-SCHEDULING.md`](HOST-SCHEDULING.md); plugin installation never enables it implicitly.

## Definition of done

The stable identifiers below make every part of the release contract traceable to executable
evidence in [`CONFORMANCE.md`](CONFORMANCE.md):

- **DOD-1 — Portable installation.** A clean adopter can install the Agent Plugin or
  `@clockgrove/factory`, authenticate GitHub, and deliberately install one local repository
  controller without install-time lifecycle scripts.
- **DOD-2 — GitHub-only durable control.** GitHub issues, sub-issues, dependency relationships, pull
  requests, and versioned custom refs contain the durable orchestration state; Factory requires no
  Action, hosted service, database, sidecar queue, or custom UI.
- **DOD-3 — Objective compilation and activation.** A chat/MCP activation compiles an Objective into
  a bounded, cost-aware graph of native Work Item sub-issues before execution.
- **DOD-4 — Adaptive local-first execution.** Trusted dependency-ready work runs locally by default,
  with concurrency continuously constrained by CPU, memory, repository, Objective, backend, path,
  and exclusive-resource limits.
- **DOD-5 — Explicit bounded cloud burst.** Daytona or managed-agent execution is opt-in and occurs
  only when policy, capability, priority, queue/deadline trigger, independent-validation capacity,
  and hard native budget reservations all admit it.
- **DOD-6 — Durable recovery.** Controller, worker, validation, publication, and integration restarts
  reconstruct facts from GitHub without duplicating already valid work or widening authority.
- **DOD-7 — Evidence-bound delivery.** Independent validation binds the exact artifact tree and pull
  request head; sibling or supported stacked delivery integrates only reversible, current evidence
  and closes the Objective only after all Work Items ship.
- **DOD-8 — Explainable, replayable economics.** Bounded status, explanation, replay, and run-summary
  surfaces distinguish observed facts from unavailable data and expose stable gates, reasons,
  priorities, capacity, burst use, and recorded cost units without writing the control plane.
- **DOD-9 — Evidenced human boundaries.** Human attention occurs only for a specific product, policy,
  safety, budget, platform, provider, or correctness boundary carrying concrete evidence and a
  required action; retries never silently broaden scope, trust, compute, credentials, or spending.

Passing deterministic and package conformance proves the implementation contract. Broad platform
or paid-provider support is claimed only after the corresponding live gate in `CONFORMANCE.md` also
passes.
