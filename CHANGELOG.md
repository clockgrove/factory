# Changelog

Notable changes to Factory. See [the delivery plan](docs/DELIVERY-PLAN.md) for upcoming work.

## Unreleased

### Added

- Immutable recovery-plan and predecessor-chain verification contracts, with authenticated request
  bindings and explicit cumulative allowance increments. Execution remains gated on the unfinished
  adoption and resource-reconciliation transaction.
- Read-only recovery assessment through chat/MCP and CLI, with graph/PR identity checks and
  historical cumulative accounting. Successor execution and additional spending still require
  a separate implemented authorization path.
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

- Native linear-stack Daytona execution uses immutable, independently sandboxed rebase validation
  and separate paid capacity/accounting before semantic review. Runtime qualification remains open.
- Native-mode independent siblings retain parallel execution and validate the combined merge tree
  after another Work Item in the same run advances trunk. Durable candidate/review checkpoints
  preserve original PR heads, budget history, and response-loss recovery; external advances remain
  an escalation boundary.
- Recovery inspection distinguishes graph-derived native-stack units from independent sibling PRs.
- Local Codex execution is the default; paid execution is always explicitly authorized and bounded.
- The supported runtime is Linux on native Linux, Windows WSL2, or a Linux guest hosted by macOS.
- Compiler navigation guidance now reaches local CLI/SDK workers without expanding edit scope.
- Factory acceptance review remains mandatory; external Copilot PR review is an optional second
  opinion, not an installation dependency or a substitute for acceptance evidence.

### Security

- Validation and budget receipts cannot be written using another run's reservation under a current
  lease; same-run fenced takeover remains supported.
- New activations reject predecessor execution that cannot yet be adopted safely, including
  reservation refs with missing comments and startup races. Existing PRs and accounting remain
  untouched; explicit successor-run recovery is still an open implementation task.
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
