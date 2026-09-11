---
name: objective-compilation
description: Compiles a human Objective into the smallest complete, validated DAG of issue-ready Factory Work Items with exact execution and validation requirements; use when an Objective needs decomposition or graph repair.
---

# Objective compilation

Compile an Objective into an issue-ready dependency graph. Work Item count is an output of the work,
never a quota: one item is valid for indivisible work; larger Objectives may require many.

## Ground first

Read the Objective, repository layout, repository instructions, dependency manifests, test/build
configuration, and files that determine likely seams. Never invent paths or commands from convention
alone. If the Objective cannot support observable acceptance criteria, escalate instead of creating
fictional work.

Validation operations normally come from the frozen repository. Use a future repository-capability
adapter only when the compilation context explicitly advertises its authority paths, finite command
grammar, exact runtime, setup destination, and provisioning support. One dependency-root item must
own the adapter's complete absent root authority; a partially present authority surface is observed
state and cannot be completed this way. Descendants may name only promised operations on a transitive
dependency path. A later generation requires an explicit mutator that owns the generation surface
and validates the new operation; scope alone is not a promise. Do not emit capability bindings—the
trusted compiler derives provider, requirement, and generation records after validating the graph.
If no advertised adapter applies, an absent npm, pnpm, bun, uv, Cargo, Go, Python, or other recipe is
unavailable evidence, not permission to rely on an ambient executable.

## Decompose

Prefer independently deliverable behavior with disjoint file scope. Add a dependency only when one
item's output is literally another's input or they must edit the same path. Shared registries/barrels
belong to one item with dependent consumers, not several parallel writers.

Every Work Item must contain:

- a unique short kebab-case `id` and concise `title`;
- one bounded `goal`;
- observable `acceptance` criteria;
- concrete repository-relative `scope` entries (directory entries end in `/`, never use globs);
- explicit `preconditions`, `outOfScope`, and repository-derived `conventions`;
- sibling IDs in `dependsOn`;
- the exact observed `baseSha`;
- one or more authoritative `validationCommands` from the repository's toolchain or an explicitly
  advertised future-capability adapter;
- complete `requirements`: OS, architecture, tools, services, operator-allowed network destinations,
  an empty permitted-secret list, optional resource/time bounds, and `trust`;
- a bounded repository-derived `context` manifest, mechanically classified `changeSurface`,
  criterion-linked validation tiers with an evidence-grounded rationale, and a topology-consistent
  `delivery` hint;
- a conservative `economicReview` based only on known validation/runtime needs (never invent live
  paid measurements);
- `artifactContract: "clockgrove.factory/artifact-v1"`.

The `workItems` array is semantic. Order independent peers by the Objective's requested initial
priority and put every dependency before its dependent. Factory preserves that dependency-aware
order when it creates native sub-issues; the order therefore participates in the durable graph
digest rather than being cosmetic.

Keep the phase boundary exact. A Work Item goal, acceptance criterion, or validation criterion may
describe only a repository-artifact outcome observable from the candidate artifact and evidence
available before publication; conventions are likewise observable implementation constraints. Do
not copy Factory-owned pull-request publication,
merge/integration, issue closure, accounting, later monitoring, scheduler priority, or native
sub-issue placement into the Worker Packet. The Supervisor enforces those lifecycle outcomes;
express code dependencies in `dependsOn`, topology in `delivery`, and initial peer priority through
array order.

Default `trust` to `trusted_local` only for an explicitly activated trusted repository and trusted
Objective provenance. Use `isolated` for untrusted code/tests or requested isolation, and `managed`
only when the task truly requires a GitHub-managed backend. A requested network
destination must already be in the immutable run policy; never expand that policy. Arbitrary task
secrets are not supported, so `permittedSecretNames` must be empty. Treat model-authored OS,
architecture, CPU, memory, disk and timeout values as proposals: the trusted compiler replaces them
with pinned `.factory/execution-requirements.json` evidence, the active run policy, or named defaults.
Do not infer sizing from apparent task complexity. Absent architecture evidence stays portable,
ordinary artifact storage remains backend-managed, and Work Item timeout cannot exceed policy.

Classify each acceptance criterion explicitly and exactly once as ordinary, safety, security,
destructive-action, accounting, or recovery, then assign it to the least expensive sufficient validation tier. Use mechanical
validation alone for exact output, file-mode, lifecycle, and other machine-verifiable outcomes;
semantic review for behavior or qualitative judgment that commands cannot establish; and both only
when the criterion combines protected risk or exact evidence with genuine judgment. Safety,
security, destructive-action, accounting, and recovery requirements always retain a deterministic
gate. Never label protected behavior ordinary merely because the criterion uses a synonym such as
overwrite, purge, API key, expose, charge, ledger, backup, or failover. Every non-semantic tier cites exact entries from `validationCommands`; never claim a generic
command proves a criterion unless observed repository tests or scoped test changes bind that command
to it. Reuse one authoritative artifact or command result across criteria instead of requesting the
same evidence twice.

## Mechanical self-check

Before returning the object:

- every ID is unique and every dependency resolves;
- every dependency precedes its dependent, while independent peers retain requested priority order;
- the graph is acyclic;
- parallel scopes do not overlap;
- every overlapping scope pair has a dependency path, and stack parents exactly match dependencies;
- context, conflict/resource, validation, delivery, and economic fields agree with repository facts;
- every base SHA equals the supplied base;
- validation commands are non-empty and either observed in the repository or connected to exactly
  one advertised provider generation through the dependency graph and backend requirements;
- no field contains a secret value;
- the result validates against `schemas/objective.schema.json` and
  `schemas/work-item.schema.json`.

Return only the compiled Objective object. The Supervisor authenticates the graph digest on the
Objective before applying it, stores the complete graph under an immutable GitHub custom ref, and
persists per-item receipts in each sub-issue. An interrupted application replays that stored object
without recompilation; a divergent replay fails closed. Do not use the standalone legacy
`graph_apply` tool to activate an execution run.
