## Goal

Add `tailWord{{ID}}` in its own file `src/tailWord{{ID}}.js` as a named export, with its own test `test/tailWord{{ID}}.test.js`. No other file changes.

## Acceptance

- `tailWord{{ID}}(s)` returns the last non-empty space-separated word of `s`, or `""` when there is none: `tailWord{{ID}}(" a  b c ")` is `"c"`.
- `npm test`
- `npm run lint-drill{{ID}}`
