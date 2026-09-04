# Factory v2 — Design

This is Factory's authoritative design. [`PROTOCOL-V1.md`](PROTOCOL-V1.md) preserves the original
GitHub Copilot execution protocol, which remains supported only as a compatibility backend.

Factory v2's release designation is preview. That designation applies to the complete product
contract, not to selected capabilities within it. A capability belongs to the v2 contract when it
passes the same deterministic, package, security, recovery, and applicable live-provider gates
recorded in [`CONFORMANCE.md`](CONFORMANCE.md). Additional integrations live in Labs instead of
weakening the meaning of the supported contract.

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

## V2 release scope

The v2 preview is a Linux product. Its supported environment matrix is:

- native Linux on a laptop, desktop, or developer workstation;
- a Linux distribution under Windows WSL2, with Factory state and repositories in the Linux
  filesystem; and
- a Linux guest hosted by macOS, with the controller and workers running inside that guest.

Windows and macOS may host or access the Linux environment, but native Win32 and native Darwin
process management, worktrees, credential handling, and service lifecycle are not supported targets.
Coordinating a pool of multiple local computers is also out of scope.

The v2 support contract includes both the Agent Plugins package and the `@clockgrove/factory` npm
CLI/controller, Codex SDK local execution with Codex CLI fallback, Daytona sandbox burst, GitHub
Copilot and OpenAI Codex managed-agent execution, and regular or native stacked pull-request
delivery. The unreleased Codex profile remains fail-closed until live conformance records a stable,
provider-published actor identity; a display name is not identity evidence. Paid backends always
require explicit immutable authority and budgets; inclusion in the support contract never makes
cloud execution the default.

Labs contains Vercel Sandbox, Codex App Server, and additional harness/provider experiments. Labs
adapters may reuse the production contracts and tests, but they are not release blockers and must not
be selected implicitly. The boundary and its rationale are recorded in
[`decisions/0007-v2-preview-release-boundary.md`](decisions/0007-v2-preview-release-boundary.md).

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
acquires the repository and Objective leases, and continues without holding the chat turn open. The
controller shares one CPU, memory, backend, and GitHub-rate-limit pool. The v2 release admits one
Objective at a time in that repository. Native-stack delivery may admit dependency-ready Work Items
concurrently; regular-PR delivery admits one complete Work Item pipeline at a time. Additional
activations remain durable and queued. Plugin installation never starts or installs the controller;
service installation is a separate explicit user action.

Each controller process acquires the repository lease under one generated controller identity and
epoch. That same identity is recorded with every Objective Supervisor observation and fences
admission and integration across the checkout. Restart or takeover acquires a new identity/epoch;
process-local queues and cursors never survive as authority.

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

The ordered implementation and migration gates are in
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
Both API surfaces still share Factory's circuit breaker, concurrency limiter, content-creation pacer,
and secondary-rate-limit handling. Unchanged idle state is polled no more often than once per minute
by default, while active local-worker cancellation uses the cheaper REST comments path.

Model quota is protected at retry boundaries as well. After an artifact has passed host scope,
secret, clean-apply, and sensitive-path checks, the running Supervisor may retain it in a bounded
32 MiB in-memory cache. A retry at the same base SHA is seeded with that complete patch and receives
the bounded failure diagnostic, so it repairs prior work instead of recreating it. This cache is a
non-authoritative optimization: it cannot change derived state, is lost on restart, is never used by
a provider-managed publication backend, and every resulting complete patch is independently
revalidated from the pinned base.

## Versioned GitHub protocol

Every machine-readable v2 record contains at least:

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

The graph is immutable for the lifetime of its run. Factory may retry a Work Item with bounded prior
failure evidence, but it does not silently replace issue scope, dependencies, or budget through a
second compilation. An inadequate durable graph escalates; an explicitly authorized new run is the
boundary for a different graph. See
[`decisions/0002-immutable-graph-recovery.md`](decisions/0002-immutable-graph-recovery.md).

## Repository-controller and Director leases

Exactly one repository controller owns admission and integration for a checkout. Its custom-ref
lease records one generated controller ID, policy digest, epoch, sequence, and server-relative
expiry. All Objective Supervisors started by that process carry this controller observation and
recheck it at mutation boundaries. A second process cannot become an additional scheduler under the
same identity; it must wait or acquire a later fenced epoch after expiry/release.

Exactly one Director may schedule or integrate one Objective at a time. The lease is a commit chain
under a custom ref such as `refs/clockgrove-factory/leases/objective-166`.

Lease mutation uses GitHub GraphQL `updateRefs`, not REST `updateRef`. Every update supplies
`beforeOid` and `afterOid`; the stale caller fails atomically if the ref no longer points to the
observed commit. The new commit records holder, run ID, monotonically increasing epoch and sequence,
server-relative expiry, and policy digest. Launch, budget reservation, publication, validation, and
integration all recheck current lease ownership and epoch.

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

Before launch, the Supervisor creates an immutable metadata commit using the base tree and creates a
deterministic custom attempt ref. The commit records protocol, run, Objective, Work Item, attempt,
backend, base SHA, lease epoch, policy digest, creation time, and budget reservation. Ref creation is
atomic; a conflict is re-read, never assumed to belong to the caller.

Only after reservation and another lease/budget check may the backend launch. The trusted Supervisor
writes lifecycle events: reserved, started, meaningful progress, succeeded, failed, timed out,
cancelled, infrastructure-deferred, collected, published, validated, and integrated. It opens no
empty pull request. A PR exists only after a meaningful artifact has been inspected, committed, and
pushed by the host.

Crash recovery is reconstruction:

- an attempt ref without a comment repairs the comment;
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

## Provider-neutral Work Item state

V2 state is a pure function of one GitHub snapshot and its server timestamp:

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

Receipt-free Copilot Objectives continue to use v1 derivation. An active attempt remains pinned to
the protocol and backend that created it. Inconsistent mixed state is reported; it is never guessed
into a runnable state.

## Worker and artifact contract

The compiler emits a bounded Worker Packet containing goal, acceptance criteria, allowed paths,
preconditions, exclusions, repository conventions, base SHA, validation commands, trust class,
OS/architecture and resource requirements, required tools/services/network destinations, permitted
secret names, and the output contract.

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

Repository CI remains supported but Factory does not impersonate required checks. Preflight reads
branch rules and required checks before spending on implementation. If a required check cannot be
produced without repository configuration, Factory escalates before launch.

Only branch-rule shapes whose autonomous semantics are proven are allowed. Unknown rule types fail
closed. Human-approval, code-owner, last-push approval, and incompatible merge-method requirements
escalate rather than being bypassed. Regular sibling PRs are the default. Explicit stacked delivery
uses GitHub's pinned REST surface only after an observed repository capability probe; an
unavailable capability produces a durable configured fallback or escalation before publication.
The regular-PR fallback admits one complete Work Item pipeline at a time. This is an intentional
correctness boundary: ordinary sibling PRs share the trunk base, while only native stacks currently
provide cascading rebase plus fresh validation and semantic review after a lower layer changes.
Immediately before each regular or stacked merge, integration is repository-fenced and Factory
rechecks the exact validated head, current stack/base relationship, current branch rules, required
checks, leases, and mergeability. A lower-layer rebase invalidates every affected descendant receipt
before validation is rerun. Parallel workers therefore cannot merge sequentially from the same stale
base. Native stacks are part of the v2 contract; release remains gated on their live conformance
matrix.

Immediately before merge, Factory rechecks lease epoch, policy digest, validated SHA, checks,
mergeability, branch rules, scope, and semantic acceptance. Integration is a reversible squash merge.
Force-push, history rewrite, settings changes, releases, and cross-repository writes are absent from
the autonomous tool surface.

## Execution backends

Every backend exposes capability, availability, launch, observe, cancel, collect, and cleanup
contracts. The v2 release bundles are:

- `codex-sdk/local-worktree` — preferred programmatic local backend in every supported Linux environment;
- `codex-cli/local-worktree` — supported portable local fallback;
- `codex-cli/daytona` — supported opt-in paid sandbox burst;
- `github-copilot/github-managed` — supported opt-in GitHub Copilot managed agent; and
- `openai-codex/github-managed` — bundled opt-in OpenAI Codex release profile; unavailable until its
  live gate records a stable provider-published identity.

`codex-cli/vercel-sandbox`, `codex-app-server/local-worktree`, and harness-native child-worker
adapters are Labs integrations. The installed package must still start when their optional
credentials or host capabilities are unavailable. The local default/fallback decision is recorded
in [`decisions/0008-codex-sdk-default.md`](decisions/0008-codex-sdk-default.md).

Missing optional credentials or SDK support cannot prevent local plugin or MCP startup.

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
  "maxParallel": 8,
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

Paid execution remains explicit immutable authority. Local-compatible work uses a paid burst backend
only after local saturation and the configured burst trigger, priority threshold, provider probe,
native-unit budget, repository concurrency, egress, trust, and TTL gates all pass. Capability-required
remote work is recorded separately from overflow burst. Independent validation is pinned and
budgeted in the same admission plan, but occupies its own phase reservation. The detailed invariants
and remaining live-provider gates are in
[`ADAPTIVE-SCHEDULING-IMPLEMENTATION-PLAN.md`](ADAPTIVE-SCHEDULING-IMPLEMENTATION-PLAN.md).

When `economics.minCloudTimeSavedMinutes` is nonzero, overflow burst also requires an explicit
`requirements.estimatedDurationMinutes` value on the Work Packet at or above that threshold. V2 uses
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

`economics.maxModelTokens` is an observed-usage stop threshold, not a provider-enforced hard cap.
Management and SDK/CLI/App Server workers must return real terminal counters; Factory persists their
input-plus-output total in both the model-token ledger and terminal Attempt receipt. On restart those
receipts reconstruct remaining observed budget. Once the threshold is exhausted, Factory refuses the
next reporting worker, compilation, or semantic review. Already-started concurrent invocations are
not given a provider token limit and can each overshoot the threshold by their terminal usage.
Cached-input tokens are not added again when the provider already includes them in input tokens.

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

The v2 `models` contract supports `single-profile` only. Every phase mapping must name the same
profile, whose model and reasoning effort are carried to compile, implement, review, and retry/recover
invocations. GitHub managed agents do not expose model selection, so Factory rejects combining them
with an explicit `models` block. `task-class` is rejected until a durable classifier and mapping are
part of the protocol; it is not accepted as an inert preview field.

## Management backends

Mechanical scheduling never calls a model. A Management Backend receives narrow evidence and a
strict output schema for initial compilation and independent semantic review. Bounded retries carry
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
pacer, and concurrency limiter. Mutations are issued serially and are priced at admission, including
failed requests. Normal writes leave 24 hourly mutation slots reserved for lease acquisition and
renewal. A paced normal write sleeps outside the priority gate and outside lease-renewal
serialization, so a busy audit stream cannot starve the heartbeat. A platform refusal stops mutation
under the current lease. On recovery the interrupted
reservation is reconciled and marked `AttemptDeferred`; it remains in the audit and cost ledgers but
does not consume a Work Item implementation attempt. A durable failed validation remains a real
attempt failure.

Immediately before each externally visible mutation, the Director re-observes the lease ref and
GitHub server time in one REST request. An unchanged OID reuses the already-validated lease payload;
only a concurrently renewed OID requires a second commit read. This keeps strict per-write fencing
without the previous three-read assertion cost.

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

The v2 environment claim is Linux: native Linux, Windows WSL2, or a Linux guest hosted by macOS.
Codex SDK is the preferred local route and Codex CLI is its supported portable fallback. Daytona and
the two GitHub-managed release targets extend local execution only after their publication-blocking
live gates pass and under explicit paid-backend policies. V1 GitHub Copilot execution remains
resumable during migration.

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
