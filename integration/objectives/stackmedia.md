## Goal

Add a coloured badge image and a helper that uses it, as two Work Items where the second builds on the first (a stack). The first adds `assets/badge{{ID}}.png`, a 32x32 PNG filled with one colour, stored in Git LFS as `.gitattributes` requires; produce two alternative candidate sets that differ only in the colour, so the operator can pick one. The second adds `src/badge{{ID}}.js` exporting `badgePath{{ID}}()`, which returns the string `"assets/badge{{ID}}.png"`, with `test/badge{{ID}}.test.js` checking that value and that the file exists and starts with the PNG signature. No other file changes.

## Acceptance

- `assets/badge{{ID}}.png` is a 32x32 single-colour PNG in Git LFS.
- `badgePath{{ID}}()` is `"assets/badge{{ID}}.png"`, and that file exists and starts with the PNG signature.
- `npm test`

## Context

The helper needs the badge, so the helper's Work Item builds on the badge's.
