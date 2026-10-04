# Faster wrap

## Goal

Implement `wrap` as `docs/SPEC.md#Wrap` specifies, at least twice as fast
as a naive split-and-join implementation, as measured by the repository's
benchmark.

## Acceptance

- `node scripts/check.mjs wrap` passes.
- The benchmark `npm run bench` reports at least a 2× speedup for `wrap`.

## Planning sources

- `docs/SPEC.md#Wrap`

## Final validation

- `node scripts/check.mjs wrap`

## Non-goals

- Changing other functions.
