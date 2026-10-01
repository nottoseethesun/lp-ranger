"use strict";

/**
 * @file test/aggregator-nonce-settlement.test.js
 * @description
 * The aggregator's timeout recovery must know who owns the nonce before it
 * does anything else, because both of its alternatives spend the same balance
 * twice when it guesses wrong.
 *
 * A swap and the cancel sent to displace it share one nonce, so at most one
 * can mine. That makes three states, and each has exactly one safe move:
 *
 *   - the swap mined  → report it as the swap; retrying would swap again
 *   - the cancel mined → the slot is closed to the swap; re-quote safely
 *   - neither mined   → the swap can still mine; send nothing
 *
 * The third state is the one with no good option, and the tests here pin that
 * it stops rather than advancing. The sharpest of them is the last: it drives
 * the real `swapIfNeeded` and asserts the V3 router is **not** reached, since
 * that fallback reads any throw as "no swap happened" and would issue the
 * second swap itself — the throw alone does not prevent it.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  _resolveSwapOutcome,
  _handleSwapError,
} = require("../src/rebalancer-aggregator");
/*- From the module that owns it, not through the aggregator: the decision
 *  moved out when rebalancer-aggregator.js reached its line cap. */
const { settleNonce: _settleNonce } = require("../src/aggregator-nonce-settle");

const SWAP_HASH = "0xswap";
const CANCEL_HASH = "0xcancel";

/** Provider whose receipts come from a hash→receipt map; absent hashes null. */
function providerWith(receipts, { throwOn } = {}) {
  return {
    getTransactionReceipt: async (hash) => {
      if (throwOn && throwOn.includes(hash))
        throw new Error("RPC unavailable: " + hash);
      return receipts[hash] ?? null;
    },
    getFeeData: async () => ({ gasPrice: 1_000_000_000n }),
  };
}

/*- `status: 1` is not decoration.  A reverted transaction also has a
 *  receipt, so the production code reads `status` to tell "the swap landed"
 *  from "the swap consumed its nonce and moved nothing" — a fixture without
 *  it exercises neither. */
const receipt = (hash, gasUsed = 21000n, status = 1) => ({
  hash,
  gasUsed,
  gasPrice: 2n,
  status,
});
/** A receipt for a transaction that reverted: nonce spent, no funds moved. */
const revertedReceipt = (hash) => receipt(hash, 21000n, 0);

// ── _settleNonce ─────────────────────────────────────────────────────

describe("_settleNonce", () => {
  it("reports the swap's receipt when the swap mined", async () => {
    const p = providerWith({ [SWAP_HASH]: receipt(SWAP_HASH) });
    const out = await _settleNonce(p, SWAP_HASH, {
      hash: CANCEL_HASH,
      receipt: null,
    });
    assert.strictEqual(out.swapReceipt.hash, SWAP_HASH);
    assert.strictEqual(out.nonceSpent, true);
  });

  it("re-quotes when the swap mined but reverted", async () => {
    /*- A reverted swap has a receipt, so "receipt present" is not "swap
     *  happened".  It consumed the nonce and moved nothing, which is the
     *  one case where a re-quote is both safe and required. */
    const p = providerWith({ [SWAP_HASH]: revertedReceipt(SWAP_HASH) });
    const out = await _settleNonce(p, SWAP_HASH, {
      hash: CANCEL_HASH,
      receipt: null,
    });
    assert.strictEqual(out.swapReceipt, null);
    assert.strictEqual(out.nonceSpent, true);
  });

  it("sends nothing more when a receipt carries no status", async () => {
    /*- Unknown is not "reverted".  Treating it as reverted would re-quote,
     *  and if the swap had in fact landed that re-quote is the second swap.
     *  So an unreadable status stops the loop instead. */
    const p = providerWith({
      [SWAP_HASH]: { hash: SWAP_HASH, gasUsed: 1n, gasPrice: 1n },
    });
    const out = await _settleNonce(p, SWAP_HASH, {
      hash: CANCEL_HASH,
      receipt: null,
    });
    assert.strictEqual(out.swapReceipt, null);
    assert.strictEqual(out.nonceSpent, false);
  });

  it("takes a cancel receipt already in hand without re-reading it", async () => {
    let reads = 0;
    const p = {
      getTransactionReceipt: async () => {
        reads++;
        return null;
      },
    };
    const out = await _settleNonce(p, SWAP_HASH, {
      hash: CANCEL_HASH,
      receipt: receipt(CANCEL_HASH),
    });
    assert.strictEqual(out.swapReceipt, null);
    assert.strictEqual(out.nonceSpent, true);
    /*- One read for the swap only.  Re-reading a receipt we hold would
     *  spend a request on a question already answered. */
    assert.strictEqual(reads, 1);
  });

  it("reports the slot spent when only the cancel mined", async () => {
    const p = providerWith({ [CANCEL_HASH]: receipt(CANCEL_HASH) });
    const out = await _settleNonce(p, SWAP_HASH, {
      hash: CANCEL_HASH,
      receipt: null,
    });
    assert.strictEqual(out.swapReceipt, null);
    assert.strictEqual(out.nonceSpent, true);
  });

  it("reports the slot unspent when neither mined", async () => {
    const p = providerWith({});
    const out = await _settleNonce(p, SWAP_HASH, {
      hash: CANCEL_HASH,
      receipt: null,
    });
    assert.strictEqual(out.swapReceipt, null);
    assert.strictEqual(out.nonceSpent, false);
  });

  it("treats an unreadable receipt as unspent rather than throwing", async () => {
    /*- An error escaping here would reach the swap fallback as an ordinary
     *  failure and earn a second swap — the precise outcome this path
     *  exists to prevent.  Unknown must resolve to the cautious answer. */
    const p = providerWith({}, { throwOn: [SWAP_HASH, CANCEL_HASH] });
    const out = await _settleNonce(p, SWAP_HASH, {
      hash: CANCEL_HASH,
      receipt: null,
    });
    assert.strictEqual(out.swapReceipt, null);
    assert.strictEqual(out.nonceSpent, false);
  });

  it("does not read a cancel hash when no cancel was broadcast", async () => {
    const asked = [];
    const p = {
      getTransactionReceipt: async (h) => {
        asked.push(h);
        return null;
      },
    };
    const out = await _settleNonce(p, SWAP_HASH, { hash: null, receipt: null });
    assert.deepStrictEqual(asked, [SWAP_HASH]);
    assert.strictEqual(out.nonceSpent, false);
  });
});

// ── _resolveSwapOutcome ──────────────────────────────────────────────

describe("_resolveSwapOutcome", () => {
  const base = {
    tx: { nonce: 7, hash: SWAP_HASH },
    waitMs: 180_000,
    cancelGasTotal: 5n,
    ctx: "ctx",
    fromSym: "TKA",
    toSym: "TKB",
  };

  it("returns the swap as the result when it mined late", () => {
    const out = _resolveSwapOutcome({
      ...base,
      outcome: {
        cancelGasWei: 0n,
        swapReceipt: receipt(SWAP_HASH, 100n),
        nonceSpent: true,
      },
    });
    assert.strictEqual(out.txHash, SWAP_HASH);
    /*- The cancel's gas is spent whether or not the cancel landed, so the
     *  move's cost carries it alongside the swap's own. */
    assert.strictEqual(out.gasCostWei, 100n * 2n + 5n);
  });

  it("returns null when the slot is spent, so the loop may re-quote", () => {
    const out = _resolveSwapOutcome({
      ...base,
      outcome: { cancelGasWei: 0n, swapReceipt: null, nonceSpent: true },
    });
    assert.strictEqual(out, null);
  });

  it("throws a flagged error when the slot is unspent", () => {
    assert.throws(
      () =>
        _resolveSwapOutcome({
          ...base,
          outcome: { cancelGasWei: 0n, swapReceipt: null, nonceSpent: false },
        }),
      (err) => {
        assert.strictEqual(err.nonceUnsettled, true);
        /*- The message has to name the nonce and the hash: an operator
         *  reading it needs to be able to look the swap up. */
        assert.match(err.message, /nonce 7/);
        assert.match(err.message, new RegExp(SWAP_HASH));
        /*- The cancel's gas is spent on chain whatever happens next, and
         *  `executeRebalance`'s catch reads this field off the error.
         *  Without it the charge falls in the gap between the thrown frame
         *  and the recorder. */
        assert.strictEqual(err.cancelGasCostWei, 5n);
        return true;
      },
    );
  });
});

// ── _handleSwapError ─────────────────────────────────────────────────

describe("_handleSwapError", () => {
  const tx = { nonce: 7, hash: SWAP_HASH };

  it("treats an on-chain revert as a spent slot without cancelling", async () => {
    const err = { message: "CALL_EXCEPTION", code: "CALL_EXCEPTION" };
    const out = await _handleSwapError(err, {}, {}, tx, 5000, "TKA", "TKB", 0n);
    assert.deepStrictEqual(out, {
      cancelGasWei: 0n,
      swapReceipt: null,
      nonceSpent: true,
    });
  });

  it("reports the swap when the cancel is refused as nonce-too-low", async () => {
    /*- The regression.  The node refusing the cancel is the chain telling
     *  us the swap mined; before the fix that refusal escaped as an error
     *  and the router fallback swapped the same balance again. */
    const signer = {
      signer: {
        getAddress: async () => "0xme",
        sendTransaction: async () => {
          const e = new Error("nonce too low");
          e.code = "NONCE_EXPIRED";
          throw e;
        },
      },
      reset: () => {},
    };
    const provider = providerWith({ [SWAP_HASH]: receipt(SWAP_HASH, 300n) });
    const out = await _handleSwapError(
      { message: "_AGG_TIMEOUT" },
      signer,
      provider,
      tx,
      10,
      "TKA",
      "TKB",
      1n,
    );
    assert.strictEqual(out.swapReceipt.hash, SWAP_HASH);
    assert.strictEqual(out.nonceSpent, true);
    assert.strictEqual(out.cancelGasWei, 0n);
  });

  it("settles instead of rethrowing when the cancel send fails", async () => {
    /*- The regression, second door.  "Already known" means the cancel is in
     *  the mempool, but `_isNonceTooLow` is false for it, so an earlier
     *  version rethrew — and an error leaving here carries no
     *  `nonceUnsettled`, so the router fallback swapped again.  Any cancel
     *  failure must reach the chain, never the caller. */
    const signer = {
      signer: {
        getAddress: async () => "0xme",
        sendTransaction: async () => {
          throw new Error("already known");
        },
      },
      reset: () => {},
    };
    const provider = providerWith({ [SWAP_HASH]: receipt(SWAP_HASH, 300n) });
    const out = await _handleSwapError(
      { message: "_AGG_TIMEOUT" },
      signer,
      provider,
      tx,
      10,
      "TKA",
      "TKB",
      1n,
    );
    assert.strictEqual(out.swapReceipt.hash, SWAP_HASH);
    assert.strictEqual(out.nonceSpent, true);
  });

  it("reports an unspent slot when the cancel send fails and nothing mined", async () => {
    /*- Same door, worse room: no cancel pending and no swap receipt, so
     *  the slot is open and the swap can still land.  Must not rethrow and
     *  must not license a re-quote. */
    const signer = {
      signer: {
        getAddress: async () => "0xme",
        sendTransaction: async () => {
          throw new Error("txpool is full");
        },
      },
      reset: () => {},
    };
    const out = await _handleSwapError(
      { message: "_AGG_TIMEOUT" },
      signer,
      providerWith({}),
      tx,
      10,
      "TKA",
      "TKB",
      1n,
    );
    assert.strictEqual(out.swapReceipt, null);
    assert.strictEqual(out.nonceSpent, false);
  });

  it("reports an unspent slot when the cancel never confirms", async () => {
    const signer = {
      signer: {
        getAddress: async () => "0xme",
        sendTransaction: async () => ({
          hash: CANCEL_HASH,
          nonce: 7,
          gasPrice: 9n,
          /*- Never settles, so the bounded wait expires — the state the
           *  old code reported as a plain 0n and advanced past. */
          wait: () => new Promise(() => {}),
        }),
      },
      reset: () => {},
    };
    const provider = providerWith({});
    const out = await _handleSwapError(
      { message: "_AGG_TIMEOUT" },
      signer,
      provider,
      tx,
      10,
      "TKA",
      "TKB",
      1n,
    );
    assert.strictEqual(out.swapReceipt, null);
    assert.strictEqual(out.nonceSpent, false);
  });

  it("reports a spent slot and the cancel's gas when the cancel confirms", async () => {
    const signer = {
      signer: {
        getAddress: async () => "0xme",
        sendTransaction: async () => ({
          hash: CANCEL_HASH,
          nonce: 7,
          gasPrice: 9n,
          wait: async () => receipt(CANCEL_HASH, 21000n),
        }),
      },
      reset: () => {},
    };
    const provider = providerWith({});
    const out = await _handleSwapError(
      { message: "_AGG_TIMEOUT" },
      signer,
      provider,
      tx,
      10_000,
      "TKA",
      "TKB",
      1n,
    );
    assert.strictEqual(out.swapReceipt, null);
    assert.strictEqual(out.nonceSpent, true);
    assert.strictEqual(out.cancelGasWei, 21000n * 2n);
  });
});

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
      AGGREGATOR_LABEL: "9mm Aggregator",
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
      /*- The whole point.  A throw alone does not stop the second swap —
       *  the fallback is what issues it. */
      assert.strictEqual(routerCalls.count, 0);
    } finally {
      restore();
    }
  });

  it("still falls back to the router for an ordinary aggregator failure", async () => {
    /*- The guard must be narrow: without this, a one-line change that
     *  rethrows everything would pass the test above and silently remove
     *  the fallback the router exists to provide. */
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
    /*- `terminal-nonce-consumed`: "already known" means this exact
     *  transaction is in the mempool, so something is live and nothing more
     *  may be sent.
     *
     *  The `transient` bucket takes the same branch and is the more common
     *  way in, but it is not the case driven here: `_retrySend` sleeps
     *  30+60+90 seconds before giving up on a transient error, so asserting
     *  through it would add three minutes to the suite while exercising that
     *  backoff rather than this classification.  "Already known" is terminal,
     *  so it arrives immediately, and the branch is the same one. */
    const { err, routerCalls } = await runWithFailedSend(
      new Error("already known"),
    );
    assert.strictEqual(err?.nonceUnsettled, true);
    assert.strictEqual(routerCalls, 0);
  });

  it("still falls back when the node never admitted the transaction", async () => {
    /*- `terminal-nonce-unused`: rejected "before it was admitted to the
     *  executable pending pool", so the nonce was never consumed and the
     *  router is the recovery, not a second swap.  Without this the guard
     *  would quietly disable the fallback for every send failure. */
    const refused = new Error("insufficient funds for gas * price + value");
    const { err, routerCalls } = await runWithFailedSend(refused);
    assert.strictEqual(err, null);
    assert.strictEqual(routerCalls, 1);
  });
});
