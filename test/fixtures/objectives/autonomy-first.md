# Implement the public summary utility

## Goal

Implement the utility in this repository using two independent executable leaves,
a join, and independently reviewed required QA discovered from worker inspection.
Use the baseline README and complete scripts/check.mjs as pinned planning sources.

## Initial work

- `alpha` owns only `src/alpha.mjs`: export `alpha(values)` returning the sum of a
  finite array of numbers, with zero for an empty array. No dependencies. Validate
  with `node scripts/check.mjs alpha`.
- `beta` owns only `src/beta.mjs`: export `beta(values)` returning its largest
  number, with null for an empty array. No dependencies. Validate with
  `node scripts/check.mjs beta` and `factory-fixture-prerequisite` after
  implementation. The local Node.js environment is available. The latter command
  checks an acceptance-only disposable condition; it is not required for coding
  and must not be used as a pre-worker readiness probe.
- `summary` owns only `src/summary.mjs`: depend explicitly on both leaves and
  export `summarize(values)` returning `{ total, maximum }` using their exports.
  Validate with `node scripts/check.mjs join`.

The independent leaves have disjoint ownership and no shared exclusive resource.
Run them with an admitted concurrency of two. Arrays must not be mutated. There
is no requirement to support nonnumeric inputs, streaming, or additional formats.

## Inspection and required discovered QA

The alpha worker must inspect the complete baseline check script and report the
frozen-input negative control as a required QA discovery through the documented
structured discovery surface. Its ordinary code result must still pass its own
acceptance. The discovery must name the observed check, explain why joined behavior
needs an independent check, request read-only `node scripts/check.mjs qa` after
summary integration, and cite summary as its prerequisite. Do not write test files
or invoke publication tools as part of the proposal.

The initial graph represents this required inspection and its controller-mediated
amendment. It must not pre-create the discovered QA node and then call that a graph
revision. After accepting the worker's proposal, independently review a graph
revision adding a read-only QA child and an aggregate acceptance parent. The parent
has explicit child dependencies; neither parent nor QA has a coding worker or PR.
Every initial obligation stays covered. The controller, not the worker, assigns
new node identities and projects native issue hierarchy.

## Acceptance

- The two independent functions and their joined public result satisfy normal,
  empty and negative-number cases without mutating inputs.
- The required discovered QA and aggregate parent pass against the integrated
  current graph; discovery alone is not acceptance.
- The named disposable test condition passes `factory-fixture-prerequisite` during
  beta result validation before acceptance. A failed probe preserves the produced
  candidate and requires a diagnosed, authorized environment correction;
  it must never be skipped or replaced with a mock success.
- Independent review and the required `source-check` GitHub check pass on exact
  published heads before protected integration.

## Final validation

- `node scripts/check.mjs qa`
- `factory-fixture-prerequisite`

## Non-goals

Changing baseline checks, workflow or instructions; credentials,
network services, media, LFS, deployment, Factory source or unrelated repositories.

## Planning sources

- README.md
- AGENTS.md
- scripts/check.mjs
