# Factory completion board

Updated: 2026-09-05. The authoritative remaining-work checklist is
[GitHub #69](https://github.com/clockgrove/factory/issues/69). These are ordinary development issues,
not Factory Objectives. This board is a linked summary, not another backlog.

## Finish line and execution order

Finish all remaining implementation code and known-bug fixes first, in parallel isolated worktrees.
**No test runs, typechecks, lint/format checks, release checks, plugin reinstalls, or live qualification
during this implementation phase.** Then run the coordinated suite, fix discovered defects, and
qualify the integrated product. Keep all six release gates and post-publication installation.

Factory is not feature-complete while its promised managed-provider implementation is blocked.
A bounded Clockgrove pilot is separate from full release qualification and grants no production or
paid-provider authority. Missing input for one issue does not stop independent implementation.

## Current implementation ownership

| Issue / acceptance boundary | Kind | Owner / state | Next deliverable |
| --- | --- | --- | --- |
| [#70 Accurate recovery guidance](https://github.com/clockgrove/factory/issues/70): supported recovery instructions without weakening restart fences | Code, known bug | Recovery lane / code integrated; checks deferred | Run written regression coverage in the coordinated phase; keep the issue open until acceptance. |
| [#71 Real Codex managed binding](https://github.com/clockgrove/factory/issues/71): actual actor and provider-specific lifecycle, never Copilot substitution | Code, external contract | Codex lane / blocked | Provider must expose supported actor identity, exact task/session-to-PR/head binding, launch/replay and termination interfaces. Enabling the current profile would wrongly enter Copilot lifecycle logic. |
| [#72 Copilot identity and termination](https://github.com/clockgrove/factory/issues/72): exact task binding and supported stop/absence evidence | Code, external contract | Copilot lane / guidance fix integrated; feature blocked | Obtain issue-to-task identity and a supported exact stop operation. Unassignment now explicitly leaves compute unknown; bound active tasks name the operator stop action. |
| [#73 Managed billing settlement](https://github.com/clockgrove/factory/issues/73): exact attributable native units and finality | Code, external contract or explicit product decision | Coordinator / blocked | Obtain task-scoped charge/finality evidence or an explicit contract decision. Aggregate bills and terminal sessions do not supply it. |
| [#90 Provider-cost replay](https://github.com/clockgrove/factory/issues/90): unique receipts, contradictory evidence and finite totals | Code, known accounting bug | Accounting lane / code integrated; checks deferred | Run written regressions in the coordinated phase; this does not resolve provider settlement. |
| [#74 Retained qualifier corrections](https://github.com/clockgrove/factory/issues/74): bounded, correctly bound cancellation/budget evidence | Code, qualification-tool bugs | Existing worktrees / paused | Preserve written work until the product implementation boundary; no additional harness expansion. |

Issue comments carry exact handoffs and blockers. The recovery lane completed its first code task and
was explicitly restarted for #90. The provider lanes are blocked, not running background tests.
No test, typecheck, lint/format, build or live qualification has run since the implementation-only
directive. Written regression source and old qualifier work are preserved, not claimed as passed.

## Deferred qualification and distribution

Every issue has acceptance criteria, dependencies and an exact next deliverable. These remain open;
they do not run before implementation is complete.

| Capability | Ordinary issues | Dependency / next boundary |
| --- | --- | --- |
| WSL2 resilience and adaptive scheduling | [#75](https://github.com/clockgrove/factory/issues/75), [#76](https://github.com/clockgrove/factory/issues/76) | Integrated code, frozen artifact and a new scoped execution allowance; no reuse of a completed run's unused allowance. |
| Organization priority edits | [#77](https://github.com/clockgrove/factory/issues/77) | Scoped disposable organization-field permission. |
| Other supported Linux hosts | [Native Linux #78](https://github.com/clockgrove/factory/issues/78), [macOS-hosted Linux #79](https://github.com/clockgrove/factory/issues/79) | Host access; supported architecture coverage is retained. Neither blocks independent WSL2 work. |
| Native stacks, merge queue and recorded regular-PR fallback | [#80](https://github.com/clockgrove/factory/issues/80), [#81](https://github.com/clockgrove/factory/issues/81), [#82](https://github.com/clockgrove/factory/issues/82) | Installed candidate; queue/rule tests additionally need eligible disposable features and explicit configuration authority. |
| Daytona and two real managed providers | [Daytona #83](https://github.com/clockgrove/factory/issues/83), [Copilot #84](https://github.com/clockgrove/factory/issues/84), [Codex #85](https://github.com/clockgrove/factory/issues/85) | Actual provider implementation, credentials, exact native-unit spending and cleanup authority. Credentials alone authorize no launch. |
| Bounded Clockgrove pilot | [#86](https://github.com/clockgrove/factory/issues/86) | Accepted Objective, trust, delivery policy and allowance before actual-checkout activation. |
| Integrated suite and discovered-defect fixes | [#87](https://github.com/clockgrove/factory/issues/87) | All implementation code integrated, then one coordinated suite and defect-fix phase. |
| Release and actual published installation | [Publication #88](https://github.com/clockgrove/factory/issues/88), [post-publication #89](https://github.com/clockgrove/factory/issues/89) | All retained gates, compatible exact-candidate evidence and registry approval; clean-install the actual published bytes afterwards. |

## Scope and retained evidence

The [design definition of done](DESIGN.md#definition-of-done), [delivery plan](DELIVERY-PLAN.md), and
[conformance gates](CONFORMANCE.md#verification-required-before-publication) retain the complete
product contract. Vercel Sandbox, Codex App Server and harness-native child workers remain Labs.
Git LFS lifecycle and oversized artifact transfer remain explicit future appendix extensions, not
current support claims. No requirement is dropped merely because its issue is externally blocked.

[PR #68](https://github.com/clockgrove/factory/pull/68) delivered native sibling refresh and retained
successor completion. [Exact evidence](release-evidence/quota-safe-successor-completion-component-2026-09-05.json)
preserves the original failures, separate adoption/closure artifact identities, known accounting and
verified cleanup. The completed successor and its stopped controller are not a new-run allowance.
Historical implementation issues remain history, not evidence that unexecuted release gates passed.

The new board and guidance are not part of those previously tested artifacts. Never attach old
evidence to changed source bytes. [Contributor procedure](../CONTRIBUTING.md#validate-changes).
