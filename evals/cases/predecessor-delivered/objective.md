# Edge-case tests for slug

## Goal

Objective #12 delivered `slug`; it is on `main` at this base. Add
`test/slug-edge.test.mjs` with tests for empty input, input with only
separators, and digits, following `docs/SPEC.md#Slug`.

## Acceptance

- `test/slug-edge.test.mjs` covers empty input, separators only, and
  digits.
- `npm test` passes.

## Planning sources

- `docs/SPEC.md#Slug`

## Final validation

- `npm test`

## Non-goals

- Reimplementing or changing `slug`.
