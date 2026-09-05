# Factory verification status

Date: 2026-09-05

This file distinguishes release evidence from implemented adapters. An adapter existing in the
bundle is not, by itself, a support claim.

The scope is defined in [`DESIGN.md`](DESIGN.md). This document records tested behavior and the
checks still required before publication. Tasks are organized in the [delivery plan](DELIVERY-PLAN.md).

## Proven on this branch

The [final key-free component record](release-evidence/local-keyfree-finalization-component-2026-09-05.json)
binds the latest `npm run verify:release` at `1346107ae568099f823a72066316c86d8793b685`:
125 files, 2,300 passing tests, three skips, all static/schema/bundle/staged-package checks and zero
dependency vulnerabilities. Its exact 79-file package is separately identified from the earlier
`2668f0b` full release (2,249 passing tests) and 79-file installed package. All earlier installed
files match that installed package except the canonical personal-plugin manifest cachebuster.
Runtime bundles remain the recorded `0c97438` subjects; no reinstall occurred during the live
exercise. This later evidence update is not part of either tested tarball.

The installed one-token negative exercise at the earlier `2668f0b` candidate remained
**failed/incomplete**: its queue-and-cancel harness expected a later stage than Factory reached.
Retained authenticated evidence
instead shows one compiler call accounting for 15,919 tokens, followed by exact exhausted-budget
backend refusal and escalation before Work Item projection. No attempts, validation, publication or
capacity receipts exist; fresh installed status reports no active or outstanding reservations, and
the exact captured service was independently absent. The immutable compiled graph was not inspected:
source persists graph and usage before preflight, so absent graph-event receipts do not prove absent
durable graph data. A separate read-only assessment at `0f3f55a` preserves the original failed record;
it is not execution of the corrected prospective pre-projection-refusal qualifier. No cancellation,
reinjection or allowance increase occurred.

That prospective correction is integrated at `12f63736cf1d615dff3510e3988617d5bcfe9404`, where
132 focused tests, typecheck and scoped formatting/lint passed. Its script is byte-identical to the
recorded assessor source; integration does not mean the private assessment was reinvoked at that
revision. The earlier full release and unchanged installed runtime retain their separate identities.

A separate checkpoint qualifier at `f634bd62e14e6ade80e84a4a1c839943ca6b95db` stopped after its
sole controller-start action and before Objective creation or any model call. Its original generic
diagnostic did not localize the failed startup assertion. A later independent read observed that
exact controller active; a separate normal stop was accepted and independent inspection confirmed
inactive state with MainPID zero. No checkpoint, worker interruption or restart completion was
exercised. A later no-model startup-only probe at `e90628a` localized its own failure to reading the
controller executable identity (`EACCES`). It likewise created no Objective and made no model or
restart call. A subsequent privileged read matched the original single generation with no restarts;
normal cleanup and independent inactive/MainPID-zero observation followed. This is a local process
observation boundary, not a provider-credential gate; it does not retrospectively localize the first
attempt or pass full restart qualification. These narrowly observed outcomes close none of the six
broad prepublication gates.

A subsequent startup-only probe at `1346107` passed its intended component: the initial executable
read returned `EACCES`, the second bounded read validated the exact same generation, a prior-bound
pre-stop recheck passed, and normal stop reached independently observed inactive state. It created
no Objective, made no model call and exercised no restart. Ninety focused tests plus static checks
passed for that helper revision. The separate full checkpoint exercise retains its own outcome;
this startup result does not stand in for it.

The actual full exercise reached a clean intermediate checkpoint after one integration with
73,821 known tokens across three calls, no outstanding reservations and exact resource absence.
A new controller invocation and lease reconstructed the same paused work/accounting before resume.
The qualifier subsequently exited 2 during final proof: its comments snapshot ended at the final
`AttemptIntegrated` receipt while the later status read already reported completed. It accepted
status before the terminal receipt entered the same observation, then correctly failed its final
receipt proof. No final stop action was recorded by that exercise. This is a harness snapshot
coherence failure, not a qualified final pass. A later retained read-only observation independently
verified the original run completed with all three first-attempt integrations, closed Work Items
and Objective, exact published PR heads and GraphQL merge commits. Seven known usage receipts total
205,830 tokens; the accounted checkpoint prefix and takeover remain unchanged, no active
reservations remain, and all nine recorded execution/validation scopes were absent. Separate fresh
artifact verification passed 76 clone tests and independent behavior assertions at the exact default
head, with a clean worktree before/after execution and both join dependencies verified. A separate
cleanup component strictly rechecked the replacement generation, issued one normal installed Stop,
and independently observed inactive state/MainPID zero. No new model calls occurred after the
original run completed. These components establish useful retained closure/recovery evidence but
do not rewrite the original incomplete qualifier or close the broader adversarial/host gates.

Prospective harness fixes are separately checked: the coherent completion poll at `abd582c` passed
97 focused tests, and exact GraphQL actual-merge proof at `c3b31a` passed 113 focused tests; both
passed typecheck and scoped formatting/lint. The final proof binds REST/GraphQL PR identity, head,
repository and merge commit to the authenticated integration receipt, without relying on the removed
REST `merge_commit_sha` field. These later test-harness corrections do not change runtime bundles;
they were not in the `1346107` full-release snapshot and have not been re-exercised as a complete
prospective qualification. All six broad prepublication gates remain Open.

The [installed local scheduling component](release-evidence/local-scheduling-component-2026-09-05.json)
passed with harness `98ce207650e76b2f1aed114b89749c80b34e0e34` and the unchanged installed
`0c97438` runtime. A 0.5-CPU Director leaf admitted no workers while both roots queued; native
subissue reordering promoted the first eventual reservation, and a second installed runner was
refused by the outer repository-controller lease. Releasing that same Director to 4 CPUs preceded
every admission's fresh capacity sample. Three first-attempt SDK pipelines then integrated serially
through the join and Objective closure; 63 fresh-clone tests and independent behavior checks passed.
Seven calls accounted for 221,536 tokens, no active reservations remained, and all three execution
plus six validation-command scopes and both temporary services were observed absent. This qualifies
only the recorded admission/priority/outer-lease subset, not worker throttling, inner Director CAS,
native concurrency, abrupt recovery, paid burst or the complete adaptive/host matrix.
Fresh installed status and write-free replay agree with the original completed summary, including
three publications/integrations and all seven usage calls. Replay explicitly lacks pinned admission
snapshots and does not recompute the scheduler; the separate captured barriers prove this subset.

Its record separately binds the full release at `13d4efea2b8eaf7ca8ed764492c0f8b2091ad9f8`
(123 files, 2,140 passing tests, three skips, all static/schema/package checks and zero vulnerabilities),
148 final affected tests with typecheck/scoped Biome at `98ce207`, and that later candidate's exact
76-file tarball. Those are distinct source/package checkpoints; neither closes a broad live gate.

The [corrected explicit regular-delivery qualification](release-evidence/regular-delivery-component-2026-09-05.json)
passed through the installed candidate `0c97438f05d721d6cde761b79ae05f5510659199`. Its SDK-first
policy used actual SDK workers for all three first-attempt pipelines: two independent roots and a
dependent join. Each next reservation/start followed the preceding integration on its new base.
All three PRs were validated, reviewed, merged and closed, the Objective closed, and the join's
integration matched the fresh default-branch clone. Thirty clone tests and independent behavior
assertions passed. Seven model-call receipts account for 205,570 tokens; no active reservations
remained and all nine exact recorded scopes were independently absent. This is a passed explicit
serialized regular happy path, not native concurrency, automatic fallback or a broad fault/host gate.
A separate CLI-only run against the same installed subjects also passed: all three first-attempt
workers used the requested CLI backend, with no SDK worker. Its three serialized pipelines closed
and merged all PRs, the dependent join and Objective; 46 fresh-clone tests and independent behavior
assertions passed. Seven model calls account for 199,368 tokens, no active reservations remained,
and all nine exact recorded scopes were absent. Fresh installed status/replay summaries agree on
completion and three distinct publications/integrations; replay is write-free without pinned
scheduler recomputation. Direct CLI selection does not prove observed SDK-failure fallback.

The same candidate passed `npm run verify:release`: 122 files, 2,064 tests and three skips, all
static/schema/bundle/staged-package checks and zero dependency vulnerabilities. The record binds
its exact 74-file local tarball and installed executable identities. Fresh installed status, explain
and replay observations reconstruct the completed run; status/replay summaries agree on three
distinct publications and integrations. Corrected read-only reconstruction of the earlier failed
regular run reports two distinct publications and one integration, with unchanged receipt digest
and 131,699 tokens across five calls. Replay remains write-free and explicitly does not recompute
the scheduler without pinned admission snapshots. Neither correction rewrites the earlier failure.
All six prepublication gates remain Open; subsequent historical records retain their own scopes.

The earlier [explicit regular-delivery observation](release-evidence/regular-delivery-failure-2026-09-05.json)
failed despite passing the offline release batch at `657d746bb8a2708d03f55a898ee04e3da2e0d725`
(121 files, 2,051 tests, three skips). The installed unchanged runtime ran two SDK workers, passed
both independent validations, recorded two review calls, and merged one PR; the other PR was closed
unmerged and the dependent join never started. Pending regular integration failed to block the next
Work Item's admission. A possible additional concurrent publication/recovery race remains under
investigation, not a proved cause. The run escalated with 131,699 known model tokens across five
calls against its initial 500,000-token admission threshold, no active reservations, and all six
exact recorded scopes independently absent. Fresh installed status/explain/replay reads retained the
failure honestly: status and replay summaries agreed, replay was write-free, and scheduler
recomputation remained unavailable without pinned admission snapshots. This is failed explicit
regular qualification and useful read-only reconstruction, not native fallback/concurrency evidence
or a passed live gate. Earlier records and all six prepublication gates remain unchanged.

The final verifier batch `35ea74c00d1f0eba9a963fde9256dba5190b5716` passed the full release
command: 121 test files, 2,035 passing tests and three skips, all static/schema/bundle/package
checks, and zero dependency vulnerabilities. The
[local lifecycle component record](release-evidence/local-lifecycle-component-2026-09-05.json)
separately binds its 72-file local tarball and the earlier installed lifecycle subject. Runtime
bundles did not change. A corrected read-only parser confirmed the retained restart's independent
same-sequence receipts, controller takeover and pause acknowledgement, with no retry/resume and
unavailable worker usage. Neither that parser check nor this release batch closes a live gate.

The installed lifecycle candidate `136983af385413c971bf3f5cd0f744542a56cdf2` passed
`npm run verify:release`: 121 test files, 2,032 passing tests and three skips, typecheck,
lint, formatting, schemas, reproducible bundles, staged clean plugin/npm installation,
and a dependency audit with zero vulnerabilities. The
[local lifecycle component record](release-evidence/local-lifecycle-component-2026-09-05.json)
binds its exact 71-file staged tarball and matching executable digests. Fresh staged npm/plugin
WSL2 no-model startup, controller installation lifecycle and disposable host-process checks also
passed. These host probes did not start a Factory controller or qualify model-backed cancellation.

The exact personal plugin installation accepted withdrawal of the previously queued activation.
Installed status reported `activation.state: withdrawn`, matching request identities, and
`run.state: not-started`, with no Work Items, active reservations or run summary. This is a
never-started activation withdrawal, not cancellation of an active worker.

A separate fresh installed cancellation scenario captured an active worker, recorded the operator's
durable cancellation request, observed the exact captured scope absent, and reached a cancelled run
with one cancelled attempt and no active reservations. It performed no validation, PR publication or
integration. Both exercise and read-only verification remained incomplete because the interrupted
worker's model counters were unavailable. The 14,431 recorded compiler tokens are known partial
usage, not total consumption and not evidence that the worker used zero tokens.

The separate installed restart scenario observed its captured active scope become absent and the
controller invocation change. Installed status then showed the original run paused, one cancelled
attempt and no active reservations. The harness stopped during takeover evidence processing; no
retry or resume was requested and recovered completion was not demonstrated. Its 14,406 known
compiler tokens likewise exclude unavailable interrupted-worker usage. A separate operator cleanup
request subsequently cancelled that same run, with one cancelled attempt, no active reservations or
pending retries, and no publication or integration. The controller was then explicitly stopped and
reported inactive. Cleanup is not recovered completion. These mixed component results close no
complete live gate.

The retained restart diagnostic attributes the reader failure to a harness-only global sequence
uniqueness assumption: an authenticated pause request and an independently written local-budget
reconciliation both used sequence 12. The later authenticated controller observation and exact
resource measurements remain useful evidence, but a verifier correction cannot retroactively turn
the original exercise into a recovered-completion pass. Its original evidence is preserved.

The earlier records below remain bound to their own revisions. In particular, their test counts,
tarball identities and installed observations are not evidence for the latest candidate.

The integrated implementation and matching bundles at `efb9578edd959a23d23e8e9ab0ae97e619b675e8`
passed `npm run verify:release`: 118 test files, 1,996 passing tests and three skips, typecheck,
lint, formatting, schema checks, reproducible bundles, staged clean plugin/npm installation,
and a dependency audit with zero vulnerabilities. The
[completion-batch component record](release-evidence/completion-batch-component-2026-09-05.json)
binds that exact source snapshot, package digest and executable subjects. The tested local tarball
contains 69 files; this later evidence update was not in that tarball.

Fresh staged npm and plugin installations of the same executable subjects also passed no-model
WSL2 component checks: installed startup, explicit controller install/idempotent reinstall/uninstall,
process pressure, descendant cancellation, restart generation and cleanup. These checks did not
start a Factory controller or execute a model-backed Objective. The complete installed happy path
and fault matrix are not claimed passed. Native Linux, macOS-hosted Linux, paid-provider and
published-artifact gates remain open. Earlier records below retain their own revision and scope;
neither a passing component test nor deferred credentials closes a live gate.

The same record includes installed read-only `doctor` and `plan` observations against those bundles.
Doctor reported ready with a controller warning and no allowed paid backend. Plan inspected three
existing Work Items with compilation disabled, no model usage and no writes; it did not verify a
durable graph. Neither operation granted activation authority or establishes Objective completion.

An [installed local Objective observation](release-evidence/installed-local-component-2026-09-05.json)
then compiled three Work Items, ran both independent siblings successfully on their first attempts,
validated both artifacts, and merged one PR. The second sibling remained blocked by GitHub's stale
test-merge metadata after trunk advanced. The operator cancelled the run; the dependent join did not
start. All eight exact recorded execution/validation scopes were subsequently absent. This is useful
partial execution evidence, not an end-to-end pass. GitHub's
[documented test-merge generation policy](https://github.blog/changelog/2026-02-19-changes-to-test-merge-commit-generation-for-pull-requests/)
invalidates an assumption that polling alone will promptly refresh that preview.
The decision whether to permit changing a sibling PR head to obtain fresh preview evidence remains
unanswered. Current integration pacing preserves the unchanged-head and exact-merge guards; it does
not resolve that product decision. This blocker is independent of API keys or paid-provider access.

The same observation records a separate pre-worker failure: durable activation of a plain human
issue was accepted but remained undiscovered because its structural Objective label was missing.
The fault harness injected no cancellation and the controller was stopped. Fixes require fresh
installed qualification; neither the activation receipt nor controller startup passes the fault gate.

The first installed multi-wave Objective escalated during compilation before creating Work Items.
Its [failure record](release-evidence/local-objective-failure-2026-09-04.json) preserves the rejected
acceptance check and unavailable historical model usage. It closes no live gate; missing token
receipts are not evidence of zero consumption.

The [same-Objective retry](release-evidence/local-objective-stream-failure-2026-09-04.json) exposed
incorrect selection of an intermediate agent message as structured output. Failed-call accounting
did persist 29,407 model tokens in GitHub this time. This is live evidence for that accounting path,
not successful compilation or execution.

The [next retry](release-evidence/local-objective-command-failure-2026-09-04.json) reached command
grounding and escalated before graph projection, recording 15,125 model tokens. The fixed npm-alias
discovery list cannot express the fixture's scoped use of its observed test runner. This remains a
failed Objective, not a passed compilation gate.

The subsequent installed WSL2 run on candidate `3e64d41` compiled three native Work Items, admitted
two SDK workers with overlapping attempt lifecycles, independently validated both artifacts, and
published two PRs. Integration escalated on an external automatic review check whose integration
could not access the now-private repository. No PR was merged and the dependent join did not run.
Observed model usage was 157,125 tokens across compilation, two workers, and two reviews; the
150,000-token policy is a stop-before-next-call threshold, not an in-flight hard cap. Raw private
issues, diffs, and job logs are retained outside this public repository. These partial results do not
close the environment, scheduling, native-stack, or Objective E2E gates below.

A subsequent installed local-only qualification compiled three Work Items and completed two
independent worker/validation/review pipelines. Their recorded attempt lifecycles overlapped for
41 seconds; that is not a measurement of physical CPU or model-session concurrency. One sibling
merged, then integration of the other escalated because trunk no longer matched its original base.
The dependent join did not execute. Observed usage was 196,220 model tokens against a 250,000-token
stop threshold, so this failure was not budget exhaustion. The run remains terminal and its
controller was stopped; no replacement run or extra allowance was created to bypass that history.

`test/parallel-sibling-integration.test.ts` now exercises the real Supervisor with local Git and
simulated GitHub/management responses: sequential integration of two independently published
siblings, unchanged PR heads, fresh combined-tree validation, immutable candidate/review reuse
after merge-response loss and lease takeover, repair of a missing integration receipt, stale
test-merge metadata, wrong test-merge trees, external trunk changes, failed tests, rejected semantic
review, and unknown validator cleanup. The candidate proof/checkpoint, publication, review, and
capacity suites cover their lower-level binding and durability contracts. These are offline
component results, not a completed installed Objective, live native stack, or dependent-join gate.
The [component verification record](release-evidence/parallel-sibling-integration-component-2026-09-05.json)
binds the source commit, full release-suite result, exact local package, and freshly reinstalled
CLI/MCP entry points. The historical qualification remains escalated; installation did not revive it.

A [live native-stack API component test](release-evidence/native-stack-component-2026-09-05.json)
created and extended a three-layer stack, replayed deliberately lost success responses without
duplicate writes, merged the lower layers, observed the remaining layer's cascading rebase with
its complete tree preserved, and merged that final layer. All disposable refs were removed; an
independent read-only check confirmed three closed/merged PRs and an unchanged default branch.
This used direct API adapters and no models, not an installed Supervisor. Merge-queue behavior,
fallback, and Factory's cascading independent validation/review remain live qualification work.

| Surface | Evidence | Status |
|---|---|---|
| GitHub custom control refs | Live custom-ref, metadata-commit, workflow-side-effect, and GraphQL compare-and-swap probes against `clockgrove/factory` | Passed |
| Codex CLI management call | Live nested ephemeral call with JSONL and strict output schema on Codex CLI 0.153.0 | Passed |
| Codex SDK local worker contract | Official SDK client, exact-SHA worktree, isolated Codex home, sanitized environment, no-prompt sandboxing, Work-Packet-derived network rules, bounded streamed output, cancellation, usage normalization, artifact collection, and cleanup | Passed in deterministic SDK contract tests; installed live Objective is part of the environment/adversarial gates below |
| Codex CLI local fallback | Exact-SHA worktree, sanitized environment, no-prompt sandboxing, disabled web search, Work-Packet-derived network proxy rules, bounded output, process-group cancellation, artifact collection, and independent fresh-checkout validation tests | Passed |
| Protocol and recovery mechanics | Unit/fault fixtures for leases, reservations, partial graph writes, state derivation, budget reconciliation, stale-base integration, cancellation, and provider-neutral artifacts | Passed |
| Adaptive scheduling mechanics | Deterministic stable-ID priority and DAG fixtures; cgroup v1/v2 and WSL-host sampling; repository/per-Objective capacity CAS; complete local-first/burst admission matrices; continuous refill, fairness, restart reconstruction, and validator native-budget tests | Passed in the full release suite |
| Provider-neutral delivery mechanics | Deterministic sibling/linear/fork/join topology; observed capability selection; exact-head evidence; partial branch/PR/receipt recovery; descendant invalidation; asynchronous merge/queue resume; and reversible integration-lease fixtures | Passed in automated tests; live native-stack behavior remains gated below |
| Explainability, replay, and economics | Stable explanation-code fixtures; bounded status rendering; durable receipt replay; pure credential-free admission replay; tamper detection; distinct-call model-token reconstruction; stop-before-next-call exhaustion; model-profile routing; time-saved burst gating; and observed/unavailable cost accounting | Passed in automated tests |
| Installed plugin shape | Manifest, version, executable, skill, schema, asset, public-marketplace, no-lifecycle-script, standalone bundle, and credential-free startup checks | Passed in staged clean-home Codex installation and both official skill/plugin validators; published-artifact installation remains a separate gate |
| npm package shape | Package allowlist, `factory` executable, exported contract, install-time behavior, and clean `npm`/`npx` startup | Passed in reproducible local packing and clean tarball installation; registry installation and publication provenance remain unverified until publication |
| GitHub managed agents | Provider-neutral managed-session contract, exact-head collection, independent validation, and bounded session accounting | The Copilot adapter and Codex release profile are implemented. Codex discovery remains deliberately unavailable until live evidence records a stable provider-published identity; live runs for both remain release gates. Managed sessions may consume GitHub Actions minutes, but Factory installs no scheduler workflow. |
| Security boundaries | Scope/base/digest checks, suspected-secret rejection, validation-command restrictions, branch-rule fail-closed behavior, repository-identity checks, Factory-controlled worker credential stripping, and exact local/Daytona approval/network argument tests | Passed; provider-controlled managed-agent credential and egress behavior remains gated below |

Detailed live control-plane and CLI observations are recorded in
[`decisions/0001-v2-control-protocol.md`](decisions/0001-v2-control-protocol.md). Exact graph recovery
and the boundary around replanning are recorded in
[`decisions/0002-immutable-graph-recovery.md`](decisions/0002-immutable-graph-recovery.md).

A [WSL cgroup component observation](release-evidence/wsl-cgroup-component-2026-09-04.json)
measured the real sampler inside a transient systemd service capped at one CPU and 256 MiB.
Both ceilings were observed and the unit was automatically collected. This is partial host evidence,
not completion of the Linux environment or live adaptive scheduling gates.

A [local resource component observation](release-evidence/local-resource-observation-component-2026-09-04.json)
detected a synthetic owned worker and observed its graceful exit. Post-exit absence remained unknown:
three same-owner processes denied environment inspection. The observer retained that uncertainty;
this is not a passed cleanup or successor-execution gate. It does not qualify the current
generation-bound resource ownership and cleanup implementation.

## Definition-of-done evidence map

Terminal-run continuation remains an open installed qualification gate: ordinary resume/retry cannot
revive an escalated run. Explicit successor requests, controller adoption, repeated-successor lineage
and mixed retained/fresh native-stack restoration have deterministic coverage in the completed batch.
Installed execution and live delivery-lineage qualification remain outstanding. The
[successor recovery plan](TERMINAL-RECOVERY-IMPLEMENTATION-PLAN.md) covers explicit authority,
cumulative accounting, resource reconciliation, and reuse of validated publications. A startup
guard blocks implicit reuse of executed work; it is containment, not a passed recovery gate.
The read-only `factory_recovery_plan` assessment inspects graph, reservation, publication, and
accounting evidence through a read-only store capability. Historical usage is not new spending
authority, and an observed terminal resource receipt does not prove host/provider cleanup.
Recovery-plan persistence, source-history/allowance-chain verification, authenticated successor
request bindings, cross-run receipt-write fences, immutable pending claims, exact adoption-receipt
replay inspection, and read-only source-evidence resolution have deterministic fixtures.
`factory_recovery_propose` is read-only; `factory_recovery_request` binds explicit authority to its
exact plan without inferring extra allowance. Controller discovery and the Supervisor require that
identity and verified adoption. Offline `test/successor-supervisor.test.ts` covers an existing
publication, independently validated combined-tree integration, response-loss replay, and execution
of its dependent join through Objective completion. These fixtures use real Git with simulated
GitHub and management responses, not live installed agents.

New Linux execution/validation reservations bind command scopes and their producer generation.
`test/controller-retirement.test.ts` includes a real no-model, opt-in systemd probe for controlled
retirement and prevention of a repeated restart. Absence is independently rechecked after restart;
legacy unbound resources, changed hosts, and incomplete observations still block. Repeated-successor
delivery lineage and multi-member native-stack restoration are covered by offline Supervisor fixtures;
live provider cleanup and installed recovery qualification remain open. An observed completion receipt or a descriptive next-event candidate
cannot authorize a worker. These component results do not pass the live recovery gate.

This table maps every stable contract statement in [`DESIGN.md`](DESIGN.md#definition-of-done) to
the executable evidence required on a release branch. “Implemented” does not promote an open live
gate into a platform or paid-provider support claim.

| Contract | Executable evidence | Release-branch result |
|---|---|---|
| DOD-1 — Portable installation | `test/auth.test.ts`, `test/repository-controller.test.ts`, `test/systemd-service.test.ts`, `test/manifest-consistency.test.ts`, `test/package-install.test.ts`, `test/cli-interface.test.ts`, `scripts/verify-plugin-install.mjs`, `scripts/verify-package.mjs`, `scripts/verify-npm-package.mjs` | Staged plugin and npm-tarball verification passed; published-artifact and live-host installation gates remain open |
| DOD-2 — GitHub-only durable control | `test/v2-control.test.ts`, `test/v2-protocol.test.ts`, `test/v2-state.test.ts`, `test/authenticated-events.test.ts`, `test/durable-commands.test.ts`, `test/supervisor-commands.test.ts`, `test/github-reader-history.test.ts`, `test/application-services.test.ts`, `test/repository-controller.test.ts`, `test/control-surface.test.ts`, plus the package verifier's no-workflow check | Implemented; authenticated atomic comment requests, centralized semantic request-ID deduplication, at-least-once replay tolerance, single-controller fencing, and the no-workflow boundary have deterministic coverage |
| DOD-3 — Objective compilation and activation | `test/compiler-pipeline.test.ts`, `test/compiled-graph.test.ts`, `test/compilation-durability.test.ts`, `test/graph.test.ts`, `test/application-services.test.ts`, `test/control-surface.test.ts` | Implemented and deterministic/fault-injection fixtures pass |
| DOD-4 — Adaptive local-first execution | `test/admission.test.ts`, `test/capacity-ledger.test.ts`, `test/resource-sampler.test.ts`, `test/scheduling-priority.test.ts`, `test/local-runtime.test.ts`, `test/codex-sdk-backend.test.ts`, `test/codex-cli-backend.test.ts` | Implemented; broad live-host matrix remains gated below |
| DOD-5 — Explicit bounded cloud burst | `test/admission.test.ts`, `test/budget.test.ts`, `test/economics.test.ts`, `test/backend-conformance.test.ts`, `test/daytona-backend.test.ts`, `test/github-managed.test.ts`, `test/sandbox-contract.test.ts`, `test/supervisor-preflight.test.ts` | Implemented with fake/credential-free adapters; paid-provider runs remain gated below |
| DOD-6 — Durable recovery | `test/repository-controller-faults.test.ts`, `test/compilation-durability.test.ts`, `test/review-durability.test.ts`, `test/scheduling-recovery.test.ts`, `test/session-recovery.test.ts`, `test/integration-recovery.test.ts`, `test/publication.test.ts` | Implemented and injected-fault fixtures pass |
| DOD-7 — Evidence-bound delivery | `test/validation.test.ts`, `test/exact-head-validation.test.ts`, `test/delivery-topology.test.ts`, `test/stack-publication.test.ts`, `test/integration-recovery.test.ts`, `test/checks.test.ts`, `test/merge-candidate.test.ts`, `test/merge-candidates.test.ts`, `test/parallel-sibling-integration.test.ts` | Implemented; combined-tree sibling integration has offline Supervisor coverage; installed Objective and live native-stack matrix remain gated below |
| DOD-8 — Explainable, replayable economics | `test/status-output.test.ts`, `test/explanations.test.ts`, `test/replay.test.ts`, `test/economics.test.ts`, `test/model-economics.test.ts`, `test/budget.test.ts`, `test/admission.test.ts`, installed MCP surface verification | Implemented and read-only contract verified; model tokens are an observed stop threshold with documented one-call overshoot, not a provider hard cap |
| DOD-9 — Evidenced human boundaries | `test/approval.test.ts`, `test/branch-policy.test.ts`, `test/supervisor-preflight.test.ts`, `test/budget.test.ts`, `test/explanations.test.ts`, `test/execution-contract.test.ts` | Implemented and fail-closed fixtures pass |

The release command is `npm run verify:release`: typecheck, lint, formatting, coverage, schema,
deterministic bundle, clean plugin/npm package, and production dependency-audit gates. Recovery of
existing recorded runs is covered by
`test/fixtures/legacy-run-policy.json`, `test/policy.test.ts`, `test/dispatch.test.ts`,
`test/state.test.ts`, `test/v2-protocol.test.ts`, `test/v2-state.test.ts`, and the active-run history
fixtures in `test/github-reader-history.test.ts`.

The same batch covers cancellation-drain token receipts before cleanup, retention of known usage
when cleanup remains uncertain, no stale-lease accounting writes, and preservation of escalation,
cancellation or lease-release outcomes while workers drain. Unknown counters remain unavailable and
unknown resources still block replacement. These are deterministic regressions, not live fault passes.

## Verification required before publication

| Gate | Status | Evidence or open reason |
|---|---|---|
| Linux environment matrix | Open | [Current staged WSL2 component evidence](release-evidence/local-lifecycle-component-2026-09-05.json) covers no-model installation and host-process checks only. Run the default Codex SDK route and Codex CLI fallback with adaptive scheduling, pressure, cancellation, restart, service install/uninstall, and clean validation on native Linux, Windows WSL2, and a Linux guest hosted by macOS. Native Win32 and Darwin are not part of this gate. |
| Live adaptive scheduling matrix | Open | [Installed component evidence](release-evidence/local-scheduling-component-2026-09-05.json) passes native subissue-order admission, a 0.5-to-4-CPU Director leaf barrier and outer repository-controller lease refusal. Organization field edits, broader pressure and phase-kill recovery, inner Director races, paid burst and the remaining host matrix still require [`ADAPTIVE-SCHEDULING-IMPLEMENTATION-PLAN.md`](ADAPTIVE-SCHEDULING-IMPLEMENTATION-PLAN.md). |
| Live native-stack matrix | Open | [Live API component evidence](release-evidence/native-stack-component-2026-09-05.json) covers create/extend response-loss replay, partial direct merge, cascading rebase/tree preservation, final merge, and cleanup. Installed Supervisor recovery, cascading exact-head validation/review, merge-queue ejection, and regular-PR fallback still need live evidence. |
| Real Daytona Objective | Open | Credential-free full-Supervisor tests prove local/Daytona independent-sibling overlap, both integration orders, isolated merge-candidate validation, native accounting restart, and cleanup fail-closed behavior. Sixteen native linear-stack scenarios include four fresh-controller checkpoint/review/receipt replay boundaries without duplicated sandbox, review, or accounting. The opt-in installed runner is described in [provider qualification](PROVIDER-QUALIFICATION.md). Paid creation, TTL, egress, secret brokerage and actual leak cleanup remain unexercised; simulated-provider results do not satisfy this live gate. |
| Two real managed-agent Objectives | Open | Credential-free full-Supervisor scenarios cover three-item Objectives for each simulated profile without fallback. The [installed runner](PROVIDER-QUALIFICATION.md) preserves the missing stable Codex actor identity gate and reports Copilot orchestration separately from unqualified session absence/billing. Real capability discovery, provider Actions-minute billing, exact-head collection, independent validation, cancellation/recovery, credential/egress behavior and no fallback remain required. Existing single-provider backend smokes do not satisfy this gate. |
| Objective-level adversarial E2E | Open | Run a disposable multi-wave Objective through compile, parallel local execution, independent validation, integration, restart recovery, cancellation, failed checks, conflict, budget exhaustion, and final closure. Destructive failure injection belongs in a disposable repository, not `main`. |

Publication requires the checks above to pass. Implemented adapters alone do not establish
end-to-end readiness.

`scripts/verify-publish-readiness.mjs` treats this table as release state, not prose. Each required
gate must occur exactly once and say `Passed`. A passed row must link a checked-in
`docs/release-evidence/*.json` schema-2 record using a relative link such as
`[record](release-evidence/linux.json)`. Each record binds the tested Git commit, commands, required
bundle/package subjects, and evidence artifacts by SHA-256. The tested commit must be an ancestor of
the final release commit, and their trees may differ only in this ledger and
`docs/release-evidence/`. This permits committing evidence after its run without asking a record to
contain its own commit hash. Any other source, bundle, manifest, or documentation change invalidates
the evidence. The final clean, tagged checkout is separately packed and verified; its tarball can
include the newly committed evidence documentation. See the concrete sequence and record format in
[`DELIVERY-PLAN.md`](DELIVERY-PLAN.md#recording-evidence-and-publishing).

## Post-publication completion gate

Publishing the candidate makes this final check possible; it cannot be evidence for the publication
that creates the candidate.

| Gate | Required evidence |
|---|---|
| Published-artifact install | From clean environments, install the synchronized Agent Plugin and `@clockgrove/factory` npm artifacts, start each executable surface without worktree configuration, run a private-repository Objective through the installed product, and verify the published checksums and provenance. |

Delivery is not complete until this gate passes. The immutable package tag already
identifies the published candidate; never move it to add this later evidence. Record the completion
receipt in a follow-up documentation commit or release attachment, identifying that version tag,
its source commit, and the published artifact digests.

No paid gate may be executed or marked passed merely because credentials become available. A real
Daytona or managed-agent run requires separate explicit authorization naming the
provider, target, maximum billable units, and cleanup boundary. Without that authorization, the
correct result is “not exercised,” not “failed” and not an inferred support claim.

## Labs evidence

Vercel Sandbox, Codex App Server, and harness-native child workers are Labs integrations. Their
deterministic tests should remain green, but missing credentials, host capabilities, or live-provider
evidence do not block the initial delivery scope. If a paid Labs provider is exercised, it requires the same
explicit authorization and cleanup boundary as a release provider.

## Product-plan implementation status

[`INDIE-FACTORY-IMPLEMENTATION-PLAN.md`](INDIE-FACTORY-IMPLEMENTATION-PLAN.md) records the accepted
product plan and implementation sequence. Its core repository controller, agent-chat/MCP control,
cost-aware compiler, adaptive single-host scheduler, bounded cloud burst, durable session contract,
provider-neutral delivery state machines, replay/economics surfaces, and staged clean-install
verification are implemented. The release-finalization and live gates above remain open.
