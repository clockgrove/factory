# Factory contributor rules

These instructions are for human and agent contributors **building Factory in this repository**. They govern source extraction, slice scope, implementation, tests, review, and handoff. End-user instructions for using the installed plugin belong in the [README](README.md) and packaged `director`/`setup` skills; contributors do not invoke Factory Director to build Factory.

Read [the public implementation plan](docs/IMPLEMENTATION-PLAN.md), [current build status](docs/BUILD-STATUS.md), and the current [project issue](https://github.com/orgs/clockgrove/projects/2) before changing code. These public files and issues are the complete contributor handoff; private adopter material is never required. Factory is a plugin for a target repository, not a hosted service. Never install, activate, or qualify it against a Factory source checkout. Use a disposable target built from [the public fixture](test/fixtures/disposable-target/).

## Priority

Ship the trunk through one path: Objective → Work Item DAG → local execution → exact validation → GitHub delivery → Objective final validation. Trunk includes native linear PR stacks, media assets, large content, Git LFS, restart/cancel/status, and packaging. Private adopter pilots follow the disposable release gate built from public fixtures and use the public plugin surface exactly as a third party would.

The installed local harness seam and its second-provider proof are trunk issue #55. After trunk and the public pilot, add `ManagedExecutionDriver`, then `SandboxExecutionDriver` using the already-landed harness seam, then Daytona as the first `SandboxProvider`. Bursting, mixed modes, live migration, adaptive pressure, distributed controllers, and compounded fault matrices are leaves.

The operator-approved Codex-only #26 adopter pilot is a bounded execution-order
exception: #55 and Claude/Copilot live qualification are deferred prerequisites
for that pilot, not accepted behavior. See the [controlling plan exception](docs/IMPLEMENTATION-PLAN.md#operator-approved-codex-only-adopter-pilot).
Keep #55 OPEN/deferred and draft PR #62 frozen/unmerged; its live proof and the
actual adopter acceptance remain separate requirements for overall trunk
completion. Do not block the independently authorized pilot on #55, provider
login or this docs handoff, and do not infer new target/source-egress authority
from public contributor instructions.

## Scope

Start from the current issue's outcome and the relevant section of the public plan. A finding is a blocker only when it prevents that path; record useful follow-ups without making them blockers. Stop when accepted behavior and focused validation pass. The target repository owns product requirements, documentation authority, commands, branch protection, and Objective exit conditions. Work Item completion does not imply Objective completion.

## Design

Build successive vertical slices. Define narrow contracts for the named variation points: PlanningModel, ExecutionDriver, AgentHarness, SandboxProvider, DeliveryStrategy, ContentStore, and GitHubGateway. Compose only implementations needed by the current slice. Do not abstract the state store, scheduler, lifecycle, validator, runner, Git model, or controller host.

Use one atomic local snapshot. Do not add operational event journals, receipts, recovery journals, custom state refs, provider ranking, fallback chains, or qualification machinery. The planned [agent-readable diagnostics](docs/IMPLEMENTATION-PLAN.md#planned-agent-readable-diagnostics) record correlated local observations but never reconstruct or control lifecycle state; optional OpenTelemetry export is not a second controller. MediaAssetService preserves immutable bytes, AssetSets, provenance, review, selection, and bindings; the configured AgentHarness owns model and tool execution. Media reenters ordinary validation and delivery.

The rebuild starts at schemaVersion 1 and reads no archived configuration or state. Inspect only archived paths named by the current slice in [SOURCE-PROVENANCE.md](docs/SOURCE-PROVENANCE.md) and the public plan; record retained behavior and clean destination. Copy no archived runtime, tests, or fixtures. Do not invent Factory limits beneath dependencies or operator policy. Work Item failure stops with evidence, and a new implementation attempt requires explicit retry. The planned compiler gate may make one evidenced planning revision after independent review; this is not an implementation retry and is not yet implemented. Ambiguous external state requires operator direction.

Use low reasoning effort for focused implementation and routine tests, medium for architecture and unfamiliar debugging, and higher only for a concrete blocker. Review the accepted diff once, batch findings, fix blockers, run affected checks, and stop. Prefer deterministic integration scenarios with real temporary Git repositories; stub remote services at narrow contracts.

Keep the tracking GitHub issue useful while work is in progress, not only when it closes. Post a concise comment at meaningful checkpoints: a merged change or published artifact, the start or result of an acceptance gate, a blocker or changed plan, and the end of a long workday if the issue would otherwise appear idle. State what is done, link durable public evidence, say what remains, and name the next action. Do not post routine activity pings or rely on agent-session messages, private workspace files, or local artifacts as the public status record. The parent agent is responsible for keeping the issue current when subagents do the work.

After a slice gate, update [BUILD-STATUS.md](docs/BUILD-STATUS.md), the tracking issue, and the provenance ledger so a new contributor can resume from the public repo alone. Report current slice, proven behavior, blocker, next action, and whether remaining work is trunk, branch, or leaf.
