# Factory contributor rules

These rules govern building Factory. The README and packaged skills govern using it on an approved target repository. Never run Factory Objectives against its own source checkout.

Factory is being rebuilt: [the design](docs/DESIGN.md) is the authority. Until cutover, the old tree under `src/` is frozen: no fixes or features there; it is deleted at cutover. [The architecture](docs/ARCHITECTURE.md) and [the lifecycle](docs/LIFECYCLE.md) describe the old tree and are replaced at cutover.

## Stability rules

Every change must keep these. Review checks them, not just the diff.

1. **Contained.** A failure affects only its own Objective; the service and queue keep running.
2. **Deadlines.** Every wait has a deadline that ends in progress, an automatic retry or a hold.
3. **Actionable holds.** Every hold is a question with named answers that work. Cancel always works.
4. **Crash-only.** Killing the service at any point and restarting it continues the run with no duplicate GitHub effect.
5. **GitHub is retried.** A GitHub error, timeout or partial read never fails a run.
6. **Bounded.** Cost follows active work; nothing reads history to make progress.
7. **Checked once.** Input is validated where it enters, and trusted after that.

A change that needs a new kind of hold, lock, owner, archive, background loop or fence is a design change: raise it in an issue first.

## Delivery

- Finish one phase at a time. Use concurrent agents within that phase with clear file ownership.
- Batch related fixes into a complete outcome. Merge with green CI and the maintainer’s read; independently review the completed milestone once against the stability rules. Credentials, isolation and state changes also need one focused independent review.
- **Stop rule.** When the same class of failure shows up a second time, stop patching: find the structural cause and fix it in the design, or raise it in an issue.
- **Lean code.** One implementation per job, no dead code, and tests that prove behavior ([the design](docs/DESIGN.md#lean-code)). Sweep for duplication at every milestone.
- CI is the routine check. Run an affected local check only when it resolves an actual uncertainty; do not repeat full suites or add per-fix qualification.
- Finish the product outcome with meaningful affected tests, independent review and green CI. A milestone also needs its crash drill (see Testing). Stop when the behavior works and the required checks pass.
- **Land through the merge queue, in stacks.** Enqueue with `gh pr merge --auto --squash N`, never merge directly. Changes that build on each other are one `gh stack`, landed with `gh stack merge --yes`. Push with `scripts/land-prep.sh`. Settings, commands and the reasons are in [Landing changes](docs/LANDING.md).
- **No hot files.** No status documents or changelogs in the repository: a capability Factory still lacks is one GitHub issue labelled `cutover-gap`, and cutover waits until none is open. One topic, one file: the design is split under `docs/reference/`; a CLI command is `core/src/commands/<name>.ts`, a phase's step is its own module under `core/src/work/`, and the service tests are split by area in `core/test/`. Add a file rather than grow a shared one. How a module does its job belongs in its own header comment, not the spec.
- **Refactors are proven.** Generate a split with a script, and prove each layer a pure move with `scripts/split-proof.mjs` ([Large refactors](docs/LANDING.md#large-refactors)).
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

Factory is a general-purpose plugin. Keep adopter-specific behavior out of its source. Keep every capability: Objective → plan → Work Items → execution → validation → GitHub delivery → final acceptance, including media/LFS, all providers, and restart/cancel/status. Simplify mechanisms, never scope.

Keep credentials, configuration and state outside targets. Preserve the sandbox, branch protection, owned paths, source and command authority from pinned Sources, independent acceptance review, and provider/resource limits. Contributor authority never transfers to workers or adopters. Private adopter content and raw prompts/logs stay private.

## State and effects

- **One writer.** Only `factory serve` writes state. The CLI reads state and writes request files.
- **One state file per Objective**, saved atomically after every step. It is trusted: no digests, seals or tamper checks on same-user files.
- **Idempotent effects.** Every outside effect is found on GitHub before it is made: fixed branch names, PRs by head branch, comments by marker. A lost response is resolved by looking, then carrying on. It is never a permanent "unknown".
- **Outcomes, not throws.** A step returns `done`, `retry`, `repair`, `hold` or `fail`. An escaped exception counts as `retry`, and repeated ones become a hold with `retry` and `cancel`. Never add an error path that leaves an Objective with no working answer.
- **GitHub and the Project are displays and inputs, never preconditions.** Read failures keep the last good view; write failures retry later.
- **Logs observe.** Diagnostics and analysis read the run log; they never drive progress.
- Provider APIs stay in their adapters, behind the Planner, Worker, Reviewer and Delivery seams.

## Testing

No mocks, fake services, fake providers or scripted responses.

- Tests use real Git repositories, processes and files, and the real `factory serve`.
- **Crash tests** kill the real service at named crash points (`FACTORY_CRASH_AT`) and restart it. Every new step or outside effect gets a crash point, listed in `core/test/crash.test.mjs`, and is covered.
- **Drill.** At each milestone, run a small real Objective on the scratch drill repository with real providers. Kill the service at every crash point, cut the network, and stop a model mid-turn. The milestone passes only if the Objective finishes with no duplicate effect and every hold had a working answer.
- Don't add unit tests of private helpers or provider/profile matrices.

## Model contracts

Models decide semantics; code supplies identities and derived facts. Validate a model answer where it enters. Give an invalid answer one retry with the error, then retry or hold; never turn it into accepted evidence, and never fail the run on it. Check official contracts when changing provider APIs.

A plan check ships with its facts in the planner request and a refusal that names what would pass. See [the plan checks](docs/PLANNING.md#plan-checks).

Prerelease contracts may change coherently: no compatibility formats or migrations. A state version mismatch holds with `reset` and `cancel`.
