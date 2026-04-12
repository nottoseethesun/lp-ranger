/**
 * @file src/gas-monitor.js
 * @module gasMonitor
 * @description
 * Monitors the wallet's native token balance and sends a Telegram alert
 * when it drops below the estimated cost of the next rebalance.
 *
 * Threshold logic:
 *   1. If a rebalance has occurred: 4 × last rebalance gas (native token).
 *   2. Otherwise: estimate from `STANDARD_SEND_TX_COST_FACTOR`, doubled
 *      for safety.
 *
 * The alert fires once per low-balance episode.  It resets when the
 * balance recovers above the threshold so the next dip triggers a new
 * alert.
 */

"use strict";

const { notify } = require("./telegram");

/**
 * Ratio of rebalance gas (~800k) to a standard EVM send (21k gas).
 * Used to estimate rebalance cost on any blockchain from the
 * easily-measurable send transaction cost.  This ratio is consistent
 * across EVM chains because the opcodes are the same.
 */
const STANDARD_SEND_TX_COST_FACTOR = 38;

/** Standard EVM send gas (21,000). */
const SEND_GAS = 21_000n;

/**
 * Check wallet gas balance and alert if low.
 *
 * @param {object} opts
 * @param {object} opts.provider    Ethers provider.
 * @param {string} opts.address     Wallet address.
 * @param {object} opts.pnlTracker  P&L tracker (for last rebalance gas).
 * @param {object} opts.position    Position (for notification label).
 * @param {object} opts.alertState  Mutable object tracking alert state:
 *   `{ alerted: boolean }`.  Persists across poll cycles.
 * @returns {Promise<void>}
 */
async function checkGasBalance(opts) {
  const { provider, address, pnlTracker, position, alertState } = opts;
  if (!provider || !address) return;
  try {
    const balance = await provider.getBalance(address);
    const threshold = await _computeThreshold(provider, pnlTracker);
    if (threshold <= 0n) return;
    if (balance < threshold) {
      if (!alertState.alerted) {
        alertState.alerted = true;
        const balEth = _formatNative(balance);
        const thrEth = _formatNative(threshold);
        console.warn(
          "[gas-monitor] Low gas balance: %s (threshold %s)",
          balEth,
          thrEth,
        );
        notify("lowGasBalance", {
          position: {
            tokenId: position?.tokenId,
            token0Symbol: position?.token0Symbol,
            token1Symbol: position?.token1Symbol,
          },
          message: `Balance: ${balEth} — threshold: ${thrEth}. Top up to avoid missed rebalances.`,
        });
      }
    } else if (alertState.alerted) {
      alertState.alerted = false;
      console.log("[gas-monitor] Gas balance recovered above threshold");
    }
  } catch (err) {
    console.warn("[gas-monitor] Check failed: %s", err.message);
  }
}

/**
 * Compute the low-gas threshold in native token (wei).
 *
 * @param {object} provider     Ethers provider.
 * @param {object} pnlTracker   P&L tracker (may be null).
 * @returns {Promise<bigint>}   Threshold in wei.
 */
async function _computeThreshold(provider, pnlTracker) {
  // Primary: 4× last rebalance gas
  const lastGas = _lastRebalanceGasNative(pnlTracker);
  if (lastGas > 0n) return lastGas * 4n;
  // Fallback: estimate from gas price × send gas × factor × 2 (safety)
  try {
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice ?? 0n;
    if (gasPrice <= 0n) return 0n;
    return gasPrice * SEND_GAS * BigInt(STANDARD_SEND_TX_COST_FACTOR) * 2n;
  } catch {
    return 0n;
  }
}

/**
 * Extract the last rebalance gas cost in native token from the P&L tracker.
 * @param {object} pnlTracker
 * @returns {bigint}  Gas in wei, or 0n if unavailable.
 */
function _lastRebalanceGasNative(pnlTracker) {
  if (!pnlTracker) return 0n;
  const data = pnlTracker.serialize();
  const epochs = data?.closedEpochs;
  if (!epochs || epochs.length === 0) return 0n;
  const last = epochs[epochs.length - 1];
  const native = last.gasNative || 0;
  if (native <= 0) return 0n;
  // gasNative is stored as a float (ethers); convert back to wei
  return BigInt(Math.round(native * 1e18));
}

/** Format a wei BigInt as a human-readable native token string. */
function _formatNative(wei) {
  const f = Number(wei) / 1e18;
  return f < 0.01 ? f.toExponential(2) : f.toFixed(4);
}

module.exports = {
  checkGasBalance,
  STANDARD_SEND_TX_COST_FACTOR,
  _computeThreshold,
  _lastRebalanceGasNative,
  _formatNative,
};
