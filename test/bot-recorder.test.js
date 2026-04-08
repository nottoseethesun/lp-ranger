/**
 * @file test/bot-recorder.test.js
 * @description Unit tests for pure helper functions in bot-recorder.js:
 *   _bigIntReplacer, _activePosSummary, _updateHodlBaseline,
 *   _collectTokenIds, _pushRebalanceEvent, _recordResidual,
 *   appendLog, and _notifyRebalance.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  _bigIntReplacer,
  _activePosSummary,
  _updateHodlBaseline,
  _collectTokenIds,
  _pushRebalanceEvent,
  _recordResidual,
  _notifyRebalance,
} = require("../src/bot-recorder");

// ── _bigIntReplacer ─────────────────────────────────────────────────

describe("_bigIntReplacer", () => {
  it("converts BigInt to string", () => {
    assert.strictEqual(_bigIntReplacer("k", 123n), "123");
  });

  it("passes through non-BigInt values", () => {
    assert.strictEqual(_bigIntReplacer("k", 42), 42);
    assert.strictEqual(_bigIntReplacer("k", "hello"), "hello");
    assert.strictEqual(_bigIntReplacer("k", null), null);
    assert.strictEqual(_bigIntReplacer("k", true), true);
  });

  it("works with JSON.stringify", () => {
    const obj = { a: 100n, b: "text", c: 200n };
    const s = JSON.stringify(obj, _bigIntReplacer);
    assert.deepStrictEqual(JSON.parse(s), { a: "100", b: "text", c: "200" });
  });
});

// ── _activePosSummary ───────────────────────────────────────────────

describe("_activePosSummary", () => {
  it("builds serialisable summary from position", () => {
    const p = {
      tokenId: 12345n,
      token0: "0xA",
      token1: "0xB",
      fee: 3000,
      tickLower: -100,
      tickUpper: 200,
      liquidity: 99999n,
      extraField: "ignored",
    };
    const s = _activePosSummary(p);
    assert.strictEqual(s.tokenId, "12345");
    assert.strictEqual(s.token0, "0xA");
    assert.strictEqual(s.token1, "0xB");
    assert.strictEqual(s.fee, 3000);
    assert.strictEqual(s.tickLower, -100);
    assert.strictEqual(s.tickUpper, 200);
    assert.strictEqual(s.liquidity, "99999");
    assert.strictEqual(s.extraField, undefined);
  });

  it("handles missing liquidity", () => {
    const s = _activePosSummary({ tokenId: "1" });
    assert.strictEqual(s.liquidity, "0");
  });

  it("converts string tokenId", () => {
    const s = _activePosSummary({ tokenId: "555" });
    assert.strictEqual(s.tokenId, "555");
  });
});

// ── _collectTokenIds ────────────────────────────────────────────────

describe("_collectTokenIds", () => {
  it("collects current tokenId with no events", () => {
    const ids = _collectTokenIds({ tokenId: "100" }, []);
    assert.ok(ids.has("100"));
    assert.strictEqual(ids.size, 1);
  });

  it("collects IDs from rebalance events", () => {
    const ids = _collectTokenIds({ tokenId: "103" }, [
      { oldTokenId: "100", newTokenId: "101" },
      { oldTokenId: "101", newTokenId: "102" },
      { oldTokenId: "102", newTokenId: "103" },
    ]);
    assert.ok(ids.has("100"));
    assert.ok(ids.has("101"));
    assert.ok(ids.has("102"));
    assert.ok(ids.has("103"));
    assert.strictEqual(ids.size, 4);
  });

  it("deduplicates IDs", () => {
    const ids = _collectTokenIds({ tokenId: "1" }, [
      { oldTokenId: "1", newTokenId: "1" },
    ]);
    assert.strictEqual(ids.size, 1);
  });

  it("handles null events", () => {
    const ids = _collectTokenIds({ tokenId: "5" }, null);
    assert.strictEqual(ids.size, 1);
    assert.ok(ids.has("5"));
  });

  it("skips events with missing oldTokenId", () => {
    const ids = _collectTokenIds({ tokenId: "10" }, [
      { newTokenId: "11" },
      { oldTokenId: "9", newTokenId: "10" },
    ]);
    assert.ok(ids.has("9"));
    assert.ok(ids.has("10"));
    assert.ok(ids.has("11"));
  });
});

// ── _pushRebalanceEvent ─────────────────────────────────────────────

describe("_pushRebalanceEvent", () => {
  it("appends event to array", () => {
    const events = [];
    _pushRebalanceEvent(events, {
      oldTokenId: "1",
      newTokenId: "2",
      txHashes: ["0xabc"],
    });
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].oldTokenId, "1");
    assert.strictEqual(events[0].newTokenId, "2");
    assert.strictEqual(events[0].txHash, "0xabc");
    assert.strictEqual(events[0].index, 1);
    assert.ok(events[0].dateStr);
    assert.ok(events[0].timestamp > 0);
  });

  it("handles missing txHashes", () => {
    const events = [];
    _pushRebalanceEvent(events, { oldTokenId: "5", newTokenId: "6" });
    assert.strictEqual(events[0].txHash, "");
  });

  it("uses ? for missing tokenIds", () => {
    const events = [];
    _pushRebalanceEvent(events, {});
    assert.strictEqual(events[0].oldTokenId, "?");
    assert.strictEqual(events[0].newTokenId, "?");
  });

  it("increments index for subsequent events", () => {
    const events = [{ index: 1 }];
    _pushRebalanceEvent(events, { oldTokenId: "a", newTokenId: "b" });
    assert.strictEqual(events[1].index, 2);
  });

  it("does nothing when events is null", () => {
    // Should not throw
    _pushRebalanceEvent(null, { oldTokenId: "1", newTokenId: "2" });
  });
});

// ── _updateHodlBaseline ─────────────────────────────────────────────

describe("_updateHodlBaseline", () => {
  it("sets baseline from rebalance result", () => {
    const botState = {};
    const result = {
      amount0Minted: 1000000000000000000n, // 1e18
      amount1Minted: 2000000000000000000n, // 2e18
      decimals0: 18,
      decimals1: 18,
      token0UsdPrice: 0.5,
      token1UsdPrice: 0.25,
      mintGasCostWei: 100000n,
    };
    _updateHodlBaseline(botState, result, "2026-03-15T12:00:00Z");
    assert.ok(botState.hodlBaseline);
    assert.strictEqual(botState.hodlBaseline.mintDate, "2026-03-15");
    assert.strictEqual(
      botState.hodlBaseline.mintTimestamp,
      "2026-03-15T12:00:00Z",
    );
    assert.strictEqual(botState.hodlBaseline.hodlAmount0, 1);
    assert.strictEqual(botState.hodlBaseline.hodlAmount1, 2);
    assert.strictEqual(botState.hodlBaseline.token0UsdPrice, 0.5);
    assert.strictEqual(botState.hodlBaseline.token1UsdPrice, 0.25);
    // entryValue = 1*0.5 + 2*0.25 = 1.0
    assert.strictEqual(botState.hodlBaseline.entryValue, 1);
    assert.strictEqual(botState.hodlBaseline.mintGasWei, "100000");
  });

  it("handles missing prices", () => {
    const botState = {};
    _updateHodlBaseline(
      botState,
      { amount0Minted: 0n, amount1Minted: 0n },
      "2026-01-01T00:00:00Z",
    );
    assert.strictEqual(botState.hodlBaseline.token0UsdPrice, 0);
    assert.strictEqual(botState.hodlBaseline.entryValue, 0);
    assert.strictEqual(botState.hodlBaseline.mintGasWei, "0");
  });

  it("uses default decimals of 18 when not specified", () => {
    const botState = {};
    _updateHodlBaseline(
      botState,
      {
        amount0Minted: 500000000000000000n, // 0.5 @ 18 decimals
        amount1Minted: 0n,
        token0UsdPrice: 2,
        token1UsdPrice: 0,
      },
      "2026-01-01T00:00:00Z",
    );
    assert.strictEqual(botState.hodlBaseline.hodlAmount0, 0.5);
    assert.strictEqual(botState.hodlBaseline.entryValue, 1);
  });
});

// ── _recordResidual ─────────────────────────────────────────────────

describe("_recordResidual", () => {
  it("records delta when tracker and pool address exist", () => {
    let addedDelta = null;
    let statePatch = null;
    const deps = {
      _residualTracker: {
        addDelta: (pool, d0, d1) => {
          addedDelta = { pool, d0, d1 };
        },
        serialize: () => ({ pools: {} }),
      },
      updateBotState: (p) => {
        statePatch = p;
      },
    };
    _recordResidual(deps, {
      poolAddress: "0xPOOL",
      amount0Collected: 100n,
      amount1Collected: 50n,
      amount0Minted: 90n,
      amount1Minted: 45n,
    });
    assert.ok(addedDelta);
    assert.strictEqual(addedDelta.pool, "0xPOOL");
    assert.strictEqual(addedDelta.d0, 10n);
    assert.strictEqual(addedDelta.d1, 5n);
    assert.ok(statePatch.residuals);
  });

  it("does nothing without residual tracker", () => {
    // Should not throw
    _recordResidual({}, { poolAddress: "0xP" });
  });

  it("does nothing without pool address", () => {
    let called = false;
    _recordResidual(
      {
        _residualTracker: {
          addDelta: () => {
            called = true;
          },
        },
      },
      {},
    );
    assert.ok(!called);
  });
});

// ── _notifyRebalance ────────────────────────────────────────────────

describe("_notifyRebalance", () => {
  it("sends state patch with rebalance data", () => {
    let patch = null;
    const deps = {
      _rebalanceCount: 5,
      updateBotState: (p) => {
        patch = p;
      },
    };
    const throttle = {
      getState: () => ({ dailyCount: 2 }),
    };
    const position = {
      tokenId: "42",
      token0: "0xA",
      token1: "0xB",
      fee: 3000,
      tickLower: -10,
      tickUpper: 10,
      liquidity: 100n,
    };
    _notifyRebalance(deps, throttle, position, [{ id: 1 }]);
    assert.strictEqual(patch.rebalanceCount, 6);
    assert.ok(patch.lastRebalanceAt);
    assert.deepStrictEqual(patch.throttleState, { dailyCount: 2 });
    assert.strictEqual(patch.activePosition.tokenId, "42");
    assert.strictEqual(patch.activePositionId, "42");
    assert.strictEqual(patch.rebalanceEvents.length, 1);
  });

  it("handles null events", () => {
    let patch = null;
    _notifyRebalance(
      { updateBotState: (p) => (patch = p) },
      { getState: () => ({}) },
      { tokenId: "1" },
      null,
    );
    assert.strictEqual(patch.rebalanceEvents, undefined);
  });
});

// ── _applyRebalanceResult ───────────────────────────────────────────

describe("_applyRebalanceResult", () => {
  const { _applyRebalanceResult } = require("../src/bot-recorder");

  it("updates position tokenId and ticks from result", () => {
    const position = {
      tokenId: "100",
      tickLower: -50,
      tickUpper: 50,
    };
    const patches = [];
    const deps = {
      position,
      _rebalanceEvents: [],
      _botState: { oorSince: Date.now() },
      throttle: { getState: () => ({}) },
      updateBotState: (p) => patches.push(p),
    };
    const result = {
      newTokenId: 200n,
      newTickLower: -100,
      newTickUpper: 100,
      liquidity: 5000n,
      amount0Minted: 0n,
      amount1Minted: 0n,
    };
    _applyRebalanceResult(deps, result);
    assert.strictEqual(position.tokenId, "200");
    assert.strictEqual(position.tickLower, -100);
    assert.strictEqual(position.tickUpper, 100);
    assert.strictEqual(position.liquidity, "5000");
    assert.strictEqual(deps._botState.oorSince, null);
    assert.strictEqual(deps._botState._mintGasApplied, false);
  });

  it("does not update tokenId when newTokenId is 0n", () => {
    const position = { tokenId: "100", tickLower: 0, tickUpper: 0 };
    const deps = {
      position,
      _rebalanceEvents: [],
      _botState: {},
      throttle: { getState: () => ({}) },
      updateBotState: () => {},
    };
    _applyRebalanceResult(deps, {
      newTokenId: 0n,
      newTickLower: -10,
      newTickUpper: 10,
      amount0Minted: 0n,
      amount1Minted: 0n,
    });
    assert.strictEqual(position.tokenId, "100");
  });

  it("returns early without calling updateBotState when absent", () => {
    const position = { tokenId: "1", tickLower: 0, tickUpper: 0 };
    const deps = {
      position,
      _rebalanceEvents: [],
      _botState: {},
    };
    // Should not throw
    _applyRebalanceResult(deps, {
      newTokenId: 2n,
      newTickLower: -5,
      newTickUpper: 5,
      amount0Minted: 0n,
      amount1Minted: 0n,
    });
  });

  it("includes rangeRounded when effective differs from requested", () => {
    const position = { tokenId: "1" };
    const patches = [];
    const deps = {
      position,
      _rebalanceEvents: [],
      _botState: {},
      throttle: { getState: () => ({}) },
      updateBotState: (p) => patches.push(p),
    };
    _applyRebalanceResult(deps, {
      newTokenId: 2n,
      newTickLower: 0,
      newTickUpper: 0,
      amount0Minted: 0n,
      amount1Minted: 0n,
      requestedRangePct: 10,
      effectiveRangePct: 12.5,
    });
    const rangePatch = patches.find((p) => p.rangeRounded);
    assert.ok(rangePatch);
    assert.strictEqual(rangePatch.rangeRounded.requested, 10);
    assert.strictEqual(rangePatch.rangeRounded.effective, 12.5);
  });
});

// ── appendLog ───────────────────────────────────────────────────────

describe("appendLog", () => {
  it("creates log file and appends entry", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "br-test-"));
    const logPath = path.join(dir, "test-rebalance.json");
    const origLog = process.env.LOG_FILE;
    process.env.LOG_FILE = logPath;
    // Clear require cache so config picks up new LOG_FILE
    delete require.cache[require.resolve("../src/config")];
    delete require.cache[require.resolve("../src/bot-recorder")];
    const { appendLog: al } = require("../src/bot-recorder");
    al({ action: "test", value: 123n });
    const entries = JSON.parse(fs.readFileSync(logPath, "utf8"));
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].action, "test");
    assert.strictEqual(entries[0].value, "123");
    assert.ok(entries[0].loggedAt);
    // Append a second entry
    al({ action: "test2" });
    const entries2 = JSON.parse(fs.readFileSync(logPath, "utf8"));
    assert.strictEqual(entries2.length, 2);
    // Cleanup
    fs.rmSync(dir, { recursive: true });
    if (origLog) process.env.LOG_FILE = origLog;
    else delete process.env.LOG_FILE;
    delete require.cache[require.resolve("../src/config")];
    delete require.cache[require.resolve("../src/bot-recorder")];
  });
});
