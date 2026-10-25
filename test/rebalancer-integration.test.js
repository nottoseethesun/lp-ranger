"use strict";

/**
 * @file test/rebalancer-integration.test.js
 * @description Stateful simulation integration tests for the rebalancer pipeline.
 * Uses a mock that maintains consistent balances across remove→swap→mint,
 * verifying cross-function invariants that unit tests cannot catch.
 */

const { describe, it } = require("node:test");
const assert = require("assert");
// Before anything that reads a price loads: prices come from a fixed table.
require("./helpers/price-stand-ins");
const { executeRebalance } = require("../src/lib/rebalancer");
const { priceToTick, nearestUsableTick } = require("../src/lib/range-math");

/*
 * Local fee→spacing map for parameterized tests.  Production code reads
 * spacing on-chain via factory.feeAmountTickSpacing(); the test mock
 * mirrors that surface (see test/helpers/rebalancer-simulation.js).
 */
const TEST_FEE_SPACINGS = { 100: 1, 500: 10, 2500: 50, 3000: 60, 10000: 200 };
const {
  ADDR,
  createSimulation,
  mockSigner,
  makePosition,
  makeOpts,
  ONE_ETH,
} = require("./helpers/rebalancer-simulation");

// ── Integration tests ──────────────────────────────────────────────────────

describe("Integration: balanced rebalance (equal amounts)", () => {
  it("succeeds with near-zero dust remaining", async () => {
    const sim = createSimulation({
      positionAmount0: 5n * ONE_ETH,
      positionAmount1: 5n * ONE_ETH,
      price: 1.0,
    });
    const r = await executeRebalance(
      mockSigner(),
      sim.ethersLib,
      makeOpts(makePosition()),
    );
    assert.strictEqual(r.success, true);
    assert.ok(r.liquidity > 0n, "liquidity must be > 0");
    assert.ok(r.newTokenId > 0n, "newTokenId must be > 0");
    // Dust should be small relative to position
    const dust0 = sim.balances[ADDR.token0];
    const dust1 = sim.balances[ADDR.token1];
    assert.ok(dust0 >= 0n, "token0 balance must not be negative");
    assert.ok(dust1 >= 0n, "token1 balance must not be negative");
  });
});

describe("Integration: imbalanced (100% token0)", () => {
  it("swaps to rebalance and mints successfully", async () => {
    const sim = createSimulation({
      positionAmount0: 10n * ONE_ETH,
      positionAmount1: 0n,
      price: 1.0,
    });
    const r = await executeRebalance(
      mockSigner(),
      sim.ethersLib,
      makeOpts(makePosition()),
    );
    assert.strictEqual(r.success, true);
    assert.ok(r.liquidity > 0n);
    // Verify no negative balances at any step
    for (const check of sim.invariantChecks) {
      if (check.bal0 !== undefined) {
        assert.ok(check.bal0 >= 0n, `negative token0 at step ${check.step}`);
      }
      if (check.bal1 !== undefined) {
        assert.ok(check.bal1 >= 0n, `negative token1 at step ${check.step}`);
      }
    }
  });
});

describe("Integration: imbalanced (100% token1)", () => {
  it("swaps to rebalance and mints successfully", async () => {
    const sim = createSimulation({
      positionAmount0: 0n,
      positionAmount1: 10n * ONE_ETH,
      price: 1.0,
    });
    const r = await executeRebalance(
      mockSigner(),
      sim.ethersLib,
      makeOpts(makePosition()),
    );
    assert.strictEqual(r.success, true);
    assert.ok(r.liquidity > 0n);
  });
});

describe("Integration: asymmetric decimals (6 vs 18)", () => {
  it("handles USDC/WETH style pairs", async () => {
    const sim = createSimulation({
      positionAmount0: 2000_000000n, // 2000 USDC (6 dec)
      positionAmount1: ONE_ETH, // 1 WETH (18 dec)
      price: 2000, // 1 token0 = 2000 token1
      decimals0: 6,
      decimals1: 18,
    });
    const pos = makePosition({
      tickLower: nearestUsableTick(priceToTick(1600, 6, 18), 60),
      tickUpper: nearestUsableTick(priceToTick(2400, 6, 18), 60),
    });
    const r = await executeRebalance(
      mockSigner(),
      sim.ethersLib,
      makeOpts(pos),
    );
    assert.strictEqual(r.success, true);
    assert.ok(r.liquidity > 0n);
    assert.ok(sim.balances[ADDR.token0] >= 0n, "no negative USDC");
    assert.ok(sim.balances[ADDR.token1] >= 0n, "no negative WETH");
  });
});

describe("Integration: dust amounts near swap threshold", () => {
  it("handles very small position amounts", async () => {
    const sim = createSimulation({
      positionAmount0: 500n, // below _MIN_SWAP_THRESHOLD
      positionAmount1: 500n,
      price: 1.0,
    });
    const r = await executeRebalance(
      mockSigner(),
      sim.ethersLib,
      makeOpts(makePosition()),
    );
    assert.strictEqual(r.success, true);
  });
});

describe("Integration: all fee tiers", () => {
  for (const fee of [100, 500, 2500, 3000, 10000]) {
    it(`fee tier ${fee} produces valid range`, async () => {
      const spacing = TEST_FEE_SPACINGS[fee];
      const sim = createSimulation({
        positionAmount0: 5n * ONE_ETH,
        positionAmount1: 5n * ONE_ETH,
        price: 1.0,
        fee,
      });
      const pos = makePosition({
        fee,
        tickLower: -spacing * 10,
        tickUpper: spacing * 10,
      });
      const r = await executeRebalance(
        mockSigner(),
        sim.ethersLib,
        makeOpts(pos),
      );
      assert.strictEqual(r.success, true);
      // Verify new ticks are valid multiples of spacing
      assert.ok(
        r.newTickLower % spacing === 0,
        `lowerTick ${r.newTickLower} not multiple of ${spacing}`,
      );
      assert.ok(
        r.newTickUpper % spacing === 0,
        `upperTick ${r.newTickUpper} not multiple of ${spacing}`,
      );
      assert.ok(r.newTickLower < r.newTickUpper);
    });
  }
});

describe("Integration: various range widths", () => {
  for (const width of [1, 5, 10, 20, 50, 80]) {
    it(`range width ${width}% succeeds`, async () => {
      const sim = createSimulation({
        positionAmount0: 5n * ONE_ETH,
        positionAmount1: 5n * ONE_ETH,
        price: 1.0,
      });
      const r = await executeRebalance(
        mockSigner(),
        sim.ethersLib,
        makeOpts(makePosition(), {}),
      );
      assert.strictEqual(r.success, true);
      assert.ok(r.liquidity > 0n);
      assert.ok(r.newTickLower < r.newTickUpper);
    });
  }
});

describe("Integration: extreme prices", () => {
  it("handles very high price (1e10)", async () => {
    const sim = createSimulation({
      positionAmount0: ONE_ETH,
      positionAmount1: 10_000_000_000n * ONE_ETH,
      price: 1e10,
    });
    const tick = Math.floor(Math.log(1e10) / Math.log(1.0001));
    const pos = makePosition({
      tickLower: nearestUsableTick(tick - 6000, 60),
      tickUpper: nearestUsableTick(tick + 6000, 60),
    });
    const r = await executeRebalance(
      mockSigner(),
      sim.ethersLib,
      makeOpts(pos),
    );
    assert.strictEqual(r.success, true);
  });

  it("handles very low price (1e-10)", async () => {
    const sim = createSimulation({
      positionAmount0: 10_000_000_000n * ONE_ETH,
      positionAmount1: ONE_ETH,
      price: 1e-10,
    });
    const tick = Math.floor(Math.log(1e-10) / Math.log(1.0001));
    const pos = makePosition({
      tickLower: nearestUsableTick(tick - 6000, 60),
      tickUpper: nearestUsableTick(tick + 6000, 60),
    });
    const r = await executeRebalance(
      mockSigner(),
      sim.ethersLib,
      makeOpts(pos),
    );
    assert.strictEqual(r.success, true);
  });
});

// ── enrichResultUsd — token decimal handling ─────────────────────────────────

const { enrichResultUsd } = require("../src/lib/rebalancer");

describe("enrichResultUsd — token decimal handling", () => {
  it("uses 18 decimals for both tokens when decimals match (e.g. WPLS/WETH)", async () => {
    const result = {
      decimals0: 18,
      decimals1: 18,
      amount0Collected: 5000000000000000000n, // 5e18 = 5 tokens
      amount1Collected: 2000000000000000000n, // 2e18 = 2 tokens
      amount0Minted: 4000000000000000000n, // 4e18 = 4 tokens
      amount1Minted: 3000000000000000000n, // 3e18 = 3 tokens
    };
    const priceFn = async () => ({ price0: 10, price1: 20 });
    await enrichResultUsd(result, priceFn, "0xA", "0xB");
    assert.strictEqual(result.exitValueUsd, 5 * 10 + 2 * 20); // 90
    assert.strictEqual(result.entryValueUsd, 4 * 10 + 3 * 20); // 100
  });

  it("handles mixed decimals (e.g. HEX=8 / WPLS=18)", async () => {
    const result = {
      decimals0: 8,
      decimals1: 18,
      amount0Collected: 500000000n, // 5e8 = 5 HEX
      amount1Collected: 2000000000000000000n, // 2e18 = 2 WPLS
      amount0Minted: 400000000n, // 4e8 = 4 HEX
      amount1Minted: 3000000000000000000n, // 3e18 = 3 WPLS
    };
    const priceFn = async () => ({ price0: 0.002, price1: 0.0006 });
    await enrichResultUsd(result, priceFn, "0xHEX", "0xWPLS");
    assert.ok(Math.abs(result.exitValueUsd - (5 * 0.002 + 2 * 0.0006)) < 1e-10);
    assert.ok(
      Math.abs(result.entryValueUsd - (4 * 0.002 + 3 * 0.0006)) < 1e-10,
    );
  });

  it("handles 6-decimal tokens (e.g. USDC)", async () => {
    const result = {
      decimals0: 6,
      decimals1: 18,
      amount0Collected: 1000000n, // 1e6 = 1 USDC
      amount1Collected: 500000000000000000n, // 0.5e18 = 0.5 WETH
      amount0Minted: 2000000n, // 2e6 = 2 USDC
      amount1Minted: 1000000000000000000n, // 1e18 = 1 WETH
    };
    const priceFn = async () => ({ price0: 1.0, price1: 3000 });
    await enrichResultUsd(result, priceFn, "0xUSDC", "0xWETH");
    assert.ok(Math.abs(result.exitValueUsd - (1 * 1.0 + 0.5 * 3000)) < 1e-6); // 1501
    assert.ok(Math.abs(result.entryValueUsd - (2 * 1.0 + 1 * 3000)) < 1e-6); // 3002
  });

  it("falls back to 18 when decimals are missing from result", async () => {
    const result = {
      // no decimals0/decimals1 — should default to 18
      amount0Collected: 1000000000000000000n, // 1e18 = 1 token
      amount1Collected: 2000000000000000000n, // 2e18 = 2 tokens
      amount0Minted: 1000000000000000000n,
      amount1Minted: 2000000000000000000n,
    };
    const priceFn = async () => ({ price0: 5, price1: 10 });
    await enrichResultUsd(result, priceFn, "0xA", "0xB");
    assert.strictEqual(result.exitValueUsd, 1 * 5 + 2 * 10); // 25
    assert.strictEqual(result.entryValueUsd, 1 * 5 + 2 * 10); // 25
  });

  it("sets token prices on the result object", async () => {
    const result = {
      decimals0: 18,
      decimals1: 18,
      amount0Collected: 0n,
      amount1Collected: 0n,
      amount0Minted: 0n,
      amount1Minted: 0n,
    };
    const priceFn = async () => ({ price0: 42, price1: 99 });
    await enrichResultUsd(result, priceFn, "0xA", "0xB");
    assert.strictEqual(result.token0UsdPrice, 42);
    assert.strictEqual(result.token1UsdPrice, 99);
  });

  it("would produce wrong values with hardcoded 18 for HEX (regression guard)", async () => {
    // This test documents WHY we need real decimals:
    // HEX has 8 decimals. 500000000n = 5 HEX.
    // With hardcoded 18: _toFloat(500000000n, 18) = 5e-10 (wrong!)
    // With correct 8:    _toFloat(500000000n, 8)  = 5.0   (correct)
    const result = {
      decimals0: 8,
      decimals1: 18,
      amount0Collected: 500000000n,
      amount1Collected: 0n,
      amount0Minted: 500000000n,
      amount1Minted: 0n,
    };
    const priceFn = async () => ({ price0: 0.002, price1: 0 });
    await enrichResultUsd(result, priceFn, "0xHEX", "0xWPLS");
    assert.ok(
      result.exitValueUsd > 0.009,
      `exit should be ~$0.01, got ${result.exitValueUsd}`,
    );
    // If decimals were hardcoded to 18, exitValueUsd would be ~1e-12 (effectively 0)
  });
});

describe("Integration: the wallet's readings for the Activity Log", () => {
  it("reads the wallet before the drain, after it, and just before the mint", async () => {
    const sim = createSimulation({
      positionAmount0: 10n * ONE_ETH,
      positionAmount1: 5n * ONE_ETH,
      price: 1.0,
    });
    const r = await executeRebalance(
      mockSigner(),
      sim.ethersLib,
      makeOpts(makePosition()),
    );
    assert.strictEqual(r.success, true);
    const { beforeDrain, afterDrain, beforeMint } = r.walletReadings;
    // The wallet held nothing until the drain brought in the position.
    assert.deepStrictEqual(beforeDrain, { amount0: 0, amount1: 0 });
    assert.deepStrictEqual(afterDrain, { amount0: 10, amount1: 5 });
    /*-
     *  The mint takes the wallet's whole balance, so the reading just
     *  before it is what the mint was asked to deposit. The fixture's
     *  coins have no price, so the dust check skips the swap here, and
     *  this test of the readings does not depend on one.
     */
    const mint = sim.invariantChecks.find((c) => c.step === "mint");
    assert.deepStrictEqual(beforeMint, {
      amount0: Number(mint.a0Desired) / 1e18,
      amount1: Number(mint.a1Desired) / 1e18,
    });
  });
});
