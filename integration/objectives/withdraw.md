## Goal

Add `onlyDigits{{ID}}` in its own file `src/onlyDigits{{ID}}.js` as a named export, with its own test `test/onlyDigits{{ID}}.test.js`. No other file changes.

## Acceptance

- `onlyDigits{{ID}}(s)` returns `s` with every character other than 0-9 removed: `onlyDigits{{ID}}("a1b2-3")` is `"123"`.

```factory-commands
npm test
```
