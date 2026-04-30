/**
 * @file test/swap-gates.test.js
 * @description Unit tests for src/swap-gates.js — the dust-then-gas
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

const {
  MAX_SWAP_GAS_RATIO,
  shouldSkipSwap,
  estimateSwapGasUsd,
} = require("../src/swap-gates");

describe("swap-gates", () => {
  describe("MAX_SWAP_GAS_RATIO", () => {
    it("is exposed as a module-level const set to 1%", () => {
      assert.equal(MAX_SWAP_GAS_RATIO, 0.01);
    });
  });

  describe("shouldSkipSwap", () => {
    it("skips with reason='dust' for sub-cent swap value", async () => {
      const res = await shouldSkipSwap({ swapUsd: 0.001, gasUsd: 0 });
      assert.equal(res.skip, true);
      assert.equal(res.reason, "dust");
    });

    it("skips with reason='gas-unfavorable' when gas exceeds 1% of value", async () => {
      // $1000 swap, $50 gas — well above dust, gas-ratio = 0.05.
      const res = await shouldSkipSwap({ swapUsd: 1000, gasUsd: 50 });
      assert.equal(res.skip, true);
      assert.equal(res.reason, "gas-unfavorable");
      assert.ok(res.gasRatio > MAX_SWAP_GAS_RATIO);
    });

    it("passes when swap exceeds dust AND gas/value ≤ 1%", async () => {
      const res = await shouldSkipSwap({ swapUsd: 1000, gasUsd: 5 });
      assert.equal(res.skip, false);
      assert.equal(res.reason, null);
      assert.equal(res.gasRatio, 0.005);
    });

    it("passes when gas estimate is 0 (gas-gate degrades to no-op)", async () => {
      const res = await shouldSkipSwap({ swapUsd: 1000, gasUsd: 0 });
      assert.equal(res.skip, false);
    });

    it("dust gate runs FIRST: dust-rejected swap returns reason='dust' even when gas would also trip", async () => {
      // $0.001 swap (dust), $10 gas (gas/value = 10000× over).  Both
      // gates would skip; dust must win because it runs first.
      const res = await shouldSkipSwap({ swapUsd: 0.001, gasUsd: 10 });
      assert.equal(res.reason, "dust");
    });

    it("gas-gate boundary: ratio exactly at 1% still passes (strict >)", async () => {
      const res = await shouldSkipSwap({ swapUsd: 1000, gasUsd: 10 });
      assert.equal(res.skip, false);
      assert.equal(res.gasRatio, 0.01);
    });

    it("returns thresholdUsd > 0 from the gold-pegged dust module", async () => {
      const res = await shouldSkipSwap({ swapUsd: 1000, gasUsd: 0 });
      assert.ok(res.thresholdUsd > 0);
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
