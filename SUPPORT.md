# Support policy

Factory is an open-source preview, not a hosted service or paid support product. Maintainers and the
community help on a best-effort basis.

## Supported v2 boundary

| Area | V2 contract |
|---|---|
| Runtime | Linux: native Linux, Windows WSL2, or a Linux guest hosted by macOS |
| Distribution | Agent Plugin plus `@clockgrove/factory` npm CLI/controller |
| Local execution | Codex SDK in exact-SHA worktrees, with Codex CLI as supported fallback |
| Delivery | Regular PRs serialize complete Work Item pipelines; native stacks retain dependency-ready concurrency with cascading revalidation |
| Cloud sandbox | Daytona, only with explicit provider and budget authority |
| Managed agents | GitHub Copilot and OpenAI Codex release targets, only with explicit session authority and after their publication-blocking live gates pass |
| Labs | Vercel Sandbox, Codex App Server, and additional harness/provider adapters |
| Out of scope | Native Win32/Darwin execution or lifecycle, multi-local-machine clusters, custom UI, required hosted service |

The contract describes the intended v2 preview. Current proof and open release gates are listed in
[docs/CONFORMANCE.md](docs/CONFORMANCE.md). Until the npm artifact is published, use the plugin or
source-checkout path documented in the README.

## Ask for help

Before opening an issue, read [README.md](README.md),
[docs/HOST-SCHEDULING.md](docs/HOST-SCHEDULING.md), and
[docs/CREDENTIALS.md](docs/CREDENTIALS.md). Search existing issues, then use the bug-report or
feature-request template.

Include Factory and Node.js versions, installation method, Linux environment, repository visibility,
the command or chat operation, expected/actual behavior, and the smallest sanitized diagnostic. Do
not include tokens, private source, raw environment dumps, provider credentials, or unsanitized agent
transcripts.

Use private vulnerability reporting for security issues as described in
[SECURITY.md](SECURITY.md). Public issues containing secrets may be removed immediately.

## Version policy

During preview, the latest published v2 prerelease and `main` receive fixes. Older v2 previews are
best-effort and may require upgrade before diagnosis. V1 remains a compatibility protocol for
existing runs, not a separately developed feature line. Breaking preview changes must include a
migration note and preserve safe reconstruction of already-active supported runs.
