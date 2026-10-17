"use strict";

/**
 * @file test/helpers/aggregator-harness.js
 * @description The stage for tests that drive an aggregator swap from
 *   quote to receipt.
 *
 *   An aggregator swap is a quote fetched over http, an approval of the
 *   quote's spender, a fresh quote, the quoted transaction broadcast, and
 *   a wait for its receipt — retried when the route goes stale, and
 *   cancelled when the wait runs out. This helper scripts every one of
 *   those answers while leaving the code that reacts to them real:
 *
 *   - The aggregator is a real local http server, which the active chain's
 *     aggregator url points at, so each quote travels through Node's own
 *     `fetch`. It answers from `state.quotes` in order, then from
 *     `state.quoteFor`, and records each request's path in `state.urls`.
 *   - `sendTx.waitForReceipt` answers a cancel from the cancel's own
 *     `wait()`, and a swap from `state.receipts` in order, then
 *     confirms.
 *   - `aggSigner()` broadcasts the swap and any cancel itself, recording
 *     each, and hands the approvals to the shared contract mocks.
 *   - Its provider answers receipt lookups from `state.chain`, so the
 *     timeout recovery can find out what mined.
 *
 *   `installAggregatorStage()` belongs in `beforeEach` and
 *   `restoreAggregatorStage()` in `afterEach`; both are async. Each test
 *   file runs in its own process, so the module-level `state` is per file.
 */

const http = require("http");
const config = require("../../src/config");
const sendTx = require("../../src/send-transaction");
const { ADDR, mockSigner, defaultDispatch } = require("./rebalancer-mocks");

/** The exchange proxy a quote names as both `to` and spender. */
const EXCHANGE = "0xEXCHANGE00000000000000000000000000000001";
const OTHER_SPENDER = "0xEXCHANGE00000000000000000000000000000002";

/** An aggregator quote in 0x v1's shape. */
function quote(extra = {}) {
  return {
    to: EXCHANGE,
    data: "0xdeadbeef",
    value: "0",
    gas: "250000",
    gasPrice: "2000",
    allowanceTarget: EXCHANGE,
    buyAmount: "990",
    guaranteedPrice: "0.98",
    estimatedPriceImpact: "0.1",
    sources: [{ name: "NineMM_V3", proportion: "1" }],
    ...extra,
  };
}

/** A confirmed receipt for a broadcast swap. */
const confirmed = (tx) => ({
  hash: tx.hash,
  gasUsed: 300000n,
  gasPrice: 2n,
  status: 1,
});

/** A confirmed receipt that carries no gas figures. */
const confirmedWithoutGas = (tx) => ({ hash: tx.hash, status: 1 });

/** What the chain reports for a swap whose route went stale. */
function reverted() {
  const e = new Error("execution reverted");
  e.code = "CALL_EXCEPTION";
  e.receipt = { gasUsed: 50000n, status: 0 };
  throw e;
}

/** What the receipt wait reports when its time runs out. */
function timedOut() {
  throw new Error("_AGG_TIMEOUT");
}

/** Everything a test scripted, and everything the code under test did. */
const state = {};
const realWait = sendTx.waitForReceipt;
const stage = { server: null, savedUrl: null };

/** The aggregator's side of a quote request: the next scripted quote. */
function answerQuote(req, res) {
  state.urls.push(req.url);
  const q = state.quotes.length
    ? state.quotes.shift()
    : state.quoteFor(req.url);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(q));
}

/**
 * Reset `state`, start the local aggregator and point the active chain's
 * aggregator url at it, and put the scripted receipt wait in place.
 */
async function installAggregatorStage() {
  Object.assign(state, {
    urls: [],
    quotes: [],
    sent: [],
    cancels: [],
    approvals: [],
    receipts: [],
    chain: {},
    measuredOn: null,
    quoteFor: () => quote(),
  });
  stage.server = http.createServer(answerQuote);
  await new Promise((resolve) => stage.server.listen(0, "127.0.0.1", resolve));
  stage.savedUrl = config.AGGREGATOR_URL;
  config.AGGREGATOR_URL = `http://127.0.0.1:${stage.server.address().port}`;
  sendTx.waitForReceipt = async ({ tx, sentinel }) => {
    /*-
     *  A cancel answers from its own `wait()`, which this stage's signer
     *  scripts as "no receipt in time"; the gateway reports that as its
     *  deadline. The scripted receipts are the swaps'.
     */
    if (tx.hash.startsWith("0xcancel")) {
      const receipt = await tx.wait();
      if (receipt) return receipt;
      throw new Error(sentinel);
    }
    const next = state.receipts.shift() ?? confirmed;
    return next(tx);
  };
}

/** Put the aggregator url and receipt wait back, and stop the server. */
async function restoreAggregatorStage() {
  config.AGGREGATOR_URL = stage.savedUrl;
  sendTx.waitForReceipt = realWait;
  stage.server.closeAllConnections();
  await new Promise((resolve) => stage.server.close(resolve));
  stage.server = null;
}

/** Contract mocks whose approve records its spender and reports gas. */
function dispatchWithApprovals() {
  const d = defaultDispatch();
  d[ADDR.token0] = {
    ...d[ADDR.token0],
    approve: async (spender, amount) => {
      state.approvals.push({ spender, amount });
      return {
        wait: async () => ({
          hash: "0xapprove",
          gasUsed: 46000n,
          gasPrice: 3n,
          logs: [],
        }),
      };
    },
  };
  return d;
}

/**
 * A signer that broadcasts the aggregator's swap and any cancel itself,
 * and hands every other transaction (the approvals) to the shared
 * contract mocks. A cancel is the 0-value self-transfer the timeout
 * recovery sends; it never confirms here, so `state.chain` decides what
 * mined.
 */
function aggSigner() {
  const base = mockSigner();
  return {
    ...base,
    provider: {
      ...base.provider,
      getTransactionReceipt: async (hash) => state.chain[hash] ?? null,
    },
    sendTransaction: async (req) => {
      if (req.to === ADDR.signer) {
        state.cancels.push(req);
        return {
          hash: "0xcancel" + state.cancels.length,
          nonce: req.nonce,
          gasPrice: req.gasPrice,
          wait: async () => null,
        };
      }
      if (req.to !== EXCHANGE) return base.sendTransaction(req);
      state.sent.push(req);
      return {
        hash: "0xswap" + state.sent.length,
        nonce: 40 + state.sent.length,
        gasPrice: req.gasPrice,
        type: req.type,
      };
    },
  };
}

/** `swapViaAggregator` parameters for a token0 → token1 swap. */
const params = (extra = {}) => ({
  tokenIn: ADDR.token0,
  tokenOut: ADDR.token1,
  amountIn: 10000n,
  slippagePct: 0.5,
  recipient: ADDR.signer,
  symbolIn: "T0",
  symbolOut: "T1",
  approvalMultiple: 1,
  ...extra,
});

/**
 * balanceDiff stand-in: runs the swap, reports a fixed output, and
 * records the provider the output was measured on.
 */
const fixedOut = async (_lib, _out, _r, prov, fn) => {
  state.measuredOn = prov;
  return { ...(await fn()), amountOut: 9900n };
};

module.exports = {
  EXCHANGE,
  OTHER_SPENDER,
  quote,
  confirmed,
  confirmedWithoutGas,
  reverted,
  timedOut,
  state,
  installAggregatorStage,
  restoreAggregatorStage,
  dispatchWithApprovals,
  aggSigner,
  params,
  fixedOut,
};
