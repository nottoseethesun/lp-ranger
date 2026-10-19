"use strict";

/**
 * @file test/compounder-swap.test.js
 * @description The compound flow's ratio-correcting swap, end to end:
 *   when it skips, when it swaps, and which way and at whose slippage.
 *
 *   A compound collects fees and re-deposits them into the same position.
 *   When the collected coins do not fit the position's ratio, one side is
 *   swapped first so the deposit takes all of it. The ratio math here is
 *   the real `computeDesiredAmounts`, fed real tick ranges. Only the
 *   effects are stubbed: the USD price lookup, the gas estimate and the
 *   dust-and-gas gate (each covered in its own suite), and the swap
 *   itself.
 *
 *   The default slippage is an operator's own here, 1.1%, not the 0.75%
 *   that ships, so a figure written into the code fails.
 */

const fs = require("fs");
const path = require("path");
const { makeTestTempFolder } = require("../src/test-temp-folders");

const SETTINGS_DIR = makeTestTempFolder("compounder-swap-settings");
fs.writeFileSync(
  path.join(SETTINGS_DIR, "bot-config-defaults.json"),
  JSON.stringify({ slippagePct: 1.1 }),
);
process.env.LP_RANGER_USER_CONFIG_DIR = SETTINGS_DIR;

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

/*-
 *  Load the real modules first, then swap stand-ins into the module cache
 *  so `compounder-swap` — required last — binds to them. Each stand-in
 *  forwards to a per-test function in `stub`.
 */
const realSwap = require("../src/rebalancer-swap");
const realGates = require("../src/swap-gates");
const realPrices = require("../src/price-fetcher");

const stub = {};
function replace(id, exports) {
  require.cache[require.resolve(id)].exports = exports;
}
replace("../src/rebalancer-swap", {
  ...realSwap,
  swapIfNeeded: (...a) => stub.swap(...a),
});
replace("../src/swap-gates", {
  ...realGates,
  estimateSwapGasUsd: (...a) => stub.gasUsd(...a),
  shouldSkipSwap: (...a) => stub.gate(...a),
});
replace("../src/price-fetcher", {
  ...realPrices,
  fetchTokenPriceUsd: (...a) => stub.price(...a),
});

const { swapForCompound } = require("../src/compounder-swap");

const T0 = "0xA1077a294dDE1B09bB078844df40758a5D0f9a27";
const T1 = "0x7b39712EF45F7dcED2bBDF11F3D5046bA61dA719";
const ONE = 10n ** 18n;
const SIGNER = { provider: { name: "provider" } };
const LIB = { name: "ethers" };

/** Compound opts for a position at tick 0, with the given range. */
function opts(tickLower, tickUpper, extra = {}) {
  return {
    token0: T0,
    token1: T1,
    token0Symbol: "WPLS",
    token1Symbol: "9MM",
    decimals0: 18,
    decimals1: 18,
    fee: 2500,
    recipient: "0x4e44847675763D5540B32Bee8a713CfDcb4bE61A",
    tokenId: 7,
    swapRouterAddress: "0xROUTER",
    approvalMultiple: 3,
    gasFeePct: 2,
    slippagePctToken0: 0.4,
    slippagePctToken1: 1.2,
    poolState: { price: 1.0, tick: 0 },
    tickLower,
    tickUpper,
    ...extra,
  };
}

/** A gate answer, in `shouldSkipSwap`'s shape. */
const gate = (skip, reason) => ({
  skip,
  reason,
  thresholdUsd: 1,
  gasRatio: 0.01,
  maxRatio: 0.02,
});

beforeEach(() => {
  stub.calls = { swap: [], gate: [], price: [] };
  stub.price = async (addr) => {
    stub.calls.price.push(addr);
    return 2;
  };
  stub.gasUsd = async () => 0.05;
  stub.gate = async (args) => {
    stub.calls.gate.push(args);
    return gate(false, null);
  };
  stub.swap = async (_signer, _lib, params) => {
    stub.calls.swap.push(params);
    return { gasCostWei: 123n, txHash: "0xswap" };
  };
});

describe("swapForCompound", () => {
  it("skips when the pool state or range was not passed", async () => {
    const out = await swapForCompound(
      SIGNER,
      LIB,
      opts(600, 1200, { poolState: null }),
      ONE,
      ONE,
    );
    assert.deepEqual(out, {
      gasCostWei: 0n,
      txHash: null,
      gateReason: null,
      swapped: false,
    });
    assert.equal(stub.calls.swap.length, 0);
  });

  it("skips when the collected coins already fit the range", async () => {
    /*-
     *  A range wholly above the current tick takes only token0, and only
     *  token0 was collected: nothing to convert.
     */
    const out = await swapForCompound(SIGNER, LIB, opts(600, 1200), ONE, 0n);
    assert.equal(out.gateReason, "no-swap-needed");
    assert.equal(out.swapped, false);
    assert.equal(stub.calls.gate.length, 0);
    assert.equal(stub.calls.swap.length, 0);
  });

  it("skips a swap the dust gate refuses, without swapping", async () => {
    stub.gate = async (args) => {
      stub.calls.gate.push(args);
      return gate(true, "dust");
    };
    const out = await swapForCompound(SIGNER, LIB, opts(600, 1200), 0n, ONE);
    assert.deepEqual(out, {
      gasCostWei: 0n,
      txHash: null,
      gateReason: "dust",
      swapped: false,
    });
    assert.equal(stub.calls.swap.length, 0);
  });

  it("skips a swap whose gas would outweigh it", async () => {
    stub.gate = async () => gate(true, "gas-unfavorable");
    const out = await swapForCompound(SIGNER, LIB, opts(600, 1200), 0n, ONE);
    assert.equal(out.gateReason, "gas-unfavorable");
    assert.equal(stub.calls.swap.length, 0);
  });

  it("prices the swap in USD from the coin it sells, for the gate", async () => {
    /*-
     *  Range above the tick takes only token0, so the collected token1 is
     *  sold: the gate must see token1's price and amount, and the
     *  operator's gas ceiling as a ratio.
     */
    await swapForCompound(SIGNER, LIB, opts(600, 1200), 0n, 3n * ONE);
    assert.deepEqual(stub.calls.price, [T1]);
    assert.deepEqual(stub.calls.gate, [
      { swapUsd: 6, gasUsd: 0.05, maxRatio: 0.02 },
    ]);
  });

  it("swaps token1 into token0 at token0's slippage when the range needs token0", async () => {
    const out = await swapForCompound(
      SIGNER,
      LIB,
      opts(600, 1200),
      0n,
      3n * ONE,
    );
    assert.deepEqual(out, {
      gasCostWei: 123n,
      txHash: "0xswap",
      gateReason: null,
      swapped: true,
    });
    const [p] = stub.calls.swap;
    assert.equal(p.tokenIn, T1);
    assert.equal(p.tokenOut, T0);
    assert.equal(p.amountIn, 3n * ONE);
    assert.equal(p.isToken0To1, false);
    // Chosen by destination: the coin bought is token0.
    assert.equal(p.slippagePct, 0.4);
    assert.equal(p.symbolIn, "9MM");
    assert.equal(p.symbolOut, "WPLS");
    assert.equal(p.decimalsIn, 18);
    assert.equal(p.decimalsOut, 18);
    assert.equal(p.currentPrice, 1.0);
    assert.equal(p.fee, 2500);
    assert.equal(p.swapRouterAddress, "0xROUTER");
    assert.equal(p.recipient, opts(0, 0).recipient);
    assert.equal(p.approvalMultiple, 3);
  });

  it("swaps token0 into token1 at token1's slippage when the range needs token1", async () => {
    // A range wholly below the current tick takes only token1.
    await swapForCompound(SIGNER, LIB, opts(-1200, -600), 2n * ONE, 0n);
    const [p] = stub.calls.swap;
    assert.equal(p.tokenIn, T0);
    assert.equal(p.tokenOut, T1);
    assert.equal(p.amountIn, 2n * ONE);
    assert.equal(p.isToken0To1, true);
    assert.equal(p.slippagePct, 1.2);
    assert.deepEqual(stub.calls.price, [T0]);
  });

  it("falls back to the default slippage when the bought coin has none", async () => {
    await swapForCompound(
      SIGNER,
      LIB,
      opts(600, 1200, { slippagePctToken0: undefined }),
      0n,
      ONE,
    );
    assert.equal(stub.calls.swap[0].slippagePct, 1.1);
  });

  it("lets a failed swap reach the compound, which decides what to do", async () => {
    stub.swap = async () => {
      throw new Error("router reverted");
    };
    await assert.rejects(
      swapForCompound(SIGNER, LIB, opts(600, 1200), 0n, ONE),
      /router reverted/,
    );
  });
});
