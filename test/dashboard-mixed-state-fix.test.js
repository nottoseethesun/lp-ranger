"use strict";

/**
 * @file test/dashboard-mixed-state-fix.test.js
 * @description Tests for the "tokenId correct, pool name stale"
 *   mixed-state render bug fixes across three modules:
 *
 *     1. `posStore.add()` dedup branch in
 *        `public/dashboard-positions-store.js` refreshes pool-identity
 *        fields (via the now-exported `_refreshDuplicateEntry`).
 *     2. `_applyLiqAndTicks` / `_applyPoolFields` / `_applySymbols` in
 *        `public/dashboard-active-sync.js` propagate pool identity +
 *        symbols from `data.activePosition` to the posStore active
 *        entry.  All three are now exported.
 *     3. `_activeMatches` in `public/dashboard-unmanaged.js` (also now
 *        exported) drops stale pending fetches and stale in-flight
 *        phase1 results when posStore's active tokenId no longer
 *        matches.  Server-side `_activePosSummary` still ships symbols.
 *
 *   Uses jsdom + direct import of all four modules.  No mirrors.
 */

require("global-jsdom/register");

const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { _activePosSummary } = require("../src/bot-recorder");

let store;
let activeSync;
let unmanaged;

before(async () => {
  store = await import("../public/dashboard-positions-store.js");
  activeSync = await import("../public/dashboard-active-sync.js");
  unmanaged = await import("../public/dashboard-unmanaged.js");
});

beforeEach(() => {
  store.posStore.entries.length = 0;
  store.posStore.activeIdx = -1;
});

// ── Server-side: _activePosSummary ships symbols to the client ─────────

describe("_activePosSummary includes symbols", () => {
  it("propagates token0Symbol and token1Symbol so the dashboard self-heals stale pool labels", () => {
    const s = _activePosSummary({
      tokenId: 1n,
      token0: "0xA",
      token1: "0xB",
      fee: 10000,
      token0Symbol: "HEX",
      token1Symbol: "eHEX",
    });
    assert.strictEqual(s.token0Symbol, "HEX");
    assert.strictEqual(s.token1Symbol, "eHEX");
  });
});

// ── _refreshDuplicateEntry (posStore.add dedup branch) ─────────────────

describe("posStore._refreshDuplicateEntry — pool-identity refresh", () => {
  it("rewrites token0/token1/fee/ticks when scan returns fresh values", () => {
    const existing = {
      tokenId: "159250",
      walletAddress: "0xWALLET",
      positionType: "nft",
      token0: "0xMAXIMUS_OLD",
      token1: "0xMAXIMUS_E_OLD",
      fee: 10000,
      tickLower: -100,
      tickUpper: 100,
      token0Symbol: "Maximus",
      token1Symbol: "Maximus from Ethereum",
    };
    const fresh = {
      tokenId: "159250",
      walletAddress: "0xWALLET",
      positionType: "nft",
      token0: "0xHEX",
      token1: "0xeHEX",
      fee: 10000,
      tickLower: -200,
      tickUpper: 200,
      token0Symbol: "HEX",
      token1Symbol: "eHEX",
    };
    store._refreshDuplicateEntry(existing, fresh);
    assert.strictEqual(existing.token0, "0xHEX");
    assert.strictEqual(existing.token1, "0xeHEX");
    assert.strictEqual(existing.tickLower, -200);
    assert.strictEqual(existing.tickUpper, 200);
    assert.strictEqual(existing.token0Symbol, "HEX");
    assert.strictEqual(existing.token1Symbol, "eHEX");
  });

  it("leaves existing fields alone when fresh entry omits them", () => {
    const existing = {
      token0: "0xA",
      token1: "0xB",
      fee: 3000,
      tickLower: -10,
      tickUpper: 10,
      token0Symbol: "A",
      token1Symbol: "B",
    };
    store._refreshDuplicateEntry(existing, { liquidity: "999" });
    assert.strictEqual(existing.token0, "0xA");
    assert.strictEqual(existing.token1, "0xB");
    assert.strictEqual(existing.fee, 3000);
    assert.strictEqual(existing.tickLower, -10);
    assert.strictEqual(existing.tickUpper, 10);
    assert.strictEqual(existing.token0Symbol, "A");
    assert.strictEqual(existing.token1Symbol, "B");
    assert.strictEqual(existing.liquidity, "999");
  });

  it("treats fee=0 and tick=0 as legitimate values (no falsy skips)", () => {
    const existing = { fee: 10000, tickLower: 100, tickUpper: 200 };
    store._refreshDuplicateEntry(existing, {
      fee: 500,
      tickLower: 0,
      tickUpper: 0,
    });
    assert.strictEqual(existing.fee, 500);
    assert.strictEqual(existing.tickLower, 0);
    assert.strictEqual(existing.tickUpper, 0);
  });
});

// ── _applyLiqAndTicks / _applyPoolFields / _applySymbols ───────────────

describe("_applyLiqAndTicks()", () => {
  it("copies liquidity as a string, coerces numeric input", () => {
    const active = {};
    activeSync._applyLiqAndTicks(active, { liquidity: 1234 });
    assert.strictEqual(active.liquidity, "1234");
  });

  it("copies both ticks together (paired update)", () => {
    const active = {};
    activeSync._applyLiqAndTicks(active, { tickLower: -50, tickUpper: 50 });
    assert.strictEqual(active.tickLower, -50);
    assert.strictEqual(active.tickUpper, 50);
  });

  it("null liquidity is rejected (would corrupt the isPositionClosed check)", () => {
    const active = { liquidity: "orig" };
    activeSync._applyLiqAndTicks(active, { liquidity: null });
    assert.strictEqual(active.liquidity, "orig");
  });
});

describe("_applyPoolFields()", () => {
  it("returns true when token0 / token1 / fee change", () => {
    const active = { token0: "0xA", token1: "0xB", fee: 3000 };
    const changed = activeSync._applyPoolFields(active, {
      token0: "0xC",
      token1: "0xD",
      fee: 10000,
    });
    assert.strictEqual(changed, true);
    assert.strictEqual(active.token0, "0xC");
    assert.strictEqual(active.fee, 10000);
  });

  it("returns false when the fields are already identical", () => {
    const active = { token0: "0xA", token1: "0xB", fee: 3000 };
    const changed = activeSync._applyPoolFields(active, {
      token0: "0xA",
      token1: "0xB",
      fee: 3000,
    });
    assert.strictEqual(changed, false);
  });

  it("returns false when ap.token0 is missing (no update, no change flag)", () => {
    const active = { token0: "0xA", token1: "0xB", fee: 3000 };
    const changed = activeSync._applyPoolFields(active, {});
    assert.strictEqual(changed, false);
    assert.strictEqual(active.token0, "0xA");
  });
});

describe("_applySymbols()", () => {
  it("returns true and copies when either symbol changes", () => {
    const active = { token0Symbol: "OLD0", token1Symbol: "OLD1" };
    const changed = activeSync._applySymbols(active, {
      token0Symbol: "NEW0",
      token1Symbol: "NEW1",
    });
    assert.strictEqual(changed, true);
    assert.strictEqual(active.token0Symbol, "NEW0");
    assert.strictEqual(active.token1Symbol, "NEW1");
  });

  it("returns false when symbols are already identical", () => {
    const active = { token0Symbol: "A", token1Symbol: "B" };
    const changed = activeSync._applySymbols(active, {
      token0Symbol: "A",
      token1Symbol: "B",
    });
    assert.strictEqual(changed, false);
  });

  it("empty-string symbols are treated as absent (no clobber)", () => {
    const active = { token0Symbol: "A" };
    activeSync._applySymbols(active, { token0Symbol: "" });
    assert.strictEqual(active.token0Symbol, "A");
  });
});

// ── _activeMatches (dashboard-unmanaged stale-target guard) ────────────

describe("_activeMatches()", () => {
  it("compares as strings (numeric tokenId → string match works both ways)", () => {
    store.posStore.entries.push({
      positionType: "nft",
      tokenId: "159250",
      walletAddress: "0xW",
    });
    store.posStore.activeIdx = 0;
    assert.strictEqual(unmanaged._activeMatches("159250"), true);
    assert.strictEqual(unmanaged._activeMatches(159250), true);
  });

  it("returns false when the active tokenId does not match", () => {
    store.posStore.entries.push({
      positionType: "nft",
      tokenId: "159250",
      walletAddress: "0xW",
    });
    store.posStore.activeIdx = 0;
    assert.strictEqual(unmanaged._activeMatches("159322"), false);
  });

  it("returns false when there is no active position", () => {
    // beforeEach cleared posStore; no active.
    assert.strictEqual(unmanaged._activeMatches("159250"), false);
  });
});
