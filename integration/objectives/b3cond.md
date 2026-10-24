## Goal

Add `pad{{ID}}(s, n)` in `src/pad{{ID}}.js` (pads `s` on the left with spaces to length `n`) with `test/pad{{ID}}.test.js`.

Then a migration: every file under `src/` that imports `legacyPad{{ID}}` must import `pad{{ID}}` instead. Whether any such file exists is not known up front; first take an inventory of `src/`. Declare the migration Work Item with a work condition on that inventory: when the inventory finds no file importing `legacyPad{{ID}}` (the inventory is empty), the migration Work Item is skipped.

## Acceptance

- `pad{{ID}}("7", 3)` is `"  7"`.
- No file under `src/` imports `legacyPad{{ID}}`.
- `npm test`

## Adaptive workflow

enabled
