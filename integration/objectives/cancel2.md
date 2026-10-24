## Goal

Add `countLower{{ID}}` in its own file `src/countLower{{ID}}.js` as a named export, with its own test `test/countLower{{ID}}.test.js`. No other file changes.

## Acceptance

- `countLower{{ID}}(s)` returns how many characters of `s` are lower-case letters a-z: `countLower{{ID}}("aBcD-e")` is `3`.
- `npm test`
