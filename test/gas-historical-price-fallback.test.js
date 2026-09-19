/**
 * @file test/gas-historical-price-fallback.test.js
 * @description What `actualGasCostUsd` does when the day it is asked
 *   about cannot be priced.
 *
 *   The answer matters more than it looks. `actualGasCostUsd` reports a
 *   failed lookup as `0`, and `_fetchEpochsFromChain` reads a zero USD
 *   on a non-zero wei amount as "price unknown" and withholds the whole
 *   epoch. So a historical source that cannot answer for one day would
 *   not cost that row its gas figure — it would cost the Per-Day table
 *   the row, and the history its completeness, which then has the
 *   rescan timer retrying every thirty minutes for the life of the
 *   process.
 *
 *   Falling back to the current price is therefore not a nicety. The
 *   figure is slightly off; the alternative is a vanished row and a scan
 *   that never settles.
 */

"use strict";

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

let actualGasCostUsd;
let _historicalAnswer;
let _currentAnswer;
let _historicalCalls;

const _origRequire = Module.prototype.require;
const ONE_ETH_WEI = 1_000_000_000_000_000_000n;

before(() => {
  Module.prototype.require = function (id) {
    if (id === "./historical-token-price") {
      return {
        fetchHistoricalTokenPriceUsd: async (_token, opts) => {
          _historicalCalls.push(opts);
          return _historicalAnswer;
        },
      };
    }
    if (id === "./price-fetcher") {
      return {
        fetchTokenPriceUsd: async () => _currentAnswer,
      };
    }
    return _origRequire.apply(this, arguments);
  };
  delete require.cache[require.resolve("../src/bot-pnl-updater")];
  ({ actualGasCostUsd } = require("../src/bot-pnl-updater"));
});

after(() => {
  Module.prototype.require = _origRequire;
  delete require.cache[require.resolve("../src/bot-pnl-updater")];
});

beforeEach(() => {
  _historicalAnswer = 0;
  _currentAnswer = 0;
  _historicalCalls = [];
});

const WHEN = Object.freeze({ timestamp: 1_760_000_000, blockNumber: 27_000_1 });

describe("actualGasCostUsd — pricing a charge at the day it was spent", () => {
  it("uses the historical price when there is one", async () => {
    _historicalAnswer = 0.00002;
    _currentAnswer = 0.00001; // deliberately different, so a mix-up shows
    const usd = await actualGasCostUsd(ONE_ETH_WEI, WHEN);
    assert.equal(usd, 0.00002);
  });

  it("falls back to today rather than reporting nothing", async () => {
    /*-
     *  The whole point. A zero here does not mean free gas — it is read
     *  upstream as an unpriceable charge and the epoch is dropped.
     */
    _historicalAnswer = 0;
    _currentAnswer = 0.00001;
    const usd = await actualGasCostUsd(ONE_ETH_WEI, WHEN);
    assert.equal(usd, 0.00001, "a priced-at-today row beats no row");
  });

  it("does not consult the historical source without a moment", async () => {
    /*-
     *  Live gas — a rebalance or compound happening now. There is no
     *  past day to ask about, and the current price IS its historical
     *  price.
     */
    _currentAnswer = 0.00003;
    const usd = await actualGasCostUsd(ONE_ETH_WEI);
    assert.equal(usd, 0.00003);
    assert.equal(_historicalCalls.length, 0);
  });

  it("passes the moment and the refresh flag through", async () => {
    _historicalAnswer = 0.00002;
    await actualGasCostUsd(ONE_ETH_WEI, { ...WHEN, refresh: true });
    assert.equal(_historicalCalls.length, 1);
    assert.equal(_historicalCalls[0].timestamp, WHEN.timestamp);
    assert.equal(_historicalCalls[0].blockNumber, WHEN.blockNumber);
    assert.equal(_historicalCalls[0].refresh, true);
  });

  it("defaults refresh to false rather than passing undefined", async () => {
    _historicalAnswer = 0.00002;
    await actualGasCostUsd(ONE_ETH_WEI, WHEN);
    assert.equal(_historicalCalls[0].refresh, false);
  });

  it("still answers zero when nothing at all can price it", async () => {
    /*-
     *  Both sources empty. Zero is then the honest answer, and the
     *  epoch guard upstream is right to withhold the row rather than
     *  record gas that cost nothing.
     */
    const usd = await actualGasCostUsd(ONE_ETH_WEI, WHEN);
    assert.equal(usd, 0);
  });

  it("scales the price by the coins actually spent", async () => {
    _historicalAnswer = 2;
    const usd = await actualGasCostUsd(ONE_ETH_WEI / 2n, WHEN);
    assert.equal(usd, 1);
  });
});
