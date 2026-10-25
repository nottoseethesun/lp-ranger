"use strict";

/**
 * @file test/rebalancer-correct-branches.test.js
 * @description The corrective swap's other half: the token1 → token0
 *   direction, stopping because gas would outweigh the swap, stopping on
 *   a later iteration, unknown coin symbols, and swaps that report no gas
 *   or hash.
 *
 *   After a rebalance's main swap moves the pool's tick, the corrective
 *   loop re-reads the pool and swaps again — up to three times — until
 *   the wallet's coins fit the new range. Its collaborators are stubbed
 *   in the module cache (pool state, the ratio math, the swap, prices,
 *   the dust threshold, the swap gates and the log), so each test scripts
 *   what the pool and the gates answer on each iteration.
 *   `rebalancer-correct.test.js` covers the token0 → token1 runs.
 */

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const util = require("util");

const realLog = require("../src/lib/log");
const SHIPPED_DEFAULTS = require("../app-config/app-defaults-for-user-configurable/bot-config-defaults.json");

const PATHS = {
  pools: require.resolve("../src/lib/rebalancer-pools"),
  swap: require.resolve("../src/lib/rebalancer-swap"),
  price: require.resolve("../src/lib/price-fetcher"),
  dust: require.resolve("../src/lib/dust"),
  gates: require.resolve("../src/lib/swap-gates"),
  log: require.resolve("../src/lib/log"),
  correct: require.resolve("../src/lib/rebalancer-correct"),
};

const T0 = "0xT0";
const T1 = "0xT1";
// Distinct decimals, so a test can tell which side was read.
const POOL = { tick: 0, price: 1.0, decimals0: 18, decimals1: 6 };

const need = (swapDirection, swapAmount) => ({
  needsSwap: true,
  swapDirection,
  swapAmount,
});
const NO_NEED = { needsSwap: false, swapDirection: null, swapAmount: 0n };
const PASS = { skip: false, reason: null, gasRatio: 0.01, maxRatio: 0.02 };
const DUST = { skip: true, reason: "dust", gasRatio: 0, maxRatio: 0.02 };
const GAS = {
  skip: true,
  reason: "gas-unfavorable",
  gasRatio: 0.5,
  maxRatio: 0.02,
};

const cacheEntry = (id, exports) => ({
  id,
  filename: id,
  loaded: true,
  exports,
});

/** Each scripted answer is used once, in order; the last one repeats. */
function script(answers) {
  const left = answers.slice();
  return () => (left.length > 1 ? left.shift() : left[0]);
}

/**
 * Install the stubs and load a fresh `rebalancer-correct` against them.
 * @returns {{ run: Function, calls: object }}
 */
function load({ desired, gates, swaps }) {
  const calls = { swaps: [], gates: [], prices: [], logs: [] };
  const nextDesired = script(desired);
  const nextGate = script(gates);
  const nextSwap = script(swaps);
  const record = (...a) => calls.logs.push(util.format(...a));
  require.cache[PATHS.pools] = cacheEntry(PATHS.pools, {
    ERC20_ABI: [],
    getPoolState: async () => POOL,
    _MIN_SWAP_THRESHOLD: 1000n,
  });
  require.cache[PATHS.swap] = cacheEntry(PATHS.swap, {
    computeDesiredAmounts: () => nextDesired(),
    swapIfNeeded: async (_signer, _lib, params) => {
      calls.swaps.push(params);
      // A scripted Error is the swap failing.
      const answer = nextSwap();
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });
  require.cache[PATHS.price] = cacheEntry(PATHS.price, {
    fetchTokenPriceUsd: async (addr) => {
      calls.prices.push(addr);
      return 2;
    },
  });
  require.cache[PATHS.dust] = cacheEntry(PATHS.dust, {
    getDustThresholdUsd: async () => ({
      thresholdUsd: 1,
      usdPerUnit: 4800,
      units: 1 / 4800,
      usedFallback: false,
    }),
  });
  require.cache[PATHS.gates] = cacheEntry(PATHS.gates, {
    gasFeePctToRatio: () => 0.02,
    estimateSwapGasUsd: async () => 0.5,
    shouldSkipSwap: async (args) => {
      calls.gates.push(args);
      return nextGate();
    },
  });
  require.cache[PATHS.log] = cacheEntry(PATHS.log, {
    ...realLog,
    log: { ...realLog.log, info: record, warn: record },
  });
  delete require.cache[PATHS.correct];
  const { correctivelyRebalanceIfNeeded } = require(PATHS.correct);
  const lib = {
    Contract: function MockContract(addr) {
      this.balanceOf = async () => (addr === T0 ? 5n : 7n);
    },
  };
  return {
    calls,
    run: (ctx) => correctivelyRebalanceIfNeeded({}, lib, ctx),
  };
}

const ctx = (extra = {}) => ({
  provider: {},
  signerAddress: "0xSIGNER",
  position: { token0: T0, token1: T1, fee: 3000, tokenId: 1n },
  factoryAddress: "0xFAC",
  newRange: { lowerTick: -600, upperTick: 600 },
  swapRouterAddress: "0xROUTER",
  slippagePctToken0: 0.4,
  slippagePctToken1: 1.2,
  symbol0: "T0",
  symbol1: "T1",
  approvalMultiple: 2,
  ...extra,
});

afterEach(() => {
  for (const id of Object.values(PATHS)) delete require.cache[id];
});

describe("corrective swap — stopping before the first swap", () => {
  it("stops when the gas would outweigh the swap, and says so", async () => {
    const { run, calls } = load({
      desired: [need("token0to1", 10n ** 18n)],
      gates: [GAS],
      swaps: [{}],
    });
    const r = await run(ctx());
    assert.equal(r.skipped, true);
    assert.equal(r.reason, "gas-unfavorable");
    assert.equal(r.iterations, 0);
    assert.equal(calls.swaps.length, 0);
    assert.ok(
      calls.logs.some((l) => l.includes("gas/value ratio too high")),
      calls.logs.join("\n"),
    );
  });
});

describe("corrective swap — token1 into token0", () => {
  it("sells token1 at token0's slippage, then stops when the rest is dust", async () => {
    const { run, calls } = load({
      desired: [need("token1to0", 3_000_000n), need("token1to0", 2_000n)],
      gates: [PASS, DUST],
      swaps: [
        {
          txHash: "0xc1",
          amountOut: 777n,
          gasCostWei: 5n,
          swapSources: "Watergun Aggregator",
        },
      ],
    });
    const r = await run(ctx());
    assert.deepEqual(
      {
        reason: r.reason,
        skipped: r.skipped,
        iterations: r.iterations,
        txHash: r.txHash,
        extra0: r.extra0,
        extra1: r.extra1,
        gasCostWei: r.gasCostWei,
        swapSources: r.swapSources,
      },
      {
        reason: "swapped",
        skipped: false,
        iterations: 1,
        txHash: "0xc1",
        extra0: 777n,
        extra1: 0n,
        gasCostWei: 5n,
        swapSources: ["Watergun Aggregator"],
      },
    );
    const [p] = calls.swaps;
    assert.equal(p.tokenIn, T1);
    assert.equal(p.tokenOut, T0);
    assert.equal(p.decimalsIn, 6);
    assert.equal(p.decimalsOut, 18);
    assert.equal(p.isToken0To1, false);
    assert.equal(p.symbolIn, "T1");
    assert.equal(p.symbolOut, "T0");
    // Chosen by destination: the coin bought is token0.
    assert.equal(p.slippagePct, 0.4);
    assert.equal(p.amountIn, 3_000_000n);
    assert.equal(p.recipient, "0xSIGNER");
    assert.equal(p.approvalMultiple, 2);
    // Priced from the coin sold, at its own decimals: 3 × $2.
    assert.deepEqual(calls.prices, [T1, T1]);
    assert.equal(calls.gates[0].swapUsd, 6);
  });

  it("stops on a later iteration when gas would outweigh the next swap", async () => {
    const { run } = load({
      desired: [need("token1to0", 3_000_000n), need("token1to0", 3_000_000n)],
      gates: [PASS, GAS],
      swaps: [{ txHash: "0xc1", amountOut: 5n, gasCostWei: 1n }],
    });
    const r = await run(ctx());
    assert.equal(r.reason, "swapped");
    assert.equal(r.iterations, 1);
    assert.equal(r.txHash, "0xc1");
  });

  it("names the coins token1 and token0 in the log when their symbols are unknown", async () => {
    const { run, calls } = load({
      desired: [need("token1to0", 3_000_000n), NO_NEED],
      gates: [PASS],
      swaps: [{ txHash: "0xc1", amountOut: 1n, gasCostWei: 1n }],
    });
    await run(ctx({ symbol0: undefined, symbol1: undefined }));
    assert.ok(
      calls.logs.some((l) => l.includes("token1 -> token0")),
      calls.logs.join("\n"),
    );
  });

  it("names them token0 and token1 the other way round", async () => {
    const { run, calls } = load({
      desired: [need("token0to1", 10n ** 18n), NO_NEED],
      gates: [PASS],
      swaps: [{ txHash: "0xc1", amountOut: 1n, gasCostWei: 1n }],
    });
    await run(ctx({ symbol0: undefined, symbol1: undefined }));
    assert.ok(calls.logs.some((l) => l.includes("token0 -> token1")));
  });
});

describe("corrective swap — swaps that report no hash", () => {
  /*-
   *  Every swap reports its gas, zero when it sent nothing — what a swap
   *  below the threshold answers, with no hash.
   */
  it("counts their zero gas and reports no hash once it converges", async () => {
    const { run } = load({
      desired: [need("token0to1", 10n ** 18n), NO_NEED],
      gates: [PASS],
      swaps: [{ amountOut: 9n, gasCostWei: 0n }],
    });
    const r = await run(ctx());
    assert.equal(r.reason, "swapped");
    assert.equal(r.txHash, null);
    assert.deepEqual(r.txHashes, []);
    assert.equal(r.gasCostWei, 0n);
    assert.equal(r.extra1, 9n);
    assert.deepEqual(r.swapSources, []);
  });

  it("stops after the configured round limit with the imbalance still above threshold", async () => {
    const rounds = SHIPPED_DEFAULTS.correctiveSwapMaxRounds;
    const { run, calls } = load({
      desired: [need("token0to1", 10n ** 18n)],
      gates: [PASS],
      swaps: [{ amountOut: 1n, gasCostWei: 0n }],
    });
    const r = await run(ctx());
    assert.equal(calls.swaps.length, rounds);
    assert.deepEqual(
      {
        reason: r.reason,
        iterations: r.iterations,
        aboveThresholdAfterCap: r.aboveThresholdAfterCap,
        txHash: r.txHash,
        extra1: r.extra1,
        finalImbalanceUsd: r.finalImbalanceUsd,
        thresholdUsd: r.thresholdUsd,
      },
      {
        reason: "above-threshold-after-cap",
        iterations: rounds,
        aboveThresholdAfterCap: true,
        txHash: null,
        extra1: BigInt(rounds),
        finalImbalanceUsd: 2,
        thresholdUsd: 1,
      },
    );
  });
});

describe("corrective swap — a round that fails", () => {
  it("carries the gas of the rounds before it", async () => {
    /*-
     *  The first round's swap confirmed and was paid for; the second
     *  fails. The failure has to carry both, its own and the first
     *  round's, or the record of what the rebalance paid loses the first
     *  (src/lib/spent-gas.js).
     */
    const failed = Object.assign(new Error("swap reverted"), {
      gasCostWei: 7n,
    });
    const { run, calls } = load({
      desired: [need("token0to1", 10n ** 18n), need("token0to1", 10n ** 18n)],
      gates: [PASS],
      swaps: [
        {
          txHash: "0xc1",
          amountOut: 9n,
          gasCostWei: 5n,
          swapSources: "Watergun Aggregator",
        },
        failed,
      ],
    });
    await assert.rejects(run(ctx()), (err) => {
      assert.equal(err, failed);
      assert.equal(err.gasCostWei, 12n, "its own 7 and the first round's 5");
      return true;
    });
    assert.equal(calls.swaps.length, 2);
  });
});
