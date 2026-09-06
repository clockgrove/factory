import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { renderCatalog } from "./scripts/generate.mjs";
import { status } from "./generated/status.mjs";
const source = JSON.parse(await readFile(new URL("./data/status.json", import.meta.url), "utf8"));
assert.equal(
  await readFile(new URL("./generated/status.mjs", import.meta.url), "utf8"),
  renderCatalog(source),
);
assert.deepEqual(status.ready, { label: "Ready", rank: 1 });
const a = { label: "Alpha", rank: 1 };
const z = { label: "Zulu", rank: 2 };
assert.equal(renderCatalog({ z, a }), renderCatalog({ a, z }));
console.log("generated-catalog baseline ok");
