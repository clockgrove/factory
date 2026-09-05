# Implementation handoff

Implementation and qualification are in progress. Completing an integration batch does not establish
that the product contract is complete. The last bundled checkpoint is `3780a29`; the completion work
below must be integrated, tested, and rebuilt before it can replace that checkpoint.
[DESIGN.md](DESIGN.md) defines behavior; [CONFORMANCE.md](CONFORMANCE.md) remains the release-gate
ledger. This document grants no execution, spending, installation, or publication authority.

## Completion acceptance

| Capability | Required outcome | Status |
| --- | --- | --- |
| Ordinary restart and receipt repair | Resume after authenticated same-run merges; reject external trunk changes; reconstruct reservation receipts without losing immutable resource identity. | Integrated; targeted regression checks passed; full batch pending |
| Partial native-stack recovery | Retain validated lower work and execute unfinished upper work through exact-evidence publication and integration without duplicate work. | In progress |
| Generic, economic compilation | Ground commands in observed repository toolchains, accept explicit exclusive-resource claims, and evaluate decomposition costs without fabricated prices or measurements. | Integrated; targeted regression checks passed; full batch pending |
| Chat preflight and planning | Doctor performs useful mechanical diagnostics; explicit plan produces or inspects a proposed graph before activation; CLI and MCP share the same write-free inspection contract. | Integrated; targeted regression checks passed; installed verification pending |
| Managed providers | Prove assignable provider identities and owned session lifecycle observations for both managed targets; preserve explicit unsupported boundaries until evidenced. | Exact Copilot task/session reconciliation integrated and regression-tested; live credentials and Codex identity remain external gates |
| Installed complete Objective | Qualify matching installed artifacts through parallel siblings, independent validation/review, integration, dependent join, final closure, and bounded recovery/cancellation cases. | Pending integration |
| Release verification | Run the complete integrated suite and package checks; preserve exact-revision evidence and the independent host/provider/publication gates. | Pending integration |

These are completion gates, not a new architecture or permission to reduce scope. Regression tests
must expose the reported defects before a fix is accepted. Simulated fixtures, component probes,
installed local runs, and paid-provider/host qualification remain distinct evidence scopes.

The current completion effort proceeds with credential-free verification and local installed runs.
Paid-provider qualification is deferred until the operator supplies credentials; this does not waive
provider evidence or authorize fallback, extra spending, publication, or a reduced support contract.

## Integrated capabilities

| Capability | Integrated implementation |
| --- | --- |
| Provider execution | `db15c41`: local/Daytona sibling pipelines, fresh isolated candidate validation, exact invocation ownership, durable native accounting and cleanup-uncertainty handling. Accepted `trusted_local` overflow may feed local work; isolated requirements never become local authority. |
| Daytona native linear stacks | `f0ab346` + `59f90d6`: native-stack Daytona admission, rewritten-head/base/artifact-bound isolated validation, immutable completion before paid review, separate capacity/budget replay and partial publication/integration repair. Local native validation retains scoped resource ownership. The cloud-child fixture is written but unexecuted. |
| Portable installation and Linux host runner | `b44742d`: installed npm/plugin identity verification and reusable no-model host qualification runner. Earlier staged WSL2 evidence is not an integrated-tree or complete host-matrix pass. |
| Event schemas | `e7181d0` + `061e419`: recovery source-publication/integration fields, source-capacity and scope-batch envelopes. Runtime still enforces cross-field identity, chronology and authenticated lineage. |
| Successor recovery | `bf3388a` + `3780a29`: plan-bound requests, adoption, cumulative accounting, repeated-successor lineage, source-delivery restoration, failed-attempt eligibility and leased completed-merge reconciliation. Original source attempts and terminal history are not rewritten as successor authority. |
| Distributable artifacts | `3780a29`: CLI and MCP bundles regenerated from the combined source, with matching dependency inventory and notices. A separate temporary rebuild reproduced all four artifacts byte-for-byte. No plugin reinstall or publication was performed. |

## Implementation closeout

- [x] Integrate the recovery owner's source/proof work and the final leased
  lost-lower-merge-response reconciliation wiring: `3780a29`.
- [x] Reconcile source changes with schemas and documentation and regenerate both bundles,
  inventory and notices: `3780a29`.
- [x] Review immutable policy and cumulative allowances, authenticated requests, original
  artifact/validation bindings, exact native membership, checkpoint/review reuse and resource
  ownership remain intact. Never fabricate stack receipts or turn unknown cleanup into absence.

Static checks passed on the combined source: `npm run typecheck`, `npm run lint`,
`npm run format:check`, `npm run verify:schemas`, `npm run verify:dist`, and `git diff --check`.
The schema check compiles all nine schemas; it is not a runtime protocol-conformance test.
Independent source review covered the local/isolated validation merge, new event wire shapes,
and the pre-lease inspection / leased repair / strict runtime re-verification boundary.

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
