"use strict";

/**
 * @file test/rebalancer-tick-spacing.test.js
 * @description Tests covering getPoolState's on-chain tickSpacing lookup
 * via factory.feeAmountTickSpacing(fee).  Split out of rebalancer.test.js
 * for line-count compliance.
 *
 * Background: 9mm Pro defines non-standard fee tiers (notably fee=20000 →
 * tickSpacing=400) that aren't in the upstream Uniswap V3 hardcoded map,
 * so the rebalancer must read spacing fresh from the factory on every
 * call rather than relying on a static fee→spacing table.  See git log
 * for the on-chain bug that motivated this.
 */

const { describe, it } = require("node:test");
const assert = require("assert");
const { getPoolState } = require("../src/rebalancer");
const {
  ADDR,
  defaultDispatch,
  buildMockEthersLib,
  poolArgs,
} = require("./helpers/rebalancer-mocks");

describe("getPoolState — tickSpacing from factory", () => {
  it("returns tickSpacing fetched from factory.feeAmountTickSpacing", async () => {
    // poolArgs.fee = 3000 → spacing 60 from the default mock
    const r = await getPoolState(buildMockEthersLib(), poolArgs);
    assert.strictEqual(r.tickSpacing, 60);
  });

  it("returns non-standard 9mm spacing 400 for fee=20000", async () => {
    const r = await getPoolState(buildMockEthersLib(), {
      ...poolArgs,
      fee: 20000,
    });
    assert.strictEqual(r.tickSpacing, 400);
  });

  it("throws when factory returns invalid tickSpacing (0)", async () => {
    const d = defaultDispatch();
    d[ADDR.factory] = {
      ...d[ADDR.factory],
      feeAmountTickSpacing: async () => 0n,
    };
    await assert.rejects(
      () => getPoolState(buildMockEthersLib({ contractDispatch: d }), poolArgs),
      /tickSpacing|spacing/i,
    );
  });
});
