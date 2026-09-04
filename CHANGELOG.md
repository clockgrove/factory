# Changelog

Notable changes to Factory. See [the delivery plan](docs/DELIVERY-PLAN.md) for upcoming work.

## Unreleased

### Added

- GitHub-only control protocol with immutable compiled graphs, compare-and-swap leases,
  deterministic attempts, and restart reconstruction.
- Repository controller and explicit Linux `systemd` lifecycle.
- Official Codex SDK local backend with Codex CLI as the supported portable fallback.
- Cost-aware Objective compiler, native sub-issue dependencies, adaptive local scheduling, priority,
  bounded cloud burst, independent validation, replay, explanations, and economic evidence.
- Regular and native stacked pull-request delivery with exact-head validation and recovery.
- Daytona execution adapter and provider-neutral managed-agent contract.
- Labs adapters for Vercel Sandbox and Codex App Server.
- Formal npm package contract for `@clockgrove/factory` alongside the Agent Plugin.
- Provider-reported input/output/cached-input token breakdowns in existing durable receipts, with
  explicit partial-coverage reporting and unchanged model-token budget totals.

### Changed

- Local Codex execution is the default; paid execution is always explicitly authorized and bounded.
- The supported runtime is Linux on native Linux, Windows WSL2, or a Linux guest hosted by macOS.
- Compiler navigation guidance now reaches local CLI/SDK workers without expanding edit scope.
- Factory acceptance review remains mandatory; external Copilot PR review is an optional second
  opinion, not an installation dependency or a substitute for acceptance evidence.

### Security

- Rejected management output retains observed token usage, with checkpoint-first recovery and
  failed-invocation replay protection.

- Workers are treated as untrusted artifact producers without GitHub mutation, merge, budget, or
  Director authority.
- Credentials are stripped or brokered by name, artifacts are independently validated, mutations are
  fenced, and sandbox/managed execution requires native-unit budget limits.

### Release gates

- Publish and clean-install the synchronized npm and Agent Plugin artifacts.
- Complete the native Linux, Windows WSL2, and macOS-hosted Linux matrix.
- Complete live native-stack, Daytona, GitHub Copilot, OpenAI Codex, and adversarial Objective runs.
