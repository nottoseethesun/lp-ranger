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
 *   src/bot-cycle.js) is driven here with the rebalance itself and the
 *   recorder's writes stood in for, and the alert it sends is captured.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const REBALANCER = require.resolve("../src/rebalancer");
const RECORDER = require.resolve("../src/bot-recorder");
const TELEGRAM = require.resolve("../src/telegram-notifications/telegram");
const PNL = require.resolve("../src/bot-pnl-updater");
const CYCLE = require.resolve("../src/bot-cycle");

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
    const out = await _executeAndRecord(
      {
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
        _getConfig: () => undefined,
        updateBotState: () => {},
      },
      {},
    );
    assert.equal(out.rebalanced, true);
    const success = alerts.filter((a) => a.type === "rebalanceSuccess");
    assert.equal(success.length, 1);
    assert.equal(success[0].details.txHash, "0xmint");
  });
});
