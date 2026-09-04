# Contributing to Factory

## Before proposing a change

Read [`docs/DESIGN.md`](docs/DESIGN.md) first. It states the goals, the non-goals, and the rules that
changes are judged against; [`AGENTS.md`](AGENTS.md) states the engineering conventions.

Keep changes narrowly scoped. GitHub is Factory's durable state: do not add sidecar state, status
labels, queues, services, or workflows that reconstruct the orchestration loop outside the harness.
All GitHub access in `src/` must use Octokit, and every write must pass through the pacing,
concurrency, and circuit-breaker controls in `src/platform.ts`.

## Validate changes

Use Node.js 20 or later:

```bash
npm ci
npm run typecheck
npm test
npm run verify:package
npm audit --omit=dev
```

`verify:package` checks the committed plugin manifests and skills, starts the bundled MCP server
through the manifest's own command and arguments, and verifies its public tool surface. It also
installs a staged copy through an isolated `CODEX_HOME` using the Codex CLI and starts the installed
MCP and repository-controller executables. The check does not use the development worktree's Codex
configuration or credentials and does not create a paid provider resource. `npm run verify:release`
runs the same release gates as one command.

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
  instructions, run them end to end against the published artifact. Reviewing them for plausibility
  is not the same thing.

## Pull requests

Explain the user-visible behavior, the evidence supporting any GitHub API assumptions, and the
validation performed. Never include credentials, repository secrets, or private test data.

By contributing, you agree that your contribution is licensed under the
[MIT License](LICENSE).
