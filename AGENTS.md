# Factory contributor rules

These rules govern building Factory. The README and packaged skills govern using it on an approved target repository. Never run Factory Objectives against its own source checkout. Read the relevant issue and code; use [the architecture](docs/ARCHITECTURE.md) as a reference.

## Delivery

- Finish one phase at a time. Use concurrent agents within that phase with clear file ownership.
- Batch related fixes into a complete outcome. Merge with green CI and the maintainer’s read; independently review the completed milestone once. Credentials, isolation and persisted-state changes also need one focused independent review.
- CI is the routine check. Run an affected local check only when it resolves an actual uncertainty; do not repeat full suites or add per-fix qualification.
- Issues and pull requests record scope, decisions and results. Comment when a fix merges, an actual blocker appears or the plan changes. No separate status documents, per-PR changelog entries, mandatory issue-heading templates or label taxonomy.
- Follow [the release procedure](docs/RELEASING.md) and the release issue’s actual exits. Do not invent additional release gates. GitHub release notes record changes.

## Product boundaries

Factory is a general-purpose plugin. Keep adopter-specific behavior out of its source. Preserve Objective → Work Item graph → execution → exact validation → GitHub delivery → final acceptance, including media/LFS and restart/cancel/status.

Keep credentials, configuration and continuation state outside targets. Preserve isolation, branch protection, ownership, source/command authority, exact commit/tree/head checks, substantive acceptance and recorded provider/resource limits. Contributor authority never transfers to workers or adopters.

Continue external effects only from verified recorded outcomes. Unknown is unknown: do not replay ambiguous mutations, revive terminal runs, bypass fences, manually repair state or fabricate evidence. Preserve results, failures, artifacts, usage and spent allowances. Private adopter content and raw prompts/logs stay private.

Use the existing atomic continuation snapshot. Diagnostics observe; they never drive recovery. Keep provider-specific APIs in adapters. Use narrow contracts only at the existing PlanningModel, ExecutionDriver, AgentHarness, DeliveryStrategy, ContentStore and GitHubGateway seams; do not add a framework or duplicate lifecycle/state layer.

## Coverage and model contracts

Keep the small real integration suite: actual Git repositories, processes, files, scanner and offline packed CLI. Reuse an existing workflow for a demonstrated regression. Do not add unit tests, mocks, fake services/providers, scripted responses, fault matrices or fixture frameworks. Real provider/GitHub acceptance occurs at the approved milestone when its substantive exits require it; CI does not claim that acceptance.

Models decide semantics; code supplies verified identities, hashes and derived facts. Inspect producers, actual schemas, decoders, validators and supplied evidence together. Preserve complete required source evidence and deterministic grounding. Never normalize an invalid answer into accepted evidence or invent command catalogs. Check official contracts when changing provider APIs.

Prefer the smallest correction to a demonstrated defect. Prerelease contracts may change coherently; do not add compatibility formats, migrations or extra safeguards without a concrete requirement.
