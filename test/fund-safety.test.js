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

// ── One swap intent produces at most one on-chain swap ───────────────────────

/**
 * The aggregator's timeout recovery cancels a nonce and then re-quotes. Both
 * of those moves spend the balance again if the original swap is still able to
 * mine, and `swapIfNeeded` makes it worse by falling back to the V3 router on
 * any aggregator throw — so a throw is not by itself a safe way to stop.
 *
 * The guard is an `err.nonceUnsettled` flag that the fallback declines. This
 * drives the real chain — `swapIfNeeded` → `swapViaAggregator` →
 * `_sendWithRetry` → `_settleNonce` → `_balanceDiff` — with only the quote
 * endpoint and the signer stubbed, because the flag's whole job is to survive
 * those layers. Stubbing the aggregator module would prove the two halves and
 * not the join: a refactor that re-wrapped the error on its way out would
 * strip the flag, restore the second swap, and pass a module-level test.
 *
 * The assertion is that the rejection still carries `nonceUnsettled`. Had the
 * router run, `swapIfNeeded` would have returned its result or thrown the
 * router's own error instead, neither of which carries the flag.
 */
describe("Fund safety — one swap intent, at most one swap", () => {
  const { swapIfNeeded: realSwapIfNeeded } = require("../src/rebalancer-swap");
  const { _setWaitMsForTests } = require("../src/rebalancer-aggregator");

  /** Quote the stubbed aggregator endpoint returns for both calls. */
  const QUOTE = {
    to: ADDR.router,
    data: "0xdeadbeef",
    value: "0",
    gas: "500000",
    gasPrice: "1000000000",
    buyAmount: "1000",
    estimatedPriceImpact: "0",
    allowanceTarget: ADDR.router,
    sources: [],
  };

  it("declines the router fallback when the swap's nonce is unsettled", async () => {
    const origFetch = globalThis.fetch;
    /*- Two bounded waits run in series — the swap's and the cancel's — so
     *  this is half the runtime of the case.  Not tighter than this: the
     *  suite runs 24 files at once, and a budget close to the scheduler's
     *  own jitter would be measuring the machine rather than the code. */
    _setWaitMsForTests(100);
    globalThis.fetch = async () => ({ ok: true, json: async () => QUOTE });

    const sends = [];
    /*- Neither the swap nor the cancel ever confirms, and no receipt is
     *  readable for either: nobody owns the nonce, and the swap can still
     *  mine.  This is the state with no safe continuation. */
    const neverConfirms = {
      hash: "0xpending",
      nonce: 7,
      wait: () => new Promise(() => {}),
    };
    const signer = {
      getAddress: async () => ADDR.signer,
      sendTransaction: async (req) => {
        sends.push(req);
        return neverConfirms;
      },
      provider: {
        getFeeData: async () => ({ gasPrice: 1_000_000_000n }),
        getTransactionReceipt: async () => null,
      },
    };
    const ethersLib = {
      Contract: class {
        async allowance() {
          /*- Already approved, so `_ensureAllowance` short-circuits and no
           *  approve transaction joins the sequence. */
          return 2n ** 255n;
        }
        async balanceOf() {
          return 0n;
        }
      },
    };

    try {
      await assert.rejects(
        () =>
          realSwapIfNeeded(signer, ethersLib, {
            amountIn: ONE_ETH,
            tokenIn: ADDR.token0,
            tokenOut: ADDR.token1,
            recipient: ADDR.signer,
            swapRouterAddress: ADDR.router,
            slippagePct: 1,
            fee: 3000,
          }),
        (err) => {
          assert.strictEqual(
            err.nonceUnsettled,
            true,
            "flag must survive _sendWithRetry, swapViaAggregator and _balanceDiff",
          );
          return true;
        },
      );
      /*- The swap and its cancel, and nothing after them.  A third send
       *  would be the router's. */
      assert.strictEqual(sends.length, 2);
    } finally {
      globalThis.fetch = origFetch;
      _setWaitMsForTests(null);
    }
  });
});

// ── A live swap is distinguishable from an ordinary failure ──────────────────

describe("Fund safety — a pending swap is distinguishable", () => {
  /**
   * `executeRebalance` reports a failure as an object, and a caller that
   * cannot tell "this failed" from "this failed and a swap may still mine"
   * can only treat both as ordinary. The second leaves the position drained
   * until that nonce resolves, so the flag rides the result rather than only
   * the message prose.
   */
  it("carries nonceUnsettled through to the result", async () => {
    const d = defaultDispatch();
    d[ADDR.pm] = {
      ...d[ADDR.pm],
      mint: async () => {
        const err = new Error("nonce 7 unsettled: swap may still mine");
        err.nonceUnsettled = true;
        throw err;
      },
    };
    const r = await executeRebalance(
      mockSigner(),
      buildMockEthersLib({ contractDispatch: d }),
      rebalOpts(),
    );
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.nonceUnsettled, true);
  });

  it("reports false for an ordinary failure", async () => {
    /*- Without this, a field hard-coded to true would pass the case above
     *  and tell every caller that every failure left a swap pending. */
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
    assert.strictEqual(r.nonceUnsettled, false);
  });
});

// ── Chunked swaps must not be re-swapped by the fallback ─────────────────────

/**
 * `_swapInChunks` splits one swap into three and runs them in sequence, but
 * `params.amountIn` stays the whole amount — each chunk builds its own locally.
 * So a mid-sequence failure used to reach a router fallback holding the FULL
 * original amount, on top of whatever the earlier chunks had already moved.
 *
 * Two chunks of three at two-thirds, plus a full-size router swap, is about
 * 1⅔× the intended trade. The fix keeps the partial instead: the caller mints
 * with the balances it finds, which is what a gate-skipped swap already does,
 * and the corrective and residual-cleanup paths pick up the rest.
 */
describe("Fund safety — a partial chunked swap is not swapped again", () => {
  const AGG_PATH = require.resolve("../src/rebalancer-aggregator");
  const ROUTER_PATH = require.resolve("../src/rebalancer-router");
  const SWAP_PATH = require.resolve("../src/rebalancer-swap");

  const CHUNK_OUT = 500n;

  /**
   * Load `swapIfNeeded` against an aggregator that aborts at full size,
   * succeeds on chunk 1 and fails on chunk 2, and a router that counts calls.
   * @returns {{swapIfNeeded: Function, routerCalls: object}}
   */
  function loadStubs() {
    const routerCalls = { count: 0, amountIn: null };
    const stub = (id, exports) => {
      require.cache[id] = { id, filename: id, loaded: true, exports };
    };
    stub(AGG_PATH, {
      AGGREGATOR_LABEL: "9mm Aggregator",
      swapViaAggregator: async (_s, _e, params) => {
        const label = params._attemptLabel || "";
        if (label.includes("(full)")) {
          const err = new Error("price impact too high");
          err.isSwapImpactAbort = true;
          throw err;
        }
        if (label.includes("chunk 1/3"))
          return { amountOut: CHUNK_OUT, txHash: "0xchunk1", gasCostWei: 7n };
        throw new Error("aggregator HTTP 503 on chunk 2");
      },
    });
    stub(ROUTER_PATH, {
      swapViaRouter: async (_s, _e, params) => {
        routerCalls.count++;
        routerCalls.amountIn = params.amountIn;
        return { amountOut: 9999n, txHash: "0xrouter", gasCostWei: 0n };
      },
    });
    delete require.cache[SWAP_PATH];
    const { swapIfNeeded } = require(SWAP_PATH);
    return { swapIfNeeded, routerCalls };
  }

  it("returns the partial and never calls the router", async () => {
    const { swapIfNeeded, routerCalls } = loadStubs();
    try {
      const out = await swapIfNeeded(
        {},
        {},
        {
          amountIn: 3n * 10n ** 18n,
          tokenIn: ADDR.token0,
          tokenOut: ADDR.token1,
          recipient: ADDR.signer,
          swapRouterAddress: ADDR.router,
          slippagePct: 1,
          fee: 3000,
        },
      );
      assert.strictEqual(out.amountOut, CHUNK_OUT);
      assert.strictEqual(out.txHash, "0xchunk1");
      /*- The whole point: the router holds the full original amountIn, so
       *  one call here would re-swap what chunk 1 already moved. */
      assert.strictEqual(routerCalls.count, 0);
    } finally {
      delete require.cache[AGG_PATH];
      delete require.cache[ROUTER_PATH];
      delete require.cache[SWAP_PATH];
    }
  });
});
