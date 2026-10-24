## Goal

Add two independent helpers, each in its own file with its own test, as two separate Work Items that don't depend on each other and can be built and delivered in parallel (one PR each):

- `src/twinUpper{{ID}}.js` exporting `twinUpper{{ID}}(s)`, which returns `s` upper-cased, with `test/twinUpper{{ID}}.test.js`.
- `src/twinLower{{ID}}.js` exporting `twinLower{{ID}}(s)`, which returns `s` lower-cased, with `test/twinLower{{ID}}.test.js`.

No other file changes.

## Acceptance

- `twinUpper{{ID}}("aB")` is `"AB"` and `twinLower{{ID}}("aB")` is `"ab"`.
- `npm test`
