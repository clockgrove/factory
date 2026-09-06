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
| Same-host multi-Objective and regular-PR concurrency | [#113](https://github.com/clockgrove/factory/issues/113), [#114](https://github.com/clockgrove/factory/issues/114) | Code / concurrency lane: explicitly restored by maintainer. Implement fair shared capacity and concurrent independent work with exact safe integration/recovery before WSL2 qualification. |
| Durable App Server sessions | [#115](https://github.com/clockgrove/factory/issues/115) | Code / session lane: explicitly restored. Complete supported same-thread resume, immutable identity, lifecycle/accounting and controller integration. |
| Generic large-file handling | [#116](https://github.com/clockgrove/factory/issues/116), [#117](https://github.com/clockgrove/factory/issues/117), [#118](https://github.com/clockgrove/factory/issues/118) | Code / artifact lane: explicitly restored LFS detection/tooling, binary/media manifests and oversized content-addressed transport with durable lifecycle evidence. |
| Scope and acceptance reconciliation | [#108](https://github.com/clockgrove/factory/issues/108) | Coordinator has delivered the cross-domain register; maintainer disposition is needed for disputed reductions. Reconcile plans, ADRs and release/pilot acceptance before declaring completion. |
| Compiler economics and runtime reporting | [#110](https://github.com/clockgrove/factory/issues/110) | Code written and integrated: grounded compilation tradeoffs, runtime intervals/concurrency, delivery-attributed consumption and evidence gaps. Regression execution and PR acceptance remain at the final candidate boundary; restored concurrency must update delivery assumptions. This is not measured benefit. |
| Representative compiler/chat evaluation | [#111](https://github.com/clockgrove/factory/issues/111), [#112](https://github.com/clockgrove/factory/issues/112) | Code / evaluation lane: implement executable fixtures and direct/indirect/negative prompts, then qualify actual compiler/agent behavior after integration. Existing profile/annotation tests are narrower. |
| Measured product benefit | [#109](https://github.com/clockgrove/factory/issues/109) | Testing / qualification lane: compare equivalent accepted outcomes against controlled baselines after implementation. Depends on #110/#111 and scope reconciliation; coordinate with #112 without duplicating runs. |
| WSL2 resilience | [#75](https://github.com/clockgrove/factory/issues/75) | Orderly [accounted checkpoint restart](release-evidence/accounted-checkpoint-restart-component-2026-09-06.json) and [pre-projection budget refusal](release-evidence/budget-refusal-component-2026-09-06.json) passed. Budget refusal recorded 16,437 compilation tokens, durable escalation and no implementation admission; the compiler graph was not inspected. [Active cancellation remains incomplete](release-evidence/active-cancellation-incomplete-2026-09-06.json) on unavailable worker usage. These component results do not close the full resilience matrix. |
| Adaptive scheduling and organization priority | [#76](https://github.com/clockgrove/factory/issues/76), [#77](https://github.com/clockgrove/factory/issues/77) | Extend the [installed scheduling subset](release-evidence/local-scheduling-component-2026-09-05.json) with pressure, fairness, phase recovery, inner Director contention and organization-field edits. |
| Genuine SDK-to-CLI fallback | [#75](https://github.com/clockgrove/factory/issues/75) | [Passed on the recorded installed candidate](release-evidence/genuine-sdk-cli-fallback-component-2026-09-06.json): authentic CLI incompatibility refused SDK admission; unchanged SDK-first policy delivered through CLI, with complete reported usage and exact resource absence. Other WSL2 fault cases remain open. |
| Supplied-snapshot replay interface | [#103](https://github.com/clockgrove/factory/issues/103) | Code: expose bounded, validated pinned admission snapshots through MCP and CLI. Preserve read-only receipt reconstruction and distinguish supplied simulations from authenticated history. |
| Pressure/cooldown qualification scenario | [#104](https://github.com/clockgrove/factory/issues/104), [#76](https://github.com/clockgrove/factory/issues/76) | Code: extend existing installed qualification with bounded genuine pressure, cooldown and safe readmission observations. Implementation is not a live pass or the whole scheduling matrix. |
| Hierarchical capacity and queued-reason correctness | [#105](https://github.com/clockgrove/factory/issues/105), [#106](https://github.com/clockgrove/factory/issues/106) | Code: honor applicable ancestor CPU/memory limits and persist genuine queued-reason changes without repeated writes or reset waiting age. These fixes precede pressure qualification. |
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
