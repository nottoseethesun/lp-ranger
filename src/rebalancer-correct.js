/**
 * @file rebalancer-correct.js
 * @module rebalancerCorrect
 * @description
 * Post-swap corrective rebalance.  The primary swap (step 6) uses the
 * pre-swap pool tick to compute how much to swap, but the swap itself
 * can move our own pool's tick when the aggregator routes through it —
 * shifting `R = need0/need1` against our target and leaving meaningful
 * residuals on the opposite side after mint.
 *
 * This module re-queries the pool after the primary swap, re-runs the
 * SDK ratio computation with the fresh tick and current wallet balances,
 * and if the residual imbalance is above the inflation-resistant dust
 * threshold (see `src/dust.js`), fires a corrective swap before mint.
 *
 * Because the corrective swap can ALSO route through our own pool and
 * shift the tick again, the check is iterative: up to `_MAX_ITERATIONS`
 * rounds (hard cap: 3).  Each round re-reads pool state and balances,
 * stops when the imbalance falls below the dust threshold, and flags
 * `aboveThresholdAfterCap = true` if the cap is reached with residual
 * still above threshold.  The UI surfaces this as a non-blocking
 * warning so the user can manually retry later if they care about the
 * leftover amount.
 *
 * Dust threshold is pegged to units of a reference asset (not USD) so
 * the guard doesn't slowly loosen as fiat inflates.
 */

"use strict";

const {
  ERC20_ABI,
  getPoolState,
  _MIN_SWAP_THRESHOLD,
} = require("./rebalancer-pools");
const { computeDesiredAmounts, swapIfNeeded } = require("./rebalancer-swap");
const { fetchTokenPriceUsd } = require("./price-fetcher");
const { isDust, getDustThresholdUsd } = require("./dust");

/** Hard cap on corrective-swap iterations per rebalance. */
const _MAX_ITERATIONS = 3;

/**
 * @typedef {Object} CorrectiveCtx
 * @property {object} provider                 ethers provider
 * @property {string} signerAddress
 * @property {object} position                 { token0, token1, fee, tokenId }
 * @property {string} factoryAddress
 * @property {{lowerTick: number, upperTick: number}} newRange
 * @property {string} swapRouterAddress
 * @property {number} slippagePct
 * @property {string} [symbol0]
 * @property {string} [symbol1]
 */

/**
 * Run the corrective-swap step, iterating up to `_MAX_ITERATIONS` times
 * because the corrective swap itself can re-shift the tick when routed
 * through our own pool.
 *
 * @param {object} signer      ethers Signer (same as primary rebalance)
 * @param {object} ethersLib   ethers library handle
 * @param {CorrectiveCtx} ctx  Context captured from the main executeRebalance flow.
 * @returns {Promise<{
 *   txHash: string|null,
 *   txHashes: string[],
 *   extra0: bigint,
 *   extra1: bigint,
 *   gasCostWei: bigint,
 *   skipped: boolean,
 *   reason: string,
 *   iterations: number,
 *   aboveThresholdAfterCap: boolean,
 *   finalImbalanceUsd: number,
 *   thresholdUsd: number,
 * }>}
 */
async function correctivelyRebalanceIfNeeded(signer, ethersLib, ctx) {
  console.log(
    "[rebalance] Step 6d: corrective-swap check (up to %d iterations)",
    _MAX_ITERATIONS,
  );
  const acc = _initAccumulator();
  for (let i = 0; i < _MAX_ITERATIONS; i++) {
    const stop = await _runIteration(signer, ethersLib, ctx, acc, i);
    if (stop) return stop;
  }
  return _capExhaustedResult(acc);
}

/**
 * @returns {{
 *   txHashes: string[],
 *   extra0: bigint,
 *   extra1: bigint,
 *   gasCostWei: bigint,
 *   swapSources: string[],
 *   lastImbalanceUsd: number,
 *   lastThresholdUsd: number,
 * }}
 */
function _initAccumulator() {
  return {
    txHashes: [],
    extra0: 0n,
    extra1: 0n,
    gasCostWei: 0n,
    swapSources: [],
    lastImbalanceUsd: 0,
    lastThresholdUsd: 0,
  };
}

/**
 * Run one corrective-swap iteration.  Returns a terminal result object
 * when the loop should stop (converged or nothing to do); returns null
 * to continue to the next iteration.
 */
async function _runIteration(signer, ethersLib, ctx, acc, i) {
  const ps = await getPoolState(ctx.provider, ethersLib, {
    factoryAddress: ctx.factoryAddress,
    token0: ctx.position.token0,
    token1: ctx.position.token1,
    fee: ctx.position.fee,
  });
  const { bal0, bal1 } = await _readBalances(ethersLib, ctx, ps, i);
  const desired = _computeDesired(ps, ctx.newRange, bal0, bal1);
  if (!desired.needsSwap || desired.swapAmount < _MIN_SWAP_THRESHOLD) {
    console.log(
      "[rebalance] Step 6d iter %d/%d: balances match new tick — stop",
      i + 1,
      _MAX_ITERATIONS,
    );
    return i === 0 ? _noopResult("no-swap-needed") : _convergedResult(acc, i);
  }
  const { swapUsd, thresholdUsd } = await _imbalanceUsd(desired, ps, ctx, i);
  acc.lastImbalanceUsd = swapUsd;
  acc.lastThresholdUsd = thresholdUsd;
  if (await isDust(swapUsd)) {
    console.log(
      "[rebalance] Step 6d iter %d/%d: below dust threshold — stop",
      i + 1,
      _MAX_ITERATIONS,
    );
    return i === 0
      ? _noopResult("below-dust-threshold")
      : _convergedResult(acc, i);
  }
  const iter = await _fireCorrectiveSwap(
    signer,
    ethersLib,
    ctx,
    ps,
    desired,
    i,
  );
  if (iter.txHash) acc.txHashes.push(iter.txHash);
  acc.gasCostWei += iter.gasCostWei || 0n;
  acc.extra0 += iter.extra0 || 0n;
  acc.extra1 += iter.extra1 || 0n;
  if (iter.swapSources) acc.swapSources.push(iter.swapSources);
  return null;
}

/** Read wallet balances for both position tokens. */
async function _readBalances(ethersLib, ctx, ps, i) {
  const t0c = new ethersLib.Contract(
    ctx.position.token0,
    ERC20_ABI,
    ctx.provider,
  );
  const t1c = new ethersLib.Contract(
    ctx.position.token1,
    ERC20_ABI,
    ctx.provider,
  );
  const [bal0, bal1] = await Promise.all([
    t0c.balanceOf(ctx.signerAddress),
    t1c.balanceOf(ctx.signerAddress),
  ]);
  console.log(
    "[rebalance] Step 6d iter %d: postSwapTick=%d price=%s bal0=%s bal1=%s",
    i + 1,
    ps.tick,
    ps.price,
    String(bal0),
    String(bal1),
  );
  return { bal0, bal1 };
}

/** Re-run the SDK ratio math with fresh tick + balances. */
function _computeDesired(ps, newRange, bal0, bal1) {
  return computeDesiredAmounts(
    { amount0: bal0, amount1: bal1 },
    {
      currentPrice: ps.price,
      currentTick: ps.tick,
      lowerTick: newRange.lowerTick,
      upperTick: newRange.upperTick,
    },
    { decimals0: ps.decimals0, decimals1: ps.decimals1 },
  );
}

/**
 * Compute USD value of the proposed corrective swap and log dust context.
 * @returns {Promise<{swapUsd: number, thresholdUsd: number}>}
 */
async function _imbalanceUsd(desired, ps, ctx, i) {
  const is0to1 = desired.swapDirection === "token0to1";
  const tokenInAddr = is0to1 ? ctx.position.token0 : ctx.position.token1;
  const decIn = is0to1 ? ps.decimals0 : ps.decimals1;
  const priceInUsd = await fetchTokenPriceUsd(tokenInAddr);
  const swapUsd = (Number(desired.swapAmount) / 10 ** decIn) * priceInUsd;
  const { thresholdUsd, usdPerUnit, units, usedFallback } =
    await getDustThresholdUsd();
  console.log(
    "[rebalance] Step 6d iter %d: imbalance=$%s threshold=$%s (%s units × $%s/unit%s)",
    i + 1,
    swapUsd.toFixed(4),
    thresholdUsd.toFixed(4),
    units.toFixed(8),
    usdPerUnit.toFixed(2),
    usedFallback ? " [FALLBACK — unit price fetch failed]" : "",
  );
  return { swapUsd, thresholdUsd };
}

/** Execute one corrective swap and return iteration deltas. */
async function _fireCorrectiveSwap(signer, ethersLib, ctx, ps, desired, i) {
  const is0to1 = desired.swapDirection === "token0to1";
  const {
    position,
    signerAddress,
    swapRouterAddress,
    slippagePct,
    symbol0,
    symbol1,
    approvalMultiple,
  } = ctx;
  console.log(
    "[rebalance] Step 6d iter %d: firing corrective swap: %s %s -> %s",
    i + 1,
    String(desired.swapAmount),
    is0to1 ? symbol0 || "token0" : symbol1 || "token1",
    is0to1 ? symbol1 || "token1" : symbol0 || "token0",
  );
  const result = await swapIfNeeded(signer, ethersLib, {
    swapRouterAddress,
    fee: position.fee,
    amountIn: desired.swapAmount,
    tokenIn: is0to1 ? position.token0 : position.token1,
    tokenOut: is0to1 ? position.token1 : position.token0,
    slippagePct,
    currentPrice: ps.price,
    decimalsIn: is0to1 ? ps.decimals0 : ps.decimals1,
    decimalsOut: is0to1 ? ps.decimals1 : ps.decimals0,
    isToken0To1: is0to1,
    recipient: signerAddress,
    symbolIn: is0to1 ? symbol0 : symbol1,
    symbolOut: is0to1 ? symbol1 : symbol0,
    approvalMultiple,
  });
  console.log(
    "[rebalance] Step 6d iter %d: corrective swap done, txHash=%s out=%s",
    i + 1,
    result.txHash,
    String(result.amountOut),
  );
  return {
    txHash: result.txHash,
    gasCostWei: result.gasCostWei || 0n,
    extra0: is0to1 ? 0n : result.amountOut,
    extra1: is0to1 ? result.amountOut : 0n,
    swapSources: result.swapSources || null,
  };
}

/** Terminal result: at least one corrective swap fired and residual is now below threshold. */
function _convergedResult(acc, i) {
  return {
    txHash: acc.txHashes[acc.txHashes.length - 1] || null,
    txHashes: acc.txHashes,
    extra0: acc.extra0,
    extra1: acc.extra1,
    gasCostWei: acc.gasCostWei,
    swapSources: acc.swapSources,
    skipped: false,
    reason: "swapped",
    iterations: i,
    aboveThresholdAfterCap: false,
    finalImbalanceUsd: acc.lastImbalanceUsd,
    thresholdUsd: acc.lastThresholdUsd,
  };
}

/** Terminal result: cap exhausted, residual still above threshold. */
function _capExhaustedResult(acc) {
  console.warn(
    "[rebalance] Step 6d: %d iterations exhausted, residual=$%s > threshold=$%s",
    _MAX_ITERATIONS,
    acc.lastImbalanceUsd.toFixed(4),
    acc.lastThresholdUsd.toFixed(4),
  );
  return {
    txHash: acc.txHashes[acc.txHashes.length - 1] || null,
    txHashes: acc.txHashes,
    extra0: acc.extra0,
    extra1: acc.extra1,
    gasCostWei: acc.gasCostWei,
    swapSources: acc.swapSources,
    skipped: false,
    reason: "above-threshold-after-cap",
    iterations: _MAX_ITERATIONS,
    aboveThresholdAfterCap: true,
    finalImbalanceUsd: acc.lastImbalanceUsd,
    thresholdUsd: acc.lastThresholdUsd,
  };
}

/** Terminal result: nothing to do on the first iteration. */
function _noopResult(reason) {
  return {
    txHash: null,
    txHashes: [],
    extra0: 0n,
    extra1: 0n,
    gasCostWei: 0n,
    swapSources: [],
    skipped: true,
    reason,
    iterations: 0,
    aboveThresholdAfterCap: false,
    finalImbalanceUsd: 0,
    thresholdUsd: 0,
  };
}

module.exports = { correctivelyRebalanceIfNeeded, _MAX_ITERATIONS };
