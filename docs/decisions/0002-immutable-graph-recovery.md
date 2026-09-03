# ADR 0002 — Immutable graph recovery before autonomous replanning

Date: 2026-09-03

Status: accepted for protocol v2

## Context

An unattended Supervisor needs to recover from compiler errors, partial GitHub writes, failed Work
Items, and changed repository state. It is tempting to call the compiler again and silently replace
the Work Item graph. That is unsafe once any graph fact is durable: GitHub sub-issues, dependency
edges, attempt reservations, pull requests, budget receipts, and human-visible audit history would no
longer have one stable meaning.

A second compilation is also not guaranteed to be identical. Treating nondeterministic model output
as an in-place repair primitive would weaken idempotency and could expand scope after the operator
accepted the run policy.

## Decision

One v2 run has exactly one content-addressed compiled graph. Factory validates every Work Item against
the immutable run policy and available backend capabilities before persisting that graph or creating
the first sub-issue. It then stores the full graph under an immutable per-run custom ref and records
its digest, blob OID, ref, and size on the Objective.

After persistence, recovery only replays that exact graph to repair missing sub-issues or dependency
edges. A retry may receive bounded, sanitized evidence from an earlier attempt, but it cannot change
the Work Item's scope, dependency position, trust, credentials, backend permissions, or budget.

If the graph is structurally invalid, no GitHub issue is written. If the durable graph becomes
inadequate or execution exhausts its bounded attempts, Factory escalates with evidence. Creating a
different graph requires an explicitly authorized new run; it is not a hidden mutation of the active
run.

## Consequences

- Crash recovery is deterministic and never needs a model call.
- Existing issue and attempt history keeps one auditable meaning.
- Factory can safely repair a response-lost graph write without duplicating valid work.
- Protocol v2 deliberately does not claim autonomous graph replacement. Safe unattended replanning
  would require versioned graph revisions, rules for superseding issue and attempt history, new budget
  authorization, and a migration protocol. That is a future protocol change, not a release shortcut.
