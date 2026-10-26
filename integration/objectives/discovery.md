## Goal

Add `discBase{{ID}}(s)` in its own file `src/discBase{{ID}}.js` as a named export, with its own test `test/discBase{{ID}}.test.js`: it returns `s` with every space removed. Add `discMore{{ID}}(s)` in its own file `src/discMore{{ID}}.js` as a named export, with its own test `test/discMore{{ID}}.test.js`: it returns `discBase{{ID}}(s).length`. No other file changes.

## Acceptance

- `discBase{{ID}}("a b c")` is `"abc"`.
- `discMore{{ID}}("a b c")` is `3`.
- `npm test` passes.

## Constraints

- This Objective drills Factory's discovery path. The plan has exactly one Work Item. It owns only `src/discBase{{ID}}.js` and `test/discBase{{ID}}.test.js`, and it covers both the `discBase{{ID}}` and the `discMore{{ID}}` criteria.
- The `discMore{{ID}}` files are left out of that Work Item on purpose: its acceptance then needs paths it doesn't own, so its worker proposes them as an in-scope discovery, and the amendment adds the Work Item that owns them, depending on the first.
