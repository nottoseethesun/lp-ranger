"use strict";

/**
 * @file test/aggregator-quote-time-limit.test.js
 * @description The aggregator quote request gives up after
 * `config.AGGREGATOR_QUOTE_TIMEOUT_MS`, and the swap then goes through the
 * V3 router in the position's own pool.
 *
 * The aggregator here is a real local server that accepts the request and
 * never answers, not a `fetch` stub. A stub would show only that the code
 * passes a signal; the server shows that the request really ends when the
 * limit runs out, through Node's own `fetch`. Each case carries its own
 * test timeout, so code without the limit fails here instead of hanging
 * the suite.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("assert");
const http = require("http");
const config = require("../src/config");
const { swapIfNeeded } = require("../src/rebalancer-swap");
const { swapViaAggregator } = require("../src/rebalancer-aggregator");
const CHAINS = require("../app-config/app-defaults-for-user-configurable/chains.json");
const {
  ADDR,
  makeTx,
  mockSigner,
  defaultDispatch,
  buildMockEthersLib,
} = require("./helpers/rebalancer-mocks");

// Short, to keep the suite quick; the shipped limit is far longer.
const LIMIT_MS = 300;

/*-
 *  How long a case may run before it counts as hung: the limit, plus
 *  room for the router fallback on a loaded machine.
 */
const HUNG_MS = 5000;

// Accepts every request and never answers.
const silent = http.createServer(() => {});
const saved = {};

before(async () => {
  await new Promise((resolve) => silent.listen(0, "127.0.0.1", resolve));
  saved.url = config.AGGREGATOR_URL;
  saved.limitMs = config.AGGREGATOR_QUOTE_TIMEOUT_MS;
  config.AGGREGATOR_URL = `http://127.0.0.1:${silent.address().port}`;
  config.AGGREGATOR_QUOTE_TIMEOUT_MS = LIMIT_MS;
});

after(() => {
  config.AGGREGATOR_URL = saved.url;
  config.AGGREGATOR_QUOTE_TIMEOUT_MS = saved.limitMs;
  silent.closeAllConnections();
  silent.close();
});

const swArgs = () => ({
  swapRouterAddress: ADDR.router,
  tokenIn: ADDR.token0,
  tokenOut: ADDR.token1,
  fee: 3000,
  amountIn: 10000n,
  slippagePct: 0.5,
  recipient: ADDR.signer,
  currentPrice: 1.0,
  decimalsIn: 18,
  decimalsOut: 18,
  isToken0To1: true,
  deadline: 9999999999n,
});

describe("aggregator quote time limit", () => {
  it("reads the active chain's limit from chains.json at startup", () => {
    const shipped = CHAINS[config.CHAIN_NAME].aggregator.quoteTimeoutMs;
    assert.ok(Number.isInteger(shipped) && shipped > 0, String(shipped));
    assert.strictEqual(saved.limitMs, shipped);
  });

  it(
    "gives up on a quote that never arrives, naming the limit",
    { timeout: HUNG_MS },
    async () => {
      await assert.rejects(
        swapViaAggregator(
          mockSigner(),
          buildMockEthersLib({ contractDispatch: defaultDispatch() }),
          swArgs(),
          async () => assert.fail("no swap may be built without a quote"),
        ),
        /^Error: Aggregator API: no answer within 0\.3 s$/,
      );
    },
  );

  it(
    "then swaps through the V3 router in the position's own pool",
    { timeout: HUNG_MS },
    async () => {
      const d = defaultDispatch();
      let swapped = false;
      d[ADDR.token1] = {
        ...d[ADDR.token1],
        balanceOf: async () => (swapped ? 9000n : 0n),
      };
      d[ADDR.router] = {
        exactInputSingle: Object.assign(
          async () => {
            swapped = true;
            return makeTx("0xs");
          },
          { staticCall: async (p) => p.amountIn },
        ),
      };
      const r = await swapIfNeeded(
        mockSigner(),
        buildMockEthersLib({ contractDispatch: d }),
        swArgs(),
      );
      assert.ok(swapped, "the V3 router should have swapped");
      assert.strictEqual(r.swapSources, "9mm V3 Router");
      assert.ok(r.amountOut > 0n, "expected the router's output");
    },
  );
});
