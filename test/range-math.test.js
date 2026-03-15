/**
 * @file test/range-math.test.js
 * @description Unit tests for the range-math module.
 * Run with: npm test
 */

'use strict';
const { describe, it } = require('node:test');

const assert = require('assert');
const {
  sqrtPriceX96ToPrice,
  priceToTick,
  tickToPrice,
  nearestUsableTick,
  computeNewRange,
  compositionRatio,
  isInRange,
  isNearEdge,
  TICK_SPACINGS,
} = require('../src/range-math');

// ── sqrtPriceX96ToPrice ───────────────────────────────────────────────────────

describe('sqrtPriceX96ToPrice', () => {
  it('converts a known sqrtPriceX96 within a reasonable range', () => {
    // For equal-decimals token pair, price ≈ (sqrtPriceX96/2^96)^2
    const Q96 = BigInt('0x1000000000000000000000000');
    // Set sqrtPriceX96 so that price = 1.0 (same decimals)
    const sqrtOneX96 = Q96; // sqrt(1) × 2^96 = Q96
    const price = sqrtPriceX96ToPrice(sqrtOneX96, 18, 18);
    assert.ok(Math.abs(price - 1.0) < 1e-9, `expected ≈1.0, got ${price}`);
  });

  it('adjusts for decimal difference', () => {
    // USDC (6 decimals) / WETH (18 decimals) — price should be tiny
    const Q96 = BigInt('0x1000000000000000000000000');
    const price = sqrtPriceX96ToPrice(Q96, 18, 6);
    // With equal sqrtPriceX96=Q96 (raw ratio=1), adjusted = 1×10^(18-6) = 1e12
    assert.ok(price > 1e10);
  });

  it('accepts string input', () => {
    const Q96str = '79228162514264337593543950336'; // 2^96
    const price  = sqrtPriceX96ToPrice(Q96str, 18, 18);
    assert.ok(Math.abs(price - 1.0) < 1e-9);
  });
});

// ── priceToTick / tickToPrice round-trip ──────────────────────────────────────

describe('priceToTick and tickToPrice', () => {
  it('round-trips for same decimals', () => {
    const price    = 0.00042;
    const tick     = priceToTick(price, 18, 18);
    const recovered = tickToPrice(tick, 18, 18);
    // Tick is floored so recovered ≤ original; within one tick-step ≈ 0.01%
    assert.ok(Math.abs(recovered - price) / price < 0.001);
  });

  it('higher price → higher tick (same decimals)', () => {
    const t1 = priceToTick(0.0001, 18, 18);
    const t2 = priceToTick(0.001,  18, 18);
    assert.ok(t2 > t1, `tick for 0.001 (${t2}) should exceed tick for 0.0001 (${t1})`);
  });

  it('tick 0 → price 1 for equal decimals', () => {
    const price = tickToPrice(0, 18, 18);
    assert.ok(Math.abs(price - 1) < 1e-9);
  });
});

// ── nearestUsableTick ─────────────────────────────────────────────────────────

describe('nearestUsableTick', () => {
  it('rounds to spacing=60 for fee 3000', () => {
    const t = nearestUsableTick(205, 3000);
    assert.strictEqual(t % 60, 0);
  });

  it('rounds to spacing=10 for fee 500', () => {
    const t = nearestUsableTick(205, 500);
    assert.strictEqual(t % 10, 0);
  });

  it('rounds to spacing=200 for fee 10000', () => {
    const t = nearestUsableTick(205, 10000);
    assert.strictEqual(t % 200, 0);
  });

  it('falls back to spacing=60 for unknown fee tier', () => {
    const t = nearestUsableTick(205, 9999);
    assert.strictEqual(t % 60, 0);
  });

  it('returns exact multiple when already aligned', () => {
    assert.strictEqual(nearestUsableTick(240, 3000), 240);
  });
});

// ── computeNewRange ───────────────────────────────────────────────────────────

describe('computeNewRange', () => {
  const price    = 0.00042;
  const widthPct = 20;
  const feeTier  = 3000;
  const d0 = 18, d1 = 6;

  it('lowerPrice is close to (1 − widthPct/100) × price (tick-snapped)', () => {
    const { lowerPrice } = computeNewRange(price, widthPct, feeTier, d0, d1);
    // Tick-derived price won't be exact, but should be within 2% of the target
    assert.ok(Math.abs(lowerPrice - price * 0.8) / price < 0.02,
      `lowerPrice ${lowerPrice} too far from ${price * 0.8}`);
  });

  it('upperPrice is close to (1 + widthPct/100) × price (tick-snapped)', () => {
    const { upperPrice } = computeNewRange(price, widthPct, feeTier, d0, d1);
    assert.ok(Math.abs(upperPrice - price * 1.2) / price < 0.02,
      `upperPrice ${upperPrice} too far from ${price * 1.2}`);
  });

  it('lowerTick < upperTick always', () => {
    const { lowerTick, upperTick } = computeNewRange(price, widthPct, feeTier, d0, d1);
    assert.ok(lowerTick < upperTick);
  });

  it('ticks are multiples of the fee tier spacing', () => {
    const { lowerTick, upperTick } = computeNewRange(price, widthPct, feeTier, d0, d1);
    // Use Math.abs to handle JS negative-zero: (-356340 % 60) === -0 which !== 0 in strict equality
    assert.strictEqual(Math.abs(lowerTick % TICK_SPACINGS[feeTier]), 0);
    assert.strictEqual(Math.abs(upperTick % TICK_SPACINGS[feeTier]), 0);
  });

  it('works for very narrow ranges (1%)', () => {
    const { lowerTick, upperTick } = computeNewRange(price, 1, feeTier, d0, d1);
    assert.ok(lowerTick < upperTick);
  });

  it('works for very wide ranges (100%)', () => {
    const { lowerTick, upperTick } = computeNewRange(price, 100, feeTier, d0, d1);
    assert.ok(lowerTick < upperTick);
  });
});

// ── compositionRatio ─────────────────────────────────────────────────────────

describe('compositionRatio', () => {
  it('returns 1 when price is at or below lower', () => {
    assert.strictEqual(compositionRatio(0.5, 1, 2), 1);
    assert.strictEqual(compositionRatio(1,   1, 2), 1);
  });

  it('returns 0 when price is at or above upper', () => {
    assert.strictEqual(compositionRatio(2, 1, 2), 0);
    assert.strictEqual(compositionRatio(3, 1, 2), 0);
  });

  it('returns a value between 0 and 1 at midpoint (V3 sqrt formula)', () => {
    // With V3 sqrt-price formula, midpoint of [1, 3] is NOT exactly 0.5
    const r = compositionRatio(2, 1, 3);
    assert.ok(r > 0 && r < 1, `expected ratio in (0,1), got ${r}`);
  });

  it('output is in [0, 1]', () => {
    for (const p of [0, 0.5, 1, 1.5, 2, 2.5, 3]) {
      const r = compositionRatio(p, 1, 2);
      assert.ok(r >= 0 && r <= 1, `compositionRatio(${p}) = ${r} is out of bounds`);
    }
  });
});

// ── isInRange ─────────────────────────────────────────────────────────────────

describe('isInRange', () => {
  it('returns true when price is within bounds', () => {
    assert.strictEqual(isInRange(1.5, 1, 2), true);
  });

  it('returns true at exact bounds (inclusive)', () => {
    assert.strictEqual(isInRange(1, 1, 2), true);
    assert.strictEqual(isInRange(2, 1, 2), true);
  });

  it('returns false when price is outside bounds', () => {
    assert.strictEqual(isInRange(0.9, 1, 2), false);
    assert.strictEqual(isInRange(2.1, 1, 2), false);
  });
});

// ── isNearEdge ────────────────────────────────────────────────────────────────

describe('isNearEdge', () => {
  it('returns false when price is in the middle', () => {
    // range [1, 3], buffer 10% of width = 0.2. Near edge if < 1.2 or > 2.8
    assert.strictEqual(isNearEdge(2, 1, 3, 10), false);
  });

  it('returns true when price is within the lower buffer', () => {
    assert.strictEqual(isNearEdge(1.1, 1, 3, 10), true);
  });

  it('returns true when price is within the upper buffer', () => {
    assert.strictEqual(isNearEdge(2.9, 1, 3, 10), true);
  });

  it('returns false at the edge-buffer boundary', () => {
    // lower buffer = 1 + 0.2 = 1.2; exactly at 1.2 is NOT near edge
    assert.strictEqual(isNearEdge(1.2, 1, 3, 10), false);
  });
});

// ── sqrtPriceX96ToPrice — precision for large values ─────────────────────────

describe('sqrtPriceX96ToPrice — precision', () => {
  it('handles a realistic WETH/USDC sqrtPriceX96', () => {
    // sqrtPriceX96 for ~2000 USDC/WETH (token0=USDC-6, token1=WETH-18)
    // sqrt(2000 * 10^(18-6)) / 2^96 → sqrtPriceX96 ≈ 3.54e30
    // We use a known value: sqrt(2000 * 1e12) * 2^96
    const sqrtP = BigInt(Math.floor(Math.sqrt(2000 * 1e12))) * BigInt('0x1000000000000000000000000');
    const price = sqrtPriceX96ToPrice(sqrtP, 6, 18);
    // Should be close to 2000
    assert.ok(Math.abs(price - 2000) / 2000 < 0.01,
      `expected ≈2000, got ${price}`);
  });

  it('handles very small sqrtPriceX96 (low price)', () => {
    // sqrtPriceX96 for price ≈ 0.0001 (equal decimals)
    // sqrt(0.0001) * 2^96 = 0.01 * 2^96
    const Q96 = BigInt('0x1000000000000000000000000');
    const sqrtP = Q96 / 100n;
    const price = sqrtPriceX96ToPrice(sqrtP, 18, 18);
    assert.ok(Math.abs(price - 0.0001) / 0.0001 < 0.01,
      `expected ≈0.0001, got ${price}`);
  });
});

// ── compositionRatio — V3 sqrt-price formula ─────────────────────────────────

describe('compositionRatio — V3 sqrt formula', () => {
  it('returns 1 at lower boundary (100% token0)', () => {
    assert.strictEqual(compositionRatio(100, 100, 200), 1);
  });

  it('returns 0 at upper boundary (100% token1)', () => {
    assert.strictEqual(compositionRatio(200, 100, 200), 0);
  });

  it('ratio decreases as price increases', () => {
    const r1 = compositionRatio(110, 100, 200);
    const r2 = compositionRatio(150, 100, 200);
    const r3 = compositionRatio(190, 100, 200);
    assert.ok(r1 > r2, 'ratio should decrease as price moves up');
    assert.ok(r2 > r3, 'ratio should decrease as price moves up');
  });

  it('is always in [0, 1] for prices within range', () => {
    for (let p = 101; p < 200; p += 10) {
      const r = compositionRatio(p, 100, 200);
      assert.ok(r >= 0 && r <= 1, `ratio ${r} at price ${p} out of bounds`);
    }
  });
});

// ── computeNewRange — tick-derived prices ────────────────────────────────────

describe('computeNewRange — tick-derived prices', () => {
  it('returned prices correspond to returned ticks', () => {
    const { lowerTick, upperTick, lowerPrice, upperPrice } = computeNewRange(1.0, 20, 3000, 18, 18);
    const derivedLower = tickToPrice(lowerTick, 18, 18);
    const derivedUpper = tickToPrice(upperTick, 18, 18);
    assert.ok(Math.abs(lowerPrice - derivedLower) < 1e-12,
      `lowerPrice ${lowerPrice} != tickToPrice(${lowerTick}) = ${derivedLower}`);
    assert.ok(Math.abs(upperPrice - derivedUpper) < 1e-12,
      `upperPrice ${upperPrice} != tickToPrice(${upperTick}) = ${derivedUpper}`);
  });

  it('supports fee tier 100 (1 bps, tick spacing 1)', () => {
    const { lowerTick, upperTick } = computeNewRange(1.0, 10, 100, 18, 18);
    assert.ok(lowerTick < upperTick);
    // Ticks should be integers (use Math.abs to avoid -0)
    assert.strictEqual(Math.abs(lowerTick % 1), 0);
    assert.strictEqual(Math.abs(upperTick % 1), 0);
  });

  it('fee tier 100 produces a tighter range than fee tier 3000', () => {
    const r100  = computeNewRange(1.0, 10, 100, 18, 18);
    const r3000 = computeNewRange(1.0, 10, 3000, 18, 18);
    // Same widthPct but tick spacing 1 vs 60 — 100 has more granularity
    const width100  = r100.upperTick - r100.lowerTick;
    const width3000 = r3000.upperTick - r3000.lowerTick;
    assert.ok(width100 <= width3000,
      `fee=100 width ${width100} should be <= fee=3000 width ${width3000}`);
  });
});
