# Changelog

Notable user-visible changes are recorded here. Factory follows semantic versioning; v2 preview
builds are published through npm's `next` distribution tag.

## Unreleased — Factory v2 preview

### Added

- GitHub-only v2 control protocol with immutable compiled graphs, compare-and-swap leases,
  deterministic attempts, and restart reconstruction.
- Repository controller and explicit Linux `systemd` lifecycle.
- Official Codex SDK local backend with Codex CLI as the supported portable fallback.
- Cost-aware Objective compiler, native sub-issue dependencies, adaptive local scheduling, priority,
  bounded cloud burst, independent validation, replay, explanations, and economic evidence.
- Regular and native stacked pull-request delivery with exact-head validation and recovery.
- Daytona execution adapter and provider-neutral managed-agent contract.
- Labs adapters for Vercel Sandbox and Codex App Server.
- Formal npm package contract for `@clockgrove/factory` alongside the Agent Plugin.

### Changed

- Local Codex execution is the default; paid execution is always explicitly authorized and bounded.
- The supported runtime is Linux on native Linux, Windows WSL2, or a Linux guest hosted by macOS.
- The complete v2 release is designated preview rather than assigning separate preview labels to
  individual v2 capabilities.

### Security

- Workers are treated as untrusted artifact producers without GitHub mutation, merge, budget, or
  Director authority.
- Credentials are stripped or brokered by name, artifacts are independently validated, mutations are
  fenced, and sandbox/managed execution requires native-unit budget limits.

### Release gates

- Publish and clean-install the synchronized npm and Agent Plugin artifacts.
- Complete the native Linux, Windows WSL2, and macOS-hosted Linux matrix.
- Complete live native-stack, Daytona, GitHub Copilot, OpenAI Codex, and adversarial Objective runs.

## 1.0.1 — 2026-09-01

- Preserved the original GitHub Copilot execution protocol now documented as v1 compatibility.

## 1.0.0 — 2026-09-01

- Initial open-source Factory release.
