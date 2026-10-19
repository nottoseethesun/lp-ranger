"use strict";

/**
 * @file test/rebalancer-swap-failures.test.js
 * @description How the rebalancer's swap (`swapIfNeeded`) fails: an
 *   approval or a router swap that reverts, a balance that falls across
 *   the swap, and which price impact the error names when both the
 *   aggregator and the V3 router refuse a swap for its impact.
 *
 *   The aggregator is a local one (test/helpers/local-aggregator.js). It
 *   refuses every quote unless a case scripts one, as the live aggregator
 *   refuses the fixtures' made-up tokens, so each swap goes on to the V3
 *   router as it would there.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("assert");
const { startLocalAggregator } = require("./helpers/local-aggregator");
const { swapIfNeeded } = require("../src/rebalancer-swap");
const {
  ADDR,
  makeTx,
  mockSigner,
  defaultDispatch,
  buildMockEthersLib,
} = require("./helpers/rebalancer-mocks");

let aggregator;
before(async () => {
  aggregator = await startLocalAggregator();
});
after(() => aggregator.stop());

describe("Failure: swapIfNeeded", () => {
  const swArgs = (extra) => ({
    swapRouterAddress: ADDR.router,
    tokenIn: ADDR.token0,
    tokenOut: ADDR.token1,
    fee: 3000,
    amountIn: 2000n,
    slippagePct: 0.5,
    recipient: ADDR.signer,
    currentPrice: 1.0,
    decimalsIn: 18,
    decimalsOut: 18,
    isToken0To1: true,
    deadline: 9999999999n,
    ...extra,
  });

  it("throws when approve reverts", async () => {
    const d = defaultDispatch();
    d[ADDR.token0] = {
      ...d[ADDR.token0],
      approve: async () => {
        throw new Error("APPROVE_REVERTED");
      },
    };
    await assert.rejects(
      () =>
        swapIfNeeded(
          mockSigner(),
          buildMockEthersLib({ contractDispatch: d }),
          swArgs(),
        ),
      { message: /APPROVE_REVERTED/ },
    );
  });

  it("throws when exactInputSingle reverts", async () => {
    const d = defaultDispatch();
    const revert = async () => {
      throw new Error("SWAP_REVERTED");
    };
    d[ADDR.router] = {
      exactInputSingle: Object.assign(revert, { staticCall: revert }),
    };
    await assert.rejects(
      () =>
        swapIfNeeded(
          mockSigner(),
          buildMockEthersLib({ contractDispatch: d }),
          swArgs(),
        ),
      { message: /SWAP_REVERTED/ },
    );
  });

  it("synthesizes lowest-impact error across aggregator + V3 router slippage aborts", async () => {
    /*-
     *  The aggregator's quote names a 6% impact and the V3 router's 30%,
     *  so both refuse the swap against a 0.5% slippage setting. The error
     *  names the lower, the aggregator's 6%, so the operator is told to
     *  raise slippage to 6.5% rather than past the router's 30%.
     */
    aggregator.answer(200, {
      estimatedPriceImpact: "6",
      buyAmount: "1",
      guaranteedPrice: "1",
      sources: [{ name: "NineMM_V3", proportion: "1" }],
    });
    try {
      const d = defaultDispatch();
      // V3 router quotedOut = 1400 → impact = (2000-1400)/2000 = 30%
      d[ADDR.router] = {
        exactInputSingle: Object.assign(async () => makeTx("0xs"), {
          staticCall: async () => 1400n,
        }),
      };
      let caught = null;
      try {
        await swapIfNeeded(
          mockSigner(),
          buildMockEthersLib({ contractDispatch: d }),
          swArgs(),
        );
      } catch (e) {
        caught = e;
      }
      assert.ok(caught, "swapIfNeeded should have thrown");
      assert.match(caught.message, /lowest observed price impact/);
      assert.match(caught.message, /6\.0%/);
      assert.match(caught.message, /Watergun Aggregator \(full\)/);
      assert.match(caught.message, /Increase to at least 6\.5%/);
      assert.ok(
        !/30/.test(caught.message),
        "must not surface the V3 router's 30% impact",
      );
    } finally {
      aggregator.refuse();
    }
  });

  it("does not synthesize when only one attempt was recorded", async () => {
    /*-
     *  The aggregator fails for another reason (an HTTP 500), and the V3
     *  router refuses the swap for its impact. Only the router named an
     *  impact, so its own error goes through as it is.
     */
    aggregator.answer(500, {});
    try {
      const d = defaultDispatch();
      d[ADDR.router] = {
        exactInputSingle: Object.assign(async () => makeTx("0xs"), {
          staticCall: async () => 1400n,
        }),
      };
      await assert.rejects(
        () =>
          swapIfNeeded(
            mockSigner(),
            buildMockEthersLib({ contractDispatch: d }),
            swArgs(),
          ),
        (err) =>
          /price impact 30\.0% exceeds slippage/.test(err.message) &&
          !/lowest observed/.test(err.message),
      );
    } finally {
      aggregator.refuse();
    }
  });

  it("does not synthesize when final error is non-slippage (RPC revert)", async () => {
    /*-
     *  The aggregator refuses the swap for a 6% impact, and the V3 router
     *  then fails for another reason, a revert. The operator sees that
     *  revert, the cause, rather than advice to raise slippage, which
     *  would not help.
     */
    aggregator.answer(200, {
      estimatedPriceImpact: "6",
      buyAmount: "1",
      sources: [],
    });
    try {
      const d = defaultDispatch();
      const revert = async () => {
        throw new Error("ROUTER_REVERT");
      };
      d[ADDR.router] = {
        exactInputSingle: Object.assign(revert, { staticCall: revert }),
      };
      await assert.rejects(
        () =>
          swapIfNeeded(
            mockSigner(),
            buildMockEthersLib({ contractDispatch: d }),
            swArgs(),
          ),
        (err) =>
          /ROUTER_REVERT/.test(err.message) &&
          !/lowest observed/.test(err.message),
      );
    } finally {
      aggregator.refuse();
    }
  });

  it("returns 0n when balance decreases after swap (fee-on-transfer)", async () => {
    let swapped = false;
    const d = defaultDispatch();
    // Balance goes DOWN after swap
    d[ADDR.token1] = {
      ...d[ADDR.token1],
      balanceOf: async () => (swapped ? 50n : 100n),
    };
    d[ADDR.router] = {
      exactInputSingle: Object.assign(
        async () => {
          swapped = true;
          return makeTx("0xs");
        },
        { staticCall: async (p) => p.amountIn },
      ),
    };
    const r = await swapIfNeeded(
      mockSigner(),
      buildMockEthersLib({ contractDispatch: d }),
      swArgs(),
    );
    assert.strictEqual(r.amountOut, 0n, "negative diff should return 0n");
  });
});
