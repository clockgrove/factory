# Factory contributor rules

These instructions are for human and agent contributors **building Factory in this repository**. They govern source extraction, slice scope, implementation, tests, review, and handoff. End-user instructions for using the installed plugin belong in the [README](README.md) and packaged `director`/`setup` skills; contributors do not invoke Factory Director to build Factory.

Read [the public implementation plan](docs/IMPLEMENTATION-PLAN.md), [current build status](docs/BUILD-STATUS.md), and the current [project issue](https://github.com/orgs/clockgrove/projects/2) before changing code. These public files and issues are the complete contributor handoff; private adopter material is never required. Factory is a plugin for a target repository, not a hosted service. Never install, activate, or qualify it against a Factory source checkout. Use a disposable target built from [the public fixture](test/fixtures/disposable-target/).

## Priority

Ship the trunk through one path: Objective → Work Item DAG → local execution → exact validation → GitHub delivery → Objective final validation. Trunk includes native linear PR stacks, media assets, large content, Git LFS, restart/cancel/status, and packaging. Private adopter pilots follow the disposable release gate built from public fixtures and use the public plugin surface exactly as a third party would.

Shared execution/result contracts, snapshot and validation/delivery boundaries, and the installed local harness seam with its second-provider proof (#55) are trunk foundations. Working managed execution (#7) and sandbox transport/lifecycle (#8) remain branches after full trunk and pilot acceptance. Daytona (#9) is the first sandbox provider and depends on #8; #7 is not a technical prerequisite for #8 or #9. The planned delivery order remains managed execution, sandbox execution, then Daytona; scheduling belongs to the Project. See the [foundation and provider boundary](docs/IMPLEMENTATION-PLAN.md#trunk-foundations-and-provider-branches).

Additional cloud-session SDKs and sandbox providers are separate adapter capabilities that reuse the appropriate execution mode. Keep provider-specific APIs and configuration inside adapters. A declared interface or scripted fixture does not qualify a real provider. Improve shared code in the branch that demonstrates the need; move a correction into trunk only for a demonstrated current trunk requirement. Bursting, mixed modes, live migration, adaptive pressure, distributed controllers, and compounded fault matrices remain leaves.

The approved adopter pilot is Codex-only. #55 and PR #62 are accepted and closed with their own installed harness evidence; that evidence does not qualify a later artifact or optional provider for this pilot. Current execution gates belong to [#206](https://github.com/clockgrove/factory/issues/206), with independent final acceptance in [#207](https://github.com/clockgrove/factory/issues/207). Historical #26 is closed as superseded tracking. Do not infer new target or source-egress authority from contributor instructions.

## Scope

Start from the current issue's outcome and the relevant section of the public plan. A finding is a blocker only when it prevents that path; record useful follow-ups without making them blockers. Stop when accepted behavior and focused validation pass. The target repository owns product requirements, documentation authority, commands, branch protection, and Objective exit conditions. Work Item completion does not imply Objective completion.

## GitHub issue hygiene

Treat issue metadata as part of issue creation, not as optional cleanup. Before opening a Factory contributor issue, search both open and closed issues for the behavior and exact error. Prefer updating an existing issue when its accepted scope covers the finding. When a closed predecessor or active parent only partially covers it, file a focused follow-up and link the predecessor, parent tracking issue, relevant pull request, and durable public reproduction. Do not publish private adopter content, credentials, raw model prompts or responses, or local-only evidence.

The copyable [Development Objective form](docs/templates/objective.yml) is for an Objective in the repository that owns target work; it is not the template for Factory implementation findings. Use this minimum structure for a Factory contributor issue, adapting headings only when the subject genuinely requires it:

```markdown
## Outcome

State the user- or operator-visible result, not an implementation task.

## Reproducible gap

Give the current behavior, exact public identities or evidence, and why existing issues do not already resolve it.

## Acceptance

- List observable behavior and focused regression coverage.
- Preserve relevant safety, authority, privacy, and compatibility invariants.

## Non-goals

- Bound adjacent work, retries, migrations, provider changes, and release claims.
```

Apply metadata in the same operation whenever the interface permits it. Every issue must normally have exactly one delivery-scope label:

- `trunk` for a required vertical slice or correction on the shippable Factory path;
- `branch` for a named post-trunk capability branch;
- `leaf` for bounded optional follow-up work after trunk;
- `release-gate` for acceptance or adopter evidence with no Factory implementation scope.

Add `bug`, `enhancement`, `decision`, or `blocked` only when each label adds accurate information; those labels do not replace the delivery-scope label. Use a milestone, project, or assignee when the operator names one or when the active parent and neighboring issues establish that convention; do not invent one. After creation, inspect the issue's title, body, state, labels, milestone, project items, assignees, and links. Do not report the issue as filed until the body and metadata are verified. If later evidence changes scope, update the issue and its metadata together.

## Design

Build successive vertical slices. Define narrow contracts for the named variation points: PlanningModel, ExecutionDriver, AgentHarness, SandboxProvider, DeliveryStrategy, ContentStore, and GitHubGateway. Compose only implementations needed by the current slice. Do not abstract the state store, scheduler, lifecycle, validator, runner, Git model, or controller host.

Use one atomic local snapshot. Do not add operational event journals, receipts, recovery journals, custom state refs, provider ranking, fallback chains, or qualification machinery. The planned [agent-readable diagnostics](docs/IMPLEMENTATION-PLAN.md#agent-readable-diagnostics) record correlated local observations but never reconstruct or control lifecycle state; optional OpenTelemetry export is not a second controller. MediaAssetService preserves immutable bytes, AssetSets, provenance, review, selection, and bindings; the configured AgentHarness owns model and tool execution. Media reenters ordinary validation and delivery.

The rebuild starts at schemaVersion 1 and reads no archived configuration or state. Inspect only archived paths named by the current slice in [SOURCE-PROVENANCE.md](docs/SOURCE-PROVENANCE.md) and the public plan; record retained behavior and clean destination. Copy no archived runtime, tests, or fixtures. Do not invent Factory limits beneath dependencies or operator policy. Existing explicit-run Work Item failure stops with evidence, and a new implementation attempt requires explicit retry. Approved program #243 adds a separately bound autonomous policy through its owning capabilities; neither contributor authority nor an upgrade grants target runs automatic retry, service or spending authority. The compiler gate may make one evidenced planning revision after independent review; this is not an implementation retry. Ambiguous external state requires operator direction.

Use low reasoning effort for focused implementation and routine tests, medium for architecture and unfamiliar debugging, and higher only for a concrete blocker. Review the accepted diff once, batch findings, fix blockers, run affected checks, and stop. Prefer deterministic integration scenarios with real temporary Git repositories; stub remote services at narrow contracts.

Keep the tracking GitHub issue useful while work is in progress, not only when it closes. Post a concise comment at meaningful checkpoints: a merged change or published artifact, the start or result of an acceptance gate, a blocker or changed plan, and the end of a long workday if the issue would otherwise appear idle. State what is done, link durable public evidence, say what remains, and name the next action. Do not post routine activity pings or rely on agent-session messages, private workspace files, or local artifacts as the public status record. The parent agent is responsible for keeping the issue current when subagents do the work.

After a slice gate, update [BUILD-STATUS.md](docs/BUILD-STATUS.md), the tracking issue, and the provenance ledger so a new contributor can resume from the public repo alone. Report current slice, proven behavior, blocker, next action, and whether remaining work is trunk, branch, or leaf.

### Model-facing contracts

Ask models for semantic decisions; keep controller-known identities, hashes, constants and
derived relationships in deterministic code. Use existing typed alternatives or local references
and hydrate canonical facts from verified inputs instead of requiring exact bookkeeping copies
or independent fields that permit invalid combinations. Apply this to demonstrated supported
paths, not every opaque string; do not invent finite catalogs for base-observed commands.

Before patching or releasing a model contract, review related fields together through producers,
actual provider schemas, decoders, canonical validators and review inputs. Prefer direct changes
at those existing boundaries; do not compensate with generic frameworks, extra model calls or
persistent state. Preserve evidence grounding and completeness, security, source and command
authority, and fail-closed validation. Never repair invalid responses into accepted facts.

Prerelease interfaces may change coherently; preserve historical evidence, but add no fallback, migration or duplicate format solely for compatibility without an explicit requirement.

Test actual emitted schemas and decoders, current supported variants and refusals, and replay
the complete preserved failing response rather than substituting a hand-built fragment.

When changing a selected API version, check the official response contract and every affected
consumer. Fixtures must match that version, including the absence of removed fields;
asserting the version header alone does not prove a successful migration.
