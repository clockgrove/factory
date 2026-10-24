## Goal

Add `countUpper{{ID}}` in its own file `src/countUpper{{ID}}.js` as a named export, with its own test `test/countUpper{{ID}}.test.js`. No other file changes.

## Acceptance

- `countUpper{{ID}}(s)` returns how many characters of `s` are upper-case letters A-Z: `countUpper{{ID}}("aBcD-E")` is `3`.
- `npm test`
