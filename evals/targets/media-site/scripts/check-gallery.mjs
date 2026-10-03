import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const phase = process.argv[2];
if (!["manifest", "thumbs"].includes(phase))
  throw new Error("Expected manifest or thumbs");
const root = new URL("../", import.meta.url);
const gallery = JSON.parse(readFileSync(new URL("gallery.json", root), "utf8"));

for (const image of gallery.images) {
  assert.ok(existsSync(new URL(image.path, root)), `${image.path} is missing`);
  assert.equal(typeof image.alt, "string");
  if (phase === "thumbs") {
    assert.ok(image.thumb, `${image.path} needs a thumb`);
    assert.ok(existsSync(new URL(image.thumb, root)), `${image.thumb} missing`);
    const sidecar = image.thumb.replace(/\.png$/, ".json");
    const meta = JSON.parse(readFileSync(new URL(sidecar, root), "utf8"));
    assert.equal(meta.source, image.path);
  }
}
console.log(`PASS ${phase}`);
