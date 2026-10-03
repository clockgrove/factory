# Implement the summary alpha function

## Goal

Implement `alpha(values)` in `src/alpha.mjs` so that it returns the sum of a
finite array of numbers, with zero for an empty array. One Work Item owns only
`src/alpha.mjs` and has no dependencies.

## Acceptance

- `alpha` returns the sum for normal, empty and negative-number inputs.
- `alpha` does not mutate its input array.

## Final validation

- `node scripts/check.mjs alpha`

## Non-goals

Changing `scripts/check.mjs`, `src/beta.mjs`, the summary join, the README or
the repository instructions.
