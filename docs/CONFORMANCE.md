# Factory conformance gates and evidence

Updated: 2026-09-06

This ledger retains exact-candidate observations and release requirements, not current project status.
[DESIGN.md](DESIGN.md#definition-of-done) defines the contract; the
[Factory Project](https://github.com/orgs/clockgrove/projects/1) links remaining work.
An adapter or passing component test does not establish broader support. The gate table remains
machine-checked release state bound to exact candidate evidence, not a general project backlog;
all six prepublication gates remain required. Dated component observations retain their original scope.

## Recorded component results

Each linked record retains its own date, exact source and artifact identities, outcome and
limitations. Later source or documentation changes do not extend an observation to a new candidate.

| Component | Recorded result and scope |
| --- | --- |
| Integrated local verification, 2026-09-05 | [Passed](release-evidence/integrated-completion-suite-2026-09-05.json) at `1e605d2fba58c9134b9e90e1b516a58bedb42424`, including deterministic bundles and staged plugin/npm installation. The [original failed candidate](release-evidence/final-suite-original-failure-2026-09-05.json) remains separate. Neither is published-artifact or live-provider qualification. |
| Accounted checkpoint restart, 2026-09-06 | [Passed](release-evidence/accounted-checkpoint-restart-component-2026-09-06.json) at `d61c43640da81ed454326ff9c34e7618b03d0583`: same-run restart after accounted integration, no repeated checkpoint work, final artifact verification and exact resource cleanup. This closes only the orderly-restart component, not abrupt interruption, fallback or the full host matrix. |
| Active cancellation, 2026-09-06 | [Incomplete](release-evidence/active-cancellation-incomplete-2026-09-06.json): terminal cancellation and reserved-resource absence were observed, but interrupted worker usage is unavailable. Known management usage is not total usage; cleanup does not qualify complete cancellation accounting. |
| Retained-successor completion, 2026-09-05 | [Passed at the recorded boundaries](release-evidence/quota-safe-successor-completion-component-2026-09-05.json): adoption/delivery and proof-only final closure used distinct identified artifacts. Valid work, accounting and cleanup were independently verified. This is not a clean-history run on one candidate or a broad recovery-gate pass. |
| Direct regular delivery, 2026-09-05 | [SDK and CLI-only cases passed](release-evidence/regular-delivery-component-2026-09-05.json), including three serial pipelines, dependent join, independent validation and fresh-artifact checks. Direct CLI selection is not failure-triggered SDK fallback. |
| Local scheduling subset, 2026-09-05 | [Passed](release-evidence/local-scheduling-component-2026-09-05.json): native subissue-order admission, constrained Director CPU admission and outer repository-lease contention on that source. The current [Objective authority model](OBJECTIVE-AUTHORITY.md) retains election contention, not a repository data lock; this old result does not qualify independent Objective execution on the changed model. Broader pressure, fairness, inner Director races and other hosts remain unqualified. |
| Write-free installed planning, 2026-09-05 | [Passed](release-evidence/installed-planning-component-2026-09-05.json): one explicit compilation, verified returned graph digest and no control-plane, checkout or installation mutation. This is not activation or execution. |
| Native stack API, 2026-09-05 | [Scoped API cases passed](release-evidence/native-stack-component-2026-09-05.json), including response-loss replay, partial merge and cascading tree preservation. Direct API observations do not replace installed Supervisor validation/review, branch-rule and fallback qualification. |

## Dated evidence index

- [Trunk contracts: integrated checks, original failures and matching WSL installation](release-evidence/trunk-contracts-2026-09-06.json). This is implementation acceptance, not a model-backed or economic qualification pass.

These records preserve both successful observations and failures. A filename or an implementation
correction is not a passed gate. Consult each record for its exact source, artifact digests,
measurement scope and outcome; private raw evidence is not a public reproduction procedure.
Public records may be normalized to remove private details. Their historical outcomes and tested
artifact identities are preserved, while exact original records remain private. Normalization or a
later fix does not turn an earlier failure into a pass.

- [accounted checkpoint restart component 2026 09 06](release-evidence/accounted-checkpoint-restart-component-2026-09-06.json)
- [active cancellation incomplete 2026 09 06](release-evidence/active-cancellation-incomplete-2026-09-06.json)
- [completion batch component 2026 09 05](release-evidence/completion-batch-component-2026-09-05.json)
- [final suite original failure 2026 09 05](release-evidence/final-suite-original-failure-2026-09-05.json)
- [foreground recovery candidate component 2026 09 05](release-evidence/foreground-recovery-candidate-component-2026-09-05.json)
- [installed local component 2026 09 05](release-evidence/installed-local-component-2026-09-05.json)
- [installed planning component 2026 09 05](release-evidence/installed-planning-component-2026-09-05.json)
- [integrated completion suite 2026 09 05](release-evidence/integrated-completion-suite-2026-09-05.json)
- [local keyfree finalization component 2026 09 05](release-evidence/local-keyfree-finalization-component-2026-09-05.json)
- [local lifecycle component 2026 09 05](release-evidence/local-lifecycle-component-2026-09-05.json)
- [local objective command failure 2026 09 04](release-evidence/local-objective-command-failure-2026-09-04.json)
- [local objective failure 2026 09 04](release-evidence/local-objective-failure-2026-09-04.json)
- [local objective stream failure 2026 09 04](release-evidence/local-objective-stream-failure-2026-09-04.json)
- [local resource observation component 2026 09 04](release-evidence/local-resource-observation-component-2026-09-04.json)
- [local scheduling component 2026 09 05](release-evidence/local-scheduling-component-2026-09-05.json)
- [native refresh release component 2026 09 05](release-evidence/native-refresh-release-component-2026-09-05.json)
- [native stack component 2026 09 05](release-evidence/native-stack-component-2026-09-05.json)
- [parallel sibling integration component 2026 09 05](release-evidence/parallel-sibling-integration-component-2026-09-05.json)
- [publication recovery candidate component 2026 09 05](release-evidence/publication-recovery-candidate-component-2026-09-05.json)
- [quota safe successor completion component 2026 09 05](release-evidence/quota-safe-successor-completion-component-2026-09-05.json)
- [recovery discovery component 2026 09 05](release-evidence/recovery-discovery-component-2026-09-05.json)
- [recovery foreground resource component 2026 09 05](release-evidence/recovery-foreground-resource-component-2026-09-05.json)
- [recovery quota closure component 2026 09 05](release-evidence/recovery-quota-closure-component-2026-09-05.json)
- [regular delivery component 2026 09 05](release-evidence/regular-delivery-component-2026-09-05.json)
- [regular delivery failure 2026 09 05](release-evidence/regular-delivery-failure-2026-09-05.json)
- [sibling branch cas component 2026 09 05](release-evidence/sibling-branch-cas-component-2026-09-05.json)
- [wsl cgroup component 2026 09 04](release-evidence/wsl-cgroup-component-2026-09-04.json)

## Definition-of-done evidence map

Recovery requires authenticated source and successor identity, cumulative accounting and independently
verified resource reconciliation. Ordinary retry cannot revive a terminal run. The bounded installed
successor result above complements deterministic lineage and fault coverage; it does not qualify every
restart, cancellation or provider-cleanup case. See the
[recovery contract](TERMINAL-RECOVERY-IMPLEMENTATION-PLAN.md).

This table maps every stable contract statement in [`DESIGN.md`](DESIGN.md#definition-of-done) to
the executable evidence required on a release branch. “Implemented” does not promote an open live
gate into a platform or paid-provider support claim.

| Contract | Executable evidence | Release-branch result |
|---|---|---|
| DOD-1 — Portable installation | `test/auth.test.ts`, `test/repository-controller.test.ts`, `test/systemd-service.test.ts`, `test/manifest-consistency.test.ts`, `test/package-install.test.ts`, `test/cli-interface.test.ts`, `scripts/verify-plugin-install.mjs`, `scripts/verify-package.mjs`, `scripts/verify-npm-package.mjs` | Staged plugin and npm-tarball verification passed; published-artifact and live-host installation gates remain open |
| DOD-2 — GitHub-only durable control | `test/v2-control.test.ts`, `test/v2-protocol.test.ts`, `test/v2-state.test.ts`, `test/authenticated-events.test.ts`, `test/durable-commands.test.ts`, `test/supervisor-commands.test.ts`, `test/github-reader-history.test.ts`, `test/application-services.test.ts`, `test/repository-controller.test.ts`, `test/control-surface.test.ts`, plus the package verifier's no-workflow check | Implemented; authenticated atomic comment requests, centralized semantic request-ID deduplication, at-least-once replay tolerance, single-controller fencing, and the no-workflow boundary have deterministic coverage |
| DOD-3 — Objective compilation and activation | `test/compiler-pipeline.test.ts`, `test/compiled-graph.test.ts`, `test/compilation-durability.test.ts`, `test/graph.test.ts`, `test/application-services.test.ts`, `test/control-surface.test.ts` | Implemented and deterministic/fault-injection fixtures pass |
| DOD-4 — Adaptive local-first execution | `test/admission.test.ts`, `test/capacity-ledger.test.ts`, `test/resource-sampler.test.ts`, `test/scheduling-priority.test.ts`, `test/local-runtime.test.ts`, `test/codex-sdk-backend.test.ts`, `test/codex-cli-backend.test.ts` | Implemented; broad live-host matrix remains gated below |
| DOD-5 — Explicit bounded cloud burst | `test/admission.test.ts`, `test/budget.test.ts`, `test/economics.test.ts`, `test/backend-conformance.test.ts`, `test/daytona-backend.test.ts`, `test/github-managed.test.ts`, `test/sandbox-contract.test.ts`, `test/supervisor-preflight.test.ts` | Policy, Daytona and Copilot paths implemented with credential-free coverage; managed Codex remains unavailable pending its own supported actor/lifecycle binding. Provider limitations narrow support claims, not the whole product. Paid launches still require explicit authority |
| DOD-6 — Durable recovery | `test/repository-controller-faults.test.ts`, `test/compilation-durability.test.ts`, `test/review-durability.test.ts`, `test/scheduling-recovery.test.ts`, `test/session-recovery.test.ts`, `test/integration-recovery.test.ts`, `test/publication.test.ts` | Implemented and injected-fault fixtures pass |
| DOD-7 — Evidence-bound delivery | `test/validation.test.ts`, `test/exact-head-validation.test.ts`, `test/delivery-topology.test.ts`, `test/stack-publication.test.ts`, `test/integration-recovery.test.ts`, `test/checks.test.ts`, `test/merge-candidate.test.ts`, `test/merge-candidates.test.ts`, `test/parallel-sibling-integration.test.ts` | Implemented; combined-tree sibling integration has offline Supervisor coverage; installed Objective and live native-stack matrix remain gated below |
| DOD-8 — Explainable, replayable economics | `test/status-output.test.ts`, `test/explanations.test.ts`, `test/replay.test.ts`, `test/economics.test.ts`, `test/model-economics.test.ts`, `test/budget.test.ts`, `test/admission.test.ts`, installed MCP surface verification | Budget-intent correction #136 passed integrated checks and matching installation: explicit observed-stop selection for new thresholds, unsupported hard-cap refusal, durable unknown-call fencing and distinct historical interpretation. Comparative benefit remains unproven under #109. |
| DOD-9 — Evidenced human boundaries | `test/approval.test.ts`, `test/branch-policy.test.ts`, `test/supervisor-preflight.test.ts`, `test/budget.test.ts`, `test/explanations.test.ts`, `test/execution-contract.test.ts` | Implemented and fail-closed fixtures pass |

The release command is `npm run verify:release`: a bounded Linux systemd 254+ user-manager preflight,
then typecheck, lint, formatting, coverage, schema, deterministic bundle, clean plugin/npm package,
and production dependency-audit gates. The preflight fails before broad tests when the user bus is
unreachable; it does not replace or skip the real transient-scope containment coverage. Recovery of
existing recorded runs is covered by
`test/fixtures/legacy-run-policy.json`, `test/policy.test.ts`, `test/dispatch.test.ts`,
`test/state.test.ts`, `test/v2-protocol.test.ts`, `test/v2-state.test.ts`, and the active-run history
fixtures in `test/github-reader-history.test.ts`.

The same batch covers cancellation-drain token receipts before cleanup, retention of known usage
when cleanup remains uncertain, no stale-lease accounting writes, and preservation of escalation,
cancellation or lease-release outcomes while workers drain. Unknown counters remain unavailable and
unknown resources still block replacement. These are deterministic regressions, not live fault passes.

## Release verification procedure

Maintainers coordinate qualification for an identified release candidate after implementation and
integration review. Ordinary contributor checks are described in
[CONTRIBUTING.md](../CONTRIBUTING.md#validate-changes); a routine PR is not a release candidate.

1. Freeze the source, tests, documentation, and manifests as an identified candidate.
2. Run the complete suite, fix actual failures, and retain security, destructive-action, accounting,
   and recovery coverage. Implementation blockers must be resolved before declaring code complete.
3. Build synchronized bundles and run `npm run verify:release` for the integrated checks.
4. Install the matching artifact and record its source and artifact identities.
5. Execute the required installed end-to-end cases and applicable conformance matrices under their
   separately accepted authority. All six prepublication gates below remain required.

The release gate must run directly on a supported Linux host with systemd 254 or newer and a
reachable systemd user manager. This includes the Linux side of WSL2, not a nested sandbox without
access to the user bus. To diagnose the host, run the same read-only user-manager probe used by the
preflight:

```sh
systemctl --user show --property=Version --value --no-pager
```

The preflight also checks the `systemd-run` version. Passing preflight does not replace the suite's
real transient-scope containment tests.

`verify:package` checks committed plugin manifests and skills, starts the bundled MCP server through
the manifest's command and arguments, and verifies its public tool surface. It installs a staged
copy through an isolated `CODEX_HOME` using the Codex CLI and starts the installed MCP and
repository-controller executables. It does not use the development worktree's Codex configuration
or credentials or create a paid provider resource. Staged plugin and npm checks do not establish
published-artifact installation support.

If a check fails, preserve its original result, fix the defect, and run affected checks first.
Repeat broader checks at the next stable candidate boundary. Keep evidence bound to its exact
source, artifact, and scenario; never relabel an earlier pass as proof of changed bytes. Reuse
completed work only through authorized recovery. Record unrun or blocked checks explicitly.
Simulated providers do not establish live support, and pilot evidence does not replace release gates.

Publication requires `npm run verify:release` and the applicable prepublication gates below. The
final verified tag also requires the [post-publication completion gate](#post-publication-completion-gate)
against the actual published artifact. This procedure does not grant publication or provider-spend
authority.

## Verification required before publication

| Gate | Status | Evidence or open reason |
|---|---|---|
| Linux environment matrix | Open | [Current staged WSL2 component evidence](release-evidence/local-lifecycle-component-2026-09-05.json) covers no-model installation and host-process checks only. Run the default Codex SDK route and Codex CLI fallback with adaptive scheduling, pressure, cancellation, restart, service install/uninstall, and clean validation on native Linux, Windows WSL2, and a Linux guest hosted by macOS. Native Win32 and Darwin are not part of this gate. |
| Live adaptive scheduling matrix | Open | [Installed component evidence](release-evidence/local-scheduling-component-2026-09-05.json) passes native subissue-order admission, a 0.5-to-4-CPU Director leaf barrier and outer repository-controller lease refusal on its original source. Current acceptance requires independent Objective concurrency without that data lock; service election and same-Objective contention are separate fault cases. Organization field edits, broader pressure and phase-kill recovery, inner Director races, paid burst and the remaining host matrix still require [`ADAPTIVE-SCHEDULING-IMPLEMENTATION-PLAN.md`](ADAPTIVE-SCHEDULING-IMPLEMENTATION-PLAN.md). |
| Live native-stack matrix | Open | [Live API component evidence](release-evidence/native-stack-component-2026-09-05.json) covers create/extend response-loss replay, partial direct merge, cascading rebase/tree preservation, final merge, and cleanup. Installed Supervisor recovery, cascading exact-head validation/review, ordinary branch-rule enforcement, and regular-PR fallback still need live evidence. Optional merge-queue integration and queue-ejection qualification are tracked separately as future work in [#223](https://github.com/clockgrove/factory/issues/223); required queues must not be bypassed when that integration is unavailable. |
| Real Daytona Objective | Open | Credential-free full-Supervisor tests prove local/Daytona independent-sibling overlap, both integration orders, isolated merge-candidate validation, native accounting restart, and cleanup fail-closed behavior. Sixteen native linear-stack scenarios include four fresh-controller checkpoint/review/receipt replay boundaries without duplicated sandbox, review, or accounting. The opt-in installed runner is described in [provider qualification](PROVIDER-QUALIFICATION.md). Paid creation, TTL, egress, secret brokerage and actual leak cleanup remain unexercised; simulated-provider results do not satisfy this live gate. |
| Managed-provider capability boundaries | Open | The accepted contract is provider-specific: Copilot execution needs installed exact-task/head, independent-validation, native-admission and terminal-session proof; automatic-stop limitations remain explicit human actions. Codex is currently unavailable and must refuse launch without breaking local startup, not pass as a simulated working provider. The schema-2 record binds evidence for both declarations and every supported claim. Missing credentials do not prove an unsupported interface. Final invoice settlement is not required; unknown execution and resource obligations remain fenced. [Provider qualification](PROVIDER-QUALIFICATION.md). |
| Objective-level adversarial E2E | Open | Run a disposable multi-wave Objective through compile, parallel local execution, independent validation, integration, restart recovery, cancellation, failed checks, conflict, budget exhaustion, and final closure. Destructive failure injection belongs in a disposable repository, not `main`. |

Publication requires the checks above to pass. Implemented adapters alone do not establish
end-to-end readiness.

### Prospective two-Objective concurrency allowance

The installed `scripts/verify-local-concurrency.mjs` qualifier requires explicit
`FACTORY_CONCURRENCY_MODEL` and `FACTORY_CONCURRENCY_REASONING` values before preflight. They become
one immutable run-policy profile for compile, implement, review and recovery; they do not change
Factory defaults. Final evidence distinguishes requested policy, deterministic phase resolution and
observed execution backends. Provider-returned model or reasoning values remain explicitly
unavailable when existing authenticated receipts do not contain them.

The default `throughput` scenario contains only ordinary Objective creation, activation, useful
work, symmetric freed-slot refill, completion and shutdown. It injects no delay, lease expiry,
contention, pause or restart. `FACTORY_CONCURRENCY_SCENARIO=lease-fault` selects the separately
acknowledged expiry/contention/restart scenario; neither result substitutes for the other. The
observer uses bounded repository-wide incremental comment listings while receipts are unchanged,
but those listings are wake hints only. Their canonical issue target is validated before owned issue
filtering because GitHub includes pull-request conversations in the same endpoint. Authenticated
graph or terminal changes force bounded fresh reads until child topology, receipts and terminal
status converge. Phase acceptance, subsequent mutation and final reporting always require a fresh
complete authenticated Objective/sub-issue/comment/status observation. Historical results retain
their original scenario and evidence identity.

Both scenarios accept
`FACTORY_CONCURRENCY_PER_OBJECTIVE_MAX_MODEL_TOKENS` from 250000 through 500000. Omission
retains 250000 per Objective. `FACTORY_CONCURRENCY_MAX_MODEL_TOKENS` remains an explicit
aggregate acknowledgement and must equal exactly twice that selection: the existing 500000
invocation is unchanged; an explicit 400000 per Objective requires 800000 aggregate.
Select both values before preflight and activation, only under the corresponding local spending
authority. These are observed-stop thresholds, not provider-enforced token caps or promises of
completion. Actual usage is never clamped. One attempt per Work Item, two one-worker Objectives
and the unchanged installed controller ceiling still apply.
This prospective option does not top up or rewrite any recorded run, policy, digest or failed
qualification evidence; historical continuation retains its original authority.

`FACTORY_CONCURRENCY_DURATION_MINUTES` prospectively selects an integer from 45 through 120;
omission retains 45. Select it before preflight and exercise under the corresponding local
authority. Both Objective policies bind that duration. All scenario observation, inner-lease
eligibility and final verification share one finite deadline anchored to the original scenario
start, including time spent preparing and waiting; later phases never reset it. This can accommodate
legitimate Factory pacing waits without changing pacing, token thresholds or provider authority.
A local pacer wait is not evidence of GitHub refusing writes. No new duration may extend an
already-started run or rewrite its policy, continuation or failed evidence. Other checkpoint
callers retain their original 45-minute observation window.

`scripts/verify-publish-readiness.mjs` treats this table as release state, not prose. Each required
gate must occur exactly once and say `Passed`. A passed row must link a checked-in
`docs/release-evidence/*.json` schema-2 record using a relative link such as
`[record](release-evidence/linux.json)`. Each record binds the tested Git commit, commands, required
bundle/package subjects, and evidence artifacts by SHA-256. The tested commit must be an ancestor of
the final release commit, and their trees may differ only in this ledger and
`docs/release-evidence/`. This permits committing evidence after its run without asking a record to
contain its own commit hash. Any other source, bundle, manifest, or documentation change invalidates
the evidence. Repository evidence is retained separately from the installed package. The final
clean, tagged checkout is separately packed, and that exact distribution tarball is verified against
the package allowlist and provenance. See the concrete sequence and record format in
[`DELIVERY-PLAN.md`](DELIVERY-PLAN.md#recording-evidence-and-publishing).

The `Managed-provider capability boundaries` record additionally declares both known profiles in
`managedProviders`, each with `backendId`, `availability` and a digest-bound `evidence` artifact.
The artifact records the installed probe, exact candidate, matching support declaration and
unaffected local startup. An unavailable provider needs an evidenced unsupported interface, denied
launch and no provider launch, with no supported execution claims; absent user credentials alone
do not qualify. An available provider needs digest-bound qualification for `objective-delivery` and
every other advertised capability. Unsupported capabilities carry their reason and official source.
An `objective-delivery` qualification artifact uses schema 1, kind
`installed-provider-objective-qualification`, and an `observation` containing the installed provider
runner's complete structured result. The gate re-evaluates its execution proof and binds clean
harness source, installed bundle inventory, original run/policy, exact integration/task/session
evidence, independent validator absence and final artifact output. A `passed` label alone, an
incomplete completion assessment or a different installed artifact cannot satisfy the claim.
New capability names need their own concrete assessor before they can be advertised as qualified.
All referenced artifacts remain subject to the same tracked-path, exact-commit and SHA-256 checks.
Invoice settlement is not part of this evidence contract. No existing observation is relabelled as
proof of the revised candidate or gate.

## Post-publication completion gate

Publishing the candidate makes this final check possible; it cannot be evidence for the publication
that creates the candidate.

| Gate | Required evidence |
|---|---|
| Published-artifact install | From clean environments, install the synchronized Agent Plugin and `@clockgrove/factory` npm artifacts, start each executable surface without worktree configuration, run a private-repository Objective through the installed product, and verify the published checksums and provenance. |

Delivery is not complete until this gate passes. The immutable package tag already
identifies the published candidate; never move it to add this later evidence. Record the completion
receipt in a follow-up documentation commit or release attachment, identifying that version tag,
its source commit, and the published artifact digests.

No paid gate may be executed or marked passed merely because credentials become available. A real
Daytona or managed-agent run requires separate explicit authorization naming the
provider, target, maximum billable units, and cleanup boundary. Without that authorization, the
correct result is “not exercised,” not “failed” and not an inferred support claim.

## Labs evidence

The explicit Codex App Server route is part of supported local qualification, not Labs. Its
[session acceptance](CODEX-APP-SERVER-SESSIONS.md#qualification-still-required) requires installed
fresh execution and exact same-attempt terminal recovery without another model turn, with complete
usage and independently absent resources. This evidence is pending on WSL2; component code/tests
do not substitute for it. Unsupported cold repair turns remain a documented provider boundary.

Vercel Sandbox and harness-native child workers are Labs integrations. Their
deterministic tests should remain green, but missing credentials, host capabilities, or live-provider
evidence do not block the initial delivery scope. If a paid Labs provider is exercised, it requires the same
explicit authorization and cleanup boundary as a release provider.

## Product-plan implementation status

[`INDIE-FACTORY-IMPLEMENTATION-PLAN.md`](INDIE-FACTORY-IMPLEMENTATION-PLAN.md) records the accepted
product plan and implementation sequence. Its core repository controller, agent-chat/MCP control,
cost-aware compiler, adaptive single-host scheduler, bounded cloud burst, durable session contract,
provider-neutral delivery state machines, replay/economics surfaces, and staged clean-install
verification are implemented. The release-finalization and live gates above remain open.
