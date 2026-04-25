"use strict";
/**
 * Rebalancer unit tests — mintPosition, balance-diff swapIfNeeded,
 * _ensureAllowance, executeRebalance.
 */
const { describe, it } = require("node:test");
const assert = require("assert");
const {
  swapIfNeeded,
  mintPosition,
  executeRebalance,
} = require("../src/rebalancer");
const {
  ADDR,
  ONE_ETH,
  INC_TOPIC,
  makeTx,
  makeMintTx,
  mockSigner,
  defaultDispatch,
  buildMockEthersLib,
} = require("./helpers/rebalancer-mocks");

// ── mintPosition ─────────────────────────────────────────────────────────────
describe("mintPosition", () => {
  const mtArgs = (extra) => ({
    positionManagerAddress: ADDR.pm,
    token0: ADDR.token0,
    token1: ADDR.token1,
    fee: 3000,
    tickLower: -600,
    tickUpper: 600,
    amount0Desired: 1000000n,
    amount1Desired: 1000000n,
    slippagePct: 0.5,
    recipient: ADDR.signer,
    deadline: 9999999999n,
    ...extra,
  });

  it("runs the two approvals serially (never overlapping)", async () => {
    // Regression test: parallel Promise.all approvals submit
    // adjacent-nonce TXs that can be routed into the RPC's `queued`
    // sub-pool under load, triggering "queued sub-pool is full"
    // rejections.  The fix in rebalancer.js serialises them.
    let inFlight = 0;
    let maxInFlight = 0;
    const gated = (tag) => async () => {
      inFlight++;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      // Yield to the event loop so a parallel sibling gets a chance to
      // overlap if serialisation were broken.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      inFlight--;
      return makeTx("0x" + tag);
    };
    const d = defaultDispatch();
    d[ADDR.token0] = {
      allowance: async () => 0n,
      approve: gated("a0"),
    };
    d[ADDR.token1] = {
      allowance: async () => 0n,
      approve: gated("a1"),
    };
    d[ADDR.pm] = {
      ...d[ADDR.pm],
      mint: async () => makeMintTx("0xm", 42n, 5000n, 5000n, 7000n),
    };
    await mintPosition(
      mockSigner(),
      buildMockEthersLib({ contractDispatch: d }),
      mtArgs({ amount0Desired: 5000n, amount1Desired: 7000n }),
    );
    assert.strictEqual(
      maxInFlight,
      1,
      "approvals must run one at a time — never two concurrently",
    );
  });

  it("approves exact amounts (not unlimited)", async () => {
    const approvedAmounts = [];
    const d = defaultDispatch();
    d[ADDR.token0] = {
      allowance: async () => 0n,
      approve: async (_s, amt) => {
        approvedAmounts.push(amt);
        return makeTx("0xa");
      },
    };
    d[ADDR.token1] = {
      allowance: async () => 0n,
      approve: async (_s, amt) => {
        approvedAmounts.push(amt);
        return makeTx("0xa");
      },
    };
    d[ADDR.pm] = {
      ...d[ADDR.pm],
      mint: async () => makeMintTx("0xm", 42n, 5000n, 5000n, 7000n),
    };
    await mintPosition(
      mockSigner(),
      buildMockEthersLib({ contractDispatch: d }),
      mtArgs({ amount0Desired: 5000n, amount1Desired: 7000n }),
    );
    assert.ok(approvedAmounts.includes(5000n), "should approve exact amount0");
    assert.ok(approvedAmounts.includes(7000n), "should approve exact amount1");
  });
  it("sets mint mins to zero (no sandwich risk on addLiquidity)", async () => {
    let captured;
    const d = defaultDispatch();
    d[ADDR.pm] = {
      ...d[ADDR.pm],
      mint: async (p) => {
        captured = p;
        return makeMintTx("0xm", 42n, 5000n, 10000n, 20000n);
      },
    };
    await mintPosition(
      mockSigner(),
      buildMockEthersLib({ contractDispatch: d }),
      mtArgs({ amount0Desired: 10000n, amount1Desired: 20000n }),
    );
    assert.strictEqual(captured.amount0Min, 0n);
    assert.strictEqual(captured.amount1Min, 0n);
  });
  it("returns txHash", async () => {
    const d = defaultDispatch();
    d[ADDR.pm] = { ...d[ADDR.pm], mint: async () => makeMintTx("0xmint") };
    const r = await mintPosition(
      mockSigner(),
      buildMockEthersLib({ contractDispatch: d }),
      mtArgs(),
    );
    assert.strictEqual(r.txHash, "0xmint");
  });

  it("parses IncreaseLiquidity event for tokenId and liquidity", async () => {
    const d = defaultDispatch();
    d[ADDR.pm] = {
      ...d[ADDR.pm],
      mint: async () => ({
        wait: async () => ({
          hash: "0xm",
          logs: [
            {
              topics: [INC_TOPIC, "0x" + "0".repeat(63) + "7"], // tokenId = 7
              data:
                "0x" +
                "0".repeat(63) +
                "a" + // liquidity = 10
                "0".repeat(62) +
                "64" + // amount0 = 100
                "0".repeat(62) +
                "c8", // amount1 = 200
            },
          ],
        }),
      }),
    };
    const r = await mintPosition(
      mockSigner(),
      buildMockEthersLib({ contractDispatch: d }),
      mtArgs(),
    );
    assert.strictEqual(r.tokenId, 7n);
    assert.strictEqual(r.liquidity, 10n);
    assert.strictEqual(r.amount0, 100n);
    assert.strictEqual(r.amount1, 200n);
  });

  it("throws when no IncreaseLiquidity event (tokenId=0)", async () => {
    const d = defaultDispatch();
    d[ADDR.pm] = { ...d[ADDR.pm], mint: async () => makeTx("0xm") }; // no event
    await assert.rejects(
      () =>
        mintPosition(
          mockSigner(),
          buildMockEthersLib({ contractDispatch: d }),
          mtArgs({ amount0Desired: 5000n, amount1Desired: 7000n }),
        ),
      { message: /no tokenId was returned/ },
    );
  });
});

// ── swapIfNeeded — balance-diff ──────────────────────────────────────────────
describe("swapIfNeeded — balance-diff output", () => {
  it("returns actual balance-diff as amountOut", async () => {
    let swapped = false;
    const d = defaultDispatch();
    d[ADDR.token1] = {
      ...d[ADDR.token1],
      balanceOf: async () => (swapped ? 1500n : 0n),
    };
    d[ADDR.router] = {
      exactInputSingle: Object.assign(
        async () => {
          swapped = true;
          return makeTx("0xs");
        },
        { staticCall: async (p) => p.amountIn },
      ),
    };
    const r = await swapIfNeeded(
      mockSigner(),
      buildMockEthersLib({ contractDispatch: d }),
      {
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
      },
    );
    assert.strictEqual(r.amountOut, 1500n);
  });

  it("applies slippage to quoted output, not spot price", async () => {
    let captured;
    const quotedOut = 1_998_000_000n; // 0.1% impact (within 0.5% slippage)
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
      {
        swapRouterAddress: ADDR.router,
        tokenIn: ADDR.token0,
        tokenOut: ADDR.token1,
        fee: 3000,
        amountIn: ONE_ETH,
        slippagePct: 0.5,
        recipient: ADDR.signer,
        currentPrice: 2000,
        decimalsIn: 18,
        decimalsOut: 6,
        isToken0To1: true,
        deadline: 9999999999n,
      },
    );
    assert.strictEqual(captured.amountOutMinimum, 1_988_010_000n); // 1998000000 * 9950 / 10000
  });
});

// ── _ensureAllowance — skip when sufficient ──────────────────────────────────
describe("_ensureAllowance skip path", () => {
  it("does not call approve when allowance is already sufficient", async () => {
    let approveCalled = false;
    const d = defaultDispatch();
    d[ADDR.token0] = {
      ...d[ADDR.token0],
      allowance: async () => 9999999n,
      approve: async () => {
        approveCalled = true;
        return makeTx("0xa");
      },
    };
    d[ADDR.token1] = {
      ...d[ADDR.token1],
      allowance: async () => 9999999n,
      approve: async () => {
        approveCalled = true;
        return makeTx("0xa");
      },
    };
    d[ADDR.pm] = { ...d[ADDR.pm], mint: async () => makeMintTx("0xm") };
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
        amount0Desired: 1000n,
        amount1Desired: 1000n,
        slippagePct: 0.5,
        recipient: ADDR.signer,
        deadline: 9999999999n,
      },
    );
    assert.strictEqual(
      approveCalled,
      false,
      "approve should not be called when allowance is sufficient",
    );
  });

  it("approves requiredAmount × approvalMultiple when under-approved", async () => {
    const captured = { t0: null, t1: null };
    const d = defaultDispatch();
    d[ADDR.token0] = {
      ...d[ADDR.token0],
      allowance: async () => 0n,
      approve: async (_spender, amount) => {
        captured.t0 = amount;
        return makeTx("0xa0");
      },
    };
    d[ADDR.token1] = {
      ...d[ADDR.token1],
      allowance: async () => 0n,
      approve: async (_spender, amount) => {
        captured.t1 = amount;
        return makeTx("0xa1");
      },
    };
    d[ADDR.pm] = { ...d[ADDR.pm], mint: async () => makeMintTx("0xm") };
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
        amount0Desired: 1000n,
        amount1Desired: 500n,
        slippagePct: 0.5,
        recipient: ADDR.signer,
        deadline: 9999999999n,
        approvalMultiple: 20,
      },
    );
    assert.strictEqual(captured.t0, 20000n); // 1000 × 20
    assert.strictEqual(captured.t1, 10000n); // 500 × 20
  });

  it("approves exactly requiredAmount when approvalMultiple omitted (default 1x)", async () => {
    const captured = { t0: null, t1: null };
    const d = defaultDispatch();
    d[ADDR.token0] = {
      ...d[ADDR.token0],
      allowance: async () => 0n,
      approve: async (_spender, amount) => {
        captured.t0 = amount;
        return makeTx("0xa0");
      },
    };
    d[ADDR.token1] = {
      ...d[ADDR.token1],
      allowance: async () => 0n,
      approve: async (_spender, amount) => {
        captured.t1 = amount;
        return makeTx("0xa1");
      },
    };
    d[ADDR.pm] = { ...d[ADDR.pm], mint: async () => makeMintTx("0xm") };
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
        amount0Desired: 1000n,
        amount1Desired: 500n,
        slippagePct: 0.5,
        recipient: ADDR.signer,
        deadline: 9999999999n,
      },
    );
    assert.strictEqual(captured.t0, 1000n);
    assert.strictEqual(captured.t1, 500n);
  });
});

// ── V3 fee tier 100 + executeRebalance ────────────────────────────────────────
describe("executeRebalance", () => {
  const basePos = {
    tokenId: 1n,
    token0: ADDR.token0,
    token1: ADDR.token1,
    fee: 3000,
    liquidity: 5000n,
    tickLower: -600,
    tickUpper: 600,
  };
  const rebalOpts = (posOverride) => ({
    position: { ...basePos, ...posOverride },
    factoryAddress: ADDR.factory,
    positionManagerAddress: ADDR.pm,
    swapRouterAddress: ADDR.router,
    slippagePct: 0.5,
  });

  it("fee tier 100 is accepted", async () => {
    const r = await executeRebalance(
      mockSigner(),
      buildMockEthersLib(),
      rebalOpts({ fee: 100, tickLower: -10, tickUpper: 10 }),
    );
    assert.strictEqual(r.success, true);
  });
  it("full happy path returns success:true with txHashes", async () => {
    const r = await executeRebalance(
      mockSigner(),
      buildMockEthersLib(),
      rebalOpts(),
    );
    assert.strictEqual(r.success, true);
    assert.ok(r.txHashes.length >= 2);
    assert.strictEqual(r.oldTokenId, 1n);
  });
  it("returns success:false on error", async () => {
    const d = defaultDispatch();
    d[ADDR.factory] = {
      getPool: async () => {
        throw new Error("rpc failure");
      },
    };
    const r = await executeRebalance(
      mockSigner(),
      buildMockEthersLib({ contractDispatch: d }),
      rebalOpts(),
    );
    assert.strictEqual(r.success, false);
    assert.ok(r.error.includes("rpc failure"));
  });
  it("rejects positions without fee (V2 guard)", async () => {
    await assert.rejects(
      () =>
        executeRebalance(
          mockSigner(),
          buildMockEthersLib(),
          rebalOpts({ fee: 0 }),
        ),
      { message: /Only V3 NFT positions are supported/ },
    );
  });
  it("rejects positions without tokenId", async () => {
    await assert.rejects(
      () =>
        executeRebalance(
          mockSigner(),
          buildMockEthersLib(),
          rebalOpts({ tokenId: undefined }),
        ),
      { message: /Only V3 NFT positions are supported/ },
    );
  });
  it("checks NFT ownership before removing liquidity", async () => {
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
  it("returns liquidity from mint result", async () => {
    const r = await executeRebalance(
      mockSigner(),
      buildMockEthersLib(),
      rebalOpts(),
    );
    assert.strictEqual(r.success, true);
    assert.strictEqual(typeof r.liquidity, "bigint");
    assert.ok(r.liquidity > 0n);
  });
});
