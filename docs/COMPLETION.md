# Factory completion board

Updated: 2026-09-06. [GitHub #69](https://github.com/clockgrove/factory/issues/69) is the
authoritative backlog. This page summarizes capability boundaries, not execution sessions or a
second queue. These are ordinary development issues, not Factory Objectives.

Filter open work by
[code](https://github.com/clockgrove/factory/issues?q=is%3Aissue+is%3Aopen+label%3A%22work%3Acode%22),
[testing](https://github.com/clockgrove/factory/issues?q=is%3Aissue+is%3Aopen+label%3A%22work%3Atest%22),
[review](https://github.com/clockgrove/factory/issues?q=is%3Aissue+is%3Aopen+label%3A%22work%3Areview%22),
[release](https://github.com/clockgrove/factory/issues?q=is%3Aissue+is%3Aopen+label%3A%22work%3Arelease%22),
[provider follow-up](https://github.com/clockgrove/factory/issues?q=is%3Aissue+is%3Aopen+label%3A%22work%3Afollow-up%22)
or [tracking](https://github.com/clockgrove/factory/issues?q=is%3Aissue+is%3Aopen+label%3A%22work%3Atracking%22).
Each issue and subissue has one primary work type, retained on closure. Qualification-tool defects
are implementation work; exercising an existing qualifier is testing work.

## Capability status

The restored implementation is complete, reviewed and passed the
[integrated release checks and exact-artifact installation](release-evidence/restored-capabilities-integrated-2026-09-06.json).
The capability stack is merged. Installed WSL2 qualification exposed two concrete defects:
[#124](https://github.com/clockgrove/factory/issues/124) in cooldown parsing and
[#125](https://github.com/clockgrove/factory/issues/125) in foreground integration continuation.
Their corrections passed [integrated checks and matching installation](release-evidence/foreground-continuation-correction-2026-09-06.json).
Installed retained-work recovery then exposed [#128](https://github.com/clockgrove/factory/issues/128):
an older-base retained regular PR was not refreshed through the successor path. Its correction and
the remaining installed scenarios are the current critical path; this is a code defect, not a
provider limitation or a waived qualification requirement.
This does not establish live provider support, actual compiler/chat behavior or measured cost/throughput benefit.

The [recorded integrated local suite](release-evidence/integrated-completion-suite-2026-09-05.json)
passed on its exact candidate; the
[original failed candidate](release-evidence/final-suite-original-failure-2026-09-05.json) remains
separate. That evidence does not qualify changed source or close the six live release gates.
The [sanitization and fallback qualifier implementation checks](release-evidence/sanitization-fallback-implementation-2026-09-06.json)
passed on their separate exact candidate. New defects remain tracked implementation work.

The [scope audit](https://github.com/clockgrove/factory/issues/108) found unverified reductions
and retained implementation gaps. Earlier blanket completion and accepted-deferral claims are
withdrawn. The comparative cost/throughput benefit is not yet demonstrated; safe execution and
consumption counters are not substitutes. Disputed requirements remain unresolved, not waived.

| Capability | Issues | Remaining acceptance |
| --- | --- | --- |
| Retained regular-PR successor refresh | [#128](https://github.com/clockgrove/factory/issues/128) | Code / recovery and regression owners: carry exact-owned non-force refresh through authenticated successor lineage, require new-head validation/review/accounting, and preserve interrupted-CAS, provider-ownership and exact-merge fences. The approved local continuation is acknowledged paused; original outputs, failures, allowances and deadlines are unchanged. Next: integrated correction, review and affected checks before matching-artifact qualification. |
| Isolated adopted merge candidates | [#129](https://github.com/clockgrove/factory/issues/129) | Code / isolated-recovery owner: complete required independent validation for retained ordinary/native-sibling candidates with explicit policy, native budget/capacity, durable resource completion and restart reconciliation. The local path's safe refusal is not implementation completion or a provider limitation. Next: credential-free implementation and fault regressions before coordinated checks; live paid qualification retains separate authority. |
| Shared provider validation capacity | [#130](https://github.com/clockgrove/factory/issues/130) | Code / integration owner: invocation-specific Daytona candidate reservations now share repository and Objective provider ceilings with workers while preserving exact receipt/release identities. Regression coverage is written; integrate with the recovery capability before coordinated checks. |
| Integrated candidate corrections | [#119](https://github.com/clockgrove/factory/issues/119) | Completed / integration owner: reviewed capability stack merged in #120–#122. Final integrated gates passed on the recorded candidate; original failures remain separate. |
| Installed continuation corrections | [#124](https://github.com/clockgrove/factory/issues/124), [#125](https://github.com/clockgrove/factory/issues/125), [#126](https://github.com/clockgrove/factory/issues/126) | Completed / integration owner: strict cooldown parsing, authenticated foreground graph-base proof and one bounded real-Git fixture corrected and reviewed. Full release checks and matching WSL2 installation passed. Preserve [original failure, partial pressure proof and independent cleanup](release-evidence/wsl2-pressure-original-failure-2026-09-06.json). Next: supported recovery retaining the first merge and second root output; installed qualification remains open. |
| Restored installed runtime | [#123](https://github.com/clockgrove/factory/issues/123) | Testing / qualification lane: remaining same-host multi-Objective and regular-PR overlap, durable terminal session recovery, LFS/tooling, manifests and oversized transfer cases. Reuse compatible #75/#76 evidence; integrated source checks are not these live passes. |
| Same-host multi-Objective and regular-PR concurrency | [#113](https://github.com/clockgrove/factory/issues/113), [#114](https://github.com/clockgrove/factory/issues/114) | Completed / concurrency lane: fair shared capacity, concurrent regular work, pinned compilation and exact peer/sibling integration implemented and covered by passing integrated checks. Next: installed overlap, fairness and recovery qualification. |
| Durable App Server sessions | [#115](https://github.com/clockgrove/factory/issues/115) | Completed / session lane: exact session identity, terminal recovery without another model turn, complete-usage accounting and deterministic recovery qualifier implemented; integrated checks passed. Next: installed WSL2 recovery scenario. [Unsupported cold repair turns](CODEX-APP-SERVER-SESSIONS.md) remain an explicit provider boundary. |
| Generic large-file handling | [#116](https://github.com/clockgrove/factory/issues/116), [#117](https://github.com/clockgrove/factory/issues/117), [#118](https://github.com/clockgrove/factory/issues/118) | Completed / artifact lane: LFS/tooling, manifests, streamed content, durable transfer recovery, cache ownership and exact continuation implemented; integrated checks passed. Unknown replacement remains refused. Next: installed local large-file cases and separately authorized provider transfer qualification. |
| Scope and acceptance reconciliation | [#108](https://github.com/clockgrove/factory/issues/108) | All six restored commitments implemented. Maintainer decisions remain on the adaptive-default prerequisite, token-threshold semantics and broader dogfood acceptance; these are not waived by implementation completion. |
| Compiler economics and runtime reporting | [#110](https://github.com/clockgrove/factory/issues/110) | Completed / economics lane: grounded compilation tradeoffs, runtime intervals/concurrency, attributed consumption and explicit evidence gaps implemented, reviewed and covered by passing integrated checks. Next: measured comparison under #109, not a savings claim. |
| Representative compiler/chat evaluation | [#111](https://github.com/clockgrove/factory/issues/111), [#112](https://github.com/clockgrove/factory/issues/112) | Corpus implementation completed / evaluation lane: five executable projects, twelve selection cases and production-contract consumers; integrated checks passed. Next: actual compiler/agent behavior under #112. |
| Measured product benefit | [#109](https://github.com/clockgrove/factory/issues/109) | Testing / qualification lane: compare equivalent accepted outcomes against controlled baselines after implementation. Depends on #110/#111 and scope reconciliation; coordinate with #112 without duplicating runs. |
| WSL2 resilience | [#75](https://github.com/clockgrove/factory/issues/75) | Orderly [accounted checkpoint restart](release-evidence/accounted-checkpoint-restart-component-2026-09-06.json) and [pre-projection budget refusal](release-evidence/budget-refusal-component-2026-09-06.json) passed. Budget refusal recorded 16,437 compilation tokens, durable escalation and no implementation admission; the compiler graph was not inspected. [Active cancellation remains incomplete](release-evidence/active-cancellation-incomplete-2026-09-06.json) on unavailable worker usage. These component results do not close the full resilience matrix. |
| WSL2 lifecycle and retirement components | [#75](https://github.com/clockgrove/factory/issues/75) | Two existing [no-model service cases passed](release-evidence/wsl2-lifecycle-components-2026-09-06.json) with exact owned-unit absence. This is not installed Objective or full resilience qualification. |
| Adaptive scheduling and organization priority | [#76](https://github.com/clockgrove/factory/issues/76), [#77](https://github.com/clockgrove/factory/issues/77) | Extend the [installed scheduling subset](release-evidence/local-scheduling-component-2026-09-05.json) with pressure, fairness, phase recovery, inner Director contention and organization-field edits. |
| Genuine SDK-to-CLI fallback | [#75](https://github.com/clockgrove/factory/issues/75) | [Passed on the recorded installed candidate](release-evidence/genuine-sdk-cli-fallback-component-2026-09-06.json): authentic CLI incompatibility refused SDK admission; unchanged SDK-first policy delivered through CLI, with complete reported usage and exact resource absence. Other WSL2 fault cases remain open. |
| Supplied-snapshot replay interface | [#103](https://github.com/clockgrove/factory/issues/103) | Completed / admission lane: bounded pinned admission inputs exposed through MCP/CLI, explicitly distinct from authenticated history; review and integrated checks passed. |
| Pressure/cooldown qualification scenario | [#104](https://github.com/clockgrove/factory/issues/104), [#76](https://github.com/clockgrove/factory/issues/76) | Testing / admission lane: original pressure/cooldown/readmission passes strict read-only reassessment after #124. Original run escalated on #125 before complete delivery. No reinjection or original-run revival; preserve partial evidence and qualify recovered delivery separately. |
| Hierarchical capacity and queued-reason correctness | [#105](https://github.com/clockgrove/factory/issues/105), [#106](https://github.com/clockgrove/factory/issues/106) | Completed / admission lane: ancestor CPU/memory limits and genuine queued-reason transitions are implemented, reviewed and covered by the passing integrated checks. |
| Native-unavailable regular-PR fallback qualifier | [#99](https://github.com/clockgrove/factory/issues/99), [#82](https://github.com/clockgrove/factory/issues/82) | Qualifier implemented and affected checks passed. Live #82 still requires genuinely unavailable native-stack delivery; direct regular-PR selection or synthetic errors are not equivalent. |
| Other supported Linux hosts — deferred | [#78](https://github.com/clockgrove/factory/issues/78), [#79](https://github.com/clockgrove/factory/issues/79) | Maintainer-approved availability deferral: only WSL2 is available. Leave native non-WSL Linux and macOS-hosted Linux tests unrun for now; no host requests. They are not on the current WSL2 qualification critical path and are not passed by WSL2 evidence. |
| Native delivery, merge queue and regular fallback | [#80](https://github.com/clockgrove/factory/issues/80), [#81](https://github.com/clockgrove/factory/issues/81), [#82](https://github.com/clockgrove/factory/issues/82) | Qualify the remaining installed native-stack, queue/ejection and recorded fallback cases. [Retained successor completion](release-evidence/quota-safe-successor-completion-component-2026-09-05.json) is a bounded component result. |
| Daytona and supported managed capabilities | [#83](https://github.com/clockgrove/factory/issues/83), [#84](https://github.com/clockgrove/factory/issues/84) | Exact installed execution, independent validation, native admission and resource/session termination evidence, within provider-specific capabilities. |
| Codex managed interface | [#85](https://github.com/clockgrove/factory/issues/85) | External interface follow-up. The profile remains unavailable and unlaunchable, not a required working-provider release gate. |
| Bounded pilot | [#86](https://github.com/clockgrove/factory/issues/86) | Pilot-specific Objective, trust, delivery and resource boundaries; pilot acceptance is separate from release qualification. |
| Integrated verification | [#87](https://github.com/clockgrove/factory/issues/87) | Completed for the recorded candidate. Verify subsequent implementation at the next integrated candidate boundary. |
| Public presentation and sanitization | [#98](https://github.com/clockgrove/factory/issues/98), [#100](https://github.com/clockgrove/factory/issues/100) | Review and current-tree/package remediation completed and affected checks passed. Historical public commits and previously copied artifacts are not retracted or relabelled as sanitized. |
| Publication and published installation | [#88](https://github.com/clockgrove/factory/issues/88), [#89](https://github.com/clockgrove/factory/issues/89) | All required gates, compatible exact-candidate evidence and distribution authority, followed by clean installation of the actual published bytes. |

## Completion rules

Follow the coordinated implementation and verification procedure in [AGENTS.md](../AGENTS.md) and
[CONTRIBUTING.md](../CONTRIBUTING.md#validate-changes). Reuse evidence only within its exact source,
artifact and scope boundaries; issue closure is not a substitute for acceptance evidence.

The [definition of done](DESIGN.md#definition-of-done), [delivery plan](DELIVERY-PLAN.md), and
[conformance ledger](CONFORMANCE.md#verification-required-before-publication) retain all six
prepublication gates and the post-publication installation gate. The retained economic and
compiler/chat acceptance is tracked explicitly above. Vercel as an optional second sandbox and
originally conditional harness-native workers do not imply approval to defer App Server session
acceptance, LFS detection, binary/media manifests or oversized transfer. The maintainer explicitly
restored those four commitments and same-host multi-Objective sharing/regular-PR concurrency;
#113–#118 own their implementation. The adaptive-default prerequisite, token-limit semantics and
broader dogfood coverage still require explicit reconciliation in #108. Current limited support
must remain honestly documented until the restored implementation and qualification are complete.

Unsupported third-party interfaces narrow the affected integration, not Factory globally. Users
own their provider relationships and billing; invoice finality is not execution qualification.
Unknown usage remains unavailable, never zero, and unknown active resources still prevent unsafe
replacement. Local qualification follows its configured scenario boundaries; completed or failed
runs are not silently revived. Paid-provider, production and publication actions retain their
separate authority requirements.
