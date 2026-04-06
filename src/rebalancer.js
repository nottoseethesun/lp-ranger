/**
 * @file rebalancer.js
 * @description Mint, execution, and orchestration for the 9mm v3
 * Position Manager rebalancer.  Re-exports all public symbols from
 * rebalancer-pools and rebalancer-swap so external callers are
 * unaffected by the split.
 */

"use strict";

const pools = require("./rebalancer-pools");
const { computeDesiredAmounts, swapIfNeeded } = require("./rebalancer-swap");

const {
  ERC20_ABI,
  PM_ABI,
  _MAX_UINT128,
  _DEADLINE_SECONDS,
  _MIN_SWAP_THRESHOLD,
  V3_FEE_TIERS,
  _deadline,
  _waitOrSpeedUp,
  _ensureAllowance,
  getPoolState,
  removeLiquidity,
  logSwapNeeded,
  rangeMath,
  config,
} = pools;

// ── Mint ─────────────────────────────────────────────────────────────────────

/** Mint a new V3 liquidity position via the NonfungiblePositionManager. */
async function mintPosition(
  signer,
  ethersLib,
  {
    positionManagerAddress,
    token0,
    token1,
    fee,
    tickLower,
    tickUpper,
    amount0Desired,
    amount1Desired,
    recipient,
    deadline,
  },
) {
  const { Contract } = ethersLib;
  const signerAddress = await signer.getAddress();
  const token0Contract = new Contract(token0, ERC20_ABI, signer);
  const token1Contract = new Contract(token1, ERC20_ABI, signer);
  // prettier-ignore
  console.log("[rebalance] Step 7a: ensureAllowance — a0=%s a1=%s", String(amount0Desired), String(amount1Desired));
  // prettier-ignore
  const [appGas0, appGas1] = await Promise.all([_ensureAllowance(token0Contract, signerAddress, positionManagerAddress, amount0Desired), _ensureAllowance(token1Contract, signerAddress, positionManagerAddress, amount1Desired)]);

  const pm = new Contract(positionManagerAddress, PM_ABI, signer);
  const dl = deadline ?? _deadline();
  // prettier-ignore
  console.log("[rebalance] Step 7b: mint — fee=%d tL=%d tU=%d a0d=%s a1d=%s", fee, tickLower, tickUpper, String(amount0Desired), String(amount1Desired));
  // prettier-ignore
  const tx = await pm.mint({ token0, token1, fee, tickLower, tickUpper, amount0Desired, amount1Desired, amount0Min: 0n, amount1Min: 0n, recipient, deadline: dl }, { type: config.TX_TYPE, gasLimit: config.CHAIN.contracts?.positionManager?.mintGasLimit || 600000 });
  // prettier-ignore
  console.log("[rebalance] Step 7b: TX submitted, hash= %s nonce=%d type=%s gasLimit=%s gasPrice=%s", tx.hash, tx.nonce, String(tx.type), String(tx.gasLimit), String(tx.gasPrice ?? "—"));
  const receipt = await _waitOrSpeedUp(tx, signer, "mint");
  // prettier-ignore
  console.log("[rebalance] Step 7c: mint confirmed, block=%s gasUsed=%s", receipt.blockNumber, String(receipt.gasUsed));

  const { tokenId, liquidity, amount0, amount1 } = _parseMintReceipt(
    receipt,
    amount0Desired,
    amount1Desired,
  );

  // prettier-ignore
  console.log("[rebalance] Mint: desired0=%s desired1=%s actual0=%s actual1=%s liq=%s", String(amount0Desired), String(amount1Desired), String(amount0), String(amount1), String(liquidity));
  const mintGas =
    (receipt.gasUsed ?? 0n) *
    (receipt.gasPrice ?? receipt.effectiveGasPrice ?? 0n);
  const gasCostWei = mintGas + (appGas0 || 0n) + (appGas1 || 0n);
  return {
    tokenId,
    liquidity,
    amount0,
    amount1,
    txHash: receipt.hash,
    gasCostWei,
  };
}

// ── Internal helpers ─────────────────────────────────────────────────────────

const _INC_TOPIC =
  "0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f";

/** Parse the IncreaseLiquidity event from a mint TX receipt. */
function _parseMintReceipt(receipt, amount0Desired, amount1Desired) {
  let tokenId = 0n;
  let liquidity = 0n;
  let amount0 = amount0Desired;
  let amount1 = amount1Desired;
  if (receipt.logs) {
    for (const log of receipt.logs) {
      if (log.topics && log.topics[0] === _INC_TOPIC && log.data) {
        try {
          tokenId = BigInt(log.topics[1]);
          const data = log.data.replace(/^0x/, "");
          liquidity = BigInt("0x" + data.slice(0, 64));
          amount0 = BigInt("0x" + data.slice(64, 128));
          amount1 = BigInt("0x" + data.slice(128, 192));
        } catch (_) {
          /* fall through to defaults */
        }
        break;
      }
    }
  }
  if (tokenId === 0n)
    throw new Error(
      "Mint succeeded but no tokenId was returned — check IncreaseLiquidity event parsing",
    );
  if (liquidity === 0n)
    throw new Error("Mint returned zero liquidity — position would be empty");
  return { tokenId, liquidity, amount0, amount1 };
}

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
  // prettier-ignore
  const { desired, position: p, poolState: ps, swapRouterAddress, slippagePct, signerAddress, symbol0, symbol1 } = ctx;
  if (!desired.needsSwap || desired.swapAmount < _MIN_SWAP_THRESHOLD)
    return { txHash: null, extra0: 0n, extra1: 0n, gasCostWei: 0n };
  const is0to1 = desired.swapDirection === "token0to1";
  // prettier-ignore
  const result = await swapIfNeeded(signer, ethersLib, { swapRouterAddress, fee: p.fee, amountIn: desired.swapAmount, tokenIn: is0to1 ? p.token0 : p.token1, tokenOut: is0to1 ? p.token1 : p.token0, slippagePct, currentPrice: ps.price, decimalsIn: is0to1 ? ps.decimals0 : ps.decimals1, decimalsOut: is0to1 ? ps.decimals1 : ps.decimals0, isToken0To1: is0to1, recipient: signerAddress, symbolIn: is0to1 ? symbol0 : symbol1, symbolOut: is0to1 ? symbol1 : symbol0 });
  // prettier-ignore
  return { txHash: result.txHash, gasCostWei: result.gasCostWei || 0n, extra0: is0to1 ? 0n : result.amountOut, extra1: is0to1 ? result.amountOut : 0n };
}

/** Verify wallet owns the NFT. Throws on failure. */
async function _verifyOwnership(ethersLib, provider, pmAddr, tokenId, signer) {
  console.log("[rebalance] Step 2: ownerOf NFT #%s…", tokenId);
  // prettier-ignore
  const c = new ethersLib.Contract(pmAddr, ["function ownerOf(uint256 tokenId) view returns (address)"], provider);
  let owner;
  try {
    owner = await c.ownerOf(tokenId);
  } catch (e) {
    throw new Error(
      `Cannot verify ownership of NFT #${tokenId}: ${e.message}`,
      { cause: e },
    );
  }
  // prettier-ignore
  if (owner.toLowerCase() !== signer.toLowerCase()) throw new Error(`Wallet ${signer} does not own NFT #${tokenId} (owner: ${owner})`);
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
    // prettier-ignore
    removed = await removeLiquidity(signer, ethersLib, { positionManagerAddress, tokenId: position.tokenId, liquidity: onChainLiquidity, recipient: signerAddress, token0: position.token0, token1: position.token1 });
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
  // prettier-ignore
  console.log("[rebalance] Step 3a done: amount0=%s amount1=%s", String(removed.amount0), String(removed.amount1));
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
 */
async function _adjustRangeAfterSwap(
  provider,
  ethersLib,
  position,
  factoryAddress,
  poolState,
  newRange,
) {
  // prettier-ignore
  const ps = await getPoolState(provider, ethersLib, { factoryAddress, token0: position.token0, token1: position.token1, fee: position.fee });
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
  // prettier-ignore
  console.log("[rebalance] Step 6b: swap moved tick %d → %d, shifted range to [%d, %d]", poolState.tick, ps.tick, newRange.lowerTick, newRange.upperTick);
}

/** Compute new tick range: custom width or preserve existing spread. */
function _computeRange(ps, pos, crw) {
  // prettier-ignore
  return crw ? rangeMath.computeNewRange(ps.price, crw / 2, pos.fee, ps.decimals0, ps.decimals1, { currentTick: ps.tick }) : rangeMath.preserveRange(ps.tick, pos.tickLower, pos.tickUpper, pos.fee, ps.decimals0, ps.decimals1);
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
) {
  // prettier-ignore
  const ePct = crw ? ((newRange.upperPrice - newRange.lowerPrice) / poolState.price) * 100 : undefined;
  // prettier-ignore
  return { success: true, txHashes, totalGasCostWei: _sumGas(removed, swapped, mintResult), mintGasCostWei: mintResult.gasCostWei || 0n, oldTokenId: position.tokenId, newTokenId: mintResult.tokenId, oldTickLower: position.tickLower, oldTickUpper: position.tickUpper, newTickLower: newRange.lowerTick, newTickUpper: newRange.upperTick, currentPrice: poolState.price, poolAddress: poolState.poolAddress, decimals0: poolState.decimals0, decimals1: poolState.decimals1, amount0Collected: removed.amount0, amount1Collected: removed.amount1, liquidity: mintResult.liquidity, amount0Minted: mintResult.amount0, amount1Minted: mintResult.amount1, ...(crw ? { requestedRangePct: crw, effectiveRangePct: Number(ePct.toFixed(2)) } : {}) };
}

/** Execute a complete rebalance: remove → swap → mint at new range. */
async function executeRebalance(signer, ethersLib, opts) {
  const {
    position,
    factoryAddress,
    positionManagerAddress,
    swapRouterAddress,
    slippagePct,
    customRangeWidthPct,
  } = opts;
  if (!position.tokenId || !position.fee || position.fee <= 0) {
    throw new Error(
      "Only V3 NFT positions are supported. V2 positions use a different contract and cannot be rebalanced by this tool.",
    );
  }
  try {
    const txHashes = [],
      signerAddress = await signer.getAddress(),
      provider = signer.provider || signer;

    // 1. Get current pool state
    console.log("[rebalance] Step 1: getPoolState…");
    // prettier-ignore
    const poolState = await getPoolState(provider, ethersLib, { factoryAddress, token0: position.token0, token1: position.token1, fee: position.fee });
    console.log(
      "[rebalance] Step 1 done: tick=%d price=%s",
      poolState.tick,
      poolState.price,
    );

    // 2. Verify ownership
    await _verifyOwnership(
      ethersLib,
      provider,
      positionManagerAddress,
      position.tokenId,
      signerAddress,
    );

    // 3. Remove liquidity (or use wallet balances if drained)
    const removed = await _removeLiquidityStep(signer, ethersLib, provider, {
      positionManagerAddress,
      position,
      signerAddress,
    });
    if (removed.txHash) txHashes.push(removed.txHash);

    // 4. Compute new range — custom width if specified, else preserve existing tick spread
    const newRange = _computeRange(poolState, position, customRangeWidthPct);
    if (customRangeWidthPct) {
      const ePct = (
        ((newRange.upperPrice - newRange.lowerPrice) / poolState.price) *
        100
      ).toFixed(2);
      // prettier-ignore
      console.log("[rebalance] Step 4: requested=%s%% effective=%s%% ticks=[%d,%d]", customRangeWidthPct, ePct, newRange.lowerTick, newRange.upperTick);
      // prettier-ignore
      if (Math.abs(Number(ePct) - customRangeWidthPct) > 0.01) console.warn("[rebalance] Step 4: tick spacing for fee=%d rounded %s%% → %s%%", position.fee, String(customRangeWidthPct), ePct);
    }

    // 5. Read full wallet balances (includes residuals from prior rebalances)
    const t0c = new ethersLib.Contract(position.token0, ERC20_ABI, provider);
    const t1c = new ethersLib.Contract(position.token1, ERC20_ABI, provider);
    const [walBal0, walBal1] = await Promise.all([
      t0c.balanceOf(signerAddress),
      t1c.balanceOf(signerAddress),
    ]);
    console.log(
      "[rebalance] Step 5: walletBal0=%s walletBal1=%s",
      String(walBal0),
      String(walBal1),
    );

    // 6. Determine desired amounts from FULL wallet balance and swap if needed
    // prettier-ignore
    const desired = computeDesiredAmounts({ amount0: walBal0, amount1: walBal1 }, { currentPrice: poolState.price, currentTick: poolState.tick, lowerTick: newRange.lowerTick, upperTick: newRange.upperTick }, { decimals0: poolState.decimals0, decimals1: poolState.decimals1 });
    if (desired.needsSwap)
      logSwapNeeded(desired, position, poolState, opts.symbol0, opts.symbol1);
    console.log("[rebalance] Step 6: swap…");
    // prettier-ignore
    const swapped = await _swapAndAdjust(signer, ethersLib, { desired, position, poolState, swapRouterAddress, slippagePct, signerAddress, symbol0: opts.symbol0, symbol1: opts.symbol1 });
    if (swapped.txHash) txHashes.push(swapped.txHash);
    console.log(
      "[rebalance] Step 6 done: extra0=%s extra1=%s",
      String(swapped.extra0),
      String(swapped.extra1),
    );

    // 6b. Re-read pool tick after swap — price impact may have moved it
    //     outside the range computed in step 4.  Shift if needed.
    await _adjustRangeAfterSwap(
      provider,
      ethersLib,
      position,
      factoryAddress,
      poolState,
      newRange,
    );

    // 6c. Final tick check before mint — if price STILL moved outside the
    //     adjusted range, the market is too volatile to mint safely.
    // prettier-ignore
    const preMintState = await getPoolState(provider, ethersLib, { factoryAddress, token0: position.token0, token1: position.token1, fee: position.fee });
    if (
      preMintState.tick < newRange.lowerTick ||
      preMintState.tick >= newRange.upperTick
    ) {
      // prettier-ignore
      console.warn("[rebalance] Step 6c: tick %d still outside [%d, %d] after adjustment — price too volatile", preMintState.tick, newRange.lowerTick, newRange.upperTick);
      return {
        success: false,
        priceVolatile: true,
        error: "Price moved during rebalance — backing off",
      };
    }

    // 7. Mint new position with FULL wallet balance (collected + residuals + swapped)
    const [mintBal0, mintBal1] = await Promise.all([
      t0c.balanceOf(signerAddress),
      t1c.balanceOf(signerAddress),
    ]);
    console.log(
      "[rebalance] Step 7: mintBal0=%s mintBal1=%s",
      String(mintBal0),
      String(mintBal1),
    );
    // prettier-ignore
    const mintResult = await mintPosition(signer, ethersLib, { positionManagerAddress, token0: position.token0, token1: position.token1, fee: position.fee, tickLower: newRange.lowerTick, tickUpper: newRange.upperTick, amount0Desired: mintBal0, amount1Desired: mintBal1, recipient: signerAddress });
    txHashes.push(mintResult.txHash);
    return _buildRebalanceResult(
      txHashes,
      removed,
      swapped,
      mintResult,
      position,
      newRange,
      poolState,
      customRangeWidthPct,
    );
  } catch (err) {
    return {
      success: false,
      error: err.message || String(err),
      cancelled: !!err.cancelled,
      cancelTxHash: err.cancelTxHash || null,
      cancelGasCostWei: err.cancelGasCostWei || 0n,
    };
  }
}

/**
 * Enrich a rebalance result with USD values using current token prices.
 * Uses `result.decimals0/decimals1` from the pool state (not hardcoded 18).
 * @param {object}   result   Rebalance result from executeRebalance().
 * @param {Function} priceFn  Async fn(token0, token1) → {price0, price1}.
 * @param {string}   token0   Token0 address.
 * @param {string}   token1   Token1 address.
 */
async function enrichResultUsd(result, priceFn, token0, token1) {
  const { price0, price1 } = await priceFn(token0, token1);
  const d0 = result.decimals0 ?? 18,
    d1 = result.decimals1 ?? 18;
  const toFloat = (amt, dec) => Number(amt) / 10 ** dec;
  result.token0UsdPrice = price0;
  result.token1UsdPrice = price1;
  result.exitValueUsd =
    toFloat(result.amount0Collected, d0) * price0 +
    toFloat(result.amount1Collected, d1) * price1;
  result.entryValueUsd =
    toFloat(result.amount0Minted, d0) * price0 +
    toFloat(result.amount1Minted, d1) * price1;
}

// ── Module exports ───────────────────────────────────────────────────────────
// Re-export ALL previously exported symbols so no external callers break.

module.exports = {
  enrichResultUsd,
  executeRebalance,
  getPoolState,
  removeLiquidity,
  computeDesiredAmounts,
  swapIfNeeded,
  mintPosition,
  _MAX_UINT128,
  _DEADLINE_SECONDS,
  _MIN_SWAP_THRESHOLD,
  V3_FEE_TIERS,
};
