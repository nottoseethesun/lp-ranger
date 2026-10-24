/**
 * @file test/bot-recorder-baseline.test.js
 * @description The HODL baseline a rebalance starts
 *   (`updateHodlBaseline`, src/lib/bot-recorder-baseline.js): its mint gas,
 *   and the decimals it reads the minted amounts with.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("assert");
const { updateHodlBaseline } = require("../src/lib/bot-recorder-baseline");
const { log } = require("../src/lib/log");

const MINTED = {
  amount0Minted: 1000n,
  amount1Minted: 2000n,
  decimals0: 8,
  decimals1: 8,
  token0UsdPrice: 1,
  token1UsdPrice: 1,
};

describe("updateHodlBaseline mintGasWei", () => {
  it("preserves mintGasWei from rebalance result", () => {
    const botState = {};
    updateHodlBaseline(
      botState,
      { ...MINTED, mintGasCostWei: 500000000000000n },
      "2026-04-05T12:00:00Z",
    );
    assert.equal(botState.hodlBaseline.mintGasWei, "500000000000000");
  });

  it("sets mintGasWei to 0 when missing from result", () => {
    const botState = {};
    updateHodlBaseline(botState, MINTED, "2026-04-05T12:00:00Z");
    assert.equal(botState.hodlBaseline.mintGasWei, "0");
  });
});

describe("updateHodlBaseline decimals", () => {
  it("reads the minted amounts at the result's decimals, saying nothing", (t) => {
    const warn = t.mock.method(log, "warn", () => {});
    const botState = {};
    updateHodlBaseline(botState, MINTED, "2026-04-05T12:00:00Z");
    assert.equal(botState.hodlBaseline.hodlAmount0, 1000 / 1e8);
    assert.equal(botState.hodlBaseline.hodlAmount1, 2000 / 1e8);
    assert.equal(warn.mock.callCount(), 0);
  });

  it("assumes 18 for a token the result names no decimals for, and says so", (t) => {
    const lines = [];
    t.mock.method(log, "warn", (...args) => lines.push(args.join(" ")));
    const botState = {};
    updateHodlBaseline(
      botState,
      { ...MINTED, decimals1: undefined, newTokenId: 4242n },
      "2026-04-05T12:00:00Z",
    );
    assert.equal(botState.hodlBaseline.hodlAmount1, 2000 / 1e18);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /4242/);
    assert.match(lines[0], /token1/);
    assert.match(lines[0], /HODL baseline/);
  });
});
