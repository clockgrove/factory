import assert from "node:assert/strict";
import test from "node:test";
import { slug } from "../src/slug.mjs";

test("slug joins words with single dashes", () => {
  assert.equal(slug("A  B"), "a-b");
});
