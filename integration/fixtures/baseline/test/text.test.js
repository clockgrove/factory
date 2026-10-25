import { test } from "node:test";
import assert from "node:assert/strict";
import { squish } from "../src/text.js";

test("squish collapses whitespace", () => {
  assert.equal(squish("  a \n\t b  "), "a b");
});
