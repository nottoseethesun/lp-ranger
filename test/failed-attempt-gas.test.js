"use strict";

/**
 * @file test/failed-attempt-gas.test.js
 * @description A swap's gas counts every transaction the wallet paid for,
 *   including those of the routes it gave up on.
 *
 * A swap tries the aggregator first. Before that attempt fails, it may
 * already have paid for an approval, a swap that reverted on chain, or a
 * cancel; each was mined, so each was paid for. `swapIfNeeded` then tries
 * the aggregator in smaller chunks, when the full amount's price impact
 * was too high, and the V3 router after that.
 *
 * Before, only the route that succeeded was counted. The aggregator added
 * its approval only to a swap that landed, never counted a reverted swap,
 * and put its cancels on an error that the switch to another route
 * discarded. A rebalance or compound that fell back to the router reported
 * the router's gas alone, and the Per-Day and lifetime gas read low.
 *
 * Two halves. The first drives the real aggregator, through the scripted
 * quote server and receipts of `helpers/aggregator-harness.js`, and the
 * real V3 router, through the shared contract mocks, so each figure is
 * the one the swap path itself computes. The second replaces both routes
 * with stand-ins to pin how `swapIfNeeded` adds what each route paid: the
 * chunked retry, a partial chunk run, and every way the swap can end in an
 * error. Recording a failed move's figure is `test/spent-gas.test.js`.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  swapViaAggregator,
  _setWaitMsForTests,
} = require("../src/lib/rebalancer-aggregator");
const { swapIfNeeded } = require("../src/lib/rebalancer-swap");
const { V3_ROUTER_LABEL } = require("../src/lib/rebalancer-router");
const { readBotConfigDefaults } = require("../src/lib/bot-config-defaults");
const { ADDR, buildMockEthersLib } = require("./helpers/rebalancer-mocks");
const {
  EXCHANGE,
  quote,
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

/*-
 *  One approval in the harness costs 46000 × 3 wei, a reverted swap
 *  50000 × 2, and the V3 router's swap receipt names no gas at all, so
 *  the router's own figure is its approval alone.
 */
const APPROVAL = 138000n;
const REVERT = 100000n;

/** `swapIfNeeded` parameters for a token0 → token1 swap. */
const swapParams = () => ({
  ...params(),
  swapRouterAddress: ADDR.router,
  fee: 3000,
  currentPrice: 1.0,
  decimalsIn: 18,
  decimalsOut: 18,
  isToken0To1: true,
});

/** A quote the aggregator refuses: it names no price impact. */
const unpriced = () => quote({ estimatedPriceImpact: undefined });

describe("a failed aggregator attempt's gas, through to the V3 router", () => {
  beforeEach(installAggregatorStage);
  afterEach(restoreAggregatorStage);

  it("adds the aggregator's approval when its fresh quote is refused", async () => {
    state.quotes = [quote(), unpriced()];
    const r = await swapIfNeeded(
      aggSigner(),
      buildMockEthersLib({ contractDispatch: dispatchWithApprovals() }),
      swapParams(),
    );
    assert.equal(r.swapSources, V3_ROUTER_LABEL);
    assert.equal(state.sent.length, 0, "the aggregator sent no swap");
    assert.deepEqual(
      state.approvals.map((a) => a.spender),
      [EXCHANGE, ADDR.router],
    );
    // The router's approval, and the aggregator's before it.
    assert.equal(r.gasCostWei, APPROVAL + APPROVAL);
  });

  it("adds a reverted aggregator swap and its approval", async () => {
    state.quotes = [quote(), quote(), unpriced()];
    state.receipts = [reverted];
    const r = await swapIfNeeded(
      aggSigner(),
      buildMockEthersLib({ contractDispatch: dispatchWithApprovals() }),
      swapParams(),
    );
    assert.equal(r.swapSources, V3_ROUTER_LABEL);
    assert.equal(state.sent.length, 1);
    assert.equal(r.gasCostWei, APPROVAL + APPROVAL + REVERT);
  });

  it("adds a cancel that the chain shows mined", async () => {
    /*-
     *  The swap's wait runs out and the cancel's own wait gives up too,
     *  but the chain shows the cancel mined: 21000 × 4.
     */
    state.quotes = [quote(), quote(), unpriced()];
    state.receipts = [timedOut];
    state.chain["0xcancel1"] = {
      hash: "0xcancel1",
      status: 1,
      gasUsed: 21000n,
      gasPrice: 4n,
    };
    _setWaitMsForTests(20);
    try {
      const r = await swapIfNeeded(
        aggSigner(),
        buildMockEthersLib({ contractDispatch: dispatchWithApprovals() }),
        swapParams(),
      );
      assert.equal(r.swapSources, V3_ROUTER_LABEL);
      assert.equal(state.cancels.length, 1);
      assert.equal(r.gasCostWei, APPROVAL + APPROVAL + 84000n);
    } finally {
      _setWaitMsForTests(null);
    }
  });

  it("keeps a reverted swap's gas when the next send is refused", async () => {
    /*-
     *  The node refuses the second swap before admitting it, so nothing
     *  is pending and the error is not flagged. It still carries what the
     *  first attempt paid.
     */
    state.receipts = [reverted];
    const signer = aggSigner();
    const send = signer.sendTransaction;
    signer.sendTransaction = async (req) => {
      if (req.to === EXCHANGE && state.sent.length === 1)
        throw new Error("insufficient funds for gas * price + value");
      return send(req);
    };
    await assert.rejects(
      swapViaAggregator(
        signer,
        buildMockEthersLib({ contractDispatch: dispatchWithApprovals() }),
        params(),
        fixedOut,
      ),
      (err) => {
        assert.match(err.message, /insufficient funds/);
        assert.equal(err.nonceUnsettled, undefined);
        assert.equal(err.gasCostWei, APPROVAL + REVERT);
        return true;
      },
    );
  });

  it("keeps an earlier revert's gas on an unsettled nonce's error", async () => {
    /*-
     *  The second swap's wait runs out, and neither it nor its cancel
     *  shows on chain. The swap may still mine, so the error is flagged
     *  and the router is not tried, but the error carries everything
     *  paid before it.
     */
    state.receipts = [reverted, timedOut];
    _setWaitMsForTests(20);
    try {
      await assert.rejects(
        swapIfNeeded(
          aggSigner(),
          buildMockEthersLib({ contractDispatch: dispatchWithApprovals() }),
          swapParams(),
        ),
        (err) => {
          assert.equal(err.nonceUnsettled, true, err.message);
          assert.equal(err.gasCostWei, APPROVAL + REVERT);
          return true;
        },
      );
    } finally {
      _setWaitMsForTests(null);
    }
    assert.equal(state.sent.length, 2);
    assert.deepEqual(
      state.approvals.map((a) => a.spender),
      [EXCHANGE],
      "the router never ran",
    );
  });
});

describe("swapIfNeeded adds what every route given up on paid", () => {
  const AGG_PATH = require.resolve("../src/lib/rebalancer-aggregator");
  const ROUTER_PATH = require.resolve("../src/lib/rebalancer-router");
  const SWAP_PATH = require.resolve("../src/lib/rebalancer-swap");

  /**
   * Load `swapIfNeeded` with both routes replaced by stand-ins.
   *
   * @param {Function} aggregator  Called once per aggregator attempt, the
   *   full amount first and then each chunk, with that attempt's params.
   * @param {Function} router  Called for the V3 router's attempt.
   * @returns {Function} `swapIfNeeded`, bound to the stand-ins.
   */
  function load(aggregator, router) {
    const stub = (id, exports) => {
      require.cache[id] = { id, filename: id, loaded: true, exports };
    };
    stub(AGG_PATH, {
      swapViaAggregator: (_s, _l, p) => aggregator(p),
      AGGREGATOR_LABEL: "Aggregator",
    });
    stub(ROUTER_PATH, {
      swapViaRouter: (_s, _l, p) => router(p),
      V3_ROUTER_LABEL: "Router",
    });
    delete require.cache[SWAP_PATH];
    return require(SWAP_PATH).swapIfNeeded;
  }

  afterEach(() => {
    delete require.cache[AGG_PATH];
    delete require.cache[ROUTER_PATH];
    delete require.cache[SWAP_PATH];
  });

  const big = { amountIn: 10n ** 18n, slippagePct: 1 };

  /** An error as a route throws it, carrying the gas that route paid. */
  function failed(message, gasCostWei, extra = {}) {
    return Object.assign(new Error(message), { gasCostWei }, extra);
  }

  /**
   * The full amount's impact is past the slippage, after its approval
   * was mined: 7 wei paid, and the swap goes on to the chunks.
   */
  const fullAborts = (p) => {
    p._attempts.push({ label: p._attemptLabel, impactPct: 6 });
    throw failed("impact 6% exceeds slippage", 7n, { isSwapImpactAbort: true });
  };

  /** A chunk or route that lands, with the gas it paid. */
  const landed = (txHash, gasCostWei) => ({
    amountOut: 10n,
    txHash,
    gasCostWei,
    swapSources: "Aggregator",
  });

  it("adds the full amount's attempt to the chunks that landed", async () => {
    let calls = 0;
    const swap = load(
      (p) => (++calls === 1 ? fullAborts(p) : landed("0xc" + calls, 100n)),
      () => assert.fail("the router is not reached"),
    );
    const r = await swap({}, {}, big);
    const chunks = BigInt(readBotConfigDefaults().swapChunkCount);
    assert.equal(r.gasCostWei, chunks * 100n + 7n);
  });

  it("keeps every chunk's gas, and the full amount's, on a partial", async () => {
    /*-
     *  The first chunk lands and the second fails after paying 30 wei.
     *  The partial is returned rather than re-swapped through the router,
     *  and it carries all three figures.
     */
    let calls = 0;
    const swap = load(
      (p) => {
        calls++;
        if (calls === 1) return fullAborts(p);
        if (calls === 2) return landed("0xc1", 100n);
        throw failed("route went stale", 30n);
      },
      () => assert.fail("the router is not reached"),
    );
    const r = await swap({}, {}, big);
    assert.equal(r.txHash, "0xc1");
    assert.equal(r.amountOut, 10n);
    assert.equal(r.gasCostWei, 100n + 30n + 7n);
  });

  it("hands the router's result what the full amount and the chunks paid", async () => {
    let calls = 0;
    const swap = load(
      (p) => (++calls === 1 ? fullAborts(p) : Promise.reject(failed("x", 30n))),
      async () => ({
        amountOut: 5n,
        txHash: "0xrouter",
        gasCostWei: 200n,
        swapSources: "Router",
      }),
    );
    const r = await swap({}, {}, big);
    assert.equal(r.txHash, "0xrouter");
    assert.equal(r.gasCostWei, 200n + 7n + 30n);
  });

  it("puts every route's gas on the router's error, keeping its flags", async () => {
    const swap = load(
      () => Promise.reject(failed("aggregator HTTP 503", 7n)),
      () =>
        Promise.reject(
          failed("router swap cancelled", 50n, {
            cancelled: true,
            cancelTxHash: "0xcancel",
          }),
        ),
    );
    await assert.rejects(swap({}, {}, big), (err) => {
      assert.equal(err.message, "router swap cancelled");
      assert.equal(err.cancelled, true);
      assert.equal(err.gasCostWei, 50n + 7n);
      return true;
    });
  });

  it("puts every route's gas on the raise-slippage error that replaces the router's", async () => {
    let calls = 0;
    const swap = load(
      (p) => {
        if (++calls === 1) return fullAborts(p);
        p._attempts.push({ label: p._attemptLabel, impactPct: 4 });
        throw failed("impact 4%", 30n, { isSwapImpactAbort: true });
      },
      (p) => {
        p._attempts.push({ label: p._attemptLabel, impactPct: 3 });
        throw failed("impact 3%", 50n, { isSwapImpactAbort: true });
      },
    );
    await assert.rejects(swap({}, {}, big), (err) => {
      assert.match(err.message, /lowest observed price impact 3\.0%/);
      assert.equal(err.gasCostWei, 7n + 30n + 50n);
      return true;
    });
  });

  it("adds the full amount's attempt to a chunk's unsettled-nonce error", async () => {
    let calls = 0;
    const swap = load(
      (p) =>
        ++calls === 1
          ? fullAborts(p)
          : Promise.reject(
              failed("nonce unsettled", 30n, { nonceUnsettled: true }),
            ),
      () => assert.fail("the router is not reached"),
    );
    await assert.rejects(swap({}, {}, big), (err) => {
      assert.equal(err.nonceUnsettled, true);
      assert.equal(err.gasCostWei, 30n + 7n);
      return true;
    });
  });
});
