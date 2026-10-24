## Goal

Add three text helpers that build on each other, plus one independent helper. Each helper lives in its own file `src/<name>.js` as a named export with its own test `test/<name>.test.js`. No other file changes.

## Acceptance

- `collapseSpaces{{ID}}(s)` replaces each run of spaces in `s` with one space and trims both ends: `collapseSpaces{{ID}}("  a   b ")` is `"a b"`.
- `slugWords{{ID}}(s)` lower-cases `collapseSpaces{{ID}}(s)` and replaces each space with `-`, importing `collapseSpaces{{ID}}` from `src/collapseSpaces{{ID}}.js`: `slugWords{{ID}}("  Hello   World ")` is `"hello-world"`.
- `titleSlug{{ID}}(s)` returns `"title-"` followed by `slugWords{{ID}}(s)`, importing `slugWords{{ID}}` from `src/slugWords{{ID}}.js`: `titleSlug{{ID}}("A B")` is `"title-a-b"`.
- `isEmptyText{{ID}}(s)` is `true` when `s` has no characters other than spaces.
- `npm test`

## Context

`slugWords{{ID}}` needs `collapseSpaces{{ID}}`, and `titleSlug{{ID}}` needs `slugWords{{ID}}`, so those three are a chain of Work Items, each building on the one before. `isEmptyText{{ID}}` is independent.
