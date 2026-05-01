/**
 * @file src/swap-gates.js
 * @module swap-gates
 * @description
 * Two pre-swap gates shared by every swap call site (initial Rebalance,
 * corrective Rebalance, Compound).  Both gates exist to avoid swaps
 * whose value is too small to be worth executing:
 *
 *   1. Dust gate — USD value of the swap is below the gold-pegged dust
 *      threshold (`src/dust.js`).
 *   2. Gas gate — estimated swap gas cost exceeds
 *      `MAX_SWAP_GAS_RATIO` of the swap value.  Built primarily for
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

/**
 * Default fraction used when no per-call override is supplied.
 * 0.01 = 1%.  Tuned conservatively: a swap that costs more than 1%
 * of its value in gas is almost always net-negative once slippage
 * and price impact are stacked on top.
 *
 * The active value is now operator-tunable via the global
 * `gasFeePct` Bot Setting (percent input, 0.1–15).  Each swap call
 * site reads `_getConfig("gasFeePct")` from the per-position bot
 * state, divides by 100, and passes the resulting ratio to
 * `shouldSkipSwap` as `maxRatio`.  This constant remains the
 * fallback when no value is supplied — keep it in sync with the
 * default in `app-config/static-tunables/bot-config-defaults.json`.
 */
const MAX_SWAP_GAS_RATIO = 0.01;

/**
 * UI bounds for the operator-tunable `gasFeePct` Bot Setting.  Mirror
 * the input `min`/`max` attrs in `public/index.html` so server-side
 * clamping matches what the dashboard exposes.  Below 0.1% would
 * effectively block all swaps on chains with non-trivial gas; above
 * 15% is well past the point where gas eats the trade.
 */
const GAS_FEE_PCT_MIN = 0.1;
const GAS_FEE_PCT_MAX = 15;
const GAS_FEE_PCT_DEFAULT = 1;

/**
 * Convert the operator's `gasFeePct` (a percent) into the ratio used
 * by `shouldSkipSwap`'s gas gate.  Clamps to `[GAS_FEE_PCT_MIN,
 * GAS_FEE_PCT_MAX]` so a corrupt config or wild manual edit can't
 * disable the gate or block all swaps.  Falls back to the default
 * when the input isn't a positive number.
 *
 * @param {number|string|undefined} pct
 * @returns {number}  Ratio in `(0, 0.15]`.
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
 * before we commit to a quote.  Pulled from chain config when
 * available so different chains can tune.
 */
const _DEFAULT_SWAP_GAS_UNITS = 500_000n;

function _swapGasUnits() {
  const fromCfg = config.CHAIN?.aggregator?.estimatedSwapGasUnits;
  if (typeof fromCfg === "number" && fromCfg > 0) return BigInt(fromCfg);
  return _DEFAULT_SWAP_GAS_UNITS;
}

/**
 * Estimate the USD cost of one swap on the current chain.
 *
 * Mirrors `bot-pnl-updater.estimateGasCostUsd` but parameterized for
 * swap-sized gas (default 500k vs 800k for a full rebalance).  Returns
 * 0 on any failure so the gas-gate degrades into a no-op rather than
 * blocking swaps when fee-data or price lookups are flaky.
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
 * `maxRatio` is the per-call override of the gas-gate ceiling, derived
 * by the caller from the operator's `gasFeePct` Bot Setting (percent ÷
 * 100).  Pass `undefined` to fall back to the conservative
 * `MAX_SWAP_GAS_RATIO` default — used by tests that don't care about
 * the operator override path.
 *
 * @param {{swapUsd: number, gasUsd: number, maxRatio?: number}} args
 * @returns {Promise<{
 *   skip: boolean,
 *   reason: 'dust'|'gas-unfavorable'|null,
 *   thresholdUsd: number,
 *   gasRatio: number,
 *   maxRatio: number,
 * }>}
 */
async function shouldSkipSwap({ swapUsd, gasUsd, maxRatio }) {
  const ceiling =
    typeof maxRatio === "number" && maxRatio > 0
      ? maxRatio
      : MAX_SWAP_GAS_RATIO;
  const { thresholdUsd } = await getDustThresholdUsd();
  if (await isDust(swapUsd)) {
    return {
      skip: true,
      reason: "dust",
      thresholdUsd,
      gasRatio: 0,
      maxRatio: ceiling,
    };
  }
  const ratio = swapUsd > 0 ? gasUsd / swapUsd : Infinity;
  if (gasUsd > 0 && ratio > ceiling) {
    return {
      skip: true,
      reason: "gas-unfavorable",
      thresholdUsd,
      gasRatio: ratio,
      maxRatio: ceiling,
    };
  }
  return {
    skip: false,
    reason: null,
    thresholdUsd,
    gasRatio: ratio,
    maxRatio: ceiling,
  };
}

module.exports = {
  MAX_SWAP_GAS_RATIO,
  GAS_FEE_PCT_MIN,
  GAS_FEE_PCT_MAX,
  GAS_FEE_PCT_DEFAULT,
  gasFeePctToRatio,
  estimateSwapGasUsd,
  shouldSkipSwap,
  _DEFAULT_SWAP_GAS_UNITS,
};
