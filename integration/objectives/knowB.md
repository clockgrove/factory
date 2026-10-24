## Goal
Make `parse{{ID}}(text)` in src/parse{{ID}}.js accept quoted values: `a="x y"` gives { a: "x y" } and the quotes are removed. Keep the existing behaviour, with tests.

## Acceptance
- `npm test`
- parse{{ID}}('a="x y"') returns { a: "x y" }; parse{{ID}}("") still throws ParseError{{ID}}.

## Adaptive workflow
enabled
