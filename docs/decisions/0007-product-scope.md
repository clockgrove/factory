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

Every claimed supported capability passes the applicable deterministic, security, recovery, package,
and live-provider conformance gates. Unsupported third-party features are documented per provider;
their absence does not block the entire product. Paid execution remains off by default and explicitly
budgeted. Factory reuses providers under the user's direct subscription and billing relationship.
Session/resource caps are not guaranteed dollar caps, unknown costs remain unavailable, and provider
billing settlement finality is not required. Exact active-compute and cleanup evidence remains required
before releasing resource obligations or admitting unsafe replacements.

Vercel Sandbox, Codex App Server, and additional provider/harness adapters are Labs. Native Win32
and Darwin lifecycle/execution and multi-machine local clusters are out of scope.

## Consequences

- `CONFORMANCE.md` records verification results and remaining gaps.
- Daytona retains its live release gate. **Managed-provider capability boundaries** requires exact
  evidence for each provider's claimed behavior and explicit limits for unavailable features; it does
  not require every managed provider to offer the same API. Vercel and App Server remain Labs.
- Copilot has limited automation, including an operator boundary when exact-session termination cannot
  be automated. Codex managed execution remains unavailable until an authoritative identity and real
  provider-specific lifecycle interface are implemented and qualified; a display name is not identity.
- Native stacked pull requests are release-critical and retain a recorded regular-PR fallback.
- The `systemd` lifecycle runs inside Linux even when Windows or macOS hosts that environment.
- Plugin and npm artifacts are versioned and verified together; neither installation starts the
  controller or mutates a repository.
