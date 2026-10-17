import { test } from "node:test";
import assert from "node:assert/strict";
import { settle } from "../src/settle.js";

test("shares add up to the total", () => {
  const shares = settle(1000, [1, 1, 1]);
  assert.equal(shares.reduce((a, b) => a + b, 0), 1000);
});

// SPEC.md rule 3: remainder cents are handed out one at a time in payer
// order, starting with the first payer.
test("remainder goes to the first payers in order", () => {
  assert.deepEqual(settle(1000, [1, 1, 1]), [334, 333, 333]);
});

test("remainder distribution matches spec for uneven weights", () => {
  // 100 * 1/6 = 16.67 -> 16; 100 * 2/6 = 33.33 -> 33 (twice); remainder 1 goes to payer 1
  assert.deepEqual(settle(100, [1, 2, 3]), [17, 33, 50]);
  assert.deepEqual(settle(10, [1, 1, 1, 1]), [3, 3, 2, 2]);
});
