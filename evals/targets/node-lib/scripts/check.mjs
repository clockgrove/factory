import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const phase = process.argv[2];
const phases = ["slug", "wrap", "truncate", "cli", "docs"];
if (!phases.includes(phase)) throw new Error(`Expected one of ${phases}`);
const root = new URL("../", import.meta.url);

if (phase === "slug") {
  const { slug } = await import("../src/slug.mjs");
  assert.equal(slug("Hello, World!"), "hello-world");
  assert.equal(slug("--a  b--"), "a-b");
}
if (phase === "wrap") {
  const { wrap } = await import("../src/wrap.mjs");
  assert.equal(wrap("the quick brown fox", 10), "the quick\nbrown fox");
  assert.equal(wrap("extraordinary day", 5), "extraordinary\nday");
  assert.throws(() => wrap("x", 0), RangeError);
}
if (phase === "truncate") {
  const { truncate } = await import("../src/truncate.mjs");
  assert.equal(truncate("short", 10), "short");
  assert.equal(truncate("abcdefgh", 5), "abcd…");
  assert.throws(() => truncate("x", 0), RangeError);
}
if (phase === "cli") {
  const run = (args, input) =>
    execFileSync(process.execPath, ["bin/textkit.mjs", ...args], {
      cwd: root,
      input,
      encoding: "utf8",
    }).trimEnd();
  assert.equal(run(["slug"], "Hi There"), "hi-there");
  assert.equal(run(["truncate", "4"], "abcdef"), "abc…");
}
if (phase === "docs") {
  const text = readFileSync(new URL("docs/CLI.md", root), "utf8");
  for (const term of ["textkit slug", "textkit wrap", "textkit truncate"])
    assert.ok(text.includes(term), `docs/CLI.md must document ${term}`);
}
console.log(`PASS ${phase}`);
