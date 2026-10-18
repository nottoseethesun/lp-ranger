"use strict";

/**
 * @file test/aggregator-router-fallback.test.js
 * @description
 * When an aggregator swap fails, `swapIfNeeded` falls back to the V3
 * router, and that fallback is a recovery only when the aggregator's swap
 * cannot still mine. If it can, the router would swap the same balance a
 * second time: the fallback reads any throw as "no swap happened", so a
 * throw alone does not prevent it.
 *
 * These cases drive the real `swapIfNeeded`. The first section has the
 * aggregator report its nonce unsettled, and asserts the V3 router is
 * not reached. The second has the swap's own send fail, and asserts the
 * router is reached only when the node never admitted the transaction.
 * Each section also pins the other direction, so a guard that refused
 * every fallback could not pass.
 *
 * Split out of test/aggregator-nonce-settlement.test.js, which settles
 * the nonce itself, at the 500-line cap.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

// ── swapIfNeeded must not fall back on an unsettled nonce ────────────

describe("swapIfNeeded — unsettled nonce blocks the router fallback", () => {
  const AGG_PATH = require.resolve("../src/rebalancer-aggregator");
  const ROUTER_PATH = require.resolve("../src/rebalancer-router");
  const SWAP_PATH = require.resolve("../src/rebalancer-swap");

  /**
   * Load `swapIfNeeded` against a stubbed aggregator and router.
   * @param {Error} aggError Error the aggregator throws.
   * @returns {{swapIfNeeded: Function, routerCalls: object}}
   */
  function loadWithStubs(aggError) {
    const routerCalls = { count: 0 };
    const stub = (id, exports) => {
      require.cache[id] = { id, filename: id, loaded: true, exports };
    };
    stub(AGG_PATH, {
      swapViaAggregator: async () => {
        throw aggError;
      },
      AGGREGATOR_LABEL: "Watergun Aggregator",
    });
    stub(ROUTER_PATH, {
      swapViaRouter: async () => {
        routerCalls.count++;
        return { amountOut: 1n, txHash: "0xrouter", gasCostWei: 0n };
      },
    });
    delete require.cache[SWAP_PATH];
    const { swapIfNeeded } = require(SWAP_PATH);
    return { swapIfNeeded, routerCalls };
  }

  function restore() {
    delete require.cache[AGG_PATH];
    delete require.cache[ROUTER_PATH];
    delete require.cache[SWAP_PATH];
  }

  const params = {
    amountIn: 10n ** 18n,
    tokenIn: "0x" + "1".repeat(40),
    tokenOut: "0x" + "2".repeat(40),
    slippagePct: 1,
  };

  it("rethrows without calling the V3 router", async () => {
    const err = new Error("nonce 7 unsettled");
    err.nonceUnsettled = true;
    const { swapIfNeeded, routerCalls } = loadWithStubs(err);
    try {
      await assert.rejects(() => swapIfNeeded({}, {}, params), {
        message: /unsettled/,
      });
      /*-
       *  The whole point.  A throw alone does not stop the second swap —
       *  the fallback is what issues it.
       */
      assert.strictEqual(routerCalls.count, 0);
    } finally {
      restore();
    }
  });

  it("still falls back to the router for an ordinary aggregator failure", async () => {
    /*-
     *  The guard must be narrow: without this, a one-line change that
     *  rethrows everything would pass the test above and silently remove
     *  the fallback the router exists to provide.
     */
    const { swapIfNeeded, routerCalls } = loadWithStubs(
      new Error("aggregator HTTP 503"),
    );
    try {
      const out = await swapIfNeeded({}, {}, params);
      assert.strictEqual(out.txHash, "0xrouter");
      assert.strictEqual(routerCalls.count, 1);
    } finally {
      restore();
    }
  });
});

// ── A failed swap send: fall back only when nothing was admitted ─────

/**
 * The swap's own send sits outside the try that leads to `_settleNonce`, so a
 * throw from it reaches `swapIfNeeded` directly. Whether the V3-router
 * fallback is a recovery or a second swap depends entirely on which bucket the
 * error fell in, and the classifier's config states the answer: a
 * `terminal-nonce-unused` rejection happened "before it was admitted to the
 * executable pending pool", while a `transient` failure means the transaction
 * "may or may not have been broadcast".
 *
 * Both directions are pinned here. A guard that flagged everything would pass
 * the first case and silently remove the fallback the router exists to
 * provide, so the second case is what keeps it narrow.
 */
describe("swapIfNeeded — a failed swap send only falls back when safe", () => {
  const AGG_PATH = require.resolve("../src/rebalancer-aggregator");
  const ROUTER_PATH = require.resolve("../src/rebalancer-router");
  const SWAP_PATH = require.resolve("../src/rebalancer-swap");

  const QUOTE = {
    to: "0x" + "9".repeat(40),
    data: "0xdead",
    value: "0",
    gas: "500000",
    gasPrice: "1000000000",
    buyAmount: "1000",
    estimatedPriceImpact: "0",
    allowanceTarget: "0x" + "9".repeat(40),
    sources: [],
  };

  /**
   * Drive the real aggregator with a send that throws `sendErr`, stubbing only
   * the quote endpoint and the router — the router so the fallback is
   * observable, the aggregator left real because its classification is the
   * subject.
   * @param {Error} sendErr Error the signer's sendTransaction throws.
   * @returns {Promise<{err: Error|null, routerCalls: number}>}
   */
  async function runWithFailedSend(sendErr) {
    /*-
     *  TEST-ONLY global swap: the quote request (src/aggregator-quote-request.js)
     *  calls the global `fetch` and offers no seam, and the aggregator must
     *  stay real here because its classification is the subject. The
     *  original is captured first and restored pristine in the `finally`
     *  below, straight after the one call that needs it.
     */
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => QUOTE });
    const routerCalls = { count: 0 };
    require.cache[ROUTER_PATH] = {
      id: ROUTER_PATH,
      filename: ROUTER_PATH,
      loaded: true,
      exports: {
        swapViaRouter: async () => {
          routerCalls.count++;
          return { amountOut: 1n, txHash: "0xrouter", gasCostWei: 0n };
        },
      },
    };
    delete require.cache[SWAP_PATH];
    const { swapIfNeeded } = require(SWAP_PATH);
    const signer = {
      getAddress: async () => "0x" + "1".repeat(40),
      sendTransaction: async () => {
        throw sendErr;
      },
      provider: {
        getFeeData: async () => ({ gasPrice: 1_000_000_000n }),
        getTransactionReceipt: async () => null,
      },
    };
    const ethersLib = {
      Contract: class {
        async allowance() {
          return 2n ** 255n;
        }
        async balanceOf() {
          return 0n;
        }
      },
    };
    let err = null;
    try {
      await swapIfNeeded(signer, ethersLib, {
        amountIn: 10n ** 18n,
        tokenIn: "0x" + "a".repeat(40),
        tokenOut: "0x" + "b".repeat(40),
        recipient: "0x" + "1".repeat(40),
        swapRouterAddress: QUOTE.to,
        slippagePct: 1,
        fee: 3000,
      });
    } catch (e) {
      err = e;
    } finally {
      globalThis.fetch = origFetch;
      delete require.cache[ROUTER_PATH];
      delete require.cache[SWAP_PATH];
      delete require.cache[AGG_PATH];
    }
    return { err, routerCalls: routerCalls.count };
  }

  it("declines the fallback when a nonce may already be consumed", async () => {
    /*-
     *  `terminal-nonce-consumed`: "already known" means this exact
     *  transaction is in the mempool, so something is live and nothing more
     *  may be sent.
     *
     *  The `transient` bucket takes the same branch and is the more common
     *  way in, but it is not the case driven here: `_retrySend` sleeps
     *  30+60+90 seconds before giving up on a transient error, so asserting
     *  through it would add three minutes to the suite while exercising that
     *  backoff rather than this classification.  "Already known" is terminal,
     *  so it arrives immediately, and the branch is the same one.
     */
    const { err, routerCalls } = await runWithFailedSend(
      new Error("already known"),
    );
    assert.strictEqual(err?.nonceUnsettled, true);
    assert.strictEqual(routerCalls, 0);
  });

  it("still falls back when the node never admitted the transaction", async () => {
    /*-
     *  `terminal-nonce-unused`: rejected "before it was admitted to the
     *  executable pending pool", so the nonce was never consumed and the
     *  router is the recovery, not a second swap.  Without this the guard
     *  would quietly disable the fallback for every send failure.
     */
    const refused = new Error("insufficient funds for gas * price + value");
    const { err, routerCalls } = await runWithFailedSend(refused);
    assert.strictEqual(err, null);
    assert.strictEqual(routerCalls, 1);
  });
});
