/**
 * @file src/bot-provider.js
 * @module bot-provider
 * @description
 * RPC provider with automatic fallback and fee data patching.
 * Extracted from bot-loop.js.
 */

"use strict";
const { log } = require("./log");
const ethers = require("ethers");
const config = require("./config");

/*- Throttle for the per-call feeData log line.  Every call logs in
    --verbose mode; otherwise log at most once per hour so the terminal
    stays readable over long sessions. */
const _FEE_LOG_INTERVAL_MS = 60 * 60 * 1000;
let _lastFeeDataLogAt = 0;

/**
 * Patch `provider.getFeeData()` to guarantee a non-zero gas price.
 * PulseChain supports EIP-1559 but ethers.js v6's `getFeeData()` intermittently
 * returns null/0 for all fee fields.  When this happens, ethers submits TXs with
 * 0 gas price — they sit pending forever or get mined as failed.  This patch
 * intercepts the call and falls back to raw `eth_gasPrice` RPC when needed.
 * @param {import('ethers').JsonRpcProvider} provider
 */
function _patchFeeData(provider) {
  if (typeof provider.getFeeData !== "function") return;
  const _orig = provider.getFeeData.bind(provider);
  provider.getFeeData = async () => {
    const fd = await _orig();
    const now = Date.now();
    if (config.VERBOSE || now - _lastFeeDataLogAt >= _FEE_LOG_INTERVAL_MS) {
      _lastFeeDataLogAt = now;
      log.info(
        "[bot] feeData: gasPrice=%s maxFee=%s maxPriority=%s",
        String(fd.gasPrice),
        String(fd.maxFeePerGas),
        String(fd.maxPriorityFeePerGas),
      );
    }
    // Chain-specific gas price multiplier from app-config/static-tunables/chains.json.
    // Return ONLY gasPrice (no maxFeePerGas/maxPriorityFeePerGas) so
    // ethers.js sends legacy type 0 TXs. PulseChain validators don't
    // reliably include EIP-1559 type 2 TXs — they sit pending forever.
    const _mult = config.CHAIN.gasPriceMultiplier || 1;
    const gp = fd.gasPrice && fd.gasPrice > 0n ? fd.gasPrice : fd.maxFeePerGas;
    if (gp && gp > 0n) {
      const scaled = (gp * BigInt(Math.round(_mult * 1000))) / 1000n;
      return new ethers.FeeData(scaled, null, null);
    }
    log.warn(
      "[bot] getFeeData returned zero/null — falling back to eth_gasPrice RPC",
    );
    try {
      const gp = BigInt(await provider.send("eth_gasPrice", []));
      if (gp > 0n) {
        log.info("[bot] eth_gasPrice fallback: %s", String(gp));
        return new ethers.FeeData(gp, null, null);
      }
    } catch (e) {
      log.warn("[bot] eth_gasPrice fallback failed:", e.message);
    }
    return fd;
  };
}

/**
 * Construct a single JsonRpcProvider for `url` and apply the feeData patch.
 *
 * Pure factory — does NOT perform a reachability check.  Used by callers
 * that need ALL configured providers built up-front (e.g. send-transaction.js
 * which holds primary + fallback for mid-session failover, and must be
 * able to reach for the fallback even if the primary was down at boot).
 * @param {string} url           RPC endpoint URL.
 * @param {object} [ethersLib]   Injected ethers library (for testing).
 * @returns {import('ethers').JsonRpcProvider}
 */
function buildProvider(url, ethersLib) {
  const lib = ethersLib || ethers;
  const provider = new lib.JsonRpcProvider(url);
  _patchFeeData(provider);
  return provider;
}

module.exports = { _patchFeeData, buildProvider };
