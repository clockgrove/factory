import { test } from "node:test";
import assert from "node:assert/strict";
import { fillPolygon, readPng, writePng } from "../scripts/png.mjs";

test("writePng writes a PNG that readPng reads back, with a filled polygon", () => {
  const rgba = new Uint8Array(8 * 8 * 4);
  fillPolygon(rgba, 8, [[1, 1], [7, 1], [7, 7], [1, 7]], [255, 0, 0, 255]);
  const read = readPng(writePng(8, 8, rgba));
  assert.deepEqual([read.width, read.height], [8, 8]);
  assert.deepEqual([...read.rgba.subarray(4 * (4 * 8 + 4), 4 * (4 * 8 + 5))], [255, 0, 0, 255]);
  assert.deepEqual([...read.rgba.subarray(0, 4)], [0, 0, 0, 0]);
});
