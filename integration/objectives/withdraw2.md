## Goal

Add `isAllCaps{{ID}}` in its own file `src/isAllCaps{{ID}}.js` as a named export, with its own test `test/isAllCaps{{ID}}.test.js`. No other file changes.

## Acceptance

- `isAllCaps{{ID}}(s)` is `true` when `s` has at least one letter and no lower-case letter a-z: `isAllCaps{{ID}}("AB-1")` is `true`.
- `npm test`
