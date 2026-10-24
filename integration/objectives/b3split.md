## Goal

Two unrelated deliverables that share nothing and should be planned and delivered as two separate child Objectives, one per deliverable, each with its own outcome:

1. A string helper: `src/rev{{ID}}.js` exporting `rev{{ID}}(s)`, which reverses a string, with `test/rev{{ID}}.test.js`.
2. A number helper: `src/sum{{ID}}.js` exporting `sum{{ID}}(xs)`, which sums an array of numbers (`0` for `[]`), with `test/sum{{ID}}.test.js`.

They have different owners and will be reviewed and shipped independently, so please split this Objective into child Objectives rather than one plan. No other file changes.

## Acceptance

- `rev{{ID}}("abc")` is `"cba"`.
- `sum{{ID}}([1, 2, 3])` is `6` and `sum{{ID}}([])` is `0`.
- `npm test`
