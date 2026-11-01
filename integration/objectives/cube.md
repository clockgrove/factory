## Goal

Add a 3D model of a unit cube for the demo scene, with a small preview image: the model `assets/cube{{ID}}.glb`, its preview `assets/cube{{ID}}-preview.png`, and a new test of those two delivered files. Offer two candidate sets in different colours so the operator can pick one; only the picked set is delivered. Change no files besides the two assets and the new test.

## Acceptance

- `assets/cube{{ID}}.glb` is a valid glTF 2.0 binary containing one mesh: a unit cube centred at the origin.
- `assets/cube{{ID}}-preview.png` is a 64x64 PNG preview of the cube.
- Both are stored in Git LFS.
- `npm test` passes.

## Context

The model is written with the repository's GLB library, not by hand: `writeGlb(positions, indices, color)` in `scripts/glb.mjs` returns the bytes of a valid GLB, with the material's `[r, g, b, a]` base colour when `color` is given, and `readGlb(bytes)` parses one. Supply the cube's vertex data and each candidate's colour; the test reads the delivered model with `readGlb`.

## Sources

- `scripts/glb.mjs`
