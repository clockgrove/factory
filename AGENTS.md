# Factory contributor rules

These rules govern building Factory. The README and packaged skills govern using it on an approved target repository. Never run Factory Objectives against its own source checkout. Read the relevant issue and code; use [the architecture](docs/ARCHITECTURE.md) as a reference. Lifecycle refusals carry the stable codes in [the lifecycle](docs/LIFECYCLE.md); a new state or command needs a conformance row.

## Delivery

- Finish one phase at a time. Use concurrent agents within that phase with clear file ownership.
- Batch related fixes into a complete outcome. Merge with green CI and the maintainer’s read; independently review the completed milestone once. Credentials, isolation and persisted-state changes also need one focused independent review.
- CI is the routine check. Run an affected local check only when it resolves an actual uncertainty; do not repeat full suites or add per-fix qualification.
- Use meaningful affected tests, retained evidence, independent review and green CI to finish the product outcome. Add a live check only for a specific changed behavior that these facts do not prove. Reuse evidence where it still applies, and stop when the behavior works and the required checks pass.
- Issues and pull requests record scope, decisions and results. Follow the issue metadata rules below, existing Project status and applicable relationships. Comment when a fix merges, an actual blocker appears or the plan changes. No separate status documents, per-PR changelog entries, mandatory issue-heading templates or new label taxonomy.
- Follow [the release procedure](docs/RELEASING.md) and the release issue’s actual exits. Do not invent additional release gates. GitHub release notes record changes.

## Issue metadata

- Set the native issue type when creating an issue: `Bug` for a standalone defect, `Feature` for a requested capability or Objective, and `Task` for a Work Item, qualification, investigation or maintenance task. A corrective Work Item remains `Task`; its underlying standalone defect can be `Bug`.
- Use labels only for information independent of type, such as area, priority, phase, scope or Factory role. Do not add `bug`, `enhancement`, `feature` or `task` labels as substitutes for, or duplicates of, native types. Preserve `factory:objective` and `factory:work-item` where required; they describe roles, not issue types.
- When creating an issue or triaging the active backlog, assign exactly one existing priority label: `P0` for urgent security, data loss, duplicate effects or stranded work; `P1` for current critical-path delivery or incorrect behavior with a supported workaround; `P2` for low-impact bugs, optional improvements, cleanup or deferred qualification. Priority is independent of native type and blocked status.
- Work Items normally inherit their parent's priority unless their own impact justifies a different one. Verify priority after creation or projection, and preserve an existing priority unless evidence supports a change. Priority labels do not admit work, reorder the approved queue or grant retry, spending or deployment authority.
- CLI/API issue creation must explicitly supply the native type; issue forms must set their top-level `type`. Inspect the returned issue after creation or edits to verify its type and labels. Do not assume a template or title assigned the type, and do not leave an issue untyped when an appropriate native type is available.
- On adopter targets, use available native types and existing labels. Do not create types, alter repository settings or invent fallback classification labels to enforce this convention; report unavailable types through the existing prerequisite guidance.

## Product boundaries

Factory is a general-purpose plugin. Keep adopter-specific behavior out of its source. Preserve Objective → Work Item graph → execution → exact validation → GitHub delivery → final acceptance, including media/LFS and restart/cancel/status.

Keep credentials, configuration and continuation state outside targets. Preserve isolation, branch protection, ownership, source/command authority, exact commit/tree/head checks, substantive acceptance and recorded provider/resource limits. Contributor authority never transfers to workers or adopters.

Continue external effects only from verified recorded outcomes. Unknown is unknown: do not replay ambiguous mutations, revive terminal runs, bypass fences, manually repair state or fabricate evidence. Preserve results, failures, artifacts, usage and spent allowances. Private adopter content and raw prompts/logs stay private.

Use the existing atomic continuation snapshot. Diagnostics observe; they never drive recovery. Keep provider-specific APIs in adapters. Use narrow contracts only at the existing PlanningModel, ExecutionDriver, AgentHarness, DeliveryStrategy, ContentStore and GitHubGateway seams; do not add a framework or duplicate lifecycle/state layer.

## Coverage and model contracts

Keep the small real integration suite: actual Git repositories, processes, files, scanner and offline packed CLI. Reuse an existing workflow for a demonstrated regression. Do not add unit tests, mocks, fake services/providers, scripted responses, fault matrices or fixture frameworks. Real provider/GitHub acceptance occurs at the approved milestone when its substantive exits require it; CI does not claim that acceptance.

Qualification serves the product outcome. Broad provider/profile matrices, benchmarks and deliberate fault drills are not automatic feature-closure or release gates. A new live provider capability still needs real SDK evidence for the named claim; use the smallest bounded check that proves it. Preserve security, ownership, unknown outcomes, accounting and recorded limits without expanding qualification beyond the required behavior.

For local process/resource observations, establish that the observer shares the recorded owners' runtime and process namespace before claiming cessation; a sandbox-only `/proc` scan does not prove host closure. Keep unproved namespace or resource visibility unknown. Verify prerequisite setup and probes use the exact source-authorized commands and order in the actual fresh checkout for that phase. Distinguish transferred Git-tracked inputs from ignored installations and generated runtime artifacts, and verify the latter are prepared there.

Models decide semantics; code supplies verified identities, hashes and derived facts. Inspect producers, actual schemas, decoders, validators and supplied evidence together. Preserve complete required source evidence and deterministic grounding. Never normalize an invalid answer into accepted evidence or invent command catalogs. Check official contracts when changing provider APIs.

Prefer the smallest correction to a demonstrated defect. Prerelease contracts may change coherently; do not add compatibility formats, migrations or extra safeguards without a concrete requirement.
