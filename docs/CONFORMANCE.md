# Factory v2 conformance status

Date: 2026-09-03

This file distinguishes release evidence from implemented adapters. An adapter existing in the
bundle is not, by itself, a support claim.

## Proven on this branch

| Surface | Evidence | Status |
|---|---|---|
| GitHub custom control refs | Live custom-ref, metadata-commit, workflow-side-effect, and GraphQL compare-and-swap probes against `clockgrove/factory` | Passed |
| Codex CLI management call | Live nested ephemeral call with JSONL and strict output schema on Codex CLI 0.153.0 | Passed |
| Codex CLI local worker contract | Exact-SHA worktree, sanitized environment, no-prompt sandboxing, disabled web search, Work-Packet-derived network proxy rules, bounded output, process-group cancellation, artifact collection, and independent fresh-checkout validation tests | Passed |
| Protocol and recovery mechanics | Unit/fault fixtures for leases, reservations, partial graph writes, state derivation, budget reconciliation, stale-base integration, cancellation, and provider-neutral artifacts | Passed |
| Installed package shape | Manifest, schema, skill, bundled-SDK, no-lifecycle-script, and standalone credential-free MCP startup checks | Passed from the source checkout |
| Security boundaries | Scope/base/digest checks, suspected-secret rejection, validation-command restrictions, branch-rule fail-closed behavior, repository-identity checks, worker credential stripping, and exact Codex approval/network argument tests | Passed |

Detailed live control-plane and CLI observations are recorded in
[`decisions/0001-v2-control-protocol.md`](decisions/0001-v2-control-protocol.md). Exact graph recovery
and the boundary around replanning are recorded in
[`decisions/0002-immutable-graph-recovery.md`](decisions/0002-immutable-graph-recovery.md).

## Gates still required before a non-draft v2 release

| Gate | Why it is open |
|---|---|
| Adaptive priority and burst scheduling | The implementation-ready plan exists, but the current Supervisor still takes a fixed `maxParallel` slice, does not ingest GitHub issue priority, and does not measure Linux/WSL CPU or memory for admission. The protocol, scheduler, recovery, provider, and live-host gates in [`ADAPTIVE-SCHEDULING-IMPLEMENTATION-PLAN.md`](ADAPTIVE-SCHEDULING-IMPLEMENTATION-PLAN.md) must pass before this is a support claim. |
| Real Daytona Objective | No Daytona credentials are configured on the release host. The SDK adapter and fake sandbox contract are tested, but paid resource creation, TTL, egress, secret brokerage, host publication, and leak cleanup still need one real run. |
| Real Vercel Sandbox Objective | No Vercel OIDC token or worker model credential is configured on the release host. The SDK adapter and fake sandbox contract are tested, but the real provider lifecycle still needs one run. |
| Published-artifact install | Plugin development changes cannot be installed as the released artifact until they are reviewed and published. After publication, repeat package verification from a clean install and run a private-repository Objective through the installed plugin. |
| Objective-level adversarial E2E | Run a disposable multi-wave Objective through compile, parallel local execution, independent validation, integration, restart recovery, cancellation, failed checks, conflict, budget exhaustion, and final closure. Destructive failure injection belongs in a disposable repository, not `main`. |

Until those gates pass, Factory v2 is a release candidate. The supported claim is limited to the
measured GitHub control primitives and Codex CLI on Linux/WSL; Daytona, Vercel Sandbox, native harness
workers, macOS, and Windows remain unclaimed even though some adapters or portable surfaces exist.

## Accepted product plan, not yet a support claim

[`INDIE-FACTORY-IMPLEMENTATION-PLAN.md`](INDIE-FACTORY-IMPLEMENTATION-PLAN.md) is the accepted roadmap
for the indie-developer product: one local repository controller, agent-chat/MCP control, cost-aware
compilation, adaptive single-host scheduling, bounded cloud burst, durable Codex sessions, and native
stacked pull requests. Except for the current v2 foundations identified above, those capabilities
remain planned until their individual phase and live-conformance gates pass. Product-direction
documentation must not be interpreted as release evidence.
