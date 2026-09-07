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

The current trunk batch integrates
[#136](https://github.com/clockgrove/factory/issues/136) (explicit budget intent and durable model-call
admission), [#137](https://github.com/clockgrove/factory/issues/137) (safe conservative defaults),
and [#138](https://github.com/clockgrove/factory/issues/138) (accepted-work recovery before publication).
The final corrected candidate's coordinated verification and matching-artifact acceptance remain
pending; earlier failed checks remain separate evidence, not a pass or a new scope deferral.
The coordinator owns that integration boundary. Full application scenario coverage remains required
in [#86](https://github.com/clockgrove/factory/issues/86), not replaced by the first bounded pilot.

These settle the original contract rather than create new approval gates: unsupported hard token
ceilings are rejected before model work; new observed thresholds require explicit `observed-stop`
intent and allow in-flight overshoot. Authenticated historical policies retain their original
digests and semantics. Dispatch intent is not observed usage or a zero-token allocation, and
missing actual counters continue to fence replacement. New policies default to fixed two-worker
admission with physical CPU/memory safety; adaptive mode remains explicit, with its live default-change
prerequisites retained. None of these choices waives application, provider or comparative-benefit acceptance.

The restored implementation is complete, reviewed and passed the
[integrated release checks and exact-artifact installation](release-evidence/restored-capabilities-integrated-2026-09-06.json).
The capability stack is merged. Installed WSL2 qualification exposed two concrete defects:
[#124](https://github.com/clockgrove/factory/issues/124) in cooldown parsing and
[#125](https://github.com/clockgrove/factory/issues/125) in foreground integration continuation.
Their corrections passed [integrated checks and matching installation](release-evidence/foreground-continuation-correction-2026-09-06.json).
Installed retained-work recovery then exposed [#128](https://github.com/clockgrove/factory/issues/128):
an older-base retained regular PR was not refreshed through the successor path. Its correction and
the remaining installed scenarios are the current critical path. Review also confirmed required
isolated adopted-candidate validation in [#129](https://github.com/clockgrove/factory/issues/129)
and shared provider admission in [#130](https://github.com/clockgrove/factory/issues/130).
Their implementation and regressions are integrated in one recovery capability batch and passed
[final release checks and matching WSL2 installation](release-evidence/retained-recovery-correction-2026-09-06.json).
That record preserves the initial receipt/provenance and fixture failures separately. The
retained-work continuation subsequently completed as a bounded installed recovery subset.
Explicit-compilation LFS preparation in [#134](https://github.com/clockgrove/factory/issues/134)
and installed large-file scenario implementation in [#133](https://github.com/clockgrove/factory/issues/133)
are now integrated and passed their own
[coordinated release checks](release-evidence/compilation-large-file-capability-2026-09-06.json).
Their installed model-backed acceptance remains open; prior installed evidence does not cover these changes.
This does not establish live provider support, actual compiler/chat behavior or measured cost/throughput benefit.

The [recorded integrated local suite](release-evidence/integrated-completion-suite-2026-09-05.json)
passed on its exact candidate; the
[original failed candidate](release-evidence/final-suite-original-failure-2026-09-05.json) remains
separate. That evidence does not qualify changed source or close the six live release gates.
The [sanitization and fallback qualifier implementation checks](release-evidence/sanitization-fallback-implementation-2026-09-06.json)
passed on their separate exact candidate. New defects remain tracked implementation work.

The [scope audit](https://github.com/clockgrove/factory/issues/108) found unverified reductions
and retained implementation gaps. Earlier blanket completion and accepted-deferral claims are
withdrawn. The six restorations and the remaining budget/default/application scope decisions are
now reconciled through #136/#137 and retained #86 acceptance. Implementation verification and
unexecuted qualification are still required. Comparative cost/throughput benefit is not yet
demonstrated; safe execution and consumption counters are not substitutes.

| Capability | Issues | Remaining acceptance |
| --- | --- | --- |
| Explicit compilation source preparation | [#134](https://github.com/clockgrove/factory/issues/134) | Implementation accepted / compilation owner: pre-model LFS/tool/cache refusal, exact-base isolated hydration, unchanged source checkout and preserved paid-result accounting passed review and integrated release checks. Next: installed acceptance in #123 and real compiler/chat evaluation in #112. |
| Installed large-file scenarios | [#133](https://github.com/clockgrove/factory/issues/133) | Implementation accepted / artifact owner: intent-to-ready recovery, content and refusal scenarios passed coordinated checks. Next: matching installed scenarios in #123 under separate accepted authority; no live pass is claimed. |
| Retained regular-PR successor refresh | [#128](https://github.com/clockgrove/factory/issues/128) | Completed / recovery owner: integrated checks and the bounded installed retained-work continuation passed. Original artifacts and paid history remain immutable. This subset does not close remaining session, concurrency, provider or large-file qualification. |
| Isolated adopted merge candidates | [#129](https://github.com/clockgrove/factory/issues/129) | Implementation accepted / isolated-recovery owner: required independent validation, explicit provider authorization, native budget/capacity, durable completion and crash reconciliation passed integrated checks. A failed validator is not successful work; unknown termination prevents replacement. Next: live provider qualification with separate spending authority. |
| Shared provider validation capacity | [#130](https://github.com/clockgrove/factory/issues/130) | Implementation accepted / integration owner: candidate reservations and workers share repository/Objective provider ceilings without changing exact receipt/release identity. Independent review and final integrated checks passed. Next: installed provider-capacity qualification within separately authorized scenarios. |
| Integrated candidate corrections | [#119](https://github.com/clockgrove/factory/issues/119) | Completed / integration owner: reviewed capability stack merged in #120–#122. Final integrated gates passed on the recorded candidate; original failures remain separate. |
| Installed continuation corrections | [#124](https://github.com/clockgrove/factory/issues/124), [#125](https://github.com/clockgrove/factory/issues/125), [#126](https://github.com/clockgrove/factory/issues/126) | Completed / integration owner: strict cooldown parsing, authenticated foreground graph-base proof and one bounded real-Git fixture corrected and reviewed. Full release checks and matching WSL2 installation passed. Preserve [original failure, partial pressure proof and independent cleanup](release-evidence/wsl2-pressure-original-failure-2026-09-06.json). Next: supported recovery retaining the first merge and second root output; installed qualification remains open. |
| Restored installed runtime | [#123](https://github.com/clockgrove/factory/issues/123) | Testing / qualification lane: remaining same-host multi-Objective and regular-PR overlap, durable terminal session recovery, LFS/tooling, manifests and oversized transfer cases. Reuse compatible #75/#76 evidence; integrated source checks are not these live passes. |
| Same-host multi-Objective and regular-PR concurrency | [#113](https://github.com/clockgrove/factory/issues/113), [#114](https://github.com/clockgrove/factory/issues/114) | Completed / concurrency lane: fair shared capacity, concurrent regular work, pinned compilation and exact peer/sibling integration implemented and covered by passing integrated checks. Next: installed overlap, fairness and recovery qualification. |
| Durable App Server sessions | [#115](https://github.com/clockgrove/factory/issues/115) | Completed / session lane: exact session identity, terminal recovery without another model turn, complete-usage accounting and deterministic recovery qualifier implemented; integrated checks passed. Next: installed WSL2 recovery scenario. [Unsupported cold repair turns](CODEX-APP-SERVER-SESSIONS.md) remain an explicit provider boundary. |
| Generic large-file handling | [#116](https://github.com/clockgrove/factory/issues/116), [#117](https://github.com/clockgrove/factory/issues/117), [#118](https://github.com/clockgrove/factory/issues/118) | Completed / artifact lane: LFS/tooling, manifests, streamed content, durable transfer recovery, cache ownership and exact continuation implemented; integrated checks passed. Unknown replacement remains refused. Next: installed local large-file cases and separately authorized provider transfer qualification. |
| Trunk budget contract | [#136](https://github.com/clockgrove/factory/issues/136) | Implementation integrated / budget-policy and runtime owners: explicit intent, unsupported hard-cap refusal before model work, durable unknown-call fencing, unchanged authenticated historical authority and honest usage disclosure. Next: resolve observed verification defects and pass the final integrated candidate; no provider hard-cap or live savings claim. |
| Safe scheduling defaults | [#137](https://github.com/clockgrove/factory/issues/137) | Implementation integrated / scheduling owner: new fixed two-worker default with physical/resource safety; explicit adaptive policies and recorded policy identities remain intact. Next: final integrated regression acceptance, with adaptive live prerequisites retained. |
| Accepted work before publication | [#138](https://github.com/clockgrove/factory/issues/138) | Implementation integrated / recovery owner: repair linked review accounting and the missing owned publication from the exact retained artifact/validation/accepted review, without repeating those calls. Current head, policy, scope and lease fences remain required. Next: affected interruption/restart regression, then final integrated checks. |
| Scope and acceptance reconciliation | [#108](https://github.com/clockgrove/factory/issues/108) | All six restored commitments implemented. Original budget/default contracts are explicit in #136/#137; full Wave 8 application coverage remains #86. Scope reconciliation is not an installed qualification pass or permission to close incomplete acceptance. |
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
| Application dogfood and bounded pilot | [#86](https://github.com/clockgrove/factory/issues/86) | Full Wave 8 scenario coverage remains required as the application makes it available. The bounded first pilot has its own Objective/trust/delivery/resource boundaries and cannot substitute for the rest. |
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
#113–#118 own their implementation. #136/#137 restore explicit budget intent and the adaptive-default
prerequisite, while #86 retains full application coverage; #108 reconciles those original contracts
without treating a smaller pilot or observed token threshold as an implicit substitute. Current limited support
must remain honestly documented until the restored implementation and qualification are complete.

Unsupported third-party interfaces narrow the affected integration, not Factory globally. Users
own their provider relationships and billing; invoice finality is not execution qualification.
Unknown usage remains unavailable, never zero, and unknown active resources still prevent unsafe
replacement. Local qualification follows its configured scenario boundaries; completed or failed
runs are not silently revived. Paid-provider, production and publication actions retain their
separate authority requirements.
