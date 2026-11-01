# Factory integration drill

Scratch target the Factory integration suite creates for one run and deletes
after it. It holds a tiny Node library that the run's Objectives change. Not
product code.

`scripts/glb.mjs` and `scripts/png.mjs` are small, correct GLB and PNG writers and readers,
so the media case's model and preview are made by the libraries rather than by hand: that
case checks Factory's media flow, not a model's skill with a binary format.
