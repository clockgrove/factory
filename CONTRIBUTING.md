# Contributing to Factory

Bug reports, documentation improvements, tests, and code contributions are welcome. You do not need
Factory or a coding agent installed to contribute to the repository.

Start with [development setup](#set-up-development), make a [focused change](#make-a-focused-change),
[validate it](#validate-changes), and [submit a pull request](#submit-a-pull-request). Documentation
fixes and clear bug reports are useful contributions too.

Looking for a place to help? Browse [help-wanted issues](https://github.com/clockgrove/factory/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22help%20wanted%22).
Some need access to a specific Linux host environment; read the scope and coordinate in the issue
before running live qualification. Small documentation fixes can go straight to a pull request.

## Before proposing a change

Search the [existing issues](https://github.com/clockgrove/factory/issues) before opening a new one.
For a bug, include the affected version, your environment, reproduction steps, and expected versus
actual behavior. Use sanitized logs and a small example where possible.

Discuss substantial features or architectural changes in an issue before implementing them,
particularly new providers, credential classes, durable protocols, or public APIs. Small fixes and
documentation improvements can go straight to a PR. The
[Factory Project](https://github.com/orgs/clockgrove/projects/1) tracks current priorities;
[docs/DESIGN.md](docs/DESIGN.md) describes the architecture and supported scope.

Report suspected vulnerabilities privately through [SECURITY.md](SECURITY.md), not a public issue.
For usage questions, see [SUPPORT.md](SUPPORT.md).

## Set up development

Use Linux, including Windows WSL2 or a Linux guest on macOS, with Git, Node.js 20 or later, and the
npm version declared in [`package.json`](package.json). Use a Node.js version supported by that npm
release. Native Windows and macOS process lifecycle support is outside the project's scope.

Fork the repository on GitHub, clone your fork, and create a branch for your change. From the
repository root, install the locked dependencies:

```sh
npm ci
```

The implementation is in `src/`, tests in `test/`, and development scripts in `scripts/`.
Build the committed distribution bundles when your change affects them:

```sh
npm run build
```

## Make a focused change

Prefer the simplest solution that satisfies the current requirement. Consider deletion and reuse
before adding abstractions, recovery paths, or persistent state. Explain substantial design choices
briefly in the PR; hypothetical future flexibility alone does not justify extra complexity.

Follow existing code conventions and keep unrelated cleanup out of your PR. Preserve authorization,
security, and data-integrity boundaries. GitHub is Factory's durable control plane; production
GitHub access uses Octokit and the shared controls in `src/platform.ts`. See
[docs/DESIGN.md](docs/DESIGN.md) for the detailed contract and [AGENTS.md](AGENTS.md) for coding-agent
instructions.

## Validate changes

During implementation, run typecheck, changed-file format/lint checks, and the tests that cover the
affected behavior. Before opening or merging a code pull request, run the repository PR gate against
the intended base:

```sh
npm run test:pr -- --base origin/main
```

`test:pr` runs typecheck, Biome only on changed code/configuration, eight critical contract files,
directly changed tests, and dependency-selected regressions for ordinary source changes. Package,
schema, workflow, and shared test-support surfaces use explicit impact rules. Deep Supervisor
scenario matrices run here only when directly changed or selected by an impact rule; the complete
matrix remains in `test:main`. The command prints its selected files, worker count, phase timings,
and deferred deep scenarios in the log and CI summary. The PR gate never promotes itself to the
complete deterministic suite. Add a regression test for a bug fix. If you add or change shared test
support, add its fail-closed `prImpactRules` mapping in `scripts/verify-pr.mjs`. `npm run format`
applies formatting to the configured code files. Live-provider tests use separate, opt-in commands.
Record any checks you could not run and the reason.

After a related batch lands on `main`, CI runs `npm run test:main` once: full typecheck, lint,
formatting, deterministic tests, and schemas. Its uploaded JSON result names the exact successful
commit and tree. The small PR gate uses up to four file workers. The complete main suite uses at
most two because its process-heavy Supervisor scenarios also consume subprocess and mock-service
capacity; higher file concurrency causes resource starvation rather than useful parallelism. Do not
rerun the full suite between each repair when focused checks cover the change.

For documentation-only changes, check the diff, links, and examples. The current format command
covers code and configuration, not Markdown. If you change install, upgrade, or uninstall
instructions, exercise that flow against the published artifact when available; staged verification
does not establish that the published artifact works.

For changes that depend on external APIs, verify assumptions against official documentation and,
when authorized, a real service. Tests against fakes alone do not establish external behavior.
Live checks that mutate repositories or use paid providers require explicit authorization.

Maintainers coordinate release qualification using
[docs/CONFORMANCE.md](docs/CONFORMANCE.md#release-verification-procedure). A routine contributor PR
does not require coverage, packaging, reproducibility, installation, audit, publishing, or live
qualification. Maintainers run `npm run verify:candidate` once on a stable exact commit after related
fixes settle. Keep concise verification results in the PR; generated release observations belong in
ignored `release/evidence/`.

## Submit a pull request

Open a PR against `main` with one focused outcome. Use the PR template and include:

- What changed and why, with a linked issue when applicable.
- How you verified the change, including the actual commands and any unrun checks.
- Relevant compatibility, security, credential, spending, or public API implications.
- Updates to documentation, tests, schemas, changelog, and generated bundles where applicable.

Do not include credentials, local Factory state, installation receipts, private fixtures, or
unrelated generated changes. Maintainers handle project-status tracking, integration, and releases.
See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for community expectations.

## Tracking work

Maintainers use the [Factory Project](https://github.com/orgs/clockgrove/projects/1) to schedule work.
See the [tracking procedure](docs/MAINTAINING.md#tracking-work) for field meanings and updates.
Contributors without Project access can continue authorized work and note any pending update.

If you run a live smoke or qualification scenario, follow the
[fixture retirement procedure](docs/MAINTAINING.md#retire-qualification-fixtures). Every disposable
fixture needs a recorded disposition, including after failure or cancellation.

## AI-assisted contributions and licensing

AI-assisted contributions are welcome and receive the same review as other contributions. You are
responsible for understanding and verifying the submitted code, its license compatibility, and the
claims in your PR. Do not include private prompts or transcripts; summarize relevant decisions and
verification instead. No particular model or agent workflow is required.

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
