"use strict";

/**
 * @file test/send-transaction-reverted.test.js
 * @description What `sendTx.sendTransaction` makes of a transaction that
 *   failed on chain, and of one an endpoint says it already holds.
 *
 *   A transaction that failed on chain was mined, and its gas paid. Its
 *   receipt says so with status 0, and the send must fail with the
 *   CALL_EXCEPTION ethers' own wait raises, carrying that gas so the
 *   failed rebalance or compound records it. That holds on both ways a
 *   receipt arrives: ethers' own wait, and the re-ask of another endpoint
 *   when the one that broadcast it has stopped answering, which once
 *   handed a reverted receipt back as a confirmation.
 *
 *   An endpoint answering "already known" holds the transaction, so the
 *   send waits on it and returns its receipt rather than failing.
 */

const { describe, it, before, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { Wallet, Transaction } = require("ethers");

const sendTx = require("../src/lib/send-transaction");
const rpcQueue = require("../src/lib/rpc-request-manager");
const outOfService = require("../src/lib/rpc-out-of-service");
const logModule = require("../src/lib/log");

const PRI = "http://primary.test";
const FALL = "http://fallback.test";

/** A receipt as an endpoint returns one. */
const receipt = (hash, extra = {}) => ({
  _type: "TransactionReceipt",
  hash,
  gasUsed: 30000n,
  gasPrice: 3n,
  blockNumber: 99,
  status: 1,
  ...extra,
});

/** A 502 shaped the way ethers reports one. */
function serverError(url) {
  const e = new Error("server response 502 Bad Gateway");
  e.code = "SERVER_ERROR";
  e.info = { requestUrl: url, responseStatus: "502 Bad Gateway" };
  return e;
}

/** An ethers stand-in whose providers answer as `receipts` says. */
function makeLib(receipts = {}) {
  return {
    JsonRpcProvider: class {
      constructor(url) {
        this._url = url;
        this.pollingInterval = 5;
        this.getFeeData = async () => ({ gasPrice: 1n });
        this.estimateGas = async () => 100_000n;
        this.getBlockNumber = async () => 1;
        this.getTransactionReceipt = receipts[url] || (async () => null);
      }
      send(method) {
        if (method === "eth_gasPrice") return Promise.resolve("0x1");
        return Promise.resolve(null);
      }
    },
    FeeData: class {},
  };
}

/** A signer whose broadcast works and whose `tx.wait()` does as given. */
function makeSigner(wait) {
  return {
    getAddress: async () => "0x" + "11".repeat(20),
    provider: { getFeeData: async () => ({ gasPrice: 1n }) },
    sendTransaction: async () => ({
      hash: "0xsent",
      nonce: 7,
      gasLimit: 300000n,
      gasPrice: 3n,
      wait,
    }),
  };
}

const POPULATE = async () => ({
  to: "0x" + "22".repeat(20),
  gasLimit: 300000n,
});

describe("sendTransaction", () => {
  let restore;

  beforeEach(() => {
    sendTx._resetForTests();
    rpcQueue._resetForTests();
    outOfService._resetForTests();
    restore = logModule._setSinkForTests({
      log: () => {},
      warn: () => {},
      error: () => {},
    });
  });
  afterEach(() => {
    restore();
    sendTx._resetForTests();
    rpcQueue._resetForTests();
    outOfService._resetForTests();
  });

  it("fails a transaction the re-ask finds reverted, carrying its gas", async () => {
    /*-
     *  The endpoint that broadcast it refuses the wait, and the one asked
     *  instead has its receipt: mined, and reverted.
     */
    sendTx.init(
      { urls: [PRI, FALL] },
      makeLib({
        [PRI]: async (hash) => receipt(hash, { status: 0 }),
        [FALL]: async (hash) => receipt(hash, { status: 0 }),
      }),
    );
    await assert.rejects(
      sendTx.sendTransaction({
        populate: POPULATE,
        signer: makeSigner(async () => {
          throw serverError(PRI);
        }),
        label: "[rebalance] mint",
      }),
      (err) => {
        assert.equal(err.code, "CALL_EXCEPTION");
        assert.equal(err.receipt.status, 0);
        assert.equal(err.gasCostWei, 30000n * 3n);
        return true;
      },
    );
  });

  it("carries the gas of a revert ethers' own wait reports", async () => {
    sendTx.init({ urls: [PRI, FALL] }, makeLib());
    await assert.rejects(
      sendTx.sendTransaction({
        populate: POPULATE,
        signer: makeSigner(async () => {
          const e = new Error("transaction execution reverted");
          e.code = "CALL_EXCEPTION";
          e.receipt = receipt("0xsent", { status: 0, gasUsed: 50000n });
          throw e;
        }),
        label: "[compound] increaseLiquidity",
      }),
      (err) => {
        assert.equal(err.code, "CALL_EXCEPTION");
        assert.equal(err.gasCostWei, 50000n * 3n);
        return true;
      },
    );
  });

  it("still confirms a transaction the re-ask finds mined", async () => {
    sendTx.init(
      { urls: [PRI, FALL] },
      makeLib({
        [PRI]: async (hash) => receipt(hash),
        [FALL]: async (hash) => receipt(hash),
      }),
    );
    const { receipt: r } = await sendTx.sendTransaction({
      populate: POPULATE,
      signer: makeSigner(async () => {
        throw serverError(PRI);
      }),
      label: "[rebalance] mint",
    });
    assert.equal(r.hash, "0xsent");
    assert.equal(r.status, 1);
  });

  describe("an endpoint that already holds the transaction", () => {
    let RAW;
    let HASH;

    before(async () => {
      const wallet = Wallet.createRandom();
      RAW = await wallet.signTransaction({
        type: 0,
        to: "0x" + "22".repeat(20),
        nonce: 7,
        gasLimit: 300000n,
        gasPrice: 3n,
        value: 0n,
        chainId: 943n,
      });
      HASH = Transaction.from(RAW).hash;
    });

    it("is waited on through the endpoint in use, and its receipt returned", async () => {
      sendTx.init(
        { urls: [PRI, FALL] },
        makeLib({
          [PRI]: async (hash) => (hash === HASH ? receipt(hash) : null),
        }),
      );
      let sends = 0;
      const signer = {
        getAddress: async () => "0x" + "11".repeat(20),
        provider: { getFeeData: async () => ({ gasPrice: 1n }) },
        sendTransaction: async () => {
          sends++;
          const e = new Error("already known");
          e.code = "UNKNOWN_ERROR";
          e.payload = { method: "eth_sendRawTransaction", params: [RAW] };
          throw e;
        },
      };
      const { tx, receipt: r } = await sendTx.sendTransaction({
        populate: POPULATE,
        signer,
        label: "[rebalance] approve",
      });
      assert.equal(sends, 1, "a held transaction is not submitted again");
      assert.equal(tx.hash, HASH);
      assert.equal(r.hash, HASH);
    });
  });
});
