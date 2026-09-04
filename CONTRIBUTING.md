# Contributing to Factory

Contributions are welcome, including AI-assisted contributions. The author remains responsible for
the code, tests, licensing,
security boundary, and claims in the pull request.

## Before proposing a change

Read [`docs/DESIGN.md`](docs/DESIGN.md) first. It states the goals, the non-goals, and the rules that
changes are judged against; [`AGENTS.md`](AGENTS.md) states the engineering conventions.
The current implementation waves are tracked in [`docs/DELIVERY-PLAN.md`](docs/DELIVERY-PLAN.md).

Keep changes narrowly scoped. GitHub is Factory's durable state: do not add sidecar state, status
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

Add the narrowest unit or fault-injection test that would fail without your change. Changes to a
provider, GitHub behavior, platform lifecycle, install path, or other external contract also need
the applicable conformance evidence; do not convert a fake-provider test into a live-support claim.

`verify:package` checks the committed plugin manifests and skills, starts the bundled MCP server
through the manifest's own command and arguments, and verifies its public tool surface. It also
installs a staged copy through an isolated `CODEX_HOME` using the Codex CLI and starts the installed
MCP and repository-controller executables. The check does not use the development worktree's Codex
configuration or credentials and does not create a paid provider resource. `npm run verify:release`
runs typecheck, lint, formatting, coverage, schema, deterministic-build, plugin, npm-package, and
production-audit gates as one command.

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

Work on a branch and submit a pull request. Do not commit credentials, local Factory state,
installation receipts, provider output, or private fixtures. A release candidate is published only
after `npm run verify:release` and the applicable prepublication gates in
[docs/CONFORMANCE.md](docs/CONFORMANCE.md). The final verified tag also requires that candidate's
post-publication clean-install gate.

By contributing, you agree that your contribution is licensed under the
[MIT License](LICENSE).
