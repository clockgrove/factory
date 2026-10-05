# Implement wrap

## Outcome

Implement `wrap(text, width)` in `src/wrap.mjs` as `docs/SPEC.md#Wrap`
specifies.

## Acceptance

- `wrap` packs words greedily into lines of at most `width` characters and
  puts a word longer than `width` on its own line.
- `wrap` throws a `RangeError` when `width` is not a positive integer.
- `node scripts/check.mjs wrap`

## Sources

- `docs/SPEC.md#Wrap`

## Constraints

- Changing `slug`, `scripts/check.mjs` or adding the command line.
