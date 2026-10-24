## Goal

Add `isUpper{{ID}}(s)` in its own file `src/isUpper{{ID}}.js` as a named export, which is `true` when `s` is non-empty and equals its own upper-case form, with its own test `test/isUpper{{ID}}.test.js` written in the style of the source test file below. No other file changes.

## Acceptance

- `isUpper{{ID}}("AB")` is `true` and `isUpper{{ID}}("Ab")` and `isUpper{{ID}}("")` are `false`.
- `npm test`

## Sources

- src/__tests__/x.test.js
