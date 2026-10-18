/**
 * @file rebalancer-swap.js
 * @description Swap logic and amount computation for the 9mm v3
 * Position Manager rebalancer.
 */

"use strict";

const { log } = require("./log");
const {
  maxLiquidityForAmounts,
  TickMath,
  SqrtPriceMath,
} = require("@uniswap/v3-sdk");
const JSBI = require("jsbi");
const { _MIN_SWAP_THRESHOLD } = require("./rebalancer-pools");
const { _bestAttemptError } = require("./rebalancer-swap-impact");
const { readBotConfigDefaults } = require("./bot-config-defaults");
const {
  swapViaAggregator,
  AGGREGATOR_LABEL,
  aggregatorBaseUrl,
} = require("./rebalancer-aggregator");
const { swapViaRouter, V3_ROUTER_LABEL } = require("./rebalancer-router");
const { spentGasOf, addSpentGas } = require("./spent-gas");
const { balanceDiff } = require("./rebalancer-swap-balance");

/*-
 *  How many equal parts a swap the aggregator refused for its price
 *  impact is tried again in: bot-config-defaults.json → swapChunkCount.
 */
const _CHUNKS = readBotConfigDefaults().swapChunkCount;

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
  log.info(
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
  log.info(
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
  log.info(
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
 * Whether a failed swap may already have moved this balance, so that no
 * fallback route may swap it again: its transaction may still mine
 * (`nonceUnsettled`), or it mined and only reading what it delivered
 * failed (`swapLanded`).
 * @param {*} err  The failed route's error.
 * @returns {boolean}
 */
function _noFallback(err) {
  return err?.nonceUnsettled === true || err?.swapLanded === true;
}

/** Swap via aggregator — delegates to rebalancer-aggregator.js. */
async function _swapViaAggregator(signer, ethersLib, params) {
  return swapViaAggregator(signer, ethersLib, params, balanceDiff);
}

/** Swap via V3 SwapRouter — delegates to rebalancer-router.js. */
async function _swapViaRouter(signer, ethersLib, params) {
  return swapViaRouter(signer, ethersLib, params, balanceDiff);
}

/**
 * Execute a swap in N equal chunks to reduce per-swap impact.
 * Each chunk runs sequentially (prior chunks move the price).
 */
async function _swapInChunks(swapFn, signer, ethersLib, params, n) {
  const total = params.amountIn;
  const chunk = total / BigInt(n);
  const remainder = total - chunk * BigInt(n);
  /*-
   *  Refuse a split whose chunks would fall below the swap threshold,
   *  before any is sent: each would be a swap too small to be worth
   *  making, and the outer catch then falls through to the V3 router
   *  with the whole amount instead. The last chunk takes the remainder,
   *  so none is smaller than `chunk`.
   */
  if (chunk < _MIN_SWAP_THRESHOLD)
    throw new Error(
      `Cannot chunk: amountIn=${total} split into ${n} would yield ` +
        `chunks below MIN_SWAP_THRESHOLD=${_MIN_SWAP_THRESHOLD}`,
    );
  let amountOut = 0n,
    gasCostWei = 0n,
    txHash = null;
  /*- Preserve swapSources across chunks so the rebalance log displays
   *  "NineMM_V3+DEX_X" rather than "(no swap)" after a chunked retry. */
  const sources = [];
  /*-
   *  What has been swapped so far.  One construction for both exits,
   *  because a partial and a completed run are the same shape: a partial
   *  IS what has been swapped so far.  Two literals would mean the next
   *  field added to the result reaches only one of them.  Either way at
   *  least one chunk has swapped, and each names its route.
   */
  const swapped = () => ({
    amountOut,
    txHash,
    gasCostWei,
    swapSources: sources.join("+"),
  });
  for (let i = 0; i < n; i++) {
    const amt = i === n - 1 ? chunk + remainder : chunk;
    log.info(
      "[rebalance] %s: swap chunk %d/%d: %s",
      params.logCtx,
      i + 1,
      n,
      String(amt),
    );
    let r;
    try {
      r = await swapFn(signer, ethersLib, {
        ...params,
        amountIn: amt,
        _attemptLabel: `${AGGREGATOR_LABEL} (chunk ${i + 1}/${n})`,
      });
    } catch (chunkErr) {
      /*-
       *  The failed chunk's own gas (an approval, a reverted swap, a
       *  cancel) joins the earlier chunks', and the error carries the
       *  total, since every one of those transactions was paid for.
       *
       *  Carry out what the earlier chunks already moved. `params.amountIn`
       *  is the whole amount and is never decremented — each chunk builds
       *  its own `amountIn` locally — so a caller that falls back after a
       *  mid-sequence failure would swap the full amount on top of the part
       *  already swapped. `amountOut > 0n` is the test because it means
       *  balance actually moved: when the first chunk is the one that
       *  failed, nothing has, and the full amount is genuinely unswapped.
       */
      gasCostWei += spentGasOf(chunkErr);
      chunkErr.gasCostWei = gasCostWei;
      if (amountOut > 0n) chunkErr.partialSwap = swapped();
      throw chunkErr;
    }
    amountOut += r.amountOut;
    gasCostWei += r.gasCostWei;
    // Every chunk that returns was mined, so it carries its receipt's hash.
    txHash = r.txHash;
    sources.push(r.swapSources);
  }
  return swapped();
}

/**
 * Swap tokens if needed for rebalancing.
 *
 * Fallback chain:
 *   1. Aggregator at full amount.
 *   2. If (and only if) the aggregator slippage-aborted, retry as
 *      `swapChunkCount` smaller chunks via the aggregator.  Chunking is
 *      fundamentally an impact-reduction tool — smaller amounts move the
 *      multi-hop route less, so chunking can plausibly clear the slippage
 *      gate that the full-size attempt failed.  Other aggregator failures
 *      (TX revert, timeout, no-liquidity, HTTP error) are NOT retried in
 *      chunks: a broken route at full size is broken in parts too, and
 *      chunking would just burn a nonce per part before falling through.
 *   3. V3 SwapRouter against the position's own pool.
 *
 * Step 3 is skipped in two cases, both because taking it would swap the same
 * balance twice. If a chunk fails after an earlier one already moved
 * balance, the partial is returned instead: `params.amountIn` is never
 * decremented, so the router would be handed the full original amount on top
 * of what was already swapped. And an aggregator error carrying
 * `nonceUnsettled` means its swap is neither confirmed nor cancelled and may
 * still mine, and one carrying `swapLanded` means its swap mined though what
 * it delivered could not be read, so each propagates rather than being
 * treated as "no swap happened". A partial or abandoned swap leaves the mint to proceed on the
 * balances it finds, which is what a tripped swap-gate already does, and the
 * corrective and residual-cleanup paths recover the remainder.
 *
 * One consequence worth knowing rather than mistaking for a hole: the
 * "raise slippage to N" message `_bestAttemptError` synthesises fires only
 * on the router's own failure, so returning a partial skips it for that
 * cycle. A genuinely too-tight slippage still surfaces — the cleanup
 * rebalance retries the remainder at full size, aborts on impact, and
 * reaches the router and the message then. Surfacing it sooner would mean
 * re-swapping the balance or inventing a second guidance path.
 *
 * A route given up on may already have paid gas: an approval, a reverted
 * swap, a cancel. Its error carries that as `gasCostWei`, and the figure
 * is added to whatever the swap ends with, the next route's result or the
 * final error, so a fallback that succeeds still reports every
 * transaction the wallet paid for (see `src/spent-gas.js`).
 *
 * @param {object} signer      ethers Signer.
 * @param {object} ethersLib   ethers library.
 * @param {object} params      Swap parameters.
 * @returns {Promise<{amountOut: bigint, txHash: string|null, gasCostWei: bigint}>}
 */
async function swapIfNeeded(signer, ethersLib, params) {
  if (params.amountIn < _MIN_SWAP_THRESHOLD)
    return { amountOut: 0n, txHash: null, gasCostWei: 0n };
  /*- Shared attempts log threaded through every swap path so the final
   *  error can point at the LOWEST observed price impact across the
   *  whole chain (aggregator full → chunks → V3 router fallback) instead
   *  of just the last attempt's number — which on a low-liquidity
   *  fallback pool can be misleadingly large. */
  const attempts = [];
  const wrapped = { ...params, _attempts: attempts };
  try {
    return await _swapViaAggregator(signer, ethersLib, {
      ...wrapped,
      _attemptLabel: `${AGGREGATOR_LABEL} (full)`,
    });
  } catch (err) {
    /*-
     *  An unsettled nonce means the aggregator's swap is neither confirmed
     *  nor cancelled and may still mine, and a landed swap has happened.
     *  Every fallback below sends a second swap of the same balance, so
     *  either error propagates untouched and the rebalance fails instead.
     */
    if (_noFallback(err)) throw err;
    // Gas the routes given up on had paid, for whatever ends the swap.
    let spentWei = spentGasOf(err);
    if (err?.isSwapImpactAbort) {
      log.warn(
        "[rebalance] %s: aggregator slippage abort at full amount" +
          " — retrying in %d chunks via aggregator (lower per-swap impact)",
        params.logCtx,
        _CHUNKS,
      );
      try {
        return addSpentGas(
          await _swapInChunks(
            _swapViaAggregator,
            signer,
            ethersLib,
            wrapped,
            _CHUNKS,
          ),
          spentWei,
        );
      } catch (chunkErr) {
        if (_noFallback(chunkErr)) throw addSpentGas(chunkErr, spentWei);
        /*- Earlier chunks already moved part of the balance, and the router
         *  fallback below is handed the FULL original amount, so taking it
         *  would swap that part a second time.  Report what was swapped
         *  instead: the caller mints with the balances it finds, which is
         *  what a gate-skipped swap already does, and the corrective and
         *  residual-cleanup paths pick up the rest. */
        if (chunkErr.partialSwap) {
          log.warn(
            "[rebalance] %s: aggregator chunks stopped after a partial swap" +
              " (out=%s): %s — keeping the partial rather than re-swapping" +
              " it through the V3 router",
            params.logCtx,
            String(chunkErr.partialSwap.amountOut),
            chunkErr.message,
          );
          return addSpentGas(chunkErr.partialSwap, spentWei);
        }
        spentWei += spentGasOf(chunkErr);
        log.warn(
          "[rebalance] %s: aggregator chunks also failed: %s" +
            " — falling back to V3 router",
          params.logCtx,
          chunkErr.message,
        );
      }
    } else {
      log.warn(
        "[rebalance] %s: aggregator failed (non-impact): %s" +
          " — falling back to V3 router (chunking would not help)",
        params.logCtx,
        err.message,
      );
    }
    try {
      return addSpentGas(
        await _swapViaRouter(signer, ethersLib, {
          ...wrapped,
          _attemptLabel: V3_ROUTER_LABEL,
        }),
        spentWei,
      );
    } catch (routerErr) {
      /*-
       *  Only synthesize when the FINAL error is itself a slippage
       *  abort.  If the chain failed for a non-slippage reason
       *  (RPC timeout, no pool liquidity, revert), surfacing a
       *  "raise slippage" message would mislead the user about the
       *  actual cause.  Also requires >1 attempt so we don't just
       *  re-wrap a single throw with the same impact number.  The
       *  synthesised error stands in for the router's, so it carries
       *  the router's gas as well.
       */
      if (routerErr.isSwapImpactAbort && attempts.length > 1) {
        const synth = _bestAttemptError(attempts, params.slippagePct);
        if (synth) throw addSpentGas(synth, spentWei + spentGasOf(routerErr));
      }
      throw addSpentGas(routerErr, spentWei);
    }
  }
}

/**
 * Label of the route a swap tries first on the active chain: the
 * aggregator's when the chain names one, the V3 router's when it does
 * not. Published on `GET /api/status` as `swapRouteLabel`, so the
 * dashboard's "Routing through:" badge is right on every chain instead
 * of assuming an aggregator exists. Whether the chain has an aggregator
 * is `aggregatorBaseUrl`'s answer, the same one the swap acts on.
 *
 * @returns {string}
 */
function primaryRouteLabel() {
  return aggregatorBaseUrl().length > 0 ? AGGREGATOR_LABEL : V3_ROUTER_LABEL;
}

// ── Module exports ───────────────────────────────────────────────────────────

module.exports = {
  computeDesiredAmounts,
  swapIfNeeded,
  primaryRouteLabel,
};
