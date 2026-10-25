## Goal

Add `discBase{{ID}}(s)` in its own file `src/discBase{{ID}}.js` as a named export, with its own test `test/discBase{{ID}}.test.js`: it returns `s` with every space removed. No other file changes.

## Acceptance

- `discBase{{ID}}("a b c")` is `"abc"`.

```factory-commands
npm test
```

## Constraints

- This Objective drills Factory's discovery path. The plan has exactly one Work Item, which owns only `src/discBase{{ID}}.js` and `test/discBase{{ID}}.test.js`.
- Its worker must not create any other file. It must propose, as an in-scope discovery in `.factory-discovery.json`, a second Work Item that adds `src/discMore{{ID}}.js` exporting `discMore{{ID}}(s)`, which returns `discBase{{ID}}(s).length`, with `test/discMore{{ID}}.test.js`, depending on the first.
