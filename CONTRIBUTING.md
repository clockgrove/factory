# Contributing to Factory

Bug reports, documentation improvements, tests, and code contributions are welcome. You do not need
Factory or a coding agent installed to contribute to the repository.

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

## Tracking work

Use the [Factory Project](https://github.com/orgs/clockgrove/projects/1) for scheduling and progress.
The Backlog view contains open work; the Now board shows the small set currently selected.
Issues describe a concrete problem, scope, acceptance and evidence. Link implementation PRs to
their issues. Use native issue dependencies for actual blockers and describe the clearing condition
in the issue. A shared topic or possible future benefit is not a dependency.

| Field | Meaning |
| --- | --- |
| Status | Backlog: unselected; Ready: selected next; In Progress: actively owned; Blocked: selected work waiting on a concrete prerequisite; Deferred: intentionally outside current work; Done: issue acceptance met and issue closed. |
| Priority | Now: current committed work; Next: selected follow-on work; Later: unselected or deferred. |
| Milestone | Use the native issue milestone only for a real delivery target. Do not invent release dates or create a duplicate Project field. |

Add a work issue to the Project once. Update fields at meaningful transitions, including when a PR
closes its issue; do not maintain a separate written status summary. Project membership is not
permission to start unselected work. Closing an implementation issue does not imply broad installed
qualification: put any remaining required scenario in a concrete linked issue before closing.
Assignees identify people actually owning work; do not invent agent identities or owner fields.

The former #69 summary is historical. Bounded parent issues may group a coherent feature, but must
not become another project-wide backlog. Repository documents describe contracts and procedures;
PRs and issues retain checks and relevant evidence. Publication is deferred in #88 until a release
is selected; #89 verifies its published artifacts afterward.

Use GitHub's native UI/API for updates. No polling controller, custom synchronization workflow,
second database or new tracking service is needed. If Project permissions are missing, continue
authorized work and report the specific pending update. Maintainers using `gh` need the `project`
scope for writes; request it with `gh auth refresh -h github.com -s project` when needed.

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

For code changes, run the static checks and tests that cover the affected behavior:

```sh
npm run typecheck
npm run lint
npm run format:check
npm test -- test/graph.test.ts
```

The last command is a focused-test example; select the relevant test file for your change. Add a
regression test for a bug fix. `npm run format` applies formatting to the configured code files.
`npm test` runs the default suite; live-provider tests use separate, opt-in commands. Some local
lifecycle tests require Linux systemd 254+ and a reachable user manager. Record any checks you could
not run and the reason.

For documentation-only changes, check the diff, links, and examples. The current format command
covers code and configuration, not Markdown. If you change install, upgrade, or uninstall
instructions, exercise that flow against the published artifact when available; staged verification
does not establish that the published artifact works.

For changes that depend on external APIs, verify assumptions against official documentation and,
when authorized, a real service. Tests against fakes alone do not establish external behavior.
Live checks that mutate repositories or use paid providers require explicit authorization.

Maintainers coordinate release qualification using
[docs/CONFORMANCE.md](docs/CONFORMANCE.md#release-verification-procedure). A routine contributor PR
does not require publishing, installing the plugin, or running the full release gate.

## Submit a pull request

Open a PR against `main` with one focused outcome. Use the PR template and include:

- What changed and why, with a linked issue when applicable.
- How you verified the change, including the actual commands and any unrun checks.
- Relevant compatibility, security, credential, spending, or public API implications.
- Updates to documentation, tests, schemas, changelog, and generated bundles where applicable.

Do not include credentials, local Factory state, installation receipts, private fixtures, or
unrelated generated changes. Maintainers handle project-status tracking, integration, and releases.
See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for community expectations.

## AI-assisted contributions and licensing

AI-assisted contributions are welcome and receive the same review as other contributions. You are
responsible for understanding and verifying the submitted code, its license compatibility, and the
claims in your PR. Do not include private prompts or transcripts; summarize relevant decisions and
verification instead. No particular model or agent workflow is required.

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
