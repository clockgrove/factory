## Goal

Add `hasDigit{{ID}}` in its own file `src/hasDigit{{ID}}.js` as a named export, with its own test `test/hasDigit{{ID}}.test.js`. No other file changes.

## Acceptance

- `hasDigit{{ID}}(s)` is `true` when `s` contains at least one character 0-9: `hasDigit{{ID}}("ab1")` is `true` and `hasDigit{{ID}}("ab")` is `false`.
- `npm test`
