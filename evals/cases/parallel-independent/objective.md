# Implement wrap and truncate

## Goal

Implement `wrap` in `src/wrap.mjs` and `truncate` in `src/truncate.mjs` as
`docs/SPEC.md` specifies. The two functions are independent.

## Acceptance

- `node scripts/check.mjs wrap` passes.
- `node scripts/check.mjs truncate` passes.

## Planning sources

- `docs/SPEC.md#Wrap`
- `docs/SPEC.md#Truncate`

## Final validation

- `node scripts/check.mjs wrap`
- `node scripts/check.mjs truncate`

## Non-goals

- The command line, `src/index.mjs`, and the check script.
