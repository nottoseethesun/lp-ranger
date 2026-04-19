"use strict";
/**
 * Rebalancer unit tests — Constants, getPoolState, removeLiquidity,
 * computeDesiredAmounts, swapIfNeeded.
 */
const { describe, it } = require("node:test");
const assert = require("assert");
const {
  getPoolState,
  removeLiquidity,
  computeDesiredAmounts,
  swapIfNeeded,
  _MAX_UINT128,
  _DEADLINE_SECONDS,
  _MIN_SWAP_THRESHOLD,
  V3_FEE_TIERS,
} = require("../src/rebalancer");
const {
  ADDR,
  ZERO_ADDRESS,
  Q96,
  ONE_ETH,
  defaultDispatch,
  buildMockEthersLib,
  mockSigner,
  makeTx,
  poolArgs,
} = require("./helpers/rebalancer-mocks");

// ── Constants ────────────────────────────────────────────────────────────────
describe("Constants", () => {
  it("_MAX_UINT128 equals 2n**128n - 1n", () => {
    assert.strictEqual(_MAX_UINT128, 2n ** 128n - 1n);
  });
  it("V3_FEE_TIERS contains common fee tiers (informational, not used as gate)", () => {
    assert.ok(V3_FEE_TIERS.includes(3000), "should include 0.3% tier");
    assert.ok(V3_FEE_TIERS.includes(10000), "should include 1% tier");
    assert.ok(V3_FEE_TIERS.includes(20000), "should include 2% tier");
  });
  it("_MIN_SWAP_THRESHOLD is 1000n", () => {
    assert.strictEqual(_MIN_SWAP_THRESHOLD, 1000n);
  });
});

// ── getPoolState ─────────────────────────────────────────────────────────────
describe("getPoolState", () => {
  it("returns correct price, tick, decimals, poolAddress", async () => {
    const r = await getPoolState({}, buildMockEthersLib(), poolArgs);
    assert.strictEqual(r.poolAddress, ADDR.pool);
    assert.strictEqual(r.decimals0, 18);
    assert.strictEqual(r.decimals1, 18);
    assert.strictEqual(typeof r.price, "number");
    assert.strictEqual(typeof r.tick, "number");
  });
  it("returns price close to 1.0 for sqrtPriceX96=Q96 with equal decimals", async () => {
    const r = await getPoolState({}, buildMockEthersLib(), poolArgs);
    assert.ok(Math.abs(r.price - 1.0) < 1e-9);
  });
  it("throws when pool is ZeroAddress", async () => {
    const d = defaultDispatch();
    d[ADDR.factory] = { getPool: async () => ZERO_ADDRESS };
    await assert.rejects(
      () =>
        getPoolState({}, buildMockEthersLib({ contractDispatch: d }), poolArgs),
      { message: /Pool not found/ },
    );
  });
  it("returns correct tick from slot0", async () => {
    const d = defaultDispatch();
    d[ADDR.pool] = {
      slot0: async () => ({ sqrtPriceX96: Q96, tick: 42n }),
    };
    const r = await getPoolState(
      {},
      buildMockEthersLib({ contractDispatch: d }),
      poolArgs,
    );
    assert.strictEqual(r.tick, 42);
  });
  it("handles different decimals for token0 and token1", async () => {
    const d = defaultDispatch();
    d[ADDR.token0] = { ...d[ADDR.token0], decimals: async () => 6n };
    const r = await getPoolState(
      {},
      buildMockEthersLib({ contractDispatch: d }),
      poolArgs,
    );
    assert.strictEqual(r.decimals0, 6);
    assert.strictEqual(r.decimals1, 18);
  });
});

// ── removeLiquidity ──────────────────────────────────────────────────────────
describe("removeLiquidity", () => {
  const rmArgs = (extra) => ({
    positionManagerAddress: ADDR.pm,
    tokenId: 1n,
    liquidity: 1000n,
    recipient: ADDR.signer,
    deadline: 9999999999n,
    token0: ADDR.token0,
    token1: ADDR.token1,
    ...extra,
  });

  it("calls decrease then collect via multicall, returns amounts via balance-diff", async () => {
    const order = [];
    let phase = 0;
    const d = defaultDispatch();
    d[ADDR.token0] = {
      ...d[ADDR.token0],
      balanceOf: async () => (phase >= 2 ? ONE_ETH : 0n),
    };
    d[ADDR.token1] = {
      ...d[ADDR.token1],
      balanceOf: async () => (phase >= 2 ? ONE_ETH : 0n),
    };
    d[ADDR.pm] = {
      ...d[ADDR.pm],
      decreaseLiquidity: async () => {
        order.push("decrease");
        return makeTx("0xdec");
      },
      collect: async () => {
        order.push("collect");
        phase = 2;
        return { wait: async () => ({ hash: "0xcol", logs: [] }) };
      },
      positions: async () => ({
        liquidity: 5000n,
        tokensOwed0: 0n,
        tokensOwed1: 0n,
      }),
    };
    const r = await removeLiquidity(
      mockSigner(),
      buildMockEthersLib({ contractDispatch: d }),
      rmArgs(),
    );
    assert.deepStrictEqual(order, ["decrease", "collect"]);
    assert.strictEqual(r.txHash, "0xmulticall");
    assert.strictEqual(r.amount0, ONE_ETH);
    assert.strictEqual(r.amount1, ONE_ETH);
  });

  it("uses _MAX_UINT128 for collect amounts", async () => {
    let captured,
      callCount = 0;
    const d = defaultDispatch();
    d[ADDR.token0] = {
      ...d[ADDR.token0],
      balanceOf: async () => (callCount >= 2 ? ONE_ETH : 0n),
    };
    d[ADDR.token1] = {
      ...d[ADDR.token1],
      balanceOf: async () => (callCount >= 2 ? ONE_ETH : 0n),
    };
    d[ADDR.pm] = {
      ...d[ADDR.pm],
      collect: async (p) => {
        captured = p;
        callCount = 2;
        return { wait: async () => ({ hash: "0xc", logs: [] }) };
      },
      positions: async () => ({
        liquidity: 5000n,
        tokensOwed0: 0n,
        tokensOwed1: 0n,
      }),
    };
    await removeLiquidity(
      mockSigner(),
      buildMockEthersLib({ contractDispatch: d }),
      rmArgs(),
    );
    assert.strictEqual(captured.amount0Max, _MAX_UINT128);
    assert.strictEqual(captured.amount1Max, _MAX_UINT128);
  });
  it("uses default deadline when none provided", async () => {
    let captured;
    const d = defaultDispatch();
    d[ADDR.pm] = {
      ...d[ADDR.pm],
      decreaseLiquidity: async (p) => {
        captured = p;
        return makeTx("0xdec");
      },
    };
    const before = BigInt(Math.floor(Date.now() / 1000));
    await removeLiquidity(
      mockSigner(),
      buildMockEthersLib({ contractDispatch: d }),
      rmArgs({ deadline: undefined }),
    );
    const after = BigInt(Math.floor(Date.now() / 1000));
    assert.ok(captured.deadline >= before + BigInt(_DEADLINE_SECONDS));
    assert.ok(captured.deadline <= after + BigInt(_DEADLINE_SECONDS) + 1n);
  });
  it("throws when balance-diff is zero (prevents empty mint)", async () => {
    const d = defaultDispatch();
    d[ADDR.token0] = { ...d[ADDR.token0], balanceOf: async () => 0n };
    d[ADDR.token1] = { ...d[ADDR.token1], balanceOf: async () => 0n };
    d[ADDR.pm] = {
      ...d[ADDR.pm],
      collect: async () => ({
        wait: async () => ({ hash: "0xc", logs: [] }),
      }),
      positions: async () => ({
        liquidity: 5000n,
        tokensOwed0: 0n,
        tokensOwed1: 0n,
      }),
    };
    await assert.rejects(
      () =>
        removeLiquidity(
          mockSigner(),
          buildMockEthersLib({ contractDispatch: d }),
          rmArgs(),
        ),
      { message: /Collected 0 tokens/ },
    );
  });
});

// ── computeDesiredAmounts ────────────────────────────────────────────────────
describe("computeDesiredAmounts", () => {
  const S = 10 ** 18;
  const range = { currentPrice: 1.0 }; // token1 per token0
  const toks = { decimals0: 18, decimals1: 18 };

  it("returns no-swap when amounts are already 50/50 by value", () => {
    const amt = BigInt(Math.floor(0.5 * S));
    const r = computeDesiredAmounts(
      { amount0: amt, amount1: amt },
      range,
      toks,
    );
    assert.strictEqual(r.needsSwap, false);
  });
  it("returns zero amounts when totalValue is 0", () => {
    const r = computeDesiredAmounts({ amount0: 0n, amount1: 0n }, range, toks);
    assert.strictEqual(r.amount0Desired, 0n);
    assert.strictEqual(r.needsSwap, false);
  });
  it("identifies token0to1 swap when too much token0", () => {
    const r = computeDesiredAmounts(
      { amount0: BigInt(S), amount1: 0n },
      range,
      toks,
    );
    assert.strictEqual(r.swapDirection, "token0to1");
    assert.ok(r.swapAmount > 0n);
  });
  it("identifies token1to0 swap when too much token1", () => {
    const r = computeDesiredAmounts(
      { amount0: 0n, amount1: BigInt(S) },
      range,
      toks,
    );
    assert.strictEqual(r.swapDirection, "token1to0");
    assert.ok(r.swapAmount > 0n);
  });
  it("swaps approximately half the excess for 50/50 balance", () => {
    // All token0, price=1 → should swap ~half of token0 to token1
    const r = computeDesiredAmounts(
      { amount0: BigInt(S), amount1: 0n },
      range,
      toks,
    );
    // swapAmount should be ~0.5 ETH (half the value excess)
    const swapFloat = Number(r.swapAmount) / S;
    assert.ok(
      swapFloat > 0.45 && swapFloat < 0.55,
      `swap should be ~0.5, got ${swapFloat}`,
    );
  });
  it("handles asymmetric price (price=2000, 6 vs 18 decimals)", () => {
    const r = computeDesiredAmounts(
      { amount0: 1_000_000n, amount1: BigInt(S) }, // 1 USDC + 1 token1
      { currentPrice: 2000 }, // 2000 token1 per token0
      { decimals0: 6, decimals1: 18 },
    );
    // 1 USDC at price 2000 = 2000 token1-value; 1 token1 = 1 token1-value
    // token0 is vastly heavier → swap token0→token1
    assert.strictEqual(r.swapDirection, "token0to1");
    assert.ok(r.swapAmount > 0n);
  });
});

// ── computeDesiredAmounts — SDK path (tick-based range) ──────────────────────
describe("computeDesiredAmounts — SDK path", () => {
  const S = 10 ** 18;

  it("uses SDK math when tick range is provided", () => {
    // currentTick=0, range=[-600, 600], all token0 → should swap some to token1
    const r = computeDesiredAmounts(
      { amount0: BigInt(S), amount1: 0n },
      {
        currentPrice: 1.0,
        currentTick: 0,
        lowerTick: -600,
        upperTick: 600,
      },
      { decimals0: 18, decimals1: 18 },
    );
    assert.strictEqual(r.swapDirection, "token0to1");
    assert.ok(r.swapAmount > 0n, "should swap excess token0");
    assert.ok(r.needsSwap, "needsSwap should be true");
  });

  it("swaps token1→token0 when all funds are in token1", () => {
    const r = computeDesiredAmounts(
      { amount0: 0n, amount1: BigInt(S) },
      {
        currentPrice: 1.0,
        currentTick: 0,
        lowerTick: -600,
        upperTick: 600,
      },
      { decimals0: 18, decimals1: 18 },
    );
    assert.strictEqual(r.swapDirection, "token1to0");
    assert.ok(r.swapAmount > 0n);
  });

  it("needs no swap when amounts already match SDK ratio", () => {
    // Compute what SDK wants for a balanced position, then feed it back
    const half = BigInt(S) / 2n;
    const r = computeDesiredAmounts(
      { amount0: half, amount1: half },
      {
        currentPrice: 1.0,
        currentTick: 0,
        lowerTick: -600,
        upperTick: 600,
      },
      { decimals0: 18, decimals1: 18 },
    );
    // Either no swap or swap below threshold
    if (r.needsSwap) {
      assert.ok(r.swapAmount <= 1000n, "swap amount should be negligible");
    } else {
      assert.strictEqual(r.swapDirection, null);
    }
  });

  it("returns only token0 when currentTick is below lowerTick", () => {
    const r = computeDesiredAmounts(
      { amount0: BigInt(S), amount1: BigInt(S) },
      {
        currentPrice: 0.5,
        currentTick: -1000,
        lowerTick: -600,
        upperTick: 600,
      },
      { decimals0: 18, decimals1: 18 },
    );
    assert.strictEqual(r.swapDirection, "token1to0");
    assert.ok(r.needsSwap);
  });
  it("returns only token1 when currentTick is at or above upperTick", () => {
    const r = computeDesiredAmounts(
      { amount0: BigInt(S), amount1: BigInt(S) },
      {
        currentPrice: 2.0,
        currentTick: 700,
        lowerTick: -600,
        upperTick: 600,
      },
      { decimals0: 18, decimals1: 18 },
    );
    assert.strictEqual(r.swapDirection, "token0to1");
    assert.ok(r.needsSwap);
  });
  it("currentTick exactly at lowerTick needs mostly token0 (near boundary)", () => {
    const r = computeDesiredAmounts(
      { amount0: BigInt(S), amount1: 0n },
      {
        currentPrice: 1.0,
        currentTick: -600,
        lowerTick: -600,
        upperTick: 600,
      },
      { decimals0: 18, decimals1: 18 },
    );
    assert.strictEqual(r.needsSwap, false);
  });

  it("swap amount + desired amount0 does not exceed available (fund safety)", () => {
    const total0 = BigInt(2 * S);
    const total1 = BigInt(S);
    const r = computeDesiredAmounts(
      { amount0: total0, amount1: total1 },
      {
        currentPrice: 1.0,
        currentTick: 0,
        lowerTick: -600,
        upperTick: 600,
      },
      { decimals0: 18, decimals1: 18 },
    );
    if (r.swapDirection === "token0to1") {
      // amount0Desired + swapAmount should not exceed what we have
      assert.ok(
        r.amount0Desired + r.swapAmount <= total0,
        `desired0(${r.amount0Desired}) + swap(${r.swapAmount}) should not exceed available(${total0})`,
      );
    } else if (r.swapDirection === "token1to0") {
      assert.ok(
        r.amount1Desired + r.swapAmount <= total1,
        `desired1(${r.amount1Desired}) + swap(${r.swapAmount}) should not exceed available(${total1})`,
      );
    }
  });

  it("ratio-preserving swap prevents over-conversion (large excess)", () => {
    // Reproduces the real-world bug: large pre-existing token1 balance caused
    // all excess to be swapped, stranding most of the converted token0.
    // With ratio math the swap should be much smaller than the full excess.
    const r = computeDesiredAmounts(
      { amount0: 2858185477277n, amount1: 37034691401154n },
      {
        currentPrice: 2.5642,
        currentTick: 9417,
        lowerTick: 9100,
        upperTick: 9700,
      },
      { decimals0: 8, decimals1: 8 },
    );
    assert.strictEqual(r.swapDirection, "token1to0");
    const excess1 = 37034691401154n - 8202565216500n; // ~28.8T raw
    // Ratio swap should be well under half the full excess
    assert.ok(
      r.swapAmount < excess1 / 2n,
      `ratio swap ${r.swapAmount} should be < half excess ${excess1 / 2n}`,
    );
    assert.ok(r.swapAmount > _MIN_SWAP_THRESHOLD);
  });

  it("fires swap when both sides have positive excess (SDK round-up dust)", () => {
    /*- Regression: the SDK's getAmount{0,1}Delta rounds up, so the non-binding
     *  side frequently has a tiny positive "excess" even though that side is
     *  fully consumed. The prior strict `excess <= 0n` guards rejected the
     *  swap whenever both sides reported positive excess, leaving meaningful
     *  residuals (e.g. 22k CRO ≈ $47) in the wallet after every rebalance.
     *  The ratio-direction logic should fire the swap based on `f0` vs `R*f1`
     *  even when excess is positive on both sides. */
    const r = computeDesiredAmounts(
      { amount0: BigInt(Math.floor(1.5 * S)), amount1: BigInt(S) },
      {
        currentPrice: 1.0,
        currentTick: 0,
        lowerTick: -600,
        upperTick: 600,
      },
      { decimals0: 18, decimals1: 18 },
    );
    assert.strictEqual(r.swapDirection, "token0to1");
    assert.ok(r.needsSwap, "should swap even with dust on non-binding side");
    assert.ok(r.swapAmount > _MIN_SWAP_THRESHOLD);
  });

  it("handles asymmetric decimals (6 vs 18) with SDK path", () => {
    const r = computeDesiredAmounts(
      { amount0: 1_000_000n, amount1: BigInt(S) },
      {
        currentPrice: 2000,
        currentTick: 0,
        lowerTick: -600,
        upperTick: 600,
      },
      { decimals0: 6, decimals1: 18 },
    );
    // Just verify it doesn't throw and returns a valid result
    assert.ok(typeof r.needsSwap === "boolean");
    assert.ok(typeof r.swapAmount === "bigint");
  });
});

// ── swapIfNeeded ─────────────────────────────────────────────────────────────
describe("swapIfNeeded", () => {
  const swArgs = (extra) => ({
    swapRouterAddress: ADDR.router,
    tokenIn: ADDR.token0,
    tokenOut: ADDR.token1,
    fee: 3000,
    amountIn: 2000n,
    slippagePct: 0.5,
    recipient: ADDR.signer,
    currentPrice: 1.0,
    decimalsIn: 18,
    decimalsOut: 18,
    isToken0To1: true,
    deadline: 9999999999n,
    ...extra,
  });

  it("skips swap when amountIn < _MIN_SWAP_THRESHOLD", async () => {
    const r = await swapIfNeeded(
      mockSigner(),
      buildMockEthersLib(),
      swArgs({ amountIn: 999n }),
    );
    assert.strictEqual(r.amountOut, 0n);
    assert.strictEqual(r.txHash, null);
  });
  it("calls approve and exactInputSingle", async () => {
    const calls = [];
    const d = defaultDispatch();
    d[ADDR.token0] = {
      ...d[ADDR.token0],
      allowance: async () => 0n,
      approve: async () => {
        calls.push("approve");
        return makeTx("0xa");
      },
    };
    d[ADDR.router] = {
      exactInputSingle: Object.assign(
        async () => {
          calls.push("swap");
          return makeTx("0xs");
        },
        { staticCall: async (p) => p.amountIn },
      ),
    };
    await swapIfNeeded(
      mockSigner(),
      buildMockEthersLib({ contractDispatch: d }),
      swArgs(),
    );
    assert.ok(calls.includes("approve"));
    assert.ok(calls.includes("swap"));
  });
  it("returns txHash from receipt", async () => {
    const r = await swapIfNeeded(mockSigner(), buildMockEthersLib(), swArgs());
    assert.strictEqual(r.txHash, "0xswap");
  });
});
