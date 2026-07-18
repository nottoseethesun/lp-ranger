/**
 * @file test/rebalancer-execute-compute-range.test.js
 * @description Tests for the `_computeRange` seam in
 *   `src/rebalancer-execute.js` — the seam that decides whether a
 *   rebalance uses (a) the explicit Full-Range checkbox, (b) a custom
 *   Price Range Extension widthPct, or (c) preserveRange from the
 *   on-chain spread.
 *
 *   The full-range branch is now driven by a boolean `fullRange`
 *   argument (from the dashboard's Full-Range checkbox), replacing the
 *   old `crw === 100` sentinel.  Guarantees: (1) fullRange=true →
 *   MIN_TICK/MAX_TICK, (2) fullRange=false + crw=100 → custom widthPct
 *   (no longer a sentinel), (3) fullRange=false + crw=undefined →
 *   preserveRange.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { _computeRange } = require("../src/rebalancer-execute");
const { MIN_TICK, MAX_TICK } = require("../src/range-math");

/*- Minimal pool state; only the fields _computeRange reads matter. */
const ps = {
  tick: 0,
  price: 1,
  tickSpacing: 200,
  decimals0: 18,
  decimals1: 18,
};
/*- Minimal existing position; only tickLower/tickUpper matter for the
 *  preserveRange fallback branch. */
const pos = {
  tickLower: -1000,
  tickUpper: 1000,
  tokenId: "42",
};

describe("_computeRange full-range flag (fullRange === true)", () => {
  it("mints at MIN_TICK/MAX_TICK (tickSpacing-aligned) when fullRange=true", () => {
    const r = _computeRange(ps, pos, undefined, 50, true);
    /*- sp=200: nearestUsableTick clamps to [-887200, 887200]. */
    assert.strictEqual(r.lowerTick, -887200);
    assert.strictEqual(r.upperTick, 887200);
  });

  it("ignores offset — full-range is symmetric by definition", () => {
    /*- Regression guard: the fullRange branch must not thread
     *  offsetToken0Pct through to a formula that would asymmetrize the
     *  bounds.  A full-range position covers everything; offset is
     *  meaningless. */
    const centered = _computeRange(ps, pos, undefined, 50, true);
    const skewed = _computeRange(ps, pos, undefined, 30, true);
    assert.deepStrictEqual(centered, skewed);
  });

  it("ignores crw when fullRange=true (fullRange wins)", () => {
    /*- Full-range takes precedence over a saved Price Range Extension
     *  value.  The user has explicitly opted in via the checkbox. */
    const withCrw = _computeRange(ps, pos, 50, 50, true);
    const withoutCrw = _computeRange(ps, pos, undefined, 50, true);
    assert.deepStrictEqual(withCrw, withoutCrw);
  });

  it("ignores the existing position's tickLower/tickUpper", () => {
    const wideExisting = _computeRange(
      ps,
      { tickLower: -500_000, tickUpper: 500_000, tokenId: "9" },
      undefined,
      50,
      true,
    );
    const narrowExisting = _computeRange(
      ps,
      { tickLower: -1000, tickUpper: 1000, tokenId: "9" },
      undefined,
      50,
      true,
    );
    assert.deepStrictEqual(wideExisting, narrowExisting);
  });

  it("aligns to tickSpacing=60 (fee=3000)", () => {
    const r = _computeRange(
      { ...ps, tickSpacing: 60 },
      pos,
      undefined,
      50,
      true,
    );
    assert.strictEqual(r.lowerTick, -887220);
    assert.strictEqual(r.upperTick, 887220);
  });

  it("aligns to tickSpacing=1 (fee=100) — exactly MIN_TICK/MAX_TICK", () => {
    const r = _computeRange(
      { ...ps, tickSpacing: 1 },
      pos,
      undefined,
      50,
      true,
    );
    assert.strictEqual(r.lowerTick, MIN_TICK);
    assert.strictEqual(r.upperTick, MAX_TICK);
  });
});

describe("_computeRange non-fullRange paths (regression guards)", () => {
  it("crw = 100 with fullRange=false is a normal concentrated range (no longer a sentinel)", () => {
    /*- Sentinel semantics removed: 100 goes through computeNewRange
     *  like any other value, producing a wide (but not full-range)
     *  position — ±50% around current price. */
    const r = _computeRange(ps, pos, 100, 50, false);
    assert.ok(r.lowerTick > MIN_TICK + 100_000);
    assert.ok(r.upperTick < MAX_TICK - 100_000);
  });

  it("crw = 99.99 uses the custom widthPct formula", () => {
    const r = _computeRange(ps, pos, 99.99, 50, false);
    assert.ok(r.lowerTick > MIN_TICK + 100_000);
    assert.ok(r.upperTick < MAX_TICK - 100_000);
  });

  it("crw = 50 produces a normal concentrated ±25% range", () => {
    const r = _computeRange(ps, pos, 50, 50, false);
    /*- ±25% around current price (tick=0): lowerTick ~-2900, upperTick
     *  ~2300 (approximate — depends on tick-spacing rounding). */
    assert.ok(r.lowerTick < 0);
    assert.ok(r.upperTick > 0);
    assert.ok(Math.abs(r.lowerTick) < 5000);
    assert.ok(Math.abs(r.upperTick) < 5000);
  });

  it("crw = undefined + fullRange=false falls back to preserveRange", () => {
    const r = _computeRange(ps, pos, undefined, 50, false);
    /*- preserveRange preserves the existing spread (2000 ticks) centered
     *  on currentTick=0 — approximately [-1000, 1000] modulo
     *  tickSpacing. */
    const spread = r.upperTick - r.lowerTick;
    assert.ok(spread >= 2000, `expected spread >= 2000, got ${spread}`);
  });

  it("crw = 0 + fullRange=false falls back to preserveRange (truthy-omit)", () => {
    /*- Documented behavior in bot-cycle-opts.js — 0 means "no override". */
    const r = _computeRange(ps, pos, 0, 50, false);
    const spread = r.upperTick - r.lowerTick;
    assert.ok(spread >= 2000, `expected spread >= 2000, got ${spread}`);
  });

  it("fullRange defaults to false when omitted (5th arg undefined)", () => {
    /*- Callers that haven't been updated to pass the new arg get the
     *  same behavior as fullRange=false — a concentrated range from crw
     *  or preserveRange. */
    const r = _computeRange(ps, pos, 50, 50);
    assert.ok(r.lowerTick > MIN_TICK + 100_000);
    assert.ok(r.upperTick < MAX_TICK - 100_000);
  });
});
