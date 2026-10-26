## Goal

Add `discBase{{ID}}(s)` in its own file `src/discBase{{ID}}.js` as a named export, with its own test `test/discBase{{ID}}.test.js`: it returns `s` with every space removed.

## Acceptance

- `discBase{{ID}}("a b c")` is `"abc"`.
- `npm test` passes.

## Constraints

- The Work Item that adds `discBase{{ID}}` runs `npm test` in its validation.
- A file that a test in the repository requires for `discBase{{ID}}` when the work runs is in scope, in a Work Item of its own.
