## Goal

Add `longestWord{{ID}}` in its own file `src/longestWord{{ID}}.js` as a named export, with its own test `test/longestWord{{ID}}.test.js`. No other file changes.

## Acceptance

- `longestWord{{ID}}(s)` returns the longest space-separated word of `s`, the first one on a tie, or `""` when there is none: `longestWord{{ID}}("a bbb cc ddd")` is `"bbb"`.
- `npm test`
