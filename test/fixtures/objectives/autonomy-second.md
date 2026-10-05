# Explain the accepted summary utility

## Outcome

After the first Objective is independently accepted, use its exact integrated
baseline to create only `GUIDE.md`. Describe importing `summarize`, the normal
example `[3, -2, 8]`, the empty array `[]`, the `total` and `maximum` fields, null
for an empty maximum, and the promise that input is not mutated. Include a working
Node.js usage example. Do not change implementation or acceptance scripts.

This Objective has a native GitHub blocked-by dependency on the first Objective.
Materialize its plan only after the predecessor is accepted, binding the new plan
to the actual accepted predecessor head. Queueing alone does not satisfy that gate.

## Acceptance

- GUIDE.md accurately explains the accepted implementation and examples.
- The first Objective's accepted implementation and immutable checks are unchanged.
- The predecessor's full QA still passes and independent review accepts the guide.
- `node scripts/check.mjs guide`
- `node scripts/check.mjs qa`

## Sources

- README.md
- AGENTS.md
- scripts/check.mjs
- src/alpha.mjs
- src/beta.mjs
- src/summary.mjs

## Constraints

Implementation, dependency changes, deployment, media or extra features.
