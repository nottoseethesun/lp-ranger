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
 * Skip a swap when estimated gas cost exceeds this fraction of the
 * total value being swapped.  Single source of truth — exported so
 * tests and operators can grep for it without diving into function
 * bodies.
 *
 * 0.01 = 1%.  Tuned conservatively: a swap that costs more than 1%
 * of its value in gas is almost always net-negative once slippage
 * and price impact are stacked on top.
 */
const MAX_SWAP_GAS_RATIO = 0.01;

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
 * @param {{swapUsd: number, gasUsd: number}} args
 * @returns {Promise<{
 *   skip: boolean,
 *   reason: 'dust'|'gas-unfavorable'|null,
 *   thresholdUsd: number,
 *   gasRatio: number,
 * }>}
 */
async function shouldSkipSwap({ swapUsd, gasUsd }) {
  const { thresholdUsd } = await getDustThresholdUsd();
  if (await isDust(swapUsd)) {
    return { skip: true, reason: "dust", thresholdUsd, gasRatio: 0 };
  }
  const ratio = swapUsd > 0 ? gasUsd / swapUsd : Infinity;
  if (gasUsd > 0 && ratio > MAX_SWAP_GAS_RATIO) {
    return {
      skip: true,
      reason: "gas-unfavorable",
      thresholdUsd,
      gasRatio: ratio,
    };
  }
  return { skip: false, reason: null, thresholdUsd, gasRatio: ratio };
}

module.exports = {
  MAX_SWAP_GAS_RATIO,
  estimateSwapGasUsd,
  shouldSkipSwap,
  _DEFAULT_SWAP_GAS_UNITS,
};
