/**
 * @file test/epoch-reconstructor-helpers.test.js
 * @description Tests for internal helpers exported from epoch-reconstructor.js:
 *   _cacheKeyFromState, _mergeAndPersist, _hasValidTimestamps, _assembleEpoch,
 *   and early-return paths of reconstructEpochs.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  _cacheKeyFromState,
  _mergeAndPersist,
  _hasValidTimestamps,
  _assembleEpoch,
  reconstructEpochs,
} = require("../src/epoch-reconstructor");

// ── _hasValidTimestamps ─────────────────────────────────────────────

describe("_hasValidTimestamps", () => {
  it("returns true when mintDate is present", () => {
    assert.strictEqual(_hasValidTimestamps({ mintDate: "2026-01-01" }), true);
  });

  it("returns true when closeDate is present", () => {
    assert.strictEqual(_hasValidTimestamps({ closeDate: "2026-01-02" }), true);
  });

  it("returns true when both are present", () => {
    assert.strictEqual(
      _hasValidTimestamps({
        mintDate: "2026-01-01",
        closeDate: "2026-01-02",
      }),
      true,
    );
  });

  it("returns false when both are null", () => {
    assert.strictEqual(
      _hasValidTimestamps({ mintDate: null, closeDate: null }),
      false,
    );
  });

  it("returns false when both are undefined", () => {
    assert.strictEqual(_hasValidTimestamps({}), false);
  });

  it("returns false for empty strings", () => {
    assert.strictEqual(
      _hasValidTimestamps({ mintDate: "", closeDate: "" }),
      false,
    );
  });
});

// ── _cacheKeyFromState ──────────────────────────────────────────────

describe("_cacheKeyFromState", () => {
  it("builds cache key from bot state with activePosition", () => {
    const state = {
      activePosition: {
        token0: "0xA",
        token1: "0xB",
        fee: 3000,
      },
      positionManager: "0xPM",
      walletAddress: "0xW",
    };
    const key = _cacheKeyFromState(state);
    assert.deepStrictEqual(key, {
      contract: "0xPM",
      wallet: "0xW",
      token0: "0xA",
      token1: "0xB",
      fee: 3000,
    });
  });

  it("returns null when no activePosition", () => {
    assert.strictEqual(_cacheKeyFromState({}), null);
    assert.strictEqual(_cacheKeyFromState({ activePosition: null }), null);
  });

  it("returns null when token0 is missing", () => {
    const state = {
      activePosition: { token1: "0xB", fee: 500 },
    };
    assert.strictEqual(_cacheKeyFromState(state), null);
  });

  it("returns null when token1 is missing", () => {
    const state = {
      activePosition: { token0: "0xA", fee: 500 },
    };
    assert.strictEqual(_cacheKeyFromState(state), null);
  });

  it("uses empty strings for missing manager/wallet", () => {
    const state = {
      activePosition: { token0: "0xA", token1: "0xB", fee: 100 },
    };
    const key = _cacheKeyFromState(state);
    assert.strictEqual(key.contract, "");
    assert.strictEqual(key.wallet, "");
  });
});

// ── _assembleEpoch ──────────────────────────────────────────────────

describe("_assembleEpoch", () => {
  it("assembles a complete epoch object", () => {
    const h = {
      mintDate: "2026-02-01T12:00:00Z",
      closeDate: "2026-02-03T18:30:00Z",
      entryValueUsd: 400,
      exitValueUsd: 380,
      feesEarnedUsd: 5,
      gasCostUsd: 1.5,
      gasNative: 0.003,
      entryAmount0: 1000,
      entryAmount1: 2000,
      token0UsdPriceAtOpen: 0.2,
      token1UsdPriceAtOpen: 0.1,
      token0UsdPriceAtClose: 0.19,
      token1UsdPriceAtClose: 0.1,
    };
    const ep = _assembleEpoch(h, 3);
    assert.strictEqual(ep.id, 4);
    assert.strictEqual(ep.entryValue, 400);
    assert.strictEqual(ep.exitValue, 380);
    assert.strictEqual(ep.fees, 5);
    assert.strictEqual(ep.gas, 1.5);
    assert.strictEqual(ep.gasNative, 0.003);
    assert.strictEqual(ep.hodlAmount0, 1000);
    assert.strictEqual(ep.hodlAmount1, 2000);
    assert.strictEqual(ep.token0UsdEntry, 0.2);
    assert.strictEqual(ep.token1UsdExit, 0.1);
    assert.strictEqual(ep.status, "closed");
    // epochPnl = exit - entry + fees - gas = 380 - 400 + 5 - 1.5 = -16.5
    assert.strictEqual(ep.epochPnl, -16.5);
    // priceChangePnl = exit - entry - fees = 380 - 400 - 5 = -25
    assert.strictEqual(ep.priceChangePnl, -25);
    assert.strictEqual(ep.feePnl, 5);
    assert.strictEqual(ep.il, 0);
    assert.strictEqual(ep.entryPrice, 0);
    assert.strictEqual(ep.lowerPrice, 0);
    assert.strictEqual(ep.upperPrice, 0);
  });

  it("handles missing optional fields with defaults", () => {
    const h = {
      mintDate: "2026-01-01T00:00:00Z",
      closeDate: null,
      entryValueUsd: null,
      exitValueUsd: 0,
      feesEarnedUsd: null,
    };
    const ep = _assembleEpoch(h, 0);
    assert.strictEqual(ep.entryValue, 0);
    assert.strictEqual(ep.exitValue, 0);
    assert.strictEqual(ep.fees, 0);
    assert.strictEqual(ep.gas, 0);
    assert.strictEqual(ep.gasNative, 0);
    assert.strictEqual(ep.closeTime, ep.openTime); // closeDate null → fallback
    assert.strictEqual(ep.hodlAmount0, 0);
    assert.strictEqual(ep.hodlAmount1, 0);
    assert.strictEqual(ep.token0UsdEntry, 0);
    assert.strictEqual(ep.token1UsdEntry, 0);
  });

  it("wraps colour index correctly", () => {
    const h = {
      mintDate: "2026-01-01T00:00:00Z",
      closeDate: "2026-01-02T00:00:00Z",
      exitValueUsd: 100,
    };
    // Index 11 → 11 % 10 = 1 → "#ff6b35"
    assert.strictEqual(_assembleEpoch(h, 11).color, "#ff6b35");
    // Index 20 → 20 % 10 = 0 → "#00e5ff"
    assert.strictEqual(_assembleEpoch(h, 20).color, "#00e5ff");
  });
});

// ── _mergeAndPersist ────────────────────────────────────────────────

describe("_mergeAndPersist", () => {
  /** Create a minimal tracker mock. */
  function mockTracker() {
    let _data = null;
    return {
      restore: (d) => {
        _data = d;
      },
      getData: () => _data,
      serialize: () => _data,
    };
  }

  it("sorts epochs by openTime and reassigns ids", () => {
    const tracker = mockTracker();
    const epochs = [
      { openTime: 300, id: 99 },
      { openTime: 100, id: 88 },
      { openTime: 200, id: 77 },
    ];
    _mergeAndPersist(tracker, epochs, null, null, null);
    assert.strictEqual(epochs[0].openTime, 100);
    assert.strictEqual(epochs[0].id, 1);
    assert.strictEqual(epochs[1].openTime, 200);
    assert.strictEqual(epochs[1].id, 2);
    assert.strictEqual(epochs[2].openTime, 300);
    assert.strictEqual(epochs[2].id, 3);
  });

  it("restores tracker with sorted epochs and liveEpoch", () => {
    const tracker = mockTracker();
    const live = { id: 10, status: "open" };
    _mergeAndPersist(tracker, [{ openTime: 1 }], live, null, null);
    const data = tracker.getData();
    assert.deepStrictEqual(data.closedEpochs, [{ openTime: 1, id: 1 }]);
    assert.strictEqual(data.liveEpoch, live);
  });

  it("calls updateBotState when provided", () => {
    const tracker = mockTracker();
    let patch = null;
    const updateBotState = (p) => {
      patch = p;
    };
    _mergeAndPersist(tracker, [{ openTime: 1 }], null, updateBotState, null);
    assert.ok(patch);
    assert.ok(patch.pnlEpochs);
  });

  it("does not call updateBotState when null", () => {
    const tracker = mockTracker();
    // Should not throw
    _mergeAndPersist(tracker, [{ openTime: 1 }], null, null, null);
  });
});

// ── reconstructEpochs early returns ─────────────────────────────────

describe("reconstructEpochs early returns", () => {
  it("returns 0 when pnlTracker is null", async () => {
    const r = await reconstructEpochs({
      pnlTracker: null,
      rebalanceEvents: [{ oldTokenId: "1", newTokenId: "2" }],
      botState: {},
    });
    assert.strictEqual(r, 0);
  });

  it("returns 0 when rebalanceEvents is empty", async () => {
    const tracker = {
      serialize: () => ({ closedEpochs: [] }),
    };
    const r = await reconstructEpochs({
      pnlTracker: tracker,
      rebalanceEvents: [],
      botState: {},
    });
    assert.strictEqual(r, 0);
  });

  it("returns 0 when rebalanceEvents is null", async () => {
    const tracker = {
      serialize: () => ({ closedEpochs: [] }),
    };
    const r = await reconstructEpochs({
      pnlTracker: tracker,
      rebalanceEvents: null,
      botState: {},
    });
    assert.strictEqual(r, 0);
  });

  it("returns 0 when tracker already has closed epochs", async () => {
    const tracker = {
      serialize: () => ({ closedEpochs: [{ id: 1 }] }),
    };
    const r = await reconstructEpochs({
      pnlTracker: tracker,
      rebalanceEvents: [{ oldTokenId: "1", newTokenId: "2" }],
      botState: {},
    });
    assert.strictEqual(r, 0);
  });

  it("returns 0 when no valid closedIds in events", async () => {
    const tracker = {
      serialize: () => ({ closedEpochs: [] }),
    };
    const r = await reconstructEpochs({
      pnlTracker: tracker,
      rebalanceEvents: [
        { oldTokenId: "?", newTokenId: "2" },
        { oldTokenId: null, newTokenId: "3" },
        { newTokenId: "4" },
      ],
      botState: {},
    });
    assert.strictEqual(r, 0);
  });
});
