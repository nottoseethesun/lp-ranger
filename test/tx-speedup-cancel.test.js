"use strict";

/**
 * @file test/tx-speedup-cancel.test.js
 * @description What becomes of a move whose transaction is stuck, once the
 *   speed-up and the cancel come into it.
 *
 *   A stuck transaction is sped up at the same nonce, and if that does not
 *   confirm in time, cancelled at the same nonce with a zero-value
 *   self-transfer. Up to three transactions then compete for one nonce and
 *   exactly one mines, so the pipeline's answer has to come from which one
 *   did — not from the cancel's own wait, and not from whether a send was
 *   accepted:
 *
 *   - a speed-up that cannot be sent still leaves the cancel owed, under
 *     the same clock, rather than an unbounded wait on the original;
 *   - the move's own transaction mining while the cancel is pending is a
 *     move that happened, not a cancelled one;
 *   - a cancel refused as "nonce too low" means the move already mined;
 *   - only the cancel's own receipt makes the move "cancelled";
 *   - a transaction from outside the bot taking the nonce fails the move,
 *     naming it.
 *
 *   Driven through `_waitOrSpeedUp` with scripted transactions, so each
 *   case decides exactly which wait settles and how.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const config = require("../src/config");
const logModule = require("../src/log");
const { _waitOrSpeedUp } = require("../src/tx-speedup");

const WALLET = "0x" + "11".repeat(20);

/** A receipt for `hash`, mined. */
const mined = (hash) => ({
  _type: "TransactionReceipt",
  hash,
  status: 1,
  blockNumber: 77,
  gasUsed: 21000n,
  gasPrice: 4n,
});

/** A wait that never settles: the transaction is still pending. */
const pending = () => new Promise(() => {});

/** What a wait reports when another transaction took its nonce. */
function replacedBy(receipt) {
  const e = new Error("transaction was replaced");
  e.code = "TRANSACTION_REPLACED";
  e.cancelled = true;
  e.receipt = receipt;
  return e;
}

/** A node refusal, shaped the way ethers reports one. */
function refusal(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/**
 * The move's transaction, and a signer whose later sends — the speed-up,
 * then the cancel — are scripted by the case.
 *
 * @param {object} o
 * @param {Function} o.originalWait  What the original's `wait()` does.
 * @param {Function} o.speedUp       `() => tx` or throws, for the speed-up send.
 * @param {Function} o.cancel        `() => tx` or throws, for the cancel send.
 */
function stage({ originalWait, speedUp, cancel }) {
  const original = {
    hash: "0xoriginal",
    nonce: 9,
    to: "0x" + "22".repeat(20),
    data: "0xabcdef",
    value: 0n,
    gasLimit: 300000n,
    gasPrice: 2n,
    wait: originalWait,
  };
  const sent = [];
  const signer = {
    provider: { getFeeData: async () => ({ gasPrice: 1n }) },
    getAddress: async () => WALLET,
    sendTransaction: async (req) => {
      sent.push(req);
      return req.to === WALLET ? cancel(req) : speedUp(req);
    },
  };
  return { original, signer, sent };
}

describe("a stuck move, through the speed-up and the cancel", () => {
  const saved = {};
  let restoreLog;

  beforeEach(() => {
    /*-
     *  Shortened so every phase fires inside a test. `config` is a plain
     *  module object, not a JS global, and every value is put back in
     *  `afterEach`.
     */
    for (const k of [
      "TX_SPEEDUP_SEC",
      "TX_CANCEL_SEC",
      "TX_CANCEL_PHASE_FLOOR_SEC",
    ])
      saved[k] = config[k];
    config.TX_SPEEDUP_SEC = 0.05;
    config.TX_CANCEL_SEC = 0.1;
    config.TX_CANCEL_PHASE_FLOOR_SEC = 0.05;
    restoreLog = logModule._setSinkForTests({
      log: () => {},
      warn: () => {},
      error: () => {},
    });
  });
  afterEach(() => {
    Object.assign(config, saved);
    restoreLog();
  });

  it("still cancels when the speed-up cannot be sent and the original never mines", async () => {
    const { original, signer, sent } = stage({
      originalWait: pending,
      speedUp: () => {
        throw refusal("INSUFFICIENT_FUNDS", "insufficient funds for gas");
      },
      cancel: (req) => ({
        hash: "0xcancel",
        nonce: req.nonce,
        gasPrice: req.gasPrice,
        wait: async () => mined("0xcancel"),
      }),
    });
    await assert.rejects(
      _waitOrSpeedUp(original, signer, "[rebalance] mint"),
      (err) => {
        assert.equal(err.cancelled, true);
        assert.equal(err.cancelTxHash, "0xcancel");
        assert.equal(err.cancelGasCostWei, 21000n * 4n);
        return true;
      },
    );
    assert.equal(sent.length, 2, "the refused speed-up, then the cancel");
    assert.equal(sent[1].nonce, original.nonce);
  });

  it("reports the move confirmed when it mines while the cancel is pending", async () => {
    const receipt = mined("0xoriginal");
    const { original, signer } = stage({
      originalWait: pending,
      speedUp: () => {
        throw refusal("INSUFFICIENT_FUNDS", "insufficient funds for gas");
      },
      /*-
       *  ethers marks this `cancelled: true` — its own word for "another
       *  transaction took the nonce" — which must not be read as the
       *  app's own cancel having worked.
       */
      cancel: (req) => ({
        hash: "0xcancel",
        nonce: req.nonce,
        gasPrice: req.gasPrice,
        wait: async () => {
          throw replacedBy(receipt);
        },
      }),
    });
    const r = await _waitOrSpeedUp(original, signer, "[rebalance] mint");
    assert.equal(r.hash, "0xoriginal");
  });

  it("waits for the move's receipt when the cancel is refused as nonce too low", async () => {
    // Every wait on one transaction is the same wait.
    let mineOriginal;
    const originalMined = new Promise((resolve) => {
      mineOriginal = resolve;
    });
    const { original, signer } = stage({
      originalWait: () => originalMined,
      speedUp: () => {
        throw refusal("INSUFFICIENT_FUNDS", "insufficient funds for gas");
      },
      cancel: () => {
        mineOriginal(mined("0xoriginal"));
        throw refusal("NONCE_EXPIRED", "nonce too low");
      },
    });
    const r = await _waitOrSpeedUp(original, signer, "[compound] collect");
    assert.equal(r.hash, "0xoriginal");
  });

  it("returns the speed-up's receipt when the speed-up is what mined", async () => {
    const { original, signer } = stage({
      originalWait: pending,
      speedUp: (req) => ({
        hash: "0xspeedup",
        nonce: req.nonce,
        gasPrice: req.gasPrice,
        wait: async () => mined("0xspeedup"),
      }),
      cancel: () => assert.fail("no cancel once the speed-up confirmed"),
    });
    const r = await _waitOrSpeedUp(original, signer, "[rebalance] mint");
    assert.equal(r.hash, "0xspeedup");
  });

  it("fails the move, naming it, when a transaction from outside the bot took the nonce", async () => {
    const { original, signer } = stage({
      originalWait: pending,
      speedUp: () => {
        throw refusal("INSUFFICIENT_FUNDS", "insufficient funds for gas");
      },
      cancel: (req) => ({
        hash: "0xcancel",
        nonce: req.nonce,
        gasPrice: req.gasPrice,
        wait: async () => {
          throw replacedBy(mined("0xforeign"));
        },
      }),
    });
    await assert.rejects(
      _waitOrSpeedUp(original, signer, "[rebalance] mint"),
      (err) => {
        assert.match(err.message, /taken by another transaction.*0xforeign/);
        assert.notEqual(err.cancelled, true);
        return true;
      },
    );
  });

  it("reports a cancel the node refuses for another reason as stuck", async () => {
    const { original, signer } = stage({
      originalWait: pending,
      speedUp: () => {
        throw refusal("INSUFFICIENT_FUNDS", "insufficient funds for gas");
      },
      cancel: () => {
        throw refusal("INSUFFICIENT_FUNDS", "insufficient funds for gas");
      },
    });
    await assert.rejects(
      _waitOrSpeedUp(original, signer, "[rebalance] mint"),
      /TX stuck and cancel failed: insufficient funds/,
    );
  });
});
