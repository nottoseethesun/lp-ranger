/**
 * @file test/history-lookback.test.js
 * @description `src/history-lookback.js` answers how far back a scan of a
 * pool's past reaches: `historyLookbackYears` from bot-config-defaults.json,
 * turned into blocks at the active chain's `blockTimeSec` in chains.json.
 *
 * Both settings are an operator's own here, three years at twelve seconds
 * a block rather than the five years at ten that ship, and the expected
 * figures are written out from them, so a wrong conversion in the module,
 * or one that read the shipped figures, fails.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { makeTestTempFolder } = require("../src/test-temp-folders");
const SHIPPED_CHAINS = require("../app-config/app-defaults-for-user-configurable/chains.json");

const SETTINGS_DIR = makeTestTempFolder("lookback-settings");
fs.writeFileSync(
  path.join(SETTINGS_DIR, "chains.json"),
  JSON.stringify(
    Object.fromEntries(
      Object.keys(SHIPPED_CHAINS).map((chain) => [chain, { blockTimeSec: 12 }]),
    ),
  ),
);
fs.writeFileSync(
  path.join(SETTINGS_DIR, "bot-config-defaults.json"),
  JSON.stringify({ historyLookbackYears: 3 }),
);
process.env.LP_RANGER_USER_CONFIG_DIR = SETTINGS_DIR;

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  BLOCKS_PER_YEAR,
  LOOKBACK_YEARS,
  historyFloorBlock,
} = require("../src/history-lookback");

describe("history lookback", () => {
  it("counts a year of blocks at the chain's own block time", () => {
    // 365.25 days of 86,400 seconds, at twelve seconds a block.
    assert.equal(BLOCKS_PER_YEAR, 2_629_800);
  });

  it("reaches back the configured historyLookbackYears", () => {
    assert.equal(LOOKBACK_YEARS, 3);
    // Three years of 2,629,800 blocks back from the head.
    assert.equal(historyFloorBlock(40_000_000), 32_110_600);
  });

  it("takes another number of years when asked", () => {
    assert.equal(historyFloorBlock(40_000_000, 2), 34_740_400);
  });

  it("never reaches below block 0 on a chain younger than the lookback", () => {
    assert.equal(historyFloorBlock(1_000), 0);
  });
});
