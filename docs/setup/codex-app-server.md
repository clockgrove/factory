# Local Codex App Server runner (Labs)

[Setup home](README.md) · Backend: `codex-app-server/local-worktree`

## TL;DR

1. Complete [local setup](local.md) with the Linux Codex executable and login.
2. Ask for a read-only backend probe and inspect the App Server result.
3. If deliberately testing this Labs adapter, request it explicitly in the complete run policy.
   Keep the default SDK/CLI path for normal local onboarding.

**What it is:** a local Codex protocol adapter, not a hosted Factory server and not GitHub-managed
Codex. It needs no Daytona or Vercel credentials. Labs is outside initial delivery scope.

## Detailed configuration

The actual Factory process must resolve the compatible local executable and intended Linux login.
See [process selection](configuration.md#1-identify-the-process-that-will-execute-the-objective) and
[provider requirements](configuration.md#3-configure-the-chosen-provider-not-every-provider).
For a background controller, also follow [unattended setup](unattended.md); a terminal login or PATH
is not proof the service can find the same executable. FACTORY_CODEX_PATH selects an executable,
not an authentication mode or a command with arguments.

## Verification and troubleshooting

Follow [read-only checks](configuration.md#7-verify-the-same-environment-that-will-do-the-work) and
[current conformance](../CONFORMANCE.md). A protocol/version gate is not a missing sandbox API key.
A local App Server probe says nothing about GitHub-managed identity readiness. Local work uses your
model account's normal cost/quota and must remain within the approved trust and run-policy boundaries.
