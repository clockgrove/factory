## Goal

Add `shortestWord{{ID}}` in its own file `src/shortestWord{{ID}}.js` as a named export, with its own test `test/shortestWord{{ID}}.test.js`. No other file changes.

## Acceptance

- `shortestWord{{ID}}(s)` returns the shortest non-empty space-separated word of `s`, the first one on a tie, or `""` when there is none: `shortestWord{{ID}}("aaa b cc d")` is `"b"`.
- `npm test`
