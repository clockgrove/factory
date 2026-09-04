# ADR 0007 — One Factory v2 preview contract

Date: 2026-09-04

Status: accepted

## Context

Factory v2 intentionally combines new control-plane, scheduling, provider, and GitHub delivery
capabilities before its first public v2 release. Assigning separate “preview” or “experimental”
labels to every upstream dependency obscures the actual product promise. At the same time, treating
every implemented adapter as release-critical would spend qualification effort on breadth rather
than proving the local-first product.

Factory also needs a precise platform statement. Windows WSL2 and a Linux guest on macOS are Linux
execution environments; supporting those does not imply native Win32 or Darwin lifecycle support.

## Decision

Factory v2 is one preview product. Its support contract contains:

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

- Public documentation applies the preview designation once, to Factory v2 as a whole.
- `CONFORMANCE.md` may record open evidence without inventing per-feature maturity tiers.
- Daytona and both managed agents are release gates; Vercel and App Server live evidence is not.
- The Codex managed profile remains unavailable until its gate records a stable,
  provider-published actor identity; a display name is not identity evidence.
- Native stacked pull requests are release-critical and retain a recorded regular-PR fallback.
- The `systemd` lifecycle runs inside Linux even when Windows or macOS hosts that environment.
- Plugin and npm artifacts are versioned and verified together; neither installation starts the
  controller or mutates a repository.
