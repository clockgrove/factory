# Factory completion board

Updated: 2026-09-07. [GitHub #69](https://github.com/clockgrove/factory/issues/69) owns
the backlog. Work is tracked in ordinary GitHub issues, with separate labels for
code, testing, release work and provider follow-up.

## Current milestone

The ordinary WSL2 path **passed on candidate `4923ef8`**: compilation, dependency-bound
sub-issues, concurrent local execution, independent validation, regular-PR publication,
sibling refresh, integration, Objective closure and terminal accounting. All three work
items completed on their first attempts, with no unresolved model invocation or active
reservation. The installed bundles matched the verified candidate throughout.

The [candidate verification record](https://github.com/clockgrove/factory/issues/69#issuecomment-5576545317)
preserves the original interrupted command and the affected-file completion separately.
The [installed trunk result](https://github.com/clockgrove/factory/issues/69#issuecomment-5576916925)
records the exact scope, artifact identities, timing and accounting. Neither result is
a full-release or comparative-performance claim.

## Remaining acceptance

| Capability | Kind / owner | Acceptance, dependency and next deliverable | State |
| --- | --- | --- | --- |
| Mutation telemetry attribution — [#199](https://github.com/clockgrove/factory/issues/199) | Code / reporting | Distinguish reader-process counters from run measurements; report missing historical usage as unavailable. Next: reviewed correction and focused regressions. | Running |
| Large files — [#123](https://github.com/clockgrove/factory/issues/123) | Testing / artifact qualification | Qualify LFS/tooling, manifests and oversized transfers with the matching installed artifact. Next: bounded installed scenarios and exact evidence. | Running |
| Durable sessions — [#123](https://github.com/clockgrove/factory/issues/123) | Testing / session qualification | Prove exact session/artifact continuity, terminal accounting and cleanup. Next: reconcile retained evidence before selecting any necessary fresh scenario. Old evidence retains its original candidate identity. | Running |
| Scheduling and priority — [#76](https://github.com/clockgrove/factory/issues/76), [#77](https://github.com/clockgrove/factory/issues/77), [#123](https://github.com/clockgrove/factory/issues/123) | Testing / scheduling qualification | Complete shared-work fairness, continuous refill, pressure, real lease contention and live Priority edits. Next: remaining bounded cases after coordinating the shared GitHub write allowance. | Waiting |
| Lifecycle and failure handling — [#75](https://github.com/clockgrove/factory/issues/75) | Testing / resilience qualification | Complete restart, cancellation, SDK fallback and safe failed-validation/conflict outcomes. Next: reuse compatible evidence, then execute missing cases. Unavailable interrupted usage remains explicit. | Waiting |
| Native delivery and repository rules — [#80](https://github.com/clockgrove/factory/issues/80), [#81](https://github.com/clockgrove/factory/issues/81), [#82](https://github.com/clockgrove/factory/issues/82) | Testing / delivery qualification | Qualify native cascades, merge-queue ejection, branch fencing and genuine native-unavailable fallback. Ordinary regular delivery is not equivalent to these cases. | Waiting |
| Provider capabilities — [#83](https://github.com/clockgrove/factory/issues/83), [#84](https://github.com/clockgrove/factory/issues/84) | Testing / provider qualification | Qualify supported Daytona and Copilot behavior within configured credentials, original spend authority and exact cleanup boundaries. Document unavailable interfaces without claiming success. | Waiting |
| Compiler quality and measured value — [#109](https://github.com/clockgrove/factory/issues/109), [#112](https://github.com/clockgrove/factory/issues/112) | Testing / evaluation | Exercise representative compiler/tool-selection cases and compare equal-quality outcomes against controlled baselines. Next: use correctly attributed measurements; share compatible runs between both issues. | Waiting |
| Clockgrove pilot — [#86](https://github.com/clockgrove/factory/issues/86) | Testing / application qualification | Run the bounded authorized pilot after relevant branch acceptance. Retain the full application scenario requirements separately from first-pilot readiness. | Waiting |
| Publication and published installation — [#88](https://github.com/clockgrove/factory/issues/88), [#89](https://github.com/clockgrove/factory/issues/89) | Release / distribution | Complete applicable conformance gates and publication authority, then verify the actual published npm/plugin bytes from clean environments. Staged installation is not published-artifact evidence. | Waiting |

The trunk run demonstrates concurrent execution and complete accounting. It does not yet
demonstrate a cost or throughput improvement: server quota, cached tokens, model usage,
wall time and provider billing are distinct measurements. See #109 for the required
comparison and interpretation boundaries.

## Explicitly retained limitations

- [#78](https://github.com/clockgrove/factory/issues/78) and
  [#79](https://github.com/clockgrove/factory/issues/79): native Linux and macOS-hosted
  Linux tests remain unrun because those hosts are unavailable. WSL2 evidence does not
  qualify those hosts.
- [#85](https://github.com/clockgrove/factory/issues/85): the Codex managed-provider
  interface remains an external capability follow-up; it is not claimed as supported.
- [#171](https://github.com/clockgrove/factory/issues/171): compounded multi-generation
  outage recovery remains visible after the ordinary trunk and promised branches.

## Evidence and completion rules

Use [AGENTS.md](../AGENTS.md) and [CONTRIBUTING.md](../CONTRIBUTING.md) for development
and coordinated qualification. Preserve original failures and exact source, artifact,
host and scenario identities. Reuse evidence only within those boundaries.

The [design contract](DESIGN.md#definition-of-done), [delivery plan](DELIVERY-PLAN.md),
[conformance gates](CONFORMANCE.md#verification-required-before-publication), and
[historical evidence index](COMPLETION-HISTORY.md) retain all accepted requirements.
Pilot readiness does not waive release qualification, and an issue label or closure is
not a substitute for acceptance evidence.
