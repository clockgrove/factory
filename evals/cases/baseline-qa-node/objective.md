# Qualify slug at the current base

## Goal

Qualify the existing `slug` behavior on the current base without changing
code. Run the slug check and the unit tests read-only.

## Acceptance

- `node scripts/check.mjs slug` passes on the base.
- `npm test` passes on the base.

## Planning sources

- `docs/SPEC.md#Slug`

## Final validation

- `node scripts/check.mjs slug`
- `npm test`

## Non-goals

- Any code, test or documentation change.
