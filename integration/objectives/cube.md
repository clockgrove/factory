## Goal

Add a 3D model of a unit cube for the demo scene, with a small preview image: the model `assets/cube{{ID}}.glb`, its preview `assets/cube{{ID}}-preview.png`, and a new test of those two delivered files. Offer two candidate sets in different colours so the operator can pick one; only the picked set is delivered. Change no files besides the two assets and the new test.

## Acceptance

- `assets/cube{{ID}}.glb` is a valid glTF 2.0 binary containing one mesh: a unit cube centred at the origin.
- `assets/cube{{ID}}-preview.png` is a 64x64 PNG preview of the cube.
- Both are stored in Git LFS.

```factory-commands
npm test
```
