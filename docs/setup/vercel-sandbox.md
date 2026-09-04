# Vercel Sandbox runner (Labs)

[Setup home](README.md) · Backend: `codex-cli/vercel-sandbox`

## TL;DR

1. Complete [local setup](local.md). This Labs adapter is outside initial delivery scope.
2. Supply `VERCEL_OIDC_TOKEN` and `OPENAI_API_KEY` to the executing Factory process.
3. Probe the backend without launching resources.
4. Approve the exact paid backend, sandbox budget, validation capacity, and optional burst policy.
   An unattended controller also needs an explicitly nonzero paid ceiling.

**Success looks like:** the adapter reports available in the intended environment. This is not proof
of an end-to-end paid run; check [conformance status](../CONFORMANCE.md).

## Detailed configuration

Use [foreground environment wiring](configuration.md#4-foregroundplugin-setup-configure-the-parent-before-launching-it)
or [unattended service wiring](unattended.md), supplying the two variables above instead of Daytona's.
Vercel does not use FACTORY_DAYTONA_MODEL_SECRET. Its request transformation supplies the model
Authorization header while the worker sees a placeholder. See [credential boundaries](../CREDENTIALS.md#vercel-sandbox-labs).
Do not store keys in repo .env files, prompts, or plugin manifests. Local subscription authentication
is not the host OPENAI_API_KEY required by this adapter.

## Authorization and troubleshooting

Apply [paid policy and capacity checks](configuration.md#6-authorize-capacity-and-spending-separately)
and [read-only verification](configuration.md#7-verify-the-same-environment-that-will-do-the-work).
Expired provider credentials need renewal and an affected-process restart. A successful shell probe
cannot establish the separate controller's environment. Reserve independent validation resources
and provider-side spending limits before approving a bounded live test.
