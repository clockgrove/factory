## Goal

Add two helpers as two Work Items, the second building on the first (it imports it), each in its own file with its own test:

- `src/chainBase{{ID}}.js` exporting `chainBase{{ID}}(s)`, which returns its argument with leading and trailing spaces removed, with `test/chainBase{{ID}}.test.js`.
- `src/chainTop{{ID}}.js` exporting `chainTop{{ID}}(s)`, which returns `chainBase{{ID}}(s)` upper-cased (it must import the first helper from `./chainBase{{ID}}.js`), with `test/chainTop{{ID}}.test.js`.

No other file changes.{{EXTRA}}

## Acceptance

- `chainBase{{ID}}("  a b ")` is `"a b"`.
- `chainTop{{ID}}("  a b ")` is `"A B"`.

```factory-commands
npm test
```
