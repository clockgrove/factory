# Contributing to Factory

Contributions are welcome, including AI-assisted contributions. The author remains responsible for
the code, tests, licensing,
security boundary, and claims in the pull request.

## Before proposing a change

Read [`docs/DESIGN.md`](docs/DESIGN.md) first. It states the goals, the non-goals, and the rules that
changes are judged against; [`AGENTS.md`](AGENTS.md) states the engineering conventions.
All remaining product work is tracked in ordinary GitHub issues linked from
[GitHub #69](https://github.com/clockgrove/factory/issues/69). Its body is the single current
project summary; linked issues own detailed acceptance and evidence, not duplicate status boards.
Repository documents retain durable contracts, procedures and historical evidence;
contributor tasks do not require Factory Objective compilation. Accepted implementation waves remain
in [`docs/DELIVERY-PLAN.md`](docs/DELIVERY-PLAN.md).

Keep each change focused on one complete, testable capability, not an arbitrary number of files or
helper modules. GitHub is Factory's durable state: do not add sidecar state, status
labels, queues, services, or workflows that reconstruct the orchestration loop outside the harness.
All GitHub access in `src/` must use Octokit, and every write must pass through the pacing,
concurrency, and circuit-breaker controls in `src/platform.ts`.

Open an issue before implementing a new provider, credential class, durable protocol record, public
API, or change to the product boundary. Security vulnerabilities must be reported privately through
[SECURITY.md](SECURITY.md), not discussed in a public issue.

The supported runtime is Linux: native Linux, Windows WSL2, or a Linux guest hosted by macOS. Native
Win32/Darwin lifecycle support and multiple-local-machine scheduling are intentionally out of scope.
Daytona retains its live qualification gate. Managed integrations are qualified per provider under
the **Managed-provider capability boundaries** gate: document supported behavior and unavailable
interfaces, and obtain live evidence before claiming execution support. Copilot has limited automation;
Codex remains unavailable until its identity and provider-specific lifecycle integration are established.
Missing third-party APIs are provider limitations, not categorical blockers to Factory publication.
Billing settlement finality is not required; users own their provider billing relationship. Do not
weaken active-compute, exact-identity, replacement, cleanup or spending safeguards to claim support.
Vercel Sandbox remains Labs; an optional Labs adapter cannot change default startup or release
behavior. Explicit Codex App Server execution and durable terminal recovery are part of supported
local qualification; the SDK/CLI default chain remains unchanged.

## Prefer pragmatic solutions

Apply the pragmatic-solution policy in [`AGENTS.md`](AGENTS.md) to every coding task, including
planning and review. Start with the concrete outcome and choose the simplest complete solution.
Before adding abstractions, recovery paths, or durable state, consider deletion, retaining less data,
and reuse of existing facilities. Additional complexity must serve a current requirement or a
demonstrated failure; future flexibility alone is insufficient.

For a material design choice, briefly explain why a simpler alternative is insufficient and what
operational or maintenance costs the chosen approach adds. Review requests for more generality or
resilience need the same evidence and must remain within the accepted scope. Preserve the existing
correctness and authorization boundaries; routine changes do not need another design document.

## Validate changes

Use Node.js 20 or later. Finish independent implementation capabilities in parallel, isolated
worktrees. During development, use focused tests, typechecks and lint/format checks proportional to
the changed behavior; add a regression for each concrete defect. Retain targeted security,
destructive-action, accounting and recovery checks. Use source inspection, authoritative API
documentation and captured contract fixtures to inform code; never invent provider interfaces or
broaden spending/credential authority to finish a task.

Do not repeatedly run full coverage, release matrices, packaging, plugin reinstalls or broad live
qualification between intermediate fixes. A narrow live probe is justified only when implementation
depends on uncertain platform behavior and the probe is within existing authorization. Independent
lanes own focused acceptance; the integration owner coordinates the full candidate gate below.

For instruction-only or documentation-only changes, check the diff, links, and applicable
formatting. Run runtime tests, builds, or installed qualification only when the changed behavior or
documented procedure requires them. Contributor-guidance edits alone do not create a release
candidate or require the release gate.

For a release candidate, after implementation and integration review are complete, use one
coordinated qualification phase:

1. Review and freeze the source, tests, documentation and manifests as an identified candidate.
2. Run the complete suite, fix actual failures, and retain security, destructive-action, accounting
   and recovery coverage. Do not call code feature-complete while implementation blockers remain.
3. At the stable candidate boundary, build synchronized bundles and run `npm run verify:release` for
   the full integrated checks.
4. Install the matching artifact and record source/artifact identities.
5. Execute the required installed end-to-end cases and applicable conformance matrices under their
   separately accepted authority.

If a check fails, preserve its original result, fix the defect, and run affected checks first.
Repeat broader checks at the next stable candidate boundary; do not automatically restart unrelated
tests. Keep old evidence bound to its original candidate, never relabel it as proof of changed bytes.
Reuse completed work through authorized recovery where possible rather than regenerating a cleaner
history. State unrun or blocked checks explicitly. Simulated-provider fixtures do not establish live
support, and bounded pilot qualification does not satisfy or remove full release gates.

`verify:package` checks the committed plugin manifests and skills, starts the bundled MCP server
through the manifest's own command and arguments, and verifies its public tool surface. It also
installs a staged copy through an isolated `CODEX_HOME` using the Codex CLI and starts the installed
MCP and repository-controller executables. The check does not use the development worktree's Codex
configuration or credentials and does not create a paid provider resource. `npm run verify:release`
runs typecheck, lint, formatting, coverage, schema, deterministic-build, plugin, npm-package, and
production-audit gates as one command.

The coordinated `verify:release` gate must run directly in a supported Linux environment with
systemd 254 or newer and a reachable systemd **user manager**. This includes the Linux side of WSL2,
not a nested sandbox that cannot reach the WSL user bus. Before starting any broad checks, the command
runs the bounded read-only probe
`systemctl --user show --property=Version --value --no-pager`; run that exact command yourself when
diagnosing the host. A passing preflight does not replace or skip the suite's real transient-scope
containment tests.

## AI-assisted development workflow

This section and root `AGENTS.md` guide contributors building Factory. Changes here do not change
the packaged plugin skills, generated worker prompts, runtime policies, or model defaults. Changes
to those product surfaces require a separately scoped proposal and validation.

The [OpenAI GPT-6 Astra prompting guidance](https://developers.openai.com/api/docs/guides/latest-model#prompting-best-practices)
describes increased sensitivity to instruction files, unnecessary clarification pauses, less
delegation than some workflows need, and overly broad verification. The contributor rules make
completion, delegation, and verification expectations explicit while retaining authorization and
quality gates. They remain useful with other models; using Astra is not a contribution requirement.
API-level steering capabilities do not establish how a particular development harness delivers
messages. Check the harness before relying on that behavior.

When evaluating an instruction change, compare similar bounded development tasks with the prior
workflow, keeping the model, reasoning effort, acceptance criteria, and required checks fixed where
practical. Record a compact summary in the PR:

- completion and review outcome, including defects, scope drift, or rework;
- unnecessary approval pauses, distinguished from required user decisions;
- useful parallel work, duplicate investigations, and integration conflicts;
- repeated checks and whether a changed revision, failure, or unresolved risk justified them;
- elapsed time and total observed model tokens across the coordinator and all delegated agents;
  report cached usage or monetary cost only when available, and mark missing measurements unknown.

Use cost and time per accepted deliverable to judge improvement. Token reductions are not a win if
the work is incomplete or less reliable. Do not launch paid evaluations or change model settings
without authorization. Until measured, describe efficiency gains as hypotheses, not demonstrated
results. Keep private prompts, transcripts, and credentials out of public evidence.

## Verify platform claims against the platform

Tests against fakes establish Factory's behavior for a given response; they do not establish that a
GitHub endpoint or response shape exists. Any new GitHub API claim must also be checked against
current official documentation and, where permissions allow, verified with a read or a bounded run
against a real repository.

Two things this applies to more than it looks:

- **Behavioral claims, not just schema claims.** A wrong field name looks like something you might
  misremember, so it prompts a check. A belief about what GitHub or the coding agent *does* does not
  look like a claim at all — it looks like background knowledge. If a change rests on *what something
  will do* rather than *what shape it returns*, go and measure it.
- **Documented flows.** Prose is the only part of a release with no CI, and `verify:package` does not
  cover published distribution — installing a staged release package proves the package shape but is
  still weaker than installing a published artifact. If you change install, upgrade, or uninstall
  instructions, run them end to end against the published artifact when one exists. Before the first
  publication, exercise the installed staged artifact and state that published-distribution
  verification remains open. Reviewing instructions for plausibility is not execution evidence.

## Pull requests

Explain the user-visible behavior, the evidence supporting any GitHub API assumptions, and the
validation performed. Never include credentials, repository secrets, or private test data.

A reviewable pull request should:

- identify the issue or product-contract decision it implements;
- state whether it changes protocol compatibility, security assumptions, cost authority, or public
  package/API surfaces;
- include deterministic tests and list commands actually run;
- update `CHANGELOG.md`, relevant docs, schemas, and conformance evidence when applicable;
- keep generated bundles synchronized with source through the repository's build and verification
  commands; and
- avoid unrelated formatting, dependency, or generated-file churn.

AI-generated descriptions, tests, and patches receive the same review as human-authored work. Do not
paste private prompts or full agent transcripts into an issue or pull request; summarize the design
decision and reproducible evidence instead.

## Commit and release discipline

Use one integration branch and one PR per complete, testable capability. Develop with incremental
commits and bounded parallel subagents where useful; consolidate their work in that branch rather
than opening a separate PR or stack layer for each helper or Work Item. A capability's end-to-end
acceptance criteria define its batch; a PR boundary is not automatically a release-candidate boundary.

Independent capabilities may advance concurrently in isolated worktrees, each with one owner and
explicit acceptance criteria. Optimize delivery of the overall goal, not utilization alone: keep
available agents on high-impact unblocked work within authorized budgets, and serialize only genuine
dependencies or conflicting edits. One PR per capability is a delivery boundary, not a global
one-capability-at-a-time limit. Every lane needs a concrete finish-line deliverable and an explicit
running, waiting, completed, or blocked status. Resume a completed agent explicitly before assigning
follow-up work; do not create extra audits, docs, or test infrastructure just to occupy agents.

Finish the declared candidate's implementation in parallel before coordinated qualification; do not
interpret "remaining implementation" as every future backlog enhancement. Apply the candidate
admission and cheap integrated-tree checks in AGENTS.md without repeating broad release gates.
Maintain the body of #69 with milestone, code/testing/external-input classification, owner,
dependencies, next deliverable and evidence links. Update it and affected issue bodies as part of
capability completion; comments remain historical. Keep implemented, integrated and qualified
distinct. Preserve every accepted obligation in a milestone issue, including explicit deferrals.
Before starting a capability, map its obligations to acceptance and check that individually passing
parts compose into the requested outcome; this does not require a new evaluator or framework.
At completion report elapsed time, total observed model usage including failed/reworked effort,
integration/review defects, human interventions and remaining unproven requirements. Missing
measurements remain unknown. Report the critical path and required decisions, not utilization alone.
All applicable release and live-conformance gates still apply.

Do not commit credentials, local Factory state,
installation receipts, provider output, or private fixtures. A release candidate is published only
after `npm run verify:release` and the applicable prepublication gates in
[docs/CONFORMANCE.md](docs/CONFORMANCE.md). The final verified tag also requires that candidate's
post-publication clean-install gate.

By contributing, you agree that your contribution is licensed under the
[MIT License](LICENSE).
