# Implementation handoff

Implementation checkpoint, not release approval. Current integrated baseline: `061e419`.
Finish the remaining recovery edge and synchronize artifacts before deferred testing.
[DESIGN.md](DESIGN.md) defines behavior; [CONFORMANCE.md](CONFORMANCE.md) remains the release-gate
ledger. This document grants no execution, spending, installation, or publication authority.

## Integrated capabilities

| Capability | Integrated implementation |
| --- | --- |
| Provider execution | `db15c41`: local/Daytona sibling pipelines, fresh isolated candidate validation, exact invocation ownership, durable native accounting and cleanup-uncertainty handling. Accepted `trusted_local` overflow may feed local work; isolated requirements never become local authority. |
| Daytona native linear stacks | `f0ab346` + `59f90d6`: native-stack Daytona admission, rewritten-head/base/artifact-bound isolated validation, immutable completion before paid review, separate capacity/budget replay and partial publication/integration repair. Local native validation retains scoped resource ownership. The cloud-child fixture is written but unexecuted. |
| Portable installation and Linux host runner | `b44742d`: installed npm/plugin identity verification and reusable no-model host qualification runner. Earlier staged WSL2 evidence is not an integrated-tree or complete host-matrix pass. |
| Event schemas | `e7181d0` + `061e419`: recovery source-publication/integration fields, source-capacity and scope-batch envelopes. Runtime still enforces cross-field identity, chronology and authenticated lineage. |
| Successor recovery | Plan-bound requests, adoption, cumulative accounting, resource observations and source-delivery restoration are integrated. The final recovery revision remains pending below. Original source attempts and terminal history are not rewritten as successor authority. |

## Remaining implementation closeout

- [ ] Integrate the recovery owner's final lost-lower-merge-response reconciliation fix.
  Record **recovery revision: `<RECOVERY_COMMIT>`**.
- [ ] Reconcile final source changes with schemas and documentation, then regenerate both bundles,
  inventory and notices. Record **final source/artifact revision: `<FINAL_BUNDLE_COMMIT>`**.
- [ ] Confirm immutable policy and cumulative allowances, authenticated requests, original
  artifact/validation bindings, exact native membership, checkpoint/review reuse and resource
  ownership remain intact. Never fabricate stack receipts or turn unknown cleanup into absence.

Interrupted isolated revalidation without a passing durable completion checkpoint remains blocked
for resource reconciliation. It does not authorize another invocation or establish zero usage.

## Deferred verification checklist

No runtime qualification is claimed for this integrated checkpoint. Earlier results apply only to
their recorded revisions and scopes. Implementation-first defers, rather than waives, this work:

- [ ] Run integrated recovery, provider, native-stack, publication, accounting and portable tests.
  Cover repeated successors, failed-attempt continuation, lower-merge response loss, rewritten heads,
  partial publication, checkpoint/review replay, cancellation, budget exhaustion and unknown cleanup.
  Prove no duplicate work or spend; record exact revision and results.
- [ ] Run the required `npm run verify:release` batch after source/artifact synchronization and
  resolve failures. Earlier capability-branch passes are not substitutes.
- [ ] Exercise installed artifacts for controller recovery, adaptive scheduling, native cascading
  validation/review and the Linux SDK/CLI host matrix. Simulated providers, direct API probes and
  one staged WSL2 component run do not establish end-to-end support.
- [ ] Obtain separate provider/target/billable-unit/cleanup authorization before paid qualification.
  Daytona lifecycle/absence and both managed-agent Objectives remain live gates. Missing Codex
  provider identity and unqualified managed-session absence/billing remain explicit blockers.
- [ ] Complete [prepublication gates](CONFORMANCE.md#verification-required-before-publication)
  before separately authorized publication, then the
  [published-install gate](CONFORMANCE.md#post-publication-completion-gate) against exact published
  artifacts. No publication, controller upgrade or service change is authorized here.

Report implementation completion separately from test, installed-runtime and release qualification.
