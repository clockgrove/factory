## Goal

Add two helpers as two Work Items, the second building on the first (it imports it), each in its own file with its own test:

- `src/chainBase{{ID}}.js` exporting `chainBase{{ID}}(s)`, which returns `s` with leading and trailing spaces removed, with `test/chainBase{{ID}}.test.js`.
- `src/chainTop{{ID}}.js` exporting `chainTop{{ID}}(s)`, which returns `chainBase{{ID}}(s)` upper-cased (it must import `chainBase{{ID}}` from `./chainBase{{ID}}.js`), with `test/chainTop{{ID}}.test.js`.

No other file changes.

## Acceptance

- `chainBase{{ID}}("  a b ")` is `"a b"` and `chainTop{{ID}}("  a b ")` is `"A B"`.
- `npm test`
