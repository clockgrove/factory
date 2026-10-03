# CLI docs with an integrated docs check

## Goal

Add `truncate`, the `textkit` command line, and `docs/CLI.md`. After all
three integrate, the `docs-build` CI check from
`CONTRIBUTING.md#Required checks` must pass on the integrated result.

## Acceptance

- `node scripts/check.mjs truncate` passes.
- `node scripts/check.mjs cli` passes.
- `docs/CLI.md` documents every subcommand with one example each.
- The `docs-build` check passes on the integrated result.
- `truncate` throws a `RangeError` when `max` is not an integer, such as
  `2.5`.
- `npm test`

## Planning sources

- `docs/SPEC.md#Truncate`
- `docs/SPEC.md#Command line`
- `docs/SPEC.md#Documentation`
- `CONTRIBUTING.md#Required checks`

## Final validation

- `node scripts/check.mjs truncate`
- `node scripts/check.mjs cli`
- `node scripts/check.mjs docs`

## Non-goals

- Implementing `wrap`; `docs/CLI.md` documents it as planned.
