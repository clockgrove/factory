# Agent rules

- Node 22, ES modules, no dependencies.
- Code in `src/`, tests in `test/` (node:test). `npm test` must pass.
- Keep changes small and match the existing style.
- Binary glTF models: write them with `scripts/glb.mjs` (`writeGlb`), read them with `readGlb`. Never hand-write the bytes.
