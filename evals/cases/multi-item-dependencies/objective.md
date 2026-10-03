# Add truncate and the textkit command line

## Goal

Implement `wrap` and `truncate`, then add the `textkit` command line that
uses them, as `docs/SPEC.md` specifies.

## Acceptance

- `wrap` behaves as `docs/SPEC.md#Wrap` specifies and
  `node scripts/check.mjs wrap` passes.
- `truncate` in `src/truncate.mjs` behaves as `docs/SPEC.md#Truncate`
  specifies and `node scripts/check.mjs truncate` passes.
- `bin/textkit.mjs` implements the `slug`, `wrap` and `truncate`
  subcommands and `node scripts/check.mjs cli` passes.
- `src/index.mjs` also exports `truncate`.

## Planning sources

- `docs/SPEC.md#Wrap`
- `docs/SPEC.md#Truncate`
- `docs/SPEC.md#Command line`

## Final validation

- `node scripts/check.mjs wrap`
- `node scripts/check.mjs truncate`
- `node scripts/check.mjs cli`

## Non-goals

- Publishing the package or changing `scripts/check.mjs`.
