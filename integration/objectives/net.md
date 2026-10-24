## Goal

Add `mirrorText{{ID}}` in its own file `src/mirrorText{{ID}}.js` as a named export, with its own test `test/mirrorText{{ID}}.test.js`. No other file changes.

## Acceptance

- `mirrorText{{ID}}(s)` returns `s` followed by its characters in reverse order: `mirrorText{{ID}}("ab")` is `"abba"` and `mirrorText{{ID}}("")` is `""`.
- `npm test`
