# Implement wrap under required CI

## Goal

Implement `wrap` in `src/wrap.mjs` as `docs/SPEC.md#Wrap` specifies, with a
unit test in `test/wrap.test.mjs`. The pull request must pass the required
check named in `CONTRIBUTING.md#Required checks` before it merges.

## Acceptance

- `node scripts/check.mjs wrap` passes.
- `npm test` passes, including `test/wrap.test.mjs`.
- The required CI check passes before merge.

## Planning sources

- `docs/SPEC.md#Wrap`
- `CONTRIBUTING.md#Required checks`

## Final validation

- `node scripts/check.mjs wrap`
- `npm test`

## Non-goals

- Changing CI configuration or `scripts/check.mjs`.
