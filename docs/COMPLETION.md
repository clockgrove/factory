# Factory completion board

Updated: 2026-09-05. This is the single current contributor planning board, not Factory runtime state.
GitHub remains the durable source of truth. [Design](DESIGN.md#definition-of-done) defines the finish
line; [conformance](CONFORMANCE.md) owns qualification evidence and publication gates.

## Implementation outcome

The local controller, compilation/chat, adaptive scheduling/priorities, bounded burst policy,
economics, regular/native delivery, and evidence-bound recovery are implemented. The latest native
publication-receipt/runtime correction and independent qualifier correction are integrated, including
regressions for duplicate-equivalent receipts, immutable bindings, and actual SDK/CLI identities.
The three implementation lanes found no additional concrete unblocked code gap at `ba924292`.
That is an implementation assessment, not a claim that all installed scenarios pass.

The authorized successor exercise subsequently exposed a stale assessment diagnostic and missing
structural discovery-label repair. Both corrections are integrated; installed exact-request replay
at `0363c5e` repaired discovery without changing authority. Adoption then reached a concrete resource
gap: completed foreground invocations lack a recorded launcher service identity. A narrowly bound
completion-receipt proof is implemented and independently reviewed; generic PID/scope absence alone
remains insufficient. It covers completed first-attempt trusted-local ordinary invocations; other
foreground variants remain blocked rather than receiving inferred ownership.
The [discovery failure](release-evidence/recovery-discovery-component-2026-09-05.json) and
[resource gate](release-evidence/recovery-foreground-resource-component-2026-09-05.json) are preserved.
The accepted request and allowance remain unchanged. Installed recovery at `007cd8c` passed adoption,
reused the pending publication, and executed only the dependent item; all three Work Items are done.
The [quota-interrupted closure](release-evidence/recovery-quota-closure-component-2026-09-05.json)
then exposed repeated immutable-object reads plus a controller restart loop. Both corrections are
integrated and independently reviewed, including propagation of retry timing through recovery proofs.
The controller remains stopped. Deadline-safe completion on restart is the remaining implementation
critical path; no completed work should be regenerated.

**Managed Codex is still blocked implementation**, not a finished adapter awaiting a key. Its profile
is disabled; enabling it requires authoritative actor discovery and a provider-specific task/session
lifecycle binding. The shared implementation currently observes Copilot Agent Tasks. Populating a
Codex actor list alone is not a safe implementation.

## Remaining capabilities and acceptance

Kinds: **Code**, **Testing**, **External input**. Owners are delivery lanes; blocked rows are not
active agents. Each row closes only when its stated acceptance is evidenced.

| Target / capability | Acceptance | Kind | Owner / status | Dependency → next deliverable |
| --- | --- | --- | --- | --- |
| Pilot — corrected integrated artifact | Frozen source passes integrated checks; matching staged package installs with recorded hashes. | Testing | Coordinator / completed at identified candidate | `007cd8c` passed full checks and exact matching installation. [Candidate evidence](release-evidence/foreground-recovery-candidate-component-2026-09-05.json) → separately identify the later quota corrections; no old result is rebound to changed bytes. |
| Pilot — discoverable explicit recovery | A foreground-created Objective without discovery labels becomes discoverable after an authorized recovery request; replay repairs a lost label without new authority, request or allowance. | Testing | Recovery requests / completed | Installed exact-request replay at `0363c5e` repaired the label and the controller reached adoption; original failure is retained. |
| Pilot — completed foreground resource proof | Authenticated original-local completion chains bind every invocation to its reservation, graph, artifact and accounting; fresh producer-generation/host and all reserved scope observations prove absence. Partial, conflicting or unsupported chains remain blocked. | Code, Testing | Recovery resources / implemented | First-attempt trusted-local ordinary path passed focused regressions and independent safety review → exact installed adoption observation; no invented service identity or missing command transcript. |
| Pilot — recovery read efficiency | Repeated recovery/resource checks share bounded verified immutable content; mutable refs, authenticated history, PR/base, lease and physical observations remain fresh. | Testing | Recovery resources / implemented, reviewed | Bounded exact-OID cache and typed-refusal propagation integrated with focused regressions → coordinated candidate checks and installed closure. |
| Pilot — quota-safe controller recovery | Primary reset/secondary retry boundaries cover bootstrap, discovery, admission and lease retirement; errors preserve durable work and do not cause restart storms or stale-lease reuse. | Testing | Controller runtime / implemented, reviewed | Controller-wide abortable cooldown, queued-call fences and safe ownership retirement integrated → coordinated candidate checks and installed closure. |
| Pilot — completion after delayed reconciliation | Restart can finalize already integrated work under unchanged authority, while no new execution/validation/review is admitted after its deadline. Existing closure, accounting, cleanup and fence requirements still apply. | Code assessment, Testing | Supervisor runtime / running | Quota reset exceeds the approved run deadline → determine and correct any unsafe completion ordering without extending policy. |
| Pilot — concurrent native delivery and recovery | Installed corrected runtime reuses authenticated completed work, validates/reviews each changed head, integrates remaining sibling and dependent join, closes the Objective, and proves accounting/resource cleanup. Original failed attempt stays failed. | Testing | Local runtime / waiting | All three Work Items are done; known cumulative usage is 219,769 / 500,000 tokens. Quota corrections and reported reset → resume the same non-terminal successor for closure, then independent qualification. |
| Pilot — local-only adopter handoff | Installed doctor/plan and explicit bounded activation are usable on the actual pilot checkout; scope, trust, delivery policy and allowance are accepted. SDK is the chosen route; direct CLI evidence is not automatic fallback evidence. | Testing, External input | Coordinator + operator / waiting | Corrected local qualification + pilot Objective/authority → ready-to-start local pilot handoff; no cloud prerequisite or silent production activation. |
| Release — remaining Linux and local fault cases | Native Linux, WSL2 and macOS-hosted Linux satisfy lifecycle/resource checks; SDK-failure fallback, broader adaptive priority/pressure/lease cases, native stacks/merge queue, and adversarial restart/cancel/conflict/budget cases pass. | Testing, External input | Local qualification / waiting | Stable candidate + missing host access and scoped fault authority → remaining cases in the four local [gate rows](CONFORMANCE.md#verification-required-before-publication), retaining existing exact-candidate evidence. |
| Release — Daytona burst | Real local/cloud overlap, fresh validation, TTL, egress, secret isolation, cancellation/restart, native accounting and exact cleanup pass. | Testing, External input | Provider qualification / blocked | Provider prerequisites below → authorized installed multi-worker Objective and lifecycle observations. |
| Release — Copilot managed execution | Real assigned Objective uses exact task/session identity, independent validation and no fallback; cancellation/recovery and billing evidence satisfy the retained gate. | Testing, External input | Provider qualification / blocked | Access/authority and billing boundary below → installed Objective; report terminal sessions separately from unavailable per-task settlement. |
| Release — Codex managed execution | Provider-specific actor and lifecycle implementation is complete, then a distinct real managed Objective passes the same contract without Copilot substitution. | Code, Testing, External input | Managed integration / blocked | Published identity + lifecycle contract → implement and regression-test provider-specific binding before live qualification. |
| Release — publication and distribution | All six prepublication gates pass; synchronized npm/plugin artifacts publish only with approval; the exact published artifact passes clean install and smoke qualification. | Testing, External input | Release owner / waiting | All preceding release gates + publication authority → immutable release artifacts, then separate post-publication evidence. |

The bounded pilot is a local-only learning deployment, **not full release qualification**. Its scope
does not remove Daytona, either managed provider, the Linux matrix, native-stack/adversarial cases,
or published distribution from the product contract. Vercel Sandbox and Codex App Server remain Labs.

## Agent lanes

| Lane | State | Delivered / next action |
| --- | --- | --- |
| Publication/runtime and qualifier corrections | Completed | Integrated code and independent review; next execution is the explicitly gated local qualification above. |
| Local runtime closure | Completed | No additional unblocked implementation defect identified. Restart only for a concrete defect or authorized qualification deliverable. |
| Compilation/chat/economics/scheduling | Completed | No additional unblocked implementation gap identified. No make-work test lane. |
| Provider implementation closure | Completed | Daytona/Copilot implementation classified; Codex's externally blocked implementation remains explicit. |
| Recovery request discovery correction | Completed | Integrated fresh acceptance/replay repair with unchanged identity/authority; focused regressions and independent review passed. |
| Completed foreground resource proof | Completed | Integrated finite-invocation proof and focused fail-closed regressions, including captured receipt shape and second-pass resource reappearance. |
| Resource proof safety review | Completed | Independent review cleared exact source at `3f3aa5c`; generic and unsupported-path gates remain strict. |
| Recovery immutable-read efficiency | Completed | Bounded immutable cache and typed-refusal propagation integrated; focused checks and independent review passed. |
| Controller quota recovery | Completed | Shared cooldown and safe fresh ownership integrated; focused checks and independent review passed. |
| Deadline-safe closure implementation | Running | Completion-only proof for on-time delivery, original source receipts and recovered validation epochs; no timeout or spending increase. |
| Deadline-safe closure safety review | Running | Review final authority, accounting, cancellation and resource boundaries before freezing the candidate. |
| Coordination and candidate qualification | Running | `007cd8c` passed full checks/install and performed retained-work delivery. Preserve the quota-blocked closure; integrate the concrete corrections and finish the same successor without regeneration. |

## External inputs — one actionable list

1. **Successor execution — approved:** the exact disposable continuation is authorized under its
   existing allowance and its digest-bound request is accepted. This is no longer an external blocker.
   No allowance increase or unknown-usage waiver is authorized; resource-proof repair is implementation work.
2. **Daytona:** supply `DAYTONA_API_KEY`; workers also need `FACTORY_DAYTONA_MODEL_SECRET` naming one
   organization Secret restricted to `["api.openai.com"]`. Managed validation also needs Daytona
   credentials, but not its worker model Secret. See [setup](setup/daytona.md).
3. **Paid qualification authority:** explicitly name provider/repository, native-unit ceilings,
   concurrency, allowed egress and cleanup responsibility. Unattended paid capacity must be nonzero
   only when authorized. Credentials alone grant no spending. [Exact runner inputs](PROVIDER-QUALIFICATION.md#opt-in-installed-plugin-exercise).
4. **Managed-provider boundaries:** Copilot needs assignable repository access and a user-to-server
   token with `Agent tasks: read` (reuse valid existing access). Its per-task billing settlement
   evidence remains unavailable. Codex needs an authoritative assignable actor and provider-specific
   task/session correlation and termination interfaces, not another guessed alias or API key.
   [Detailed boundaries](PROVIDER-QUALIFICATION.md#what-remains-open).
5. **Other hosts and destructive cases:** supply native Linux/macOS-hosted Linux environments and
   authorize only the remaining scoped disposable failure injections; no production failure testing.
6. **Pilot and publication:** approve the actual pilot Objective/trust/allowance before activation;
   separately approve registry identity and publication only after the retained release gates pass.

## Evidence and execution policy

[Conformance](CONFORMANCE.md) and the [historical handoff](IMPLEMENTATION-HANDOFF.md) retain exact
source/artifact identities, original failures and prior component results. The previous native run
failed; its separate planning pass does not qualify recovery. The interrupted later release check is
not a pass. The [corrected candidate component](release-evidence/publication-recovery-candidate-component-2026-09-05.json)
passes integrated checks and exact installation at `f67fd05`, but has not qualified installed
continuation. The later approved request revealed missing discovery repair, not a passed recovery
scenario. Discovery was subsequently repaired and observed at `0363c5e`, which remains blocked at
resource adoption and has not passed the full integrated suite. This board update is subsequent
documentation, not part of either installed package.

Finish implementation and integration review first. Then freeze a candidate, run integrated checks,
build/install matching bytes and execute authorized end-to-end cases. After a defect, run affected
checks first and repeat broader checks at the next stable candidate boundary. Never rebind old
evidence to new bytes. [Contributor procedure](../CONTRIBUTING.md#validate-changes).
