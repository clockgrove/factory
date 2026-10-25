## Goal

Add three helpers as three Work Items, each in its own file with its own test. The second builds on the first (it imports it); the third is independent of both:

- `src/scopeBase{{ID}}.js` exporting `scopeBase{{ID}}(s)`, which returns `s` with leading and trailing spaces removed, with `test/scopeBase{{ID}}.test.js`.
- `src/scopeTop{{ID}}.js` exporting `scopeTop{{ID}}(s)`, which returns `scopeBase{{ID}}(s)` upper-cased (it must import `scopeBase{{ID}}` from `./scopeBase{{ID}}.js`), with `test/scopeTop{{ID}}.test.js`.
- `src/scopeSolo{{ID}}.js` exporting `scopeSolo{{ID}}(s)`, which returns `s.length`, with `test/scopeSolo{{ID}}.test.js`.

No other file changes.

## Acceptance

- `scopeBase{{ID}}("  a b ")` is `"a b"`.
- `scopeTop{{ID}}("  a b ")` is `"A B"`.
- `scopeSolo{{ID}}("abc")` is `3`.
- `npm test`
