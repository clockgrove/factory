## Goal

Add a small star icon and a module that describes it.

1. A Work Item makes the icon `assets/star{{ID}}.png`, a 32x32 PNG of a five-pointed star on a transparent background. It produces two alternative candidate sets that differ only in the star's colour (gold and silver), so the operator can pick one.
2. A second Work Item, which depends on the first, adds `src/starIcon{{ID}}.js` exporting `starIcon{{ID}} = { path: "assets/star{{ID}}.png", width, height, sha256 }`, where `width`, `height` and `sha256` are read from the exact PNG the operator selected (given to it as a read-only input), and `test/starIcon{{ID}}.test.js`, which checks that `width` and `height` are both 32 and `sha256` is 64 lower-case hex characters. It must not change `assets/star{{ID}}.png`.

No other file changes.

## Acceptance

- `assets/star{{ID}}.png` is a 32x32 PNG stored in Git LFS, as `.gitattributes` requires.
- `src/starIcon{{ID}}.js` describes the selected PNG's real width, height and SHA-256.
- `npm test`

## Context

The repository CI checkout hydrates Git LFS (lfs: true), so tests read real asset bytes.
