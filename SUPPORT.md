# Support policy

Maintainers and the community provide best-effort help with Factory. There is no paid support SLA.

## Product support contract

| Area | Intended contract |
|---|---|
| Runtime | Linux: native Linux, Windows WSL2, or a Linux guest hosted by macOS |
| Distribution | Agent Plugin plus `@clockgrove/factory` npm CLI/controller |
| Local execution | Codex SDK in exact-SHA worktrees, Codex CLI fallback, and explicit Codex App Server with durable terminal recovery |
| Delivery | Dependency-ready regular or native-stack work executes concurrently; exact-head integration is serialized and revalidated |
| Cloud sandbox | Daytona, only with explicit provider and budget authority |
| Managed agents | Copilot's supported capabilities require explicit session authority and live qualification; Codex managed execution remains unavailable pending supported identity/lifecycle interfaces |
| Labs | Vercel Sandbox and additional harness/provider adapters |
| Out of scope | Native Win32/Darwin execution or lifecycle, multi-local-machine clusters, custom UI, required hosted service |

Current proof and open release gates are listed in
[verification status](https://github.com/clockgrove/factory/blob/main/docs/CONFORMANCE.md);
upcoming work is tracked in [GitHub issues](https://github.com/clockgrove/factory/issues). Until the npm
artifact is published, use the plugin or source-checkout path documented in the README.

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

## Fixes

Fixes are developed against `main`. Include the affected commit or package version in support
requests. Changes to run recovery must preserve safe reconstruction or fail closed on incompatible
receipts.
