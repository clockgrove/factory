# Objective planning qualification

This qualification separates schema capacity from live execution scale. It does not claim that a
100-Work-Item graph, a 101-requirement project, or automatic cross-Objective execution ran live.

## Candidate record

Record the exact Git commit and run policy used for qualification. The fresh default planning policy
is `maxWorkItemsPerObjective: 24`, `maxCriticalPathRatio: 0.75`, and
`maxAggregateWorkRatio: 1.5`; these numerical values remain provisional until observed planning data
supports changing them. Record input, output, and cached model tokens exactly when available, and
record unavailable counters as unavailable. List every human correction or selection; do not infer
that no intervention occurred from missing evidence.

## Deterministic scenarios

Run `npm test -- --run test/objective-planning.test.ts test/compiler-contracts.test.ts
test/application-plan-lfs.test.ts` on the exact candidate. The covered scenarios are:

- one indivisible Work Item and a bounded feature remain on the ordinary Objective path;
- a seven-item serial graph crosses its configured critical-path threshold;
- null duration estimates do not become zero or invented forecasts;
- 101 parent requirements produce separately bounded proposed Objectives with complete coverage;
- omissions, invalid aggregate integration, unresolved prerequisite outputs, cycles, and overlapping
  unordered scope are rejected;
- read-only planning returns the exact proposal identity and usage without a graph, issue creation,
  activation, or completion claim.

Any model-backed qualification additionally records the exact Objective text, base commit, full
immutable policy, management backend/model selection, proposal identity, validation report, usage,
and human interventions. Proposed Objective count is planning evidence only. Each child must later be
compiled against the commit containing its accepted prerequisite outputs.
