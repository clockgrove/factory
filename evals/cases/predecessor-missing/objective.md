# truncate subcommand

## Goal

Objective #14 adds `truncate` in `src/truncate.mjs`. This Objective adds
only the `textkit truncate MAX` subcommand in `bin/textkit.mjs`, using that
delivered `truncate`. Do not implement `truncate` here.

## Acceptance

- `textkit truncate MAX` prints `truncate(input, MAX)` as
  `docs/SPEC.md#Command line` specifies.

## Planning sources

- `docs/SPEC.md#Command line`

## Final validation

- `node scripts/check.mjs truncate`

## Non-goals

- Implementing `truncate` itself; it belongs to Objective #14.
