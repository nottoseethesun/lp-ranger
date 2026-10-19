"use strict";

/**
 * @file test/aggregator-swap-paths.test.js
 * @description The aggregator swap from quote to confirmed receipt: the
 *   path every rebalance and compound takes first, and the ways it
 *   retries before giving up.
 *
 *   What is real: the quote request, the quote url and its parsing, the
 *   approvals (through the send pipeline and the shared contract mocks),
 *   the gas price and gas limit arithmetic, the retry loop, and the swap
 *   orchestration in `swapIfNeeded`. What is scripted: the aggregator's
 *   answers (a local http server the chain's aggregator url points at),
 *   the signer's broadcast of the swap itself, and `waitForReceipt`, so
 *   each attempt can confirm, revert or run out of time on cue. The
 *   timeout-and-cancel recovery has its own suite,
 *   `aggregator-nonce-settlement.test.js`.
 *
 *   The chain's attempt limit is three here, not the four that ship, so
 *   a limit written into the code fails.
 */

const fs = require("fs");
const path = require("path");
const { makeTestTempFolder } = require("../src/test-temp-folders");
const SHIPPED_CHAINS = require("../app-config/app-defaults-for-user-configurable/chains.json");

const SETTINGS_DIR = makeTestTempFolder("agg-paths-settings");
fs.writeFileSync(
  path.join(SETTINGS_DIR, "chains.json"),
  JSON.stringify(
    Object.fromEntries(
      Object.keys(SHIPPED_CHAINS).map((chain) => [
        chain,
        { aggregator: { maxAttempts: 3 } },
      ]),
    ),
  ),
);
process.env.LP_RANGER_USER_CONFIG_DIR = SETTINGS_DIR;

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { format } = require("node:util");

const config = require("../src/config");
const logModule = require("../src/log");
const {
  swapViaAggregator,
  AGGREGATOR_LABEL,
  _setWaitMsForTests,
} = require("../src/rebalancer-aggregator");
const { swapIfNeeded } = require("../src/rebalancer-swap");
const { ADDR, buildMockEthersLib } = require("./helpers/rebalancer-mocks");
const {
  EXCHANGE,
  OTHER_SPENDER,
  quote,
  confirmed,
  reverted,
  timedOut,
  state,
  installAggregatorStage,
  restoreAggregatorStage,
  dispatchWithApprovals,
  aggSigner,
  params,
  fixedOut,
} = require("./helpers/aggregator-harness");

beforeEach(installAggregatorStage);
afterEach(restoreAggregatorStage);

describe("aggregator swap — confirmed on the first attempt", () => {
  it("sends the quoted transaction and reports it as the aggregator's", async () => {
    const lib = buildMockEthersLib({
      contractDispatch: dispatchWithApprovals(),
    });
    const r = await swapViaAggregator(aggSigner(), lib, params(), fixedOut);

    /*-
     *  Two quotes: one to price and approve against, a fresh one to send.
     *  Both reached the aggregator's server, so they were built on the
     *  active chain's aggregator url.
     */
    assert.equal(state.urls.length, 2);
    assert.ok(
      state.urls[0].startsWith(`/swap/v1/quote?sellToken=${ADDR.token0}`),
      state.urls[0],
    );
    assert.match(state.urls[0], /&sellAmount=10000&slippagePercentage=0\.005&/);

    const [tx] = state.sent;
    assert.equal(tx.to, EXCHANGE);
    assert.equal(tx.data, "0xdeadbeef");
    assert.equal(tx.value, 0n);
    // quote.gas × chains.json gasLimitMultiplier (2).
    assert.equal(tx.gasLimit, 500000n);
    /*-
     *  The higher of the quote's gas price (2000) and the chain's (1000),
     *  × the aggregator's gasPriceMultiplier (1.5).
     */
    assert.equal(tx.gasPrice, 3000n);
    assert.equal(tx.type, config.TX_TYPE);

    assert.deepEqual(state.approvals, [{ spender: EXCHANGE, amount: 10000n }]);
    assert.equal(r.txHash, "0xswap1");
    // Swap receipt (300000 × 2) plus the approval (46000 × 3).
    assert.equal(r.gasCostWei, 600000n + 138000n);
    assert.equal(r.swapSources, AGGREGATOR_LABEL);
    assert.equal(r.amountOut, 9900n);
  });

  it("approves the fresh quote's spender too when it changed", async () => {
    state.quotes = [quote(), quote({ allowanceTarget: OTHER_SPENDER })];
    const lib = buildMockEthersLib({
      contractDispatch: dispatchWithApprovals(),
    });
    const r = await swapViaAggregator(aggSigner(), lib, params(), fixedOut);
    assert.deepEqual(
      state.approvals.map((a) => a.spender),
      [EXCHANGE, OTHER_SPENDER],
    );
    assert.equal(r.gasCostWei, 600000n + 2n * 138000n);
  });

  it("leaves the quote it sends untouched by the trimmed log", async () => {
    /*-
     *  The log elides the calldata and each order's route path; it must
     *  do that to a copy, never to the quote the swap is built from.
     */
    const sentQuote = quote({
      orders: [{ fillData: { uniswapPath: "0xpath" } }, { source: "X" }],
    });
    state.quotes = [quote(), sentQuote];
    const lib = buildMockEthersLib({
      contractDispatch: dispatchWithApprovals(),
    });
    await swapViaAggregator(aggSigner(), lib, params(), fixedOut);
    assert.equal(state.sent[0].data, "0xdeadbeef");
    assert.equal(sentQuote.orders[0].fillData.uniswapPath, "0xpath");
    assert.equal(sentQuote.data, "0xdeadbeef");
  });

  it("logs the whole quote in verbose mode and still swaps", async () => {
    // The calldata and the route path are what the trimmed log leaves out.
    state.quotes = [
      quote(),
      quote({ orders: [{ fillData: { uniswapPath: "0xpath" } }] }),
    ];
    const lines = [];
    const restoreLog = logModule._setSinkForTests({
      log: (...args) => lines.push(format(...args)),
    });
    const saved = config.VERBOSE;
    config.VERBOSE = true;
    try {
      const lib = buildMockEthersLib({
        contractDispatch: dispatchWithApprovals(),
      });
      const r = await swapViaAggregator(aggSigner(), lib, params(), fixedOut);
      assert.equal(r.txHash, "0xswap1");
    } finally {
      config.VERBOSE = saved;
      restoreLog();
    }
    const responses = lines.filter((l) => l.includes("Response:"));
    assert.ok(
      responses.some(
        (l) =>
          l.includes('"data":"0xdeadbeef"') &&
          l.includes('"uniswapPath":"0xpath"'),
      ),
      responses.join("\n"),
    );
  });
});

describe("aggregator swap — every quote sent is held to the slippage", () => {
  /*-
   *  The quote's own calldata bounds the output only against that quote's
   *  price, which already includes its impact. So a quote that has drifted
   *  past the operator's slippage since the first one was checked — over
   *  an approval, or between attempts — would be sent at that impact
   *  unless it is checked itself.
   */
  it("refuses the fresh quote fetched after the approval when its impact has grown", async () => {
    state.quotes = [
      quote({ estimatedPriceImpact: "0.1" }),
      quote({ estimatedPriceImpact: "6" }),
    ];
    const lib = buildMockEthersLib({
      contractDispatch: dispatchWithApprovals(),
    });
    await assert.rejects(
      swapViaAggregator(aggSigner(), lib, params(), fixedOut),
      (err) => {
        assert.equal(err.isSwapImpactAbort, true);
        // The approval mined before the fresh quote: 46000 × 3.
        assert.equal(err.gasCostWei, 138000n);
        return true;
      },
    );
    assert.equal(state.urls.length, 2, "price, then the fresh quote");
    assert.equal(state.sent.length, 0, "nothing sent");
  });

  it("refuses a re-quote whose impact has grown, once the cancel has settled the nonce", async () => {
    state.quotes = [
      quote({ estimatedPriceImpact: "0.1" }),
      quote({ estimatedPriceImpact: "0.1" }),
      quote({ estimatedPriceImpact: "6" }),
    ];
    state.receipts = [timedOut];
    /*-
     *  The cancel's own wait gives up, but the chain shows it mined, so
     *  its gas was paid: 21000 × 4.
     */
    state.chain["0xcancel1"] = {
      hash: "0xcancel1",
      status: 1,
      gasUsed: 21000n,
      gasPrice: 4n,
    };
    _setWaitMsForTests(20);
    try {
      await assert.rejects(
        swapViaAggregator(
          aggSigner(),
          buildMockEthersLib({ contractDispatch: dispatchWithApprovals() }),
          params(),
          fixedOut,
        ),
        (err) => {
          assert.equal(err.isSwapImpactAbort, true);
          // The approval (46000 × 3) and the cancel (21000 × 4).
          assert.equal(err.gasCostWei, 138000n + 84000n);
          return true;
        },
      );
    } finally {
      _setWaitMsForTests(null);
    }
    assert.equal(state.urls.length, 3, "price, fresh, then the re-quote");
    assert.equal(state.sent.length, 1, "the re-quote is never sent");
    assert.equal(state.cancels.length, 1);
  });
});

describe("aggregator swap — reverted attempts", () => {
  it("re-quotes after a revert and reports the attempt that landed", async () => {
    /*-
     *  A revert consumed the nonce and moved nothing, so a fresh quote at
     *  the next nonce is safe — and needed, since the old route is stale.
     */
    state.receipts = [reverted, confirmed];
    const lib = buildMockEthersLib({
      contractDispatch: dispatchWithApprovals(),
    });
    const r = await swapViaAggregator(aggSigner(), lib, params(), fixedOut);
    assert.equal(state.urls.length, 3, "price, fresh, then one re-quote");
    assert.equal(state.sent.length, 2);
    assert.equal(r.txHash, "0xswap2");
    /*-
     *  The swap that landed (300000 × 2), the approval (46000 × 3), and
     *  the reverted swap before it (50000 × 2), which moved nothing but
     *  was mined and paid for.
     */
    assert.equal(r.gasCostWei, 600000n + 138000n + 100000n);
  });

  it("gives up after the chain's attempt limit, with nothing left pending", async () => {
    // Three attempts, the limit set above; a fourth receipt is never asked for.
    state.receipts = [reverted, reverted, reverted, confirmed];
    const lib = buildMockEthersLib({
      contractDispatch: dispatchWithApprovals(),
    });
    await assert.rejects(
      swapViaAggregator(aggSigner(), lib, params(), fixedOut),
      (err) => {
        assert.equal(err.message, "Aggregator swap failed after 3 attempts");
        // The approval (46000 × 3) and each reverted swap (50000 × 2).
        assert.equal(err.gasCostWei, 138000n + 3n * 100000n);
        /*-
         *  Not flagged unsettled: every nonce was spent by its revert, so
         *  the router fallback may run.
         */
        assert.equal(err.nonceUnsettled, undefined);
        return true;
      },
    );
    assert.equal(state.sent.length, 3);
    // The price quote, the fresh one, and a re-quote after each of two reverts.
    assert.equal(state.urls.length, 4);
  });
});

describe("swapIfNeeded — chunked after a slippage abort", () => {
  it("swaps in three aggregator chunks and sums what they moved", async () => {
    /*-
     *  The full amount quotes at 6% impact, past the 0.5% slippage, so the
     *  swap is retried as three smaller chunks, each of which quotes at
     *  0.1%. The output token's balance rises with every swap sent.
     */
    state.quoteFor = (url) =>
      quote({
        estimatedPriceImpact: url.includes("sellAmount=10000&") ? "6" : "0.1",
      });
    const d = dispatchWithApprovals();
    d[ADDR.token1] = {
      ...d[ADDR.token1],
      balanceOf: async () => BigInt(state.sent.length) * 1000n,
    };
    const lib = buildMockEthersLib({ contractDispatch: d });
    const r = await swapIfNeeded(aggSigner(), lib, {
      ...params(),
      swapRouterAddress: ADDR.router,
      fee: 3000,
      currentPrice: 1.0,
      decimalsIn: 18,
      decimalsOut: 18,
      isToken0To1: true,
    });
    assert.equal(state.sent.length, 3);
    assert.deepEqual(
      state.urls.map((u) => u.match(/sellAmount=(\d+)/)[1]),
      ["10000", "3333", "3333", "3333", "3333", "3334", "3334"],
    );
    assert.equal(r.amountOut, 3000n);
    assert.equal(r.txHash, "0xswap3");
    assert.equal(
      r.swapSources,
      [AGGREGATOR_LABEL, AGGREGATOR_LABEL, AGGREGATOR_LABEL].join("+"),
    );
    assert.equal(r.gasCostWei, 3n * (600000n + 138000n));
  });

  it("declines the router when a chunk's nonce is left unsettled", async () => {
    /*-
     *  The first chunk's wait runs out, and neither that chunk nor the
     *  cancel sent to displace it mines. The chunk can still mine, and
     *  the V3 router would swap the full balance on top of it, so the
     *  error leaves with its flag and nothing more is sent. Had the
     *  router run, the swap would have answered with the router's result
     *  or the router's own error, neither of which carries the flag.
     */
    state.quoteFor = (url) =>
      quote({
        estimatedPriceImpact: url.includes("sellAmount=10000&") ? "6" : "0.1",
      });
    state.receipts = [timedOut];
    _setWaitMsForTests(20);
    const lib = buildMockEthersLib({
      contractDispatch: dispatchWithApprovals(),
    });
    try {
      await assert.rejects(
        swapIfNeeded(aggSigner(), lib, {
          ...params(),
          swapRouterAddress: ADDR.router,
          fee: 3000,
          currentPrice: 1.0,
          decimalsIn: 18,
          decimalsOut: 18,
          isToken0To1: true,
        }),
        (err) => {
          assert.equal(err.nonceUnsettled, true, err.message);
          /*-
           *  The first chunk's approval (46000 × 3) was mined. The cancel
           *  never was, so it cost nothing that can be counted.
           */
          assert.equal(err.gasCostWei, 138000n);
          return true;
        },
      );
    } finally {
      _setWaitMsForTests(null);
    }
    assert.equal(state.sent.length, 1, "only the first chunk was sent");
    assert.equal(state.cancels.length, 1);
  });
});
