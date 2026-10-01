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
  _settleNonce,
  _resolveSwapOutcome,
  _handleSwapError,
} = require("../src/rebalancer-aggregator");

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

const receipt = (hash, gasUsed = 21000n) => ({
  hash,
  gasUsed,
  gasPrice: 2n,
});

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
