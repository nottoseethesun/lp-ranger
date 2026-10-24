/**
 * @file test/swap-gates.test.js
 * @description Unit tests for src/lib/swap-gates.js — the dust-then-gas
 * gate decision used by every swap call site.
 *
 * Tests are written threshold-agnostically: rather than asserting the
 * exact gold-pegged dust threshold (which depends on a live price feed
 * and can drift), we use values that are unambiguously dust ($0.001)
 * or unambiguously above dust ($1000) so the assertions hold regardless
 * of the live USD/gold price.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

// Before anything that reads a price loads: prices come from a fixed table.
require("./helpers/price-stand-ins");
const {
  GAS_FEE_PCT_MIN,
  GAS_FEE_PCT_MAX,
  GAS_FEE_PCT_DEFAULT,
  gasFeePctToRatio,
  shouldSkipSwap,
  estimateSwapGasUsd,
} = require("../src/lib/swap-gates");

// The gas limit each case holds a swap to: 1% of its value.
const LIMIT = 0.01;

describe("swap-gates", () => {
  describe("shouldSkipSwap", () => {
    it("skips with reason='dust' for sub-cent swap value", async () => {
      const res = await shouldSkipSwap({
        swapUsd: 0.001,
        gasUsd: 0,
        maxRatio: LIMIT,
      });
      assert.equal(res.skip, true);
      assert.equal(res.reason, "dust");
    });

    it("skips with reason='gas-unfavorable' when gas exceeds 1% of value", async () => {
      // $1000 swap, $50 gas — well above dust, gas-ratio = 0.05.
      const res = await shouldSkipSwap({
        swapUsd: 1000,
        gasUsd: 50,
        maxRatio: LIMIT,
      });
      assert.equal(res.skip, true);
      assert.equal(res.reason, "gas-unfavorable");
      assert.equal(res.gasRatio, 0.05);
    });

    it("passes when swap exceeds dust AND gas/value ≤ 1%", async () => {
      const res = await shouldSkipSwap({
        swapUsd: 1000,
        gasUsd: 5,
        maxRatio: LIMIT,
      });
      assert.equal(res.skip, false);
      assert.equal(res.reason, null);
      assert.equal(res.gasRatio, 0.005);
    });

    it("passes when gas estimate is 0 (gas-gate degrades to no-op)", async () => {
      const res = await shouldSkipSwap({
        swapUsd: 1000,
        gasUsd: 0,
        maxRatio: LIMIT,
      });
      assert.equal(res.skip, false);
    });

    it("dust gate runs FIRST: dust-rejected swap returns reason='dust' even when gas would also trip", async () => {
      // $0.001 swap (dust), $10 gas (gas/value = 10000× over).  Both
      // gates would skip; dust must win because it runs first.
      const res = await shouldSkipSwap({
        swapUsd: 0.001,
        gasUsd: 10,
        maxRatio: LIMIT,
      });
      assert.equal(res.reason, "dust");
    });

    it("gas-gate boundary: ratio exactly at 1% still passes (strict >)", async () => {
      const res = await shouldSkipSwap({
        swapUsd: 1000,
        gasUsd: 10,
        maxRatio: LIMIT,
      });
      assert.equal(res.skip, false);
      assert.equal(res.gasRatio, 0.01);
    });

    it("returns thresholdUsd > 0 from the gold-pegged dust module", async () => {
      const res = await shouldSkipSwap({
        swapUsd: 1000,
        gasUsd: 0,
        maxRatio: LIMIT,
      });
      assert.ok(res.thresholdUsd > 0);
    });

    it("holds a swap to the limit it is given (5% allows what 1% blocks)", async () => {
      // $1000 swap, $30 gas → ratio 0.03: over 1%, under 5%.
      const blocked = await shouldSkipSwap({
        swapUsd: 1000,
        gasUsd: 30,
        maxRatio: LIMIT,
      });
      assert.equal(blocked.skip, true);
      assert.equal(blocked.reason, "gas-unfavorable");
      const allowed = await shouldSkipSwap({
        swapUsd: 1000,
        gasUsd: 30,
        maxRatio: 0.05,
      });
      assert.equal(allowed.skip, false);
      assert.equal(allowed.maxRatio, 0.05);
    });

    it("returns the limit it applied in the result for logging", async () => {
      const res = await shouldSkipSwap({
        swapUsd: 1000,
        gasUsd: 5,
        maxRatio: LIMIT,
      });
      assert.equal(res.maxRatio, LIMIT);
      const res2 = await shouldSkipSwap({
        swapUsd: 1000,
        gasUsd: 5,
        maxRatio: 0.1,
      });
      assert.equal(res2.maxRatio, 0.1);
    });
  });

  describe("gasFeePctToRatio", () => {
    it("converts a normal percent to its ratio (1% → 0.01)", () => {
      assert.equal(gasFeePctToRatio(1), 0.01);
      assert.equal(gasFeePctToRatio(5), 0.05);
    });

    it("clamps below the floor up to GAS_FEE_PCT_MIN", () => {
      assert.equal(gasFeePctToRatio(0.001), GAS_FEE_PCT_MIN / 100);
    });

    it("clamps above the ceiling down to GAS_FEE_PCT_MAX", () => {
      assert.equal(gasFeePctToRatio(50), GAS_FEE_PCT_MAX / 100);
      assert.equal(gasFeePctToRatio(15.0001), GAS_FEE_PCT_MAX / 100);
    });

    it("uses GAS_FEE_PCT_DEFAULT for non-positive / non-finite / undefined", () => {
      const def = GAS_FEE_PCT_DEFAULT / 100;
      assert.equal(gasFeePctToRatio(undefined), def);
      assert.equal(gasFeePctToRatio(null), def);
      assert.equal(gasFeePctToRatio(0), def);
      assert.equal(gasFeePctToRatio(-3), def);
      assert.equal(gasFeePctToRatio(NaN), def);
      assert.equal(gasFeePctToRatio("not a number"), def);
    });

    it("parses numeric strings", () => {
      assert.equal(gasFeePctToRatio("2.5"), 0.025);
    });

    it("never returns a value outside (0, 0.15]", () => {
      for (const v of [-100, 0, 0.001, 1, 14.999, 15, 100, NaN, "abc"]) {
        const r = gasFeePctToRatio(v);
        assert.ok(r > 0, `${v} → ${r} should be > 0`);
        assert.ok(r <= 0.15, `${v} → ${r} should be ≤ 0.15`);
      }
    });
  });

  describe("estimateSwapGasUsd", () => {
    it("returns 0 when getFeeData throws (graceful degradation)", async () => {
      const provider = {
        getFeeData: async () => {
          throw new Error("rpc down");
        },
      };
      const usd = await estimateSwapGasUsd(provider);
      assert.equal(usd, 0);
    });

    it("never throws on a flaky provider", async () => {
      const provider = {
        getFeeData: async () => ({}), // no gasPrice / maxFeePerGas
      };
      // Should not throw — degrades to 0 internally.
      const usd = await estimateSwapGasUsd(provider);
      assert.equal(typeof usd, "number");
      assert.ok(Number.isFinite(usd));
    });
  });
});
