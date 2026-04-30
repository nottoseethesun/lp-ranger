"use strict";

/**
 * @file test/fund-safety.test.js
 * @description Tests that verify the rebalancer cannot lose user funds.
 * Covers: slippage protection, recipient validation, underflow guards,
 * wallet-balance isolation, partial-failure handling, ownership check,
 * and range validity.
 */

const { describe, it } = require("node:test");
const assert = require("assert");
const {
  computeDesiredAmounts,
  swapIfNeeded,
  mintPosition,
  removeLiquidity,
  executeRebalance,
  _MAX_UINT128,
} = require("../src/rebalancer");
const { computeNewRange, priceToTick } = require("../src/range-math");

// ── Shared helpers (test/helpers/rebalancer-mocks.js) ───────────────────────
const {
  ADDR,
  ONE_ETH,
  makeTx,
  makeMintTx,
  mockSigner,
  defaultDispatch,
  buildMockEthersLib,
} = require("./helpers/rebalancer-mocks");

const rebalOpts = (posOverride) => ({
  position: {
    tokenId: 1n,
    token0: ADDR.token0,
    token1: ADDR.token1,
    fee: 3000,
    liquidity: 5000n,
    tickLower: -600,
    tickUpper: 600,
    ...posOverride,
  },
  factoryAddress: ADDR.factory,
  positionManagerAddress: ADDR.pm,
  swapRouterAddress: ADDR.router,
  slippagePct: 0.5,
});

// ── Swap slippage (anti-sandwich) ───────────────────────────────────────────
describe("Fund safety — swap slippage", () => {
  const swArgs = (extra) => ({
    swapRouterAddress: ADDR.router,
    tokenIn: ADDR.token0,
    tokenOut: ADDR.token1,
    fee: 3000,
    amountIn: 1_000_000n,
    slippagePct: 0.5,
    recipient: ADDR.signer,
    currentPrice: 1.0,
    decimalsIn: 18,
    decimalsOut: 18,
    isToken0To1: true,
    deadline: 9999999999n,
    ...extra,
  });

  it("amountOutMinimum derived from quote simulation, not spot price", async () => {
    let captured;
    const quotedOut = 999_000n; // 0.1% impact (within 0.5% slippage)
    const d = defaultDispatch();
    d[ADDR.router] = {
      exactInputSingle: Object.assign(
        async (p) => {
          captured = p;
          return makeTx("0xs");
        },
        { staticCall: async () => quotedOut },
      ),
    };
    await swapIfNeeded(
      mockSigner(),
      buildMockEthersLib({ contractDispatch: d }),
      swArgs(),
    );
    // amountOutMinimum = 999000 * 9950 / 10000 = 994005
    assert.strictEqual(captured.amountOutMinimum, 994005n);
  });
});

// ── Recipient always equals signer ──────────────────────────────────────────
describe("Fund safety — recipient is always signer", () => {
  const SIGNER_ADDR = "0xMySigner0000000000000000000000000000001";

  it("collect() recipient is the signer address", async () => {
    let captured;
    let collected = false;
    const d = defaultDispatch();
    d[ADDR.pm] = {
      ...d[ADDR.pm],
      collect: async (p) => {
        captured = p;
        collected = true;
        return { wait: async () => ({ hash: "0xc", logs: [] }) };
      },
    };
    d[ADDR.token0] = {
      ...d[ADDR.token0],
      balanceOf: async () => (collected ? 5n * ONE_ETH : 0n),
    };
    d[ADDR.token1] = {
      ...d[ADDR.token1],
      balanceOf: async () => (collected ? 5n * ONE_ETH : 0n),
    };
    await removeLiquidity(
      mockSigner(SIGNER_ADDR),
      buildMockEthersLib({ contractDispatch: d }),
      {
        positionManagerAddress: ADDR.pm,
        tokenId: 1n,
        liquidity: 100n,
        recipient: SIGNER_ADDR,
        token0: ADDR.token0,
        token1: ADDR.token1,
      },
    );
    assert.strictEqual(captured.recipient, SIGNER_ADDR);
  });

  it("collect() uses MAX_UINT128 to claim all owed tokens", async () => {
    let captured;
    let collected = false;
    const d = defaultDispatch();
    d[ADDR.pm] = {
      ...d[ADDR.pm],
      collect: async (p) => {
        captured = p;
        collected = true;
        return { wait: async () => ({ hash: "0xc", logs: [] }) };
      },
    };
    d[ADDR.token0] = {
      ...d[ADDR.token0],
      balanceOf: async () => (collected ? 5n * ONE_ETH : 0n),
    };
    d[ADDR.token1] = {
      ...d[ADDR.token1],
      balanceOf: async () => (collected ? 5n * ONE_ETH : 0n),
    };
    await removeLiquidity(
      mockSigner(),
      buildMockEthersLib({ contractDispatch: d }),
      {
        positionManagerAddress: ADDR.pm,
        tokenId: 1n,
        liquidity: 100n,
        recipient: ADDR.signer,
        token0: ADDR.token0,
        token1: ADDR.token1,
      },
    );
    assert.strictEqual(captured.amount0Max, _MAX_UINT128);
    assert.strictEqual(captured.amount1Max, _MAX_UINT128);
  });

  it("mint() recipient is the signer address", async () => {
    let captured;
    const d = defaultDispatch();
    d[ADDR.pm] = {
      ...d[ADDR.pm],
      mint: async (p) => {
        captured = p;
        return makeMintTx("0xm");
      },
    };
    await mintPosition(
      mockSigner(SIGNER_ADDR),
      buildMockEthersLib({ contractDispatch: d }),
      {
        positionManagerAddress: ADDR.pm,
        token0: ADDR.token0,
        token1: ADDR.token1,
        fee: 3000,
        tickLower: -600,
        tickUpper: 600,
        amount0Desired: 1000n,
        amount1Desired: 1000n,
        slippagePct: 0.5,
        recipient: SIGNER_ADDR,
        deadline: 9999999999n,
      },
    );
    assert.strictEqual(captured.recipient, SIGNER_ADDR);
  });
});

// ── Ownership check ─────────────────────────────────────────────────────────
describe("Fund safety — ownership verification", () => {
  it("rejects rebalance when wallet does not own the NFT", async () => {
    const d = defaultDispatch();
    d[ADDR.pm] = { ...d[ADDR.pm], ownerOf: async () => "0xSomeoneElse" };
    const r = await executeRebalance(
      mockSigner(),
      buildMockEthersLib({ contractDispatch: d }),
      rebalOpts(),
    );
    assert.strictEqual(r.success, false);
    assert.ok(r.error.includes("does not own"));
  });
});

// ── Partial failure ─────────────────────────────────────────────────────────
describe("Fund safety — partial failure", () => {
  it("returns success:false when mint fails after remove", async () => {
    const d = defaultDispatch();
    d[ADDR.pm] = {
      ...d[ADDR.pm],
      mint: async () => {
        throw new Error("mint reverted");
      },
    };
    const r = await executeRebalance(
      mockSigner(),
      buildMockEthersLib({ contractDispatch: d }),
      rebalOpts(),
    );
    assert.strictEqual(r.success, false);
    assert.ok(r.error.includes("mint reverted"));
  });
});

// ── computeDesiredAmounts guards ────────────────────────────────────────────
describe("Fund safety — computeDesiredAmounts guards", () => {
  const S = 10 ** 18;
  const toks18 = { decimals0: 18, decimals1: 18 };
  const toks6_18 = { decimals0: 6, decimals1: 18 };

  const range18 = { currentPrice: 1.0 };
  const range6_18 = { currentPrice: 2000 };

  it("swap amount never exceeds available token0", () => {
    const amount0 = BigInt(S);
    const r = computeDesiredAmounts({ amount0, amount1: 0n }, range18, toks18);
    assert.ok(r.swapAmount <= amount0);
    assert.ok(r.amount0Desired >= 0n);
  });

  it("swap amount never exceeds available token1", () => {
    const amount1 = BigInt(S);
    const r = computeDesiredAmounts({ amount0: 0n, amount1 }, range18, toks18);
    assert.ok(r.swapAmount <= amount1);
    assert.ok(r.amount1Desired >= 0n);
  });

  it("total value preserved (amount0Desired + swapAmount === amount0)", () => {
    const amount0 = BigInt(S);
    const r = computeDesiredAmounts({ amount0, amount1: 0n }, range18, toks18);
    if (r.swapDirection === "token0to1") {
      assert.strictEqual(r.amount0Desired + r.swapAmount, amount0);
    }
  });

  it("handles asymmetric decimals (6 vs 18) without underflow", () => {
    const r = computeDesiredAmounts(
      { amount0: 1_000_000n, amount1: BigInt(S) },
      range6_18,
      toks6_18,
    );
    assert.ok(r.amount0Desired >= 0n);
    assert.ok(r.amount1Desired >= 0n);
  });

  it("handles dust amounts", () => {
    const r = computeDesiredAmounts(
      { amount0: 1n, amount1: 1n },
      range18,
      toks18,
    );
    assert.ok(r.amount0Desired >= 0n);
    assert.ok(r.amount1Desired >= 0n);
  });
});

// ── Mint slippage minimums ──────────────────────────────────────────────────
describe("Fund safety — mint slippage minimums", () => {
  it("mint minimums are zero (no sandwich risk on addLiquidity)", async () => {
    let captured;
    const d = defaultDispatch();
    d[ADDR.pm] = {
      ...d[ADDR.pm],
      mint: async (p) => {
        captured = p;
        return makeMintTx("0xm");
      },
    };
    await mintPosition(
      mockSigner(),
      buildMockEthersLib({ contractDispatch: d }),
      {
        positionManagerAddress: ADDR.pm,
        token0: ADDR.token0,
        token1: ADDR.token1,
        fee: 3000,
        tickLower: -600,
        tickUpper: 600,
        amount0Desired: 1_000_000n,
        amount1Desired: 2_000_000n,
        recipient: ADDR.signer,
        deadline: 9999999999n,
      },
    );
    assert.strictEqual(captured.amount0Min, 0n);
    assert.strictEqual(captured.amount1Min, 0n);
  });
});

// ── New range validity ──────────────────────────────────────────────────────
describe("Fund safety — new range validity", () => {
  it("contains current tick for typical price", () => {
    const price = 1.0;
    const { lowerTick, upperTick } = computeNewRange(price, 20, 60, 18, 18);
    const tick = priceToTick(price, 18, 18);
    assert.ok(lowerTick <= tick);
    assert.ok(upperTick >= tick);
  });
  it("contains current tick for small price", () => {
    const price = 0.00042;
    const { lowerTick, upperTick } = computeNewRange(price, 20, 60, 18, 6);
    const tick = priceToTick(price, 18, 6);
    assert.ok(lowerTick <= tick);
    assert.ok(upperTick >= tick);
  });
  it("lowerTick < upperTick for all standard tick spacings", () => {
    // 9mm Pro tick spacings, including non-standard 50 (fee=2500) and
    // 400 (fee=20000). Production fetches these on-chain from the factory.
    for (const spacing of [1, 10, 50, 60, 200, 400]) {
      const { lowerTick, upperTick } = computeNewRange(
        1.0,
        10,
        spacing,
        18,
        18,
      );
      assert.ok(lowerTick < upperTick);
    }
  });
});
