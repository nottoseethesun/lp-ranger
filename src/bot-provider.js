/**
 * @file src/bot-provider.js
 * @module bot-provider
 * @description
 * RPC provider with automatic fallback and fee data patching.
 * Extracted from bot-loop.js.
 */

"use strict";
const ethers = require("ethers");
const config = require("./config");

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
    console.log(
      "[bot] feeData: gasPrice=%s maxFee=%s maxPriority=%s",
      String(fd.gasPrice),
      String(fd.maxFeePerGas),
      String(fd.maxPriorityFeePerGas),
    );
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
    console.warn(
      "[bot] getFeeData returned zero/null — falling back to eth_gasPrice RPC",
    );
    try {
      const gp = BigInt(await provider.send("eth_gasPrice", []));
      if (gp > 0n) {
        console.log("[bot] eth_gasPrice fallback: %s", String(gp));
        return new ethers.FeeData(gp, null, null);
      }
    } catch (e) {
      console.warn("[bot] eth_gasPrice fallback failed:", e.message);
    }
    return fd;
  };
}

/**
 * Creates a JsonRpcProvider, trying the primary URL first and falling back
 * to the secondary if the primary is unreachable.  The returned provider's
 * `getFeeData()` is patched to guarantee non-zero gas pricing on PulseChain.
 * @param {string} primaryUrl    Primary RPC endpoint.
 * @param {string} fallbackUrl   Fallback RPC endpoint.
 * @param {object} [ethersLib]   Injected ethers library (for testing).
 * @returns {Promise<import('ethers').JsonRpcProvider>}
 */
async function createProviderWithFallback(primaryUrl, fallbackUrl, ethersLib) {
  const lib = ethersLib || ethers;
  try {
    const provider = new lib.JsonRpcProvider(primaryUrl);
    await provider.getBlockNumber();
    console.log(`[bot] RPC:    ${primaryUrl}`);
    _patchFeeData(provider);
    return provider;
  } catch (err) {
    console.warn(
      `[bot] Primary RPC unreachable (${primaryUrl}): ${err.message}`,
    );
    console.log(`[bot] Falling back to ${fallbackUrl}`);
    const provider = new lib.JsonRpcProvider(fallbackUrl);
    await provider.getBlockNumber();
    console.log(`[bot] RPC:    ${fallbackUrl} (fallback)`);
    _patchFeeData(provider);
    return provider;
  }
}

module.exports = { _patchFeeData, createProviderWithFallback };
