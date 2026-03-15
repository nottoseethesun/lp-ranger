'use strict';

/**
 * @file test/range-math-fuzz.test.js
 * @description Property-based fuzz tests for range-math.js.
 * Generates random inputs and verifies mathematical invariants hold
 * across the entire valid domain.
 */

const { describe, it } = require('node:test');
const assert = require('assert');
const {
  priceToTick, tickToPrice, computeNewRange, compositionRatio,
  sqrtPriceX96ToPrice, nearestUsableTick,
  TICK_SPACINGS, MIN_TICK, MAX_TICK,
} = require('../src/range-math');

// ── Fuzz helpers ────────────────────────────────────────────────────────────

const ITERATIONS = 500;
const FEE_TIERS = [100, 500, 2500, 3000, 10000];

/** Random float in [lo, hi] (log-uniform for wide ranges). */
function randLogFloat(lo, hi) {
  const logLo = Math.log(lo);
  const logHi = Math.log(hi);
  return Math.exp(logLo + Math.random() * (logHi - logLo));
}

/** Random integer in [lo, hi]. */
function randInt(lo, hi) {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/** Random fee tier. */
function randFee() { return FEE_TIERS[randInt(0, FEE_TIERS.length - 1)]; }

/** Run a property test N times, reporting the failing input on error. */
function fuzzRun(name, count, fn) {
  it(name + ` (${count} iterations)`, () => {
    for (let i = 0; i < count; i++) {
      fn(i);
    }
  });
}

// ── priceToTick / tickToPrice ───────────────────────────────────────────────

describe('Fuzz: priceToTick + tickToPrice', () => {
  fuzzRun('round-trip within 0.1% for valid prices', ITERATIONS, () => {
    const d0 = randInt(0, 18);
    const d1 = randInt(0, 18);
    const price = randLogFloat(1e-12, 1e12);
    const tick = priceToTick(price, d0, d1);
    const recovered = tickToPrice(tick, d0, d1);
    // tick is floor, so recovered may be slightly below price
    // check that recovered is within one tick step of price
    const nextPrice = tickToPrice(tick + 1, d0, d1);
    assert.ok(
      recovered <= price * 1.001 && nextPrice >= price * 0.999,
      `round-trip failed: price=${price}, tick=${tick}, recovered=${recovered}, next=${nextPrice}`,
    );
  });

  fuzzRun('monotonicity: higher price → higher or equal tick', ITERATIONS, () => {
    const d0 = randInt(0, 18);
    const d1 = randInt(0, 18);
    const p1 = randLogFloat(1e-10, 1e10);
    const p2 = p1 * (1 + Math.random()); // p2 > p1
    const t1 = priceToTick(p1, d0, d1);
    const t2 = priceToTick(p2, d0, d1);
    assert.ok(t2 >= t1, `monotonicity: p1=${p1} t1=${t1}, p2=${p2} t2=${t2}`);
  });

  fuzzRun('result is always a finite integer', ITERATIONS, () => {
    const d0 = randInt(0, 18);
    const d1 = randInt(0, 18);
    const price = randLogFloat(1e-15, 1e15);
    const tick = priceToTick(price, d0, d1);
    assert.ok(Number.isFinite(tick), `not finite: price=${price}`);
    assert.strictEqual(tick, Math.floor(tick), `not integer: tick=${tick}`);
  });
});

// ── computeNewRange ─────────────────────────────────────────────────────────

describe('Fuzz: computeNewRange', () => {
  fuzzRun('lowerTick < upperTick for all valid inputs', ITERATIONS, () => {
    const price = randLogFloat(1e-8, 1e8);
    const width = randInt(1, 99);
    const fee = randFee();
    const d0 = randInt(0, 18);
    const d1 = randInt(0, 18);
    const r = computeNewRange(price, width, fee, d0, d1);
    assert.ok(r.lowerTick < r.upperTick,
      `lower >= upper: ${r.lowerTick} >= ${r.upperTick} (price=${price}, w=${width}, fee=${fee})`);
  });

  fuzzRun('ticks within V3 int24 bounds', ITERATIONS, () => {
    const price = randLogFloat(1e-10, 1e10);
    const width = randInt(1, 99);
    const fee = randFee();
    const d0 = randInt(0, 18);
    const d1 = randInt(0, 18);
    const r = computeNewRange(price, width, fee, d0, d1);
    assert.ok(r.lowerTick >= MIN_TICK,
      `lowerTick ${r.lowerTick} < MIN_TICK (price=${price}, w=${width})`);
    assert.ok(r.upperTick <= MAX_TICK,
      `upperTick ${r.upperTick} > MAX_TICK (price=${price}, w=${width})`);
  });

  fuzzRun('ticks are multiples of fee tier spacing', ITERATIONS, () => {
    const price = randLogFloat(1e-6, 1e6);
    const width = randInt(1, 99);
    const fee = randFee();
    const spacing = TICK_SPACINGS[fee];
    const r = computeNewRange(price, width, fee, 18, 18);
    assert.ok(r.lowerTick % spacing === 0,
      `lowerTick ${r.lowerTick} not multiple of ${spacing}`);
    assert.ok(r.upperTick % spacing === 0,
      `upperTick ${r.upperTick} not multiple of ${spacing}`);
  });

  fuzzRun('lowerPrice > 0 and upperPrice > lowerPrice', ITERATIONS, () => {
    const price = randLogFloat(1e-8, 1e8);
    const width = randInt(1, 99);
    const fee = randFee();
    const r = computeNewRange(price, width, fee, 18, 18);
    assert.ok(r.lowerPrice > 0, `lowerPrice <= 0: ${r.lowerPrice}`);
    assert.ok(r.upperPrice > r.lowerPrice,
      `upper <= lower: ${r.upperPrice} <= ${r.lowerPrice}`);
  });

  fuzzRun('current price tick is within range', ITERATIONS, () => {
    const price = randLogFloat(1e-6, 1e6);
    const width = randInt(5, 95);
    const fee = randFee();
    const d0 = randInt(6, 18);
    const d1 = randInt(6, 18);
    const r = computeNewRange(price, width, fee, d0, d1);
    const currentTick = nearestUsableTick(priceToTick(price, d0, d1), fee);
    assert.ok(currentTick >= r.lowerTick && currentTick < r.upperTick,
      `currentTick ${currentTick} not in [${r.lowerTick}, ${r.upperTick}) ` +
      `(price=${price}, w=${width}, fee=${fee}, d0=${d0}, d1=${d1})`);
  });
});

// ── compositionRatio ────────────────────────────────────────────────────────

describe('Fuzz: compositionRatio', () => {
  fuzzRun('output always in [0, 1]', ITERATIONS, () => {
    const lower = randLogFloat(0.01, 1000);
    const upper = lower * (1 + Math.random() * 5);
    const current = randLogFloat(lower * 0.5, upper * 1.5);
    const r = compositionRatio(current, lower, upper);
    assert.ok(r >= 0 && r <= 1, `ratio=${r} for p=${current}, l=${lower}, u=${upper}`);
  });

  fuzzRun('monotonically decreasing as price rises', ITERATIONS, () => {
    const lower = randLogFloat(0.1, 100);
    const upper = lower * (1 + Math.random() * 3 + 0.1);
    const range = upper - lower;
    const p1 = lower + range * 0.3;
    const p2 = lower + range * 0.7;
    const r1 = compositionRatio(p1, lower, upper);
    const r2 = compositionRatio(p2, lower, upper);
    assert.ok(r1 >= r2 - 1e-10,
      `not monotonic: r(${p1})=${r1}, r(${p2})=${r2}`);
  });

  fuzzRun('returns 1 at lower boundary, 0 at upper', ITERATIONS, () => {
    const lower = randLogFloat(0.01, 1000);
    const upper = lower * (1 + Math.random() * 5 + 0.1);
    assert.strictEqual(compositionRatio(lower, lower, upper), 1);
    assert.strictEqual(compositionRatio(upper, lower, upper), 0);
  });
});

// ── sqrtPriceX96ToPrice ─────────────────────────────────────────────────────

describe('Fuzz: sqrtPriceX96ToPrice', () => {
  const Q96 = BigInt('0x1000000000000000000000000');

  fuzzRun('output is always a positive finite number', ITERATIONS, () => {
    // Generate random sqrtPriceX96 values in a realistic range
    const scale = BigInt(randInt(1, 1000000));
    const sqrtPrice = (Q96 * scale) / 1000n;
    const d0 = randInt(0, 18);
    const d1 = randInt(0, 18);
    const price = sqrtPriceX96ToPrice(sqrtPrice, d0, d1);
    assert.ok(Number.isFinite(price) && price > 0,
      `invalid price=${price} for sqrtPriceX96=${sqrtPrice}, d0=${d0}, d1=${d1}`);
  });

  fuzzRun('monotonically increasing in sqrtPriceX96', ITERATIONS, () => {
    const base = BigInt(randInt(1, 1000000));
    const sq1 = (Q96 * base) / 1000n;
    const sq2 = sq1 + BigInt(randInt(1, 1000000));
    const p1 = sqrtPriceX96ToPrice(sq1, 18, 18);
    const p2 = sqrtPriceX96ToPrice(sq2, 18, 18);
    assert.ok(p2 >= p1, `not monotonic: sq1=${sq1}→${p1}, sq2=${sq2}→${p2}`);
  });
});
