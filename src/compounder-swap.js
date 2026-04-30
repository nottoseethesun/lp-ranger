/**
 * @file src/compounder-swap.js
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
 *      `src/swap-gates.js`).
 *
 * Extracted from `compounder.js` to keep that file under the 500 line
 * cap and to isolate the swap logic for unit testing.
 */

"use strict";

const { computeDesiredAmounts, swapIfNeeded } = require("./rebalancer-swap");
const { fetchTokenPriceUsd } = require("./price-fetcher");
const { estimateSwapGasUsd, shouldSkipSwap } = require("./swap-gates");

/** Abbreviated address: 0x4e44…61A */
function _abbr(addr) {
  if (!addr || addr.length < 10) return addr || "?";
  return addr.slice(0, 6) + "\u2026" + addr.slice(-3);
}

/** Build a standard log context prefix matching compounder.js. */
function _ctx(opts) {
  const wallet = _abbr(opts.recipient);
  const nft = "#" + opts.tokenId;
  const s0 = opts.token0Symbol || "Token0";
  const s1 = opts.token1Symbol || "Token1";
  return wallet + " " + nft + " " + s0 + "/" + s1;
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
  const provider = signer.provider ?? signer;
  const gasUsd = await estimateSwapGasUsd(provider);
  const gate = await shouldSkipSwap({ swapUsd, gasUsd });
  console.log(
    "[compound] %s ratio-swap gate: swap=$%s gas=$%s ratio=%s — %s",
    _ctx(opts),
    swapUsd.toFixed(4),
    gasUsd.toFixed(4),
    gate.gasRatio.toFixed(4),
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
    slippagePct: opts.slippagePct ?? 0.5,
    currentPrice: ps.price,
    decimalsIn: is0to1 ? opts.decimals0 : opts.decimals1,
    decimalsOut: is0to1 ? opts.decimals1 : opts.decimals0,
    isToken0To1: is0to1,
    recipient: opts.recipient,
    symbolIn: is0to1 ? opts.token0Symbol : opts.token1Symbol,
    symbolOut: is0to1 ? opts.token1Symbol : opts.token0Symbol,
    approvalMultiple: opts.approvalMultiple,
  });
}

/**
 * Optional ratio-correcting swap.  See file-header for semantics.
 *
 * @param {import('ethers').Signer} signer
 * @param {object} ethersLib
 * @param {object} opts  Compound opts (must include token0/1, decimals,
 *   recipient, fee; optionally poolState/tickLower/tickUpper/
 *   swapRouterAddress/slippagePct).
 * @param {bigint} amount0  Collected amount0.
 * @param {bigint} amount1  Collected amount1.
 * @returns {Promise<{
 *   gasCostWei: bigint,
 *   txHash: string|null,
 *   gateReason: 'dust'|'gas-unfavorable'|'no-swap-needed'|null,
 *   swapped: boolean,
 * }>}
 */
async function swapForCompound(signer, ethersLib, opts, amount0, amount1) {
  if (!_hasRatioInputs(opts)) {
    console.log(
      "[compound] %s ratio-swap skipped: poolState/tickRange not provided",
      _ctx(opts),
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
    console.log(
      "[compound] %s ratio-swap skipped: collected amounts already match tick ratio",
      _ctx(opts),
    );
    return { ..._NOOP, gateReason: "no-swap-needed" };
  }
  const { gate, is0to1 } = await _evalGates(signer, opts, desired);
  if (gate.skip) {
    return { ..._NOOP, gateReason: gate.reason };
  }
  const result = await _fireSwap(signer, ethersLib, opts, desired, is0to1, ps);
  return {
    gasCostWei: result.gasCostWei || 0n,
    txHash: result.txHash || null,
    gateReason: null,
    swapped: true,
  };
}

module.exports = { swapForCompound };
