/**
 * @file src/lib/compounder-swap.js
 * @module compounder-swap
 * @description
 * Optional ratio-correcting swap that runs between `collect` and
 * `increaseLiquidity` in the compound flow.  Without it, the Position
 * Manager only accepts the side of the collected fees that fits the
 * current tick ratio — the rest stays in the wallet as residual.
 *
 * The swap fires only when:
 *   1. The pool/range info needed by the SDK ratio math is plumbed in
 *      (caller passes `poolState`, `tickLower`, `tickUpper`).
 *   2. `computeDesiredAmounts` says a swap is needed.
 *   3. Both swap-gates pass (dust first, gas second — see
 *      `src/lib/swap-gates.js`).
 *
 * Extracted from `compounder.js` to keep that file under the 500 line
 * cap and to isolate the swap logic for unit testing.
 */

"use strict";

const { log } = require("./log");
const config = require("./config");
const { logCtx } = require("./logger");
const { computeDesiredAmounts, swapIfNeeded } = require("./rebalancer-swap");
const { fetchTokenPriceUsd } = require("./price-fetcher");
const { resolveSlippagePct } = require("./slippage-resolver");
const {
  estimateSwapGasUsd,
  shouldSkipSwap,
  gasFeePctToRatio,
} = require("./swap-gates");

/**
 * The compound's log context: the six fields every compound, rebalance
 * and swap line carries, from the compound's own options. `compounder.js`
 * uses it too, so the compound's lines and its swap's lines name the
 * position the same way.
 *
 * @param {object} opts  Compound options: `recipient` (the wallet),
 *   `positionManagerAddress`, `tokenId` and the two token symbols.
 * @returns {string}
 */
function compoundLogCtx(opts) {
  return logCtx({
    chain: config.CHAIN_NAME,
    wallet: opts.recipient,
    factory: opts.positionManagerAddress,
    tokenId: opts.tokenId,
    symbol0: opts.token0Symbol,
    symbol1: opts.token1Symbol,
  });
}

const _NOOP = Object.freeze({
  gasCostWei: 0n,
  txHash: null,
  gateReason: null,
  swapped: false,
});

/** Confirm caller plumbed in the pool state + range needed for ratio math. */
function _hasRatioInputs(opts) {
  return (
    !!opts.poolState &&
    typeof opts.tickLower === "number" &&
    typeof opts.tickUpper === "number"
  );
}

/** Run the dust-then-gas gate; return {skip, reason, gasRatio} + USD context. */
async function _evalGates(signer, opts, desired) {
  const ps = opts.poolState;
  const is0to1 = desired.swapDirection === "token0to1";
  const tokenInAddr = is0to1 ? opts.token0 : opts.token1;
  const decIn = is0to1 ? opts.decimals0 : opts.decimals1;
  const priceInUsd = await fetchTokenPriceUsd(tokenInAddr);
  const swapUsd = (Number(desired.swapAmount) / 10 ** decIn) * priceInUsd;
  const provider = signer.provider;
  const gasUsd = await estimateSwapGasUsd(provider);
  const maxRatio = gasFeePctToRatio(opts.gasFeePct);
  const gate = await shouldSkipSwap({ swapUsd, gasUsd, maxRatio });
  log.info(
    "[compound] %s ratio-swap gate: swap=$%s gas=$%s ratio=%s max=%s%% — %s",
    compoundLogCtx(opts),
    swapUsd.toFixed(4),
    gasUsd.toFixed(4),
    gate.gasRatio.toFixed(4),
    (gate.maxRatio * 100).toFixed(2),
    gate.skip ? `SKIP (${gate.reason})` : "PROCEED",
  );
  return { gate, is0to1, ps };
}

/** Fire the swap once gates pass.  Returns the swap result. */
async function _fireSwap(signer, ethersLib, opts, desired, is0to1, ps) {
  return swapIfNeeded(signer, ethersLib, {
    swapRouterAddress: opts.swapRouterAddress,
    fee: opts.fee,
    amountIn: desired.swapAmount,
    tokenIn: is0to1 ? opts.token0 : opts.token1,
    tokenOut: is0to1 ? opts.token1 : opts.token0,
    /*-
     *  The same answer a rebalance would get for this swap: the
     *  destination token's own setting, or the default when it is
     *  unset. A compound and a rebalance move the same pair through
     *  the same router, so they cannot answer this differently.
     */
    slippagePct: resolveSlippagePct(opts, is0to1),
    currentPrice: ps.price,
    decimalsIn: is0to1 ? opts.decimals0 : opts.decimals1,
    decimalsOut: is0to1 ? opts.decimals1 : opts.decimals0,
    isToken0To1: is0to1,
    recipient: opts.recipient,
    symbolIn: is0to1 ? opts.token0Symbol : opts.token1Symbol,
    symbolOut: is0to1 ? opts.token1Symbol : opts.token0Symbol,
    approvalMultiple: opts.approvalMultiple,
    logCtx: compoundLogCtx(opts),
  });
}

/**
 * Optional ratio-correcting swap.  See file-header for semantics.
 *
 * @param {import('ethers').Signer} signer
 * @param {object} ethersLib
 * @param {object} opts  Compound opts (must include token0/1, decimals,
 *   recipient, fee; optionally poolState/tickLower/tickUpper/
 *   swapRouterAddress and the two per-token slippage settings).
 * @param {bigint} amount0  Collected amount0.
 * @param {bigint} amount1  Collected amount1.
 * @returns {Promise<{
 *   gasCostWei: bigint,
 *   txHash: string|null,
 *   gateReason: 'dust'|'gas-unfavorable'|'no-swap-needed'|null,
 *   swapped: boolean,
 *   isToken0To1?: boolean,
 *   exchange?: {sent: bigint, received: bigint}|null,
 * }>}  A swap that ran says which way (`isToken0To1`) and what its own
 *   transactions sent of the token sold and received of the token bought
 *   (`exchange`), so the compound can tell its fees from a deposit that
 *   reached the wallet meanwhile; `exchange` is null when that is unknown.
 */
async function swapForCompound(signer, ethersLib, opts, amount0, amount1) {
  if (!_hasRatioInputs(opts)) {
    log.info(
      "[compound] %s ratio-swap skipped: poolState/tickRange not provided",
      compoundLogCtx(opts),
    );
    return { ..._NOOP };
  }
  const ps = opts.poolState;
  const desired = computeDesiredAmounts(
    { amount0, amount1 },
    {
      currentPrice: ps.price,
      currentTick: ps.tick,
      lowerTick: opts.tickLower,
      upperTick: opts.tickUpper,
    },
    { decimals0: opts.decimals0, decimals1: opts.decimals1 },
  );
  if (!desired.needsSwap) {
    log.info(
      "[compound] %s ratio-swap skipped: collected amounts already match tick ratio",
      compoundLogCtx(opts),
    );
    return { ..._NOOP, gateReason: "no-swap-needed" };
  }
  const { gate, is0to1 } = await _evalGates(signer, opts, desired);
  if (gate.skip) {
    return { ..._NOOP, gateReason: gate.reason };
  }
  const result = await _fireSwap(signer, ethersLib, opts, desired, is0to1, ps);
  return {
    gasCostWei: result.gasCostWei,
    txHash: result.txHash,
    gateReason: null,
    swapped: true,
    isToken0To1: is0to1,
    exchange: result.exchange ?? null,
  };
}

module.exports = { swapForCompound, compoundLogCtx };
