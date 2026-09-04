# GitHub-managed agent runners

[Setup home](README.md)

## TL;DR

1. Complete [local setup](local.md); local compilation/management and GitHub access are still required.
2. Choose `github-copilot/github-managed` or `openai-codex/github-managed` and check
   [conformance status](../CONFORMANCE.md) before treating it as usable.
3. Enable the corresponding provider integration for the exact target GitHub repository and identity.
4. Ask Factory to inspect repository/provider gates before approving sessions. A generic backend probe
   alone does not prove repository-specific availability.
5. Approve the exact backend, a nonzero managed-session budget, validator resources, and controller
   paid capacity if running unattended. Provider sessions may consume GitHub Actions minutes.

**Current blocker:** the bundled Codex-managed profile remains unavailable until its live identity
 gate records a stable provider-published identity. Local Codex login or an OPENAI_API_KEY cannot fix it.

## Detailed setup and boundaries

Copilot requires the coding-agent integration to be enabled and assignable in the target repository.
The GitHub identity used by Factory must have access there, including for private repositories.
There is no local Copilot model-key variable that connects the integration. Codex-managed is distinct
from local Codex SDK/CLI and the local App Server adapter; do not substitute one identity for another.

Configure host GitHub access using [credential placement](configuration.md#2-put-each-setting-in-the-correct-place).
If executing unattended, configure the [controller](unattended.md) separately. Factory installs no
GitHub workflow; opting into a provider's hosted sessions is a separate execution/cost decision.

## Authorization and verification

Follow [paid authorization](configuration.md#6-authorize-capacity-and-spending-separately), including
maxManagedAgentSessions and an independently authorized validation backend. A provider session is
not proof that Factory can validate and integrate its output. Inspect doctor/status/explain for
recorded gates and reasons; approve a bounded live test only after the necessary gates are resolved.
If GitHub works but a managed profile does not, inspect integration, assignability, and identity
conformance—not another model-key export. Do not make a private repo public to bypass an auth error.
