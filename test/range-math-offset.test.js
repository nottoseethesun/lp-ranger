/**
 * @file test/range-math-offset.test.js
 * @description Tests for the offsetToken0Pct parameter in computeNewRange
 * and preserveRange. Split from range-math.test.js for line-count compliance.
 */

"use strict";
const { describe, it } = require("node:test");

const assert = require("assert");
const {
  priceToTick,
  computeNewRange,
  preserveRange,
  TICK_SPACINGS,
} = require("../src/range-math");

// ── computeNewRange — offset ────────────────────────────────────────────────

describe("computeNewRange — offsetToken0Pct", () => {
  const price = 1.0;
  const widthPct = 10; // half-width = ±10%, total = 20%
  const feeTier = 3000;
  const d0 = 18,
    d1 = 18;
  const tick = priceToTick(price, d0, d1); // tick ≈ 0

  it("offset=50 produces same result as no offset (backward compat)", () => {
    const without = computeNewRange(price, widthPct, feeTier, d0, d1, {
      currentTick: tick,
    });
    const with50 = computeNewRange(price, widthPct, feeTier, d0, d1, {
      currentTick: tick,
      offsetToken0Pct: 50,
    });
    assert.strictEqual(with50.lowerTick, without.lowerTick);
    assert.strictEqual(with50.upperTick, without.upperTick);
  });

  it("offset=60 shifts range so more is above current price", () => {
    const centered = computeNewRange(price, widthPct, feeTier, d0, d1, {
      currentTick: tick,
    });
    const offset60 = computeNewRange(price, widthPct, feeTier, d0, d1, {
      currentTick: tick,
      offsetToken0Pct: 60,
    });
    // With more range above, upperTick should be further from currentTick
    // and lowerTick should be closer to currentTick
    const centeredAbove = centered.upperTick - tick;
    const offset60Above = offset60.upperTick - tick;
    assert.ok(
      offset60Above > centeredAbove,
      `offset=60 should have more ticks above: ${offset60Above} vs ${centeredAbove}`,
    );
    assert.ok(offset60.lowerTick < offset60.upperTick);
  });

  it("offset=100 places entire range above current price (all token0)", () => {
    const r = computeNewRange(price, widthPct, feeTier, d0, d1, {
      currentTick: tick,
      offsetToken0Pct: 100,
    });
    // lowerTick should be at or near currentTick (entire range above)
    assert.ok(r.lowerTick < r.upperTick);
    assert.ok(
      r.lowerTick >= tick - 60,
      `lowerTick ${r.lowerTick} should be near tick ${tick}`,
    );
  });

  it("offset=0 places entire range below current price (all token1)", () => {
    const r = computeNewRange(price, widthPct, feeTier, d0, d1, {
      currentTick: tick,
      offsetToken0Pct: 0,
    });
    // upperTick should be at or near currentTick (entire range below)
    assert.ok(r.lowerTick < r.upperTick);
    assert.ok(
      r.upperTick <= tick + 60,
      `upperTick ${r.upperTick} should be near tick ${tick}`,
    );
  });

  it("offset skips tick containment guard (preserves offset intent)", () => {
    // With offset=0, upperTick is near currentTick. The containment guard
    // would normally shift the range to contain the tick — verify it doesn't.
    const r = computeNewRange(price, widthPct, feeTier, d0, d1, {
      currentTick: tick,
      offsetToken0Pct: 0,
    });
    // If the guard ran, it would push upperTick well above currentTick
    assert.ok(
      r.upperTick <= tick + 60,
      "containment guard should be skipped for offset != 50",
    );
  });

  it("lowerTick < upperTick for all extreme offsets", () => {
    for (const o of [0, 1, 25, 50, 75, 99, 100]) {
      const r = computeNewRange(price, widthPct, feeTier, d0, d1, {
        currentTick: tick,
        offsetToken0Pct: o,
      });
      assert.ok(
        r.lowerTick < r.upperTick,
        `offset=${o}: lowerTick ${r.lowerTick} >= upperTick ${r.upperTick}`,
      );
    }
  });
});

// ── preserveRange — offset ──────────────────────────────────────────────────

describe("preserveRange — offsetToken0Pct", () => {
  const feeTier = 3000;
  const spacing = TICK_SPACINGS[feeTier]; // 60
  const d0 = 18,
    d1 = 18;
  const tickLower = -600;
  const tickUpper = 600;
  const spread = tickUpper - tickLower; // 1200

  it("offset=50 produces same result as no offset (backward compat)", () => {
    const without = preserveRange(0, tickLower, tickUpper, feeTier, d0, d1);
    const with50 = preserveRange(0, tickLower, tickUpper, feeTier, d0, d1, {
      offsetToken0Pct: 50,
    });
    assert.strictEqual(with50.lowerTick, without.lowerTick);
    assert.strictEqual(with50.upperTick, without.upperTick);
  });

  it("offset=70 shifts range so more is above current tick", () => {
    const centered = preserveRange(0, tickLower, tickUpper, feeTier, d0, d1);
    const offset70 = preserveRange(0, tickLower, tickUpper, feeTier, d0, d1, {
      offsetToken0Pct: 70,
    });
    const centeredAbove = centered.upperTick;
    const offset70Above = offset70.upperTick;
    assert.ok(
      offset70Above > centeredAbove,
      `offset=70 upper should be higher: ${offset70Above} vs ${centeredAbove}`,
    );
  });

  it("offset preserves original spread width", () => {
    const r = preserveRange(0, tickLower, tickUpper, feeTier, d0, d1, {
      offsetToken0Pct: 70,
    });
    const newSpread = r.upperTick - r.lowerTick;
    assert.ok(
      newSpread >= spread && newSpread - spread <= spacing,
      `spread ${newSpread} should be ≈ ${spread}`,
    );
  });

  it("offset=100 places entire range above (all token0)", () => {
    const r = preserveRange(0, tickLower, tickUpper, feeTier, d0, d1, {
      offsetToken0Pct: 100,
    });
    assert.ok(r.lowerTick >= -spacing, "lowerTick near currentTick");
    assert.ok(r.lowerTick < r.upperTick);
  });

  it("offset=0 places entire range below (all token1)", () => {
    const r = preserveRange(0, tickLower, tickUpper, feeTier, d0, d1, {
      offsetToken0Pct: 0,
    });
    assert.ok(r.upperTick <= spacing, "upperTick near currentTick");
    assert.ok(r.lowerTick < r.upperTick);
  });

  it("offset skips tick containment guard", () => {
    // With offset=0, the tick is at the upper edge. Containment guard would
    // normally shift the range — verify it doesn't.
    const r = preserveRange(0, tickLower, tickUpper, feeTier, d0, d1, {
      offsetToken0Pct: 0,
    });
    assert.ok(
      r.upperTick <= spacing,
      "containment guard should be skipped for offset != 50",
    );
  });
});
