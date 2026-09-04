# Factory for indie developers — implementation plan

Status: core delivery waves implemented; release finalization and live qualification in progress

Date: 2026-09-03

Build a local-first factory that turns GitHub Objectives into validated, integrated pull requests
for indie developers and small teams. The delivery waves below identify the implementation tasks,
dependencies, and acceptance checks. Follow [`DESIGN.md`](DESIGN.md) for the product contract and
the detailed priority, capacity, and burst work in
[`ADAPTIVE-SCHEDULING-IMPLEMENTATION-PLAN.md`](ADAPTIVE-SCHEDULING-IMPLEMENTATION-PLAN.md).

Remaining qualification work includes formal npm publication, the complete Linux environment
matrix, live native-stack coverage,
one real Daytona Objective, two real GitHub-managed agents, and the adversarial installed-product
run. [`CONFORMANCE.md`](CONFORMANCE.md) is the authoritative evidence ledger.

Active runs retain their recorded protocol and policy. Changes must preserve their safe recovery;
release claims require the corresponding conformance evidence.

## Product thesis

Factory is a catalyst and multiplier for an indie developer or small trusted team. It turns a
GitHub Objective into small, executable Work Items; runs capable coding agents concurrently where
the work is genuinely independent; uses one local laptop or desktop first; bursts onto explicitly
authorized cloud capacity when the time saved justifies the cost; independently validates the
result; and delivers reviewable pull requests.

Factory does not compete with coding agents such as Codex, Claude Code, or hosted autonomous
developers. Those systems perform engineering work. Factory supplies the compiler, scheduler,
control protocol, economic policy, recovery loop, and integration discipline that make several
agent sessions behave like one production system.

The external promise is:

> Factory turns one developer, one computer, and the AI agents they already use into a coordinated
> software studio.

The optimization target is:

> Maximize validated progress per dollar and per hour, not agent activity, token throughput, or raw
> concurrency.

## Target user and primary scenario

The primary user is an indie developer or small startup team that:

- works in one GitHub repository at a time;
- has a capable laptop or desktop with an existing local checkout and toolchain;
- wants to use frontier models without paying for redundant context and failed work;
- wants local execution to consume available CPU and memory without making the computer unusable;
- will authorize bounded paid sandboxes when they shorten the critical path;
- wants to work through agent chat rather than learn a separate Factory UI;
- is willing to make product and safety decisions but does not want to supervise routine execution;
- reviews normal GitHub issues and pull requests, including stacks, as the delivery surface.

The canonical success path is:

1. The developer describes or selects a GitHub Objective in chat.
2. Factory grounds itself in the repository and compiles the Objective into the smallest complete
   DAG of Work Items. Work Item count is derived, never targeted.
3. Factory explains the proposed critical path, likely conflicts, validation plan, local resource
   demand, optional cloud ceiling, and expected human decisions.
4. The developer explicitly activates the run. That single action records an immutable authority
   and cost envelope in GitHub.
5. A repository controller continues after the chat turn, admits safe local work continuously, and
   bursts only inside the recorded policy.
6. Workers return restricted artifacts. Factory validates them independently and publishes focused
   sibling or stacked pull requests.
7. Factory recovers from process, machine, provider, and GitHub interruptions without duplicating
   valid work or widening authority.
8. The developer returns to a coherent set of validated pull requests, or to one specific,
   evidence-backed decision that genuinely requires them.

## Locked product decisions

| Decision | Contract |
| --- | --- |
| Human interface | Agent chat through a Factory skill and typed MCP tools. No custom Factory UI. |
| Durable control plane | GitHub issues, native sub-issues and dependencies, custom refs, commits, comments, and pull requests. |
| Scheduler | One deliberately installed local repository controller, plus a foreground compatibility command. MCP is not the scheduler. |
| Default execution | Official Codex SDK in an exact-SHA Git worktree, with Codex CLI as the supported portable fallback. |
| Scaling target | One Linux environment on one laptop or desktop, with optional cloud burst. Supported environments are native Linux, Windows WSL2, and a Linux guest hosted by macOS. Multiple local hosts are not a target. |
| Cost posture | Local-first, paid execution off by default, immutable native-unit budgets, no automatic budget increase. |
| Model posture | Frontier models are supported throughout. Savings come first from precise compilation, bounded context, reuse, fewer retries, and selective semantic calls; cheaper model routing is optional. |
| Delivery | Focused pull requests; native GitHub stacked pull requests are first-class for linear code dependencies. |
| Visual surface | GitHub remains the issue, diff, evidence, review, and merge UI. |
| Installation | Installing the plugin never installs a GitHub Action, changes a repository, or starts a daemon. Controller installation is a separate explicit action. |
| Open-source boundary | No required hosted Factory server, database, queue, account, or telemetry service. |
| Hosted boundary | A hosted MCP/coordinator may be a later paid target, but it cannot become a dependency of the open-source local product. |
| Sandbox provider | Daytona is the supported third-party sandbox target. Vercel Sandbox is Labs. |
| Managed agents | GitHub Copilot and OpenAI Codex are the two managed-agent targets. Both are opt-in, budget-bounded, and publication-gated; Codex discovery stays fail-closed until live evidence records a stable provider-published identity. |
| Labs | Vercel Sandbox, Codex App Server, and additional harness/provider adapters. |
| Native host lifecycle | Win32 and Darwin execution and lifecycle are out of scope; Windows and macOS host supported Linux environments. |

Official OpenAI plugin guidance supports skills plus an MCP server with structured, model-readable
results and no custom UI. GitHub's stacked-pull-request surface remains behind a versioned capability
adapter and an explicitly recorded fallback policy.

## System architecture

```text
Developer
   │ natural language
   ▼
Codex or another compatible agent host
   │ Factory workflow instructions
   ▼
Factory skill
   │ typed, annotated operations
   ▼
Factory MCP server ─────────────── read-only doctor / plan / status / explain
   │ durable command events
   ▼
GitHub control protocol
   ▲
   │ poll, lease, reconcile, record
   ▼
Local repository controller (factoryd)
   │
   ├── Objective compiler and reviewer
   ├── repository-wide admission controller
   ├── local Codex session adapter ── exact-SHA worktrees
   ├── optional cloud adapters ─────── bounded ephemeral sandboxes
   ├── clean validation
   └── stacked/sibling PR publisher and integrator
```

The MCP server and controller do not need a private IPC protocol. Authenticated Objective comments
are the single atomic command journal. Every transport uses one semantic request-ID normalizer;
response-loss retries may append an identical comment, but reconstruction applies at-least-once
duplicates only once and rejects conflicting reuse. The controller observes those events through the
same reconstructed snapshot used after a restart. Read tools derive status and explanations from
GitHub. Local-only diagnostics may inspect the current checkout and controller process without
becoming authoritative state.

This split gives each component one job:

- the skill turns human intent into the correct bounded workflow;
- MCP exposes safe, typed, auditable capabilities to any compatible agent host;
- `factoryd` owns unattended process lifetime and mechanical scheduling;
- GitHub owns durable facts and the human review surface;
- execution backends own agent sessions and isolated compute;
- workers remain untrusted producers of artifacts.

## Authority and activation

A label alone never causes execution. The default activation mode remains explicit per Objective.

`factory_activate` performs preflight and writes an idempotent `ActivationRequested` event containing
the activating GitHub identity, repository identity, Objective, base SHA, complete accepted policy,
policy digest, controller protocol range, and request id. It returns after the durable request is
accepted; it does not remain attached to the execution loop.

The repository controller may compile and execute an Objective only when all of the following hold:

- the repository matches its configured checkout and authenticated remote;
- the Objective has the structural `factory:objective` identity;
- a supported non-terminal activation or run receipt exists;
- the activating identity and Objective provenance satisfy the recorded trust policy;
- the controller can acquire its repository lease and the Objective Director lease;
- policy, branch, backend, credential, and resource preflight passes.

The controller writes `FactoryRunStarted` only after it has accepted ownership. A request received
while the controller is offline remains visibly queued in GitHub. Starting a controller later
continues it without another chat or model turn.

An optional future `trusted-author-auto` mode may activate newly discovered Objectives from a pinned
allowlist, but it is not part of the initial release. It must be separately authorized and cannot be
inferred from a label, repository membership, or prior run.

## Repository controller

Add a repository-scoped command:

```text
factory controller run OWNER/REPO --repo /absolute/checkout [--defaults FILE]
```

It manages every supported active Objective in that repository through one process, one shared
GitHub rate limiter, one local capacity pool, and one backend budget ledger. The existing
`factory run OWNER/REPO#N --until-terminal` remains a foreground compatibility path and uses the same
controller primitives for one Objective.

### Controller lifecycle

Provide explicit lifecycle commands and matching MCP tools where the host permits them:

```text
factory controller install OWNER/REPO --repo DIR [--defaults FILE]
factory controller status OWNER/REPO --repo DIR
factory controller start OWNER/REPO --repo DIR
factory controller stop OWNER/REPO --repo DIR
factory controller uninstall OWNER/REPO --repo DIR
```

The lifecycle target is a `systemd` user service inside native Linux, Windows WSL2, or a Linux guest
hosted by macOS. Native `launchd` and Windows Task Scheduler support is out of scope; host-native
wrappers may start the Linux environment but do not own Factory's controller lifecycle.

Installation must:

- be explicitly requested by the user;
- use absolute paths and contain no secret value;
- write only a generated, version-marked service definition;
- validate the checkout, Node runtime, Codex authentication, and GitHub authentication first;
- show the exact command and policy source that will run;
- be idempotent;
- refuse to overwrite a non-Factory service definition;
- support a clean uninstall that removes only the matching generated definition.

Plugin installation itself never invokes these commands.

### Repository fencing

Add a compare-and-swap repository-controller lease under a custom ref. The receipt records an opaque
controller ID, run-compatible protocol range, epoch, expiry, and policy-default digest. It does not
publish a hostname or other unnecessary machine identifier.

The repository lease prevents a foreground runner and a service controller from independently
scheduling the same repository. Per-Objective Director leases remain the narrower ownership and
recovery boundary. Repository integration uses a short separately fenced critical section to
serialize rebase, stack mutation, and merge without holding the scheduler lease longer than
necessary.

If the repository lease is lost, the controller stops new mutations and admissions, cancels owned
local children, observes or cancels paid resources through deterministic provider identities, and
reconciles before another controller admits work.

### Objective queue behavior

Multiple durable activations are supported because a developer can legitimately queue a second
feature while the first runs. Factory admits one Objective per repository controller so a trunk merge
cannot invalidate another Objective's immutable base; concurrency is within its Work Item DAG. This
is not a multi-host or enterprise scheduler.

The controller:

- maintains one repository-wide local and cloud capacity ledger;
- enforces each Objective's immutable budget independently;
- enforces repository-wide hard concurrency and provider ceilings;
- selects the next queued Objective deterministically after the active Objective finishes;
- never lets one large, temporarily unplaceable item block smaller eligible work;
- reconstructs active path and resource claims from attempt receipts after restart.

No organization-wide queues, quotas, fairness schemes, or cross-repository transactions are added.

## Product protocol additions

Extend `clockgrove.factory/v2` envelopes with optional fields so stored runs remain reconstructable.
Verify stored policy digests against their recorded external shape before normalizing defaults.

### Controller and run policy

Keep local host safety separate from per-Objective execution authority. Add a local
`ControllerPolicySchema` conceptually shaped as follows:

```json
{
  "scope": "repository",
  "maxActiveObjectives": 1,
  "maxLocalWorkers": 8,
  "maxPaidWorkers": 3,
  "pollIntervalSeconds": 15
}
```

The controller policy is supplied at explicit controller install/start and contains no secret. Its
digest and normalized non-secret content are recorded for each controller epoch so an admission can
be reconstructed. It is a host safety ceiling, not execution authority: a nonzero paid-worker limit
does not authorize any provider or expenditure.

Extend `RunPolicySchema` with strict per-Objective blocks conceptually shaped as follows:

```json
{
  "delivery": {
    "mode": "stacked-prs",
    "onUnavailable": "regular-prs",
    "merge": "bottom-up"
  },
  "models": {
    "mode": "single-profile",
    "profiles": {
      "default": {
        "model": "gpt-5",
        "reasoning": "high"
      }
    },
    "phaseProfiles": {
      "compile": "default",
      "implement": "default",
      "review": "default",
      "recover": "default"
    }
  },
  "economics": {
    "maxModelTokens": 1000000,
    "maxSandboxMinutes": 480,
    "maxManagedSessions": 0,
    "minCloudTimeSavedMinutes": 20
  }
}
```

The numeric values in these schema examples illustrate shape, not universal defaults. An omitted
local-worker ceiling is resolved conservatively from the effective host CPU/memory and the protocol's
absolute safety limit. Paid execution remains zero-authority by default regardless of the
controller's ability to host it.

Effective admission is the intersection of the controller policy, the Objective's immutable run
policy, current measured capacity, backend capability, and remaining native-unit budgets. Increasing
a controller ceiling never widens a run beyond the authority the user already recorded. Every
admission receipt includes both policy digests and the effective caps it observed.

The exact model identifier and supported reasoning effort are supplied by the operator. Factory
contains no fashionable model default. Factory accepts `single-profile` only and requires every phase to
name the same profile; that choice is routed into compile, implement, review, and retry/recover
invocations. `task-class` is rejected until a durable classifier and mapping exist. GitHub managed
agents do not expose model selection, so they cannot be combined with this explicit block.

Budget controls use provider-native measurable units. `maxModelTokens` is deliberately a
stop-before-next-call threshold over observed management and reporting local-worker usage, not a
provider-enforced hard cap. Already-started concurrent calls can each overshoot it. Opaque sandbox
and managed-agent token use remains unavailable and is bounded by sandbox minutes or managed
sessions instead. A
dollar estimate may be reported only when the provider supplies adequate price and usage data; it is
never presented as an enforcement boundary.

### Durable control events

Add authenticated, idempotent events:

- `ActivationRequested`
- `ActivationRejected`
- `RunPauseRequested`
- `RunResumeRequested`
- `RunDrainRequested`
- `CloudPauseRequested`
- `WorkItemRetryRequested`
- `WorkItemPriorityChanged`
- `ControllerObserved`

Commands apply only when GitHub authenticates the requester as the active run's activating actor and
the receipt names that exact Objective and run. Request IDs are idempotency keys and replay derives
the same state after a controller restart. Pause stops new admissions while already-admitted work is
reconciled. Drain does the same, then releases the Objective lease without creating a terminal event;
an open drained Objective remains undiscovered until that same run receives Resume. A closed active
Objective remains discoverable so the controller can repair a close-before-terminal crash. Resume
clears pause, drain, and cloud-pause together.

Cloud-pause adds a transient gate to paid execution and paid validation candidates while leaving
local work available. Retry is a one-shot permission for only the named failed or escalated Work
Item. It is consumed by the next reservation and never revives terminal work, bypasses dependencies,
preempts an open pull request, changes ownership, increases `maxAttempts`, or widens budget. The
latest unambiguous priority command overrides only that Work Item's scheduling rank and never
preempts an admitted worker. Controller observations are fenced by the Objective lease and emitted
only when repository-controller identity, epoch, expiry, or policy digest changes.

A stale activation base or other permanent rejection before `FactoryRunStarted` emits an
actor-authenticated `ActivationRejected` receipt bound to the activation request, base SHA, and
policy digest. Discovery suppresses that exact request on every later pass, avoiding an unattended
hot loop. Platform rate limits and other classified transient failures never emit this terminal
receipt; the controller retains the activation and observes the larger of its polling interval and
the provider retry window before another attempt.

Supported Daytona execution uses a bundled `@sha256`-pinned Node image index and rejects mutable tag
overrides. Execution metadata, `AttemptStarted`, and isolated-validation evidence record that exact
environment identity. This makes a replay name the environment that actually ran instead of
silently inheriting a later provider image.

Pause and drain are operational gates, not policy replacement. Resume may restore only authority
already present in the immutable run policy. A command can tighten a remaining ceiling or disable a
backend, but cannot add a backend, increase a budget, expand network access, change trust, or expand
scope. Broader authority requires a new run.

A pause/drain request is not itself proof that in-flight work is safe. The Supervisor records a
command-bound pause acknowledgement or drain-completed receipt only after local and paid attempts,
validation, and reviews are reconciled. Repository discovery suppresses the run only after that
receipt, so restart recovery wins over operational idling after a crash.

### Work Packet extensions

Extend the Worker Packet with bounded optional sections:

```ts
interface ContextManifest {
  mustRead: string[];
  searchSeeds: string[];
  dependencyEvidence: Array<{ workItem: number; commit: string }>;
}

interface ChangeSurface {
  mergeClass: "parallel-safe" | "exclusive" | "generated" | "large-binary";
  exclusiveResources: string[];
}

interface DeliveryHint {
  group: string;
  relationship: "root" | "continue-stack" | "sibling" | "join-after-merge";
  parentWorkItem?: string;
}
```

`mustRead` is context, not write scope. `allowedPaths` remains authoritative. Dependency evidence is
bound to exact commits and remains untrusted input to the worker. Resource estimates and delivery
hints narrow placement; they cannot widen policy or force paid execution.

## Cost-aware Objective compilation

Compilation is Factory's highest-leverage semantic operation. A good compiler saves more money than
late scheduler cleverness because it prevents duplicated discovery, overlapping edits, unnecessary
sessions, and doomed integration.

### Compiler pipeline

Implement compilation as explicit stages with a strict intermediate representation:

1. **Repository grounding** — inspect instructions, manifests, build and test commands, architecture
   seams, generated paths, large-file rules, and build/runtime toolchain metadata.
2. **Objective contract** — turn the request into observable acceptance criteria and identify any
   product decision that cannot safely be delegated.
3. **Change-surface analysis** — identify likely files/directories, shared registries, large or
   binary artifacts, generated output, exclusive tools/resources, and validation boundaries.
4. **Vertical decomposition** — create the smallest set of independently valuable Work Items; never
   split only to increase parallelism.
5. **Conflict analysis** — combine overlapping writers, declare exclusive resources, and add a
   dependency only when one output is literally another input or the changes cannot merge safely.
6. **DAG validation** — prove unique IDs, complete references, acyclicity, bounded paths, and no
   parallel overlapping scope.
7. **Stack planning** — mark linear code-dependency chains for stacked delivery; keep independent
   items as siblings; defer multi-parent joins until their parents land.
8. **Execution requirements** — attach OS, architecture, tools, services, network, trust, resource,
   duration, and context estimates grounded in repository evidence.
9. **Validation design** — order cheap mechanical checks before expensive builds and semantic review;
   bind each criterion to evidence.
10. **Economic review** — estimate likely local slots, critical path, cloud-eligible items, and
    duplicated context. Reject decomposition that costs more without increasing safe throughput or
    reviewability.

The compiler runs once per run and stores the complete graph before creating the first Work Item.
Retries reuse the original packet plus bounded failure evidence. Workers receive concise goals and
context manifests rather than copied repository dumps. They may search the local checkout when the
packet indicates uncertainty; the compiler must not hallucinate exhaustive context.

### Repository facts and execution profiles

Add a small `RepositoryProfile` interface so the compiler can consume repository-specific facts
without baking a framework, language, product category, or build system into the scheduler. The
initial implementation uses generic discovery from files that are actually present. A specialized
profile is added only when a real repository requirement cannot be represented by the generic
contract.

A profile contributes facts only:

- authoritative build, test, import, and headless commands;
- generated and ignored paths;
- text versus binary or large-file classifications;
- files that should be edited only by one worker at a time;
- exclusive local resources such as a singleton build tool, GPU, platform SDK, emulator, or shared
  build cache;
- evidence forms such as test output, logs, screenshots, rendered output, or recorded traces;
- known repository conventions and safe context seeds.

Profiles never create authority, silently install an SDK, launch a paid service, or weaken
validation. An unknown repository always falls back to general repository grounding.

## Single-host adaptive scheduling

The detailed scheduling algorithms and schemas live in
[`ADAPTIVE-SCHEDULING-IMPLEMENTATION-PLAN.md`](ADAPTIVE-SCHEDULING-IMPLEMENTATION-PLAN.md). Implement
them with these product-level constraints:

- all capacity is scoped to one repository controller on one local host;
- each run's `maxParallel` remains its Work Item ceiling, while the controller's local/paid worker
  limits and measured host capacity are repository-wide ceilings;
- native sub-issue order is the zero-configuration human priority mechanism;
- critical-path length and unfinished downstream work improve ordering without overruling explicit
  priority;
- organization issue fields are optional compatibility inputs, not a core onboarding dependency;
- local admissions require both a free logical slot and observed CPU/memory headroom;
- exclusive resources and overlapping active path claims are capacity constraints;
- the ready queue is continuously refilled rather than executed in fixed waves;
- running coding or validation sessions are never preempted for priority changes;
- host pressure stops new admission but does not kill healthy work merely to chase utilization.

### Cloud burst decision

Paid burst remains disabled by default. A local-compatible Work Item may burst only when every gate
passes:

1. its dependencies are complete and its path/resource claims are available;
2. local execution cannot be admitted in the current cycle;
3. the run explicitly allows the paid backend and trust class;
4. the provider is authenticated, available, and capability-compatible;
5. concurrency, sandbox-minute or managed-session, TTL, and egress ceilings can be reserved
   atomically, and any reporting model-token stop threshold still permits a new call;
6. the item's priority is inside the burst threshold;
7. queue delay, deadline pressure, or estimated critical-path time saved satisfies the recorded
   burst rule;
8. the controller still owns the repository and Objective lease immediately before launch.

The implementation uses the Work Packet's explicit `estimatedDurationMinutes` as a configured
one-local-queue-wave cloud-time-saved proxy. It is not an observed forecast. A nonzero minimum fails
closed when that field is absent, and admitted receipts preserve both the estimate and threshold.
Historical estimates may replace configured evidence only after Factory has enough comparable
completed receipts, and their effect must be visible through `factory_explain`. An estimate can
decline paid work; it cannot bypass a native-unit cap.

Work that is incompatible with the local host may use a paid backend immediately only when that
capability route was explicitly authorized. It is recorded as `remote-required`, not disguised as
burst.

### Managed-agent targets

Factory includes GitHub Copilot and OpenAI Codex as publication-gated managed-agent targets. Both
use the same provider-neutral execution contract: capability discovery, bounded session admission,
durable identity, observation, cancellation/reconciliation, exact-head artifact collection,
independent validation, and publication/integration fencing. A managed agent's self-published pull
request is an artifact source, never validation or merge authority. Codex discovery stays
unavailable until its live gate records a stable provider-published identity.

Managed agents remain opt-in even though they are supported. A run must name the provider, allow it
as a paid backend, and reserve a nonzero session ceiling. Missing repository enablement, provider
policy, assignability, or session budget leaves work queued or follows the run's recorded fallback;
Factory never changes to another paid agent implicitly.

## Supported local Codex SDK

`codex-sdk/local-worktree` is the preferred programmatic local backend. Factory, rather than the
worker, owns the isolated Codex home, exact environment, Work Packet restrictions, cancellation
signal, artifact collection, and cleanup. `codex-cli/local-worktree` implements the same contract as
the supported portable fallback. Neither local route gains GitHub publication, validation, merge,
Director, or budget authority.

## Durable Codex sessions (Labs)

`codex-app-server/local-worktree` is a Labs adapter for durable local sessions.
The release baseline remains `codex-sdk/local-worktree` with `codex-cli/local-worktree` fallback.

The adapter owns one supervised App Server process and starts one Codex thread per attempt in its
exact-SHA worktree. Attempt receipts record the thread ID, model/profile identity, worktree, base
SHA, start time, and normalized usage fields. On restart, the controller starts or reconnects to App
Server, reads the durable attempt, and resumes the same thread when safe. If the local Codex thread
store is unavailable, GitHub evidence still determines whether to collect an artifact, retry under
policy, or escalate; local thread state never overrides GitHub.

The adapter must normalize:

- start, resume, progress, completion, failure, and cancellation;
- approval requests as failures in unattended mode;
- token/usage data when the runtime exposes it;
- bounded logs and final structured output;
- process and thread identities needed for cleanup;
- capability and version probing without starting paid work.

One App Server process may serve concurrent threads, but each worker keeps isolated filesystem,
scope, artifact, and cancellation boundaries. The controller never asks a worker thread to supervise
another Factory run.

## Stacked pull-request delivery

Native GitHub stacked pull requests are a first-class publication mode, not merely a display
enhancement.

### DAG-to-stack rules

- A maximal linear chain of code dependencies may become one stack.
- The bottom PR targets the recorded trunk; each higher PR targets the branch immediately below it.
- When native-stack delivery is selected, independent Work Items produce sibling PRs and may
  validate concurrently. Regular-PR delivery serializes complete Work Item pipelines.
- A Work Item with multiple unfinished parents does not invent a multi-base stack. It waits for the
  parents to merge, refreshes from trunk, and starts a new stack.
- A dependency that expresses ordering but does not consume code need not share a stack.
- Work targeting the same exclusive resource or non-mergeable large/binary path is serialized even
  when Git could technically create parallel branches.
- Stack identity, position, parent PR, base SHA, and GitHub capability version are recorded in the
  publication receipt.

### Stack lifecycle

Add a `StackManager` behind a provider-neutral delivery interface. It:

1. probes GitHub stack capabilities before implementation spend;
2. creates branches and PRs idempotently through Octokit;
3. links or extends the stack through the supported REST surface;
4. detects lower-layer updates and performs a cascading rebase only at a fenced boundary;
5. invalidates prior validation when a rebased head changes;
6. revalidates each exact head against the stack's trunk rules;
7. merges from the bottom or uses the asynchronous atomic stack merge endpoint according to policy;
8. polls the asynchronous result and records the final outcome;
9. reconciles partial link, rebase, push, and merge operations after restart.

Because GitHub's stack API is versioned and may change, all API shapes are isolated in this adapter. At activation,
`delivery.onUnavailable` must be either `regular-prs` or `escalate`. Falling back later cannot change
already-published PR topology. Active runs retain their recorded delivery policy.

## Chat and MCP surface

Every user workflow must be possible through chat. CLI commands mirror the same application
services for diagnostics and service management; the skill does not implement a second scheduler.

### Read-only tools

- `factory_doctor` — verify repository identity, auth, toolchain, controller, backends, branch rules,
  stack capability, and effective defaults without creating paid resources or GitHub records.
- `factory_plan` — compile or inspect a proposed graph and report dependency, stack, resource,
  validation, context, and economic reasoning before activation.
- `factory_status` — report Objective and Work Item states, active sessions, queue, local pressure,
  cloud reservations, budgets, stacks, and controller heartbeat.
- `factory_explain` — explain why an item is blocked, queued, local, cloud, retried, invalidated, or
  escalated from the exact snapshot and admission receipt.
- `factory_replay` — reconstruct a completed or interrupted run and simulate scheduler decisions
  without writes or launches.
- `probe_execution_backends` — retain the existing capability probe.

### Mutating tools

- `factory_activate`
- `factory_pause`
- `factory_resume`
- `factory_drain`
- `factory_pause_cloud`
- `factory_retry`
- `factory_set_priority`
- `factory_cancel`
- explicit controller install/start/stop/uninstall tools where the host grants local filesystem and
  service-manager authority.

All tools receive minimal typed inputs, return bounded structured results plus concise model-readable
text, and carry accurate MCP annotations for read-only, destructive, idempotent, and open-world
behavior. Mutating calls require an explicit user request, an idempotency key, authenticated actor
verification, and a durable acknowledgement. Tool descriptions explain one operation, not the whole
Factory protocol.

The `director` skill chooses and sequences tools, explains consequential choices, and reports
terminal or actionable state. It never keeps a chat turn alive merely to poll unchanged state.

## Status, economics, and evidence

No hosted observability system is required. The controller emits concise local structured logs and
writes durable GitHub events only for meaningful state transitions.

`factory_status` and the final Objective receipt report, when measurable:

- elapsed and active execution time;
- critical-path estimate and observed completion time;
- local versus cloud attempts and validation;
- peak and average admitted local concurrency;
- model/profile use and reported tokens by phase;
- sandbox minutes, managed sessions, and provider-reported cost;
- retries, deferred launches, discarded artifacts, and failure categories;
- time saved by concurrency and cloud burst, clearly labeled as an estimate;
- human interventions and their evidenced reasons;
- final PR/stack topology and validation SHAs.

Factory never invents precise dollar savings from unavailable billing data. A metric used to make an
admission decision must be available to `factory_explain` and recorded at the appropriate durable
boundary.

## Implementation delivery waves

Start a wave when the contracts it consumes have deterministic test coverage. Preserve reconstruction
of stored records and require an explicit policy switch for changes to execution authority. The
runtime scheduler continuously refills eligible worker slots.

### Wave 0 — protocol and decision baseline

Modify:

- `docs/DESIGN.md`
- `docs/HOST-SCHEDULING.md`
- `docs/ADAPTIVE-SCHEDULING-IMPLEMENTATION-PLAN.md`
- `src/protocol/policy.ts`
- `src/protocol/events.ts`
- `src/protocol/worker-packet.ts`
- JSON schemas and protocol fixtures

Add decision records for the repository controller, chat/MCP split, stacked delivery, and
open-source/hosted boundary. Add optional policy, command-event, context, change-surface, delivery,
and session fields. Preserve stored policy digests and active-run parsing.

Exit gate: stored-record fixtures retain their digest and derived state; invalid cross-field authority or
budget combinations fail before the first write.

### Wave 1 — activation and agent-facing control surface

Refactor the Supervisor into application services that both CLI and MCP call. Split quick durable
activation from the long-running loop. Add doctor, plan, status, explain, pause, resume, drain,
cloud-pause, retry, and priority commands. Add correct MCP annotations and golden direct, indirect,
and negative tool-selection prompts.

Primary files:

- `src/mcp-server.ts`
- `src/cli.ts`
- `src/control/runs.ts`
- `src/control/events.ts`
- `src/control/receipts.ts`
- `skills/director/SKILL.md`
- new `src/application/` services

Exit gate: a chat request can create exactly one durable activation while the controller is offline;
read-only requests perform no mutation; duplicate mutating calls return the original result.

### Wave 2 — repository controller and service lifecycle

Add:

- `src/controller/repository-controller.ts`
- `src/controller/repository-lease.ts`
- `src/controller/discovery.ts`
- `src/controller/objective-set.ts`
- `src/service/systemd.ts`
- controller fault and lifecycle tests

Move the long-running loop behind a repository-scoped controller with shared GitHub pacing,
capacity, budgets, path claims, and integration fencing. Implement explicit systemd user-service
installation for the supported Linux environments. Rewrite host-scheduling documentation around the
repository controller.

Exit gate: activate two Objectives, prove only one becomes active while the second remains durably
queued, kill the process during every meaningful lifecycle phase, restart it, and prove exactly-once
admission/publication semantics, repository-wide caps, and clean service uninstall.

### Wave 3 — cost-aware compiler and repository facts

Add pure compiler stages, repository facts, context manifests, conflict classification, exclusive
resources, validation tiers, stack hints, and bounded economic review. Keep management backends
behind the existing strict structured-output contract.

Primary files:

- `src/management/backend.ts`
- `src/management/codex-cli.ts`
- `src/protocol/worker-packet.ts`
- new `src/compiler/`
- new `src/repository-profiles/`
- `skills/objective-compilation/SKILL.md`

Use checked-in representative fixtures for a general TypeScript repository and for the large/binary,
generated-output, deterministic-simulation, and visual-validation cases actually encountered while
dogfooding the Clockgrove Worlds platform. Do not claim specialized framework or engine support
without an installable fixture and an exercised command path.

Exit gate: golden Objectives compile deterministically into valid DAGs with no arbitrary item count,
parallel scope overlap, invented command, unnecessary context dump, or impossible stack topology.

### Wave 4 — adaptive local scheduling and bounded cloud burst

Implement the subordinate adaptive-scheduling plan, but make the capacity ledger repository-wide
and add path and exclusive-resource claims. Default remains adaptive local with paid burst disabled.

Primary additions:

- `src/scheduling/resource-sampler.ts`
- `src/scheduling/capacity-ledger.ts`
- `src/scheduling/priority.ts`
- `src/scheduling/graph-score.ts`
- `src/scheduling/admission.ts`

Exit gate: native Linux, Windows WSL2, and a Linux guest on macOS pass pressure, cooldown, fairness,
dependency, path collision, crash recovery, provider ambiguity, and budget fault matrices. A real
Daytona run proves TTL, egress, cancellation, cost reconciliation, and cleanup.

### Wave 5 — Labs durable Codex execution adapter

Add the App Server-backed local adapter, durable thread identity, usage normalization, progress
events, cancellation, and resume. Keep the CLI adapter and run the same backend conformance suite
against both.

Primary additions:

- `src/backends/codex-app-server.ts`
- `src/runtime/codex-app-server.ts`
- `src/execution/session.ts`
- session protocol and recovery tests

Labs gate: concurrent local threads stay isolated; process restart resumes or safely reconciles each
attempt; approval requests cannot hang unattended work; the artifact and validation contracts remain
identical across adapters. This Labs gate does not block release.

### Wave 6 — native stacked pull requests

Add stack planning, GitHub capability probing, publication receipts, cascading rebase, exact-head
revalidation, asynchronous atomic merge, and restart reconciliation.

Primary additions:

- `src/publication/delivery.ts`
- `src/publication/stack-manager.ts`
- `src/publication/github-stacks.ts`
- `src/publication/integration-lease.ts`
- live stack fixtures and fault tests

Exit gate: linear, sibling, diamond/join, lower-layer revision, partial publication, branch-rule,
merge-queue, and asynchronous failure scenarios pass against a disposable GitHub repository. The
regular-PR fallback is proven before it can be selected.

### Wave 7 — replay, explanations, and cost feedback

Make scheduler decisions pure and replayable from a pinned GitHub snapshot. Add stable reason codes,
run summaries, context/usage accounting, and conservative historical duration estimates. Do not add
a dashboard or required telemetry backend.

Exit gate: replay reproduces every admission from a conformance run; `factory_explain` identifies the
exact dependency, capacity, authority, priority, or economic gate; unavailable billing data is
reported as unavailable rather than estimated as fact.

### Wave 8 — release qualification and Clockgrove Worlds dogfood

Exercise Factory through an installed plugin, never a development worktree MCP configuration. Use
Clockgrove Worlds platform Objectives that cover, as the repository makes them available:

- a dependency-heavy platform feature;
- parallel code and tests;
- a large/binary artifact or generated-file conflict;
- an expensive build or validation resource;
- a local-to-cloud burst decision;
- a lower-layer change in a live PR stack;
- a controller or worker crash and recovery;
- a genuine human product decision.

The gate is scenario coverage, not a hard-coded number of Objectives or Work Items. Record both
successful and uneconomic decompositions, then adjust compiler and scheduler rules through versioned
tests rather than hidden heuristics.

Exit gate: the synchronized Agent Plugin and `@clockgrove/factory` artifacts install cleanly; the
Linux environment, native-stack, Daytona, GitHub Copilot, and OpenAI Codex matrices pass; and from
chat a clean adopter can activate an Objective, end the chat turn, and later receive validated
sibling/stacked PRs or one evidenced escalation. No Factory GitHub Action, custom UI, hosted service,
manual per-Work-Item dispatch, or unrecorded state is required.

## Dependency graph

```text
Protocol baseline
   │
   ├── Agent control surface ── Repository controller ───────────────┐
   │                                                                 │
   ├── Cost-aware compiler ───── DAG / path / stack hints ───────┐   │
   │                                                              │   │
   └── Scheduling schemas ────── Adaptive admission + burst ◀─────┘   │
                                      │                               │
                                      ├── Durable Codex sessions      │
                                      └── Stacked PR delivery ◀───────┘
                                                   │
                                      Replay / explain / economics
                                                   │
                                      Clockgrove Worlds dogfood release
```

After Wave 0, develop the pure compiler, scheduler, GitHub-stack, and session-normalization modules
in parallel where the dependency graph permits. Integrate them into the controller after their
schemas and contract tests pass. Release qualification requires live conformance.

## Verification strategy

### Deterministic tests

- schema compatibility, canonical digests, and strict cross-field validation;
- graph acyclicity, scope intersections, exclusive resources, and stack partitioning;
- priority, critical path, work-conserving admission, and multi-Objective ordering;
- CPU/memory sampling, capacity generations, cooldown, and reservation recovery;
- every budget, burst, trust, capability, and authority boundary;
- MCP tool annotations, idempotency, and positive/negative selection prompts;
- service-definition creation and safe removal;
- App Server lifecycle normalization and malformed output;
- stack publication, rebase invalidation, asynchronous merge, and fallback;
- status/explain/replay equivalence.

### Fault injection

Interrupt immediately before and after each GitHub write, provider launch, local thread start,
artifact collection, validation, push, PR creation, stack link, rebase, and merge request. On restart,
Factory must either continue the same fact or reconcile it before replacement. It may not duplicate
paid work, publish an unvalidated head, or spend the same reservation twice.

### Live conformance

Use disposable GitHub repositories and explicitly approved provider budgets to verify behavior that
mocks cannot establish: custom-ref compare-and-swap, sub-issue order, stack APIs, branch rules, merge
queues, rate limiting, provider TTL and cleanup, Codex thread resume, and installable plugin/service
lifecycle.

### Cost regression

For each golden Objective, retain the graph, prompts, context manifests, admission trace, attempts,
usage, duration, and accepted commits. Compare compiler and scheduler versions on:

- validated Work Items per reported model-token unit;
- accepted-attempt usage versus discarded-attempt usage;
- duplicated context across workers;
- local utilization without host-pressure violations;
- serial critical path versus observed completion time;
- paid minutes and estimated minutes saved;
- retries caused by scope, context, merge, or validation errors;
- human interventions and whether each was policy-required.

These are diagnostic comparisons, not a single gameable score.

## Release definition of done

Factory satisfies this plan when:

- the product can be installed as an Agent Plugins-compatible package with no install script or
  required repository configuration;
- a user can install and manage one local repository controller through chat or mirrored CLI;
- explicit activation is durable and execution continues after the initiating chat turn;
- the controller safely serializes Objectives on one machine, runs dependency-ready Work Items
  concurrently when native-stack delivery supplies cascading revalidation, serializes complete
  pipelines under regular-PR delivery, and never exceeds host or policy ceilings;
- Work Item count, scope, dependencies, context, resources, validation, and stack topology are
  compiler outputs grounded in the repository;
- local Codex sessions are isolated, recoverable, non-interactive, and attributable to exact Work
  Items;
- cloud burst is optional, local-first, economically gated, atomically budgeted, and recoverable;
- linear dependencies produce valid native stacks while independent and join work use correct
  sibling/new-stack topology;
- every published head has independent validation bound to that exact SHA;
- status and explain tools account for every blocked, queued, running, cloud, retry, invalidation,
  escalation, and merge decision;
- meaningful state is reconstructable from GitHub without a private database or queue;
- Clockgrove Worlds dogfood covers the live scenarios above through the installed plugin;
- `npm run typecheck`, all tests, package verification, production audit, clean installation, service
  lifecycle, and claimed live backend/stack conformance pass.

## Explicit non-goals

- competing with or reimplementing a coding agent;
- a custom web, desktop, or MCP Apps UI;
- coordinating multiple local worker computers;
- organization-wide quotas, custom properties, policy administration, or enterprise reporting;
- replacing repository CI or making GitHub Actions mandatory;
- a general deployment/release platform or autonomous production-secret access;
- cross-repository atomic Objectives;
- automatic purchase, provider signup, credential creation, or budget increase;
- preempting healthy running sessions to improve priority;
- silently changing an active graph, policy, model, backend, stack topology, or validation contract;
- requiring a Clockgrove account or hosted service for the open-source plugin.

## Hosted systems outside this repository

A hypothetical hosted product could reuse the public protocol through a hosted MCP server, GitHub
App, managed coordinator, and managed cloud workers. An optional local worker could connect outbound
without opening inbound access.

That product is not planned or promised by this repository. It would require a separate threat
model, authentication design, privacy contract, billing system, availability target, and
implementation plan. No speculative hosted abstraction may complicate the open-source critical path
beyond keeping protocol records versioned and provider-neutral.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Compiler creates many cheap-looking but overlapping tasks | Scope-intersection proof, exclusive resources, economic review, and golden regression fixtures. |
| Frontier sessions repeatedly rediscover the repository | Bounded context manifests, dependency evidence, stored graph, and retry deltas. |
| Concurrency makes the developer's machine unusable | Observed headroom, reserved CPU/memory, cooldown, hard worker caps, and no pressure-driven preemption. |
| Paid burst becomes the easy fallback | Disabled default, local saturation prerequisite, minimum benefit gate, native-unit budgets, TTL, and atomic reservation. |
| Large/binary artifacts or exclusive tools corrupt parallel work | Repository facts, path/resource claims, serialization, content digests, and clean validation. |
| GitHub stacked PR API changes | Isolated adapter, capability probe, versioned receipts, live conformance, and recorded regular-PR fallback. |
| Controller and foreground run race | Repository CAS lease plus per-Objective leases and deterministic attempt refs. |
| Laptop sleeps or WSL is not started | Honest controller heartbeat/status and explicit service diagnostics; a later hosted coordinator is optional, not hidden. |
| Provider/model usage lacks authoritative dollars | Enforce measurable tokens/minutes/sessions and label dollar values as estimates or unavailable. |
| MCP tool surface causes accidental writes | Minimal schemas, accurate annotations, explicit mutating names, actor verification, idempotency, and negative selection evals. |

## Appendix A — Game, simulation, and rich-media repositories

This appendix applies the general Factory contracts to repositories that contain large media,
generated content, deterministic simulations, visual behavior, or specialized authoring tools. It
does not change Factory's general-purpose audience, require an engine-specific runtime, or add a
game-development wave to the core roadmap.

### Reusable capabilities and release boundary

These are not game features. They solve common software-repository problems and therefore remain in
the generic design. Factory implements repository-fact classification, `large-binary` and
`generated` change-surface classes, exclusive-resource serialization, binary Git patches, artifact
digests, and clean validation. Its normalized patch is capped at 5 MiB, and a Daytona source archive
is capped at 64 MiB. Work that cannot be represented inside those bounds fails closed.

The current implementation does **not** include Git LFS lifecycle management, an oversized content-addressed transfer
service, media-type inspection, or a provider object-store artifact channel. The bullets below are
design requirements for adding those capabilities in later delivery waves; they are not current
support claims. A future implementation must add executable conformance evidence before changing
that boundary.

#### Future large and binary artifact extensions

- Classify a path from repository evidence as text, generated, large/binary, or otherwise
  non-mergeable.
- Represent a binary artifact by path, byte size, media type when known, executable mode, and content
  digest. Never embed the content in a GitHub comment or model prompt.
- Enforce Work Packet path and size ceilings before accepting or uploading it.
- Serialize writers to the same non-mergeable path. Distinct binary paths may still run concurrently
  when their manifests and build outputs do not collide.
- Detect Git LFS pointers and required LFS tooling when a repository already uses them. Factory does
  not enable LFS, rewrite attributes, or migrate files automatically.
- Distinguish source assets from derived exports. Rebuild derived output through the repository's
  declared command when possible instead of asking a model to manipulate opaque bytes.
- Store oversized worker transfer artifacts in the selected backend's content-addressed artifact
  channel, while GitHub retains the digest and lifecycle receipt.

#### Generated outputs

- The source and generated contracts, schemas, atlases, manifests, snapshots, or golden fixtures
  belong to one Work Item unless the generator output is an explicitly versioned dependency.
- Two parallel Work Items may not own the same generated tree, lockfile, registry, or aggregate
  manifest.
- Validation reruns the generator and fails on unexplained drift.
- Generated size does not count as useful model-authored progress when measuring worker yield.

#### Deterministic and simulation-heavy code

- Work Packets pin seed, clock/time fixture, schema/protocol version, scenario identity, and expected
  state/event hash when the repository exposes them.
- Exact deterministic tests run before model-assisted semantic review.
- Nondeterministic services use recorded or scripted fixtures for merge gates; live-provider checks
  remain separately labeled qualification evidence.
- A worker may update an expected golden result only when the Work Item explicitly owns the semantic
  change and validation explains the before/after difference.

#### Visual and experiential validation

- A visual validation plan pins scenario, data/seed, viewport or output dimensions, environment,
  tool version, and capture command.
- Factory records capture digests and bounded diffs with the exact validated commit.
- Mechanical comparison may accept unchanged or threshold-bounded output. A deliberate change in
  visual intent remains a legitimate human review boundary unless the Objective pre-authorized an
  exact replacement fixture.
- Screenshots, rendered frames, audio summaries, and other evidence are attachments or artifact
  references, not a reason to add a Factory-specific UI.

#### Exclusive tools and constrained resources

- Declare an editor, emulator, GPU, hardware device, singleton license, port, local service, or shared
  cache as an exclusive resource only when repository/toolchain evidence requires it.
- Resource claims participate in ordinary admission and are released through the same fenced
  attempt lifecycle.
- Factory never assumes that a game or media repository requires a GPU or editor. Headless commands
  remain preferred when the repository provides them.

### First-party dogfood contract

Clockgrove Worlds is Factory's first-party dogfood project. Its role in this public plan is to
exercise portable Factory behavior, not to define Factory implementation details or reproduce an
adopter's architecture. Project-specific implementation facts, paths, and source documents remain
in the adopter repository and enter Factory only through ordinary repository grounding.

The public qualification scenarios below are design inputs for future qualification; they are not
part of the current release matrix:

- a repository may expose deterministic behavior whose Work Packets must pin seeds, fixtures,
  versions, scenarios, and expected hashes;
- versioned content may combine schemas, migrations, manifests, provenance, and expected output
  without making Factory the authority for that content;
- source, reviewed, and generated assets may require different ownership and validation rules;
- large or binary artifacts may require content-addressed transfer while GitHub retains only bounded
  metadata, digests, and lifecycle receipts;
- visual or experiential changes may require reproducible captures and an explicit human review
  boundary;
- generated contracts and golden fixtures may require source-coupled ownership and drift checks;
- browser, realtime, accessibility, replay, provider, and staging checks may require distinct
  commands and evidence rather than one vague “tests pass” criterion; and
- Factory must remain external development tooling: an adopter stays buildable and operable without
  Factory installed, and Factory state never becomes product/runtime authority.

### Promotion rule

Dogfooding may reveal reusable Factory requirements, but no adopter receives hard-coded branches in
Factory. Promote a project-specific observation into the core only when:

1. the generic repository-facts, Work Packet, artifact, or validation contract cannot express it;
2. an actual dogfood Work Item demonstrates the failure with bounded evidence;
3. the proposed extension has a provider/framework-neutral contract;
4. a second, unrelated fixture proves that the abstraction is reusable;
5. the extension passes ordinary compatibility, recovery, cost, and security gates.

Otherwise, keep the behavior in a repository-supplied profile, skill, or validation command rather
than expanding Factory itself.

## References

- [OpenAI plugin architecture](https://developers.openai.com/plugins/concepts/plugins)
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [GitHub stacked pull requests](https://docs.github.com/en/pull-requests/get-started/about-stacked-prs)
- [GitHub stacked pull request APIs](https://docs.github.com/en/pull-requests/reference/stacked-pull-requests-apis-and-webhooks)
