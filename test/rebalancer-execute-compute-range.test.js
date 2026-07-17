/**
 * @file test/rebalancer-execute-compute-range.test.js
 * @description Tests for the `_computeRange` seam in
 *   `src/rebalancer-execute.js` — the seam that decides whether a
 *   rebalance uses (a) the full-range sentinel, (b) a custom widthPct,
 *   or (c) preserveRange from the on-chain spread.
 *
 *   The full-range sentinel (`crw === 100`) mints at
 *   MIN_TICK/MAX_TICK.  Guarantees: (1) 100 → full-range, (2) 99.99 →
 *   custom widthPct (NOT full-range), (3) undefined → preserveRange.
 *   The dashboard's Range Width input is capped at 100 so no
 *   legitimate ±50% override can collide with the sentinel.
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

describe("_computeRange full-range sentinel (crw === 100)", () => {
  it("mints at MIN_TICK/MAX_TICK (tickSpacing-aligned) when crw === 100", () => {
    const r = _computeRange(ps, pos, 100, 50);
    /*- sp=200: nearestUsableTick clamps to [-887200, 887200]. */
    assert.strictEqual(r.lowerTick, -887200);
    assert.strictEqual(r.upperTick, 887200);
  });

  it("ignores offset — full-range is symmetric by definition", () => {
    /*- Regression guard: the sentinel branch must not thread
     *  offsetToken0Pct through to a formula that would asymmetrize the
     *  bounds.  A full-range position covers everything; offset is
     *  meaningless. */
    const centered = _computeRange(ps, pos, 100, 50);
    const skewed = _computeRange(ps, pos, 100, 30);
    assert.deepStrictEqual(centered, skewed);
  });

  it("ignores the existing position's tickLower/tickUpper", () => {
    /*- Full-range doesn't care about the pre-rebalance range —
     *  regression guard against accidentally chaining into
     *  preserveRange. */
    const wideExisting = _computeRange(
      ps,
      { tickLower: -500_000, tickUpper: 500_000, tokenId: "9" },
      100,
      50,
    );
    const narrowExisting = _computeRange(
      ps,
      { tickLower: -1000, tickUpper: 1000, tokenId: "9" },
      100,
      50,
    );
    assert.deepStrictEqual(wideExisting, narrowExisting);
  });

  it("aligns to tickSpacing=60 (fee=3000)", () => {
    const r = _computeRange({ ...ps, tickSpacing: 60 }, pos, 100, 50);
    assert.strictEqual(r.lowerTick, -887220);
    assert.strictEqual(r.upperTick, 887220);
  });

  it("aligns to tickSpacing=1 (fee=100) — exactly MIN_TICK/MAX_TICK", () => {
    const r = _computeRange({ ...ps, tickSpacing: 1 }, pos, 100, 50);
    assert.strictEqual(r.lowerTick, MIN_TICK);
    assert.strictEqual(r.upperTick, MAX_TICK);
  });
});

describe("_computeRange non-sentinel paths (regression guards)", () => {
  it("crw = 99.99 uses the custom widthPct formula (NOT full-range)", () => {
    /*- The dashboard caps the input at 100; 99.99 is the closest legal
     *  value below the sentinel.  Verify it produces a normal
     *  concentrated range, not MIN/MAX ticks. */
    const r = _computeRange(ps, pos, 99.99, 50);
    assert.ok(r.lowerTick > MIN_TICK + 100_000);
    assert.ok(r.upperTick < MAX_TICK - 100_000);
  });

  it("crw = 50 produces a normal concentrated ±25% range", () => {
    const r = _computeRange(ps, pos, 50, 50);
    /*- ±25% around current price (tick=0): lowerTick ~-2900, upperTick
     *  ~2300 (approximate — depends on tick-spacing rounding). */
    assert.ok(r.lowerTick < 0);
    assert.ok(r.upperTick > 0);
    assert.ok(Math.abs(r.lowerTick) < 5000);
    assert.ok(Math.abs(r.upperTick) < 5000);
  });

  it("crw = undefined falls back to preserveRange (uses pos ticks)", () => {
    const r = _computeRange(ps, pos, undefined, 50);
    /*- preserveRange preserves the existing spread (2000 ticks) centered
     *  on currentTick=0 — approximately [-1000, 1000] modulo
     *  tickSpacing. */
    const spread = r.upperTick - r.lowerTick;
    assert.ok(spread >= 2000, `expected spread >= 2000, got ${spread}`);
  });

  it("crw = 0 falls back to preserveRange (truthy-omit)", () => {
    /*- Documented behavior in bot-cycle-opts.js — 0 means "no override". */
    const r = _computeRange(ps, pos, 0, 50);
    const spread = r.upperTick - r.lowerTick;
    assert.ok(spread >= 2000, `expected spread >= 2000, got ${spread}`);
  });
});
