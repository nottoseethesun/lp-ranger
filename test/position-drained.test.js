/**
 * @file test/position-drained.test.js
 * @description Whether a position holds no liquidity
 *   (src/lib/position-drained.js): the one test the Impermanent Loss Guard,
 *   the drained-position checks and the mid-rebalance retry all ask.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { isThisPositionDrained } = require("../src/lib/position-drained");

describe("isThisPositionDrained", () => {
  it("is true for no liquidity, however the chain read wrote it", () => {
    for (const liquidity of ["0", 0, 0n])
      assert.equal(
        isThisPositionDrained({ liquidity }),
        true,
        String(liquidity),
      );
  });

  it("is false for any liquidity", () => {
    for (const liquidity of [
      "1",
      "340282366920938463463374607431768211455",
      7n,
    ])
      assert.equal(
        isThisPositionDrained({ liquidity }),
        false,
        String(liquidity),
      );
  });

  it("counts a position whose liquidity was never read as holding none, as it always has", () => {
    assert.equal(isThisPositionDrained({}), true);
    assert.equal(isThisPositionDrained({ liquidity: null }), true);
    assert.equal(isThisPositionDrained(undefined), true);
  });
});
