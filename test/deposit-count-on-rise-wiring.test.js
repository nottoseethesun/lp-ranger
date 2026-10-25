/**
 * @file test/deposit-count-on-rise-wiring.test.js
 * @description Every poll hands the wallet's coins to the deposit count
 *   before it works out the figures (`updatePnlAndStats`,
 *   src/lib/bot-pnl-updater.js), and the bot loop hands every poll that
 *   count (src/lib/bot-loop.js).
 *
 *   A poll already reads the wallet's two coins for the Wallet Residual.
 *   When they have risen since the last poll, the deposit count runs
 *   (src/lib/deposit-count.js), and what it finds must be in that poll's own
 *   Lifetime figures: coins that arrived are credited to the position
 *   there at once, so a deposit counted a poll later would read as a gain
 *   until then.
 *
 *   The loop has no fixture of its own, so its one line is pinned by
 *   reading the source, as test/one-move-at-a-time.test.js pins the lock.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
// Before anything that reads a price loads: prices come from a fixed table.
require("./helpers/price-stand-ins");
const { _poll } = require("./_bot-loop-helpers");
const { createPnlTracker } = require("../src/lib/pnl-tracker");
const { _resetForTest } = require("../src/lib/gecko-rate-limit");

let _originalFetch;
beforeEach(() => {
  _originalFetch = globalThis.fetch;
  _resetForTest();
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
});
afterEach(() => {
  globalThis.fetch = _originalFetch;
});

/** A tracker with one open period, as a running position has. */
function tracker() {
  const t = createPnlTracker({ initialDeposit: 2 });
  t.openEpoch({
    entryValue: 2,
    entryPrice: 1,
    lowerPrice: 0.8,
    upperPrice: 1.2,
    token0UsdPrice: 1,
    token1UsdPrice: 1,
  });
  return t;
}

describe("a poll's deposit count", () => {
  it("gets the wallet's two coins, and its find is in that poll's figures", async () => {
    const seen = [];
    const botState = {
      hodlBaseline: { hodlAmount0: 1, hodlAmount1: 1 },
      lifetimeHodlAmounts: {
        amount0: 1,
        amount1: 1,
        lastBlock: 0,
        deposits: [],
      },
    };
    // The count finds one coin of token0 deposited after the mint.
    const countDepositsOnRise = async (deps, wallet) => {
      seen.push(wallet);
      deps._botState._depositOverlay = {
        through: 10,
        entries: [
          {
            raw0: String(10n ** 18n),
            raw1: "0",
            block: 5,
            kind: "fresh",
            txHash: "0xfound",
          },
        ],
      };
    };
    const { captured } = await _poll(0, {
      botState,
      tracker: tracker(),
      captureState: true,
      extraDeps: { _countDepositsOnRise: countDepositsOnRise },
    });
    assert.equal(seen.length, 1);
    assert.equal(typeof seen[0].raw0, "bigint");
    assert.equal(typeof seen[0].raw1, "bigint");
    assert.equal(captured.pnlSnapshot.ilInputs.lt.hodlAmount0, 2);
    /*- The Current IL/G counts no coin in the wallet, so no deposit
     *  either (src/lib/bot-pnl-il.js). */
    assert.equal(captured.pnlSnapshot.ilInputs.cur.hodlAmount0, 1);
  });
});

describe("the bot loop", () => {
  it("hands every poll the deposit count", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "src", "lib", "bot-loop.js"),
      "utf8",
    );
    assert.match(src, /_countDepositsOnRise: countDepositsOnRise,/);
  });
});
