import assert from "node:assert/strict";
import { totalCents } from "./.compiled/cart.js";
assert.equal(totalCents([101, 100]), 201);
assert.equal(totalCents([]), 0);
assert.throws(() => totalCents([-1]));
assert.throws(() => totalCents([0.5]));
assert.throws(() => totalCents([Number.MAX_SAFE_INTEGER, 1]));
console.log("typed-cart baseline ok");
