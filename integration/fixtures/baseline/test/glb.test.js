import { test } from "node:test";
import assert from "node:assert/strict";
import { readGlb, writeGlb } from "../scripts/glb.mjs";

test("writeGlb writes an aligned GLB that readGlb reads back", () => {
  const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  const glb = writeGlb(positions, [0, 1, 2]);
  assert.equal(glb.length % 4, 0);
  const read = readGlb(glb);
  assert.deepEqual(read.positions, positions);
  assert.deepEqual(read.indices, [0, 1, 2]);
  assert.equal(read.gltf.asset.version, "2.0");
});
