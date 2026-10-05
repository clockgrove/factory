# Faster wrap

## Outcome

Implement `wrap` as `docs/SPEC.md#Wrap` specifies, at least twice as fast
as a naive split-and-join implementation, as measured by the repository's
benchmark.

## Acceptance

- The benchmark `npm run bench` reports at least a 2× speedup for `wrap`.
- `node scripts/check.mjs wrap`

## Sources

- `docs/SPEC.md#Wrap`

## Constraints

- Changing other functions.
