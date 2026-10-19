/**
 * @file src/history-lookback.js
 * @module historyLookback
 * @description
 * Where a scan of a pool's past begins.
 *
 * The lookback is `historyLookbackYears` in bot-config-defaults.json,
 * turned into blocks at the active chain's `blockTimeSec` in chains.json,
 * so it is the same length of time on every chain. Every scan that walks
 * history back from the chain head asks this module: the rebalance
 * history scan in `src/event-scanner.js`, and the closed-position reads
 * in `src/position-history-scan-helpers.js` and
 * `src/position-history-mint.js`. One answer means those reads cannot
 * disagree about where a pool's history starts.
 *
 * Each caller still raises the floor to the pool's creation block when
 * it knows it; this module only answers how far back is far enough.
 */

"use strict";

const config = require("./config");
const { readBotConfigDefaults } = require("./bot-config-defaults");

// Blocks per year on the active chain: 3,155,760 at ten seconds a block.
const BLOCKS_PER_YEAR = Math.round(
  (365.25 * 24 * 3600) / config.CHAIN.blockTimeSec,
);

// The configured lookback, in years.
const LOOKBACK_YEARS = readBotConfigDefaults().historyLookbackYears;

/**
 * The earliest block a history scan reaches back to from `latestBlock`.
 *
 * @param {number} latestBlock  The chain head the scan starts from.
 * @param {number} [years]      Lookback in years; the configured one
 *   when omitted.
 * @returns {number} The floor block, never below 0.
 */
function historyFloorBlock(latestBlock, years = LOOKBACK_YEARS) {
  return Math.max(0, latestBlock - Math.round(years * BLOCKS_PER_YEAR));
}

module.exports = { BLOCKS_PER_YEAR, LOOKBACK_YEARS, historyFloorBlock };
