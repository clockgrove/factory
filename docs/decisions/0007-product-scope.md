# ADR 0007 — Product scope

Date: 2026-09-04

Amended: 2026-09-17 for the Initial Beta support boundary; 2026-09-18 for observable
native-stack qualification

Status: accepted

## Context

Factory targets indie developers and small teams using one local computer, with optional cloud
capacity. The scope prioritizes reliable local execution, bounded spending, and GitHub-native
delivery over a broad catalog of integrations.

Factory also needs a precise first-public-release statement. Implementing a host or provider route
does not make it part of the Initial Beta support claim before its live qualification passes.

## Decision

The Initial Beta scope includes:

- the Agent Plugin and `@clockgrove/factory` npm CLI/controller;
- Linux execution under Windows WSL2, with Factory state and repositories in the Linux filesystem;
- Codex SDK local workers, Codex CLI fallback, and adaptive single-host admission;
- fair same-host multi-Objective sharing and durable explicit Codex App Server sessions;
- qualified GitHub Copilot managed execution, with its documented operator boundary;
- explicit refusal of OpenAI Codex managed execution until an authoritative provider identity and
  lifecycle interface are implemented and qualified;
- concurrent regular and native stacked GitHub pull requests;
- local LFS detection/tooling, binary/media manifests, and bounded large-file transport;
- installed application qualification through the Clockgrove pilot; and
- GitHub-only durable orchestration with no required workflow, UI, or hosted Factory service.

Every claimed supported capability passes the applicable deterministic, security, recovery, package,
and live-provider conformance gates. Unsupported third-party features are documented per provider;
their absence does not block the entire product. Paid execution remains off by default and explicitly
budgeted. Factory reuses providers under the user's direct subscription and billing relationship.
Session/resource caps are not guaranteed dollar caps, unknown costs remain unavailable, and provider
billing settlement finality is not required. Exact active-compute and cleanup evidence remains required
before releasing resource obligations or admitting unsafe replacements.

Native Linux, a Linux guest hosted by macOS, and Daytona retain implemented routes and deterministic
coverage but remain later qualification targets. Vercel Sandbox and additional provider/harness
adapters are Labs. Native Win32 and Darwin lifecycle/execution and multi-machine local clusters are
out of scope.

## Consequences

- `CONFORMANCE.md` records verification results and remaining gaps.
- **Managed-provider capability boundaries** requires exact evidence for each provider's claimed
  Initial Beta behavior and explicit limits for unavailable features; it does not require every
  managed provider to offer the same API. Daytona moves to its separately tracked later-provider
  qualification. Vercel remains Labs; explicit App Server session recovery retains its
  supported-route qualification and documented provider limitations.
- Copilot has limited automation, including an operator boundary when exact-session termination cannot
  be automated. Codex managed execution remains unavailable until an authoritative identity and real
  provider-specific lifecycle interface are implemented and qualified; a display name is not identity.
- Regular and native stacked pull-request delivery are release-critical and qualify independently.
  Factory retains the fail-closed transition from an originally requested native stack to regular
  PRs, but its live qualification is conditional on observing a genuine authenticated unsupported
  native-stack surface. When the release target supports native stacks, [#82](https://github.com/clockgrove/factory/issues/82)
  remains deferred and does not block Initial Beta. Available capability, ambiguous failures,
  authentication failures, and synthetic fixtures cannot qualify that transition.
- Application dogfood retains the complete scenario coverage in implementation-plan Wave 8.
  The rich-media appendix supplies generic acceptance inputs, not an exclusion from that gate;
  a bounded first pilot cannot discharge the remaining application scenarios.
- The Initial Beta `systemd` lifecycle runs inside WSL2 Linux. Later host qualification exercises
  the same Linux service contract without implying native Win32 or Darwin lifecycle support.
- Plugin and npm artifacts are versioned and verified together; neither installation starts the
  controller or mutates a repository.
