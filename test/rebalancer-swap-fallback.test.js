"use strict";

/**
 * @file test/rebalancer-swap-fallback.test.js
 * @description Tests for the swap-fallback chain in swapIfNeeded:
 * aggregator (full) → aggregator (chunks, ONLY on slippage abort) →
 * V3 SwapRouter.  Chunking is fundamentally an impact-reduction tool,
 * so it's only attempted when the aggregator slippage-aborts.
 * Non-impact failures (HTTP 500, TX revert, no liquidity) bypass
 * chunking and fall straight to the V3 router — chunking a broken
 * route just burns nonces without changing the outcome.
 *
 * Split out of rebalancer-failures.test.js for line-count compliance.
 */

const { describe, it } = require("node:test");
const assert = require("assert");
const { swapIfNeeded } = require("../src/rebalancer");
const {
  ADDR,
  makeTx,
  mockSigner,
  defaultDispatch,
  buildMockEthersLib,
} = require("./helpers/rebalancer-mocks");

/*- Use amountIn=10_000n so 3 chunks of ~3333n each clear the
 *  _MIN_SWAP_THRESHOLD=1000n guard and the chunking path actually
 *  attempts the per-chunk swap.  Smaller values cause _swapInChunks
 *  to bail with "Cannot chunk" before any retry is observable. */
const swArgs = (extra) => ({
  swapRouterAddress: ADDR.router,
  tokenIn: ADDR.token0,
  tokenOut: ADDR.token1,
  fee: 3000,
  amountIn: 10000n,
  slippagePct: 0.5,
  recipient: ADDR.signer,
  currentPrice: 1.0,
  decimalsIn: 18,
  decimalsOut: 18,
  isToken0To1: true,
  deadline: 9999999999n,
  ...extra,
});

describe("swapIfNeeded — chunking gated on slippage abort", () => {
  it("retries aggregator in 3 chunks on slippage abort (lowers per-swap impact)", async () => {
    /*- Aggregator full-amount slippage-aborts at 6% > 0.5%.  Chunks
     *  run via the same aggregator; each chunk is allowed to also
     *  abort — what matters is that chunking was attempted before
     *  falling through to V3 router. */
    const origFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = async () => {
      fetchCount++;
      return {
        ok: true,
        json: async () => ({
          estimatedPriceImpact: "6",
          buyAmount: "1",
          sources: [],
        }),
      };
    };
    try {
      const d = defaultDispatch();
      d[ADDR.router] = {
        exactInputSingle: Object.assign(async () => makeTx("0xs"), {
          staticCall: async () => 1400n,
        }),
      };
      await assert.rejects(() =>
        swapIfNeeded(
          mockSigner(),
          buildMockEthersLib({ contractDispatch: d }),
          swArgs(),
        ),
      );
      // 1 full + at least 1 chunk before chunk1 throws and we fall through
      assert.ok(
        fetchCount >= 2,
        `expected ≥2 aggregator fetches (full + chunk), got ${fetchCount}`,
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("does NOT chunk on non-impact aggregator failure (HTTP 500 → straight to V3 router)", async () => {
    /*- A broken route at full size is broken at 1/3 size too — chunking
     *  only burns more aggregator fetches before falling through.
     *  Verify that a non-impact failure goes straight to V3 router with
     *  exactly one aggregator fetch (no chunked retries). */
    const origFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = async () => {
      fetchCount++;
      return { ok: false, status: 500, json: async () => ({}) };
    };
    try {
      const d = defaultDispatch();
      // Track post-swap balance change so balanceDiff returns nonzero
      let swapped = false;
      d[ADDR.token1] = {
        ...d[ADDR.token1],
        balanceOf: async () => (swapped ? 9000n : 0n),
      };
      let routerCalled = false;
      d[ADDR.router] = {
        exactInputSingle: Object.assign(
          async () => {
            swapped = true;
            routerCalled = true;
            return makeTx("0xs");
          },
          { staticCall: async (p) => p.amountIn },
        ),
      };
      const r = await swapIfNeeded(
        mockSigner(),
        buildMockEthersLib({ contractDispatch: d }),
        swArgs(),
      );
      assert.ok(routerCalled, "V3 router should have been called");
      assert.ok(r.amountOut > 0n, "expected successful V3 router swap");
      // Only 1 aggregator fetch (the failed full-amount attempt) — no chunks
      assert.strictEqual(
        fetchCount,
        1,
        `expected exactly 1 aggregator fetch (no chunking), got ${fetchCount}`,
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
