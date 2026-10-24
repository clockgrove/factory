## Goal

Create `src/shared{{ID}}.js` with a named export `sharedTrim{{ID}}(s)`, and its test `test/shared{{ID}}.test.js`. No other file changes.

## Acceptance

- `sharedTrim{{ID}}(s)` returns `s` with leading and trailing spaces removed: `sharedTrim{{ID}}("  a b ")` is `"a b"`.
- `npm test`
