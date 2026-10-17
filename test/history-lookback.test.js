/**
 * @file test/history-lookback.test.js
 * @description `src/history-lookback.js` answers how far back a scan of a
 * pool's past reaches: `historyLookbackYears` from bot-config-defaults.json,
 * turned into blocks at the active chain's `blockTimeSec` in chains.json.
 * The expected figures here are worked out from those two settings
 * directly, so a wrong conversion in the module cannot agree with itself.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const config = require("../src/config");
const SHIPPED = require("../app-config/app-defaults-for-user-configurable/bot-config-defaults.json");
const {
  BLOCKS_PER_YEAR,
  LOOKBACK_YEARS,
  historyFloorBlock,
} = require("../src/history-lookback");

const YEAR_SEC = 365.25 * 24 * 3600;

describe("history lookback", () => {
  it("counts a year of blocks at the chain's own block time", () => {
    assert.equal(
      BLOCKS_PER_YEAR,
      Math.round(YEAR_SEC / config.CHAIN.blockTimeSec),
    );
  });

  it("reaches back the shipped historyLookbackYears", () => {
    assert.equal(LOOKBACK_YEARS, SHIPPED.historyLookbackYears);
    const head = 40_000_000;
    const blocks = Math.round(
      (SHIPPED.historyLookbackYears * YEAR_SEC) / config.CHAIN.blockTimeSec,
    );
    assert.equal(historyFloorBlock(head), head - blocks);
  });

  it("takes another number of years when asked", () => {
    const head = 40_000_000;
    assert.equal(
      historyFloorBlock(head, 2),
      head - Math.round(2 * BLOCKS_PER_YEAR),
    );
  });

  it("never reaches below block 0 on a chain younger than the lookback", () => {
    assert.equal(historyFloorBlock(1_000), 0);
  });
});
