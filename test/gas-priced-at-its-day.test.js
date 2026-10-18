/**
 * @file test/gas-priced-at-its-day.test.js
 * @description What a gas charge is worth in dollars, and at which day's
 *   price.
 *
 *   Gas spent now (`actualGasCostUsd`) is priced at today's native price.
 *   A closed period's gas (`pastGasCostUsd`) is priced at the native
 *   price on the day it was spent, and only then: when that day's price
 *   cannot be read, the answer is null, which the Per-Day P&L table
 *   shows as a dash. Today's price would put a figure on the row that
 *   reads like a real one and is not what the gas cost.
 */

"use strict";

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

let actualGasCostUsd;
let pastGasCostUsd;
let _historicalAnswer;
let _currentAnswer;
let _historicalCalls;
let _currentCalls;

const _origRequire = Module.prototype.require;
const ONE_ETH_WEI = 1_000_000_000_000_000_000n;

before(() => {
  Module.prototype.require = function (id) {
    if (id === "./historical-token-price") {
      return {
        fetchHistoricalTokenPriceUsd: async (_token, opts) => {
          _historicalCalls.push(opts);
          if (_historicalAnswer instanceof Error) throw _historicalAnswer;
          return _historicalAnswer;
        },
      };
    }
    if (id === "./price-fetcher") {
      return {
        fetchTokenPriceUsd: async () => {
          _currentCalls++;
          return _currentAnswer;
        },
      };
    }
    return _origRequire.apply(this, arguments);
  };
  delete require.cache[require.resolve("../src/bot-pnl-updater")];
  ({ actualGasCostUsd, pastGasCostUsd } = require("../src/bot-pnl-updater"));
});

after(() => {
  Module.prototype.require = _origRequire;
  delete require.cache[require.resolve("../src/bot-pnl-updater")];
});

beforeEach(() => {
  _historicalAnswer = 0;
  _currentAnswer = 0;
  _historicalCalls = [];
  _currentCalls = 0;
});

const WHEN = Object.freeze({ timestamp: 1_760_000_000, blockNumber: 27_000_1 });

describe("actualGasCostUsd — gas spent now", () => {
  it("is priced at today's native price, with no past day to ask about", async () => {
    _currentAnswer = 0.00003;
    const usd = await actualGasCostUsd(ONE_ETH_WEI);
    assert.equal(usd, 0.00003);
    assert.equal(_historicalCalls.length, 0);
  });
});

describe("pastGasCostUsd — a closed period's gas", () => {
  it("uses the price of the day it was spent", async () => {
    _historicalAnswer = 0.00002;
    _currentAnswer = 0.00001; // deliberately different, so a mix-up shows
    const usd = await pastGasCostUsd(ONE_ETH_WEI, WHEN);
    assert.equal(usd, 0.00002);
  });

  it("has no figure when that day has no price, rather than today's", async () => {
    _historicalAnswer = 0;
    _currentAnswer = 0.00001;
    assert.equal(await pastGasCostUsd(ONE_ETH_WEI, WHEN), null);
    assert.equal(_currentCalls, 0, "today's price is never asked for");
  });

  it("has no figure when the price lookup fails", async () => {
    _historicalAnswer = new Error("rate limited");
    _currentAnswer = 0.00001;
    assert.equal(await pastGasCostUsd(ONE_ETH_WEI, WHEN), null);
  });

  it("passes the moment and the refresh flag through", async () => {
    _historicalAnswer = 0.00002;
    await pastGasCostUsd(ONE_ETH_WEI, { ...WHEN, refresh: true });
    assert.equal(_historicalCalls.length, 1);
    assert.equal(_historicalCalls[0].timestamp, WHEN.timestamp);
    assert.equal(_historicalCalls[0].blockNumber, WHEN.blockNumber);
    assert.equal(_historicalCalls[0].refresh, true);
  });

  it("defaults refresh to false rather than passing undefined", async () => {
    _historicalAnswer = 0.00002;
    await pastGasCostUsd(ONE_ETH_WEI, WHEN);
    assert.equal(_historicalCalls[0].refresh, false);
  });

  it("scales the price by the coins actually spent", async () => {
    _historicalAnswer = 2;
    const usd = await pastGasCostUsd(ONE_ETH_WEI / 2n, WHEN);
    assert.equal(usd, 1);
  });
});
