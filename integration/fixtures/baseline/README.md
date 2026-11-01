# Factory integration drill

Scratch target the Factory integration suite creates for one run and deletes
after it. It holds a tiny Node library that the run's Objectives change. Not
product code.

`scripts/glb.mjs` is a small, correct GLB writer and reader, so the media case's model
is made by the library rather than by hand: that case checks Factory's media flow, not a
model's skill with a binary format.
