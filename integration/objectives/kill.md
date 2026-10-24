## Goal

Add `stripDigits{{ID}}` in its own file `src/stripDigits{{ID}}.js` as a named export, with its own test `test/stripDigits{{ID}}.test.js`. No other file changes.

## Acceptance

- `stripDigits{{ID}}(s)` returns `s` with every character 0-9 removed and every other character kept: `stripDigits{{ID}}("a1b2-3")` is `"ab-"`.
- `npm test`
