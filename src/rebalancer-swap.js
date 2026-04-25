/**
 * @file rebalancer-swap.js
 * @description Swap logic and amount computation for the 9mm v3
 * Position Manager rebalancer.
 */

"use strict";

const {
  maxLiquidityForAmounts,
  TickMath,
  SqrtPriceMath,
} = require("@uniswap/v3-sdk");
const JSBI = require("jsbi");
const {
  ERC20_ABI,
  SWAP_ROUTER_ABI,
  _MIN_SWAP_THRESHOLD,
  _checkSwapImpact,
  _deadline,
  _waitOrSpeedUp,
  _ensureAllowance,
} = require("./rebalancer-pools");
const { swapViaAggregator } = require("./rebalancer-aggregator");
const config = require("./config");

/**
 * Display label for the V3 router fallback route.  Stamped onto
 * result.swapSources whenever the aggregator fails and we fall back to
 * the 9mm V3 SwapRouter.  Surfaces to the Rebalance Events table only
 * (the Mission Control badge intentionally doesn't track fallbacks —
 * it always reverts to the aggregator default).
 */
const V3_ROUTER_LABEL = "9mm V3 Router";

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Compute the exact token amounts the PM needs for a given tick range using
 * @uniswap/v3-sdk's `maxLiquidityForAmounts` + `SqrtPriceMath`.
 * Returns the amounts the PM would accept, given the available balances.
 *
 * @param {number} currentTick
 * @param {number} tickLower
 * @param {number} tickUpper
 * @param {bigint} avail0  Available token0 (raw units).
 * @param {bigint} avail1  Available token1 (raw units).
 * @returns {{amount0: bigint, amount1: bigint}}
 */
function _sdkTargetAmounts(currentTick, tickLower, tickUpper, avail0, avail1) {
  const sqrtCurrent = TickMath.getSqrtRatioAtTick(currentTick);
  const sqrtLower = TickMath.getSqrtRatioAtTick(tickLower);
  const sqrtUpper = TickMath.getSqrtRatioAtTick(tickUpper);
  const a0 = JSBI.BigInt(String(avail0));
  const a1 = JSBI.BigInt(String(avail1));
  const liq = maxLiquidityForAmounts(
    sqrtCurrent,
    sqrtLower,
    sqrtUpper,
    a0,
    a1,
    true,
  );
  let need0, need1;
  if (currentTick < tickLower) {
    need0 = SqrtPriceMath.getAmount0Delta(sqrtLower, sqrtUpper, liq, true);
    need1 = JSBI.BigInt(0);
  } else if (currentTick >= tickUpper) {
    need0 = JSBI.BigInt(0);
    need1 = SqrtPriceMath.getAmount1Delta(sqrtLower, sqrtUpper, liq, true);
  } else {
    need0 = SqrtPriceMath.getAmount0Delta(sqrtCurrent, sqrtUpper, liq, true);
    need1 = SqrtPriceMath.getAmount1Delta(sqrtLower, sqrtCurrent, liq, true);
  }
  return {
    amount0: BigInt(need0.toString()),
    amount1: BigInt(need1.toString()),
  };
}

/** Solve for ratio-preserving swap amount using the SDK-derived token ratio.
 *
 *  Swap direction is decided by *ratio imbalance* (`f0` vs `R*f1`), not by
 *  mutually-exclusive sign checks on `excess0`/`excess1`. The SDK's
 *  `getAmount{0,1}Delta` rounds up, so the non-binding side often carries
 *  tiny positive dust (`excess > 0` but effectively nothing). The previous
 *  strict `excess <= 0n` guards skipped the swap in that case, leaving
 *  meaningful residuals in the wallet on every rebalance. Ratio-direction
 *  selection uses the residual to maximize minted liquidity instead.
 */
function _ratioSwap(
  nf0,
  nf1,
  amount0,
  amount1,
  f0,
  f1,
  excess0,
  excess1,
  currentPrice,
  decimals0,
  decimals1,
) {
  if (nf0 <= 0 || nf1 <= 0)
    return {
      amount0Desired: amount0,
      amount1Desired: amount1,
      needsSwap: false,
      swapDirection: null,
      swapAmount: 0n,
    };
  const R = nf0 / nf1;
  if (R * f1 > f0 && excess1 > _MIN_SWAP_THRESHOLD) {
    let sw = BigInt(
      Math.max(
        0,
        Math.floor(((R * f1 - f0) / (1 / currentPrice + R)) * 10 ** decimals1),
      ),
    );
    if (sw > amount1) sw = amount1;
    return {
      amount0Desired: amount0,
      amount1Desired: amount1 - sw,
      needsSwap: sw > _MIN_SWAP_THRESHOLD,
      swapDirection: "token1to0",
      swapAmount: sw,
    };
  }
  if (f0 > R * f1 && excess0 > _MIN_SWAP_THRESHOLD) {
    let sw = BigInt(
      Math.max(
        0,
        Math.floor(((f0 - R * f1) / (1 + R * currentPrice)) * 10 ** decimals0),
      ),
    );
    if (sw > amount0) sw = amount0;
    return {
      amount0Desired: amount0 - sw,
      amount1Desired: amount1,
      needsSwap: sw > _MIN_SWAP_THRESHOLD,
      swapDirection: "token0to1",
      swapAmount: sw,
    };
  }
  return {
    amount0Desired: amount0,
    amount1Desired: amount1,
    needsSwap: false,
    swapDirection: null,
    swapAmount: 0n,
  };
}

/** Fallback: compute swap for in-range position when starting balance is fully single-sided. */
function _inRangeFallbackSwap(
  currentTick,
  lowerTick,
  upperTick,
  amount0,
  amount1,
  f0,
  f1,
  currentPrice,
  decimals0,
  decimals1,
) {
  const ref = _sdkTargetAmounts(
    currentTick,
    lowerTick,
    upperTick,
    10n ** BigInt(decimals0),
    10n ** BigInt(decimals1),
  );
  const rf0 = Number(ref.amount0) / 10 ** decimals0,
    rf1 = Number(ref.amount1) / 10 ** decimals1;
  if (rf0 <= 0 || rf1 <= 0) return null;
  const R = rf0 / rf1;
  console.log(
    "[rebalance] computeDesired: in-range fallback ratio=%s",
    R.toFixed(6),
  );
  if (f1 > 0 && f0 === 0) {
    let sw = BigInt(
      Math.floor(((R * f1) / (1 / currentPrice + R)) * 10 ** decimals1),
    );
    if (sw > amount1) sw = amount1;
    return {
      amount0Desired: 0n,
      amount1Desired: amount1 - sw,
      needsSwap: sw > _MIN_SWAP_THRESHOLD,
      swapDirection: "token1to0",
      swapAmount: sw,
    };
  }
  if (f0 > 0 && f1 === 0) {
    let sw = BigInt(
      Math.floor((f0 / (1 + R * currentPrice)) * 10 ** decimals0),
    );
    if (sw > amount0) sw = amount0;
    return {
      amount0Desired: amount0 - sw,
      amount1Desired: 0n,
      needsSwap: sw > _MIN_SWAP_THRESHOLD,
      swapDirection: "token0to1",
      swapAmount: sw,
    };
  }
  return null;
}

/**
 * SDK path: compute ratio-preserving swap using the position's geometric ratio.
 * Solves for the swap amount that produces the correct post-swap token ratio,
 * preventing over-conversion that strands tokens in the wallet.
 */
function _sdkSwap(
  amount0,
  amount1,
  f0,
  f1,
  currentPrice,
  currentTick,
  lowerTick,
  upperTick,
  decimals0,
  decimals1,
) {
  const needed = _sdkTargetAmounts(
    currentTick,
    lowerTick,
    upperTick,
    amount0,
    amount1,
  );
  const nf0 = Number(needed.amount0) / 10 ** decimals0;
  const nf1 = Number(needed.amount1) / 10 ** decimals1;
  const excess0 = amount0 - needed.amount0,
    excess1 = amount1 - needed.amount1;
  console.log(
    "[rebalance] computeDesired (SDK): need0=%s need1=%s excess0=%s excess1=%s",
    String(needed.amount0),
    String(needed.amount1),
    String(excess0),
    String(excess1),
  );

  // When SDK returns 0/0 but tick is IN range (needs both tokens), compute
  // the target ratio from the range geometry and swap to achieve it.
  const inRange = currentTick >= lowerTick && currentTick < upperTick;
  if (needed.amount0 === 0n && needed.amount1 === 0n && inRange) {
    const fb = _inRangeFallbackSwap(
      currentTick,
      lowerTick,
      upperTick,
      amount0,
      amount1,
      f0,
      f1,
      currentPrice,
      decimals0,
      decimals1,
    );
    if (fb) return fb;
  }
  // Fully one-sided (tick outside range): swap everything to the needed token
  if (needed.amount1 === 0n && amount1 > _MIN_SWAP_THRESHOLD)
    return {
      amount0Desired: amount0,
      amount1Desired: 0n,
      needsSwap: true,
      swapDirection: "token1to0",
      swapAmount: amount1,
    };
  if (needed.amount0 === 0n && amount0 > _MIN_SWAP_THRESHOLD)
    return {
      amount0Desired: 0n,
      amount1Desired: amount1,
      needsSwap: true,
      swapDirection: "token0to1",
      swapAmount: amount0,
    };

  return _ratioSwap(
    nf0,
    nf1,
    amount0,
    amount1,
    f0,
    f1,
    excess0,
    excess1,
    currentPrice,
    decimals0,
    decimals1,
  );
}

// ── Exported functions ───────────────────────────────────────────────────────

/**
 * Compute desired token amounts and swap direction for the new range.
 *
 * Uses @uniswap/v3-sdk exact 160-bit sqrtPrice math to determine the
 * precise token ratio the Position Manager needs, then computes a
 * ratio-preserving swap so post-swap balances match the position geometry.
 */
function computeDesiredAmounts(available, range, tokens) {
  const { amount0, amount1 } = available;
  const { currentPrice, currentTick, lowerTick, upperTick } = range;
  const { decimals0, decimals1 } = tokens;
  const f0 = Number(amount0) / 10 ** decimals0,
    f1 = Number(amount1) / 10 ** decimals1;
  console.log(
    "[rebalance] computeDesired: price=%s f0=%s f1=%s",
    currentPrice,
    f0.toFixed(6),
    f1.toFixed(6),
  );
  if (f0 === 0 && f1 === 0)
    return {
      amount0Desired: 0n,
      amount1Desired: 0n,
      needsSwap: false,
      swapDirection: null,
      swapAmount: 0n,
    };

  // SDK path when tick range is provided
  if (
    lowerTick !== null &&
    lowerTick !== undefined &&
    upperTick !== null &&
    upperTick !== undefined &&
    currentTick !== null &&
    currentTick !== undefined
  ) {
    return _sdkSwap(
      amount0,
      amount1,
      f0,
      f1,
      currentPrice,
      currentTick,
      lowerTick,
      upperTick,
      decimals0,
      decimals1,
    );
  }

  // ── Fallback: 50/50 value split (no tick range provided) ────────────────
  const val0 = f0 * currentPrice,
    val1 = f1;
  const total = val0 + val1;
  if (total === 0)
    return {
      amount0Desired: 0n,
      amount1Desired: 0n,
      needsSwap: false,
      swapDirection: null,
      swapAmount: 0n,
    };
  const diff = val0 - val1;
  if (Math.abs(diff) / total < 0.01) {
    return {
      amount0Desired: amount0,
      amount1Desired: amount1,
      needsSwap: false,
      swapDirection: null,
      swapAmount: 0n,
    };
  }
  if (diff > 0) {
    const sw = BigInt(Math.floor((diff / 2 / currentPrice) * 10 ** decimals0));
    return {
      amount0Desired: amount0 - sw,
      amount1Desired: amount1,
      needsSwap: sw > _MIN_SWAP_THRESHOLD,
      swapDirection: "token0to1",
      swapAmount: sw,
    };
  }
  const sw = BigInt(Math.floor((Math.abs(diff) / 2) * 10 ** decimals1));
  return {
    amount0Desired: amount0,
    amount1Desired: amount1 - sw,
    needsSwap: sw > _MIN_SWAP_THRESHOLD,
    swapDirection: "token1to0",
    swapAmount: sw,
  };
}

/**
 * Swap via the V3 SwapRouter if amount exceeds the minimum threshold.
 *
 * @param {object} signer
 * @param {object} ethersLib
 * @param {object} params
 * @param {string} params.swapRouterAddress
 * @param {string} params.tokenIn
 * @param {string} params.tokenOut
 * @param {number} params.fee
 * @param {bigint} params.amountIn
 * @param {number} params.slippagePct
 * @param {number} params.currentPrice      Current pool price (token1 per token0).
 * @param {number} params.decimalsIn        Decimals of the input token.
 * @param {number} params.decimalsOut       Decimals of the output token.
 * @param {boolean} params.isToken0To1      True when selling token0 for token1.
 * @param {string} params.recipient
 * @param {bigint} [params.deadline]
 * @returns {Promise<{amountOut: bigint, txHash: string|null}>}
 */
/** Compute gas cost from a TX receipt. */
function _gasCost(r) {
  return (r.gasUsed ?? 0n) * (r.gasPrice ?? r.effectiveGasPrice ?? 0n);
}
async function _balanceDiff(ethersLib, tokenOut, recipient, prov, fn) {
  const outC = new ethersLib.Contract(tokenOut, ERC20_ABI, prov);
  const before = await outC.balanceOf(recipient);
  const result = await fn();
  const diff = (await outC.balanceOf(recipient)) - before;
  return { ...result, amountOut: diff > 0n ? diff : 0n };
}

/** Swap via aggregator — delegates to rebalancer-aggregator.js. */
async function _swapViaAggregator(signer, ethersLib, params) {
  return swapViaAggregator(signer, ethersLib, params, _balanceDiff);
}

/**
 * Swap via V3 SwapRouter (fallback path — single pool).
 * This is the original swap logic, preserved as a fallback.
 */
async function _swapViaRouter(signer, ethersLib, params) {
  const {
    swapRouterAddress,
    tokenIn,
    tokenOut,
    fee,
    amountIn,
    slippagePct,
    currentPrice,
    decimalsIn,
    decimalsOut,
    isToken0To1,
    recipient,
    deadline,
    approvalMultiple,
  } = params;
  const { Contract } = ethersLib;
  const signerAddr = await signer.getAddress();
  const approvalGas = await _ensureAllowance(
    new Contract(tokenIn, ERC20_ABI, signer),
    signerAddr,
    swapRouterAddress,
    amountIn,
    approvalMultiple,
  );
  const router = new Contract(swapRouterAddress, SWAP_ROUTER_ABI, signer);
  const dl = deadline || _deadline();
  const swapParams = {
    tokenIn,
    tokenOut,
    fee,
    recipient,
    deadline: dl,
    amountIn,
    amountOutMinimum: 0n,
    sqrtPriceLimitX96: 0n,
  };
  let quotedOut;
  try {
    quotedOut = await router.exactInputSingle.staticCall(swapParams);
  } catch (e) {
    throw new Error("Swap quote failed: " + e.message, { cause: e });
  }
  if (quotedOut === 0n) throw new Error("Swap aborted: no pool liquidity.");
  const slip = slippagePct ?? 0.5;
  const spotRate = isToken0To1 ? currentPrice : 1 / currentPrice;
  const spotExpected =
    (Number(amountIn) / 10 ** decimalsIn) * spotRate * 10 ** decimalsOut;
  const impactPct =
    spotExpected > 0
      ? Math.max(0, ((spotExpected - Number(quotedOut)) / spotExpected) * 100)
      : 0;
  console.log(
    "[rebalance] swap (V3 router): quote=%s spot=%s impact=%s%% slip=%s%%",
    String(quotedOut),
    spotExpected.toFixed(0),
    impactPct.toFixed(2),
    slip,
  );
  _checkSwapImpact(impactPct, slip);
  const slipBps = Math.round(slip * 100);
  swapParams.amountOutMinimum = (quotedOut * BigInt(10000 - slipBps)) / 10000n;
  const provider = signer.provider || signer;
  return _balanceDiff(ethersLib, tokenOut, recipient, provider, async () => {
    const tx = await router.exactInputSingle(swapParams, {
      type: config.TX_TYPE,
    });
    console.log(
      "[rebalance] Step 6: swap (V3 router): TX submitted, hash= %s nonce=%d" +
        " type=%s gasPrice=%s",
      tx.hash,
      tx.nonce,
      String(tx.type),
      String(tx.gasPrice ?? tx.maxFeePerGas ?? "—"),
    );
    const receipt = await _waitOrSpeedUp(tx, signer, "swap");
    console.log(
      "[rebalance] swap (V3 router): confirmed gasUsed=%s",
      String(receipt.gasUsed),
    );
    console.log(
      "[route-trace] V3-router fallback swapSources=%s",
      V3_ROUTER_LABEL,
    );
    return {
      txHash: receipt.hash,
      gasCostWei: _gasCost(receipt) + (approvalGas || 0n),
      swapSources: V3_ROUTER_LABEL,
    };
  });
}

/** True when the error is a slippage/impact abort. */

/** True when aggregator exhausted all retry attempts (reverts + timeouts). */
function _isAggregatorExhausted(err) {
  return err?.message?.startsWith("Aggregator swap failed after");
}

/**
 * Execute a swap in N equal chunks to reduce per-swap impact.
 * Each chunk runs sequentially (prior chunks move the price).
 */
async function _swapInChunks(swapFn, signer, ethersLib, params, n) {
  const total = params.amountIn;
  const chunk = total / BigInt(n);
  const remainder = total - chunk * BigInt(n);
  let amountOut = 0n,
    gasCostWei = 0n,
    txHash = null;
  /*- Preserve swapSources across chunks so the rebalance log displays
   *  "NineMM_V3+DEX_X" rather than "(no swap)" after a chunked retry. */
  const sources = [];
  for (let i = 0; i < n; i++) {
    const amt = i === n - 1 ? chunk + remainder : chunk;
    if (amt < _MIN_SWAP_THRESHOLD) continue;
    console.log("[rebalance] chunk %d/%d: %s", i + 1, n, String(amt));
    const r = await swapFn(signer, ethersLib, { ...params, amountIn: amt });
    amountOut += r.amountOut;
    gasCostWei += r.gasCostWei || 0n;
    txHash = r.txHash || txHash;
    if (r.swapSources) sources.push(r.swapSources);
  }
  return {
    amountOut,
    txHash,
    gasCostWei,
    ...(sources.length ? { swapSources: sources.join("+") } : {}),
  };
}

/**
 * Swap tokens if needed for rebalancing.
 * Tries 9mm DEX Aggregator first (lowest slippage),
 * falls back to V3 SwapRouter on failure.
 * Both paths try chunking (3 equal parts) on slippage error.
 * @param {object} signer      ethers Signer.
 * @param {object} ethersLib   ethers library.
 * @param {object} params      Swap parameters.
 * @returns {Promise<{amountOut: bigint, txHash: string|null, gasCostWei: bigint}>}
 */
async function swapIfNeeded(signer, ethersLib, params) {
  if (params.amountIn < _MIN_SWAP_THRESHOLD)
    return { amountOut: 0n, txHash: null, gasCostWei: 0n };
  try {
    return await _swapViaAggregator(signer, ethersLib, params);
  } catch (err) {
    // Aggregator exhausted all retries at full amount — try 3 smaller
    // chunks via the aggregator before giving up on it entirely.
    // Smaller amounts = lower impact on multi-hop routes.
    if (_isAggregatorExhausted(err)) {
      console.warn(
        "[rebalance] Aggregator failed at full amount" +
          " — retrying in 3 chunks via aggregator",
      );
      try {
        return await _swapInChunks(
          _swapViaAggregator,
          signer,
          ethersLib,
          params,
          3,
        );
      } catch (chunkErr) {
        console.warn(
          "[rebalance] Aggregator chunks also failed: %s" +
            " — falling back to V3 router",
          chunkErr.message,
        );
      }
    } else {
      console.warn(
        "[rebalance] Aggregator failed: %s" + " — falling back to V3 router",
        err.message,
      );
    }
    return await _swapViaRouter(signer, ethersLib, params);
  }
}

// ── Module exports ───────────────────────────────────────────────────────────

module.exports = {
  computeDesiredAmounts,
  swapIfNeeded,
};
