# Contributing to Factory

Contributions are welcome, including AI-assisted contributions. The author remains responsible for
the code, tests, licensing,
security boundary, and claims in the pull request.

## Before proposing a change

Read [`docs/DESIGN.md`](docs/DESIGN.md) first. It states the goals, the non-goals, and the rules that
changes are judged against; [`AGENTS.md`](AGENTS.md) states the engineering conventions.
The current implementation waves are tracked in [`docs/DELIVERY-PLAN.md`](docs/DELIVERY-PLAN.md).

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
Daytona and two GitHub-managed release targets belong to the product contract; their live gates block
publication, and Codex discovery remains fail-closed until its provider-published identity is
recorded. Vercel Sandbox and Codex App Server are Labs. A Labs adapter must remain optional and
cannot change default startup or release behavior.

## Validate changes

Use Node.js 20 or later:

```bash
npm ci
npm run verify:release
```

For behavior changes, add the narrowest meaningful unit or fault-injection test that would fail
without the change. Documentation-only edits need relevant formatting, link, and consistency checks,
not new implementation tests. Run targeted checks while iterating; retain the full required gates
for integration and release. Repeat checks when intervening changes invalidate their evidence,
and state which checks were not run rather than implying release qualification. Changes to a
provider, GitHub behavior, platform lifecycle, install path, or other external contract also need
the applicable conformance evidence; do not convert a fake-provider test into a live-support claim.

`verify:package` checks the committed plugin manifests and skills, starts the bundled MCP server
through the manifest's own command and arguments, and verifies its public tool surface. It also
installs a staged copy through an isolated `CODEX_HOME` using the Codex CLI and starts the installed
MCP and repository-controller executables. The check does not use the development worktree's Codex
configuration or credentials and does not create a paid provider resource. `npm run verify:release`
runs typecheck, lint, formatting, coverage, schema, deterministic-build, plugin, npm-package, and
production-audit gates as one command.

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
than opening a separate PR or stack layer for each helper or Work Item. The batch boundary is when
the end-to-end acceptance criteria are met and the integrated result is ready for verification and
review.

Run targeted checks while iterating. At the batch boundary, run the full required integration and
release checks and rebuild/reinstall the updated plugin when the batch changes it. Do not pay this
overhead after every intermediate commit. Repeat checks when relevant changes or failures invalidate
their evidence; installation-specific work may need earlier targeted install tests. Documentation-only
batches use the proportional checks described above. All applicable release and live-conformance gates
still apply.

Do not commit credentials, local Factory state,
installation receipts, provider output, or private fixtures. A release candidate is published only
after `npm run verify:release` and the applicable prepublication gates in
[docs/CONFORMANCE.md](docs/CONFORMANCE.md). The final verified tag also requires that candidate's
post-publication clean-install gate.

By contributing, you agree that your contribution is licensed under the
[MIT License](LICENSE).
