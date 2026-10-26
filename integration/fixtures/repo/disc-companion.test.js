import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

// A person's test: once src/discBase{{ID}}.js exists, it needs src/discMore{{ID}}.js
// beside it. Skipped on main and in every other tree, where it passes.
const base = existsSync(new URL("../src/discBase{{ID}}.js", import.meta.url));

test("discMore{{ID}} counts what discBase{{ID}} keeps", { skip: base ? false : "no src/discBase{{ID}}.js yet" }, async () => {
  const { discMore{{ID}} } = await import("../src/discMore{{ID}}.js");
  assert.equal(discMore{{ID}}("a b c"), 3);
});
