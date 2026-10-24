/**
 * @file test/receipt-wait-failover.test.js
 * @description
 * A transaction that is already on chain must not be lost because the
 * endpoint that broadcast it stopped answering.
 *
 * `tx.wait()` polls the provider the transaction object was built with.
 * It never asks which endpoint is current, so it cannot follow the
 * failover — and until `_receiptAcrossEndpoints` it did not try. The
 * error propagated out of `_waitOrSpeedUp` and killed the whole move.
 *
 * Production, 2026-09-30, on a compound:
 *
 *   13:23:09  collect: TX not confirmed after 120s — speeding up
 *   13:23:10  RPC failover engaged: g4mm4 → rpc.pulsechain.com
 *   13:23:13  collect speedup: 'nonce too low' — original TX likely mined
 *   13:23:13  Compound failed: server response 502 Bad Gateway (g4mm4)
 *
 * The failover had moved three seconds earlier and the wait was still
 * asking the endpoint it had left. The fee collection was mined; the
 * fees sat in the wallet instead of the position, and their gas went
 * unrecorded because gas is written on the success path only.
 *
 * What the fix claims, and what these cases check: a receipt is a READ.
 * Nothing is re-sent — the transaction is already broadcast — so the
 * only thing needed is to ask a different endpoint the same question.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const sendTx = require("../src/lib/send-transaction");
const config = require("../src/lib/config");
const rpcQueue = require("../src/lib/rpc-request-manager");
const outOfService = require("../src/lib/rpc-out-of-service");
const logModule = require("../src/lib/log");

const PRI = "http://primary.test";
const FALL = "http://fallback.test";

/** The receipt every healthy endpoint in these cases returns. */
const RECEIPT = {
  _type: "TransactionReceipt",
  gasUsed: 21000n,
  gasPrice: 1n,
  blockNumber: 99,
  hash: "0xdeadbeef",
};

/** A 502 shaped the way ethers reports one. */
function serverError(url) {
  const e = new Error("server response 502 Bad Gateway");
  e.code = "SERVER_ERROR";
  e.info = { requestUrl: url, responseStatus: "502 Bad Gateway" };
  return e;
}

/**
 * An ethers stand-in whose providers answer `getTransactionReceipt`.
 *
 * That is the call the re-ask makes, and the reason matters: it returns
 * `null` for a transaction that is not mined and throws only when the
 * endpoint is at fault, so "not yet" and "broken" are different
 * answers. `waitForTransaction` conflates them behind a subscription.
 *
 * `pollingInterval` is tiny here because the loop waits it out between
 * attempts; ethers' own default is four seconds.
 *
 * @param {object} receipts  Per-URL `getTransactionReceipt` behaviour.
 * @returns {object} A stand-in for the ethers library.
 */
function makeLib(receipts = {}) {
  return {
    JsonRpcProvider: class {
      constructor(url) {
        this._url = url;
        this.pollingInterval = 5;
        this.getFeeData = async () => ({ gasPrice: 1n });
        this.estimateGas = async () => 100_000n;
        this.getBlockNumber = async () => 1;
        this.getTransactionReceipt =
          receipts[url] || (async () => ({ ...RECEIPT, servedBy: url }));
      }
      send(method) {
        if (method === "eth_gasPrice") return Promise.resolve("0x1");
        return Promise.resolve(null);
      }
    },
    FeeData: class {},
  };
}

/**
 * A signer whose broadcast succeeds and whose `tx.wait()` behaves as
 * given — the shape of the Production failure, where the send worked
 * and the wait did not.
 *
 * @param {Function} wait  What `tx.wait()` does.
 * @returns {object} A signer stand-in.
 */
function makeSigner(wait) {
  return {
    getAddress: async () => "0x" + "11".repeat(20),
    // The speed-up and the cancel price themselves off the signer's provider.
    provider: { getFeeData: async () => ({ gasPrice: 1n }) },
    sendTransaction: async () => ({
      hash: "0xdeadbeef",
      nonce: 7,
      gasLimit: 300000n,
      gasPrice: 1n,
      wait,
    }),
  };
}

/**
 * A signer that hands back a fresh hash each time, so the speed-up
 * replacement is a different transaction from the original — which is
 * what makes two concurrent receipt waits possible, and only one of
 * them ever satisfiable.
 *
 * @param {Function} wait  What every returned `tx.wait()` does.
 * @returns {object} A signer stand-in.
 */
function makeSpeedUpSigner(wait) {
  let n = 0;
  return {
    getAddress: async () => "0x" + "11".repeat(20),
    // `_submitSpeedUp` prices the replacement off the signer's provider.
    provider: { getFeeData: async () => ({ gasPrice: 1n }) },
    sendTransaction: async () => ({
      hash: "0xhash" + ++n,
      nonce: 7,
      gasLimit: 300000n,
      gasPrice: 1n,
      to: "0x" + "22".repeat(20),
      data: "0x",
      value: 0n,
      wait,
    }),
  };
}

describe("every re-ask is bounded, on both the compound and rebalance paths", () => {
  /*- The condition is the speed-up: two hashes waited on at once, of
   *  which only one can ever mine. The loser is a wait nothing will
   *  ever satisfy, and without a deadline it polls a block at a time
   *  forever, through the queue everything else shares.
   *
   *  Compound and rebalance both reach the chain through
   *  `sendTransaction`, so the same pipeline carries both — but they
   *  are driven separately here rather than asserted to be equivalent,
   *  because "they share a code path" is the kind of claim that stops
   *  being true quietly. */

  let savedSpeedup;
  let savedCancel;
  let restore;

  beforeEach(() => {
    /*- Shortened so phase 2 actually fires inside a test. `config` is a
     *  plain module object, not a JS global, and every value is put
     *  back in `afterEach`; node runs each test FILE in its own
     *  process, so nothing here can reach another file. */
    savedSpeedup = config.TX_SPEEDUP_SEC;
    savedCancel = config.TX_CANCEL_SEC;
    /*- Long enough that the loop certainly gets a turn, short enough
     *  that the file still runs in about a second.
     *
     *  This was 50 ms, which made one case flaky under the suite's own
     *  concurrency: a re-ask has to travel a dozen awaits — send, wait,
     *  the error hook, the managed provider, the pacing queue — before
     *  it reaches the endpoint, and 50 ms of wall-clock can pass across
     *  those hops while 24 test files compete for the event loop. The
     *  phase would then expire before a single ask had been made, and
     *  the case asserts that an ask WAS made.
     *
     *  Not smaller than the pacing interval either: at
     *  `globalRPCRequestRateIntervalMS` of 222 ms, only the first
     *  release is immediate, so a budget under that leaves no room for
     *  a second ask and nothing to observe if the first is delayed. */
    config.TX_SPEEDUP_SEC = 0.6;
    config.TX_CANCEL_SEC = 3;
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
    config.TX_SPEEDUP_SEC = savedSpeedup;
    config.TX_CANCEL_SEC = savedCancel;
    if (restore) restore();
    sendTx._resetForTests();
    rpcQueue._resetForTests();
    outOfService._resetForTests();
  });

  /**
   * Drive one move through a speed-up in which every `tx.wait()` fails
   * and the original's hash never mines.
   *
   * @param {string} label  The move's log label.
   * @returns {Promise<object[]>} Every `waitForTransaction` call made.
   */
  async function _driveSpeedUp(label) {
    const asks = [];
    const lib = makeLib({
      [PRI]: async (hash) => {
        asks.push({ hash, at: Date.now() });
        /*- The first hash is the original. It was replaced, so it never
         *  mines — and an unmined transaction is `null`, not a hang.
         *  Modelling it as a promise that never settles was wrong twice
         *  over: ethers does not behave that way, and Node 22's runner
         *  cancels a whole file over one pending promise. */
        if (hash === "0xhash1") return null;
        return { ...RECEIPT, servedBy: PRI };
      },
    });
    sendTx.init({ urls: [PRI, FALL] }, lib);
    const signer = makeSpeedUpSigner(async () => {
      throw serverError(PRI);
    });
    /*- The move must SUCCEED, and that assertion belongs here rather
     *  than in a tolerated catch. Every receipt wait in this fixture
     *  fails, so the only way through is the re-ask — and a refusing
     *  endpoint must never end the move, only send the question
     *  elsewhere. The original can never mine, so what confirms is the
     *  speed-up replacement, which means the phase clock has to be the
     *  one that ended phase 1.
     *
     *  This case previously tolerated a failure, because the re-ask once
     *  carried a deadline of the phase's own length and could reject
     *  first — leaving the move abandoned instead of sped up. Nothing
     *  bounds a re-ask inside a phase now except the phase, so there is
     *  no second outcome to allow for. */
    const { receipt } = await sendTx.sendTransaction({
      populate: async () => ({
        to: "0x" + "22".repeat(20),
        gasLimit: 300000n,
      }),
      signer,
      label,
    });
    return { asks, receipt };
  }

  for (const label of ["[compound] collect", "[rebalance] mint"]) {
    it(`bounds every receipt re-ask during a speed-up: ${label}`, async () => {
      const { asks, receipt } = await _driveSpeedUp(label);
      /*- A refusing endpoint must cost the move nothing. Every wait here
       *  was refused, so a confirmed receipt is the proof that the
       *  refusals were asked around rather than treated as the move
       *  failing — and since the original never mines, the receipt can
       *  only be the speed-up's. */
      assert.ok(receipt, "the move must confirm despite every wait failing");
      assert.ok(
        asks.some((a) => a.hash === "0xhash1"),
        "the never-mined hash must be asked about — it is the one that leaks",
      );
      /*- Finite is the whole claim. The hash asked about here can never
       *  mine, so every one of these would repeat until the process
       *  died if the phase's budget were not carried down to the loop
       *  that does the asking. */
      assert.ok(
        asks.length < 200,
        `${asks.length} re-asks for hashes that include one that never mines — ` +
          "the phase budget is not reaching the loop",
      );
    });
  }
});

let restoreLog;
describe("a receipt survives the endpoint that broadcast it going down", () => {
  beforeEach(() => {
    /*- Providers are rebuilt per case. `init` is a no-op when the URLs
     *  match, so without this every case after the first would keep the
     *  first one's stub library and its endpoint behaviour. */
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

  it("gets the receipt from a DIFFERENT endpoint when the first is down", async () => {
    /*- The Production shape, with the whole endpoint down rather than
     *  just the wait: the transaction is mined, and the endpoint that
     *  broadcast it answers nothing. Only a receipt carrying the other
     *  endpoint's name proves the move actually crossed over, which a
     *  receipt from the first endpoint would not. */
    sendTx.init(
      { urls: [PRI, FALL] },
      makeLib({
        [PRI]: async () => {
          throw serverError(PRI);
        },
      }),
    );
    const signer = makeSigner(async () => {
      throw serverError(PRI);
    });
    const { receipt } = await sendTx.sendTransaction({
      populate: async () => ({ to: "0x" + "22".repeat(20), gasLimit: 300000n }),
      signer,
      label: "[compound] collect",
    });
    assert.strictEqual(
      receipt.servedBy,
      FALL,
      "the receipt must come from the endpoint that was failed over to",
    );
    assert.strictEqual(receipt.blockNumber, 99);
  });

  it("confirms a move whose nonce is taken, once an endpoint serves its receipt", async () => {
    /*-
     *  The Production shape: the speed-up and then the cancel are both
     *  refused because the original already occupies the nonce, while
     *  every endpoint is still too far behind to serve its receipt. A
     *  refusing endpoint is never the move's failure, and a nonce taken
     *  by the move itself is the move having happened, so the bot keeps
     *  asking until a receipt comes back, and reports that receipt.
     */
    const saved = {
      speedup: config.TX_SPEEDUP_SEC,
      cancel: config.TX_CANCEL_SEC,
      floor: config.TX_CANCEL_PHASE_FLOOR_SEC,
    };
    config.TX_SPEEDUP_SEC = 0.1;
    config.TX_CANCEL_SEC = 0.3;
    config.TX_CANCEL_PHASE_FLOOR_SEC = 0.1;
    let asked = 0;
    let sends = 0;
    let receipt;
    try {
      /**
       * No endpoint has the receipt until the cancel — the third send —
       * has been tried, so the answer has to come through the cancel
       * phase rather than phase 3.
       */
      const behind = async () => {
        asked++;
        return sends < 3 ? null : { ...RECEIPT, servedBy: FALL };
      };
      sendTx.init(
        { urls: [PRI, FALL] },
        makeLib({ [PRI]: behind, [FALL]: behind }),
      );
      const signer = makeSigner(async () => {
        throw serverError(PRI);
      });
      const firstSend = signer.sendTransaction;
      signer.sendTransaction = async (...args) => {
        if (++sends > 1) {
          const e = new Error("nonce has already been used");
          e.code = "NONCE_EXPIRED";
          throw e;
        }
        return firstSend(...args);
      };
      ({ receipt } = await sendTx.sendTransaction({
        populate: async () => ({
          to: "0x" + "22".repeat(20),
          gasLimit: 300000n,
        }),
        signer,
        label: "[compound] collect",
      }));
    } finally {
      config.TX_SPEEDUP_SEC = saved.speedup;
      config.TX_CANCEL_SEC = saved.cancel;
      config.TX_CANCEL_PHASE_FLOOR_SEC = saved.floor;
    }
    assert.strictEqual(receipt.blockNumber, 99);
    assert.strictEqual(
      sends,
      3,
      "the move, the refused speed-up, the refused cancel",
    );
    assert.ok(asked > 0);
  });

  it("does not swallow an error that describes the transaction", async () => {
    /*- A revert is an answer, not an endpoint problem. Asking a second
     *  endpoint would return the same one, and treating it as
     *  recoverable would report a failed move as confirmed. */
    sendTx.init({ urls: [PRI, FALL] }, makeLib());
    const reverted = new Error("execution reverted");
    reverted.code = "CALL_EXCEPTION";
    const signer = makeSigner(async () => {
      throw reverted;
    });
    await assert.rejects(
      () =>
        sendTx.sendTransaction({
          populate: async () => ({
            to: "0x" + "22".repeat(20),
            gasLimit: 300000n,
          }),
          signer,
          label: "[rebalance] mint",
        }),
      /execution reverted/,
    );
  });

  it("keeps the replacement receipt when the TX was replaced", async () => {
    /*- The speed-up path depends on this: ethers reports a replaced
     *  transaction by throwing, carrying the replacement's receipt.
     *  That is a result, and must not be re-routed as a failure. */
    sendTx.init({ urls: [PRI, FALL] }, makeLib());
    const replaced = new Error("transaction was replaced");
    replaced.code = "TRANSACTION_REPLACED";
    replaced.receipt = { ...RECEIPT, blockNumber: 123 };
    const signer = makeSigner(async () => {
      throw replaced;
    });
    const { receipt } = await sendTx.sendTransaction({
      populate: async () => ({ to: "0x" + "22".repeat(20), gasLimit: 300000n }),
      signer,
      label: "[rebalance] swap",
    });
    assert.strictEqual(receipt.blockNumber, 123);
  });

  it("reports the failing endpoint so it counts toward leaving it", async () => {
    /*- Before this, a receipt wait against a dying endpoint told the
     *  out-of-service decider nothing — the error propagated and the
     *  endpoint's worst moments were invisible to the thing that
     *  decides whether to leave it. Routing through the read path is
     *  what reports them.
     *
     *  Asserted by consequence, because the tally itself cannot be read
     *  afterwards: engaging a failover clears the samples for the
     *  endpoint being left, so `decideIfCurrentRPCIsOutOfService` reads
     *  false the moment the move succeeds. What survives is the move.
     *  Selection only advances when the decider crosses, and the
     *  decider only crosses on reported failures — so selection sitting
     *  on the second endpoint is proof the first one's receipt waits
     *  were counted. Before the fix the error propagated instead, and
     *  selection never moved at all. */
    sendTx.init(
      { urls: [PRI, FALL] },
      makeLib({
        [PRI]: async () => {
          throw serverError(PRI);
        },
      }),
    );
    const signer = makeSigner(async () => {
      throw serverError(PRI);
    });
    await sendTx.sendTransaction({
      populate: async () => ({ to: "0x" + "22".repeat(20), gasLimit: 300000n }),
      signer,
      label: "[compound] collect",
    });
    assert.strictEqual(
      sendTx.getCurrentRPCUrl(),
      FALL,
      "selection must have moved off the endpoint whose waits were failing",
    );
  });
});
