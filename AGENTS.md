# Factory contributor rules

These instructions are for human and agent contributors **building Factory in this repository**. End-user instructions for using the installed plugin belong in the [README](README.md) and packaged `director`/`setup` skills; contributors do not invoke Factory Director to build Factory.

Read [the architecture](docs/ARCHITECTURE.md) and the relevant [project](https://github.com/orgs/clockgrove/projects/2) issue before changing code. Public files and issues are the complete contributor handoff; private adopter material is never required. Factory is a plugin for a target repository, not a hosted service. Never install, activate, or qualify it against a Factory source checkout. Use a disposable target built from [the public fixtures](test/fixtures/).

## Priority

Factory is a general-purpose open-source tool. No adopter is its design center, and adopter-specific behavior does not belong in its source.

Keep the trunk path working: Objective → Work Item DAG → local execution → exact validation → GitHub delivery → Objective final validation. Trunk includes native linear PR stacks, media assets, Git LFS, restart/cancel/status, and packaging. Managed execution (#7), sandbox execution (#8) and their providers are branches built on the same contracts; keep provider-specific APIs and configuration inside adapters. A declared interface or scripted fixture does not qualify a real provider.

## Working process

Work like a normal open-source project:

1. Start from an issue's outcome. Keep each pull request focused on one outcome.
2. Branch from `main`, implement with focused tests, and run the [checks](CONTRIBUTING.md#checks) that the change affects.
3. Open a pull request that links the issue and says what changed and what was tested. It merges after review and a green Quality check.
4. Release by following [RELEASING.md](docs/RELEASING.md). A merged fix can ship in a patch release the same day.

Comment on an issue when something meaningful changes: a merged fix, a release, a blocker or a changed plan. Do not post routine progress pings, and do not maintain separate status documents; issues, pull requests, releases and the changelog are the record.

Prefer simplification. Add a new safeguard, state field, gate or procedure only for a demonstrated failure, and prefer removing a cause over guarding against it. Do not add process that a contributor must perform by hand when the code, CI or GitHub can enforce the same thing.

## Scope

A finding is a blocker only when it prevents the current outcome; file useful follow-ups as separate issues. Stop when the behavior works and its tests pass. The target repository owns product requirements, documentation authority, commands, branch protection, and Objective exit conditions.

When a provider or workflow cannot satisfy a chosen mechanism, distinguish the required outcome from that mechanism. Propose the simplest alternative with its tradeoffs instead of declaring the work blocked. Never silently weaken validation, permissions, ownership, spending or acceptance.

## Issues

Search open and closed issues before filing. Use this structure for a Factory issue, adapting headings when needed:

```markdown
## Outcome

The user- or operator-visible result.

## Gap

Current behavior, a public reproduction, and why existing issues do not cover it.

## Acceptance

- Observable behavior and regression coverage.
```

Label each issue `trunk`, `branch`, `leaf` or `release-gate` by delivery scope, plus `bug`, `enhancement`, `decision` or `blocked` when accurate. Do not publish private adopter content, credentials, raw model prompts or responses. The [Objective form](docs/templates/objective.yml) is for target repositories, not for Factory issues.

## Design

Define narrow contracts for the named variation points: PlanningModel, ExecutionDriver, AgentHarness, SandboxProvider, DeliveryStrategy, ContentStore, and GitHubGateway. Compose only implementations a feature needs. Do not abstract the state store, scheduler, lifecycle, validator, runner, Git model, or controller host.

Use one atomic local snapshot for continuation state. Do not add operational event journals, recovery journals, custom state refs, provider ranking or fallback chains. [Diagnostics](docs/ARCHITECTURE.md#state-and-recovery) record correlated local observations but never reconstruct or control lifecycle state. The configured AgentHarness owns model and tool execution; media reenters ordinary validation and delivery.

Do not invent Factory limits beneath dependencies or operator policy. A failed explicit-run Work Item stops with evidence, and a new attempt requires explicit retry or an admitted repair policy. Ambiguous external effects stay unknown until reconciled; never replay them or treat a later readback as proof of completion. Contributor authority is not inherited by Factory workers or adopter sessions.

Prefer deterministic integration tests with real temporary Git repositories, and stub remote services at narrow contracts. Add a regression test for each concrete bug.

### Model-facing contracts

Ask models for semantic decisions; keep controller-known identities, hashes, constants and derived relationships in deterministic code. Hydrate canonical facts from verified inputs instead of asking a model to copy them. Do not invent finite catalogs for base-observed commands.

Before changing a model contract, review related fields together through producers, provider schemas, decoders, validators and review inputs. Prefer direct changes at those boundaries over generic frameworks, extra model calls or persistent state. Preserve evidence grounding, security, source and command authority, and fail-closed validation. Never repair invalid responses into accepted facts.

Prerelease interfaces may change coherently; do not add a fallback, migration or duplicate format solely for compatibility without an explicit requirement.

Test actual emitted schemas and decoders, current supported variants and refusals, and replay a complete preserved failing response rather than a hand-built fragment. When changing a provider API version, check the official response contract and every affected consumer; fixtures must match that version.
