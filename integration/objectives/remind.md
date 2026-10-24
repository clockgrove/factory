## Goal

Add `nthWord{{ID}}` in its own file `src/nthWord{{ID}}.js` as a named export, with its own test `test/nthWord{{ID}}.test.js`. No other file changes.

## Acceptance

- `nthWord{{ID}}(s, n)` returns the n-th (1-based) non-empty space-separated word of `s`, or `""` when there is no such word: `nthWord{{ID}}(" a  b c", 2)` is `"b"`.
- `npm test`
