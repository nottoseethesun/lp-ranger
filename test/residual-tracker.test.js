/**
 * @file test/residual-tracker.test.js
 * @description Tests for the wallet residual tracker module.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createResidualTracker } = require("../src/lib/residual-tracker");

const POOL_A = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
const POOL_B = "0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb";

describe("residual-tracker", () => {
  it("starts with zero residuals", () => {
    const rt = createResidualTracker();
    const r = rt.getResidual(POOL_A);
    assert.equal(r.token0, 0n);
    assert.equal(r.token1, 0n);
  });

  it("accumulates deltas across multiple rebalances", () => {
    const rt = createResidualTracker();
    rt.addDelta(POOL_A, 100n, 200n);
    rt.addDelta(POOL_A, 50n, 30n);
    const r = rt.getResidual(POOL_A);
    assert.equal(r.token0, 150n);
    assert.equal(r.token1, 230n);
  });

  it("floors negative residuals at zero", () => {
    const rt = createResidualTracker();
    rt.addDelta(POOL_A, 100n, 50n);
    rt.addDelta(POOL_A, -200n, -10n);
    const r = rt.getResidual(POOL_A);
    assert.equal(r.token0, 0n);
    assert.equal(r.token1, 40n);
  });

  it("tracks pools independently", () => {
    const rt = createResidualTracker();
    rt.addDelta(POOL_A, 100n, 0n);
    rt.addDelta(POOL_B, 0n, 500n);
    assert.equal(rt.getResidual(POOL_A).token0, 100n);
    assert.equal(rt.getResidual(POOL_A).token1, 0n);
    assert.equal(rt.getResidual(POOL_B).token0, 0n);
    assert.equal(rt.getResidual(POOL_B).token1, 500n);
  });

  it("cappedValueUsd uses full residual when wallet has enough", () => {
    const rt = createResidualTracker();
    rt.addDelta(POOL_A, 1_000_000n, 2_000_000n); // 1.0 token0, 2.0 token1 (6 dec)
    const usd = rt.cappedValueUsd(POOL_A, 5_000_000n, 5_000_000n, 10, 5, 6, 6);
    // expected: 1.0 * 10 + 2.0 * 5 = 20.0
    assert.equal(usd, 20);
  });

  it("cappedValueUsd caps to wallet balance when wallet has less", () => {
    const rt = createResidualTracker();
    rt.addDelta(POOL_A, 1_000_000n, 2_000_000n);
    // wallet only has 0.5 token0 and 1.0 token1
    const usd = rt.cappedValueUsd(POOL_A, 500_000n, 1_000_000n, 10, 5, 6, 6);
    // expected: 0.5 * 10 + 1.0 * 5 = 10.0
    assert.equal(usd, 10);
  });

  it("cappedValueUsd returns 0 for unknown pool", () => {
    const rt = createResidualTracker();
    const usd = rt.cappedValueUsd(POOL_A, 1000n, 1000n, 10, 10, 6, 6);
    assert.equal(usd, 0);
  });

  it("serialize / deserialize round-trips correctly", () => {
    const rt = createResidualTracker();
    rt.addDelta(POOL_A, 12345n, 67890n);
    rt.addDelta(POOL_B, 111n, 222n);
    const data = rt.serialize();

    const rt2 = createResidualTracker();
    rt2.deserialize(data);
    assert.equal(rt2.getResidual(POOL_A).token0, 12345n);
    assert.equal(rt2.getResidual(POOL_A).token1, 67890n);
    assert.equal(rt2.getResidual(POOL_B).token0, 111n);
    assert.equal(rt2.getResidual(POOL_B).token1, 222n);
  });

  it("deserialize handles null/undefined gracefully", () => {
    const rt = createResidualTracker();
    rt.deserialize(null);
    rt.deserialize(undefined);
    assert.equal(rt.getResidual(POOL_A).token0, 0n);
  });

  it("normalises pool address case", () => {
    const rt = createResidualTracker();
    rt.addDelta(POOL_A.toLowerCase(), 100n, 200n);
    const r = rt.getResidual(POOL_A.toUpperCase());
    assert.equal(r.token0, 100n);
    assert.equal(r.token1, 200n);
  });
});
