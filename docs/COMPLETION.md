# Factory completion board

Updated: 2026-09-05. The authoritative remaining-work checklist is
[GitHub #69](https://github.com/clockgrove/factory/issues/69). These are ordinary development issues,
not Factory Objectives. This board is a linked summary, not another backlog.

## Finish line and execution order

Finish all remaining implementation code and known-bug fixes first, in parallel isolated worktrees.
**No test runs, typechecks, lint/format checks, release checks, plugin reinstalls, or live qualification
during this implementation phase.** Then run the coordinated suite, fix discovered defects, and
qualify the integrated product. Keep all six release gates and post-publication installation.

Unsupported third-party features narrow the affected provider's claims, not Factory's finish line.
Users own their paid-provider relationships; final invoice settlement is not a completion gate.
Exact active-resource, identity, replacement and native admission safeguards remain mandatory.
A bounded Clockgrove pilot is separate from full release qualification and grants no production or
paid-provider authority. Missing input for one issue does not stop independent implementation.

## Implementation completed; integrated local verification passed

| Issue / acceptance boundary | Kind | Owner / state | Next deliverable |
| --- | --- | --- | --- |
| [#70 Accurate recovery guidance](https://github.com/clockgrove/factory/issues/70): supported recovery instructions without weakening restart fences | Code, known bug | Recovery lane / completed and verified | Delivered in merged #91. |
| [#71 Codex capability boundary](https://github.com/clockgrove/factory/issues/71): no working-provider claim without its own interface | Code | Capability lane / completed and verified | Merge remaining stack; actual unavailable interface remains #85 follow-up, not a global blocker. |
| [#72 Copilot limited controls](https://github.com/clockgrove/factory/issues/72): exact task-specific human action where automatic stop is unsupported | Code | Copilot lane / completed and verified | Delivered in merged #91; supported live execution qualification is #84. |
| [#73 User-owned provider billing](https://github.com/clockgrove/factory/issues/73): complete proven execution without invoice finality | Code | Accounting lane / completed and verified | Merge remaining stack; unknown actual resources still block replacement. |
| [#90 Provider-cost replay](https://github.com/clockgrove/factory/issues/90): unique receipts, contradictory evidence and finite totals | Code, known accounting bug | Accounting lane / completed and verified | Delivered in merged #91; unknown costs remain unavailable, not zero. |
| [#74 Retained qualifier corrections](https://github.com/clockgrove/factory/issues/74): bounded, correctly bound cancellation/budget evidence | Code, qualification-tool bugs | Local correction lane / completed and verified | Merge integrated tip; live scenarios remain separately authorized. |
| [#92 Final-check defects](https://github.com/clockgrove/factory/issues/92): independent managed-validator absence and real installed claim proof, with typed fixtures | Code, final verification defects | Both lanes / completed and verified | Merge integrated tip; original failed candidate remains preserved. |

All implementation and review lanes are completed, not waiting or silently running. The coordinator
integrated their work and finished the single coordinated local verification phase. There is no known
unresolved implementation defect in this backlog; this is not a claim that testing proves zero bugs.

[Exact final evidence](release-evidence/integrated-completion-suite-2026-09-05.json) records candidate
`1e605d2fba58c9134b9e90e1b516a58bedb42424`: all `verify:release` checks passed, including clean temporary
plugin/npm installation. The [original failed candidate](release-evidence/final-suite-original-failure-2026-09-05.json)
is preserved separately. Only completion/evidence documentation follows the tested candidate; runtime
and manifest hashes are unchanged. The recorded npm tarball is the tested candidate's package, not a
later documentation-bearing tarball. No paid/model-backed live qualification, production activation
or registry publication was performed. All six live release gates retain their actual open status.

## Deferred qualification and distribution

Every issue has acceptance criteria, dependencies and an exact next deliverable. Qualification and
distribution remain open; the integrated local suite is completed. Their execution can now follow
the implementation phase, but only within each issue's explicit authorization boundary.

| Capability | Ordinary issues | Dependency / next boundary |
| --- | --- | --- |
| WSL2 resilience and adaptive scheduling | [#75](https://github.com/clockgrove/factory/issues/75), [#76](https://github.com/clockgrove/factory/issues/76) | Integrated code, frozen artifact and a new scoped execution allowance; no reuse of a completed run's unused allowance. |
| Organization priority edits | [#77](https://github.com/clockgrove/factory/issues/77) | Scoped disposable organization-field permission. |
| Other supported Linux hosts | [Native Linux #78](https://github.com/clockgrove/factory/issues/78), [macOS-hosted Linux #79](https://github.com/clockgrove/factory/issues/79) | Host access; supported architecture coverage is retained. Neither blocks independent WSL2 work. |
| Native stacks, merge queue and recorded regular-PR fallback | [#80](https://github.com/clockgrove/factory/issues/80), [#81](https://github.com/clockgrove/factory/issues/81), [#82](https://github.com/clockgrove/factory/issues/82) | Installed candidate; queue/rule tests additionally need eligible disposable features and explicit configuration authority. |
| Daytona and claimed managed capabilities | [Daytona #83](https://github.com/clockgrove/factory/issues/83), [Copilot #84](https://github.com/clockgrove/factory/issues/84) | Credentials, explicit native-unit spending and cleanup authority, then evidence for supported capabilities. Unsupported automation and unavailable costs remain explicit. |
| Future Codex managed execution | [#85](https://github.com/clockgrove/factory/issues/85) | Provider-specific interface follow-up; currently unavailable, not a required working-provider release gate. |
| Bounded Clockgrove pilot | [#86](https://github.com/clockgrove/factory/issues/86) | Accepted Objective, trust, delivery policy and allowance before actual-checkout activation. |
| Integrated suite and discovered-defect fixes | [#87](https://github.com/clockgrove/factory/issues/87) | Completed on the exact integrated candidate above; merge the remaining stack. Not an open live gate. |
| Release and actual published installation | [Publication #88](https://github.com/clockgrove/factory/issues/88), [post-publication #89](https://github.com/clockgrove/factory/issues/89) | All retained gates, compatible exact-candidate evidence and registry approval; clean-install the actual published bytes afterwards. |

## Scope and retained evidence

The [design definition of done](DESIGN.md#definition-of-done), [delivery plan](DELIVERY-PLAN.md), and
[conformance gates](CONFORMANCE.md#verification-required-before-publication) retain the complete
product contract. Vercel Sandbox, Codex App Server and harness-native child workers remain Labs.
Git LFS lifecycle and oversized artifact transfer remain explicit future appendix extensions, not
current support claims. The accepted provider-specific support decision supersedes the former
two-working-managed-providers and invoice-finality requirements; the other retained gates remain.

## PR stack

[PR #91](https://github.com/clockgrove/factory/pull/91) is merged with the initial recovery/accounting
corrections and issue-first workflow. [PR #93](https://github.com/clockgrove/factory/pull/93) targets
`main` with the provider-capability layer. The final `finish/local-corrections` branch targets #93
and carries the synchronized bundles, local corrections, final defects and evidence. Merge bottom-up.
Coordinated checks ran on the integrated tip, not each intermediate layer. Source-only intermediate
PRs are not separate qualified install candidates.

[PR #68](https://github.com/clockgrove/factory/pull/68) delivered native sibling refresh and retained
successor completion. [Exact evidence](release-evidence/quota-safe-successor-completion-component-2026-09-05.json)
preserves the original failures, separate adoption/closure artifact identities, known accounting and
verified cleanup. The completed successor and its stopped controller are not a new-run allowance.
Historical implementation issues remain history, not evidence that unexecuted release gates passed.

The new board and guidance are not part of those previously tested artifacts. Never attach old
evidence to changed source bytes. [Contributor procedure](../CONTRIBUTING.md#validate-changes).
