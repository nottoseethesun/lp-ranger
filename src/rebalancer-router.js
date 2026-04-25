/**
 * @file rebalancer-router.js
 * @description V3 SwapRouter swap path for the rebalancer — fallback
 *   used when the 9mm DEX Aggregator (rebalancer-aggregator.js) fails.
 *   Single-pool swap via the V3 SwapRouter contract; staticCall is used
 *   to quote price impact before sending the TX.
 */

"use strict";

const config = require("./config");
const {
  ERC20_ABI,
  SWAP_ROUTER_ABI,
  _checkSwapImpact,
  _deadline,
  _waitOrSpeedUp,
  _ensureAllowance,
} = require("./rebalancer-pools");

/**
 * Display label for the V3 router fallback route.  Stamped onto
 * result.swapSources whenever the aggregator fails and we fall back to
 * the 9mm V3 SwapRouter.  Surfaces to the Rebalance Events table only.
 */
const V3_ROUTER_LABEL = "9mm V3 Router";

/** Compute gas cost from a TX receipt. */
function _gasCost(r) {
  return (r.gasUsed ?? 0n) * (r.gasPrice ?? r.effectiveGasPrice ?? 0n);
}

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
    _attempts,
    _attemptLabel,
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
  _checkSwapImpact(
    impactPct,
    slip,
    _attempts,
    _attemptLabel || V3_ROUTER_LABEL,
  );
  const slipBps = Math.round(slip * 100);
  swapParams.amountOutMinimum = (quotedOut * BigInt(10000 - slipBps)) / 10000n;
  const provider = signer.provider || signer;
  return balanceDiff(ethersLib, tokenOut, recipient, provider, async () => {
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

module.exports = {
  V3_ROUTER_LABEL,
  swapViaRouter,
};
