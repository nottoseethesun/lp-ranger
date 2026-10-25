/**
 * @file test/receipt-reask-bound.test.js
 * @description
 * What stops the bot asking for a receipt, and what must never stop it.
 *
 * When an endpoint refuses to say whether a transaction confirmed, the
 * bot asks a different endpoint the same question. That asking is a
 * read: the transaction is already broadcast, nothing is re-sent, and
 * the refusal says nothing about whether it is on chain. So a refusal
 * is never a reason to give up on the move — only a reason to ask
 * again.
 *
 * Something still has to stop the asking, and the rule is that exactly
 * one thing may: the caller's signal. Inside a speed-up phase, the
 * phase's own clock aborts it, and the move then proceeds to its next
 * phase; during a cancel, the first of the competing transactions to
 * mine aborts the rest.
 *
 * A second stop is the fault these cases exist to prevent. The phase
 * clock and a deadline of the loop's own were once the same length, so
 * under an endpoint that was already down at broadcast they expired
 * within milliseconds of each other — one concluding "speed the
 * transaction up", the other "the move failed". Whichever callback the
 * event loop reached first decided, which meant the bot could abandon a
 * stuck transaction instead of pushing it through with more gas, at the
 * one moment pushing it through mattered most.
 *
 * These drive the re-ask directly rather than through a whole move. The
 * fault was a race between two equal deadlines, so reproducing it
 * through the pipeline is a coin flip, and a coin flip cannot prove a
 * fix.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const sendTx = require("../src/lib/send-transaction");
const rpcQueue = require("../src/lib/rpc-request-manager");
const outOfService = require("../src/lib/rpc-out-of-service");
const logModule = require("../src/lib/log");

const PRI = "http://reask-primary.test";
const FALL = "http://reask-fallback.test";

/** The transaction being asked about. Only its hash is read. */
const TX = { hash: "0xfeedface", nonce: 3 };

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

/** The receipt an endpoint returns once the transaction has mined. */
const RECEIPT = {
  _type: "TransactionReceipt",
  gasUsed: 21000n,
  gasPrice: 1n,
  blockNumber: 1234,
};

/** A 502, shaped the way ethers reports one — a failover-eligible
 *  endpoint failure, which is what sends the bot to another endpoint. */
function serverError(url) {
  const e = new Error("server response 502 Bad Gateway");
  e.code = "SERVER_ERROR";
  e.info = { requestUrl: url, responseStatus: "502 Bad Gateway" };
  return e;
}

/**
 * An ethers stand-in whose providers answer `getTransactionReceipt`.
 *
 * `pollingInterval` is tiny because the re-ask waits it out between
 * asks; ethers' own default is four seconds, which no test should sit
 * through.
 *
 * @param {Function} onAsk  Called with the ask count; its return value
 *   is the answer. `null` means "not mined yet".
 * @returns {object} A stand-in for the ethers library.
 */
function makeLib(onAsk) {
  let asks = 0;
  const lib = {
    JsonRpcProvider: class {
      constructor(url) {
        this._url = url;
        this.pollingInterval = 1;
        this.getFeeData = async () => ({ gasPrice: 1n });
        this.getBlockNumber = async () => 1;
        this.getTransactionReceipt = async () => onAsk(++asks);
      }
      send(method) {
        if (method === "eth_gasPrice") return Promise.resolve("0x1");
        return Promise.resolve(null);
      }
    },
    FeeData: class {},
  };
  lib.askCount = () => asks;
  return lib;
}

describe("what bounds a receipt re-ask", () => {
  let restoreLog;

  beforeEach(() => {
    sendTx._resetForTests();
    rpcQueue._resetForTests();
    outOfService._resetForTests();
    restoreLog = logModule._setSinkForTests({
      log: () => {},
      warn: () => {},
      error: () => {},
    });
  });
  afterEach(() => {
    if (restoreLog) restoreLog();
    sendTx._resetForTests();
    rpcQueue._resetForTests();
    outOfService._resetForTests();
  });

  it("keeps asking under the caller's signal until a receipt arrives", async (t) => {
    /*-
     *  The regression. A loop with a clock of its own would give up
     *  partway and hand back the endpoint's 502 — which the phase's catch
     *  does not recognise, so the move would fail instead of being sped
     *  up. Only the signal may end the asking. Each empty answer here
     *  takes three days, longer than any wait a setting can name, so a
     *  loop timing itself by the clock or by a timer of its own gives up
     *  before the receipt arrives.
     */
    const lib = makeLib((n) => {
      t.mock.timers.tick(THREE_DAYS_MS);
      if (n >= 3) return RECEIPT;
      // Ends the loop's pause between asks once it has begun.
      setImmediate(() => t.mock.timers.tick(1));
      return null;
    });
    sendTx.init({ urls: [PRI, FALL] }, lib);
    const controller = new AbortController();
    /*-
     *  TEST-ONLY global swap: such a clock would be the loop's own, read
     *  from `Date` and `setTimeout`, which take no stand-in. The test
     *  runner puts both back pristine as this case ends.
     */
    t.mock.timers.enable({ apis: ["Date", "setTimeout"] });

    const receipt = await sendTx._receiptAcrossEndpoints(
      serverError(PRI),
      TX,
      "[compound] collect",
      { signal: controller.signal },
    );

    assert.strictEqual(receipt.blockNumber, 1234);
    assert.ok(
      lib.askCount() >= 3,
      `asked ${lib.askCount()} times — nothing but the signal may cut the asking short`,
    );
  });

  it("stops when the phase ends, reporting the endpoint failure", async () => {
    /*- The phase, and only the phase. Nothing here ever mines, so the
     *  abort is the sole way out, and the error handed back is the
     *  endpoint's rather than a timeout of our own — the caller that
     *  cares is a phase that has already moved on, and a timeout would
     *  tell it nothing true about what went wrong. */
    const controller = new AbortController();
    const lib = makeLib((n) => {
      if (n === 2) controller.abort();
      return null;
    });
    sendTx.init({ urls: [PRI, FALL] }, lib);

    await assert.rejects(
      () =>
        sendTx._receiptAcrossEndpoints(
          serverError(PRI),
          TX,
          "[rebalance] mint",
          {
            signal: controller.signal,
          },
        ),
      /502 Bad Gateway/,
    );
  });

  it("rethrows a transaction-level failure without asking anyone", async () => {
    /*- A revert is an answer, not a refusal. Every endpoint would give
     *  the same one, so asking again is pure cost — and treating it as an
     *  endpoint problem would retry a move that genuinely failed. */
    const lib = makeLib(() => RECEIPT);
    sendTx.init({ urls: [PRI, FALL] }, lib);
    const reverted = new Error("execution reverted");
    reverted.code = "CALL_EXCEPTION";

    await assert.rejects(
      () =>
        sendTx._receiptAcrossEndpoints(reverted, TX, "[rebalance] mint", {
          signal: new AbortController().signal,
        }),
      /execution reverted/,
    );
    assert.strictEqual(
      lib.askCount(),
      0,
      "a revert needs no second opinion — nothing should have been asked",
    );
  });
});

// ── The gateway, and the one caller that broadcasts its own transaction ──

describe("waitForReceipt — the only receipt wait outside sendTransaction", () => {
  let restoreLog;

  beforeEach(() => {
    sendTx._resetForTests();
    rpcQueue._resetForTests();
    outOfService._resetForTests();
    restoreLog = logModule._setSinkForTests({
      log: () => {},
      warn: () => {},
      error: () => {},
    });
  });
  afterEach(() => {
    if (restoreLog) restoreLog();
    sendTx._resetForTests();
    rpcQueue._resetForTests();
    outOfService._resetForTests();
  });

  /** A broadcast transaction whose own `wait()` fails the given way. */
  function txWhoseWaitFails(err) {
    return {
      hash: TX.hash,
      nonce: 3,
      wait: async () => {
        throw err;
      },
    };
  }

  it("gets the receipt elsewhere when the broadcasting endpoint quits", async () => {
    /*- The whole point. `tx.wait()` polls the endpoint the transaction
     *  was sent through and cannot follow a failover, so its failure
     *  must not be an outcome the caller has to handle — the gateway
     *  asks another endpoint and the wait resolves normally. */
    const lib = makeLib(() => RECEIPT);
    sendTx.init({ urls: [PRI, FALL] }, lib);

    const r = await sendTx.waitForReceipt({
      tx: txWhoseWaitFails(serverError(PRI)),
      label: "[aggregator] swap A->B",
      ms: 500,
      sentinel: "_AGG_TIMEOUT",
    });

    assert.strictEqual(r.blockNumber, 1234);
  });

  it("rejects with the caller's own sentinel when nothing serves it", async () => {
    /*- Preserved behaviour, and the aggregator depends on it: its catch
     *  recognises `_AGG_TIMEOUT` and runs the cancel-and-settle recovery
     *  on it. If the deadline arrived as anything else that recovery
     *  would be skipped. */
    const lib = makeLib(() => null);
    sendTx.init({ urls: [PRI, FALL] }, lib);

    await assert.rejects(
      () =>
        sendTx.waitForReceipt({
          tx: txWhoseWaitFails(serverError(PRI)),
          label: "[aggregator] swap A->B",
          ms: 60,
          sentinel: "_AGG_TIMEOUT",
        }),
      /_AGG_TIMEOUT/,
    );
  });

  it("passes a transaction-level failure through untouched", async () => {
    /*- A revert is an answer about the transaction, not about an
     *  endpoint. It has to reach the caller as itself, because the
     *  aggregator branches on `CALL_EXCEPTION` to re-quote against
     *  refreshed pool state. */
    const lib = makeLib(() => RECEIPT);
    sendTx.init({ urls: [PRI, FALL] }, lib);
    const reverted = new Error("execution reverted");
    reverted.code = "CALL_EXCEPTION";

    await assert.rejects(
      () =>
        sendTx.waitForReceipt({
          tx: txWhoseWaitFails(reverted),
          label: "[aggregator] swap A->B",
          ms: 500,
          sentinel: "_AGG_TIMEOUT",
        }),
      /execution reverted/,
    );
  });

  it("is what the aggregator's swap wait actually uses", () => {
    /*- Wiring, not behaviour, so it is asserted against the source. The
     *  bug was never in how a receipt was fetched — it was that this one
     *  caller fetched its own, with a bare `tx.wait()` raced against a
     *  timer, so an endpoint failure escaped unflagged and the router
     *  fallback swapped the same balance a second time. Behavioural
     *  coverage cannot catch that returning: a future edit could go back
     *  to a bare wait and every case above would still pass. */
    const src = fs
      .readFileSync(
        path.join(__dirname, "..", "src", "lib", "rebalancer-aggregator.js"),
        "utf8",
      )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    assert.match(
      src,
      /waitForReceipt\(/,
      "the swap's confirmation must come from the endpoint gateway",
    );
    /*- Any `.wait()` left in this module must have its rejection
     *  neutralised, as the cancel's does. An un-neutralised one inside a
     *  race is the exact shape that caused the double swap. */
    for (const m of src.matchAll(/\.wait\(\)(.{0,8})/g)) {
      assert.match(
        m[1],
        /^\.catch\(/,
        `a .wait() in rebalancer-aggregator.js is not neutralised: ".wait()${m[1]}"`,
      );
    }
  });
});
