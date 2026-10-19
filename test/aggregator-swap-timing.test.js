"use strict";

/**
 * @file test/aggregator-swap-timing.test.js
 * @description The aggregator swap's wait for its receipt is timed from
 *   the swap's first submission.
 *
 *   A swap whose submission is slow to come back, or that an endpoint
 *   answers "already known" on a resubmission, has been waiting since it
 *   was first sent. The user, 2026-10-17: if an endpoint answers "we
 *   already have it" to any transaction after the waiting period has
 *   passed, the bot should go on to the higher-gas step at once. For the
 *   aggregator that step is the cancel and a fresh quote, which its own
 *   deadline starts, so the deadline counts what the submission already
 *   used. Driven through the aggregator test harness, with the swap's
 *   broadcast made slower than the whole wait.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const sendTx = require("../src/send-transaction");
const {
  swapViaAggregator,
  _setWaitMsForTests,
} = require("../src/rebalancer-aggregator");
const { buildMockEthersLib } = require("./helpers/rebalancer-mocks");
const {
  EXCHANGE,
  installAggregatorStage,
  restoreAggregatorStage,
  dispatchWithApprovals,
  aggSigner,
  params,
  fixedOut,
} = require("./helpers/aggregator-harness");

beforeEach(installAggregatorStage);
afterEach(() => {
  _setWaitMsForTests(null);
  return restoreAggregatorStage();
});

describe("the aggregator swap's receipt wait", () => {
  it("gives a swap whose submission used up the wait no more time", async () => {
    _setWaitMsForTests(100);
    const signer = aggSigner();
    const send = signer.sendTransaction;
    // The swap's broadcast takes longer than the whole wait.
    signer.sendTransaction = async (req) => {
      if (req.to === EXCHANGE) await new Promise((r) => setTimeout(r, 300));
      return send(req);
    };
    const asked = [];
    const harnessWait = sendTx.waitForReceipt;
    sendTx.waitForReceipt = (a) => {
      asked.push(a.ms);
      return harnessWait(a);
    };
    const lib = buildMockEthersLib({
      contractDispatch: dispatchWithApprovals(),
    });
    await swapViaAggregator(signer, lib, params(), fixedOut);
    assert.ok(asked.length >= 1);
    assert.equal(asked[0], 0, "the whole wait was spent sending");
  });

  it("gives a swap sent at once the whole wait", async () => {
    _setWaitMsForTests(5000);
    const asked = [];
    const harnessWait = sendTx.waitForReceipt;
    sendTx.waitForReceipt = (a) => {
      asked.push(a.ms);
      return harnessWait(a);
    };
    const lib = buildMockEthersLib({
      contractDispatch: dispatchWithApprovals(),
    });
    await swapViaAggregator(aggSigner(), lib, params(), fixedOut);
    assert.ok(asked[0] > 4000, `asked to wait ${asked[0]} ms`);
  });
});
