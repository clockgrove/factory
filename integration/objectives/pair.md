## Goal

Add two independent helpers as two Work Items that don't depend on each other, each in its own file with its own test:

- `src/pairLeft{{ID}}.js` exporting `pairLeft{{ID}}(s)`, which returns the first character of `s` (or `""`), with `test/pairLeft{{ID}}.test.js`.
- `src/pairRight{{ID}}.js` exporting `pairRight{{ID}}(s)`, which returns the last character of `s` (or `""`), with `test/pairRight{{ID}}.test.js`.

No other file changes.

## Acceptance

- `pairLeft{{ID}}("abc")` is `"a"` and `pairLeft{{ID}}("")` is `""`.
- `pairRight{{ID}}("abc")` is `"c"` and `pairRight{{ID}}("")` is `""`.

```factory-commands
npm test
```
