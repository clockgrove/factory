# truncate subcommand

## Outcome

Objective #14 adds `truncate` in `src/truncate.mjs`. This Objective adds
only the `textkit truncate MAX` subcommand in `bin/textkit.mjs`, using that
delivered `truncate`. Do not implement `truncate` here.

## Acceptance

- `textkit truncate MAX` prints `truncate(input, MAX)` as
  `docs/SPEC.md#Command line` specifies.
- `node scripts/check.mjs truncate`

## Sources

- `docs/SPEC.md#Command line`

## Constraints

- Implementing `truncate` itself; it belongs to Objective #14.
