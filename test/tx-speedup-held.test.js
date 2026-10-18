"use strict";

/**
 * @file test/tx-speedup-held.test.js
 * @description Three things about a stuck transaction that the speed-up
 *   pipeline (`_waitOrSpeedUp`, src/tx-speedup.js) must get right.
 *
 *   - The speed-up is timed from the transaction's first submission. A
 *     transaction recovered after an endpoint answered "already known"
 *     may have been waiting longer than the speed-up time already, and
 *     is then resubmitted at higher gas at once, as the user asked,
 *     rather than given the whole wait again.
 *   - A speed-up that replaced the transaction and then reverted is a
 *     failure, not a confirmation: ethers hands its receipt over as
 *     TRANSACTION_REPLACED, and the pipeline must read its status.
 *   - A speed-up or a cancel the endpoint answers "already known" is
 *     pending, not failed. The pipeline waits on it: a speed-up that
 *     confirms is the move's receipt, and once a cancel confirms the
 *     move is cancelled with the cancel's gas, as for any cancel.
 */

const { describe, it, before, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { Wallet, Transaction } = require("ethers");

const config = require("../src/config");
const logModule = require("../src/log");
const { _waitOrSpeedUp } = require("../src/tx-speedup");

const WALLET = "0x" + "11".repeat(20);

/** A receipt for `hash`, mined at gas 21000 and a gas price of 4. */
const mined = (hash, extra = {}) => ({
  _type: "TransactionReceipt",
  hash,
  status: 1,
  blockNumber: 77,
  gasUsed: 21000n,
  gasPrice: 4n,
  ...extra,
});

/** A wait that never settles: the transaction is still pending. */
const pending = () => new Promise(() => {});

/** What a wait reports when another transaction took its nonce. */
function replacedBy(receipt) {
  const e = new Error("transaction was replaced");
  e.code = "TRANSACTION_REPLACED";
  e.cancelled = false;
  e.reason = "repriced";
  e.receipt = receipt;
  return e;
}

/**
 * The move's transaction, and a signer whose later sends — the speed-up,
 * then the cancel — are scripted by the case.
 */
function stage({ originalWait, speedUp, cancel, provider = {} }) {
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
    provider: { getFeeData: async () => ({ gasPrice: 1n }), ...provider },
    getAddress: async () => WALLET,
    sendTransaction: async (req) => {
      sent.push({ req, at: Date.now() });
      return req.to === WALLET ? cancel(req) : speedUp(req);
    },
  };
  return { original, signer, sent };
}

describe("the speed-up pipeline", () => {
  const saved = {};
  let restoreLog;

  beforeEach(() => {
    for (const k of [
      "TX_SPEEDUP_SEC",
      "TX_CANCEL_SEC",
      "TX_CANCEL_PHASE_FLOOR_SEC",
    ])
      saved[k] = config[k];
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

  it("speeds up at once a transaction first submitted longer ago than the speed-up time", async () => {
    /*-
     *  A five-second speed-up time, and a transaction first submitted ten
     *  seconds ago: the speed-up is owed already.
     */
    config.TX_SPEEDUP_SEC = 5;
    config.TX_CANCEL_SEC = 60;
    config.TX_CANCEL_PHASE_FLOOR_SEC = 1;
    const { original, signer, sent } = stage({
      originalWait: pending,
      speedUp: (req) => ({
        hash: "0xspeedup",
        nonce: req.nonce,
        gasPrice: req.gasPrice,
        wait: async () => mined("0xspeedup"),
      }),
      cancel: () => assert.fail("no cancel once the speed-up confirmed"),
    });
    const start = Date.now();
    const r = await _waitOrSpeedUp(
      original,
      signer,
      "[rebalance] mint",
      undefined,
      start - 10_000,
    );
    assert.equal(r.hash, "0xspeedup");
    assert.equal(sent.length, 1);
    assert.ok(
      sent[0].at - start < 1000,
      `sped up after ${sent[0].at - start} ms, not at once`,
    );
    assert.ok(sent[0].req.gasPrice > original.gasPrice, "at higher gas");
  });

  it("gives a fresh transaction the whole speed-up time", async () => {
    config.TX_SPEEDUP_SEC = 0.3;
    config.TX_CANCEL_SEC = 60;
    config.TX_CANCEL_PHASE_FLOOR_SEC = 1;
    const { original, signer, sent } = stage({
      originalWait: pending,
      speedUp: (req) => ({
        hash: "0xspeedup",
        nonce: req.nonce,
        gasPrice: req.gasPrice,
        wait: async () => mined("0xspeedup"),
      }),
      cancel: () => assert.fail("no cancel once the speed-up confirmed"),
    });
    const start = Date.now();
    await _waitOrSpeedUp(
      original,
      signer,
      "[rebalance] mint",
      undefined,
      start,
    );
    assert.ok(
      sent[0].at - start >= 250,
      `sped up after ${sent[0].at - start} ms, before its time`,
    );
  });

  it("fails the move when the speed-up that replaced it reverted", async () => {
    config.TX_SPEEDUP_SEC = 5;
    config.TX_CANCEL_SEC = 60;
    config.TX_CANCEL_PHASE_FLOOR_SEC = 1;
    const { original, signer } = stage({
      originalWait: async () => {
        throw replacedBy(mined("0xspeedup", { status: 0 }));
      },
      speedUp: () => assert.fail("the wait settled first"),
      cancel: () => assert.fail("the wait settled first"),
    });
    await assert.rejects(
      _waitOrSpeedUp(original, signer, "[rebalance] mint"),
      (err) => {
        assert.equal(err.code, "CALL_EXCEPTION");
        assert.equal(err.receipt.status, 0);
        assert.equal(err.receipt.hash, "0xspeedup");
        return true;
      },
    );
  });

  it("takes a replacement's confirmed receipt as the move's", async () => {
    config.TX_SPEEDUP_SEC = 5;
    config.TX_CANCEL_SEC = 60;
    config.TX_CANCEL_PHASE_FLOOR_SEC = 1;
    const { original, signer } = stage({
      originalWait: async () => {
        throw replacedBy(mined("0xspeedup"));
      },
      speedUp: () => assert.fail("the wait settled first"),
      cancel: () => assert.fail("the wait settled first"),
    });
    const r = await _waitOrSpeedUp(original, signer, "[rebalance] mint");
    assert.equal(r.hash, "0xspeedup");
  });

  it("waits on a speed-up the endpoint answers 'already known', and takes its receipt", async () => {
    /*-
     *  The endpoint already holds the speed-up, perhaps from a send whose
     *  reply was lost: it is pending, not failed. It is rebuilt from the
     *  signed bytes the refused request carried and waited on, and its
     *  receipt is the move's.
     */
    config.TX_SPEEDUP_SEC = 0.05;
    config.TX_CANCEL_SEC = 60;
    config.TX_CANCEL_PHASE_FLOOR_SEC = 1;
    const wallet = Wallet.createRandom();
    const rawSpeedUp = await wallet.signTransaction({
      type: 0,
      to: "0x" + "22".repeat(20),
      nonce: 9,
      gasLimit: 300000n,
      gasPrice: 3n,
      data: "0xabcdef",
      value: 0n,
      chainId: 943n,
    });
    const speedUpHash = Transaction.from(rawSpeedUp).hash;
    const { original, signer } = stage({
      originalWait: pending,
      speedUp: () => {
        const e = new Error("already known");
        e.code = "UNKNOWN_ERROR";
        e.payload = { method: "eth_sendRawTransaction", params: [rawSpeedUp] };
        throw e;
      },
      cancel: () => assert.fail("the speed-up confirmed; nothing to cancel"),
      provider: {
        getBlockNumber: async () => 100,
        getTransactionReceipt: async (hash) =>
          hash === speedUpHash ? mined(speedUpHash) : null,
      },
    });
    const r = await _waitOrSpeedUp(original, signer, "[rebalance] mint");
    assert.equal(r.hash, speedUpHash);
    assert.equal(r.status, 1);
  });

  describe("a cancel the endpoint answers 'already known'", () => {
    let RAW_CANCEL;
    let CANCEL_HASH;

    before(async () => {
      const wallet = Wallet.createRandom();
      RAW_CANCEL = await wallet.signTransaction({
        type: 0,
        to: wallet.address,
        nonce: 9,
        gasLimit: 21000n,
        gasPrice: 8n,
        value: 0n,
        chainId: 943n,
      });
      CANCEL_HASH = Transaction.from(RAW_CANCEL).hash;
    });

    it("waits on the cancel it holds, and records the cancel's gas", async () => {
      config.TX_SPEEDUP_SEC = 0.05;
      config.TX_CANCEL_SEC = 0.1;
      config.TX_CANCEL_PHASE_FLOOR_SEC = 0.05;
      const { original, signer } = stage({
        originalWait: pending,
        speedUp: () => {
          const e = new Error("insufficient funds for gas");
          e.code = "INSUFFICIENT_FUNDS";
          throw e;
        },
        cancel: () => {
          const e = new Error("already known");
          e.code = "UNKNOWN_ERROR";
          e.payload = {
            method: "eth_sendRawTransaction",
            params: [RAW_CANCEL],
          };
          throw e;
        },
        /*-
         *  What ethers' wait asks of the provider the held cancel was
         *  rebuilt on: its receipt, which says it confirmed.
         */
        provider: {
          getBlockNumber: async () => 100,
          getTransactionReceipt: async (hash) =>
            hash === CANCEL_HASH ? mined(CANCEL_HASH) : null,
        },
      });
      await assert.rejects(
        _waitOrSpeedUp(original, signer, "[rebalance] mint"),
        (err) => {
          assert.equal(err.cancelled, true);
          assert.equal(err.cancelTxHash, CANCEL_HASH);
          assert.equal(err.gasCostWei, 21000n * 4n);
          return true;
        },
      );
    });
  });

  describe("a cancel refused because its earlier copy went through", () => {
    /*-
     *  The cancel was accepted, but its reply was lost, so it was sent
     *  again and refused as nonce too low: the first copy had mined. The
     *  refusal carries the signed cancel, the lost copy's own bytes, so
     *  the pipeline waits on it with the move and reads its receipt as the
     *  cancel's. Before, it took the cancel for another transaction sent
     *  from the wallet: the wrong error, no cancelled flag, no gas.
     */
    let RAW_CANCEL;
    let CANCEL_HASH;

    before(async () => {
      const wallet = Wallet.createRandom();
      RAW_CANCEL = await wallet.signTransaction({
        type: 0,
        to: wallet.address,
        nonce: 9,
        gasLimit: 21000n,
        gasPrice: 8n,
        value: 0n,
        chainId: 943n,
      });
      CANCEL_HASH = Transaction.from(RAW_CANCEL).hash;
    });

    it("names the cancel, and records its gas", async () => {
      config.TX_SPEEDUP_SEC = 0.05;
      config.TX_CANCEL_SEC = 0.1;
      config.TX_CANCEL_PHASE_FLOOR_SEC = 0.05;
      /*-
       *  The move's own wait learns the nonce went to the cancel, as
       *  ethers reports it: replaced, with the cancel's receipt.
       */
      let replaceOriginal;
      const replaced = new Promise((_resolve, reject) => {
        replaceOriginal = reject;
      });
      const { original, signer } = stage({
        originalWait: () => replaced,
        speedUp: () => {
          const e = new Error("insufficient funds for gas");
          e.code = "INSUFFICIENT_FUNDS";
          throw e;
        },
        cancel: () => {
          const taken = new Error("transaction was replaced");
          taken.code = "TRANSACTION_REPLACED";
          taken.cancelled = true;
          taken.reason = "cancelled";
          taken.receipt = mined(CANCEL_HASH);
          replaceOriginal(taken);
          const e = new Error("nonce too low");
          e.code = "NONCE_EXPIRED";
          e.payload = {
            method: "eth_sendRawTransaction",
            params: [RAW_CANCEL],
          };
          throw e;
        },
        provider: {
          getBlockNumber: async () => 100,
          getTransactionReceipt: async (hash) =>
            hash === CANCEL_HASH ? mined(CANCEL_HASH) : null,
        },
      });
      await assert.rejects(
        _waitOrSpeedUp(original, signer, "[rebalance] mint"),
        (err) => {
          assert.equal(err.cancelled, true, err.message);
          assert.equal(err.cancelTxHash, CANCEL_HASH);
          assert.equal(err.gasCostWei, 21000n * 4n);
          return true;
        },
      );
    });
  });
});
