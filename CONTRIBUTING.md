# Contributing to Factory

Factory is a clean-room TypeScript/Node implementation. Do not copy architecture, documentation,
skills, or vocabulary from `clockgrove/factory-legacy`.

## Before proposing a change

Read, in order:

1. [`docs/PRD.md`](docs/PRD.md) for product decisions and non-goals.
2. [`docs/IMPLEMENTATION-PLAN.md`](docs/IMPLEMENTATION-PLAN.md) for the technical design.
3. [`AGENTS.md`](AGENTS.md) for repository engineering rules.

Keep changes narrowly scoped. GitHub is Factory's durable state: do not add sidecar state, status
labels, queues, services, or workflows that reconstruct the orchestration loop outside the harness.
All GitHub access in `src/` must use Octokit, and every write must pass through the pacing,
concurrency, and circuit-breaker controls in `src/platform.ts`.

## Validate changes

Use Node.js 20 or later:

```bash
npm install
npm test
npm run typecheck
npm run build
npm run verify:package
```

`verify:package` checks the committed plugin manifests and skills, starts the bundled MCP server
through the manifest's own command and arguments, and verifies its public tool surface.

Tests against fakes establish Factory's behavior for a response; they do not establish that a GitHub
endpoint or response shape exists. Any new GitHub API claim must also be checked against current
official documentation and, where permissions allow, verified with a read or bounded rehearsal
against a real repository.

## Pull requests

Explain the user-visible behavior, the evidence supporting any GitHub API assumptions, and the
validation performed. Never include credentials, repository secrets, or private test data.

By contributing, you agree that your contribution will be licensed under the repository's selected
license once that license is added. Do not submit contributions until that license is published if
those terms are unacceptable.
