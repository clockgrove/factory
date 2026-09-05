# Provider Objective qualification

The provider acceptance harness exercises Factory's **Supervisor**, not just backend methods. It uses
two independent foundational Work Items and a third Work Item that joins only after both integrate.

## Credential-free acceptance

```bash
npx vitest run test/provider-supervisor-qualification.test.ts test/provider-qualification-review.test.ts test/provider-objective-harness.test.ts test/validation-invocation.test.ts
```

These tests use the real scheduler, Git objects, graph/projection and review checkpoints, clean
validation, budget/capacity accounting, and publication decisions. GitHub and execution resources are
simulated; the transport denies network access. They prove orchestration contracts, not live provider
support. Both local/cloud completion orders, fresh candidate validation, join gating, changed trunk,
failed validation/review, uncertain cleanup, checkpoint response loss, and accounting restart are
covered. Copilot and Codex simulations each execute the complete three-item Objective without provider
fallback. That does not supply Codex's missing live actor identity.

Independent Daytona siblings use native delivery mode for concurrent pipelines; linear stacks remain
host-only. Regular PR mode remains serialized and cannot pass the burst-overlap gate. Every non-host
worker receives fresh independent validation, including `trusted_local` work that overflowed for
capacity. Accepted trusted-local work may feed local descendants; sandbox-untrusted work stays isolated.

## Opt-in installed-plugin exercise

No live provider exercise runs during ordinary tests or release verification. The runner is inert by
default:

```bash
node scripts/verify-provider-objective.mjs
```

Before an explicitly authorized live run, provide the existing installed-Objective inputs documented
in [conformance](CONFORMANCE.md): `FACTORY_LIVE_OBJECTIVE=1`, exact disposable repository and matching
mutation acknowledgment, clean Linux-filesystem checkout, actual installed plugin cache root, and a
fresh evidence directory. Then provide all provider-specific authority:

| Variable | Required value |
| --- | --- |
| `FACTORY_LIVE_PROVIDER` | `1` |
| `FACTORY_LIVE_PROVIDER_PROFILE` | `daytona-burst`, `github-copilot`, or `openai-codex` |
| `FACTORY_LIVE_PROVIDER_PAID_ACK` | `<profile>:<owner>/<disposable-repo>` |
| `FACTORY_LIVE_PROVIDER_CLEANUP_ACK` | `<owner>/<disposable-repo>:cancel-and-reconcile` |
| `FACTORY_LIVE_PROVIDER_MAX_SANDBOX_MINUTES` | Explicit integer from 10–120; covers worker and validators |
| `FACTORY_LIVE_PROVIDER_MAX_MODEL_TOKENS` | Explicit integer from 1,000–500,000 for observed local model usage |
| `FACTORY_LIVE_PROVIDER_MAX_MANAGED_SESSIONS` | Exactly `3` for a managed Objective; not used for Daytona burst |

Credentials remain in the installed environment; do not commit or place them in evidence. Daytona
requires its API credential and, for workers, the configured organization model Secret described in
[Daytona setup](setup/daytona.md). No model is changed by this runner. The paid ceiling is native units,
not a dollar estimate. Managed-provider model billing remains unavailable rather than counted as zero.

The installed MCP interface performs compilation and execution. The harness verifies exact installed
identity, authenticated receipt authors, selected backend, prior native budget authority, independent
validation, integrated PR/commit identity, dependency ordering, and resource reconciliation. Burst
requires an observed cloud start while a local worker is still executing; a fast run without overlap
is incomplete, not a successful burst qualification. The runner never retries a terminal Objective.

After execution it independently lists Daytona resources by the exact Objective/original-run labels.
Listing is read-only: matching labels are **not** authority to delete a resource. Failed or bounded-out
observations remain unknown. A failed active run receives a scoped Factory cancellation request; that
request alone does not prove cleanup. Retain the private evidence directory and reconcile any remaining
resources against their original identities before attempting another run.

## What remains open

**Daytona linear-stack publication remains required implementation work.** Independent siblings do
not satisfy that product goal. The next capability must replace the current host-only cascading
revalidation path with a distinct stack-rebase invocation bound to the exact rewritten head, new base,
and artifact; persist complete validation and provider resource lifetime before semantic review;
reserve/reconcile separate sandbox budget and capacity across restart; and test a cloud child through
parent merge, cascading rebase, exact-head invalidation, fresh isolated validation, and native merge.
Its conflict, response-loss, cancellation, and cleanup fault matrix is not an upstream prerequisite
or something that credentials alone can finish. This batch intentionally retains that guard.

No live provider launch was performed to implement these tests. A passed Daytona happy-path report
does not qualify all TTL, crash, egress, secret-brokerage, or provider-invoice cases. The overall live
provider gates in [CONFORMANCE.md](CONFORMANCE.md) remain open until those observations are recorded.

The Codex managed live runner stops before creating an Objective because the release profile lacks
a qualified stable provider-published actor identity. It does not guess a bot login. A Copilot run can
collect full-Objective orchestration evidence, but its final assessment stays **incomplete** until
managed-session absence and billing are independently qualified; a merged PR is insufficient.

Primary API references: [Daytona SDK listing and deletion](https://www.daytona.io/docs/en/typescript-sdk/daytona/)
and [GitHub third-party coding agents](https://docs.github.com/en/copilot/concepts/agents/about-third-party-coding-agents).
