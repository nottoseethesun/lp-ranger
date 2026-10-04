/**
 * @file test/hodl-baseline-unreadable-mint.test.js
 * @description
 * What the HODL baseline does when it cannot read the mint.
 *
 * The baseline is the two token amounts a position was opened with. It is
 * what the IL/G figure measures the position against, and what the
 * Impermanent Loss Guard compares a projected rebalance to — so both read
 * it as settled fact.
 *
 * A position cannot be opened with nothing. So a zero in that baseline can
 * only mean the chain stated zero, and the chain never does. Any zero
 * standing in for a failed read is therefore a lie neither consumer can
 * detect: IL/G values the HODL side at nothing and reports the entire
 * position as gain, and the Guard, finding no value to compare against,
 * stops gating that position's rebalances for as long as the baseline
 * stands.
 *
 * Three reads have to succeed — the mint's receipt, the deposit event
 * inside it, and the two tokens' decimals — and each can fail on its own.
 * Every failure must leave the baseline alone. These cases cover all
 * three, and the last covers the worst of them: a read that fails while a
 * correct baseline is already saved.
 */

"use strict";

const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");

const { initHodlBaseline } = require("../src/hodl-baseline");
const { _resetForTest } = require("../src/gecko-rate-limit");
const { _setRetryDelayForTests } = require("../src/rebalancer-pools");
const sendTx = require("../src/send-transaction");
const rpcQueue = require("../src/rpc-request-manager");
const outOfService = require("../src/rpc-out-of-service");
const {
  POSITION,
  mockEthersLib,
  mockProvider,
  noPricesResponse,
} = require("./helpers/hodl-baseline-stubs");

let _originalFetch;

beforeEach(() => {
  _originalFetch = globalThis.fetch;
  _resetForTest();
  sendTx._resetForTests();
  rpcQueue._resetForTests();
  outOfService._resetForTests();
  /*- The decimals read is a bounded retry, and two of these cases make it
   *  fail on purpose. Left at its shipped three seconds they would each
   *  sit through the full budget for no added coverage. */
  _setRetryDelayForTests(0);
});

afterEach(() => {
  globalThis.fetch = _originalFetch;
  mock.restoreAll();
  _setRetryDelayForTests(null);
  sendTx._resetForTests();
  rpcQueue._resetForTests();
  outOfService._resetForTests();
});

/**
 * Register a stub library with the endpoint gateway.
 *
 * The decimals read goes through `getPoolState`, which asks the gateway
 * which endpoint is current. With none registered it raises "not
 * initialized" — and the baseline then correctly declines to publish,
 * which is indistinguishable from the failures these cases are about.
 *
 * @param {object} ethersLib  The stub library to register.
 * @returns {void}
 */
function useGateway(ethersLib) {
  sendTx.init({ urls: ["http://hodl-baseline.test"] }, ethersLib);
}

/** An error shaped like an exhausted pool-state retry budget. */
function decimalsUnavailable() {
  throw new Error("pool state unavailable after 6 attempts");
}

describe("an unreadable mint publishes no baseline", () => {
  it("writes nothing when the endpoint has no receipt for the mint", async () => {
    /*- Null from `getTransactionReceipt` is an answer, not an error. An
     *  endpoint returns it for a transaction it does not have, which
     *  includes one whose block falls outside its transaction index — so
     *  it is reachable without anything being broken. */
    const botState = {};
    globalThis.fetch = async () => noPricesResponse();
    const ethers = mockEthersLib();
    useGateway(ethers);

    await initHodlBaseline(
      mockProvider({ receipt: null }),
      ethers,
      POSITION,
      botState,
      mock.fn(),
    );

    assert.strictEqual(
      botState.hodlBaseline,
      undefined,
      "no baseline may be written when the receipt did not come back",
    );
  });

  it("writes nothing when the token decimals cannot be read", async () => {
    /*- The receipt reads fine and the deposit IS found; only the decimals
     *  read fails. That read sits one statement after the loop that skips
     *  logs belonging to other contracts — inside it, its failure was
     *  taken for "not our event", and the search then reported no deposit
     *  at all. */
    const botState = {};
    globalThis.fetch = async () => noPricesResponse();
    const ethers = mockEthersLib({ onDecimals: decimalsUnavailable });
    useGateway(ethers);

    await initHodlBaseline(
      mockProvider(),
      ethers,
      POSITION,
      botState,
      mock.fn(),
    );

    assert.strictEqual(
      botState.hodlBaseline,
      undefined,
      "a failed decimals read must not become an amount of zero",
    );
  });

  it("keeps a saved baseline when the price retry's mint read fails", async () => {
    /*- The destructive case. A baseline whose dollar value never resolved
     *  is re-read at the next start to recover the price, and that re-read
     *  fetches the amounts again. Without a guard a failure there
     *  overwrites amounts that were already correct, so the retry meant to
     *  recover a price destroys what it was protecting. */
    const saved = {
      entryValue: 0,
      hodlAmount0: 0.01,
      hodlAmount1: 0.02,
      mintDate: "2023-11-14",
      mintTimestamp: 1700000000,
      mintGasWei: "15000000000000000",
    };
    const botState = { hodlBaseline: { ...saved } };
    globalThis.fetch = async () => noPricesResponse();
    const ethers = mockEthersLib({ onDecimals: decimalsUnavailable });
    useGateway(ethers);

    await initHodlBaseline(
      mockProvider(),
      ethers,
      POSITION,
      botState,
      mock.fn(),
    );

    assert.deepStrictEqual(
      botState.hodlBaseline,
      saved,
      "the saved baseline must survive a failed re-read untouched",
    );
  });
});
