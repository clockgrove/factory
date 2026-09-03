# Factory vNext — Design

This is Factory's authoritative design. [`PROTOCOL-V1.md`](PROTOCOL-V1.md) preserves the original
GitHub Copilot execution protocol, which remains supported only as a compatibility backend.

## Product contract

Factory turns a human Objective into shipped software. It compiles the Objective into native GitHub
Work Item sub-issues, records dependencies with native `blocked by` relationships, schedules ready
work, executes it through policy-approved backends, independently validates the result, publishes and
integrates acceptable pull requests, and releases newly unblocked work until the Objective is done.

The contract is:

- GitHub is the durable, versioned control plane: Objectives, Work Items, dependencies, run and
  attempt events, control refs, pull requests, checks, and audit evidence.
- Factory has no private database, queue, lease service, webhook receiver, or deployed control plane.
- The installed plugin and an operator-started harness process are sufficient. Factory orchestration
  never requires a GitHub Action or repository-specific Factory configuration.
- Trusted local compute is the default. Paid sandboxes and GitHub-managed coding agents are opt-in.
- Unchanged-state polling is mechanical and model-free. Model calls occur only for compilation and
  semantic review; retry and escalation boundaries remain mechanically policy-bounded.
- Workers are untrusted producers of artifacts. They never own GitHub publication, integration, run
  state, budget state, or Director authority.
- Minimal human involvement is the goal, but escalation is correct when policy, safety, budget,
  platform constraints, or evidence prevent safe autonomous progress.

## Component map

```text
                            GitHub
      Objective / Work Items / dependencies / run and attempt events
                  refs / commits / pull requests / checks
                               ▲
                               │ durable, versioned control state
                               │
                     Factory Supervisor
       lease / schedule / budget / retry / validate / publish / integrate
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

The canonical unattended entry point is:

```text
factory run OWNER/REPO#OBJECTIVE --until-terminal
```

One invocation validates access, policy, branch rules, and backend capabilities; writes a run
receipt; acquires the Objective lease; compiles an empty Objective; schedules and supervises work;
validates and integrates results; and exits only on completion, cancellation, escalation, or an
operational failure.

While the process is alive, no scheduler outside Factory is required. A powered-off host cannot wake
itself; optional user-authorized `systemd`, `launchd`, Task Scheduler, or harness automation adapters
may restart the same command. A new process reconstructs everything durable from GitHub.

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
without duplicates and without asking a model to reproduce prior output. Any divergent ref, receipt,
or per-item envelope fails closed.

The graph is immutable for the lifetime of its run. Factory may retry a Work Item with bounded prior
failure evidence, but it does not silently replace issue scope, dependencies, or budget through a
second compilation. An inadequate durable graph escalates; an explicitly authorized new run is the
boundary for a different graph. See
[`decisions/0002-immutable-graph-recovery.md`](decisions/0002-immutable-graph-recovery.md).

## Single-Director lease and fencing

Exactly one Director may schedule or integrate one Objective at a time. The lease is a commit chain
under a custom ref such as `refs/clockgrove-factory/leases/objective-166`.

Lease mutation uses GitHub GraphQL `updateRefs`, not REST `updateRef`. Every update supplies
`beforeOid` and `afterOid`; the stale caller fails atomically if the ref no longer points to the
observed commit. The new commit records holder, run ID, monotonically increasing epoch and sequence,
server-relative expiry, and policy digest. Launch, budget reservation, publication, validation, and
integration all recheck current lease ownership and epoch.

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
cancelled, infrastructure-deferred, collected, published, validated, and integrated. It opens no empty pull request. A PR
exists only after a meaningful artifact has been inspected, committed, and pushed by the host.

Crash recovery is reconstruction:

- an attempt ref without a comment repairs the comment;
- a stale reservation is reconciled and marked infrastructure-deferred unless durable validation
  already proves a real work failure;
- deterministic provider names locate and stop a partially recorded remote launch before replacement;
- orderly local exit kills the worker process group; restart identifies any surviving Linux/WSL
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

The normalized artifact identifies its exact base SHA, changed paths, patch or bundle/delta, reported
commands, bounded logs, optional checkpoints, and terminal outcome. The Supervisor rejects bad base
SHAs, forbidden paths, malformed outputs, oversized fields, and suspected secrets before any GitHub
publication.

## Independent validation and integration

Worker self-report is never authoritative. The trusted host applies the artifact to a fresh checkout
at the recorded base, rechecks scope and sensitive surfaces, runs the declared validation plan in the
required trust boundary, records evidence bound to exact input and output SHAs, and only then creates
the publication commit and pull request.

Repository CI remains supported but Factory does not impersonate required checks. Preflight reads
branch rules and required checks before spending on implementation. If a required check cannot be
produced without repository configuration, Factory escalates before launch.

Only branch-rule shapes whose autonomous semantics are proven are allowed. Unknown rule types fail
closed. Human-approval, code-owner, last-push approval, merge-queue, and incompatible merge-method
requirements escalate rather than being bypassed. Immediately before each merge, integration is
serialized and Factory rechecks the exact validated head, unchanged base SHA, current branch rules,
required checks, lease, and mergeability. Parallel workers therefore cannot merge sequentially from
the same stale base.

Immediately before merge, Factory rechecks lease epoch, policy digest, validated SHA, checks,
mergeability, branch rules, scope, and semantic acceptance. Integration is a reversible squash merge.
Force-push, history rewrite, settings changes, releases, and cross-repository writes are absent from
the autonomous tool surface.

## Execution backends

Every backend exposes capability, availability, launch, observe, cancel, collect, and cleanup
contracts. The initial supported bundles are:

- `codex-cli/local-worktree` — mandatory local backend on Linux/WSL;
- `codex-native/local-worktree` — only when the active harness exposes a measured child-worker API;
- `codex-cli/daytona` — optional paid isolated runtime;
- `codex-cli/vercel-sandbox` — optional paid isolated runtime;
- `github-copilot/github-managed` — explicit v1-compatible paid/managed fallback.

Missing optional credentials or SDK support cannot prevent local plugin or MCP startup.

Local work uses an exact-SHA Git worktree and a killable process group. The first implementation uses
Codex CLI non-interactively with `--ephemeral`, `--ignore-user-config`, JSONL output, and an output
schema. It sets approval policy to `never`, so sandbox-boundary requests fail instead of waiting for a
human or an automatic reviewer. Management calls are read-only. Workers use `workspace-write` with
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
Vercel remain separate adapters wherever their real behavior differs. Inside those dedicated outer
sandboxes, Codex uses its documented bypass mode; the provider boundary, TTL, and egress policy are
therefore the security boundary rather than a nested CLI sandbox.

## Routing, costs, and budgets

The default policy is local-only:

```json
{
  "backendOrder": ["codex-cli/local-worktree"],
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

Routing filters by requirements and trust, removes unavailable or unauthenticated backends, removes
policy- or budget-forbidden choices, then chooses the first permitted backend in operator order. No
implicit paid fallback exists. If no backend remains, Factory escalates before launch.

Network destinations are also operator policy, not compiler authority. A compiled Work Item may
request only destinations already present in the run's immutable allowlist; the graph fails before
its first issue write otherwise. Arbitrary task-secret injection is not enabled in this release.
Sandbox model authentication uses the backend's dedicated credential broker and never grants a
general GitHub credential.

Attempt events form separate ledgers for model usage, local wall time and concurrency, sandbox time
and resources, managed sessions, retries, and validation. Budget is reserved before launch and
reconciled on terminal status. Execution and isolated-validation reservations are separate phases,
so one cannot overwrite or hide the other. A ceiling is not a target.

## Management backends

Mechanical scheduling never calls a model. A Management Backend receives narrow evidence and a
strict output schema for initial compilation and independent semantic review. Bounded retries carry
the previous attempt's sanitized failure evidence as untrusted diagnostic data; the Supervisor never
widens scope, trust, backend permissions, or budget during retry. Structurally invalid compiled graphs
fail before their first GitHub issue write, while exhausted or unsafe work escalates with durable
evidence. In unattended mode the Supervisor invokes a configured CLI; in interactive mode the host
may provide the same judgment contract. Management children are explicitly marked supervised and
cannot recursively start another Supervisor.

## Security and activation

Factory processes an Objective only after an authorized operator explicitly starts it, or when a
supported non-terminal run receipt already exists. A label alone never executes code. The run captures
repository, fork status, Objective author, activating identity, base branch, and accepted policy.

Local execution requires trusted repository and Objective provenance. External forks, untrusted
authors, install-script changes, unrestricted network, secret-requiring tasks, and tests of newly
supplied untrusted code route to an explicitly permitted sandbox or escalation.

All GitHub writes continue through the shared circuit breaker, content-creation pacer, and concurrency
limiter. A platform refusal stops mutation under the current lease. On recovery the interrupted
reservation is reconciled and marked `AttemptDeferred`; it remains in the audit and cost ledgers but
does not consume a Work Item implementation attempt. A durable failed validation remains a real
attempt failure.

## Packaging and portability

Factory remains an Agent Plugins 1.0 package: portable skills plus one bundled stdio MCP server.
Provider SDKs used by shipped adapters are bundled. Installation runs no lifecycle scripts and needs
no `node_modules`. Client-native workers and startup hooks are optional adapters; the portable MCP
server never assumes it can call back into its host.

The first v2 release claim is Codex CLI on Linux/WSL. Other harness-native routes are added to the
supported matrix only after the same conformance suite passes. V1 GitHub Copilot execution remains
resumable during migration.

Release evidence and deliberately unclaimed adapters are listed in
[`CONFORMANCE.md`](CONFORMANCE.md). Optional host restart configuration is documented in
[`HOST-SCHEDULING.md`](HOST-SCHEDULING.md); plugin installation never enables it implicitly.

## Definition of done

A clean adopter can install Factory, authenticate GitHub, explicitly start an Objective, compile it
into native Work Item sub-issues, run trusted work locally by default, opt into supported sandboxes or
GitHub-managed sessions, recover after crashes without duplicate valid work, validate independently,
integrate only evidence-backed reversible changes, and close the Objective without Factory Actions,
a deployed service, a database, or a queue. Human attention occurs only for a specific, evidenced
policy, safety, budget, platform, or correctness boundary.
