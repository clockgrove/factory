# Local Codex App Server sessions

[Setup home](README.md) · Backend: `codex-app-server/local-worktree`

## TL;DR

1. Complete [local setup](local.md) with the Linux Codex executable and login.
2. Ask for a read-only backend probe and inspect the App Server result.
3. Request this backend explicitly in the complete run policy, retaining the intended model,
   reasoning, trust, network destinations, local resource limits and budget. The SDK-first/CLI
   default is unchanged; preferred-route promotion requires end-to-end qualification.

**What it is:** a local Codex protocol adapter, not a hosted Factory server and not GitHub-managed
Codex. It needs no Daytona or Vercel credentials. Durable sessions are implemented on the
explicit route; that does not establish a live qualification pass.

## Detailed configuration

The actual Factory process must resolve the compatible local executable and intended Linux login.
See [process selection](configuration.md#1-identify-the-process-that-will-execute-the-objective) and
[provider requirements](configuration.md#3-configure-the-chosen-provider-not-every-provider).
For a background controller, also follow [unattended setup](unattended.md); a terminal login or PATH
is not proof the service can find the same executable. FACTORY_CODEX_PATH selects an executable,
not an authentication mode or a command with arguments.

The durable-session implementation is pinned to Codex **0.153.0**. Initialization rejects
other versions before a model turn. Each attempt retains its exact provider home, thread
and turn, with immutable preparation/dispatch/terminal checkpoints in GitHub. Cancellation
interrupts the owned turn and drains its process scope; a successful interrupt request is
not a terminal receipt or known usage.

Cold recovery reads the exact terminal turn without starting or resuming model work. A ready
durable artifact wins before session collection; otherwise a successful terminal checkpoint
with complete usage can continue through ordinary artifact validation/publication, preserving
the original attempt. Exact resource absence and current ownership remain required.

**Cold same-thread repair is currently unavailable:** pinned `thread/resume` cannot enable
the raw-response accounting subscription needed for a new repair turn. Factory refuses
that dispatch rather than replacing the thread or estimating missing model usage. Missing
provider state, ambiguous dispatch, unknown interrupted usage and partial validation remain
fenced. These adapter limits do not block other supported local backends.

See [the session and accounting contract](../CODEX-APP-SERVER-SESSIONS.md) for exact supported
boundaries and remaining qualification.

## Verification and troubleshooting

Follow [read-only checks](configuration.md#7-verify-the-same-environment-that-will-do-the-work) and
[current conformance](https://github.com/clockgrove/factory/blob/main/docs/CONFORMANCE.md).
A protocol/version gate is not a missing sandbox API key.
A local App Server probe says nothing about GitHub-managed identity readiness. Local work uses your
model account's normal cost/quota and must remain within the approved trust and run-policy boundaries.
