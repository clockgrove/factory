# Threat model

This threat model covers the open-source Factory v2 preview running one Linux environment on one
laptop or desktop, with GitHub as its durable control plane and optional paid execution. It does not
cover any hosted coordinator or service.

## Assets

- GitHub credentials and repository write authority held by the trusted Supervisor;
- local source, worktrees, build outputs, and developer credentials;
- provider credentials, named model secrets, and paid-compute budgets;
- the integrity of Objectives, compiled Work Item graphs, leases, attempts, validation receipts,
  pull requests, and merge decisions;
- availability of the developer host and its GitHub API quota; and
- confidentiality of private repository content and bounded execution evidence.

## Trust boundaries

The operator, Linux host, installed Factory package, and active Supervisor process are trusted.
GitHub is trusted to authenticate actors, persist repository facts, and apply documented atomic
operations. A selected provider is trusted only for the capabilities explicitly assigned to it.

Objective text, issue comments, repository contents, dependencies, generated worker output, model
responses, and execution workers are untrusted inputs. A managed agent's branch and pull request are
also worker output; provider publication does not grant validation or integration authority.

Local Codex SDK and CLI worktrees are process-isolation boundaries, not hardened hostile-code sandboxes. Work
from an untrusted repository, author, fork, dependency source, or network requirement must use an
explicitly authorized hardened backend or escalate.

## Security invariants

1. A label, issue edit, or repository content alone never activates execution.
2. One fenced Director owns an Objective, and one fenced repository-controller identity/epoch owns
   admission and integration for a checkout. Every Supervisor mutation carries both observations.
3. Workers cannot mutate Factory's GitHub control plane, approve spending, publish, validate, merge,
   or widen their Work Packet.
4. Every paid launch is preceded by durable provider, concurrency, and native-unit budget authority.
5. Every accepted artifact is bound to its base, digest, path manifest, validation evidence, and
   exact published head.
6. Recovery may reproduce missing receipts or resume known resources; it may not infer new authority.
7. Installation performs no lifecycle script, repository mutation, daemon activation, or provider
   provisioning.

## Threats and mitigations

| Threat | Primary mitigations |
|---|---|
| Prompt injection asks a worker to control Factory or GitHub | Minimal Work Packets; workers receive no Director tools or GitHub write credentials; output is treated as an artifact, not an instruction. |
| A local or Factory-controlled sandbox worker exfiltrates credentials | Ambient secrets and GitHub credentials are removed; Git credential helpers are disabled; network is denied or allowlisted; sandbox model secrets are brokered by name. |
| Untrusted code attacks the developer host | Provenance and trust preflight; local execution only for explicitly trusted repositories/Objectives; hardened sandbox or escalation for hostile-code risk. |
| A worker changes forbidden or sensitive paths | Exact-SHA isolated worktree; manifest-first collection; allowed-path and sensitive-surface checks; fresh-checkout validation before publication. |
| A malicious or stale artifact reaches `main` | Content-addressed artifact, clean application, independent validation, exact-head receipt, branch-rule recheck, and fenced integration. |
| Two controllers execute or merge the same work | Repository and Objective compare-and-swap leases, fencing epochs, deterministic attempt refs, and pre-mutation lease observation. |
| Two chat/MCP/CLI processes submit the same command or lose a comment response | The authenticated Objective-comment stream is the single atomic request journal; one centralized semantic request-ID comparison tolerates identical at-least-once duplicates and rejects conflicting reuse. |
| A replayed or partially written graph changes scope | Immutable per-run graph ref, digest-bound graph receipt, per-item compiler envelopes, idempotent repair, and fail-closed divergence handling. |
| A provider launch is lost or duplicated during a crash | Durable reservation before launch, deterministic provider identity, bounded reconciliation, cancellation, hard TTL, and cleanup verification. |
| Cloud fallback overspends | Paid execution off by default; explicit backend allowlist; sandbox-minute or managed-session ceilings; atomic phase reservations; no retry-time budget widening. |
| GitHub API pressure prevents fencing or cleanup | Shared limiter, pacing, circuit breaker, reserved lease capacity, conservative quota admission, and stop-on-platform-refusal behavior. |
| A lower stacked-PR layer changes after validation | Stack/base/head receipts; descendant invalidation; revalidation of the changed exact head; asynchronous merge reconciliation. |
| Package or dependency compromise changes install behavior | Lockfile and production audit, committed standalone bundles, package allowlist, no install lifecycle scripts, clean-install verification, checksums/provenance in the release process. |
| Logs or issue receipts disclose secrets | Bounded output, secret scanning before durable evidence, named-secret references rather than values, and explicit unavailable fields rather than raw provider payloads. |

## Provider boundaries

Daytona is the supported v2 sandbox provider. Factory supplies source without repository
credentials, creates ephemeral resources with deterministic identity and hard wall-clock TTL,
restricts egress, brokers only the named model credential, validates in a fresh resource without a
model credential, and attempts cleanup after collection. Provider-side spend controls and TTL are
the final bounds during a host or network partition.

GitHub Copilot and OpenAI Codex managed agents run under GitHub's agent policies. Factory reserves a
managed-session budget, observes their durable identity, collects the exact resulting branch/PR,
and independently validates it. Factory does not treat the provider's completion signal, checks, or
self-authored PR as acceptance. Factory cannot strip provider-issued repository credentials or
enforce Work Packet destinations inside those sessions; credential handling and egress are
provider-controlled. Explicit managed-backend authorization accepts that boundary. Their two live
gates must verify the observed provider behavior before release evidence can close. Those sessions
may consume GitHub Actions minutes under the provider's billing boundary; Factory installs no
workflow and cannot treat an Actions allowance as launch authority or as one of its own usage
receipts.

Vercel Sandbox and Codex App Server are Labs integrations. They inherit the same worker and artifact
contracts but are not part of the v2 release gate.

## Known limitations and non-goals

- Compromise of the operator account, trusted Linux host, installed Factory executable, or GitHub
  credential is outside Factory's worker-isolation guarantee.
- Local worktrees do not provide kernel-level isolation, a clean network namespace, or protection
  from a deliberately malicious local process running as the same user.
- Local home/config redirection, environment filtering, and disabled credential helpers prevent
  conventional discovery but cannot deny a same-user worker an already-known absolute path that the
  OS and underlying Codex sandbox permit it to read.
- Factory cannot wake a powered-off laptop, start an unopened WSL distribution, or start a stopped
  Linux guest on macOS.
- Native Win32 and Darwin execution/lifecycle and multi-machine local clusters are out of scope.
- Factory does not grant production secrets, deploy to production, alter branch rules, force-push,
  rewrite history, or buy/increase provider capacity autonomously.
- No control prevents an authorized GitHub administrator from changing repository state outside
  Factory. The Supervisor re-reads relevant state and fails closed when evidence no longer matches.
- GitHub comments are editable and deletable. Authenticated journal entries prove their observed
  author and content, but do not provide an independently immutable audit log. An authorized actor
  deleting history may remove evidence that replay needs, including usage receipts; complete
  deletion cannot always be detected from the remaining journal. Protect controller credentials and
  preserve control comments and refs during active runs.

Review this model whenever a new credential class, provider, runtime, network path, durable record,
publication authority, or hosted component is added.
