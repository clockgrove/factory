import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const phase = process.argv[2];
if (!["members", "format"].includes(phase))
  throw new Error("Expected members or format");
const root = new URL("../", import.meta.url);
const workspace = readFileSync(new URL("pnpm-workspace.yaml", root), "utf8");
const members = [...workspace.matchAll(/^\s+-\s+(\S+)\s*$/gm)].map(
  (match) => match[1],
);
for (const member of members) {
  const pkg = JSON.parse(
    readFileSync(new URL(`${member}/package.json`, root), "utf8"),
  );
  assert.ok(pkg.name.startsWith("@widgets/"), `${member} name`);
  assert.equal(pkg.exports, "./src/index.mjs");
}
if (phase === "format") {
  assert.ok(members.includes("packages/format"));
  const { label } = await import("../packages/format/src/index.mjs");
  assert.equal(label({ name: "gear", size: 4 }), "gear (4)");
}
console.log(`PASS ${phase}`);
