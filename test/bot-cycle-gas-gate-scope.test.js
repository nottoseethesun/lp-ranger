/**
 * @file test/bot-cycle-gas-gate-scope.test.js
 * @description The gas gate decides on fresh prices, not cached ones.
 *
 * `_isGasTooHigh` refuses a rebalance whose gas would exceed 0.5% of the
 * position's value. It defers only when BOTH figures are above zero, so
 * an unresolved price makes the comparison silently pass and an
 * uneconomic rebalance proceeds.
 *
 * Prices can be unresolved at exactly that moment. The idle pause makes
 * `fetchTokenPriceUsd` answer from cache with no age limit — or with `0`
 * on a process that has never fetched, which is every headless
 * `npm run bot` start, since it pauses at startup and only browser
 * activity lifts the pause.
 *
 * So the gate belongs inside the same `withFreshPricesAllowed` scope as
 * the move it guards. These tests pin that: the gate's own price reads
 * must happen with the scope open.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

/**
 * Load `bot-cycle` with the price gate and gas estimator stubbed.
 *
 * Records whether the fresh-prices scope was open at the moment the gas
 * gate read its numbers — which is the whole property under test.
 *
 * @param {number} gasUsd    What the gas estimate answers.
 * @param {number} posValue  What the position is worth.
 */
function loadWithProbe(gasUsd, posValue) {
  const Module = require("module");
  const orig = Module.prototype.require;
  const probe = { scopeOpenAtGasCheck: null, invalidated: false };
  let scopeOpen = false;
  Module.prototype.require = function (id) {
    if (id === "./price-fetcher")
      return {
        invalidatePriceCacheFor: () => {
          probe.invalidated = true;
        },
        withFreshPricesAllowed: async (fn) => {
          scopeOpen = true;
          try {
            return await fn();
          } finally {
            scopeOpen = false;
          }
        },
      };
    if (id !== "./bot-pnl-updater") return orig.apply(this, arguments);
    const real = orig.apply(this, arguments);
    return {
      ...real,
      estimateGasCostUsd: async () => {
        probe.scopeOpenAtGasCheck = scopeOpen;
        return gasUsd;
      },
      fetchTokenPrices: async () => ({ price0: 1, price1: 1 }),
      positionValueUsd: () => posValue,
    };
  };
  try {
    delete require.cache[require.resolve("../src/bot-cycle")];
    const mod = require("../src/bot-cycle");
    /*- Evicted again so the stubbed copy is not handed to whoever
     *  requires this module next. */
    delete require.cache[require.resolve("../src/bot-cycle")];
    return { mod, probe };
  } finally {
    Module.prototype.require = orig;
  }
}

/*- `forceRebalance` is what carries the fixture past the range and
 *  throttle checks — it is the manual-rebalance path, and the only one
 *  that reaches the gas decision without a fixture that also has to
 *  satisfy the OOR threshold in price terms. The gas gate itself is NOT
 *  bypassed by it, which is what makes it usable here. */
const deps = () => ({
  position: {
    token0: "0xA",
    token1: "0xB",
    tickLower: -100,
    tickUpper: 100,
    liquidity: 1n,
  },
  provider: {},
  _botState: { forceRebalance: true },
  _getConfig: () => undefined,
});
const poolState = { tick: 0, decimals0: 18, decimals1: 18 };

describe("the gas gate decides inside the fresh-prices scope", () => {
  it("reads its prices with the scope open", async () => {
    /*- The property. With the gate outside the scope it read through
     *  the idle pause: a cached price of any age, or none at all. */
    const { mod, probe } = loadWithProbe(50, 100); // 50% — defers
    const r = await mod._runRangeAndExec(
      deps(),
      {},
      poolState,
      () => {},
      false,
      {},
    );
    assert.equal(r.gasDeferred, true, "50% of position value must defer");
    assert.equal(
      probe.scopeOpenAtGasCheck,
      true,
      "the gas gate must not read prices through the idle pause",
    );
  });

  it("drops the cached price for this position first", async () => {
    /*- Opening the scope lifts the pause but leaves a short cache TTL,
     *  so without the invalidation the gate can still be answered from
     *  a cached value rather than a fetched one. */
    const { mod, probe } = loadWithProbe(50, 100);
    await mod._runRangeAndExec(deps(), {}, poolState, () => {}, false, {});
    assert.equal(probe.invalidated, true);
  });

  it("still carries a completed compound back with the deferral", async () => {
    /*- A compound that already happened this cycle must be reported
     *  even when the rebalance is then deferred on gas — the two are
     *  independent outcomes of one poll. */
    const { mod } = loadWithProbe(50, 100);
    const r = await mod._runRangeAndExec(
      deps(),
      {},
      poolState,
      () => {},
      true,
      {},
    );
    assert.equal(r.gasDeferred, true);
    assert.equal(r.compounded, true);
  });
});
