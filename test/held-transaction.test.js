"use strict";

/**
 * @file test/held-transaction.test.js
 * @description A transaction an endpoint answers "already known" is one it
 *   holds, still waiting to be mined, not a failure.
 *
 *   `heldTransaction` (src/held-transaction.js) rebuilds that transaction
 *   from the signed bytes the request carried, so the bot can wait on it;
 *   `_retrySend` (src/tx-retry.js) hands it back as the send's result
 *   rather than failing the rebalance or compound. A signed transaction
 *   made here stands in for the one an endpoint would hold, and the error
 *   is shaped the way ethers 6 raises the answer: UNKNOWN_ERROR, with the
 *   request's payload attached.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { Wallet, Transaction, TransactionResponse } = require("ethers");

const logModule = require("../src/log");
const { heldTransaction } = require("../src/held-transaction");
const { _retrySend } = require("../src/tx-retry");
const { classifyRpcError } = require("../src/rpc-error-classifier");

const TO = "0x" + "22".repeat(20);
let RAW;
let SIGNED;

before(async () => {
  const wallet = Wallet.createRandom();
  RAW = await wallet.signTransaction({
    type: 0,
    to: TO,
    nonce: 7,
    gasLimit: 21000n,
    gasPrice: 5n,
    value: 0n,
    chainId: 943n,
  });
  SIGNED = Transaction.from(RAW);
});

/** The error ethers raises when an endpoint answers "already known". */
function alreadyKnown(message = "already known", raw = RAW) {
  const err = new Error(message);
  err.code = "UNKNOWN_ERROR";
  err.payload = {
    method: "eth_sendRawTransaction",
    params: [raw],
    id: 1,
    jsonrpc: "2.0",
  };
  return err;
}

/** Providers as the send paths pass them: one to wait on, one to read. */
function providers() {
  const reads = [];
  return {
    reads,
    pair: {
      wait: { name: "the endpoint that took it" },
      read: {
        getBlockNumber: async () => {
          reads.push("getBlockNumber");
          return 1234;
        },
      },
    },
  };
}

describe("an endpoint's 'already known' answer", () => {
  it("is classified as its own bucket, not as a consumed nonce", () => {
    assert.equal(classifyRpcError(alreadyKnown()), "already-known");
    assert.equal(
      classifyRpcError(alreadyKnown("known transaction: 0xabc")),
      "already-known",
    );
  });
});

describe("heldTransaction", () => {
  it("rebuilds the very transaction the endpoint holds", async () => {
    const { pair, reads } = providers();
    const held = await heldTransaction(alreadyKnown(), pair);
    assert.equal(held.hash, SIGNED.hash);
    assert.equal(held.nonce, 7);
    assert.equal(held.from, SIGNED.from);
    assert.equal(held.to, TO);
    assert.equal(held.gasPrice, 5n);
    assert.equal(held.provider, pair.wait, "waited on where it was taken");
    assert.deepEqual(reads, ["getBlockNumber"], "watches from the block now");
  });

  it("watches for a replacement from the block it was rebuilt at", async (t) => {
    /*-
     *  Made replaceable from the current block, a wait on it notices a
     *  speed-up or a cancel that takes its nonce, rather than waiting on
     *  a hash that will never be mined.
     */
    const replaceable = t.mock.method(
      TransactionResponse.prototype,
      "replaceableTransaction",
    );
    const { pair } = providers();
    await heldTransaction(alreadyKnown(), pair);
    assert.equal(replaceable.mock.callCount(), 1);
    assert.deepEqual(replaceable.mock.calls[0].arguments, [1234]);
  });

  it("answers null when the error carries no signed transaction", async () => {
    const { pair } = providers();
    const bare = new Error("already known");
    assert.equal(await heldTransaction(bare, pair), null);
    const other = alreadyKnown();
    other.payload.method = "eth_call";
    assert.equal(await heldTransaction(other, pair), null);
    assert.equal(await heldTransaction(alreadyKnown("x", "0xnot"), pair), null);
  });

  it("answers null when a provider is missing", async () => {
    const { pair } = providers();
    assert.equal(await heldTransaction(alreadyKnown(), null), null);
    assert.equal(
      await heldTransaction(alreadyKnown(), { wait: pair.wait }),
      null,
    );
    assert.equal(
      await heldTransaction(alreadyKnown(), { read: pair.read }),
      null,
    );
  });
});

describe("_retrySend, answered 'already known'", () => {
  let restoreLog;
  before(() => {
    restoreLog = logModule._setSinkForTests({
      log: () => {},
      warn: () => {},
      error: () => {},
    });
  });

  it("returns the held transaction rather than failing, sending once", async () => {
    const { pair } = providers();
    let sends = 0;
    const held = await _retrySend(
      () => {
        sends++;
        return Promise.reject(alreadyKnown());
      },
      "[test] mint",
      { heldProviders: () => pair },
    );
    assert.equal(held.hash, SIGNED.hash);
    assert.equal(sends, 1, "no second submission of a held transaction");
  });

  it("throws the answer when the held transaction cannot be rebuilt", async () => {
    let sends = 0;
    const err = alreadyKnown();
    await assert.rejects(
      _retrySend(
        () => {
          sends++;
          return Promise.reject(err);
        },
        "[test] mint",
        {},
      ),
      (thrown) => thrown === err,
    );
    assert.equal(sends, 1);
  });

  it("asks for the providers only when it needs them", async () => {
    let asked = 0;
    const r = await _retrySend(() => Promise.resolve("sent"), "[test] mint", {
      heldProviders: () => {
        asked++;
        return providers().pair;
      },
    });
    assert.equal(r, "sent");
    assert.equal(asked, 0);
  });

  after(() => restoreLog());
});
