"use strict";

/**
 * @file test/aggregator-swap-branches.test.js
 * @description The aggregator swap on the inputs and outcomes its common
 *   path does not meet: quotes missing optional fields, receipts without
 *   gas figures, a cancel with no record of what the swap paid, an error
 *   it does not recognise, and a swap that mined after its wait ran out.
 *
 *   The stage — scripted quotes, receipts and chain — is
 *   `helpers/aggregator-harness.js`; `aggregator-swap-paths.test.js`
 *   covers the common path on the same stage.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const config = require("../src/config");
const {
  swapViaAggregator,
  _handleSwapError,
  _submitGasPrice,
  _setWaitMsForTests,
} = require("../src/rebalancer-aggregator");
const { swapIfNeeded } = require("../src/rebalancer-swap");
const {
  ADDR,
  defaultDispatch,
  buildMockEthersLib,
} = require("./helpers/rebalancer-mocks");
const {
  quote,
  confirmed,
  confirmedWithoutGas,
  timedOut,
  state,
  installAggregatorStage,
  restoreAggregatorStage,
  dispatchWithApprovals,
  aggSigner,
  params,
  fixedOut,
} = require("./helpers/aggregator-harness");
const { CANCEL_GAS_LIMIT } = require("../src/tx-speedup");

beforeEach(installAggregatorStage);
afterEach(async () => {
  await restoreAggregatorStage();
  _setWaitMsForTests(null);
});

/** Contract mocks where the exchange already holds enough allowance. */
function approvedLib() {
  const d = defaultDispatch();
  d[ADDR.token0] = { ...d[ADDR.token0], allowance: async () => 10n ** 30n };
  return buildMockEthersLib({ contractDispatch: d });
}

/** `swapIfNeeded` parameters around the harness's swap. */
const swapArgs = (extra = {}) => ({
  ...params(extra),
  swapRouterAddress: ADDR.router,
  fee: 3000,
  currentPrice: 1.0,
  decimalsIn: 18,
  decimalsOut: 18,
  isToken0To1: true,
});

describe("aggregator swap — quotes missing optional fields", () => {
  it("sends no value, and swaps, when the quote names neither value nor sources", async () => {
    state.quoteFor = () => quote({ value: undefined, sources: undefined });
    const r = await swapViaAggregator(
      aggSigner(),
      approvedLib(),
      params(),
      fixedOut,
    );
    assert.equal(state.sent[0].value, 0n);
    assert.equal(r.txHash, "0xswap1");
  });

  it("submits at the chain's own price when the quote names none", async () => {
    // 1000 from the chain × the aggregator's gasPriceMultiplier (1.5).
    const gp = await _submitGasPrice(
      aggSigner().provider,
      quote({ gasPrice: undefined }),
    );
    assert.equal(gp, 1500n);
  });
});

describe("aggregator swap — receipts without gas figures", () => {
  it("reports zero gas for an approved spender and a gas-less receipt", async () => {
    state.receipts = [confirmedWithoutGas];
    const r = await swapViaAggregator(
      aggSigner(),
      approvedLib(),
      params(),
      fixedOut,
    );
    assert.equal(r.gasCostWei, 0n);
    assert.equal(r.txHash, "0xswap1");
  });

  it("sums gas-less chunks to zero after a slippage abort", async () => {
    state.quoteFor = (url) =>
      quote({
        estimatedPriceImpact: url.includes("sellAmount=10000&") ? "6" : "0.1",
      });
    state.receipts = [
      confirmedWithoutGas,
      confirmedWithoutGas,
      confirmedWithoutGas,
    ];
    const r = await swapIfNeeded(aggSigner(), approvedLib(), swapArgs());
    assert.equal(state.sent.length, 3);
    assert.equal(r.gasCostWei, 0n);
  });
});

describe("aggregator swap — outcomes of a wait that ended badly", () => {
  it("passes an error it does not recognise to its caller, unchanged", async () => {
    /*-
     *  Only its own deadline and a revert are answers about the swap;
     *  anything else leaves here as it arrived, with no cancel sent and
     *  no fresh quote.
     */
    const odd = new Error("receipt could not be decoded");
    state.receipts = [
      () => {
        throw odd;
      },
    ];
    await assert.rejects(
      swapViaAggregator(aggSigner(), approvedLib(), params(), fixedOut),
      (err) => err === odd,
    );
    assert.equal(state.sent.length, 1);
    assert.equal(state.cancels.length, 0);
    assert.equal(state.urls.length, 2);
  });

  it("reports a swap that mined after its wait ran out as the swap", async () => {
    /*-
     *  The wait expires, the cancel goes out, and the chain then shows
     *  the swap itself mined. Retrying would swap the balance twice, so
     *  the swap's receipt is the result and nothing is re-quoted.
     */
    _setWaitMsForTests(20);
    state.receipts = [timedOut];
    state.chain["0xswap1"] = confirmed({ hash: "0xswap1" });
    const r = await swapViaAggregator(
      aggSigner(),
      buildMockEthersLib({ contractDispatch: dispatchWithApprovals() }),
      params(),
      fixedOut,
    );
    assert.equal(r.txHash, "0xswap1");
    assert.equal(state.sent.length, 1);
    assert.equal(state.cancels.length, 1);
    assert.equal(state.urls.length, 2, "no re-quote");
    assert.equal(r.gasCostWei, 600000n + 138000n);
  });

  it("prices a cancel to outbid the swap it replaces", async () => {
    /*-
     *  The higher of the chain's own price × the aggregator's
     *  cancelGasMultiplier and the swap's price × the chain's
     *  speedUpGasBump, so it outbids the swap whichever moved.
     */
    const signer = aggSigner();
    state.chain["0xcancel1"] = { hash: "0xcancel1", status: 1 };
    const sent = 5000n;
    const outcome = await _handleSwapError(
      new Error("_AGG_TIMEOUT"),
      signer,
      signer.provider,
      { hash: "0xswap9", nonce: 9 },
      20,
      "T0",
      "T1",
      sent,
    );
    const [cancel] = state.cancels;
    const fromChain = BigInt(
      Math.ceil(1000 * config.CHAIN.aggregator.cancelGasMultiplier),
    );
    const fromSwap = BigInt(
      Math.ceil(Number(sent) * config.CHAIN.speedUpGasBump),
    );
    const want = fromChain > fromSwap ? fromChain : fromSwap;
    assert.equal(cancel.gasPrice, want);
    assert.equal(cancel.nonce, 9);
    assert.equal(cancel.gasLimit, CANCEL_GAS_LIMIT);
    assert.equal(cancel.to, ADDR.signer);
    assert.deepEqual(outcome, {
      cancelGasWei: 0n,
      swapReceipt: null,
      nonceSpent: true,
    });
  });
});
