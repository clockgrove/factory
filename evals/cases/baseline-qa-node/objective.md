# Qualify slug at the current base

## Outcome

Qualify the existing `slug` behavior on the current base without changing
code. Run the slug check and the unit tests read-only.

## Acceptance

- `node scripts/check.mjs slug` passes on the base.
- `npm test` passes on the base.
- `node scripts/check.mjs slug`
- `npm test`

## Sources

- `docs/SPEC.md#Slug`

## Constraints

- Any code, test or documentation change.
