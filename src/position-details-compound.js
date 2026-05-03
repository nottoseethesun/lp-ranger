/**
 * @file position-details-compound.js
 * @description Compound-detection helpers for the unmanaged-position
 *   details flow. Extracted from position-details.js to keep that file
 *   under the 500-line cap. Provides:
 *   - _scanCompounds: full chain scan returning { total, current, currentGasUsd }
 *   - _detectCurrentNftValues: cheap one-NFT scan returning { compoundUsd, gasUsd }
 *   - _resolveCompounded: cache-first wrapper used by computeLifetimeDetails
 */

"use strict";

const config = require("./config");
const { getPositionConfig, saveConfig } = require("./bot-config-v2");
const { detectCompoundsOnChain } = require("./compounder");
const { actualGasCostUsd } = require("./bot-pnl-updater");

/*- Convert a chain-scan result for a single NFT into Current-panel
 *  values: standalone-compound USD (sum of per-event usdValue) and
 *  total NFT gas USD (mint TX + standalone compound TXs, valued at
 *  current native-token price). Both metrics match what the managed
 *  liveEpoch surfaces while the bot is running. */
async function _currentValuesFromScan(r) {
  const compoundUsd = (r.compounds || []).reduce(
    (s, c) => s + (c.usdValue || 0),
    0,
  );
  const gasUsd = r.totalNftGasWei
    ? await actualGasCostUsd(BigInt(r.totalNftGasWei))
    : 0;
  return { compoundUsd, gasUsd };
}

/**
 * Detect compounds across all NFTs in the rebalance chain and cache result.
 * `_detect` is injectable for tests; defaults to the production scanner.
 * Returns `{ total, current }` — total is lifetime across the chain;
 * current is the current NFT's own compounded value (used by the
 * Current panel's "Fees Compounded" row).
 */
async function _scanCompounds(
  position,
  events,
  body,
  ps,
  prices,
  diskConfig,
  posKey,
  dir,
  _detect = detectCompoundsOnChain,
) {
  try {
    const ids = new Set([String(position.tokenId)]);
    for (const e of events) {
      if (e.oldTokenId) ids.add(String(e.oldTokenId));
      if (e.newTokenId) ids.add(String(e.newTokenId));
    }
    const opts = {
      positionManagerAddress: config.POSITION_MANAGER,
      token0: position.token0,
      token1: position.token1,
      fee: position.fee,
      walletAddress: body.walletAddress,
      price0: prices.price0,
      price1: prices.price1,
      decimals0: ps.decimals0,
      decimals1: ps.decimals1,
    };
    /*- total = lifetime collected fees across the rebalance chain
     *  (Lifetime panel "Fees Compounded"). current = sum of standalone
     *  compound deposit values for the current NFT only (Current panel
     *  "Fees Compounded") — matches bot-recorder-lifetime's compound-
     *  History/usdValue model so managed and unmanaged agree.
     *  currentGasUsd = mint + standalone compound gas for the current
     *  NFT, valued at current native price. */
    let total = 0;
    let current = 0;
    let currentGasUsd = 0;
    const curId = String(position.tokenId);
    for (const tid of ids) {
      const r = await _detect(tid, opts);
      total += r.totalCompoundedUsd;
      if (tid === curId) {
        const cv = await _currentValuesFromScan(r);
        current = cv.compoundUsd;
        currentGasUsd = cv.gasUsd;
      }
    }
    if (total > 0) {
      getPositionConfig(diskConfig, posKey).totalCompoundedUsd = total;
      saveConfig(diskConfig, dir);
    }
    return { total, current, currentGasUsd };
  } catch (e) {
    console.warn("[position details] compound detection failed:", e.message);
    return { total: 0, current: 0, currentGasUsd: 0 };
  }
}

/*- Detect Current-panel values for the current NFT only (one cheap
 *  scan): standalone compound USD and total NFT gas USD. */
async function _detectCurrentNftValues(
  position,
  body,
  ps,
  prices,
  _detect = detectCompoundsOnChain,
) {
  try {
    const opts = {
      positionManagerAddress: config.POSITION_MANAGER,
      token0: position.token0,
      token1: position.token1,
      fee: position.fee,
      walletAddress: body.walletAddress,
      price0: prices.price0,
      price1: prices.price1,
      decimals0: ps.decimals0,
      decimals1: ps.decimals1,
    };
    const r = await _detect(String(position.tokenId), opts);
    return await _currentValuesFromScan(r);
  } catch (e) {
    console.warn(
      "[position details] current-NFT values detection failed:",
      e.message,
    );
    return { compoundUsd: 0, gasUsd: 0 };
  }
}

/*- Resolve compounded USD from disk cache or chain scan.  Returns
 *  `{ total, current, currentGasUsd }`: total is the lifetime compounded
 *  across the rebalance chain (Lifetime panel); current is the current
 *  NFT's standalone-compound USD; currentGasUsd is the current NFT's
 *  total gas (mint + standalone compounds). The Current panel reads
 *  the latter two — they would otherwise render as dash on unmanaged
 *  positions even when the values are material. */
async function _resolveCompounded(
  position,
  events,
  body,
  ps,
  prices,
  diskConfig,
  posKey,
) {
  const posConfig = diskConfig.positions[posKey] || {};
  if (posConfig.totalCompoundedUsd) {
    /*- Cache hit on the lifetime total — still need a one-NFT scan
     *  for the current values (not cached on disk; per-tokenId scan
     *  is cheap, ~1 RPC call vs the full chain scan for the cold path). */
    const cv = await _detectCurrentNftValues(position, body, ps, prices);
    return {
      total: posConfig.totalCompoundedUsd,
      current: cv.compoundUsd,
      currentGasUsd: cv.gasUsd,
    };
  }
  if (events.length === 0) return { total: 0, current: 0, currentGasUsd: 0 };
  return _scanCompounds(position, events, body, ps, prices, diskConfig, posKey);
}

module.exports = {
  _scanCompounds,
  _detectCurrentNftValues,
  _resolveCompounded,
};
