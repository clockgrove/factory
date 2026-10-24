## Goal

Add `startsWithDigit{{ID}}` in its own file `src/startsWithDigit{{ID}}.js` as a named export, with its own test `test/startsWithDigit{{ID}}.test.js`. No other file changes.

## Acceptance

- `startsWithDigit{{ID}}(s)` is `true` when the first character of `s` is 0-9, and `false` otherwise, including for `""`: `startsWithDigit{{ID}}("9a")` is `true`.
- `npm test`
