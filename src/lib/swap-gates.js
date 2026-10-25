/**
 * @file src/lib/swap-gates.js
 * @module swap-gates
 * @description
 * Two pre-swap gates shared by every swap call site (initial Rebalance,
 * corrective Rebalance, Compound).  Both gates exist to avoid swaps
 * whose value is too small to be worth executing:
 *
 *   1. Dust gate — USD value of the swap is below the gold-pegged dust
 *      threshold (`src/lib/dust.js`).
 *   2. Gas gate — estimated swap gas cost exceeds the operator's
 *      `gasFeePct` share of the swap value.  Built primarily for
 *      future high-gas chains (Ethereum, Arbitrum at peak load); on
 *      PulseChain the gate almost never trips because gas is cheap.
 *
 * `shouldSkipSwap` evaluates **dust first**.  Rationale: a dust-gate
 * failure is cheaper and more reliable to detect than a gas-gate
 * failure.  The dust check uses a cached USD/unit reference price and
 * a single comparison; the gas check requires a fresh
 * `provider.getFeeData()` round-trip plus a native-token USD lookup.
 * Running dust first lets us short-circuit before paying for the
 * gas-gate inputs on every dust-rejected swap.
 */

"use strict";

const { isDust, getDustThresholdUsd } = require("./dust");
const config = require("./config");
const { fetchTokenPriceUsd } = require("./price-fetcher");
const { readBotConfigDefaults } = require("./bot-config-defaults");
const { SETTING_BOUNDS } = require("./setting-bounds");

/*-
 *  Single-source: the default for `gasFeePct` lives in
 *  bot-config-defaults.json, which an operator's copy under
 *  app-config/user-configurable/ overrides, and its range in
 *  setting-bounds.json.  Both are read once at module init.  Per
 *  feedback_one_literal_per_shipped_default, no numeric default or
 *  bound is written as a literal in this file.
 */
const _BOT_DEFAULTS = readBotConfigDefaults();

const GAS_FEE_PCT_DEFAULT = _BOT_DEFAULTS.gasFeePct;

/**
 * The range of the operator-tunable `gasFeePct` Bot Setting, from
 * setting-bounds.json: the same figures `src/lib/config-bounds.js` refuses a
 * saved value against and `src/lib/bot-config-defaults.js` holds the shipped
 * file to.
 */
const GAS_FEE_PCT_MIN = SETTING_BOUNDS.gasFeePct.min;
const GAS_FEE_PCT_MAX = SETTING_BOUNDS.gasFeePct.max;

/**
 * Convert the operator's `gasFeePct` (a percent) into the ratio used
 * by `shouldSkipSwap`'s gas gate.  Every swap call site asks this for
 * its limit, passing the global `gasFeePct` Bot Setting: the default,
 * 1% as shipped, is conservative, since a swap that costs more than
 * that share of its value in gas is almost always net-negative once
 * slippage and price impact are stacked on top.  Clamps to
 * `[GAS_FEE_PCT_MIN, GAS_FEE_PCT_MAX]` so a corrupt config or wild
 * manual edit can't disable the gate or block all swaps.  Falls back
 * to the default when the input isn't a positive number.
 *
 * @param {number|string|undefined} pct
 * @returns {number}  The percent, held inside its range, divided by 100.
 */
function gasFeePctToRatio(pct) {
  const n = typeof pct === "string" ? parseFloat(pct) : pct;
  const v =
    typeof n === "number" && Number.isFinite(n) && n > 0
      ? n
      : GAS_FEE_PCT_DEFAULT;
  const clamped = Math.min(GAS_FEE_PCT_MAX, Math.max(GAS_FEE_PCT_MIN, v));
  return clamped / 100;
}

/**
 * "High estimate" of gas units consumed by a typical aggregator swap.
 * Mirrors the buffered `quote.gas` figure the aggregator reports for
 * a first swap attempt — used to pre-compute the gas-gate ratio
 * before we commit to a quote.  Per-chain value (lives under the
 * chain's `aggregator.estimatedSwapGasUnits` key in chains.json) so
 * different chains can tune; `src/lib/config.js` refuses to start without
 * it.
 */
function _swapGasUnits() {
  return BigInt(config.CHAIN.aggregator.estimatedSwapGasUnits);
}

/**
 * Estimate the USD cost of one swap on the current chain.
 *
 * Priced as `bot-pnl-updater.estimateGasCostUsd` prices a whole
 * rebalance, but at a swap's gas: the chain's
 * `aggregator.estimatedSwapGasUnits` rather than its
 * `estimatedRebalanceGasUnits`, both in chains.json.  Returns 0 on any
 * failure so the gas-gate degrades into a no-op rather than blocking
 * swaps when fee-data or price lookups are flaky.
 *
 * @param {import('ethers').JsonRpcProvider|object} provider
 * @returns {Promise<number>}
 */
async function estimateSwapGasUsd(provider) {
  try {
    const f = await provider.getFeeData();
    const wei = (f.gasPrice ?? 0n) * _swapGasUnits();
    const native = await fetchTokenPriceUsd(config.CHAIN?.nativeWrappedToken);
    return (Number(wei) / 1e18) * native;
  } catch {
    return 0;
  }
}

/**
 * Decide whether to skip a swap given its USD value and estimated gas.
 *
 * Order is intentional: **dust first**, then gas.  See file-header
 * rationale.  Either gate's miss returns `{skip:true}` with the
 * triggering reason; passes return `{skip:false}` with the computed
 * `gasRatio` so callers can log it.
 *
 * `maxRatio` is the gas-gate ceiling, which the caller takes from
 * `gasFeePctToRatio`: the operator's `gasFeePct` Bot Setting as a
 * ratio, always above zero.
 *
 * @param {{swapUsd: number, gasUsd: number, maxRatio: number}} args
 * @returns {Promise<{
 *   skip: boolean,
 *   reason: 'dust'|'gas-unfavorable'|null,
 *   thresholdUsd: number,
 *   gasRatio: number,
 *   maxRatio: number,
 * }>}
 */
async function shouldSkipSwap({ swapUsd, gasUsd, maxRatio }) {
  const { thresholdUsd } = await getDustThresholdUsd();
  if (await isDust(swapUsd)) {
    return {
      skip: true,
      reason: "dust",
      thresholdUsd,
      gasRatio: 0,
      maxRatio,
    };
  }
  // A swap worth nothing is dust, which returned above, so swapUsd is positive.
  const ratio = gasUsd / swapUsd;
  if (gasUsd > 0 && ratio > maxRatio) {
    return {
      skip: true,
      reason: "gas-unfavorable",
      thresholdUsd,
      gasRatio: ratio,
      maxRatio,
    };
  }
  return {
    skip: false,
    reason: null,
    thresholdUsd,
    gasRatio: ratio,
    maxRatio,
  };
}

module.exports = {
  GAS_FEE_PCT_MIN,
  GAS_FEE_PCT_MAX,
  GAS_FEE_PCT_DEFAULT,
  gasFeePctToRatio,
  estimateSwapGasUsd,
  shouldSkipSwap,
};
