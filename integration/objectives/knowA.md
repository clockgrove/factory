## Goal
Add a `parse{{ID}}(text)` function in src/parse{{ID}}.js that rejects empty input with a typed ParseError{{ID}}, with tests.

## Acceptance
- `npm test`
- parse{{ID}}("") throws ParseError{{ID}}; parse{{ID}}("a=1") returns { a: "1" }.

## Sources
- docs/parse.md

## Adaptive workflow
enabled
