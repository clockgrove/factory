## Goal

Add a 3D model of a unit cube for the demo scene, with a small preview image. The model is `assets/box{{ID}}.glb` (a valid glTF 2.0 binary with one mesh of a unit cube centred at the origin) and the preview is `assets/box{{ID}}-preview.png` (a 64x64 PNG). Produce two alternative candidate sets that differ only in the cube's colour, so the operator can pick one. Add `test/box{{ID}}-asset.test.js`, which checks that `assets/box{{ID}}.glb` starts with the glTF binary magic `glTF` and declares version 2, and that `assets/box{{ID}}-preview.png` starts with the PNG signature. No other file changes.

## Acceptance

- `assets/box{{ID}}.glb` is a valid glTF 2.0 binary containing one mesh: a unit cube centred at the origin.
- `assets/box{{ID}}-preview.png` is a 64x64 PNG preview of the cube.
- Both are stored in Git LFS, as `.gitattributes` requires.
- `npm test`

## Context

The repository CI checkout hydrates Git LFS (lfs: true), so tests read real asset bytes.
