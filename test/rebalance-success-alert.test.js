"use strict";

/**
 * @file test/rebalance-success-alert.test.js
 * @description The Telegram alert for a successful rebalance names the
 *   mint's transaction.
 *
 *   A rebalance's result lists its transactions in the order they were
 *   sent, the mint last. The alert read the list as if it were an object
 *   with a `mint` field, found nothing there, and so never wrote its
 *   "TX:" line. The rebalance cycle (`_executeAndRecord`,
 *   src/lib/bot-cycle.js) is driven here with the rebalance itself and the
 *   recorder's writes stood in for, and the alert it sends is captured.
 *
 *   The same cycle stores the rebalance's Activity Log figure the moment
 *   it succeeds, before the rebalance log is written, and hands it on to
 *   the bot's own record of the event and to the pool's event cache; the
 *   records it writes are captured too.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const REBALANCER = require.resolve("../src/lib/rebalancer");
const RECORDER = require.resolve("../src/lib/bot-recorder");
const TELEGRAM = require.resolve("../src/lib/telegram-notifications/telegram");
const PNL = require.resolve("../src/lib/bot-pnl-updater");
const CYCLE = require.resolve("../src/lib/bot-cycle");

/**
 * Load the cycle with chosen exports of its dependencies replaced, then
 * put the real exports back, as test/spent-gas.test.js does.
 */
function loadCycleWith(stand) {
  const saved = {};
  for (const [p, over] of Object.entries(stand)) {
    const real = require(p);
    saved[p] = require.cache[p].exports;
    require.cache[p].exports = { ...real, ...over };
  }
  delete require.cache[CYCLE];
  try {
    return require(CYCLE);
  } finally {
    for (const p of Object.keys(saved)) require.cache[p].exports = saved[p];
    delete require.cache[CYCLE];
  }
}

/**
 * The cycle's view of one position, with its saved settings.
 * @param {object} [settings]  The position's settings, by key.
 */
function cycleDeps(settings = {}) {
  return {
    signer: { getAddress: async () => "0x" + "11".repeat(20) },
    position: {
      tokenId: "42",
      token0: "0x" + "aa".repeat(20),
      token1: "0x" + "bb".repeat(20),
      fee: 3000,
      liquidity: "5000",
      tickLower: -600,
      tickUpper: 600,
    },
    throttle: {
      recordRebalance() {},
      getState: () => ({ dailyCount: 1 }),
    },
    _botState: {},
    _getConfig: (key) => settings[key],
    updateBotState: () => {},
  };
}

describe("the rebalance-succeeded alert", () => {
  it("names the mint's transaction, the last of the rebalance's", async () => {
    const alerts = [];
    const { _executeAndRecord } = loadCycleWith({
      [REBALANCER]: {
        executeRebalance: async () => ({
          success: true,
          newTokenId: 43n,
          oldTokenId: 42n,
          txHashes: ["0xdrain", "0xswap", "0xmint"],
          gasCostWei: 0n,
        }),
        enrichResultUsd: async () => {},
      },
      [RECORDER]: {
        appendLog: () => {},
        _closePnlEpoch: async () => {},
        _recordResidual: () => {},
        _applyRebalanceResult: () => {},
      },
      [PNL]: { fetchTokenPrices: async () => ({ price0: 1, price1: 1 }) },
      [TELEGRAM]: {
        notify: (type, details) => alerts.push({ type, details }),
      },
    });
    const out = await _executeAndRecord(cycleDeps(), {});
    assert.equal(out.rebalanced, true);
    const success = alerts.filter((a) => a.type === "rebalanceSuccess");
    assert.equal(success.length, 1);
    assert.equal(success[0].details.txHash, "0xmint");
  });
});

describe("the Activity Log figures of a successful rebalance", () => {
  /*-
   *  The wallet held 1,100 and 50 after the drain and 600 and 545 before
   *  the mint: at $1 each, the swaps cost $5 of the $1,145 left.
   */
  const READINGS = Object.freeze({
    beforeDrain: { amount0: 100, amount1: 50 },
    afterDrain: { amount0: 1100, amount1: 50 },
    beforeMint: { amount0: 600, amount1: 545 },
  });
  const PCT = ((1145 - 1150) / 1145) * 100;

  it("are stored before the rebalance log is written, and handed on", async () => {
    const logged = [];
    const applied = [];
    const { _executeAndRecord } = loadCycleWith({
      [REBALANCER]: {
        executeRebalance: async () => ({
          success: true,
          newTokenId: 43n,
          oldTokenId: 42n,
          txHashes: ["0xdrain", "0xmint"],
          blockNumber: 1000,
          gasCostWei: 0n,
          walletReadings: READINGS,
        }),
        // The prices fetched after the mint, with none for token0.
        enrichResultUsd: async (result) => {
          result.token0UsdPrice = 0;
          result.token1UsdPrice = 1;
        },
      },
      [RECORDER]: {
        appendLog: (result) => logged.push(structuredClone(result)),
        _closePnlEpoch: async () => {},
        _recordResidual: () => {},
        _applyRebalanceResult: (_deps, result) => applied.push(result),
      },
      [PNL]: { fetchTokenPrices: async () => ({ price0: 1, price1: 1 }) },
      [TELEGRAM]: { notify: () => {} },
    });
    // The operator's own price for token0 stands in, as on the panels.
    const out = await _executeAndRecord(cycleDeps({ priceOverride0: 1 }), {});
    assert.equal(out.rebalanced, true);
    // The log entry, the bot's event, and the event cache's entry.
    for (const record of [logged[0], applied[0], out]) {
      assert.deepEqual(record.walletReadings, READINGS);
      assert.ok(
        Math.abs(record.historical.impermanentLossGainPct - PCT) < 1e-9,
        JSON.stringify(record.historical),
      );
      assert.equal(record.figuresDue, true);
    }
  });
});
