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

Independent Daytona siblings use native delivery mode for concurrent pipelines. The linear-stack
Daytona path now includes durable isolated cascading revalidation; its runtime qualification is still
pending. Regular PR mode remains serialized and cannot pass the burst-overlap gate. Every non-host
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
Copilot qualification additionally requires a user-to-server GitHub token with the repository
`Agent tasks: read` permission. GitHub App installation tokens are not accepted by that API. The
runner probes this read-only permission before Objective creation; it does not broaden the token or
start a task through the Agent Tasks API.

The installed MCP interface performs compilation and execution. The harness verifies exact installed
identity, authenticated receipt authors, selected backend, prior native budget authority, independent
validation, integrated PR/commit identity, dependency ordering, and resource reconciliation. For
Copilot it also binds every pull request's REST database ID to exactly one Agent Task owned by the
authenticated user in the same repository, fetches that exact task, binds every session to the task
and pull-request head ref, and requires the task and every session to be terminal. A merged pull
request, an empty assignee list, or successful unassignment is never cleanup evidence. Burst
requires an observed cloud start while a local worker is still executing; a fast run without overlap
is incomplete, not a successful burst qualification. The runner never retries a terminal Objective.

After execution it independently lists Daytona resources by the exact Objective/original-run labels.
Listing is read-only: matching labels are **not** authority to delete a resource. Failed or bounded-out
observations remain unknown. A failed active run receives a scoped Factory cancellation request; that
request alone does not prove cleanup. Retain the private evidence directory and reconcile any remaining
resources against their original identities before attempting another run.

Copilot cancellation removes only the exact discovered assignee and then observes Agent Tasks. GitHub
documents a **Stop session** UI action that ends the Actions run, but the current public Agent Tasks API
documents list, start, and get operations only—no cancellation endpoint. It also exposes no issue
reference, so an issue-assignment launch cannot be bound safely before its exact pull-request artifact
appears. If cancellation occurs before that binding, or the bound task remains active, Factory blocks
replacement and requires the operator to stop the exact session in GitHub's Agents view. It never
guesses from timestamps or assumes unassignment stopped compute.

## What remains open

**Daytona linear-stack runtime qualification remains open.** The implementation now binds a distinct
stack-rebase invocation to the original publication, rewritten head, new base and artifact, persists
complete validation and provider resource lifetime before semantic review, and reconstructs separate
sandbox budget/capacity. The new credential-free linear-stack fixture has not yet been executed.
Testing must cover the cloud child through parent merge, cascading rebase, exact-head invalidation,
isolated validation and native merge, plus conflict, response-loss, cancellation, budget and cleanup
faults. Independent sibling evidence does not establish this acceptance matrix, and credentials alone
cannot finish the deferred deterministic verification.

No live provider launch was performed to implement these tests. A passed Daytona happy-path report
does not qualify all TTL, crash, egress, secret-brokerage, or provider-invoice cases. The overall live
provider gates in [CONFORMANCE.md](CONFORMANCE.md) remain open until those observations are recorded.

The Codex managed live runner stops before creating an Objective because the release profile lacks
a qualified stable provider-published actor identity. Current GitHub documentation names the installed
GitHub App display name `openai code agent`, but does not publish the corresponding assignable Bot
login/node identity. A display name is not authorization evidence, and the Agent Tasks API is
documented for Copilot cloud agent rather than third-party Codex tasks, so Factory does not guess a bot
alias or silently use Copilot's lifecycle surface. Official OpenAI documentation describes starting
Codex cloud work from GitHub issues and pull requests, but publishes no GitHub assignable actor identity
or provider API binding for the GitHub Copilot-powered integration.

A Copilot run can now collect exact task/session terminal evidence. Its final assessment still stays
**incomplete** at the narrower external boundary: GitHub documents that managed coding-agent sessions
consume Actions minutes and AI credits. GitHub's billing APIs expose aggregate account, repository,
product, model, and date-level usage, but no Agent Task or session identity and no per-task settlement
state. Terminal task/session state is execution-lifecycle evidence, not proof that provider billing
has settled or that no additional charge can post.

Primary API references: [Daytona SDK listing and deletion](https://www.daytona.io/docs/en/typescript-sdk/daytona/)
and [GitHub third-party coding agents](https://docs.github.com/en/copilot/concepts/agents/about-third-party-coding-agents),
[Agent Tasks REST API](https://docs.github.com/en/rest/agent-tasks/agent-tasks), and
[managing agent sessions](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/manage-and-track-agents).
The billing boundary was checked against [GitHub's aggregate billing usage API](https://docs.github.com/en/rest/billing/usage).
The OpenAI-side boundary was checked against [official Codex cloud documentation](https://learn.chatgpt.com/docs/cloud).
