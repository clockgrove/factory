# Factory implementation plan

This is the public, controlling build plan for contributors. [BUILD-STATUS.md](BUILD-STATUS.md) names the current slice and next action. The [project board](https://github.com/orgs/clockgrove/projects/2) and linked issues track accepted outcomes. Target repositories own their own product requirements; no private adopter document is required to build or test Factory.

[The archive-to-rebuild capability review](ARCHIVE-CAPABILITY-DECISIONS.md) records the operator-approved retain/simplify/defer/discard decisions from the original Factory. The linked issues define accepted implementation scope; the review does not supersede this plan or imply that retained behavior is complete.

## Product boundary

Factory is a plugin installed for one target GitHub repository. It compiles a human Objective issue into a dependency-linked Work Item graph, runs a configured harness, validates exact changes independently, delivers through GitHub, and validates the integrated Objective. Factory is neither a hosted control plane nor a dependency of the target product. It must never run against a Factory source repository.

The shippable trunk covers installation, compilation, GitHub projection, one active Objective, local DAG scheduling, restart/cancel/retry, exact-tree validation, regular PRs and native linear stacks, media AssetSets, target-owned Git LFS policy, package/skill/CLI delivery, and the installed bring-your-own harness seam tracked by #55. Later branches add managed cloud-agent execution, a sandbox driver that consumes that harness seam, and Daytona as its first provider. Automatic bursting, mixed modes, live migration, distributed controllers, provider marketplaces, media-tool discovery, search catalogs, and exhaustive fault systems are leaves and do not block trunk.

## Design laws

1. Keep one vertical path: Objective → validated DAG → GitHub Work Items → ready item → configured driver/harness → exact change or declared AssetSet → independent validation → configured delivery → final Objective validation at the integrated default-branch head. Reviewed media returns to that path.
2. Preserve one source of durable truth per concern: one atomic local continuation snapshot, GitHub Issues/PRs/checks for collaboration, the target Git tree for product result, a content-addressed store for immutable large bytes, and the target repository for requirements and commands. Do not add operational event journals, receipt ledgers, activation refs, or state reconstruction from diagnostic logs or session memory.
3. Use narrow contracts for known alternatives: `PlanningModel`, `ExecutionDriver`, `AgentHarness`, `SandboxProvider`, `DeliveryStrategy`, `ContentStore`, and `GitHubGateway`. Keep the runner, scheduler, validator, local state store, Git model, and controller host concrete.
4. Do not create hidden Factory limits beneath GitHub, providers, the OS, target rules, or explicit operator policy. One repository, one execution mode, and one active Objective per installation are explicit trunk boundaries.
5. Existing explicit runs stop on failed work or ambiguous external state and require explicit operator retry for a new Work Item attempt. The autonomous contract below permits only diagnosed repairs within an explicitly admitted policy once that capability is implemented. Upgrading never grants existing runs new retry authority. The explicit compiler gate may make one evidenced planning revision after independent review; this is not an implementation retry. Ordinary controller restart reattaches to an identifiable active attempt.
6. Work Items name owned paths, dependencies, resources, acceptance, non-goals, source citations, and command provenance. Parallel items cannot write overlapping paths or claim the same exclusive resource. Validation commands must be observed on the base or literally declared by a supplied source.
7. A worker has no GitHub credentials or publication authority. The controller checks exact bases, PR heads, merge results, and the final default-branch head. Target branch protection and required checks remain authoritative.

### Explicit autonomous execution contract

[Program #243](https://github.com/clockgrove/factory/issues/243) extends the explicit-run contract with local background supervision, reviewed graph revisions, bounded diagnosed repair and sequential authorized intake. These capabilities are implemented through its individual issues; this contract is not a claim that they are enabled in the published plugin. The existing explicit plan/run/retry workflow remains supported.

An installation may admit only explicitly authorized Objectives or a finite batch. Bind the target, exact Objective body, pinned base and source packet, installation configuration, delivery and acceptance policy before dispatch. The configuration remains the authority for providers, permissions and worker ceilings; admission cannot expand it. Record numeric planning, implementation and review allowances, permitted repair classes, resource limits and required environments from the operator, without inventing defaults. Initial explicitly requested planning remains separately authorized preparation. Installation, a discovery label and service consent alone authorize no Objective execution or provider spending.

Use one concrete local coordinator and one authoritative continuation store. Reconcile known work before dispatch, serialize lifecycle changes and run long I/O outside state mutation. The coordinator owns projection and admissions; workers propose discoveries without GitHub publication credentials. An accepted graph revision is immutable. Review amendments at safe boundaries, preserve running/completed identities, distinguish executable leaves from aggregate parents, and retain every required criterion's owner, phase and evidence. A paused active Objective prevents admission of another.

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

The existing atomic snapshot retains the admitted initial graph, immutable reviewed
successors, one pending amendment and Objective-level allowance consumption. Each
new attempt binds its accepted graph digest. A revision consumes one recorded
planning allowance before model submission; decomposition, children and restart do
not reset it. Every required source criterion and existing Work Item acceptance
remains covered. Changed started or completed nodes require explicit successor or
revalidation work. Independent graph review includes the previous graph, proposal
and compact attempt/result identities; it cannot expand source or command authority.

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

### Compiler plan review

[Trunk issue #19](https://github.com/clockgrove/factory/issues/19) defines the routine path: one structured compiler output from a complete, pinned source packet, deterministic graph checks, then one independent LLM review of the complete proposed plan. The review surface includes the Objective, base, pinned sources, Work Item graph, command-authority receipts, and exact final integrated-head commands. The reviewer must cite source-backed findings for missing Objective obligations, unsupported scope, citation defects, dependency or ownership mistakes, unobservable acceptance, or command/final-validation gaps. Deterministic checks remain authoritative for machine-checkable facts; the reviewer cannot grant authority or silently edit the plan.

Graph and result review use transient packet-local evidence IDs rather than model-transcribed quotations or source labels. Result findings name controller-assigned criterion IDs, may arrive in any order and may cite multiple supplied chunks. The controller rejects missing, duplicate, unknown or malformed identities; a valid ID is not semantic proof. Repository text is encoded as data and cannot assign controller authority through a colliding display label. Persisted findings retain compact resolved provenance and digests, while historical quotation records remain readable. Invalid review transport is distinct from a substantive refusal or human-owned criterion and stays within the existing decision lifecycle; it does not authorize another call or acceptance.

Result evidence separates complete changed-path/blob descriptors from individually bounded file patches. A complete descriptor proves its metadata, not omitted content. A pass cannot cite an incomplete chunk, but unrelated incomplete patches do not veto a criterion independently proved by complete supplied evidence. Patch allocation consumes actual emitted UTF-8 bytes across the existing work-item packet budget; the setting is not a total model-prompt cap. Full sources, command receipts and other controller observations retain their separate bounds.

Planning pairs each acceptance claim with evidence available at its actual review phase. Equal immutable ordinary blob identities can prove preserved committed bytes, without proving checkout hydration, opaque semantics or transient history. Additional exact size/hash assertions are needed only when the required fact lacks sufficient supplied evidence; they must retain existing source-command authority and declaration syntax. Worker conduct and existing operator-history duties remain separate from tree facts, and later controller hydration remains final-review evidence. Missing evidence requires a precise source question, not an invented command or weakened requirement. Deterministic prompt regressions establish this instruction contract, not live-model judgment.

A concrete finding permits at most one evidenced compiler revision, followed by deterministic revalidation and independent re-review. A clean validated and reviewed plan proceeds without routine human approval. After the bounded revision, unresolved source conflict, missing authority, material defects or disagreement, or an explicitly human-owned decision triggers one specific question with a recorded fallback reason. A human decision is bound to the exact reviewed-plan digest and cannot cause compilation or review to repeat. Activation verifies that immutable packet and its installation-configuration digest without another model call; any changed Objective, base, source, graph, command receipt, final command, or configuration is rejected. [Issue #60](https://github.com/clockgrove/factory/issues/60) records the activation/review-surface correction exposed by the v0.1.7 greenfield gate. Do not add a recursive judge/repair pipeline or a generic request to approve every plan. Command authority and result-level acceptance remain the separate #20 responsibility.

An operator may explicitly request exact-tree Work Item re-review through `rereview`, then `run`, after inspecting a pending result. This schedules existing validation and automatic review without restarting implementation or recording acceptance. The existing final-result continuation remains `run`, which repeats final validation and review. These explicit actions do not expand automatic provider retries or revive terminal results. [Issue #202](https://github.com/clockgrove/factory/issues/202) records this continuation boundary.

### Existing workspace membership authority

The pinned Objective may declare exact relative directories under `## Workspace package additions`. Compilation requires one responsible Work Item to own the existing `pnpm-workspace.yaml` and each new package manifest and carry its directory in the brief. Runtime validation compares parsed membership against the original accepted base and accepted predecessor, permits only those additions with regular JSON manifests, preserves original entry order and predecessor membership, and keeps every non-membership setting pinned. Ambiguous YAML, aliases, tags and merges fail closed. This uses the existing Objective digest and immutable Git evidence, not a new permission store. Ownership and validation commands alone never grant this authority. The same check runs before commands in Work Item, environment, QA and final validation, including command-less results. Greenfield workspace authority remains unchanged.

### Executable acceptance coverage (#248)

New compiler output retains one `coverage` collection in the accepted WorkGraph.
Controller-generated criterion IDs bind each Objective acceptance criterion to its
complete pinned source digest and text. The planner selects criterion IDs; the
controller restores source facts without requiring quoted text or hash transcription.
Command and result-semantic oracles select owning-array indices, while final semantic
oracles select the criterion ID. Each entry names an existing Work Item,
its command, semantic oracle, controller guarantee or named CI check, the feasible
phase, and environment readiness. Deterministic checks reject uncovered criteria,
unknown owners, unsupported commands and premature proof. Independent graph review
still owns semantic adequacy, source obligations beyond mechanically parsed Objective
criteria, required negative controls, golden/baseline authority and missing thresholds.
Final semantic coverage refers to the exact Objective criterion; controller guarantees
remain subject to the existing final acceptance review. Older explicit graphs without
coverage remain readable, while new compilation requires complete coverage.

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

`src/runner.ts` coordinates the compiler (`src/compiler.ts`), local execution (`src/execution/`), GitHub gateway (`src/github.ts`), and delivery graph runners (`src/delivery/`). The regular and native runners use the same concrete scheduler (`src/scheduler.ts`), validator (`src/validation.ts`), and local content service. `src/state-store.ts` owns the controller lock and one atomic snapshot; `src/state.ts` validates persisted identities before use. `src/contracts.ts` holds the narrow outer contracts. The installed CLI writes private schemaVersion 1 configuration and schemaVersion 2 state outside the target checkout. State v2 makes each ordered validation receipt carry its command, successful exit code, and exact tree, and rejects receipts that differ from the accepted graph or Objective command surface. It reads no archived Factory config or state.

The local driver creates an exact-base worktree, launches one configured `AgentHarness`, records its adapter-bound durable handle, collects an exact change, and removes the owned worktree. The package-root registration seam composes an installed adapter without replacing planning, scheduling, validation, GitHub delivery, or content services. Codex remains the default; pinned Claude Agent SDK and GitHub Copilot SDK adapters triangulate provider-specific model, permission, tool, settings, session, authentication, and lifecycle choices behind the same worktree contract. Built-in workers are identifiable detached process groups; cancellation signals only the owned group and waits for live members to exit. The regular strategy publishes and merges one PR at a time. The native strategy partitions maximal unbranched chains; forks and multi-parent joins start new units after predecessors integrate. Native stacks use GitHub's versioned stack and asynchronous merge APIs, observe checks and branch protection, and reconcile stable PR/merge identities after restart.

The harness capability contract requires Factory-owned read/write worktrees, unchanged `HEAD`, controller-only publication, durable restart-safe lifecycle methods, normalized evidence and declared AssetSets, and an explicit authentication mode. Built-in local adapters reuse the developer's existing CLI/profile rather than storing provider credentials in Factory configuration. Missing or expired authentication becomes an actionable failed attempt followed by an explicit login and retry; it never triggers fallback or an interactive prompt inside a detached worker. [AGENT-HARNESSES.md](AGENT-HARNESSES.md) is the public adapter and security-boundary reference.

Media belongs to the configured `AgentHarness`: it may return multiple logical multi-file `AssetSet` candidates with evidence and provenance. Candidate count and required LFS roles come from the source-grounded Work Item. The local `ContentStore` keeps immutable SHA-256-addressed bytes and media type; each source binding records role, declared media type, and visibility, while each captured AssetSet descriptor retains input bindings and digests, provenance, rights, visibility, lineage, member roles, optional output relationships, and any declared authoritative format metadata without interpreting the format. A digest binds the private harness result. This lets the same bytes support different uses without attaching mutable policy to a content digest. Factory supports human review and whole-set selection, binds the selected set to approved destinations, and feeds it through ordinary validation and delivery. Workers produce candidates only under the private media staging directory and may not mutate final destinations. The controller permits an existing destination only for an exact byte-identical repository-source-to-required-LFS migration at the same owned path; every other overwrite remains invalid. The target's `.gitattributes` controls LFS for any format. Factory verifies pointer assignment, exact raw bytes, upload, and fresh-clone hydration. Exact-tree Work Item and final validation first verify the committed pointer, locally restore only applicable selected required-LFS members from the content store, and verify their SHA-256 and size before command zero; missing or corrupt content fails closed without smudge or network fallback. Selected bytes are reverified after commands and clean-tree enforcement uses the controller-hydrated state as its baseline. A canonical versioned controller-capability manifest is bound into compile, graph review, and immutable plan identity so these supervisor guarantees do not become invented target work or commands. Fresh-clone hydration runs before final acceptance review and contributes an exact integrated-commit/tree/member receipt to both review evidence and the atomic snapshot. The public PNG gate is one example; the core capture and delivery path also handles opaque 3D, audio, video, and other files.

## Resource admission and completion opportunity

Both delivery paths share phase admission over the existing atomic WorkState. Item path and named-resource ownership lasts across coding, validation, independent review and delivery; coding capacity is released after collection settles. Each effect reserves its configured phase before starting. A completed phase transfers its reservation before waiting for the next, so a concurrency-one run can review and finish its own worker result. Unknown effects retain their reservation and existing replay refusal.

Accepted pending priority uses larger integer values first (zero when unspecified), then prerequisite work within that priority, then stable graph order. Dependencies, accepted authority and ownership remain eligibility gates. Ready QA and waiting review receive the next suitable completion opportunity before new coding grants; this is not a wall-clock or preemption promise. Pending reprioritization uses the accepted graph-amendment boundary; running attempts retain their identities. Read-only aggregate/QA nodes reserve validation/review capacity and never a coding slot.

Optional installation `scheduling` declares total `cpu` and `memoryMiB`, `reviewConcurrency` and `validationConcurrency`, and per-phase `phases.coding`, `phases.validation`, `phases.review`, `phases.delivery` CPU/memory reservations. A binding total requires a fitting declaration for every phase; an absent reservation is unknown, not zero. These are operator admission reservations, not OS quotas or adaptive measurements. The execution concurrency and admitted maximum bound coding; the driver's `availableSlots` is already remaining capacity and is never reduced a second time. Unknown driver capacity stays unknown in diagnostics while the operator ceiling remains enforced. Existing absolute Objective deadlines also govern waiting phase admission.

Native preparation retains actual overlap but does not wait for every independent worker before reviewing a completed result. Publication and integration retain their established safety boundaries. Final Objective validation/review occurs after item work has settled. No separate queue, resource inventory or operational journal is introduced. Source acceptance does not qualify managed/sandbox execution; installed public overlap evidence remains #253.

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

### Trunk review checkpoint

The `v0.1.0` one-immutable-package combined disposable gate passed; [BUILD-STATUS.md](BUILD-STATUS.md) records its package digest and final integrated head. The operator-approved pre-pilot trunk closure was issues [#19–#25 and #28](https://github.com/clockgrove/factory/issues). A later audit of Clockgrove W0-001 found that its accepted base has no pnpm package or lockfile, which led to the greenfield command-authority and exact-tree receipt work in [#44](https://github.com/clockgrove/factory/issues/44) and [#64](https://github.com/clockgrove/factory/issues/64). The v0.1.7 combined gate completed [#46](https://github.com/clockgrove/factory/issues/46), [#48](https://github.com/clockgrove/factory/issues/48), and [#51](https://github.com/clockgrove/factory/issues/51); public v0.1.8 proved [#60](https://github.com/clockgrove/factory/issues/60)'s complete planning packet and deterministic zero-review activation. Public v0.1.10 then completed the fresh installed greenfield gate with canonical exact-tree receipts and authoritative per-Work-Item deltas, closing #44, #64, and [#67](https://github.com/clockgrove/factory/issues/67) without a human result override or retry. [#55](https://github.com/clockgrove/factory/issues/55) separately owns the installed BYO harness seam and second-provider proof required for overall trunk completion, not a prerequisite for the operator-approved Codex-only [#26](https://github.com/clockgrove/factory/issues/26) pilot described below; [#59](https://github.com/clockgrove/factory/issues/59) owns role-specific model defaults. The currently authorized #162/#164 profile capabilities may proceed through deterministic development and reviewed integration in a separate contributor lane. Other capability branches (including #7/#8/#9), repository cutover, and trunk-complete claims remain on hold until those gates pass; this exception does not resume release or pilot gates. A clean refactor that wires known variation-point contracts to real behavior is welcome when it reduces a concrete gap. The first-release agent interface is the CLI plus installed skills over one application layer, with no MCP prerequisite. A later MCP adapter needs a demonstrated agent-integration need and must not duplicate lifecycle logic. This public repository, including contributor instructions, fixtures, and acceptance evidence, must remain sufficient for unrelated contributors; `AGENTS.md` guides building Factory, while packaged skills guide using it.

### Operator-approved Codex-only adopter pilot

The approved [adopter execution gate](https://github.com/clockgrove/factory/issues/206), continued from historical [#26](https://github.com/clockgrove/factory/issues/26), uses the published plugin and matching CLI artifact with local Codex. Its execution-order exception allowed the bounded pilot before #55's separate installed-harness proof. #55 and PR #62 are now accepted and closed; their provider evidence retains its own exact artifact and scenario identity.

The remaining first-adopter milestone requires fresh public qualification of the selected artifact, independent terminal audit, and then actual Clockgrove acceptance on that same artifact. Earlier accepted public runs do not qualify changed bytes. See [the release checklist](RELEASE-CHECKLIST.md) for the procedure and [execution #206](https://github.com/clockgrove/factory/issues/206) / [final acceptance #207](https://github.com/clockgrove/factory/issues/207) for current acceptance. Optional-provider logins, managed execution, sandboxes, and current profile enhancements do not become prerequisites for this Codex-only pilot.

Overall trunk completion requires both the accepted installed-harness foundation and actual adopter acceptance. Contributor procedures do not grant an adopter new target, provider, source-egress, or spending authority.

## Trunk foundations and provider branches

Trunk owns the shared execution and result contracts, the atomic continuation snapshot, independent validation and delivery boundaries, and the installed harness seam and second-provider proof in [#55](https://github.com/clockgrove/factory/issues/55). These foundations let the local path use the same orchestration boundaries as later execution modes. They do not require working cloud or sandbox execution before trunk acceptance.

| Trunk foundation                                             | Branch implementation                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------- |
| `ExecutionDriver` lifecycle and exact result contract        | Managed cloud tasks and their first SDK adapter (#7)          |
| Installed `AgentHarness` selection and conformance (#55)     | Sandbox transport and lifecycle around that harness seam (#8) |
| Shared snapshot, content, validation and delivery boundaries | Daytona behind the sandbox provider boundary (#9)             |

The named contracts and configuration shapes are architectural seams, not claims of available execution. Unsupported mode selections must fail explicitly until their implementation is accepted. A scripted provider fixture proves the exercised contract; a real provider requires its own installed evidence. One provider does not establish portability across all SDKs, vendors or harness/provider combinations.

Working managed execution belongs to #7. It establishes a reusable execution mode with Copilot cloud sessions as the first concrete SDK adapter. Further cloud-session SDKs are separate capability issues behind the same driver lifecycle and result boundary. Keep SDK types, authentication, configuration and result transport inside adapters; extract shared machinery only when concrete implementations demonstrate a need.

Working sandbox execution belongs to #8. One `SandboxExecutionDriver` composes a `SandboxProvider` for infrastructure with the configured `AgentHarness` for agent behavior. #9 depends on #8 and adds Daytona as the first concrete provider. Later sandbox vendors are sibling adapter capabilities depending on #8, not on Daytona. Do not create a driver for every vendor/harness pairing. #7 is not a technical dependency of #8 or #9; the planned delivery order remains managed execution, sandbox execution, then Daytona.

A branch may change shared code to satisfy its accepted behavior without becoming a trunk prerequisite. Move a correction earlier only when a demonstrated current trunk requirement needs it. Do not add speculative registries, generic SDK wrappers or remote lifecycle state merely to advertise extensibility. Installation-owned execution profiles (#162) explicitly extend the former project-level single-harness selection boundary: compilation assigns each Work Item an eligible profile before independent review and projection. Selection remains within one local execution mode, one scheduler and one shared concurrency limit. The accepted graph, installation digest and durable attempt binding fix each assignment; there is no runtime ranking, automatic fallback or mid-attempt switching. Profile membership authorizes the provider to receive the whole worktree and materialized inputs, not just owned write paths. Environment preparation belongs separately to #164.

This boundary preserves the full-trunk and actual-pilot start gates and the bounded Codex-only pilot exception above. It does not expand provider spending, source-egress, target or publication authority. [Decision #157](https://github.com/clockgrove/factory/issues/157) records the approved documentation scope.

## Named branches after trunk

![Planning, harness, and execution-driver layering](architecture/execution-drivers.png)

`PlanningModel` compiles and reviews the Work Item graph. `AgentHarness` performs one Work Item under a Factory-operated local or sandbox driver. The three peer `ExecutionDriver` implementations differ in placement and lifecycle ownership: trunk's `LocalExecutionDriver` operates a local worktree; Branch 1's `ManagedExecutionDriver` submits and tracks a provider-owned agent task; Branch 2's `SandboxExecutionDriver` operates a `SandboxProvider` and invokes the configured harness inside it. An SDK name alone does not determine whether an agent is local or managed.

- [Managed cloud execution, starting with Copilot sessions, issue #7](https://github.com/clockgrove/factory/issues/7): evaluate GitHub Copilot SDK [cloud sessions](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/cloud-sessions) as the initial GitHub-hosted candidate, then implement only if its durable task, authorization, cancellation, exact-change, and result semantics fit the `ExecutionDriver` contract. Copilot SDK local CLI/runtime mode is not a managed task. Persist provider identity, observe/cancel/collect, and feed unchanged validation and delivery. Prove the same disposable Objective with this driver.
- [Configured harnesses in Factory-managed sandboxes, issue #8](https://github.com/clockgrove/factory/issues/8): using the accepted #55 harness foundation, compose `SandboxProvider` with that installed harness seam. Prove transfer, execution, observation, cancellation, collection, and destruction with a provider-neutral fixture; do not redefine BYO harness installation or configuration in this branch.
- [Daytona sandbox provider, issue #9](https://github.com/clockgrove/factory/issues/9): add the first concrete provider behind `SandboxExecutionDriver` and run the Branch 2 scenario unchanged. Keep Daytona details within its adapter.

## Test reset and representative gates

Archived tests, fixtures, snapshots, transcripts, generated evidence, and coverage targets are not copied. Tests are written from current acceptance. Use real temporary Git repositories, commits, worktrees, processes, and files; a scripted harness; and a small stateful GitHub gateway fake at domain operations. Unit tests focus on dense DAG, path/resource, chain, digest, pointer, and descriptor logic. Live SDK/GitHub runs are release-candidate smokes, not a broad qualification system.

`npm ci && npm run build && npm run typecheck && npm run lint && npm run format:check && npm test && npm pack --dry-run` is the local gate. The [Quality workflow](../.github/workflows/quality.yml) runs this gate on pull requests and main without credentials; live GitHub and Codex gates are recorded separately. For GitHub delivery, create a disposable repository you control from [the target fixture](../test/fixtures/disposable-target/), create an Objective using a checked-in template, install the packed tarball in an isolated prefix, and record issue/PR identities, validated tree, and integrated head. Never point Factory at this repository. The [README](../README.md) has the current install command; [BUILD-STATUS.md](BUILD-STATUS.md) identifies the accepted live evidence.

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
