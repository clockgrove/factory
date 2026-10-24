## Goal

Set the palette in `src/palette.js`: `palette` becomes `["{{C1}}", "{{C2}}", "{{C3}}"]`. Update `test/palette.test.js` to match. The repository's `scripts/review-image.mjs` renders the palette as a swatch PNG for review; run it as part of validation so the reviewer can see the swatch. No other file changes.

## Acceptance

- `palette` is `["{{C1}}", "{{C2}}", "{{C3}}"]`.
- `npm test`
- `node scripts/review-image.mjs`
- The swatch shows three bands, in that order: {{C1}}, {{C2}}, {{C3}}.
