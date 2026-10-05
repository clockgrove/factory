# Implement wrap under required CI

## Outcome

Implement `wrap` in `src/wrap.mjs` as `docs/SPEC.md#Wrap` specifies, with a
unit test in `test/wrap.test.mjs`. The pull request must pass the required
check named in `CONTRIBUTING.md#Required checks` before it merges.

## Acceptance

- `npm test` passes, including `test/wrap.test.mjs`.
- The required CI check passes before merge.
- `node scripts/check.mjs wrap`
- `npm test`

## Sources

- `docs/SPEC.md#Wrap`
- `CONTRIBUTING.md#Required checks`

## Constraints

- Changing CI configuration or `scripts/check.mjs`.
