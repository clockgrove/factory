## Goal

Add a 3D model of a unit cube for the demo scene, with a small preview image: the model `assets/cube{{ID}}.glb`, its preview `assets/cube{{ID}}-preview.png`, and a new test `test/cube{{ID}}.test.js` of those two delivered files. Offer two candidate sets in different colours so the operator can pick one; only the picked set is delivered. Change no files besides the two assets and the new test.

## Acceptance

- `assets/cube{{ID}}.glb` is a valid glTF 2.0 binary containing one mesh: a unit cube centred at the origin.
- `assets/cube{{ID}}-preview.png` is a 64x64 PNG preview of the cube.
- Both are stored in Git LFS.
- `npm test` passes.

## Context

The files are written with the repository's libraries, not by hand. `writeGlb(positions, indices, color)` in `scripts/glb.mjs` returns the bytes of a valid GLB, with the material's `[r, g, b, a]` base colour when `color` is given, and `readGlb(bytes)` parses one. `writePng(width, height, rgba)` in `scripts/png.mjs` returns the bytes of a valid PNG, `readPng(bytes)` parses one, and `fillPolygon(rgba, width, points, color)` draws on the pixels. Supply the cube's vertex data, its drawing and each candidate's colour; the test reads the delivered files with `readGlb` and `readPng`.
