"use strict";

/**
 * @file test/rebalancer-drain-wallet-reading.test.js
 * @description The drain (`removeLiquidity`, src/rebalancer-pools.js)
 *   hands back what the wallet held just before it, beside the coins it
 *   collected. It reads that balance anyway, to work out what the drain
 *   collected; a rebalance's Activity Log figures then cap the deposit
 *   they set aside at it (src/rebalance-activity-figures.js), since coins
 *   not in the wallet before the drain cannot be a deposit waiting there.
 *
 *   Kept apart from test/rebalancer.test.js, which is at its line cap.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { removeLiquidity } = require("../src/rebalancer-pools");
const {
  ADDR,
  ONE_ETH,
  defaultDispatch,
  buildMockEthersLib,
  mockSigner,
} = require("./helpers/rebalancer-mocks");

describe("removeLiquidity — the wallet before the drain", () => {
  it("hands back the wallet's balance from before the drain", async () => {
    // 5 and 7 in the wallet; the drain brings in one coin of each.
    let drained = false;
    const d = defaultDispatch();
    d[ADDR.token0] = {
      ...d[ADDR.token0],
      balanceOf: async () => (drained ? 5n + ONE_ETH : 5n),
    };
    d[ADDR.token1] = {
      ...d[ADDR.token1],
      balanceOf: async () => (drained ? 7n + ONE_ETH : 7n),
    };
    d[ADDR.pm] = {
      ...d[ADDR.pm],
      collect: async () => {
        drained = true;
        return { wait: async () => ({ hash: "0xc", logs: [] }) };
      },
      positions: async () => ({
        liquidity: 5000n,
        tokensOwed0: 0n,
        tokensOwed1: 0n,
      }),
    };
    const r = await removeLiquidity(
      mockSigner(),
      buildMockEthersLib({ contractDispatch: d }),
      {
        positionManagerAddress: ADDR.pm,
        tokenId: 1n,
        liquidity: 1000n,
        recipient: ADDR.signer,
        token0: ADDR.token0,
        token1: ADDR.token1,
      },
    );
    assert.deepStrictEqual(r.walletBefore, { amount0: 5n, amount1: 7n });
    assert.strictEqual(r.amount0, ONE_ETH);
    assert.strictEqual(r.amount1, ONE_ETH);
  });
});
