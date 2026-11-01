# Agent rules

- Node 22, ES modules, no dependencies.
- Code in `src/`, tests in `test/` (node:test). `npm test` must pass.
- Keep changes small and match the existing style.
- Binary files: write glTF models with `scripts/glb.mjs` (`writeGlb(positions, indices, color)`, read with `readGlb`) and PNG images with `scripts/png.mjs` (`writePng`, `fillPolygon`, read with `readPng`). Never hand-write the bytes.
