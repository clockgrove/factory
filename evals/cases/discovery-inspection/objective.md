# Inspect slug for accented letters

## Goal

`slug("Café")` returns `caf` today, which drops the accented letter. One
read-only inspection Work Item examines `src/slug.mjs` against
`docs/SPEC.md#Slug` and reports what it finds as a structured discovery that
proposes the follow-up change and its acceptance. Factory then amends the
graph through its normal amendment review. Do not plan the fix up front.

## Acceptance

- The inspection runs `node scripts/check.mjs slug` on the base and passes.
- The inspection submits one discovery that names the accented-letter
  behavior and proposes acceptance for a follow-up change.

## Planning sources

- `docs/SPEC.md#Slug`

## Final validation

- `node scripts/check.mjs slug`

## Non-goals

- Changing `src/slug.mjs` or `docs/SPEC.md` in this Objective.
