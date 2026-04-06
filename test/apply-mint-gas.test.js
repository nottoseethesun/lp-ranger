/**
 * @file test/apply-mint-gas.test.js
 * @description Tests for _applyMintGas in bot-pnl-updater.
 *   Split from compound-cycle.test.js for line-count compliance.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

describe("_applyMintGas", () => {
  it("adds mint gas to live epoch once", async () => {
    const { _applyMintGas } = require("../src/bot-pnl-updater");
    const { createPnlTracker } = require("../src/pnl-tracker");
    const tracker = createPnlTracker();
    tracker.openEpoch({
      entryValue: 1000,
      entryPrice: 0.001,
      lowerPrice: 0.0005,
      upperPrice: 0.002,
    });
    const deps = {
      _botState: {
        hodlBaseline: { mintGasWei: "15000000000000000" }, // 0.015 PLS
      },
    };
    // Mock actualGasCostUsd — it fetches WPLS price via DexScreener
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        pairs: [
          {
            priceUsd: "0.00001",
            chainId: "pulsechain",
            liquidity: { usd: 1000 },
          },
        ],
      }),
    });
    try {
      await _applyMintGas(deps, tracker);
      const snap = tracker.snapshot(0.001);
      assert.ok(snap.totalGas > 0, "gas should be added to epoch");
      assert.strictEqual(
        deps._botState._mintGasApplied,
        true,
        "flag should be on _botState",
      );

      // Second call should be a no-op
      const gasBefore = tracker.snapshot(0.001).totalGas;
      await _applyMintGas(deps, tracker);
      assert.strictEqual(
        tracker.snapshot(0.001).totalGas,
        gasBefore,
        "should not double-count",
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("skips when no mintGasWei in baseline", async () => {
    const { _applyMintGas } = require("../src/bot-pnl-updater");
    const { createPnlTracker } = require("../src/pnl-tracker");
    const tracker = createPnlTracker();
    tracker.openEpoch({
      entryValue: 1000,
      entryPrice: 0.001,
      lowerPrice: 0.0005,
      upperPrice: 0.002,
    });
    const deps = { _botState: { hodlBaseline: {} } };
    await _applyMintGas(deps, tracker);
    assert.strictEqual(
      tracker.snapshot(0.001).totalGas,
      0,
      "no gas should be added",
    );
  });

  it("skips when baseline is not yet set", async () => {
    const { _applyMintGas } = require("../src/bot-pnl-updater");
    const { createPnlTracker } = require("../src/pnl-tracker");
    const tracker = createPnlTracker();
    tracker.openEpoch({
      entryValue: 1000,
      entryPrice: 0.001,
      lowerPrice: 0.0005,
      upperPrice: 0.002,
    });
    const deps = { _botState: {} };
    await _applyMintGas(deps, tracker);
    assert.strictEqual(
      tracker.snapshot(0.001).totalGas,
      0,
      "no gas should be added",
    );
  });
});
