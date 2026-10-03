# Factory implementation plan

This is the public, controlling build plan for contributors. The [project board](https://github.com/orgs/clockgrove/projects/2) and linked issues track accepted outcomes. Target repositories own their own product requirements; no private adopter document is required to build or test Factory.

[The archive-to-rebuild capability review](ARCHIVE-CAPABILITY-DECISIONS.md) records the operator-approved retain/simplify/defer/discard decisions from the original Factory. The linked issues define accepted implementation scope; the review does not supersede this plan or imply that retained behavior is complete.

## Product boundary

Factory is a plugin installed for one target GitHub repository. It compiles a human Objective issue into a dependency-linked Work Item graph, runs a configured harness, validates exact changes independently, delivers through GitHub, and validates the integrated Objective. Factory is neither a hosted control plane nor a dependency of the target product. It must never run against a Factory source repository.

The shippable trunk covers installation, compilation, GitHub projection, one active Objective, local DAG scheduling, restart/cancel/retry, exact-tree validation, regular PRs and native linear stacks, media AssetSets, target-owned Git LFS policy, package/skill/CLI delivery, and the installed bring-your-own harness seam tracked by #55. Later branches add managed cloud-agent execution, a sandbox driver that consumes that harness seam, and Daytona as its first provider. Automatic bursting, mixed modes, live migration, distributed controllers, provider marketplaces, media-tool discovery, search catalogs, and exhaustive fault systems are leaves and do not block trunk.

## Design laws

1. Keep one vertical path: Objective → validated DAG → GitHub Work Items → ready item → configured driver/harness → exact change or declared AssetSet → independent validation → configured delivery → final Objective validation at the integrated default-branch head. Reviewed media returns to that path.
2. Preserve one source of durable truth per concern: one atomic local continuation snapshot, GitHub Issues/PRs/checks for collaboration, the target Git tree for product result, a content-addressed store for immutable large bytes, and the target repository for requirements and commands. Do not add operational event journals, receipt ledgers, activation refs, or state reconstruction from diagnostic logs or session memory.
3. Use narrow contracts for known alternatives: `PlanningModel`, `ExecutionDriver`, `AgentHarness`, `SandboxProvider`, `DeliveryStrategy`, `ContentStore`, and `GitHubGateway`. Keep the runner, scheduler, validator, local state store, Git model, and controller host concrete.
4. Do not create hidden Factory limits beneath GitHub, providers, the OS, target rules, or explicit operator policy. One repository, one execution mode, and one active Objective per installation are explicit trunk boundaries.
5. Existing explicit runs stop on failed work or ambiguous external state and require explicit operator retry for a new Work Item attempt. The autonomous contract below permits only diagnosed repairs within an explicitly admitted policy once that capability is implemented. Upgrading never grants existing runs new retry authority. The explicit compiler gate may make one evidenced planning revision after independent review; this is not an implementation retry. Ordinary controller restart reattaches to an identifiable active attempt. An explicitly bound operator disposition may permanently abandon a stopped failed run whose only unresolved effects are read-only result reviews or one sequential synchronous GitHub initial/amended graph-projection call, after full verified local execution cessation. Exclusive stopped ownership, exact run/configuration/snapshot binding and trusted operator cessation evidence are required; sealed final acceptance, uncertain planning/model jobs, effects outside the selected boundary and unknown live resources remain fenced. The existing atomic snapshot retains original review markers, accepted/failed work, errors, evidence, accounting and consumed allowances. Abandonment records permanent UNACCEPTED terminal cancellation, preserves all original Work Item statuses and graph uncertainty, permanently forbids revival or acceptance, and grants a successor no admission or allowance reset (#363 / #499). The explicit `cancel --abandon FILE` request binds exact repository/Objective/run/configuration/snapshot and cessation evidence; the controller derives the allowed effect. No GitHub submission, provider call, cleanup, replay or automatic worker authority is inferred.
6. Work Items name owned paths, dependencies, resources, acceptance, non-goals, source citations, and command provenance. Ownership is a literal repository-relative file or a directory prefix ending in `/`; `*` and `?` are unsupported, brackets and braces remain literal, and path components cannot be empty, `.` or `..`. Factory rejects unsupported declarations before accepting a runnable graph without rewriting them. Parallel items cannot write overlapping paths or claim the same exclusive resource. Validation commands must be observed on the base or literally declared by a supplied source.
7. Factory controller credentials and integration authority never pass to a worker. Local and sandbox harnesses have no GitHub publication authority. An explicitly authorized managed provider may publish isolated candidate branches or draft PRs under the [managed candidate publication contract](#managed-candidate-publication); those artifacts are unaccepted inputs to Factory. The controller checks exact bases, PR heads, merge results, and the final default-branch head. Target branch protection and required checks remain authoritative. Source-required named CI that must pass before integration is separately bound in the accepted graph as `requiredPreIntegrationChecks`, with exact controller-hydrated pinned source evidence. The compiler and independent graph review must identify every such obligation or expose a precise unresolved source decision before dispatch; final-review coverage alone cannot enforce merge ordering. Regular and native delivery require successful authenticated receipts on each exact published delivery head for every admitted name, even when target protections report `CLEAN` and no check has registered. Missing, pending, stale or ambiguous named evidence waits through the existing read-only ownership/cancellation path; failed checks stop. No source-required names means no new universal CI requirement. Amendments preserve the admitted gates; no protection changes or post-merge receipt fabrication are allowed. Pending checks and GitHub's documented `BLOCKED`/`UNKNOWN` protection readiness retain the known published result for read-only observation; they do not imply a submitted merge or implementation failure. The fixed PR readiness query shares authenticated GitHub rate and cancellation controls. Explicit runs return while waiting; admitted owners continue observations without another worker or model call. Merge intent is recorded only at submission; uncertain submitted effects remain fenced. Planning receives the installed controller's delivery guarantees, not receipts for future events. Final acceptance receives exact-result automatic independent-review completion derived from existing validation state, plus compact successful check identities observed on the exact published head before integration, one receipt per name. Repeated current runs of the same name are equivalent delivery evidence only when all are completed and successful on that head and identify the same authenticated GitHub app; the receipt retains one actual run ID. Singular QA named-check selection remains separate and rejects ambiguity. Human acceptance remains distinct; absent, ambiguous or unsuccessful checks never become successful named-check evidence. These compact historical facts do not replace current semantic review or duplicate GitHub's source data.

### Explicit autonomous execution contract

[Program #243](https://github.com/clockgrove/factory/issues/243) extends the explicit-run contract with local background supervision, reviewed graph revisions, bounded diagnosed repair and sequential authorized intake. These capabilities are implemented through its individual issues; this contract is not a claim that they are enabled in the published plugin. The existing explicit plan/run/retry workflow remains supported.

An installation may admit only explicitly authorized Objectives or a finite batch. Bind the target, exact Objective body, pinned base and source packet, installation configuration, delivery and acceptance policy before dispatch. The configuration remains the authority for providers, permissions and worker ceilings; admission cannot expand it. Record numeric planning, implementation and review allowances, permitted repair classes, resource limits and required environments from the operator, without inventing defaults. Initial explicitly requested planning remains separately authorized preparation. Installation, a discovery label and service consent alone authorize no Objective execution or provider spending.

Repeated setup, durable preparation reuse and first admission/activation of that prepared plan compare validated execution-authority values independently of JSON object property order. Field presence, values and every array's order remain significant. Stored admission receipt serialization and digest verification remain exact; equivalent input formatting does not rewrite receipts, replace intake, resume work or reset identity/accounting (#479). Independently verified [v0.1.71](https://github.com/clockgrove/factory/issues/480#issuecomment-5950722931) passed 514 tests across 50 whole installed files and six model-free preflights. Its focused structural-authority check proves reuse and first exact admission binding with the genuine closed-Objective stop and already-bound receipt refusal; scripted transports grant no live Objective or service acceptance.

Guided target setup (`factory setup --background`) is one operator outcome: reuse or create the bound configuration, record explicit service consent, check model-free readiness for executable work, register the exact retained installed artifact, start it and verify its owner/control connection. `--config-only` remains an explicit configuration-only outcome. Package download never grants service consent. Partial setup reports completed stages and a concrete supported continuation; it preserves state and never claims readiness from a unit file alone (#447).

Local Codex readiness and guided setup share one outside-write probe selection: the operator's home directory by default, or the explicit `--outside-directory` override. Canonical outside-workspace validation and an actual controller host write/read/removal precede the unchanged worker-policy probe. A host denial or sandbox-allowed outside write remains unavailable; neither default selection nor a path name proves confinement. Unsuitable locations require an explicit owned existing directory, with no fallback chain or policy expansion (#474). The correction is shipped in independently verified [v0.1.70](https://github.com/clockgrove/factory/issues/475#issuecomment-5949114107), with 512 tests across 50 whole installed files and five model-free preflights, including actual bundled-harness default/override and host-denial controls. This evidence proves the selected filesystem boundary; live guided setup and persistent intake retain #444/#447/#448 acceptance, followed by private #445.

An explicitly selected continuous watcher (`intake watch`, or background guided setup) retains the same atomic intake authorization and controller owner while its finite batch is exhausted. It polls GitHub conditionally at the configured interval (default 30 seconds), records the last observation and unapproved candidates, and remains model-free until separately authorized Objectives exist. A service-consented watcher may have no execution authority. Later work requires explicit `intake enqueue --authority FILE` at a settled boundary, through the existing private owner control when running; failed, paused or ambiguous nonterminal work prevents refill. Refill validates bodies, configuration and execution limits, preserves all Objective snapshots/accounting and never revives terminal runs. Existing finite intake retains its exit-after-exhaustion behavior unless watch is explicitly selected. Observation and labels grant no execution or spending authority (#444).

Use one concrete local coordinator and one authoritative continuation store. Reconcile known work before dispatch, serialize lifecycle changes and run long I/O outside state mutation. The coordinator owns projection and admissions; workers propose discoveries without Factory controller credentials or issue/graph mutation authority. A managed provider's candidate publication exception grants no projection or admission authority. An accepted graph revision is immutable. Review amendments at safe boundaries, preserve running/completed identities, distinguish executable leaves from aggregate parents, and retain every required criterion's owner, phase and evidence. A paused active Objective prevents admission of another.

Automatic repair requires a concrete diagnosis, a permitted class and remaining recorded allowance. Children, recompilation and restart cannot reset consumption. Ambiguous external effects, ownership loss, missing authority or exhausted allowances stop affected work. Unknown usage remains unknown; it blocks spending when the information is needed to enforce an actual binding limit. Human-owned acceptance, deployment and target protections remain outside delegated engineering authority. Final acceptance binds the current graph to the exact integrated tree with required evidence and settled owned resources.

The initial admission capability does not start a service, automatically amend a graph or retry work. Coordinator, supervision, QA, amendment, repair, resource and intake issues enable their own reviewed behavior. Full program acceptance includes the installed public scenario and the finite subsequent interruption matrix; earlier artifact evidence retains its original scope.

### Durable local ownership and control

The #245 coordinator extends the existing runner with one installation owner and one atomic continuation snapshot. Preparation records the exact run, input bindings and planning disposition before provider submission, then saves the accepted plan and each projected issue identity before proceeding. Identifiable effects reconcile on restart; unknown submissions and publication acknowledgements stop affected work without replay. Existing active snapshots remain readable; unsupported state is refused without resetting it.

Local lifecycle mutations route through the current owner's private socket. Long subprocess and GitHub operations are asynchronous so status and cancellation remain responsive. Admitted runs remain owned while paused, drained or waiting for an exact decision; terminal work releases the owner. An explicit run without admission retains its existing return-at-wait behavior. Pause/drain disposition and operator-declared absolute deadlines survive restart. Cancellation verifies owned cessation and preserves unresolved resources instead of claiming successful cleanup.

Exact active-issue reads distinguish confirmed closure or changed content from unavailable observations. An observation failure persists a pause with its freshness/error and allows local control; an explicit resume requests another observation. Status exposes phase, wait reason and the existing graph/attempt identities. Idle waiting does not call models. This is local ownership, not service installation or automatic repair.

The production GitHub gateway and native delivery share an asynchronous Octokit client and primary/secondary rate-limit gate. GitHub CLI is used only to obtain the local credential. HTTP mutations are never automatically retried after an uncertain response; authenticated reconciliation and existing delivery identities remain authoritative. Credentials and SDK objects stay outside continuation state.

### Reviewed active graph amendments

Issue #247 adds a controller-owned amendment operation to admitted Objectives.
Workers can return a structured private discovery alongside their ordinary result;
operators can submit a proposal to the existing local owner. Neither path grants
new authority. Evidence describes the gap, scope, ownership, acceptance and
prerequisites; the compiler still uses the original pinned source packet. Backlog
discoveries remain proposed data and never enter current execution.

Private discovery staging remains outside Git collection. A rejected collection
retains its exact proposal bytes in the existing owned attempt worktree after
worker cessation is verified; it supplies no accepted result or retry authority.
Successful collection returns the proposal and removes the private staging file
before ordinary worktree cleanup. A tracked or staged proposal cannot use this
private-file exclusion. This bounded evidence-retention correction is #465.

The existing atomic snapshot retains the admitted initial graph, immutable reviewed
successors, one pending amendment and Objective-level allowance consumption. Each
new attempt binds its accepted graph digest. A revision consumes one recorded
planning allowance before model submission; decomposition, children and restart do
not reset it. Every required source criterion retains its exact identity and text.
Never-started ordinary Work Items may revise generated acceptance wording while
preserving every substantive obligation. Independent graph review compares the
complete previous and proposed graphs; equivalent wording alone is not deletion,
and weakened or omitted requirements still stop acceptance. Changed started or
completed nodes require explicit successor or revalidation work. Independent graph
review includes the proposal and compact attempt/result identities; it cannot
expand source or command authority.

New dispatch stops while a proposal settles. Existing native delivery units finish
without repartitioning published identities; other owned effects settle before
acceptance. Aggregate parents have no worker or PR: explicit child dependencies
join their integrated results, then ordinary read-only validation/review proves the
parent acceptance. Hierarchy alone never grants readiness. The controller reconciles
exact issue bodies, dependencies and native subissues before activating a successor.
Remote edits are proposals, and unknown create/review outcomes remain fenced without
replay. Pause and drain settle the current amendment call, persist its known result,
and stop before the next call or graph activation. Resume or handoff continues from
that recorded phase without repeating known model/projection work or consuming
another planning allowance. A discovery arriving during final review invalidates
that completion result.

A known, unprojected compiler-generated rejection, including a completed independent
review finding, may be explicitly replaced through
the same proposal/control boundary. The replacement binds the current graph,
rejected amendment ID and exact failure digest to a concrete diagnosed correction;
the discovery scope is unchanged. It requires paused settled ownership, an admitted
planning repair class and remaining total/per-path allowance. A stopped owner uses
the existing controller lock. The atomic snapshot retains superseded rejected
proposals alongside their original model captures and accounting. Replacement
leaves the Objective paused and grants no acceptance: fresh compilation charges the
existing planning ledger once, then canonical validation, independent review and
projection apply normally. A diagnosis supplies no missing authority and cannot
resolve a human-owned source decision; an unresolved finding still stops the fresh
review. Unknown calls/effects, provider failures, invalid or incomplete review
responses, projected work and terminal states remain fenced. No automatic retry
loop or second state root is introduced.

New aggregate compiler choices omit free-form acceptance. The controller supplies
one structural child acceptance criterion: implementation results are integrated
into the selected candidate, while read-only QA and aggregate children supply
accepted proof against that candidate without a worker or delivery. New semantic
assertions belong to read-only QA children. Existing parent acceptance, or the
acceptance of unstarted work decomposed into a parent, remains exactly as accepted through the
trusted previous graph. Candidate validation enforces that derivation without
rewriting admitted snapshots. Final-review/controller coverage retains the
original Objective obligations separately from parent acceptance. Aggregate
validation and independent review run after implementation-child integration and
read-only-child acceptance; a read-only child is never required to deliver a PR.

An explicitly authorized unchanged-baseline qualification may compile a nonempty
all-QA graph with no coding worker, owned change, implementation dependency or
PR. Its controller-derived candidate basis is `pinned-baseline`, bound to the
accepted base and current authenticated default-branch head; an implementation
graph instead uses `current-graph-integration` from actual delivery. Baseline
qualification never writes an integration identity or fabricates native or
WorkGraph dependencies. Original final-review/controller criteria owned by QA
remain at final Objective acceptance; current QA acceptance uses its actual
phase-available commands and semantic evidence. Source-required implementation
cannot be omitted by selecting read-only nodes. QA and final evidence, sealing,
closure, status and native predecessor acceptance retain the honest candidate
basis. Exact default-head checks precede baseline QA and final validation and
follow final independent review. Existing mixed implementation graphs retain
actual integration dependencies and candidate freshness. [#459](https://github.com/clockgrove/factory/issues/459)
owns this bounded correction and its exact installed qualification.

Current, completed dependency and final review receive the harness discovery
retained on the Work Item attempt, bound to that attempt and its current reviewed
result commit/tree. The controller proves capture binding; proposal facts,
requested scope, ownership, acceptance and dependencies remain harness declarations.
A matching accepted graph-revision receipt separately proves the independently
reviewed addition: worker attempt, parent/successor graph digests, review digest,
acceptance time and exact added node definitions. Existing integrated QA/aggregate
proofs establish later completion, not proposal submission. Missing, stale or
incomplete capture supplies no submission proof and does not prove that no
submission occurred; missing or mismatched amendment facts cannot prove acceptance.
The private staging file remains outside Git. No history store or model call is
added.

### Compiler plan review

[Trunk issue #19](https://github.com/clockgrove/factory/issues/19) defines the routine path: one structured compiler output from a complete, pinned source packet, deterministic graph checks, then one independent LLM review of the complete proposed plan. The review surface includes the Objective, base, pinned sources, Work Item graph, command-authority receipts, and exact final integrated-head commands. The reviewer must cite source-backed findings for missing Objective obligations, unsupported scope, citation defects, dependency or ownership mistakes, unobservable acceptance, or command/final-validation gaps. Deterministic checks remain authoritative for machine-checkable facts; the reviewer cannot grant authority or silently edit the plan.

Graph and result review use one packet-bound choice protocol. The controller supplies a packet identity and indexed criteria and evidence. Model findings select indices; the controller resolves canonical identities and provenance. The response binds to the exact packet, and unknown, missing, duplicate or malformed selections fail validation. The provider schema stays constant in size as the packet grows. A valid selection is not semantic proof. Repository text is encoded as data and cannot assign controller authority through a colliding display label. Persisted findings retain compact resolved provenance and digests. Invalid review transport is distinct from a substantive refusal or human-owned criterion and stays within the existing decision lifecycle; it does not authorize another call or acceptance.

The compiler similarly returns semantic choices rather than a serialized internal graph. Factory derives Objective/base identities, coverage owners, criterion/source identities, exact cited commands and final criterion references from the bound request. Source command choices name supplied source and line indices; base-observed commands retain their explicit declaration and provenance checks. Pinned citation sections become structured worker input sources, independently verified before activation and rendered by the shared harness prompt. Workers do not depend on the planner copying source contents into prose. Completed response decoding failures remain known failures through the existing bounded planning-repair path; they are not unknown provider submissions.

Result evidence separates complete changed-path/blob descriptors from individually bounded file patches. A complete descriptor proves its metadata, not omitted content. A pass cannot cite an incomplete chunk, but unrelated incomplete patches do not veto a criterion independently proved by complete supplied evidence. Patch allocation consumes actual emitted UTF-8 bytes across the existing work-item packet budget; the setting is not a total model-prompt cap. Full sources, command receipts and other controller observations retain their separate bounds.

Planning pairs each acceptance claim with evidence available at its actual review phase. Read-only QA review receives its controller-selected candidate commit/tree and its `pinned-baseline` or `current-graph-integration` basis, actual completed validation receipts and any applicable completed dependency identities without a coding worker or PR. Current, dependency and final review receive compact retained failure/candidate/correction and admitted consumption facts when a diagnosed repair occurred. Retained repair proof supplies controller-validated admitted policy/class and finite consumption, failed/current attempt and execution/result-base bindings, and complete failed-candidate Git descriptors with an ownership-scoped comparison. Equal owned committed bytes can prove implementation preservation across legitimate native replay even when result bases and whole trees differ. Missing or mismatched bindings cannot prove preservation or authority. Original failed candidates remain separate from later native replay results; declared diagnosis and host-action prose do not establish unobserved external effects. A source-required successful probe proves its observed condition; no separate host-action witness is implied unless the source requires one. Conditional clauses retain their source phase and meaning: a passing condition does not require inventing a failed execution, while an actual earlier failure or source-required failure scenario needs supplied evidence. Equal immutable ordinary blob identities can prove preserved committed bytes, without proving checkout hydration, opaque semantics or transient history. Additional exact size/hash assertions are needed only when the required fact lacks sufficient supplied evidence; they must retain existing source-command authority and declaration syntax. Worker conduct and existing operator-history duties remain separate from tree facts, and later controller hydration remains final-review evidence. Missing evidence requires a precise source question, not an invented command or weakened requirement. Deterministic prompt regressions establish this instruction contract, not live-model judgment.

A concrete finding permits at most one evidenced compiler revision, followed by deterministic revalidation and independent re-review. A clean validated and reviewed plan proceeds without routine human approval. After the bounded revision, unresolved source conflict, missing authority, material defects or disagreement, or an explicitly human-owned decision triggers one specific question with a recorded fallback reason. A human decision is bound to the exact reviewed-plan digest and cannot cause compilation or review to repeat. Activation verifies that immutable packet and its installation-configuration digest without another model call; any changed Objective, base, source, graph, command receipt, final command, or configuration is rejected. [Issue #60](https://github.com/clockgrove/factory/issues/60) records the activation/review-surface correction exposed by the v0.1.7 greenfield gate. Do not add a recursive judge/repair pipeline or a generic request to approve every plan. Command authority and result-level acceptance remain the separate #20 responsibility.

An operator may explicitly request exact-tree Work Item re-review through `rereview`, then `run`, after inspecting a pending result. This schedules existing validation and automatic review without restarting implementation or recording acceptance. The existing final-result continuation remains `run`, which repeats final validation and review. These explicit actions do not expand automatic provider retries or revive terminal results. [Issue #202](https://github.com/clockgrove/factory/issues/202) records this continuation boundary.

Initial preparation and graph amendments persist the outcome of the whole sequential
GitHub projection call in the existing atomic snapshot (#498). Planning completion
is not projection completion. The call is submitted before its first read or
mutation; successful completion records projected, and an actual typed completed
HTTP 4xx rejection records rejected. A submitted call may have stopped before any
mutation, but its unresolved outcome remains fenced across restart, handoff and
stopped cancellation. Lost responses, crashes and generic exceptions cannot be
replayed or settled by reading current GitHub facts. Retained error prose and
missing fields never establish a completed rejection.

Stopped cancellation of a confirmed completed rejection is distinct from permanent UNACCEPTED abandonment of unresolved read-only review or synchronous graph projection (#363 / #499). Current readback never settles unknown submission; the permanent disposition preserves every pending fact and original Work Item status.
For a known rejected initial or amended projection, ordinary `cancel` may retire
an unaccepted failed run with exclusive stopped mutation ownership, bound original
configuration/source and independently reviewed graph, settled local work, and no
other unresolved submission. GET-only readback authenticates the unique recorded
subset of candidate issues and every accepted previous mapping. Uncreated new nodes
need no fabricated identities or role labels; an early initial rejection may precede
the Objective role assignment. Recorded Work Items retain their exact reviewed old
or new bodies, titles, roles and state. Intermediate dependency sets must stay within
reviewed old/new intent and preserve common edges. Native parent GETs and lists must
agree with reviewed old/new parents; old children cannot lose their parent, while a
new child may remain unattached. Foreign, duplicate, changed or ambiguous facts and
live resources refuse before cancellation intent is saved. The original rejection,
graph, review, maps, errors, accepted/failed evidence and consumption remain in the
terminal unaccepted snapshot. This performs no remote mutation, projection replay,
provider call, service activation or allowance reset. Historical submitted projections
without a genuine completed-response fact remain unresolved and require a separate
explicit operator disposition; this contract does not reinterpret the stopped
v0.1.72 run or authorize its cancellation.

### Existing workspace membership authority

The pinned Objective may declare exact relative directories under `## Workspace package additions`. Compilation requires one responsible Work Item to own the existing `pnpm-workspace.yaml` and each new package manifest and carry its directory in the worker-visible brief or pinned source inputs. Runtime validation compares parsed membership against the original accepted base and accepted predecessor, permits only those additions with regular JSON manifests, preserves original entry order and predecessor membership, and keeps every non-membership setting pinned. Ambiguous YAML, aliases, tags and merges fail closed. This uses the existing Objective digest and immutable Git evidence, not a new permission store. Ownership and validation commands alone never grant this authority. The same check runs before commands in Work Item, environment, QA and final validation, including command-less results. Greenfield workspace authority remains unchanged.

### Executable acceptance coverage (#248)

Every accepted WorkGraph requires a complete coverage collection. Controller-generated criterion IDs bind each Objective acceptance criterion to its complete pinned source digest and text. The planner chooses an obligation index within its owning Work Item; Factory derives canonical ownership and source facts. Each proof is a typed alternative: result or integrated command, result or integrated semantic acceptance, final review, final controller guarantee, integrated CI, or published CI. Command and semantic alternatives use bounded indices into the owner's validation or acceptance list. Final review derives the exact Objective criterion; published CI explicitly names a delivery dependency and check. Unsupported published command or semantic proof is rejected because no executor supplies it.

Deterministic checks reject uncovered criteria, unknown owners, unsupported commands and premature proof. Independent graph review still owns semantic adequacy, source obligations beyond mechanically parsed Objective criteria, required negative controls, golden/baseline authority and missing thresholds. Controller guarantees remain subject to the existing final acceptance review. Current plans and state use new format versions and reject earlier formats; no compatibility reader or migration is supplied. Historical evidence remains preserved.

A read-only `kind: qa` Work Item has empty path ownership and no execution profile,
worker, media output or pull request. It uses existing dependencies, work state,
validation, independent review and issue closure. Native delivery isolates it from
PR chains. A native consumer of a declared prepared environment also starts a new
delivery unit, so its preparer integrates before the readiness probe. Integrated QA waits for every implementation ancestor and validates the
actual integrated candidate; published CI refers to a delivery dependency's exact PR
head. Finalization rejects stale integrated QA. Required named CI must carry a
successful authenticated check-run identity at the exact head; aggregate green checks,
workflow text and local command receipts cannot satisfy it. Missing, pending or failed
CI blocks completion without adding an automatic implementation retry.

Real-environment checks require a source-authorized readiness probe. Probes run before
worker execution, and any preparation names an existing authorized dependency.
Missing external prerequisites require a precise source decision. Factory does not
infer setup commands, infrastructure or mock substitutes. Command and selected-LFS
validation keep their established authority and exact-tree rules. Deterministic tests
use temporary Git repositories and narrow service fakes; installed public acceptance
belongs to #253 and does not follow from these tests.

## Agent-readable diagnostics

[Trunk issue #28](https://github.com/clockgrove/factory/issues/28) established machine-readable current status and timestamped, correlated local diagnostics across planning and review, scheduling and blocked reasons, harness work, validation output, GitHub delivery, media decisions, and final acceptance. [Issue #73](https://github.com/clockgrove/factory/issues/73) closes the planning-adapter regression: the provider-neutral model observation seam now covers compile, graph review, Work Item result review, and final Objective review with real provider progress, explicit model policy, usage availability, safe request/response correlation, and semantic rejection. [Issue #76](https://github.com/clockgrove/factory/issues/76) makes graph-review rejection actionable without exposing target content: malformed review transport reports a fixed field and reason without copying provider content; result criteria are validated independently. Clean review remains exactly an empty findings array; malformed findings fail closed into the existing planning decision instead of being normalized into approval. One narrow application-layer emitter feeds a local structured-log sink; the read/follow/summary surface lets agents inspect progress without parsing private state JSON. The atomic snapshot remains the only continuation truth. Diagnostic loss is visible but cannot trigger replay, retry, or state reconstruction.

[Issue #214](https://github.com/clockgrove/factory/issues/214) adds explicit per-repository sensitive-content capture at the existing model and worker observation seams. Versioned metadata stays in private diagnostics/progress; bounded request/schema and exposed interaction content is referenced in private invocation artifacts. This retains original review-packet identities without another evidence database, lifecycle ledger, evaluator or replay path. Metadata-only readers do not load transcripts. See [the local capture contract](LOCAL-CAPTURE.md) for coverage, usage scope, privacy and operator retention.

[Issue #94](https://github.com/clockgrove/factory/issues/94) adds one narrow exception to the general no-automatic-retry rule: graph, Work Item result, and final Objective review may retry a provider-capacity failure twice with the exact same request, model, and reasoning selection. Each provider attempt and bounded delay is explicit in diagnostics. Non-capacity failures are not automatically retried, and exhausted capacity still produces the existing single exact human decision. A result-review retry never repeats the worker, validation, delivery, or planning.

Private model, worker, and command detail stays outside the target checkout with restrictive permissions, redaction, and operator-controlled retention. Exportable model metadata contains identities, counts, timestamps, and digests rather than raw target prompts or responses. Capture model, tool, and usage identities only when the adapter or harness reports them, and represent unavailable usage explicitly rather than inferring zero. An OpenTelemetry adapter may later export the same safe metadata; a hosted backend is not a trunk prerequisite. Focused integration evidence proves correlation, failure visibility, aggregation, and redaction without adding a fault matrix or operational event journal.

## Architecture and state

`src/runner.ts` coordinates the compiler (`src/compiler.ts`), local execution (`src/execution/`), GitHub gateway (`src/github.ts`), and delivery graph runners (`src/delivery/`). The regular and native runners use the same concrete scheduler (`src/scheduler.ts`), validator (`src/validation.ts`), and local content service. `src/state-store.ts` owns the controller lock and one atomic snapshot; `src/state.ts` validates persisted identities before use. `src/contracts.ts` holds the narrow outer contracts. The installed CLI writes private schemaVersion 1 configuration, schemaVersion 4 active state and schemaVersion 5 preparation state outside the target checkout. Current state requires typed acceptance coverage. Each ordered validation receipt carries its command, successful exit code and exact tree; receipts that differ from the accepted graph or Objective command surface are rejected. It reads no archived Factory config or state.

The local driver creates an exact-base worktree, launches one configured `AgentHarness`, records its adapter-bound durable handle, collects an exact change, and removes the owned worktree. The package-root registration seam composes an installed adapter without replacing planning, scheduling, validation, GitHub delivery, or content services. Codex remains the default; pinned Claude Agent SDK and GitHub Copilot SDK adapters triangulate provider-specific model, permission, tool, settings, session, authentication, and lifecycle choices behind the same worktree contract. Built-in workers are identifiable detached process groups; cancellation signals only the owned group and waits for live members to exit. The regular strategy publishes and merges one PR at a time. The native strategy partitions maximal unbranched chains; forks and multi-parent joins start new units after predecessors integrate. Native stacks use GitHub's versioned stack and asynchronous merge APIs, observe checks and branch protection, and reconcile stable PR/merge identities after restart.

The harness capability contract requires Factory-owned read/write worktrees, unchanged `HEAD`, controller-only publication, durable restart-safe lifecycle methods, normalized evidence and declared AssetSets, and an explicit authentication mode. Built-in local adapters reuse the developer's existing CLI/profile rather than storing provider credentials in Factory configuration. Missing or expired authentication becomes an actionable failed attempt followed by an explicit login and retry; it never triggers fallback or an interactive prompt inside a detached worker. [AGENT-HARNESSES.md](AGENT-HARNESSES.md) is the public adapter and security-boundary reference.

Media belongs to the configured `AgentHarness`: it may return multiple logical multi-file `AssetSet` candidates with evidence and provenance. Candidate count and required LFS roles come from the source-grounded Work Item. The local `ContentStore` keeps immutable SHA-256-addressed bytes and media type; each source binding records role, declared media type, and visibility, while each captured AssetSet descriptor retains input bindings and digests, provenance, rights, visibility, lineage, member roles, optional output relationships, and any declared authoritative format metadata without interpreting the format. A digest binds the private harness result. This lets the same bytes support different uses without attaching mutable policy to a content digest. Factory supports human review and whole-set selection, binds the selected set to approved destinations, and feeds it through ordinary validation and delivery. Workers produce candidates only under the private media staging directory and may not mutate final destinations. The controller permits an existing destination only for an exact byte-identical repository-source-to-required-LFS migration at the same owned path; every other overwrite remains invalid. The target's `.gitattributes` controls LFS for any format. Factory verifies pointer assignment, exact raw bytes, upload, and fresh-clone hydration. Exact-tree Work Item and final validation first verify the committed pointer, locally restore only applicable selected required-LFS members from the content store, and verify their SHA-256 and size before command zero; missing or corrupt content fails closed without smudge or network fallback. Selected bytes are reverified after commands and clean-tree enforcement uses the controller-hydrated state as its baseline. Successful exact-tree validation records a compact `worktreeObservation` only after initial cleanliness, unchanged final porcelain status relative to that baseline, selected-LFS integrity and settled subprocess ownership have all passed. Work Item, read-only QA and final review receive its literal controller evidence with the exact tree. A nonempty post-hydration baseline is reported as nonempty and unchanged, not as an empty worktree. Canonical snapshot and review validation reject malformed or mismatched observations; absent historical evidence stays absent. A canonical versioned controller-capability manifest is bound into compile, graph review, and immutable plan identity so these supervisor guarantees do not become invented target work or commands. Fresh-clone hydration runs before final acceptance review and contributes an exact integrated-commit/tree/member receipt to both review evidence and the atomic snapshot. The public PNG gate is one example; the core capture and delivery path also handles opaque 3D, audio, video, and other files.

## Resource admission and completion opportunity

Both delivery paths share phase admission over the existing atomic WorkState. Item path and named-resource ownership lasts across coding, validation, independent review and delivery; coding capacity is released after collection settles. Each effect reserves its configured phase before starting. A completed phase transfers its reservation before waiting for the next, so a concurrency-one run can review and finish its own worker result. Unknown effects retain their reservation and existing replay refusal.

Accepted pending priority uses larger integer values first (zero when unspecified), then prerequisite work within that priority, then stable graph order. Dependencies, accepted authority and ownership remain eligibility gates. Ready QA and waiting review receive the next suitable completion opportunity before new coding grants; this is not a wall-clock or preemption promise. Pending reprioritization uses the accepted graph-amendment boundary; running attempts retain their identities. Read-only aggregate/QA nodes reserve validation/review capacity and never a coding slot.

Optional installation `scheduling` declares total `cpu` and `memoryMiB`, `reviewConcurrency` and `validationConcurrency`, and per-phase `phases.coding`, `phases.validation`, `phases.review`, `phases.delivery` CPU/memory reservations. A binding total requires a fitting declaration for every phase; an absent reservation is unknown, not zero. These are operator admission reservations, not OS quotas or adaptive measurements. The execution concurrency and admitted maximum bound coding; the driver's `availableSlots` is already remaining capacity and is never reduced a second time. Unknown driver capacity stays unknown in diagnostics while the operator ceiling remains enforced. Existing absolute Objective deadlines also govern waiting phase admission.

Native preparation retains actual overlap but does not wait for every independent worker before reviewing a completed result. Publication and integration retain their established safety boundaries. Final Objective validation/review occurs after item work has settled. No separate queue, resource inventory or operational journal is introduced. Source acceptance does not qualify managed/sandbox execution; installed public overlap evidence remains #253.

### Managed candidate publication

The operator-approved exception in [#257](https://github.com/clockgrove/factory/issues/257)
permits a managed provider to commit and publish an attempt's candidate branch or
draft PR. Authorization binds the actual provider actor, target repository,
attempt-owned candidate refs and source/asset visibility. The supported provider
configuration must confine publication to those candidates: it grants no writes
to Factory delivery refs, default/protected branches or another attempt's refs,
and no merge, approval, deployment or protection-bypass authority. Repository
association, a unique branch name and prompt instructions alone do not establish
that confinement. Factory's controller credentials and GitHub gateway remain
private to the controller.

Provider publication is result transport, not delivery or acceptance. The managed
`ExecutionDriver` binds the actual task, requested base, authenticated candidate
commit/tree and any complete additional bytes in its existing execution handle.
Factory imports that immutable result into a controller-owned exact-base
worktree and applies ordinary ownership, filesystem, secret, AssetSet and LFS
checks through the existing collector. A provider may have committed its result;
the controller normalizes its verified files at the requested base and retains
the original provider head as provenance. Provider PR metadata does not define
native stack topology or substitute for dirty/untracked files, asset bytes or LFS
bodies that have not been exported.

After independent validation and review, Factory uses its existing regular or
native delivery strategy and exact-head merge guards. The provider's draft PR is
not adopted as an accepted Factory delivery. Unexpected candidate mutation,
incomplete output, unresolved submissions and active owned work remain fenced;
provider completion alone does not establish Work Item or Objective acceptance.
Restart, cancellation, accounting and resource-disposition requirements remain
unchanged. This exception changes neither the local `AgentHarness` capabilities
nor sandbox credential removal and unchanged-HEAD requirements.

Candidate content may reach GitHub before Factory's ownership and secret checks.
Those checks still gate Factory delivery, but cannot prevent or undo earlier
provider disclosure. Authorize candidate destinations and visibility before
starting the provider; a rejected candidate remains unaccepted even if already
published. The exception grants no new private-source disclosure authority.
Provider candidate refs, PRs and resources retain explicit disposition under the
existing owned-resource rules; never delete adopter resources automatically.

[#368](https://github.com/clockgrove/factory/issues/368) owns Copilot's bounded
hosted fit proof and installed qualification. The permitted publication path
must be established on the exact SDK route, together with exact initial input,
complete collection, same-task reconnect and ordinary-child cessation. Published
SDK interfaces and credential-free tests establish only their respective source
contracts; they do not qualify hosted behavior. Shared scheduling, continuation,
validation and delivery need no provider-specific state store or alternate path.

## Trunk slices and done criteria

| Slice                                      | Public acceptance                                        | Issue                                                |
| ------------------------------------------ | -------------------------------------------------------- | ---------------------------------------------------- |
| [0](#slice-0--clean-package-and-contracts) | Fresh package and contracts                              | [#1](https://github.com/clockgrove/factory/issues/1) |
| [1](#slice-1--installed-walking-skeleton)  | Installed one-item Objective                             | [#2](https://github.com/clockgrove/factory/issues/2) |
| [2](#slice-2--local-dag-and-lifecycle)     | Concurrent DAG and ordinary lifecycle                    | [#3](https://github.com/clockgrove/factory/issues/3) |
| [3](#slice-3--regular-and-native-delivery) | Predetermined native linear stack                        | [#4](https://github.com/clockgrove/factory/issues/4) |
| [4](#slice-4--media-content-and-lfs)       | Multi-file selected asset through LFS                    | [#5](https://github.com/clockgrove/factory/issues/5) |
| [5](#slice-5--release-candidate)           | Same installed candidate passes combined disposable gate | [#6](https://github.com/clockgrove/factory/issues/6) |

### Slice 0 — Clean package and contracts

Create the public repository, MIT license, plugin manifest, CLI and minimal skills, schemaVersion 1 config/state and seven outer contracts. Reject self-targeting and unsupported execution modes. Accept after clean build, typecheck, lint, format, package inspection, isolated tarball install, and refusal checks. Do not copy archived runtime or tests.

### Slice 1 — Installed walking skeleton

Complete one disposable Objective through one compiled Work Item, GitHub issue, durable snapshot, local Codex SDK attempt, fresh-worktree validation, regular PR merge, and Objective final validation at the exact integrated head. Run the installed package, not source-tree shortcuts.

### Slice 2 — Local DAG and lifecycle

Run dependency-linked items with configured concurrent independent lanes and path/resource serialization. Prove one active Objective, exact predecessor base, cancellation and process-group cleanup, explicit retry, and one controller restart during an active attempt without duplicate work. Use a source-rich public fixture to inspect a read-only draft graph; adopter-specific planning is separate.

### Slice 3 — Regular and native delivery

Partition maximal linear chains; a fork ends a chain and a join starts a new one. Preserve chain-of-one regular behavior. Publish immutable predecessor-based branches and PRs, create the native GitHub stack, verify checks and exact heads, merge via the required asynchronous API, reconcile pending identities after restart, and stop on unexpected external mutation. Accept through the three-layer [public disposable Objective template](../test/fixtures/objectives/native-stack.md). The template length is a scenario size, not a stack-depth limit.

### Slice 4 — Media, content, and LFS

Implement local content-addressed storage, safe source import, multi-file `AssetSet` and produced-set contracts, source/expected-output bindings, authoritative harness evidence, provenance/rights/visibility/lineage, human selection, and exact selected-set materialization. In one disposable Objective, first add a reviewed path-based `.gitattributes` rule, bind a real public fixture image to the harness, return two candidate sets each containing an image and sidecar, select one full set, deliver it through the ordinary Work Item path, and verify every digest after fresh-clone LFS hydration. Do not add image generation providers or a second media orchestrator.

### Slice 5 — Release candidate

Pack the plugin, installed use skills, and CLI. MCP is not a first-release requirement; discuss a thin adapter only if later installed-agent use demonstrates a concrete need. Use the same immutable versioned public artifact for one self-contained disposable Objective that combines concurrent local work, native stack delivery, real harness-declared AssetSets, selection, LFS, and exact final-head validation. Assemble the target from public fixture inputs; the target repository may be private. Document and test the full install/use flow from a fresh target checkout using only public options and the documented CLI and skills. A private adopter must then run its own source-grounded W0-001/LFS pilot under its own repository authority, using the published public artifact and interface exactly as an unrelated third party would. No source-module import, direct state edit, internal hook, unpublished local path, or adopter-specific Factory code path is allowed in that pilot. Its private notes record evidence only; they are not hidden operating instructions. The private pilot is required trunk evidence; the public fixture and operator flow make the generic gate independently reproducible by any contributor in a repository they control, without private material.

Releases are built, tested, packed, installed offline and attested by the tag-triggered [release workflow](RELEASING.md); the attestation lets anyone verify a tarball's source independently. Live qualification is required for minor versions. The earlier manual release-integrity procedure (#486) and its evidence are preserved in the [release history](history/PUBLIC-RELEASE-2026-10-03.md).

The operator [approved one named #448 continuation](https://github.com/clockgrove/factory/issues/448#issuecomment-5957494560) from the same paused v0.1.71 Objective to independently accepted v0.1.72, retaining authentic phase identities and the failed/unaccepted original one-artifact attempt. This qualification exception preserves all source, ownership, security, allowance and independent acceptance requirements; the general one-artifact rule remains in force for other gates. Its [exact event map](history/BUILD-STATUS-2026-10-03.md#approved-448-current-runtime-qualification) permits one paused cold activation with zero model dispatch and one controlled quiescent stop/start, exactly two v0.1.72 owner activations with no additional cycle or post-teardown start. One remaining planning revision, zero implementation repairs, one environment-only exact-result rereview and concurrency at most two remain unchanged. Actual #448 mixed-phase acceptance must precede private #445 on the same v0.1.72 artifact and proven scope; approval of this continuation does not accept either gate.

### Trunk review checkpoint

The `v0.1.0` one-immutable-package combined disposable gate passed; [the historical artifact records](history/BUILD-STATUS-2026-09-28.md) retain its package digest and final integrated head. The operator-approved pre-pilot trunk closure was issues [#19–#25 and #28](https://github.com/clockgrove/factory/issues). A later audit of Clockgrove W0-001 found that its accepted base has no pnpm package or lockfile, which led to the greenfield command-authority and exact-tree receipt work in [#44](https://github.com/clockgrove/factory/issues/44) and [#64](https://github.com/clockgrove/factory/issues/64). The v0.1.7 combined gate completed [#46](https://github.com/clockgrove/factory/issues/46), [#48](https://github.com/clockgrove/factory/issues/48), and [#51](https://github.com/clockgrove/factory/issues/51); public v0.1.8 proved [#60](https://github.com/clockgrove/factory/issues/60)'s complete planning packet and deterministic zero-review activation. Public v0.1.10 then completed the fresh installed greenfield gate with canonical exact-tree receipts and authoritative per-Work-Item deltas, closing #44, #64, and [#67](https://github.com/clockgrove/factory/issues/67) without a human result override or retry. [#55](https://github.com/clockgrove/factory/issues/55) separately owns the installed BYO harness seam and second-provider proof required for overall trunk completion, not a prerequisite for the operator-approved Codex-only [#26](https://github.com/clockgrove/factory/issues/26) pilot described below; [#59](https://github.com/clockgrove/factory/issues/59) owns role-specific model defaults. The currently authorized #162/#164 profile capabilities may proceed through deterministic development and reviewed integration in a separate contributor lane. The #8 start gate is now satisfied by accepted #19–#25/#28 foundations, #55 installed harness proof, and successor adopter execution/final acceptance #206/#207. Historical #26 was retired without acceptance, not relabelled as a pass. Credential-free sandbox implementation may proceed; each concrete provider retains its separately authorized installed qualification, and #9 depends on accepted #8. A clean refactor that wires known variation-point contracts to real behavior is welcome when it reduces a concrete gap. The first-release agent interface is the CLI plus installed skills over one application layer, with no MCP prerequisite. A later MCP adapter needs a demonstrated agent-integration need and must not duplicate lifecycle logic. This public repository, including contributor instructions, fixtures, and acceptance evidence, must remain sufficient for unrelated contributors; `AGENTS.md` guides building Factory, while packaged skills guide using it.

### Operator-approved Codex-only adopter pilot

The approved [adopter execution gate](https://github.com/clockgrove/factory/issues/206), continued from historical [#26](https://github.com/clockgrove/factory/issues/26), uses the published plugin and matching CLI artifact with local Codex. Its execution-order exception allowed the bounded pilot before #55's separate installed-harness proof. #55 and PR #62 are now accepted and closed; their provider evidence retains its own exact artifact and scenario identity.

The remaining first-adopter milestone requires fresh public qualification of the selected artifact, independent terminal audit, and then actual Clockgrove acceptance on that same artifact. Earlier accepted public runs do not qualify changed bytes. See [the release procedure](RELEASING.md) and [execution #206](https://github.com/clockgrove/factory/issues/206) / [final acceptance #207](https://github.com/clockgrove/factory/issues/207) for current acceptance. Optional-provider logins, managed execution, sandboxes, and current profile enhancements do not become prerequisites for this Codex-only pilot.

Overall trunk completion requires both the accepted installed-harness foundation and actual adopter acceptance. Contributor procedures do not grant an adopter new target, provider, source-egress, or spending authority.

## Trunk foundations and provider branches

Trunk owns the shared execution and result contracts, the atomic continuation snapshot, independent validation and delivery boundaries, and the installed harness seam and second-provider proof in [#55](https://github.com/clockgrove/factory/issues/55). These foundations let the local path use the same orchestration boundaries as later execution modes. They do not require working cloud or sandbox execution before trunk acceptance.

| Trunk foundation                                             | Branch implementation                                          |
| ------------------------------------------------------------ | -------------------------------------------------------------- |
| `ExecutionDriver` lifecycle and exact result contract        | Managed cloud tasks and independently qualified providers (#7) |
| Installed `AgentHarness` selection and conformance (#55)     | Sandbox transport and lifecycle around that harness seam (#8)  |
| Shared snapshot, content, validation and delivery boundaries | Daytona behind the sandbox provider boundary (#9)              |

The named contracts and configuration shapes are architectural seams, not claims of available execution. Unsupported mode selections must fail explicitly until their implementation is accepted. A scripted provider fixture proves the exercised contract; a real provider requires its own installed evidence. One provider does not establish portability across all SDKs, vendors or harness/provider combinations.

Working managed execution belongs to [#7](https://github.com/clockgrove/factory/issues/7), with peer adapters for Copilot cloud sessions ([#257](https://github.com/clockgrove/factory/issues/257)), OpenAI Agents API ([#258](https://github.com/clockgrove/factory/issues/258)) and Claude Managed Agents ([#259](https://github.com/clockgrove/factory/issues/259)). Providers have no ordering dependency. The first viable scheduled adapter supplies only the shared configuration and composition needed for its concrete capability; coordinate overlapping edits and keep SDK types, authentication and result transport inside adapters. Reuse the existing driver lifecycle, continuation snapshot, validation and delivery instead of adding a provider framework. Each adapter needs its own hosted evidence before support is claimed; a local SDK or scripted test does not qualify a managed service.

Working sandbox execution belongs to #8; see [sandbox configuration and the provider boundary](SANDBOX-EXECUTION.md). One `SandboxExecutionDriver` composes a `SandboxProvider` for infrastructure with the configured `AgentHarness` for agent behavior. #9 depends on #8 and adds Daytona as the first concrete provider. Later sandbox vendors are sibling adapter capabilities depending on #8, not on Daytona. Do not create a driver for every vendor/harness pairing. #7 is not a technical dependency of #8 or #9; the planned delivery order remains managed execution, sandbox execution, then Daytona.

A branch may change shared code to satisfy its accepted behavior without becoming a trunk prerequisite. Move a correction earlier only when a demonstrated current trunk requirement needs it. Do not add speculative registries, generic SDK wrappers or remote lifecycle state merely to advertise extensibility. Installation-owned execution profiles (#162) explicitly extend the former project-level single-harness selection boundary: compilation assigns each Work Item an eligible profile before independent review and projection. Selection remains within one local execution mode, one scheduler and one shared concurrency limit. The accepted graph, installation digest and durable attempt binding fix each assignment; there is no runtime ranking, automatic fallback or mid-attempt switching. Profile membership authorizes the provider to receive the whole worktree and materialized inputs, not just owned write paths. Environment preparation belongs separately to #164.

This boundary preserves the full-trunk and actual-pilot start gates and the bounded Codex-only pilot exception above. It does not expand provider spending, source-egress, target or publication authority. [Decision #157](https://github.com/clockgrove/factory/issues/157) records the approved documentation scope.

## Named branches after trunk

![Planning, harness, and execution-driver layering](architecture/execution-drivers.png)

`PlanningModel` compiles and reviews the Work Item graph. `AgentHarness` performs one Work Item under a Factory-operated local or sandbox driver. The three peer `ExecutionDriver` implementations differ in placement and lifecycle ownership: trunk's `LocalExecutionDriver` operates a local worktree; Branch 1's `ManagedExecutionDriver` submits and tracks a provider-owned agent task; Branch 2's `SandboxExecutionDriver` operates a `SandboxProvider` and invokes the configured harness inside it. An SDK name alone does not determine whether an agent is local or managed.

- [Managed cloud execution, issue #7](https://github.com/clockgrove/factory/issues/7): implement the independently scheduled Copilot, OpenAI and Claude provider children only where their durable task, authorization, cancellation, exact-change and result semantics fit the `ExecutionDriver` contract. Local SDK execution is not hosted proof. Preserve provider identity and unknown-effect fences, observe/cancel/collect, and feed the existing validation and delivery paths. Each provider proves its exact installed artifact through the public disposable Objective with recorded target, source-egress, provider/model, resource, attempt and spending authority. #243 local autonomy remains an independent workstream; managed providers are not prerequisites for it.
- [Configured harnesses in Factory-managed sandboxes, issue #8](https://github.com/clockgrove/factory/issues/8): using the accepted #55 harness foundation, compose `SandboxProvider` with that installed harness seam. Prove transfer, execution, observation, cancellation, collection, and destruction with a provider-neutral fixture; do not redefine BYO harness installation or configuration in this branch.
- [Daytona sandbox provider, issue #9](https://github.com/clockgrove/factory/issues/9): add the first concrete provider behind `SandboxExecutionDriver` and run the Branch 2 scenario unchanged. Keep Daytona details within its adapter.

## Test reset and representative gates

Archived tests, fixtures, snapshots, transcripts, generated evidence, and coverage targets are not copied. Tests are written from current acceptance. Use real temporary Git repositories, commits, worktrees, processes, and files; a scripted harness; and a small stateful GitHub gateway fake at domain operations. Unit tests focus on dense DAG, path/resource, chain, digest, pointer, and descriptor logic. Live SDK/GitHub runs are release-candidate smokes, not a broad qualification system.

`npm ci && npm run build && npm run typecheck && npm run lint && npm run format:check && npm test && npm pack --dry-run` is the local gate. The [Quality workflow](../.github/workflows/quality.yml) runs this gate on pull requests and main without credentials; live GitHub and Codex gates are recorded separately. For GitHub delivery, create a disposable repository you control from [the target fixture](../test/fixtures/disposable-target/), create an Objective using a checked-in template, install the packed tarball in an isolated prefix, and record issue/PR identities, validated tree, and integrated head. Never point Factory at this repository. The [README](../README.md) has the current install command; [RELEASING.md](RELEASING.md) describes live qualification.

[QUALITY-TOOLING.md](QUALITY-TOOLING.md) maps the pinned Biome lint and
formatting coverage to the previous ESLint and Prettier gate. Narrow fallback
checks remain where the selected Biome release has no equivalent.

`npm test` includes a bounded deterministic application suite. It composes a scripted planning model and harness, the real local execution driver and content store, the configured delivery strategy, and a small GitHub-domain fake through the production application boundary. The fake integrates actual commits through temporary local remotes; it does not emulate GitHub's wire protocol. A fresh packed-artifact smoke invokes the supported `install` and `status` surface from isolated prefix/config/state directories. The public `factory plan` command previews and independently reviews a plan without Work Item projection or execution state; its real model calls remain separate from this credential-free smoke.

A contributor can copy `test/fixtures/disposable-target/` into an empty directory, run `git init -b main`, commit the two fixture files, and publish that directory as a new disposable GitHub repository they control. Use `gh issue create --body-file` with [walking-skeleton.md](../test/fixtures/objectives/walking-skeleton.md), [local-dag.md](../test/fixtures/objectives/local-dag.md), or [native-stack.md](../test/fixtures/objectives/native-stack.md). Install the packed CLI with a fresh `XDG_CONFIG_HOME` and `XDG_STATE_HOME`, bind it to that checkout, and run the Issue number. Do not reuse an Objective after it has merged; use a fresh disposable repository or unique fixture paths for the next gate.

## Archived-source extraction

The archived `clockgrove/factory` commit `994bbfcadb317aed2dfa932ec9d128e7d0d8c7a8` is read-only reference. [SOURCE-PROVENANCE.md](SOURCE-PROVENANCE.md) maps each inspected path to reimplemented behavior and clean destination. Copy no archived implementation or test. Before adding a slice, inspect only the named archived files relevant to that slice, record the retained behavior, and leave old protocols and unused helpers behind.

## Release and cutover

The bounded Codex-only adopter activation exception above does not authorize
repository rename, archival, distribution changes or overall trunk completion.

The operator separately approved the repository rename on September 28, 2026: the clean implementation moved from `clockgrove/factory-rebuild` to `clockgrove/factory` after deletion of the legacy repository. This changes the repository name and current reference URLs; it does not establish overall trunk or adopter acceptance, change a target repository, or replace published artifacts and qualification evidence. [SOURCE-PROVENANCE.md](SOURCE-PROVENANCE.md) distinguishes the legacy source identity. Further archival or distribution changes remain separately authorized operator actions. Public issues, PRs, and this plan remain the contributor record.

### Local supervision lifecycle

A supported Linux systemd user manager may own the admitted coordinator independently of a chat. Registration binds the exact installed CLI, Node, configuration, state root and Objective, requires separate service consent, and never changes login persistence. Stop, disable, uninstall and artifact replacement drain the existing owner to a quiescent continuation; unknown effects do not become successful cessation. Detached attempts are not killed by service-group cleanup. Upgrades and rollback use the candidate artifact's actual continuation validator before and after drain. Unsupported state refuses without migration, deletion or allowance resets. Removing supervision preserves target binding and all execution evidence. Installed service lifecycle evidence and full autonomous Objective qualification are separate claims.

### Current-graph terminal acceptance

Final validation success is not Objective completion. After review the coordinator
re-observes the default head, checks the current graph again, and seals the exact
commit, tree, graph and configuration before beginning Objective closure. Required
leaves and aggregate parents must have accepted proof and acknowledged issue closure;
coverage, human decisions, pending discoveries, submitted effects and owned process
cessation remain independent gates. Protected delivery and media acceptance keep
their existing checks.

One compact immutable binding in the atomic snapshot references the existing final
and per-item evidence by digest. It retains diagnostic accounting scope without
inventing complete usage totals, and records settled ownership with evidence
retained. It is not a second acceptance ledger or deployment approval. Historical
snapshots remain readable without fabricated bindings.

Closure acknowledgement loss leaves the Objective active and an admitted owner
paused for explicit resume/reconciliation. Reconciliation uses the authenticated
GitHub closure contract and does not replay workers or review models. Amendment
intake reports busy while closure is sealed or unresolved; discoveries after Done
require successor work. A proposal arriving during review invalidates that review
before sealing. Later default-branch changes do not rewrite the sealed candidate.

### Diagnosed bounded repair (#250)

An admission may explicitly opt into `repairPolicy.perPath`, with numeric
`planningRevisions`, `implementationRepairs` and `resultRereviews` limits alongside
the existing Objective totals. `repairClasses` selects `implementation`,
`review-evidence`, `validation-environment`, `planning-output`,
`planning-evidence` or `planning-choice`. Omitting `repairPolicy` preserves the
previous explicit-run behavior. No contributor policy or upgrade grants this
permission to a target.

The atomic continuation retains original failed attempt identities, evidence and
corrections. A known, unpublished implementation failure may consume a permitted
repair, obtain a concrete diagnosis and correction, then start a new worker from
the accepted base. Removed unfinished edits are reported as unavailable; this is
not harness-session continuation. A repeated failed correction stops. Independent
regular lanes and independent unpublished native units may finish while failed
descendants remain held. Unknown submissions, publication, review or cancellation
retain their existing global fences. Deadlines use owned cancellation, never quiet
logs as a reason to retry. Unknown usage stays unknown in existing accounting;
this feature creates no monetary budget or missing-usage estimate.

A collected candidate can instead remain pinned through a diagnosed validation
environment correction. `factory repair --objective N --proposal FILE` accepts
`item`, its exact `treeSha`, and a `correction` containing `kind`, `failureDigest`,
`actor`, `diagnosis` and `correction`. The status response supplies the failure
identity. The operator restores only the already authorized prerequisite; changing
installation policy requires new authority, not this command. Recovery retains the original failed candidate and its history. When native
delivery replays the unchanged owned implementation onto an independently accepted
integration base, result commit/tree identities may change. Verify the exact owned
path inventory, modes and blob bytes, unchanged attempt/execution base and replay
parent/result-base binding; revalidate the actual selected result tree and run full
independent review before exact-head protected integration. Preserve both candidate
identities rather than claiming whole-tree equality. Recovery never restarts
implementation or records manual acceptance. Evidence-only review recovery uses the same exact candidate
and carries the concrete rejected transport field into a fresh review packet.
Missing/truncated evidence and semantic decisions require their actual correction;
a repeated unchanged failure is not silently accepted.

Sequential planning projects authenticated native Objective dependencies and the
original sealed, fully accepted predecessor commit/tree into compilation, graph
review and diagnosis. The compact controller facts bind the actual selected base,
unchanged predecessor body and acceptance evidence; exact equality and verified
ancestry remain distinct. They are neither target command authority nor edges
inside the current WorkGraph. Existing preparation and independent-review digests
bind this projection, and activation reobserves its original GitHub/snapshot
sources. No second dependency or acceptance store is maintained. Successor discovery
amendments supply the same validated native facts to compilation and independent
graph review. A digest of native facts in the existing admission binds that original
projection separately from current executable observations; reobservation precedes
review, projection and adoption. Historical snapshots remain readable without
fabricated native bindings. Gateway-backed amendments lacking that original binding
refuse before model calls. Item acceptance cannot require that same review's future completion; original whole criteria
requiring it stay at final Objective review with their source-required commands.

Planning separately receives the existing controller-local executable preflight
observations for the exact Objective final commands. Compilation, independent
graph review and diagnosis share these source/base/configuration-bound facts;
activation repeats the check. Ready means literal entrypoint presence and
executable-file access on the controller's validation PATH at observation time,
not command success, script-body behavior, future readiness or remote worker
capability. Dynamic, relative or target-owned resolution remains unverified.
Acceptance-only commands retain their required later phase. Graph amendments
observe the same scoped facts at their own planning boundary. These observations
use the existing preparation and review bindings, not a readiness ledger or
native Objective predecessor receipt (#403).

Planning compilation selects a source-required named CI check by semantic check
name and an existing pinned source index. The controller supplies that complete
source's canonical path, digest and literal text; models do not copy line bounds.
Independent graph and amendment review assess the resulting canonical entry and
its full pre-integration scope, rather than asking for discarded compiler choices.
Complete transport is not semantic acceptance. Planning diagnosis receives the
actual rejected canonical graph when one exists; failed wire decoding supplies
null, never a reconstructed graph. Findings and diagnosis remain claims evaluated
against supplied sources and controller facts (#458).

Compilation, graph review, diagnosis and amendment review also receive typed
configured concurrency and the checked finite authority maximum when supplied.
Explicit previews record no authorized maximum. These controller ceilings prove
neither available driver capacity, completed admission nor measured worker overlap;
authored worker prose cannot establish them. Review packets supply the facts as
controller evidence, candidates bind exactly what review saw, and activation and
admission check current configuration and authority. Existing immutable source,
configuration, authority and consumed-planning bindings remain intact (#458).

Native compilation validates copied Work Item primitives and collections before
proof, path, review or projection consumers. Identifiers, task text, string arrays
and asset declarations retain actual types across ordinary, read-only and retained
nodes. Malformed complete provider output is rejected without string coercion or
an independent review submission; the emitted schema does not substitute for
native validation (#460).

Planning with a repair policy, or within authorized intake, first persists its
body/base/configuration/authority binding. Initial compilation, diagnosis,
corrective compilation and independent review have explicit invocation identities.
Known responses remain in preparation until consumed; unknown responses cannot be
replayed. Malformed output, omitted supplied facts and already delegated choices
can consume planning correction allowances; genuinely missing product or security
decisions remain decisions. Preparation transfers its consumed allowances into
activation. Graph amendments share the same planning counter and path limit.
Original admitted item IDs anchor work repair scopes; aggregate children inherit
those scopes, and otherwise new work shares the Objective discovery scope. Neither
new children, explicit retry commands, recompilation nor restart resets limits.

A retained planning review pairs its original packet and complete canonical
review-context/configuration digest with its completed response in that same
preparation snapshot. The request is retained before provider submission. An
unchanged known review uses the original packet and resolved evidence identities;
pause/restart cannot create an identity-only protocol failure or correction charge.
Completed clean reviews and prior rejected review envelopes remain retained.
Actual rejected findings can still consume an evidenced, admitted correction and
require a fresh independent review of the corrected graph (#464).

Changed or damaged review context, a response lacking its original request binding,
and unknown submitted outcomes never inherit acceptance or get rebound to new
packet identities. They stop without a diagnostic call or allowance reset. A
historical unbound preparation requires supported owned cessation/cancellation
before a separately bounded corrected successor; preserve its rejected evidence
and accounting rather than reconstruct a binding or migrate the record (#464).
