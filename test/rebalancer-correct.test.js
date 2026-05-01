/**
 * @file test/rebalancer-correct.test.js
 * @description Tests for src/rebalancer-correct.js — post-swap corrective
 *   rebalance that re-queries the pool after the primary swap, fires a
 *   corrective swap if the new R=need0/need1 produces an imbalance above
 *   the gold-pegged dust threshold.
 */

"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const POOLS_PATH = require.resolve("../src/rebalancer-pools");
const SWAP_PATH = require.resolve("../src/rebalancer-swap");
const PRICE_PATH = require.resolve("../src/price-fetcher");
const DUST_PATH = require.resolve("../src/dust");
const CORRECT_PATH = require.resolve("../src/rebalancer-correct");

/** Simple mock ethers library (just Contract factory with a lookup table). */
function mkEthersLib(dispatch) {
  function MockContract(addr) {
    const m = dispatch[addr];
    if (!m) throw new Error(`No mock for ${addr}`);
    Object.assign(this, m);
  }
  return { Contract: MockContract };
}

/**
 * Seed require.cache with controllable stubs.
 *
 * Scalar-valued fields (`desired`, `swapResult`, `isDustReturn`) accept
 * EITHER a single value (static) OR an array (one element per iteration
 * — the corrective rebalancer can now loop up to 3 times).
 */
function installStubs({
  poolState,
  desired,
  swapResult,
  tokenPriceUsd = 1,
  isDustReturn = false,
  dustThreshold = {
    thresholdUsd: 1,
    usdPerUnit: 4800,
    units: 1 / 4800,
    usedFallback: false,
  },
}) {
  const _desiredSeq = Array.isArray(desired) ? desired.slice() : null;
  const _swapSeq = Array.isArray(swapResult) ? swapResult.slice() : null;
  const _dustSeq = Array.isArray(isDustReturn) ? isDustReturn.slice() : null;
  const _next = (seq, fallback) =>
    seq ? (seq.length > 1 ? seq.shift() : seq[0]) : fallback;
  require.cache[POOLS_PATH] = {
    id: POOLS_PATH,
    filename: POOLS_PATH,
    loaded: true,
    exports: {
      ERC20_ABI: [],
      getPoolState: async () => poolState,
      _MIN_SWAP_THRESHOLD: 1000n,
    },
  };
  require.cache[SWAP_PATH] = {
    id: SWAP_PATH,
    filename: SWAP_PATH,
    loaded: true,
    exports: {
      computeDesiredAmounts: () => _next(_desiredSeq, desired),
      swapIfNeeded: async () => _next(_swapSeq, swapResult),
    },
  };
  require.cache[PRICE_PATH] = {
    id: PRICE_PATH,
    filename: PRICE_PATH,
    loaded: true,
    exports: {
      fetchTokenPriceUsd: async () => tokenPriceUsd,
      fetchDustUnitPriceUsd: async () => 4800,
      _resetDustUnitPriceCache: () => {},
    },
  };
  require.cache[DUST_PATH] = {
    id: DUST_PATH,
    filename: DUST_PATH,
    loaded: true,
    exports: {
      isDust: async () => _next(_dustSeq, isDustReturn),
      getDustThresholdUsd: async () => dustThreshold,
    },
  };
  delete require.cache[CORRECT_PATH];
}

function clearStubs() {
  delete require.cache[POOLS_PATH];
  delete require.cache[SWAP_PATH];
  delete require.cache[PRICE_PATH];
  delete require.cache[DUST_PATH];
  delete require.cache[CORRECT_PATH];
}

const CTX = () => ({
  provider: {},
  signerAddress: "0xSIGNER",
  position: {
    token0: "0xT0",
    token1: "0xT1",
    fee: 3000,
    tokenId: 1n,
  },
  factoryAddress: "0xFAC",
  newRange: { lowerTick: -600, upperTick: 600 },
  swapRouterAddress: "0xROUTER",
  slippagePct: 0.5,
  symbol0: "T0",
  symbol1: "T1",
});

afterEach(() => {
  clearStubs();
});

describe("correctivelyRebalanceIfNeeded", () => {
  it("skips when no swap is needed", async () => {
    installStubs({
      poolState: {
        tick: 5,
        price: 1,
        decimals0: 18,
        decimals1: 18,
        poolAddress: "0xPOOL",
      },
      desired: { needsSwap: false, swapAmount: 0n, swapDirection: null },
      swapResult: null,
    });
    const {
      correctivelyRebalanceIfNeeded,
    } = require("../src/rebalancer-correct");
    const dispatch = {
      "0xT0": { balanceOf: async () => 1000n },
      "0xT1": { balanceOf: async () => 1000n },
    };
    const res = await correctivelyRebalanceIfNeeded(
      { getAddress: async () => "0xSIGNER" },
      mkEthersLib(dispatch),
      CTX(),
    );
    assert.strictEqual(res.skipped, true);
    assert.strictEqual(res.reason, "no-swap-needed");
    assert.strictEqual(res.txHash, null);
  });

  it("skips when swap amount is below dust threshold", async () => {
    installStubs({
      poolState: {
        tick: 5,
        price: 1,
        decimals0: 18,
        decimals1: 18,
        poolAddress: "0xPOOL",
      },
      // $0.5 worth of dust — should be skipped when threshold = $1.
      desired: {
        needsSwap: true,
        swapAmount: 500_000_000_000_000_000n, // 0.5 tokens
        swapDirection: "token0to1",
      },
      swapResult: null,
      tokenPriceUsd: 1, // 0.5 × $1 = $0.50 < $1 threshold
      isDustReturn: true,
    });
    const {
      correctivelyRebalanceIfNeeded,
    } = require("../src/rebalancer-correct");
    const dispatch = {
      "0xT0": { balanceOf: async () => 10_000n },
      "0xT1": { balanceOf: async () => 10_000n },
    };
    const res = await correctivelyRebalanceIfNeeded(
      { getAddress: async () => "0xSIGNER" },
      mkEthersLib(dispatch),
      CTX(),
    );
    assert.strictEqual(res.skipped, true);
    assert.strictEqual(res.reason, "below-dust-threshold");
  });

  it("fires one corrective swap then converges on iteration 2", async () => {
    installStubs({
      poolState: {
        tick: 5,
        price: 1,
        decimals0: 18,
        decimals1: 18,
        poolAddress: "0xPOOL",
      },
      // iter 1: needs swap — fires. iter 2: converged — no swap needed.
      desired: [
        {
          needsSwap: true,
          swapAmount: 10_000_000_000_000_000_000n, // 10 tokens
          swapDirection: "token0to1",
        },
        { needsSwap: false, swapAmount: 0n, swapDirection: null },
      ],
      swapResult: {
        txHash: "0xCORRECTIVE",
        amountOut: 9_500_000_000_000_000_000n,
        gasCostWei: 42n,
        swapSources: "NineMM_V3",
      },
      tokenPriceUsd: 5, // 10 × $5 = $50 >> threshold
      isDustReturn: false,
    });
    const {
      correctivelyRebalanceIfNeeded,
    } = require("../src/rebalancer-correct");
    const dispatch = {
      "0xT0": { balanceOf: async () => 50_000_000_000_000_000_000n },
      "0xT1": { balanceOf: async () => 0n },
    };
    const res = await correctivelyRebalanceIfNeeded(
      { getAddress: async () => "0xSIGNER" },
      mkEthersLib(dispatch),
      CTX(),
    );
    assert.strictEqual(res.skipped, false);
    assert.strictEqual(res.txHash, "0xCORRECTIVE");
    assert.strictEqual(res.reason, "swapped");
    assert.strictEqual(res.gasCostWei, 42n);
    // token0→1 swap, so extra1 should be the swap output.
    assert.strictEqual(res.extra1, 9_500_000_000_000_000_000n);
    assert.strictEqual(res.extra0, 0n);
    assert.strictEqual(res.iterations, 1);
    assert.strictEqual(res.aboveThresholdAfterCap, false);
    assert.deepStrictEqual(res.txHashes, ["0xCORRECTIVE"]);
    /*- Corrective swap source must flow through to the final result so
     *  the display shows "NineMM_V3 +1 corrective" rather than "(no swap)". */
    assert.deepStrictEqual(res.swapSources, ["NineMM_V3"]);
  });

  it("caps at 3 iterations and flags aboveThresholdAfterCap when residual persists", async () => {
    /*- Every iteration fires a swap (needsSwap=true, isDust=false).
     *  After the 3-iteration hard cap, residual is still above threshold
     *  — so the rebalancer returns a warning signal instead of looping
     *  forever. */
    installStubs({
      poolState: {
        tick: 5,
        price: 1,
        decimals0: 18,
        decimals1: 18,
        poolAddress: "0xPOOL",
      },
      desired: {
        needsSwap: true,
        swapAmount: 10_000_000_000_000_000_000n,
        swapDirection: "token0to1",
      },
      swapResult: {
        txHash: "0xCORRECTIVE",
        amountOut: 9_500_000_000_000_000_000n,
        gasCostWei: 42n,
      },
      tokenPriceUsd: 5,
      isDustReturn: false,
    });
    const {
      correctivelyRebalanceIfNeeded,
      _MAX_ITERATIONS,
    } = require("../src/rebalancer-correct");
    const dispatch = {
      "0xT0": { balanceOf: async () => 50_000_000_000_000_000_000n },
      "0xT1": { balanceOf: async () => 0n },
    };
    const res = await correctivelyRebalanceIfNeeded(
      { getAddress: async () => "0xSIGNER" },
      mkEthersLib(dispatch),
      CTX(),
    );
    assert.strictEqual(_MAX_ITERATIONS, 3, "hard cap must stay at 3");
    assert.strictEqual(res.skipped, false);
    assert.strictEqual(res.reason, "above-threshold-after-cap");
    assert.strictEqual(res.iterations, 3);
    assert.strictEqual(res.aboveThresholdAfterCap, true);
    assert.strictEqual(res.txHashes.length, 3);
    // Accumulated gas = 3 × 42n.
    assert.strictEqual(res.gasCostWei, 126n);
    // Accumulated output = 3 × 9.5e18.
    assert.strictEqual(res.extra1, 28_500_000_000_000_000_000n);
    assert.ok(
      res.finalImbalanceUsd > res.thresholdUsd,
      "final imbalance must exceed threshold when cap reached",
    );
  });
});

/*- Merges primary + corrective swap-source strings into a single display
 *  label; this is what the rebalance log row shows in the UI. */
describe("_mergeSwapSources", () => {
  const { _mergeSwapSources } = require("../src/rebalancer-execute");

  it("returns undefined when neither primary nor corrective present", () => {
    assert.strictEqual(_mergeSwapSources(null, []), undefined);
    assert.strictEqual(_mergeSwapSources(undefined, undefined), undefined);
  });

  it("returns primary alone when no corrective swaps", () => {
    assert.strictEqual(_mergeSwapSources("NineMM_V3", []), "NineMM_V3");
    assert.strictEqual(_mergeSwapSources("NineMM_V3", null), "NineMM_V3");
  });

  it("appends corrective count when both present and routes differ", () => {
    assert.strictEqual(
      _mergeSwapSources("9mm Aggregator", ["9mm V3 Router"]),
      "9mm Aggregator +1 corrective",
    );
    assert.strictEqual(
      _mergeSwapSources("9mm Aggregator", ["A", "B"]),
      "9mm Aggregator +2 corrective",
    );
  });

  /*- The common case: aggregator used for the primary swap and for every
   *  corrective iteration.  Collapse to just "9mm Aggregator" rather than
   *  "9mm Aggregator +3 corrective" which misleadingly suggests a
   *  different route was taken for the corrective swaps. */
  it("collapses to single label when primary and all corrective entries match", () => {
    assert.strictEqual(
      _mergeSwapSources("9mm Aggregator", ["9mm Aggregator"]),
      "9mm Aggregator",
    );
    assert.strictEqual(
      _mergeSwapSources("9mm Aggregator", [
        "9mm Aggregator",
        "9mm Aggregator",
        "9mm Aggregator",
      ]),
      "9mm Aggregator",
    );
  });

  it("labels corrective-only swaps explicitly", () => {
    assert.strictEqual(_mergeSwapSources(null, ["A", "B"]), "A,B (corrective)");
  });

  /*- Corrective-only but every iteration used the same route — again
   *  collapse to the single route label (no "(corrective)" suffix). */
  it("collapses corrective-only when every entry matches", () => {
    assert.strictEqual(
      _mergeSwapSources(null, ["9mm Aggregator", "9mm Aggregator"]),
      "9mm Aggregator",
    );
  });
});

/*- Regression: _swapAndAdjust used to reconstruct the result object
 *  with only txHash/gasCostWei/extra0/extra1 — dropping swapSources.
 *  Downstream _buildRebalanceResult then saw `swapped.swapSources ===
 *  undefined` and the rebalance event was logged as "(no swap)" even
 *  when the aggregator route had been used. */
describe("_swapAndAdjust — swapSources propagation", () => {
  const EXEC_PATH = require.resolve("../src/rebalancer-execute");
  const GATES_PATH = require.resolve("../src/swap-gates");

  function withSwapStub(swapResult, fn) {
    require.cache[SWAP_PATH] = {
      id: SWAP_PATH,
      filename: SWAP_PATH,
      loaded: true,
      exports: {
        computeDesiredAmounts: () => ({}),
        swapIfNeeded: async () => swapResult,
      },
    };
    /*- Stub the swap-gates so the initial-swap dust/gas gate always
     *  passes — this regression suite is about swapSources plumbing,
     *  not gate behavior (which has its own dedicated test file). */
    require.cache[GATES_PATH] = {
      id: GATES_PATH,
      filename: GATES_PATH,
      loaded: true,
      exports: {
        MAX_SWAP_GAS_RATIO: 0.01,
        estimateSwapGasUsd: async () => 0,
        gasFeePctToRatio: () => 0.01,
        shouldSkipSwap: async () => ({
          skip: false,
          reason: null,
          gasRatio: 0,
          thresholdUsd: 1,
          maxRatio: 0.01,
        }),
      },
    };
    require.cache[PRICE_PATH] = {
      id: PRICE_PATH,
      filename: PRICE_PATH,
      loaded: true,
      exports: { fetchTokenPriceUsd: async () => 1 },
    };
    delete require.cache[EXEC_PATH];
    try {
      return fn();
    } finally {
      delete require.cache[SWAP_PATH];
      delete require.cache[GATES_PATH];
      delete require.cache[PRICE_PATH];
      delete require.cache[EXEC_PATH];
    }
  }

  const ctx = (dir) => ({
    desired: { needsSwap: true, swapAmount: 1_000_000n, swapDirection: dir },
    position: { token0: "0xT0", token1: "0xT1", fee: 3000 },
    poolState: { price: 1, decimals0: 18, decimals1: 18 },
    swapRouterAddress: "0xROUTER",
    slippagePct: 0.5,
    signerAddress: "0xSIGNER",
    symbol0: "T0",
    symbol1: "T1",
    approvalMultiple: 20,
  });

  it("forwards aggregator swapSources to the caller", async () => {
    await withSwapStub(
      {
        amountOut: 500n,
        txHash: "0xabc",
        gasCostWei: 100n,
        swapSources: "9mm Aggregator",
      },
      async () => {
        const { _swapAndAdjust } = require("../src/rebalancer-execute");
        const out = await _swapAndAdjust({}, {}, ctx("token0to1"));
        assert.strictEqual(out.swapSources, "9mm Aggregator");
        assert.strictEqual(out.extra1, 500n);
        assert.strictEqual(out.extra0, 0n);
      },
    );
  });

  it("forwards V3 router fallback swapSources", async () => {
    await withSwapStub(
      {
        amountOut: 200n,
        txHash: "0xdef",
        gasCostWei: 50n,
        swapSources: "9mm V3 Router",
      },
      async () => {
        const { _swapAndAdjust } = require("../src/rebalancer-execute");
        const out = await _swapAndAdjust({}, {}, ctx("token1to0"));
        assert.strictEqual(out.swapSources, "9mm V3 Router");
        assert.strictEqual(out.extra0, 200n);
      },
    );
  });

  it("omits swapSources when the swap path did not stamp any", async () => {
    await withSwapStub(
      { amountOut: 100n, txHash: null, gasCostWei: 0n },
      async () => {
        const { _swapAndAdjust } = require("../src/rebalancer-execute");
        const out = await _swapAndAdjust({}, {}, ctx("token0to1"));
        assert.ok(
          !("swapSources" in out),
          "should not add an undefined swapSources key",
        );
      },
    );
  });
});
