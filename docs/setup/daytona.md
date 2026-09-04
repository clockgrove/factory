# Daytona sandbox runner

[Setup home](README.md) · Backend: `codex-cli/daytona`

## TL;DR

1. Complete [local setup](local.md): GitHub and local Objective management still run on your Linux host.
2. In your Daytona organization, create a model-key Secret with hosts exactly
   `["api.openai.com"]`. Keep the model key in Daytona.
3. Give the executing Factory process `DAYTONA_API_KEY` and `FACTORY_DAYTONA_MODEL_SECRET`.
   The second value is the Secret's **name**, not the model key.
4. Run a read-only backend probe in that environment and inspect the Daytona result.
5. Approve a complete paid-run policy and, for unattended work, a nonzero controller paid ceiling.
   Only then approve a bounded live test; a successful probe does not authorize spending.

**Success looks like:** the probe accepts the provider credentials and exact Secret metadata.
A separate approved live test must demonstrate execution, independent validation, and cleanup.
Check [current conformance](../CONFORMANCE.md); this guide is not a claim that live gates passed.

## Detailed credential setup

The API key authenticates Factory to Daytona. The model Secret supplies the worker's model access.
Factory requires exactly one Secret with the configured name and rejects empty, wildcard, or extra
hosts. A local Codex subscription login is not a replacement for this separately brokered API key.
See [Daytona credential boundaries](../CREDENTIALS.md#daytona) for the adapter's isolation contract.

For a foreground plugin, follow the exact [Bash launch example](configuration.md#4-foregroundplugin-setup-configure-the-parent-before-launching-it).
Set variables before launching the client; a repo .env is not loaded. For a durable controller,
follow [unattended service configuration](unattended.md#detailed-service-configuration) instead.
Configuring the client does not configure the separate service. Do not paste keys into chat.

## Budget and execution setup

Follow [capacity and spending](configuration.md#6-authorize-capacity-and-spending-separately).
Allow the exact Daytona backend, explicit cloud fallback, bounded sandbox minutes, and required
network destinations. Actual overflow also requires an enabled burst policy and its trigger limits.
Independent validation uses a fresh sandbox and consumes its own resource reservation. Retain
provider-side spending limits and hard TTLs; local accounting cannot stop a disconnected provider.

## Verification and troubleshooting

Use [read-only verification](configuration.md#7-verify-the-same-environment-that-will-do-the-work).
Wrong Secret metadata: check organization, exact name, unique match, and exact hosts.
Chat works but controller fails: check the service environment attachment and restart.
Authentication works but no cloud worker starts: inspect policy, burst trigger, validation resources,
and the controller's default zero paid capacity. Never broaden permissions merely to silence a gate.
