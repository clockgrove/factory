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

## Definition-of-done evidence map

Terminal-run continuation remains an implementation gap: ordinary resume/retry cannot revive an
escalated run, and a fresh run cannot yet adopt its execution evidence. The
[successor recovery plan](TERMINAL-RECOVERY-IMPLEMENTATION-PLAN.md) covers explicit authority,
cumulative accounting, resource reconciliation, and reuse of validated publications. A startup
guard blocks implicit reuse of executed work; it is containment, not a passed recovery gate.

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
| DOD-7 — Evidence-bound delivery | `test/validation.test.ts`, `test/exact-head-validation.test.ts`, `test/delivery-topology.test.ts`, `test/stack-publication.test.ts`, `test/integration-recovery.test.ts`, `test/checks.test.ts` | Implemented; live native-stack matrix remains gated below |
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
| Live native-stack matrix | Open | The versioned adapter and recovery state machines are implemented, but stack create/extend, lower-head cascading rebase, exact-head invalidation, asynchronous merge, merge-queue ejection, partial completion, and regular-PR fallback still need disposable-repository evidence. |
| Real Daytona Objective | Open | No Daytona credentials are configured on the release host. The SDK adapter and fake sandbox contract are tested, but paid resource creation, TTL, egress, secret brokerage, host publication, and leak cleanup still need one real run. |
| Two real managed-agent Objectives | Open | Record a stable provider-published Codex actor identity, then run the same bounded Work Item through GitHub Copilot and OpenAI Codex. Verify capability discovery, Factory session accounting and the provider's GitHub Actions-minute billing boundary, exact-head collection, independent validation, cancellation/recovery behavior, provider-controlled credential/egress behavior, and absence of implicit provider fallback. `test/github-managed-live.test.ts` is deliberately only a single-provider backend-plus-Daytona-validator smoke; it cannot satisfy this full Supervisor-level gate. |
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
