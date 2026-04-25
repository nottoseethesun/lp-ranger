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
  _swapAndAdjust,
  _verifyOwnership,
  _removeLiquidityStep,
  _adjustRangeAfterSwap,
  _computeRange,
  _buildRebalanceResult,
  _preMintTickCheck,
} = require("./rebalancer-execute");
const { correctivelyRebalanceIfNeeded } = require("./rebalancer-correct");

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
  _retrySend,
  getPoolState,
  removeLiquidity,
  logSwapNeeded,
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
    approvalMultiple,
  },
) {
  const { Contract } = ethersLib;
  const signerAddress = await signer.getAddress();
  const token0Contract = new Contract(token0, ERC20_ABI, signer);
  const token1Contract = new Contract(token1, ERC20_ABI, signer);
  console.log(
    "[rebalance] Step 7a: ensureAllowance — a0=%s a1=%s",
    String(amount0Desired),
    String(amount1Desired),
  );
  // Serialise the two approvals: running them in parallel submits
  // adjacent-nonce TXs to the RPC, which under mempool load can force
  // the second into the `queued` sub-pool before the first reaches
  // `pending`.  On go-ethereum nodes with a saturated per-account
  // queued pool this causes "queued sub-pool is full" rejections and
  // a cascade as `_retrySend` used to re-sign at ever-higher nonces.
  // See docs/claude or MEMORY project_rpc_fallback_on_saturation.
  const appGas0 = await _ensureAllowance(
    token0Contract,
    signerAddress,
    positionManagerAddress,
    amount0Desired,
    approvalMultiple,
  );
  const appGas1 = await _ensureAllowance(
    token1Contract,
    signerAddress,
    positionManagerAddress,
    amount1Desired,
    approvalMultiple,
  );

  const pm = new Contract(positionManagerAddress, PM_ABI, signer);
  const dl = deadline ?? _deadline();
  console.log(
    "[rebalance] Step 7b: mint — fee=%d tL=%d tU=%d a0d=%s a1d=%s",
    fee,
    tickLower,
    tickUpper,
    String(amount0Desired),
    String(amount1Desired),
  );
  const tx = await _retrySend(
    () =>
      pm.mint(
        {
          token0,
          token1,
          fee,
          tickLower,
          tickUpper,
          amount0Desired,
          amount1Desired,
          amount0Min: 0n,
          amount1Min: 0n,
          recipient,
          deadline: dl,
        },
        {
          type: config.TX_TYPE,
          gasLimit:
            config.CHAIN.contracts?.positionManager?.mintGasLimit || 600000,
        },
      ),
    "mint",
    { signer },
  );
  console.log(
    "[rebalance] Step 7b: TX submitted, hash= %s nonce=%d type=%s gasLimit=%s gasPrice=%s",
    tx.hash,
    tx.nonce,
    String(tx.type),
    String(tx.gasLimit),
    String(tx.gasPrice ?? "—"),
  );
  const receipt = await _waitOrSpeedUp(tx, signer, "mint");
  console.log(
    "[rebalance] Step 7c: mint confirmed, block=%s gasUsed=%s",
    receipt.blockNumber,
    String(receipt.gasUsed),
  );

  const { tokenId, liquidity, amount0, amount1 } = _parseMintReceipt(
    receipt,
    amount0Desired,
    amount1Desired,
  );

  console.log(
    "[rebalance] Mint: desired0=%s desired1=%s actual0=%s actual1=%s liq=%s",
    String(amount0Desired),
    String(amount1Desired),
    String(amount0),
    String(amount1),
    String(liquidity),
  );
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

// Internal helpers (_walletBalances, _swapAndAdjust, _verifyOwnership,
// _removeLiquidityStep, _adjustRangeAfterSwap, _computeRange,
// _buildRebalanceResult) are in rebalancer-execute.js.

/*- Run the post-swap corrective rebalance (Step 6d).  The primary swap
 *  (step 6) can move our own pool's tick, shifting R=need0/need1 against
 *  the original target and leaving residuals on the wrong side after
 *  mint.  This fires one small corrective swap when the residual exceeds
 *  the gold-pegged dust threshold (see src/dust.js).  Extracted here so
 *  executeRebalance stays under the complexity cap. */
async function _runCorrectiveSwap(signer, ethersLib, ctx, txHashes) {
  const corrective = await correctivelyRebalanceIfNeeded(
    signer,
    ethersLib,
    ctx,
  );
  if (corrective.txHash) txHashes.push(corrective.txHash);
  return corrective;
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
    offsetToken0Pct,
    approvalMultiple,
  } = opts;
  const offset = offsetToken0Pct ?? 50;
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
    const poolState = await getPoolState(provider, ethersLib, {
      factoryAddress,
      token0: position.token0,
      token1: position.token1,
      fee: position.fee,
    });
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
    const newRange = _computeRange(
      poolState,
      position,
      customRangeWidthPct,
      offset,
    );
    if (offset !== 50) {
      console.log(
        "[rebalance] Step 4: offset=%d%% token0 / %d%% token1, ticks=[%d,%d]",
        offset,
        100 - offset,
        newRange.lowerTick,
        newRange.upperTick,
      );
    }
    if (customRangeWidthPct) {
      const ePct = (
        ((newRange.upperPrice - newRange.lowerPrice) / poolState.price) *
        100
      ).toFixed(2);
      console.log(
        "[rebalance] Step 4: requested=%s%% effective=%s%% ticks=[%d,%d]",
        customRangeWidthPct,
        ePct,
        newRange.lowerTick,
        newRange.upperTick,
      );
      if (Math.abs(Number(ePct) - customRangeWidthPct) > 0.01)
        console.warn(
          "[rebalance] Step 4: tick spacing for fee=%d rounded %s%% → %s%%",
          position.fee,
          String(customRangeWidthPct),
          ePct,
        );
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
    const desired = computeDesiredAmounts(
      { amount0: walBal0, amount1: walBal1 },
      {
        currentPrice: poolState.price,
        currentTick: poolState.tick,
        lowerTick: newRange.lowerTick,
        upperTick: newRange.upperTick,
      },
      { decimals0: poolState.decimals0, decimals1: poolState.decimals1 },
    );
    if (desired.needsSwap)
      logSwapNeeded(desired, position, poolState, opts.symbol0, opts.symbol1);
    console.log("[rebalance] Step 6: swap…");
    const swapped = await _swapAndAdjust(signer, ethersLib, {
      desired,
      position,
      poolState,
      swapRouterAddress,
      slippagePct,
      signerAddress,
      symbol0: opts.symbol0,
      symbol1: opts.symbol1,
      approvalMultiple,
    });
    if (swapped.txHash) txHashes.push(swapped.txHash);
    console.log(
      "[rebalance] Step 6 done: extra0=%s extra1=%s",
      String(swapped.extra0),
      String(swapped.extra1),
    );

    // 6b. Re-read pool tick after swap — price impact may have moved it
    //     outside the range computed in step 4.  Shift if needed.
    //     Skipped when offset ≠ 50 (tick may be intentionally at edge).
    await _adjustRangeAfterSwap(
      provider,
      ethersLib,
      position,
      factoryAddress,
      poolState,
      newRange,
      offset,
    );

    // 6c. Final tick check — skipped when offset ≠ 50 (one-sided OK).
    const volatileResult = await _preMintTickCheck(
      provider,
      ethersLib,
      position,
      factoryAddress,
      newRange,
      offset,
    );
    if (volatileResult) return volatileResult;

    // 6d. Corrective swap — see _runCorrectiveSwap.
    const corrective = await _runCorrectiveSwap(
      signer,
      ethersLib,
      {
        provider,
        signerAddress,
        position,
        factoryAddress,
        newRange,
        swapRouterAddress,
        slippagePct,
        symbol0: opts.symbol0,
        symbol1: opts.symbol1,
        approvalMultiple,
      },
      txHashes,
    );

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
    const mintResult = await mintPosition(signer, ethersLib, {
      positionManagerAddress,
      token0: position.token0,
      token1: position.token1,
      fee: position.fee,
      tickLower: newRange.lowerTick,
      tickUpper: newRange.upperTick,
      amount0Desired: mintBal0,
      amount1Desired: mintBal1,
      recipient: signerAddress,
      approvalMultiple,
    });
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
      corrective,
      {
        chain: config.CHAIN_NAME,
        contract: positionManagerAddress,
        wallet: signerAddress,
      },
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
