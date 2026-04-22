/**
 * @file rebalancer-execute.js
 * @description Internal helpers for executeRebalance: wallet balances,
 *   swap adjustment, ownership verification, liquidity removal, range
 *   computation, and result building. Split from rebalancer.js for
 *   line-count compliance.
 */

"use strict";

const pools = require("./rebalancer-pools");
const { swapIfNeeded } = require("./rebalancer-swap");

const {
  ERC20_ABI,
  PM_ABI,
  _MIN_SWAP_THRESHOLD,
  getPoolState,
  removeLiquidity,
  rangeMath,
} = pools;

/**
 * Read wallet balances for both position tokens (recovery mode).
 * Used when on-chain liquidity is 0 (prior partial failure).
 */
async function _walletBalances(ethersLib, provider, token0, token1, owner) {
  const t0 = new ethersLib.Contract(token0, ERC20_ABI, provider);
  const t1 = new ethersLib.Contract(token1, ERC20_ABI, provider);
  const [bal0, bal1] = await Promise.all([
    t0.balanceOf(owner),
    t1.balanceOf(owner),
  ]);
  if (bal0 === 0n && bal1 === 0n)
    throw new Error("Position drained and wallet has 0 balance of both tokens");
  return { amount0: bal0, amount1: bal1, txHash: null };
}

/** Perform swap if needed and return adjusted amounts + gas. */
async function _swapAndAdjust(signer, ethersLib, ctx) {
  const {
    desired,
    position: p,
    poolState: ps,
    swapRouterAddress,
    slippagePct,
    signerAddress,
    symbol0,
    symbol1,
  } = ctx;
  if (!desired.needsSwap || desired.swapAmount < _MIN_SWAP_THRESHOLD)
    return { txHash: null, extra0: 0n, extra1: 0n, gasCostWei: 0n };
  const is0to1 = desired.swapDirection === "token0to1";
  const result = await swapIfNeeded(signer, ethersLib, {
    swapRouterAddress,
    fee: p.fee,
    amountIn: desired.swapAmount,
    tokenIn: is0to1 ? p.token0 : p.token1,
    tokenOut: is0to1 ? p.token1 : p.token0,
    slippagePct,
    currentPrice: ps.price,
    decimalsIn: is0to1 ? ps.decimals0 : ps.decimals1,
    decimalsOut: is0to1 ? ps.decimals1 : ps.decimals0,
    isToken0To1: is0to1,
    recipient: signerAddress,
    symbolIn: is0to1 ? symbol0 : symbol1,
    symbolOut: is0to1 ? symbol1 : symbol0,
  });
  return {
    txHash: result.txHash,
    gasCostWei: result.gasCostWei || 0n,
    extra0: is0to1 ? 0n : result.amountOut,
    extra1: is0to1 ? result.amountOut : 0n,
  };
}

/** Verify wallet owns the NFT. Throws on failure. */
async function _verifyOwnership(ethersLib, provider, pmAddr, tokenId, signer) {
  console.log("[rebalance] Step 2: ownerOf NFT #%s…", tokenId);
  const c = new ethersLib.Contract(
    pmAddr,
    ["function ownerOf(uint256 tokenId) view returns (address)"],
    provider,
  );
  let owner;
  try {
    owner = await c.ownerOf(tokenId);
  } catch (e) {
    throw new Error(
      `Cannot verify ownership of NFT #${tokenId}: ${e.message}`,
      { cause: e },
    );
  }
  if (owner.toLowerCase() !== signer.toLowerCase())
    throw new Error(
      `Wallet ${signer} does not own NFT #${tokenId} (owner: ${owner})`,
    );
  console.log("[rebalance] Step 2 done: owner=%s signer=%s", owner, signer);
}

/** Remove liquidity or use wallet balances if already drained. */
async function _removeLiquidityStep(signer, ethersLib, provider, opts) {
  const { positionManagerAddress, position, signerAddress } = opts;
  console.log("[rebalance] Step 3: reading on-chain liquidity…");
  const pmRead = new ethersLib.Contract(
    positionManagerAddress,
    PM_ABI,
    provider,
  );
  const onChainLiquidity = (await pmRead.positions(position.tokenId)).liquidity;
  console.log(
    "[rebalance] Step 3 done: onChainLiquidity=%s",
    String(onChainLiquidity),
  );
  let removed;
  if (onChainLiquidity > 0n) {
    console.log("[rebalance] Step 3a: removeLiquidity…");
    removed = await removeLiquidity(signer, ethersLib, {
      positionManagerAddress,
      tokenId: position.tokenId,
      liquidity: onChainLiquidity,
      recipient: signerAddress,
      token0: position.token0,
      token1: position.token1,
    });
  } else {
    console.log("[rebalance] Step 3a: 0 liquidity — using wallet balances");
    removed = await _walletBalances(
      ethersLib,
      provider,
      position.token0,
      position.token1,
      signerAddress,
    );
  }
  console.log(
    "[rebalance] Step 3a done: amount0=%s amount1=%s",
    String(removed.amount0),
    String(removed.amount1),
  );
  return removed;
}

/** Sum gas costs from multiple rebalance step results. */
function _sumGas(...steps) {
  return steps.reduce((sum, s) => sum + (s.gasCostWei || 0n), 0n);
}

/**
 * Post-swap range adjustment (Step 6b).
 *
 * Problem: the range is computed in Step 4 using the pre-swap pool tick.
 * But the swap itself can have significant price impact — especially on
 * low-liquidity pools where swapping half the collected tokens moves the
 * tick by hundreds of ticks.  If the tick moves past the range boundary,
 * the Position Manager only accepts one token on mint, leaving the other
 * as an unused wallet residual.
 *
 * Fix: re-read the pool tick after the swap completes.  If it moved
 * outside the computed range, shift the range to contain the new tick
 * (same algorithm as the tick containment guard in range-math.js).
 * Width is preserved so the position geometry stays consistent.
 *
 * A second check (Step 6c) runs right before mint to catch the case
 * where the price keeps moving even after this adjustment.
 *
 * When an offset is active (≠ 50), the tick may intentionally be
 * outside the range.  Skip the adjustment to preserve offset intent.
 */
async function _adjustRangeAfterSwap(
  provider,
  ethersLib,
  position,
  factoryAddress,
  poolState,
  newRange,
  offset,
) {
  if (offset !== undefined && offset !== 50) return;
  const ps = await getPoolState(provider, ethersLib, {
    factoryAddress,
    token0: position.token0,
    token1: position.token1,
    fee: position.fee,
  });
  if (ps.tick >= newRange.lowerTick && ps.tick < newRange.upperTick) return;
  const spacing = rangeMath.TICK_SPACINGS[position.fee] ?? 60;
  const width = newRange.upperTick - newRange.lowerTick;
  if (ps.tick < newRange.lowerTick) {
    newRange.lowerTick = Math.floor(ps.tick / spacing) * spacing;
    newRange.upperTick = newRange.lowerTick + width;
  } else {
    newRange.upperTick = (Math.floor(ps.tick / spacing) + 1) * spacing;
    newRange.lowerTick = newRange.upperTick - width;
  }
  console.log(
    "[rebalance] Step 6b: swap moved tick %d → %d, shifted range to [%d, %d]",
    poolState.tick,
    ps.tick,
    newRange.lowerTick,
    newRange.upperTick,
  );
}

/** Compute new tick range: custom width or preserve existing spread. */
function _computeRange(ps, pos, crw, offset) {
  const opts = { offsetToken0Pct: offset ?? 50 };
  console.log(
    "[offset-trace] _computeRange mode=%s offsetToken0Pct=%d tokenId=%s",
    crw ? "custom-width" : "preserve-range",
    opts.offsetToken0Pct,
    String(pos.tokenId),
  );
  return crw
    ? rangeMath.computeNewRange(
        ps.price,
        crw / 2,
        pos.fee,
        ps.decimals0,
        ps.decimals1,
        {
          currentTick: ps.tick,
          ...opts,
        },
      )
    : rangeMath.preserveRange(
        ps.tick,
        pos.tickLower,
        pos.tickUpper,
        pos.fee,
        ps.decimals0,
        ps.decimals1,
        opts,
      );
}

/**
 * Merge primary-swap and corrective-swap source strings into one display
 * label.  When every entry is identical (e.g. all "9mm Aggregator"), we
 * collapse to a single copy — otherwise "9mm Aggregator +3 corrective"
 * would misread as a different route from the primary.  Examples:
 *   primary="9mm Aggregator", corrective=["9mm Aggregator"×3]  → "9mm Aggregator"
 *   primary="9mm Aggregator", corrective=["9mm V3 Router"]     → "9mm Aggregator +1 corrective"
 *   primary=null, corrective=["A","B"]                          → "A,B (corrective)"
 *   primary=null, corrective=[]                                 → undefined
 */
function _mergeSwapSources(primary, corrective) {
  const cArr = Array.isArray(corrective) ? corrective.filter(Boolean) : [];
  if (!primary && cArr.length === 0) return undefined;
  if (!primary) {
    const unique = Array.from(new Set(cArr));
    if (unique.length === 1) return unique[0];
    return cArr.join(",") + " (corrective)";
  }
  if (cArr.length === 0) return primary;
  if (cArr.every((s) => s === primary)) return primary;
  return primary + " +" + cArr.length + " corrective";
}

/** Build success result for executeRebalance. */
function _buildRebalanceResult(
  txHashes,
  removed,
  swapped,
  mintResult,
  position,
  newRange,
  poolState,
  crw,
  corrective,
) {
  const ePct = crw
    ? ((newRange.upperPrice - newRange.lowerPrice) / poolState.price) * 100
    : undefined;
  const mergedSources = _mergeSwapSources(
    swapped.swapSources,
    corrective?.swapSources,
  );
  return {
    success: true,
    txHashes,
    totalGasCostWei: _sumGas(removed, swapped, mintResult, corrective || {}),
    mintGasCostWei: mintResult.gasCostWei || 0n,
    oldTokenId: position.tokenId,
    newTokenId: mintResult.tokenId,
    oldTickLower: position.tickLower,
    oldTickUpper: position.tickUpper,
    newTickLower: newRange.lowerTick,
    newTickUpper: newRange.upperTick,
    currentPrice: poolState.price,
    poolAddress: poolState.poolAddress,
    token0: position.token0,
    token1: position.token1,
    fee: position.fee,
    decimals0: poolState.decimals0,
    decimals1: poolState.decimals1,
    amount0Collected: removed.amount0,
    amount1Collected: removed.amount1,
    liquidity: mintResult.liquidity,
    amount0Minted: mintResult.amount0,
    amount1Minted: mintResult.amount1,
    ...(crw
      ? { requestedRangePct: crw, effectiveRangePct: Number(ePct.toFixed(2)) }
      : {}),
    ...(mergedSources ? { swapSources: mergedSources } : {}),
    ...(corrective?.aboveThresholdAfterCap
      ? {
          residualWarning: {
            iterations: corrective.iterations,
            imbalanceUsd: corrective.finalImbalanceUsd,
            thresholdUsd: corrective.thresholdUsd,
          },
        }
      : {}),
  };
}

/**
 * Step 6c pre-mint volatility check.  Returns a failure result if the
 * tick moved outside the range after the swap, or null to continue.
 * Skipped when offset ≠ 50 (one-sided positions are intentional).
 */
async function _preMintTickCheck(
  provider,
  ethersLib,
  position,
  factoryAddress,
  newRange,
  offset,
) {
  if (offset !== 50) return null;
  const ps = await getPoolState(provider, ethersLib, {
    factoryAddress,
    token0: position.token0,
    token1: position.token1,
    fee: position.fee,
  });
  if (ps.tick >= newRange.lowerTick && ps.tick < newRange.upperTick)
    return null;
  console.warn(
    "[rebalance] Step 6c: tick %d still outside [%d, %d] after adjustment — price too volatile",
    ps.tick,
    newRange.lowerTick,
    newRange.upperTick,
  );
  return {
    success: false,
    priceVolatile: true,
    error: "Price moved during rebalance — backing off",
  };
}

module.exports = {
  _walletBalances,
  _swapAndAdjust,
  _verifyOwnership,
  _removeLiquidityStep,
  _sumGas,
  _adjustRangeAfterSwap,
  _computeRange,
  _buildRebalanceResult,
  _preMintTickCheck,
  _mergeSwapSources,
};
