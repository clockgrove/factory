# ADR 0007 — Product scope

Date: 2026-09-04

Status: accepted

## Context

Factory targets indie developers and small teams using one local computer, with optional cloud
capacity. The scope prioritizes reliable local execution, bounded spending, and GitHub-native
delivery over a broad catalog of integrations.

Factory also needs a precise platform statement. Windows WSL2 and a Linux guest on macOS are Linux
execution environments; supporting those does not imply native Win32 or Darwin lifecycle support.

## Decision

The scope includes:

- the Agent Plugin and `@clockgrove/factory` npm CLI/controller;
- Linux execution on native Linux, Windows WSL2, or a Linux guest hosted by macOS;
- Codex SDK local workers, Codex CLI fallback, and adaptive single-host admission;
- GitHub Copilot and OpenAI Codex managed agents;
- Daytona as the supported third-party sandbox;
- regular and native stacked GitHub pull requests; and
- GitHub-only durable orchestration with no required workflow, UI, or hosted Factory service.

Every supported capability passes the applicable deterministic, security, recovery, package, and
live-provider conformance gates. Paid execution remains off by default and explicitly budgeted.

Vercel Sandbox, Codex App Server, and additional provider/harness adapters are Labs. Native Win32
and Darwin lifecycle/execution and multi-machine local clusters are out of scope.

## Consequences

- `CONFORMANCE.md` records verification results and remaining gaps.
- Daytona and both managed agents are release gates; Vercel and App Server live evidence is not.
- The Codex managed profile remains unavailable until its gate records a stable,
  provider-published actor identity; a display name is not identity evidence.
- Native stacked pull requests are release-critical and retain a recorded regular-PR fallback.
- The `systemd` lifecycle runs inside Linux even when Windows or macOS hosts that environment.
- Plugin and npm artifacts are versioned and verified together; neither installation starts the
  controller or mutates a repository.
