## Goal

Add `countChar{{ID}}` in its own file `src/countChar{{ID}}.js` as a named export, with its own test `test/countChar{{ID}}.test.js`. No other file changes.

## Acceptance

- `countChar{{ID}}(s, ch)` returns how many times the single character `ch` occurs in `s`, case-sensitive: `countChar{{ID}}("banana", "a")` is `3`, `countChar{{ID}}("Banana", "b")` is `0` and `countChar{{ID}}("", "a")` is `0`.
- `npm test` passes.
