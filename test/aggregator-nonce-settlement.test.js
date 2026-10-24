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
 * it stops rather than advancing. What a stop then means for the V3-router
 * fallback, which reads any throw as "no swap happened" and would issue the
 * second swap itself, is pinned in test/aggregator-router-fallback.test.js.
 */

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const { Wallet, Transaction } = require("ethers");

const { _handleSwapError } = require("../src/lib/rebalancer-aggregator");
const { nonceTooLow } = require("./helpers/ethers-rpc-errors");
/*-
 *  From the module that owns them, not through the aggregator: both moved
 *  out when rebalancer-aggregator.js reached its line cap.
 */
const {
  settleNonce: _settleNonce,
  resolveSwapOutcome: _resolveSwapOutcome,
} = require("../src/lib/aggregator-nonce-settle");

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
    // The landed swap's gas is the swap's own cost, reported with it.
    assert.strictEqual(out.spentGasWei, 0n);
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
    // Moved nothing, but mined, so its gas was paid: 21000 × 2.
    assert.strictEqual(out.spentGasWei, 42000n);
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
    // Whatever it did, it was mined, so its gas was paid.
    assert.strictEqual(out.spentGasWei, 1n);
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
    assert.strictEqual(out.spentGasWei, 42000n);
    /*- One read for the swap only.  Re-reading a receipt we hold would
     *  spend a request on a question already answered. */
    assert.strictEqual(reads, 1);
  });

  it("reads a receipt in hand by its hash: the swap's is the swap", async () => {
    /*-
     *  When the swap mines while its cancel is pending, ethers reports the
     *  cancel as replaced and hands back the swap's receipt. With the
     *  chain's answer for the swap not yet in, taking it as the cancel's
     *  would close the slot to a swap that landed, and the re-quote would
     *  swap the balance a second time.
     */
    let reads = 0;
    const p = {
      getTransactionReceipt: async () => {
        reads++;
        return null;
      },
    };
    const out = await _settleNonce(p, SWAP_HASH, {
      hash: CANCEL_HASH,
      receipt: receipt(SWAP_HASH, 300n),
    });
    assert.strictEqual(out.swapReceipt.hash, SWAP_HASH);
    assert.strictEqual(out.nonceSpent, true);
    assert.strictEqual(out.spentGasWei, 0n);
    assert.strictEqual(reads, 0, "a receipt in hand is not read again");
  });

  it("counts the swap's reverted receipt in hand as the slot spent, with its gas", async () => {
    const out = await _settleNonce(providerWith({}), SWAP_HASH, {
      hash: CANCEL_HASH,
      receipt: revertedReceipt(SWAP_HASH),
    });
    assert.strictEqual(out.swapReceipt, null);
    assert.strictEqual(out.nonceSpent, true);
    assert.strictEqual(out.spentGasWei, 21000n * 2n);
  });

  it("charges nothing for another transaction's receipt in hand", async () => {
    // Something else took the nonce: the slot is closed to the swap.
    const out = await _settleNonce(providerWith({}), SWAP_HASH, {
      hash: CANCEL_HASH,
      receipt: receipt("0xother"),
    });
    assert.strictEqual(out.swapReceipt, null);
    assert.strictEqual(out.nonceSpent, true);
    assert.strictEqual(out.spentGasWei, 0n);
  });

  it("reports the slot spent when only the cancel mined", async () => {
    const p = providerWith({ [CANCEL_HASH]: receipt(CANCEL_HASH) });
    const out = await _settleNonce(p, SWAP_HASH, {
      hash: CANCEL_HASH,
      receipt: null,
    });
    assert.strictEqual(out.swapReceipt, null);
    assert.strictEqual(out.nonceSpent, true);
    /*-
     *  The cancel's own wait gave up, but the chain shows it mined, so
     *  its gas was paid all the same: 21000 × 2.
     */
    assert.strictEqual(out.spentGasWei, 42000n);
  });

  it("reports the slot unspent when neither mined", async () => {
    const p = providerWith({});
    const out = await _settleNonce(p, SWAP_HASH, {
      hash: CANCEL_HASH,
      receipt: null,
    });
    assert.strictEqual(out.swapReceipt, null);
    assert.strictEqual(out.nonceSpent, false);
    assert.strictEqual(out.spentGasWei, 0n);
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
    spentGasWei: 5n,
    ctx: "ctx",
    fromSym: "TKA",
    toSym: "TKB",
  };

  it("returns the swap as the result when it mined late", () => {
    const out = _resolveSwapOutcome({
      ...base,
      outcome: {
        spentGasWei: 0n,
        swapReceipt: receipt(SWAP_HASH, 100n),
        nonceSpent: true,
      },
    });
    assert.strictEqual(out.txHash, SWAP_HASH);
    /*-
     *  Earlier attempts' reverted swaps and cancels were paid for whether
     *  or not they landed, so the move's cost carries them alongside the
     *  swap's own.
     */
    assert.strictEqual(out.gasCostWei, 100n * 2n + 5n);
  });

  it("returns null when the slot is spent, so the loop may re-quote", () => {
    const out = _resolveSwapOutcome({
      ...base,
      outcome: { spentGasWei: 0n, swapReceipt: null, nonceSpent: true },
    });
    assert.strictEqual(out, null);
  });

  it("throws a flagged error when the slot is unspent", () => {
    assert.throws(
      () =>
        _resolveSwapOutcome({
          ...base,
          outcome: { spentGasWei: 0n, swapReceipt: null, nonceSpent: false },
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
    /*-
     *  ethers' CALL_EXCEPTION for a revert carries the mined receipt, and
     *  the reverted swap's gas comes back to be counted.
     */
    const err = {
      message: "CALL_EXCEPTION",
      code: "CALL_EXCEPTION",
      receipt: revertedReceipt(SWAP_HASH),
    };
    const out = await _handleSwapError(err, {}, {}, tx, 5000, "TKA", "TKB", 0n);
    assert.deepStrictEqual(out, {
      spentGasWei: 21000n * 2n,
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
    assert.strictEqual(out.spentGasWei, 0n);
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

  describe("a refused cancel whose earlier copy went through", () => {
    /*-
     *  The cancel was accepted, but its reply was lost, so it was sent
     *  again and refused as nonce too low. The refusal still carries the
     *  signed cancel, the lost copy's own bytes, so the chain can be asked
     *  about it. Before, the slot was reported open, and the rebalance
     *  refused a fallback it could safely take.
     */
    let refusedCancel;
    let refusedHash;

    before(async () => {
      const wallet = Wallet.createRandom();
      refusedCancel = await wallet.signTransaction({
        type: 0,
        to: wallet.address,
        nonce: 7,
        gasLimit: 21000n,
        gasPrice: 9n,
        value: 0n,
        chainId: 943n,
      });
      refusedHash = Transaction.from(refusedCancel).hash;
    });

    const refusingSigner = () => ({
      signer: {
        getAddress: async () => "0xme",
        sendTransaction: async () => {
          throw nonceTooLow(refusedCancel);
        },
      },
      reset: () => {},
    });

    it("closes the slot, with the cancel's gas, once that copy mined", async () => {
      const provider = providerWith({ [refusedHash]: receipt(refusedHash) });
      const out = await _handleSwapError(
        { message: "_AGG_TIMEOUT" },
        refusingSigner(),
        provider,
        tx,
        10,
        "TKA",
        "TKB",
        1n,
      );
      assert.strictEqual(out.swapReceipt, null);
      assert.strictEqual(out.nonceSpent, true, "a re-quote is safe");
      assert.strictEqual(out.spentGasWei, 21000n * 2n);
    });

    it("still reports the swap when it is the swap that mined", async () => {
      const provider = providerWith({ [SWAP_HASH]: receipt(SWAP_HASH, 300n) });
      const out = await _handleSwapError(
        { message: "_AGG_TIMEOUT" },
        refusingSigner(),
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
    assert.strictEqual(out.spentGasWei, 21000n * 2n);
  });
});
