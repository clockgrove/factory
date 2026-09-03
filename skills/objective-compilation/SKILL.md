---
name: objective-compilation
description: Compiles a human Objective into the smallest complete, validated DAG of issue-ready Factory v2 Work Items with exact execution and validation requirements; use when an Objective needs decomposition or graph repair.
---

# Objective compilation

Compile an Objective into an issue-ready dependency graph. Work Item count is an output of the work,
never a quota: one item is valid for indivisible work; larger Objectives may require many.

## Ground first

Read the Objective, repository layout, repository instructions, dependency manifests, test/build
configuration, and files that determine likely seams. Never invent paths or commands from convention
alone. If the Objective cannot support observable acceptance criteria, escalate instead of creating
fictional work.

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
- one or more authoritative `validationCommands` from the repository's toolchain;
- complete `requirements`: OS, architecture, tools, services, operator-allowed network destinations,
  an empty permitted-secret list for this release, optional resource/time bounds, and `trust`;
- `artifactContract: "clockgrove.factory/artifact-v1"`.

Default `trust` to `trusted_local` only for an explicitly activated trusted repository and trusted
Objective provenance. Use `isolated` for untrusted code/tests or requested isolation, and `managed`
only when the task truly requires the GitHub-managed compatibility backend. A requested network
destination must already be in the immutable run policy; never expand that policy. Arbitrary task
secrets are not supported, so `permittedSecretNames` must be empty. Do not request services, CPU,
memory, or disk without an evidenced need.

## Mechanical self-check

Before returning the object:

- every ID is unique and every dependency resolves;
- the graph is acyclic;
- parallel scopes do not overlap;
- every base SHA equals the supplied base;
- validation commands are non-empty and actually available in the repository/backend requirements;
- no field contains a secret value;
- the result validates against `schemas/objective.schema.json` and
  `schemas/work-item.schema.json`.

Return only the compiled Objective object. The v2 Supervisor authenticates the graph digest on the
Objective before applying it, stores the complete graph under an immutable GitHub custom ref, and
persists per-item receipts in each sub-issue. An interrupted application replays that stored object
without recompilation; a divergent replay fails closed. Do not use the standalone legacy
`graph_apply` tool to activate a v2 execution run.
