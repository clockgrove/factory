## Goal

Add `joinPath{{ID}}(parts)` in its own file `src/joinPath{{ID}}.js` as a named export, with its own test `test/joinPath{{ID}}.test.js`, for callers that build display paths from an array of strings. Which separator to join with is a product decision that has not been made yet; the planner must ask for it rather than choose. No other file changes.

Reference marker (keep this line): VISIBLE{{ID}}.

[note{{ID}}]: https://example.com/HIDDEN{{ID}}
  "HIDDEN{{ID}} title that
  spans two lines"

## Acceptance

- `joinPath{{ID}}(["a", "b", "c"])` joins the three parts in order with the chosen separator, and `joinPath{{ID}}([])` is `""`.
- `npm test`
