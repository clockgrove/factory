# Implementation and qualification reference

Use the [completion board](COMPLETION.md) and its linked GitHub issues for remaining work.
[DESIGN.md](DESIGN.md) defines runtime behavior; [CONFORMANCE.md](CONFORMANCE.md) records scoped
evidence and release gates. This document is a navigation guide, not a session handoff or an
independent status ledger.

## Implemented contracts

| Area | Contract and implementation reference |
| --- | --- |
| Objective compilation and chat control | [Indie Factory plan](INDIE-FACTORY-IMPLEMENTATION-PLAN.md), [chat command boundary](decisions/0004-chat-command-boundary.md). Repository-grounded commands, bounded economic assessment, immutable graph/projection and write-free inspection remain distinct from activation. |
| Local-first scheduling | [Adaptive scheduling plan](ADAPTIVE-SCHEDULING-IMPLEMENTATION-PLAN.md). Stable priority, CPU/memory headroom, capacity/resource constraints and immutable budget authority govern admission. |
| Delivery and recovery | [Stacked delivery](decisions/0005-stacked-delivery.md), [terminal recovery](TERMINAL-RECOVERY-IMPLEMENTATION-PLAN.md). Exact source, publication, validation/review and lineage identities constrain integration and successor reuse. |
| Provider execution | [Provider qualification](PROVIDER-QUALIFICATION.md), [provider setup](setup/README.md). Daytona and Copilot require evidence for their supported capabilities. Codex managed execution remains unavailable without its own supported identity/lifecycle contract. |
| Packaging and release | [Delivery procedure](DELIVERY-PLAN.md#recording-evidence-and-publishing), [conformance gates](CONFORMANCE.md#verification-required-before-publication). Exact source and artifact binding, clean installation and post-publication verification remain separate requirements. |

## Recorded evidence

The [dated evidence index](CONFORMANCE.md#dated-evidence-index) retains exact candidate identities,
artifact hashes, successful components and original failures. In particular:

- [Integrated local verification, 2026-09-05](release-evidence/integrated-completion-suite-2026-09-05.json)
  passed for the identified candidate; the [original failure](release-evidence/final-suite-original-failure-2026-09-05.json)
  is not overwritten.
- [Regular SDK and CLI-only delivery, 2026-09-05](release-evidence/regular-delivery-component-2026-09-05.json)
  passed serial pipeline, dependent join and fresh-artifact checks. Direct CLI execution does not
  prove failure-triggered SDK fallback.
- [Local scheduling subset, 2026-09-05](release-evidence/local-scheduling-component-2026-09-05.json)
  covers constrained Director admission, native priority ordering and outer repository-lease
  contention, not the complete pressure/fairness/host matrix.
- [Write-free installed planning, 2026-09-05](release-evidence/installed-planning-component-2026-09-05.json)
  qualifies explicit planning, not durable graph publication or execution.
- [Retained successor completion, 2026-09-05](release-evidence/quota-safe-successor-completion-component-2026-09-05.json)
  preserves separate adoption/delivery and proof-only closure artifact identities. It is not a
  single-candidate clean-history run.
- [Accounted checkpoint restart, 2026-09-06](release-evidence/accounted-checkpoint-restart-component-2026-09-06.json)
  passed the orderly same-run restart component.
- [Active cancellation, 2026-09-06](release-evidence/active-cancellation-incomplete-2026-09-06.json)
  remains incomplete: exact resource absence was observed, but interrupted worker usage is
  unavailable. Known management counters cannot substitute for complete worker accounting.

## Qualification boundaries

All six prepublication gates and published-artifact installation remain required. Deterministic
fixtures, direct API probes, installed components and broad host/provider qualification are distinct.
Reuse a verified unchanged tree where applicable; never attach an old result to changed runtime
bytes or promote a corrected observer into proof that a failed exercise passed.

Provider invoice settlement is not required. Actual task/session termination, independent validator
absence, exact-head evidence and native admission remain necessary for supported managed execution.
Unavailable provider interfaces must be declared accurately and refuse launch without preventing
local startup. Credentials alone do not authorize paid work.

Use stable issue acceptance and recorded scenario bounds when continuing qualification. Preserve
terminal histories and unknown accounting; do not regenerate completed work or infer zero usage
from absent counters. Follow the [contributor verification procedure](../CONTRIBUTING.md#validate-changes)
for integrated fixes and release candidates.
