/**
 * @file rebalancer-router.js
 * @description V3 SwapRouter swap path for the rebalancer — fallback
 *   used when the aggregator (rebalancer-aggregator.js) fails, and the
 *   only path on a chain with no aggregator.
 *   Single-pool swap via the V3 SwapRouter contract; staticCall is used
 *   to quote price impact before sending the TX.
 */

"use strict";

const { log } = require("./log");
const config = require("./config");
const sendTx = require("./send-transaction");
const {
  ERC20_ABI,
  SWAP_ROUTER_ABI,
  _deadline,
  _ensureAllowance,
} = require("./rebalancer-pools");
const { _checkSwapImpact } = require("./rebalancer-swap-impact");
const { receiptGasWei } = require("./receipt-gas");
const { addSpentGas } = require("./spent-gas");

/**
 * Display label for the V3 router route: the active chain's
 * `contracts.swapRouter.name` in chains.json. Stamped onto
 * `result.swapSources` on every swap through the router, which the
 * Rebalance Events table shows, and named by the "Route:" badge on a
 * chain with no aggregator.
 */
const V3_ROUTER_LABEL = config.SWAP_ROUTER_NAME;

/**
 * Swap via V3 SwapRouter (fallback path — single pool).
 * This is the original swap logic, preserved as a fallback.
 *
 * @param {object} signer
 * @param {object} ethersLib
 * @param {object} params  See swapIfNeeded in rebalancer-swap.js for fields.
 * @param {function} balanceDiff  Balance-diff wrapper (injected to avoid
 *   a circular dep with rebalancer-swap.js).
 */
async function swapViaRouter(signer, ethersLib, params, balanceDiff) {
  const { swapRouterAddress, tokenIn, amountIn, approvalMultiple } = params;
  const { Contract } = ethersLib;
  const signerAddr = await signer.getAddress();
  const approvalGas = await _ensureAllowance(
    new Contract(tokenIn, ERC20_ABI, signer),
    signerAddr,
    swapRouterAddress,
    amountIn,
    approvalMultiple,
  );
  /*-
   *  The approval, when one was needed, has confirmed and been paid for,
   *  so the swap's result carries its gas, and so does every way this
   *  swap can fail from here: a refused quote, no liquidity, too much
   *  price impact, the swap itself failing, or the balance read after it
   *  (src/spent-gas.js). It is added here and only here: that last error
   *  already carries the swap's own gas, and an approval counted inside
   *  the swap as well was counted twice.
   */
  try {
    return addSpentGas(
      await _quoteAndSwap(signer, ethersLib, params, balanceDiff),
      approvalGas,
    );
  } catch (err) {
    throw addSpentGas(err, approvalGas);
  }
}

/**
 * Quote the router swap, hold it to the slippage setting, and send it.
 *
 * @param {object} signer
 * @param {object} ethersLib
 * @param {object} params  `swapViaRouter`'s parameters.
 * @param {Function} balanceDiff  Balance-diff wrapper.
 * @returns {Promise<{txHash: string, gasCostWei: bigint,
 *   swapSources: string, amountOut: bigint,
 *   exchange: {sent: bigint, received: bigint}|null}>}  `gasCostWei` is
 *   the swap's own; `swapViaRouter` adds the approval's. `exchange` is the
 *   swap's own, read from its receipt (src/rebalancer-swap-balance.js).
 */
async function _quoteAndSwap(signer, ethersLib, params, balanceDiff) {
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
    _attempts,
    _attemptLabel,
    logCtx,
  } = params;
  const { Contract } = ethersLib;
  const router = new Contract(swapRouterAddress, SWAP_ROUTER_ABI, signer);
  const swapParams = {
    tokenIn,
    tokenOut,
    fee,
    recipient,
    deadline: _deadline(),
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
  const spotRate = isToken0To1 ? currentPrice : 1 / currentPrice;
  const spotExpected =
    (Number(amountIn) / 10 ** decimalsIn) * spotRate * 10 ** decimalsOut;
  const impactPct =
    spotExpected > 0
      ? Math.max(0, ((spotExpected - Number(quotedOut)) / spotExpected) * 100)
      : 0;
  log.info(
    "[rebalance] %s: swap (V3 router): quote=%s spot=%s impact=%s%% slip=%s%%",
    logCtx,
    String(quotedOut),
    spotExpected.toFixed(0),
    impactPct.toFixed(2),
    slippagePct,
  );
  _checkSwapImpact(impactPct, slippagePct, _attempts, _attemptLabel);
  const slipBps = Math.round(slippagePct * 100);
  swapParams.amountOutMinimum = (quotedOut * BigInt(10000 - slipBps)) / 10000n;
  const provider = signer.provider;
  return balanceDiff(
    ethersLib,
    tokenOut,
    recipient,
    provider,
    async () => {
      const { receipt } = await sendTx.sendTransaction({
        populate: () => router.exactInputSingle.populateTransaction(swapParams),
        signer,
        label: "[rebalance] swap (V3 router)",
      });
      log.info(
        "[rebalance] %s: swap (V3 router): confirmed gasUsed=%s",
        logCtx,
        String(receipt.gasUsed),
      );
      log.info(
        "[route-trace] V3-router fallback swapSources=%s",
        V3_ROUTER_LABEL,
      );
      return {
        txHash: receipt.hash,
        gasCostWei: receiptGasWei(receipt),
        swapSources: V3_ROUTER_LABEL,
        receipt,
      };
    },
    tokenIn,
  );
}

module.exports = {
  V3_ROUTER_LABEL,
  swapViaRouter,
};
