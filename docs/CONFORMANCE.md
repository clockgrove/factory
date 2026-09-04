# Factory v2 conformance status

Date: 2026-09-04

This file distinguishes release evidence from implemented adapters. An adapter existing in the
bundle is not, by itself, a support claim.

## Proven on this branch

| Surface | Evidence | Status |
|---|---|---|
| GitHub custom control refs | Live custom-ref, metadata-commit, workflow-side-effect, and GraphQL compare-and-swap probes against `clockgrove/factory` | Passed |
| Codex CLI management call | Live nested ephemeral call with JSONL and strict output schema on Codex CLI 0.153.0 | Passed |
| Codex CLI local worker contract | Exact-SHA worktree, sanitized environment, no-prompt sandboxing, disabled web search, Work-Packet-derived network proxy rules, bounded output, process-group cancellation, artifact collection, and independent fresh-checkout validation tests | Passed |
| Protocol and recovery mechanics | Unit/fault fixtures for leases, reservations, partial graph writes, state derivation, budget reconciliation, stale-base integration, cancellation, and provider-neutral artifacts | Passed |
| Adaptive scheduling mechanics | Deterministic stable-ID priority and DAG fixtures; cgroup v1/v2 and WSL-host sampling; repository/per-Objective capacity CAS; complete local-first/burst admission matrices; continuous refill, fairness, restart reconstruction, and validator native-budget tests | Passed in the full release suite |
| Provider-neutral delivery mechanics | Deterministic sibling/linear/fork/join topology; observed capability selection; exact-head evidence; partial branch/PR/receipt recovery; descendant invalidation; asynchronous merge/queue resume; and reversible integration-lease fixtures | Passed in automated tests; live native-stack behavior remains gated below |
| Explainability, replay, and economics | Stable explanation-code fixtures; bounded status rendering; durable receipt replay; pure credential-free admission replay; tamper detection; and observed/unavailable cost accounting | Passed in automated tests |
| Installed package shape | Manifest, version, executable, skill, schema, asset, public-marketplace, no-lifecycle-script, standalone bundle, and credential-free startup checks | Passed through an isolated clean Codex home; both staged-package executables start without worktree configuration |
| Security boundaries | Scope/base/digest checks, suspected-secret rejection, validation-command restrictions, branch-rule fail-closed behavior, repository-identity checks, worker credential stripping, and exact Codex approval/network argument tests | Passed |

Detailed live control-plane and CLI observations are recorded in
[`decisions/0001-v2-control-protocol.md`](decisions/0001-v2-control-protocol.md). Exact graph recovery
and the boundary around replanning are recorded in
[`decisions/0002-immutable-graph-recovery.md`](decisions/0002-immutable-graph-recovery.md).

## Definition-of-done evidence map

This table maps every stable contract statement in [`DESIGN.md`](DESIGN.md#definition-of-done) to
the executable evidence required on a release branch. “Implemented” does not promote an open live
gate into a platform or paid-provider support claim.

| Contract | Executable evidence | Release-branch result |
|---|---|---|
| DOD-1 — Portable installation | `test/auth.test.ts`, `test/repository-controller.test.ts`, `test/systemd-service.test.ts`, `test/manifest-consistency.test.ts`, `test/package-install.test.ts`, `scripts/verify-plugin-install.mjs`, `scripts/verify-package.mjs` | Implemented and package-verified |
| DOD-2 — GitHub-only durable control | `test/v2-control.test.ts`, `test/v2-protocol.test.ts`, `test/v2-state.test.ts`, `test/github-reader-history.test.ts`, `test/control-surface.test.ts`, plus the package verifier's no-workflow check | Implemented; no Factory Action or hosted control dependency ships |
| DOD-3 — Objective compilation and activation | `test/compiler-pipeline.test.ts`, `test/compiled-graph.test.ts`, `test/graph.test.ts`, `test/application-services.test.ts`, `test/control-surface.test.ts` | Implemented and deterministic fixtures pass |
| DOD-4 — Adaptive local-first execution | `test/admission.test.ts`, `test/capacity-ledger.test.ts`, `test/resource-sampler.test.ts`, `test/scheduling-priority.test.ts`, `test/local-runtime.test.ts`, `test/codex-cli-backend.test.ts` | Implemented; broad live-host matrix remains gated below |
| DOD-5 — Explicit bounded cloud burst | `test/admission.test.ts`, `test/budget.test.ts`, `test/economics.test.ts`, `test/backend-conformance.test.ts`, `test/sandbox-contract.test.ts`, `test/supervisor-preflight.test.ts` | Implemented with fake/credential-free adapters; paid-provider runs remain gated below |
| DOD-6 — Durable recovery | `test/repository-controller-faults.test.ts`, `test/scheduling-recovery.test.ts`, `test/session-recovery.test.ts`, `test/integration-recovery.test.ts`, `test/publication.test.ts` | Implemented and injected-fault fixtures pass |
| DOD-7 — Evidence-bound delivery | `test/validation.test.ts`, `test/exact-head-validation.test.ts`, `test/delivery-topology.test.ts`, `test/stack-publication.test.ts`, `test/integration-recovery.test.ts`, `test/checks.test.ts` | Implemented; live native-stack matrix remains gated below |
| DOD-8 — Explainable, replayable economics | `test/status-output.test.ts`, `test/explanations.test.ts`, `test/replay.test.ts`, `test/economics.test.ts`, installed MCP surface verification | Implemented and read-only contract verified |
| DOD-9 — Evidenced human boundaries | `test/approval.test.ts`, `test/branch-policy.test.ts`, `test/supervisor-preflight.test.ts`, `test/budget.test.ts`, `test/explanations.test.ts`, `test/execution-contract.test.ts` | Implemented and fail-closed fixtures pass |

The release command is `npm run verify:release`: typecheck, complete deterministic suite, rebuilt
package verification through a clean Codex install, and the production dependency audit. Legacy
`clockgrove.factory/v1` and early-v2 recovery remain covered by
`test/fixtures/legacy-run-policy.json`, `test/policy.test.ts`, `test/dispatch.test.ts`,
`test/state.test.ts`, `test/v2-protocol.test.ts`, `test/v2-state.test.ts`, and the active-run history
fixtures in `test/github-reader-history.test.ts`.

## Gates still required before a non-draft v2 release

| Gate | Why it is open |
|---|---|
| Live adaptive scheduling matrix | The deterministic scheduler and recovery mechanics are implemented, but native sub-issue/field edits, constrained cgroups, process kills in every phase, two-Director races, and paid burst still need the disposable-repository/live-host matrix in [`ADAPTIVE-SCHEDULING-IMPLEMENTATION-PLAN.md`](ADAPTIVE-SCHEDULING-IMPLEMENTATION-PLAN.md) before becoming a broad support claim. |
| Live native-stack matrix | The preview adapter and recovery state machines are implemented, but stack create/extend, lower-head cascading rebase, exact-head invalidation, asynchronous merge, merge-queue ejection, partial completion, and unstack rollback still need disposable-repository evidence before native stacks become a release support claim. |
| Real Daytona Objective | No Daytona credentials are configured on the release host. The SDK adapter and fake sandbox contract are tested, but paid resource creation, TTL, egress, secret brokerage, host publication, and leak cleanup still need one real run. |
| Real Vercel Sandbox Objective | No Vercel OIDC token or worker model credential is configured on the release host. The SDK adapter and fake sandbox contract are tested, but the real provider lifecycle still needs one run. |
| Published-artifact install | The staged package passes a clean Codex install without worktree configuration, but development changes cannot be tested as a published artifact until reviewed and published. After publication, repeat clean installation and run a private-repository Objective through the installed plugin. |
| Objective-level adversarial E2E | Run a disposable multi-wave Objective through compile, parallel local execution, independent validation, integration, restart recovery, cancellation, failed checks, conflict, budget exhaustion, and final closure. Destructive failure injection belongs in a disposable repository, not `main`. |

Until those gates pass, Factory v2 is a release candidate. The supported claim is limited to the
measured GitHub control primitives and Codex CLI on Linux/WSL; Daytona, Vercel Sandbox, native harness
workers, macOS, and Windows remain unclaimed even though some adapters or portable surfaces exist.

No paid gate may be executed or marked passed merely because credentials become available. A real
Daytona, Vercel Sandbox, or managed-agent run requires separate explicit authorization naming the
provider, target, maximum billable units, and cleanup boundary. Without that authorization, the
correct result is “unclaimed,” not “failed” and not an inferred support claim.

## Accepted product plan, not yet a support claim

[`INDIE-FACTORY-IMPLEMENTATION-PLAN.md`](INDIE-FACTORY-IMPLEMENTATION-PLAN.md) is the accepted roadmap
for the indie-developer product: one local repository controller, agent-chat/MCP control, cost-aware
compilation, adaptive single-host scheduling, bounded cloud burst, durable Codex sessions, and native
stacked pull requests. The repository controller, deterministic adaptive scheduler, and
provider-neutral delivery state machines, replay/economics surfaces, and staged clean-install
verification are implemented. The live and published-artifact gates above remain deliberately open.
Product-direction documentation must not be interpreted as release evidence.
