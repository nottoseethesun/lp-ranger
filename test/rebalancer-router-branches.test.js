"use strict";

/**
 * @file test/rebalancer-router-branches.test.js
 * @description The V3 router swap — the position's own pool, used when
 *   the aggregator fails and on chains with no aggregator — on the inputs
 *   its common path does not meet: a token1 → token0 swap, a failed
 *   quote, and a pool with no price or no liquidity, plus the deadline it
 *   stamps on every swap.
 *
 *   `swapViaRouter` runs for real against the shared contract mocks: its
 *   `staticCall` quote, the impact check, the minimum-output floor, the
 *   approval and the send pipeline. Only the router's quote and the
 *   balance difference are scripted per test.
 *
 *   The deadline window is an operator's own, ten minutes, not the
 *   fifteen that ship, so a window written into the code fails.
 */

const fs = require("fs");
const path = require("path");
const { makeTestTempFolder } = require("../src/test-temp-folders");

const SETTINGS_DIR = makeTestTempFolder("router-branches-settings");
fs.writeFileSync(
  path.join(SETTINGS_DIR, "app-runtime.json"),
  JSON.stringify({ tx: { deadlineSec: 600 } }),
);
process.env.LP_RANGER_USER_CONFIG_DIR = SETTINGS_DIR;

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { swapViaRouter } = require("../src/rebalancer-router");
const {
  ADDR,
  makeTx,
  mockSigner,
  defaultDispatch,
  buildMockEthersLib,
} = require("./helpers/rebalancer-mocks");

/**
 * Contract mocks whose router quotes `quote(amountIn)` and records the
 * parameters of every quote and every swap it is sent.
 */
function routerLib(quote, seen) {
  const d = defaultDispatch();
  d[ADDR.token0] = { ...d[ADDR.token0], allowance: async () => 10n ** 30n };
  d[ADDR.token1] = { ...d[ADDR.token1], allowance: async () => 10n ** 30n };
  d[ADDR.router] = {
    exactInputSingle: Object.assign(
      async (p) => {
        seen.sent.push(p);
        return makeTx("0xrouted");
      },
      {
        staticCall: async (p) => {
          seen.quoted.push(p);
          return quote(p.amountIn);
        },
      },
    ),
  };
  return buildMockEthersLib({ contractDispatch: d });
}

const base = (extra = {}) => ({
  swapRouterAddress: ADDR.router,
  tokenIn: ADDR.token0,
  tokenOut: ADDR.token1,
  fee: 3000,
  amountIn: 10000n,
  slippagePct: 0.5,
  currentPrice: 1.0,
  decimalsIn: 18,
  decimalsOut: 18,
  isToken0To1: true,
  recipient: ADDR.signer,
  ...extra,
});

/** balanceDiff stand-in: runs the swap and reports a fixed output. */
function diff() {
  return async (_lib, _out, _r, _prov, fn) => ({
    ...(await fn()),
    amountOut: 1n,
  });
}

const fresh = () => ({ quoted: [], sent: [] });

describe("V3 router swap — the deadline it stamps", () => {
  it("stamps a deadline from the configured window", async () => {
    const seen = fresh();
    const before = Math.floor(Date.now() / 1000);
    await swapViaRouter(
      mockSigner(),
      routerLib((a) => a, seen),
      base(),
      diff(seen),
    );
    const dl = Number(seen.sent[0].deadline);
    assert.ok(dl >= before + 600, String(dl));
    assert.ok(dl <= Math.floor(Date.now() / 1000) + 600);
  });
});

describe("V3 router swap — pricing the impact", () => {
  it("values a token1 → token0 swap at the inverse price", async () => {
    /*-
     *  At 2 token1 per token0, 10000 token1 should buy 5000 token0. A
     *  quote of 5000 is no impact at all; read at the forward price it
     *  would look like 75%.
     */
    const seen = fresh();
    await swapViaRouter(
      mockSigner(),
      routerLib(() => 5000n, seen),
      base({ isToken0To1: false, currentPrice: 2.0 }),
      diff(seen),
    );
    assert.equal(seen.sent.length, 1);
  });

  it("aborts a token1 → token0 swap whose quote falls short of the inverse price", async () => {
    const seen = fresh();
    await assert.rejects(
      swapViaRouter(
        mockSigner(),
        routerLib(() => 4000n, seen),
        base({ isToken0To1: false, currentPrice: 2.0 }),
        diff(seen),
      ),
      /price impact 20\.0%/,
    );
  });

  it("measures no impact without a price, and still floors the output", async () => {
    /*-
     *  With no spot price there is nothing to measure impact against, so
     *  the check passes; the minimum output still comes from the on-chain
     *  quote, which is what bounds the swap.
     */
    const seen = fresh();
    await swapViaRouter(
      mockSigner(),
      routerLib(() => 8000n, seen),
      base({ currentPrice: 0 }),
      diff(seen),
    );
    assert.equal(seen.sent[0].amountOutMinimum, (8000n * 9950n) / 10000n);
  });

  it("names a failed quote as such, keeping the router's own error", async () => {
    const seen = fresh();
    const cause = new Error("execution reverted: SPL");
    await assert.rejects(
      swapViaRouter(
        mockSigner(),
        routerLib(() => {
          throw cause;
        }, seen),
        base(),
        diff(seen),
      ),
      (err) => {
        assert.equal(err.message, "Swap quote failed: execution reverted: SPL");
        assert.equal(err.cause, cause);
        return true;
      },
    );
    assert.equal(seen.sent.length, 0);
  });

  it("refuses to swap in a pool with no liquidity", async () => {
    const seen = fresh();
    await assert.rejects(
      swapViaRouter(
        mockSigner(),
        routerLib(() => 0n, seen),
        base(),
        diff(seen),
      ),
      /Swap aborted: no pool liquidity\./,
    );
    assert.equal(seen.sent.length, 0);
  });
});
