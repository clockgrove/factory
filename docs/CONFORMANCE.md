# Factory verification status

Date: 2026-09-04

This file distinguishes release evidence from implemented adapters. An adapter existing in the
bundle is not, by itself, a support claim.

The scope is defined in [`DESIGN.md`](DESIGN.md). This document records tested behavior and the
checks still required before publication. Tasks are organized in the [delivery plan](DELIVERY-PLAN.md).

## Proven on this branch

The first installed multi-wave Objective escalated during compilation before creating Work Items.
Its [failure record](release-evidence/local-objective-failure-2026-09-04.json) preserves the rejected
acceptance check and unavailable historical model usage. It closes no live gate; missing token
receipts are not evidence of zero consumption.

The [same-Objective retry](release-evidence/local-objective-stream-failure-2026-09-04.json) exposed
incorrect selection of an intermediate agent message as structured output. Failed-call accounting
did persist 29,407 model tokens in GitHub this time. This is live evidence for that accounting path,
not successful compilation or execution.

The [next retry](release-evidence/local-objective-command-failure-2026-09-04.json) reached command
grounding and escalated before graph projection, recording 15,125 model tokens. The fixed npm-alias
discovery list cannot express the fixture's scoped use of its observed test runner. This remains a
failed Objective, not a passed compilation gate.

The subsequent installed WSL2 run on candidate `3e64d41` compiled three native Work Items, admitted
two SDK workers with overlapping attempt lifecycles, independently validated both artifacts, and
published two PRs. Integration escalated on an external automatic review check whose integration
could not access the now-private repository. No PR was merged and the dependent join did not run.
Observed model usage was 157,125 tokens across compilation, two workers, and two reviews; the
150,000-token policy is a stop-before-next-call threshold, not an in-flight hard cap. Raw private
issues, diffs, and job logs are retained outside this public repository. These partial results do not
close the environment, scheduling, native-stack, or Objective E2E gates below.

A subsequent installed local-only qualification compiled three Work Items and completed two
independent worker/validation/review pipelines. Their recorded attempt lifecycles overlapped for
41 seconds; that is not a measurement of physical CPU or model-session concurrency. One sibling
merged, then integration of the other escalated because trunk no longer matched its original base.
The dependent join did not execute. Observed usage was 196,220 model tokens against a 250,000-token
stop threshold, so this failure was not budget exhaustion. The run remains terminal and its
controller was stopped; no replacement run or extra allowance was created to bypass that history.

`test/parallel-sibling-integration.test.ts` now exercises the real Supervisor with local Git and
simulated GitHub/management responses: sequential integration of two independently published
siblings, unchanged PR heads, fresh combined-tree validation, immutable candidate/review reuse
after merge-response loss and lease takeover, repair of a missing integration receipt, stale
test-merge metadata, wrong test-merge trees, external trunk changes, failed tests, rejected semantic
review, and unknown validator cleanup. The candidate proof/checkpoint, publication, review, and
capacity suites cover their lower-level binding and durability contracts. These are offline
component results, not a completed installed Objective, live native stack, or dependent-join gate.
The [component verification record](release-evidence/parallel-sibling-integration-component-2026-09-05.json)
binds the source commit, full release-suite result, exact local package, and freshly reinstalled
CLI/MCP entry points. The historical qualification remains escalated; installation did not revive it.

A [live native-stack API component test](release-evidence/native-stack-component-2026-09-05.json)
created and extended a three-layer stack, replayed deliberately lost success responses without
duplicate writes, merged the lower layers, observed the remaining layer's cascading rebase with
its complete tree preserved, and merged that final layer. All disposable refs were removed; an
independent read-only check confirmed three closed/merged PRs and an unchanged default branch.
This used direct API adapters and no models, not an installed Supervisor. Merge-queue behavior,
fallback, and Factory's cascading independent validation/review remain live qualification work.

| Surface | Evidence | Status |
|---|---|---|
| GitHub custom control refs | Live custom-ref, metadata-commit, workflow-side-effect, and GraphQL compare-and-swap probes against `clockgrove/factory` | Passed |
| Codex CLI management call | Live nested ephemeral call with JSONL and strict output schema on Codex CLI 0.153.0 | Passed |
| Codex SDK local worker contract | Official SDK client, exact-SHA worktree, isolated Codex home, sanitized environment, no-prompt sandboxing, Work-Packet-derived network rules, bounded streamed output, cancellation, usage normalization, artifact collection, and cleanup | Passed in deterministic SDK contract tests; installed live Objective is part of the environment/adversarial gates below |
| Codex CLI local fallback | Exact-SHA worktree, sanitized environment, no-prompt sandboxing, disabled web search, Work-Packet-derived network proxy rules, bounded output, process-group cancellation, artifact collection, and independent fresh-checkout validation tests | Passed |
| Protocol and recovery mechanics | Unit/fault fixtures for leases, reservations, partial graph writes, state derivation, budget reconciliation, stale-base integration, cancellation, and provider-neutral artifacts | Passed |
| Adaptive scheduling mechanics | Deterministic stable-ID priority and DAG fixtures; cgroup v1/v2 and WSL-host sampling; repository/per-Objective capacity CAS; complete local-first/burst admission matrices; continuous refill, fairness, restart reconstruction, and validator native-budget tests | Passed in the full release suite |
| Provider-neutral delivery mechanics | Deterministic sibling/linear/fork/join topology; observed capability selection; exact-head evidence; partial branch/PR/receipt recovery; descendant invalidation; asynchronous merge/queue resume; and reversible integration-lease fixtures | Passed in automated tests; live native-stack behavior remains gated below |
| Explainability, replay, and economics | Stable explanation-code fixtures; bounded status rendering; durable receipt replay; pure credential-free admission replay; tamper detection; distinct-call model-token reconstruction; stop-before-next-call exhaustion; model-profile routing; time-saved burst gating; and observed/unavailable cost accounting | Passed in automated tests |
| Installed plugin shape | Manifest, version, executable, skill, schema, asset, public-marketplace, no-lifecycle-script, standalone bundle, and credential-free startup checks | Passed in staged clean-home Codex installation and both official skill/plugin validators; published-artifact installation remains a separate gate |
| npm package shape | Package allowlist, `factory` executable, exported contract, install-time behavior, and clean `npm`/`npx` startup | Passed in reproducible local packing and clean tarball installation; registry installation and publication provenance remain unverified until publication |
| GitHub managed agents | Provider-neutral managed-session contract, exact-head collection, independent validation, and bounded session accounting | The Copilot adapter and Codex release profile are implemented. Codex discovery remains deliberately unavailable until live evidence records a stable provider-published identity; live runs for both remain release gates. Managed sessions may consume GitHub Actions minutes, but Factory installs no scheduler workflow. |
| Security boundaries | Scope/base/digest checks, suspected-secret rejection, validation-command restrictions, branch-rule fail-closed behavior, repository-identity checks, Factory-controlled worker credential stripping, and exact local/Daytona approval/network argument tests | Passed; provider-controlled managed-agent credential and egress behavior remains gated below |

Detailed live control-plane and CLI observations are recorded in
[`decisions/0001-v2-control-protocol.md`](decisions/0001-v2-control-protocol.md). Exact graph recovery
and the boundary around replanning are recorded in
[`decisions/0002-immutable-graph-recovery.md`](decisions/0002-immutable-graph-recovery.md).

A [WSL cgroup component observation](release-evidence/wsl-cgroup-component-2026-09-04.json)
measured the real sampler inside a transient systemd service capped at one CPU and 256 MiB.
Both ceilings were observed and the unit was automatically collected. This is partial host evidence,
not completion of the Linux environment or live adaptive scheduling gates.

A [local resource component observation](release-evidence/local-resource-observation-component-2026-09-04.json)
detected a synthetic owned worker and observed its graceful exit. Post-exit absence remained unknown:
three same-owner processes denied environment inspection. The observer retained that uncertainty;
this is not a passed cleanup or successor-execution gate. More precise independently persisted
resource ownership is still needed to avoid depending on readability of unrelated processes.

## Definition-of-done evidence map

Terminal-run continuation remains an open qualification gate: ordinary resume/retry cannot revive
an escalated run. The branch now has explicit successor requests and a controller adoption path;
installed execution and complete delivery-lineage coverage remain outstanding. The
[successor recovery plan](TERMINAL-RECOVERY-IMPLEMENTATION-PLAN.md) covers explicit authority,
cumulative accounting, resource reconciliation, and reuse of validated publications. A startup
guard blocks implicit reuse of executed work; it is containment, not a passed recovery gate.
The read-only `factory_recovery_plan` assessment inspects graph, reservation, publication, and
accounting evidence through a read-only store capability. Historical usage is not new spending
authority, and an observed terminal resource receipt does not prove host/provider cleanup.
Recovery-plan persistence, source-history/allowance-chain verification, authenticated successor
request bindings, cross-run receipt-write fences, immutable pending claims, exact adoption-receipt
replay inspection, and read-only source-evidence resolution have deterministic fixtures.
`factory_recovery_propose` is read-only; `factory_recovery_request` binds explicit authority to its
exact plan without inferring extra allowance. Controller discovery and the Supervisor require that
identity and verified adoption. Offline `test/successor-supervisor.test.ts` covers an existing
publication, independently validated combined-tree integration, response-loss replay, and execution
of its dependent join through Objective completion. These fixtures use real Git with simulated
GitHub and management responses, not live installed agents.

New Linux execution/validation reservations bind command scopes and their producer generation.
`test/controller-retirement.test.ts` includes a real no-model, opt-in systemd probe for controlled
retirement and prevention of a repeated restart. Absence is independently rechecked after restart;
legacy unbound resources, changed hosts, and incomplete observations still block. Repeated-successor
delivery lineage, multi-member native-stack restoration, provider cleanup, and installed recovery
qualification remain open. An observed completion receipt or a descriptive next-event candidate
cannot authorize a worker. These component results do not pass the live recovery gate.

This table maps every stable contract statement in [`DESIGN.md`](DESIGN.md#definition-of-done) to
the executable evidence required on a release branch. “Implemented” does not promote an open live
gate into a platform or paid-provider support claim.

| Contract | Executable evidence | Release-branch result |
|---|---|---|
| DOD-1 — Portable installation | `test/auth.test.ts`, `test/repository-controller.test.ts`, `test/systemd-service.test.ts`, `test/manifest-consistency.test.ts`, `test/package-install.test.ts`, `test/cli-interface.test.ts`, `scripts/verify-plugin-install.mjs`, `scripts/verify-package.mjs`, `scripts/verify-npm-package.mjs` | Staged plugin and npm-tarball verification passed; published-artifact and live-host installation gates remain open |
| DOD-2 — GitHub-only durable control | `test/v2-control.test.ts`, `test/v2-protocol.test.ts`, `test/v2-state.test.ts`, `test/authenticated-events.test.ts`, `test/durable-commands.test.ts`, `test/supervisor-commands.test.ts`, `test/github-reader-history.test.ts`, `test/application-services.test.ts`, `test/repository-controller.test.ts`, `test/control-surface.test.ts`, plus the package verifier's no-workflow check | Implemented; authenticated atomic comment requests, centralized semantic request-ID deduplication, at-least-once replay tolerance, single-controller fencing, and the no-workflow boundary have deterministic coverage |
| DOD-3 — Objective compilation and activation | `test/compiler-pipeline.test.ts`, `test/compiled-graph.test.ts`, `test/compilation-durability.test.ts`, `test/graph.test.ts`, `test/application-services.test.ts`, `test/control-surface.test.ts` | Implemented and deterministic/fault-injection fixtures pass |
| DOD-4 — Adaptive local-first execution | `test/admission.test.ts`, `test/capacity-ledger.test.ts`, `test/resource-sampler.test.ts`, `test/scheduling-priority.test.ts`, `test/local-runtime.test.ts`, `test/codex-sdk-backend.test.ts`, `test/codex-cli-backend.test.ts` | Implemented; broad live-host matrix remains gated below |
| DOD-5 — Explicit bounded cloud burst | `test/admission.test.ts`, `test/budget.test.ts`, `test/economics.test.ts`, `test/backend-conformance.test.ts`, `test/daytona-backend.test.ts`, `test/github-managed.test.ts`, `test/sandbox-contract.test.ts`, `test/supervisor-preflight.test.ts` | Implemented with fake/credential-free adapters; paid-provider runs remain gated below |
| DOD-6 — Durable recovery | `test/repository-controller-faults.test.ts`, `test/compilation-durability.test.ts`, `test/review-durability.test.ts`, `test/scheduling-recovery.test.ts`, `test/session-recovery.test.ts`, `test/integration-recovery.test.ts`, `test/publication.test.ts` | Implemented and injected-fault fixtures pass |
| DOD-7 — Evidence-bound delivery | `test/validation.test.ts`, `test/exact-head-validation.test.ts`, `test/delivery-topology.test.ts`, `test/stack-publication.test.ts`, `test/integration-recovery.test.ts`, `test/checks.test.ts`, `test/merge-candidate.test.ts`, `test/merge-candidates.test.ts`, `test/parallel-sibling-integration.test.ts` | Implemented; combined-tree sibling integration has offline Supervisor coverage; installed Objective and live native-stack matrix remain gated below |
| DOD-8 — Explainable, replayable economics | `test/status-output.test.ts`, `test/explanations.test.ts`, `test/replay.test.ts`, `test/economics.test.ts`, `test/model-economics.test.ts`, `test/budget.test.ts`, `test/admission.test.ts`, installed MCP surface verification | Implemented and read-only contract verified; model tokens are an observed stop threshold with documented one-call overshoot, not a provider hard cap |
| DOD-9 — Evidenced human boundaries | `test/approval.test.ts`, `test/branch-policy.test.ts`, `test/supervisor-preflight.test.ts`, `test/budget.test.ts`, `test/explanations.test.ts`, `test/execution-contract.test.ts` | Implemented and fail-closed fixtures pass |

The release command is `npm run verify:release`: typecheck, lint, formatting, coverage, schema,
deterministic bundle, clean plugin/npm package, and production dependency-audit gates. Recovery of
existing recorded runs is covered by
`test/fixtures/legacy-run-policy.json`, `test/policy.test.ts`, `test/dispatch.test.ts`,
`test/state.test.ts`, `test/v2-protocol.test.ts`, `test/v2-state.test.ts`, and the active-run history
fixtures in `test/github-reader-history.test.ts`.

## Verification required before publication

| Gate | Status | Evidence or open reason |
|---|---|---|
| Linux environment matrix | Open | Run the default Codex SDK route and Codex CLI fallback with adaptive scheduling, pressure, cancellation, restart, service install/uninstall, and clean validation on native Linux, Windows WSL2, and a Linux guest hosted by macOS. Native Win32 and Darwin are not part of this gate. |
| Live adaptive scheduling matrix | Open | The deterministic scheduler and recovery mechanics are implemented, but native sub-issue/field edits, constrained cgroups, process kills in every phase, two-Director races, and paid burst still need the disposable-repository/live-host matrix in [`ADAPTIVE-SCHEDULING-IMPLEMENTATION-PLAN.md`](ADAPTIVE-SCHEDULING-IMPLEMENTATION-PLAN.md). |
| Live native-stack matrix | Open | [Live API component evidence](release-evidence/native-stack-component-2026-09-05.json) covers create/extend response-loss replay, partial direct merge, cascading rebase/tree preservation, final merge, and cleanup. Installed Supervisor recovery, cascading exact-head validation/review, merge-queue ejection, and regular-PR fallback still need live evidence. |
| Real Daytona Objective | Open | Credential-free full-Supervisor tests prove local/Daytona independent-sibling overlap, both integration orders, isolated merge-candidate validation, native accounting restart, and cleanup fail-closed behavior. The opt-in installed runner is described in [provider qualification](PROVIDER-QUALIFICATION.md). Paid creation, TTL, egress, secret brokerage and actual leak cleanup remain unexercised. The linear-stack Daytona cascading validation/publication path is implemented but its new runtime fixture and fault matrix remain unexecuted pending the implementation testing batch. |
| Two real managed-agent Objectives | Open | Credential-free full-Supervisor scenarios cover three-item Objectives for each simulated profile without fallback. The [installed runner](PROVIDER-QUALIFICATION.md) preserves the missing stable Codex actor identity gate and reports Copilot orchestration separately from unqualified session absence/billing. Real capability discovery, provider Actions-minute billing, exact-head collection, independent validation, cancellation/recovery, credential/egress behavior and no fallback remain required. Existing single-provider backend smokes do not satisfy this gate. |
| Objective-level adversarial E2E | Open | Run a disposable multi-wave Objective through compile, parallel local execution, independent validation, integration, restart recovery, cancellation, failed checks, conflict, budget exhaustion, and final closure. Destructive failure injection belongs in a disposable repository, not `main`. |

Publication requires the checks above to pass. Implemented adapters alone do not establish
end-to-end readiness.

`scripts/verify-publish-readiness.mjs` treats this table as release state, not prose. Each required
gate must occur exactly once and say `Passed`. A passed row must link a checked-in
`docs/release-evidence/*.json` schema-2 record using a relative link such as
`[record](release-evidence/linux.json)`. Each record binds the tested Git commit, commands, required
bundle/package subjects, and evidence artifacts by SHA-256. The tested commit must be an ancestor of
the final release commit, and their trees may differ only in this ledger and
`docs/release-evidence/`. This permits committing evidence after its run without asking a record to
contain its own commit hash. Any other source, bundle, manifest, or documentation change invalidates
the evidence. The final clean, tagged checkout is separately packed and verified; its tarball can
include the newly committed evidence documentation. See the concrete sequence and record format in
[`DELIVERY-PLAN.md`](DELIVERY-PLAN.md#recording-evidence-and-publishing).

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

Vercel Sandbox, Codex App Server, and harness-native child workers are Labs integrations. Their
deterministic tests should remain green, but missing credentials, host capabilities, or live-provider
evidence do not block the initial delivery scope. If a paid Labs provider is exercised, it requires the same
explicit authorization and cleanup boundary as a release provider.

## Product-plan implementation status

[`INDIE-FACTORY-IMPLEMENTATION-PLAN.md`](INDIE-FACTORY-IMPLEMENTATION-PLAN.md) records the accepted
product plan and implementation sequence. Its core repository controller, agent-chat/MCP control,
cost-aware compiler, adaptive single-host scheduler, bounded cloud burst, durable session contract,
provider-neutral delivery state machines, replay/economics surfaces, and staged clean-install
verification are implemented. The release-finalization and live gates above remain open.
