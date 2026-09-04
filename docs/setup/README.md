# Factory setup guides

[Back to Factory](../../README.md)

## TL;DR

Start with the [local runner](local.md). Install the plugin, authenticate in Linux, inspect your
Objective, then authorize local execution. Add a cloud provider only when you want it.
For work that continues after chat disconnects, add the [unattended controller](unattended.md).

## Choose your path

| I want to… | Guide |
|---|---|
| Get started on one Linux machine, WSL2, or Linux guest on macOS | [Local runner](local.md) |
| Keep scheduling after closing chat | [Unattended controller](unattended.md) |
| Use a third-party sandbox or burst local work into cloud | [Daytona](daytona.md) |
| Use provider-managed GitHub coding sessions | [GitHub-managed agents](github-managed.md) |
| Explore the bundled Vercel adapter | [Vercel Sandbox — Labs](vercel-sandbox.md) |
| Explore the local Codex protocol adapter | [Codex App Server — Labs](codex-app-server.md) |

Each guide starts with a TL;DR, then configuration, verification, and troubleshooting detail.
Factory is still under development; [conformance status](../CONFORMANCE.md) distinguishes implemented
adapters from verified live capability. Optional provider failures do not block local-only setup.

## Understand the three choices

- **Entry point:** the plugin exposes chat/MCP; the npm package is an alternative CLI distribution.
  The plugin does not require npx, and npm installation does not install chat skills.
- **Lifetime:** run in the foreground, or explicitly install a Linux repository controller for
  unattended scheduling. Neither choice changes which repository you must identify.
- **Runner:** local workers by default, or an explicitly authorized sandbox/managed provider.
  Cloud workers do not remove the Linux host's local management requirements.

You do not need to install everything in this table. GitHub holds durable state; the local
controller supplies scheduling. Factory requires no GitHub workflow or hosted Factory service.

## Detailed reference

[Shared configuration](configuration.md) covers exact process environments, credential placement,
backend requirements, paid authorization, probes, and cross-provider troubleshooting.
[Credential boundaries](../CREDENTIALS.md) describes isolation; [host scheduling](../HOST-SCHEDULING.md)
describes lifecycle and recovery. Never paste provider credentials into chat or repository files.
