## Goal

Add `{{FN}}` in its own file `src/{{FN}}.js` as a named export, with its own test `test/{{FN}}.test.js`. No other file changes.

## Acceptance

- `{{FN}}(s)` returns `s` reversed: `{{FN}}("abc")` is `"cba"`.
- `npm run ci-only` passes.

## Sources

- `drill/missing{{ID}}.md`
