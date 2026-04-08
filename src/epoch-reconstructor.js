/**
 * @file src/epoch-reconstructor.js
 * @module epochReconstructor
 * @description
 * Reconstructs historical P&L epochs from on-chain rebalance events.
 * When the P&L tracker has no closed epochs (e.g. after wallet re-import),
 * this module queries each closed NFT in the rebalance chain via
 * `getPositionHistory()` and builds closed epoch objects that the tracker
 * can restore.  Results are cached to `.epoch-cache.json` (gitignored)
 * keyed by blockchain/wallet/contract/tokenId for fast restarts.
 *
 * Rate limiting
 * ─────────────
 * Each position lookup may trigger up to 4 GeckoTerminal API calls
 * (base+quote × open+close prices).  Rate limiting is handled centrally
 * by the sliding-window limiter in `price-fetcher.js` (25 calls / 60 s),
 * so no per-position delay is needed here.
 */

"use strict";

const { getPositionHistory } = require("./position-history");
const { getCachedEpochs, setCachedEpochs } = require("./epoch-cache");
const { actualGasCostUsd } = require("./bot-pnl-updater");

const EPOCH_COLORS = [
  "#00e5ff",
  "#ff6b35",
  "#7cfc00",
  "#c471ed",
  "#f7971e",
  "#43e97b",
  "#fa709a",
  "#4facfe",
  "#a8edea",
  "#fed6e3",
];

/**
 * Build a closed Epoch object from position history data.
 * @param {object} h       Result from getPositionHistory().
 * @param {number} index   0-based index for colour assignment.
 * @returns {object|null}  Epoch object, or null if insufficient data.
 */
function _buildClosedEpoch(h, index) {
  if (!_hasValidTimestamps(h)) return null;
  if (h.exitValueUsd === null || h.exitValueUsd === undefined) return null;
  return _assembleEpoch(h, index);
}

/** Check that at least one timestamp (open or close) is available. */
function _hasValidTimestamps(h) {
  return !!(h.mintDate || h.closeDate);
}

/** Assemble the epoch object from validated history data. */
function _assembleEpoch(h, index) {
  const openTime = h.mintDate ? new Date(h.mintDate).getTime() : 0;
  const closeTime = h.closeDate ? new Date(h.closeDate).getTime() : 0;
  const entryValue = h.entryValueUsd || 0;
  const exitValue = h.exitValueUsd || 0;
  const fees = h.feesEarnedUsd || 0;
  const gas = h.gasCostUsd || 0;
  return {
    id: index + 1,
    color: EPOCH_COLORS[index % EPOCH_COLORS.length],
    missingPrice: !h.entryValueUsd || !h.exitValueUsd,
    entryValue,
    entryPrice: 0,
    lowerPrice: 0,
    upperPrice: 0,
    openTime,
    closeTime: closeTime || openTime,
    fees,
    il: 0,
    gas,
    gasNative: h.gasNative || 0,
    exitValue,
    epochPnl: exitValue - entryValue + fees - gas,
    priceChangePnl: exitValue - entryValue - fees,
    feePnl: fees,
    hodlAmount0: h.entryAmount0 || 0,
    hodlAmount1: h.entryAmount1 || 0,
    token0UsdEntry: h.token0UsdPriceAtOpen || 0,
    token1UsdEntry: h.token1UsdPriceAtOpen || 0,
    token0UsdExit: h.token0UsdPriceAtClose || 0,
    token1UsdExit: h.token1UsdPriceAtClose || 0,
    status: "closed",
  };
}

/**
 * Reconstruct closed P&L epochs from historical rebalance events.
 * Queries on-chain data for each closed NFT to get fees, entry/exit values.
 * Skips if the tracker already has closed epochs (already reconstructed or
 * restored from disk cache).
 *
 * @param {object} opts
 * @param {object}   opts.pnlTracker       P&L tracker instance.
 * @param {Array}    opts.rebalanceEvents   Rebalance events from the scanner.
 * @param {object}   opts.botState          Bot state object.
 * @param {Function} opts.updateBotState    State update callback.
 * @returns {Promise<number>} Number of epochs reconstructed.
 */
/**
 * Build a cache key from bot state, or null if insufficient metadata.
 * @param {object} botState  Bot state with activePosition and walletAddress.
 * @returns {object|null}
 */
function _cacheKeyFromState(botState) {
  const ap = botState.activePosition;
  if (!ap || !ap.token0 || !ap.token1) return null;
  return {
    contract: botState.positionManager || "",
    wallet: botState.walletAddress || "",
    token0: ap.token0,
    token1: ap.token1,
    fee: ap.fee,
  };
}

/**
 * Fetch closed epoch data from chain for each closed NFT in the rebalance chain.
 * GeckoTerminal rate limiting is handled centrally in price-fetcher.js — no
 * per-position delay needed here.
 * @param {string[]} closedIds      Old token IDs to query.
 * @param {Array}    events         Rebalance events for context.
 * @param {object|null} activePos   Active position for pool lookup.
 * @param {object|null} fallbackPrices  Current prices {price0, price1} for when historical unavailable.
 * @param {Function|null} onProgress  Optional (done, total) callback for UI progress.
 * @returns {Promise<object[]>}   Array of closed Epoch objects (unsorted).
 */
async function _fetchEpochsFromChain(
  closedIds,
  events,
  activePos,
  fallbackPrices,
  onProgress,
) {
  const closedEpochs = [];
  for (let i = 0; i < closedIds.length; i++) {
    if (onProgress) onProgress(i, closedIds.length);
    const tokenId = closedIds[i];
    try {
      const h = await getPositionHistory(tokenId, {
        rebalanceEvents: events,
        activePosition: activePos,
        fallbackPrices,
      });
      if (h.gasCostWei) {
        const wei = BigInt(h.gasCostWei);
        h.gasNative = Number(wei) / 1e18;
        h.gasCostUsd = await actualGasCostUsd(wei);
      }
      const epoch = _buildClosedEpoch(h, closedEpochs.length);
      if (epoch) {
        closedEpochs.push(epoch);
        console.log(
          `[pnl] Epoch #${closedEpochs.length}: NFT #${tokenId} — fees $${epoch.fees.toFixed(2)}`,
        );
      } else {
        console.log(`[pnl] NFT #${tokenId}: skipped (incomplete data)`);
      }
    } catch (err) {
      console.warn(
        `[pnl] Could not reconstruct epoch for NFT #${tokenId}:`,
        err.message,
      );
    }
  }
  return closedEpochs;
}

/**
 * Merge closed epochs into the P&L tracker and persist.
 * @param {object}   pnlTracker     Tracker instance.
 * @param {object[]} closedEpochs   Sorted closed epoch array.
 * @param {object|null} liveEpoch   Current live epoch to preserve.
 * @param {Function} updateBotState State update callback.
 * @param {object|null} cacheKey    Disk cache key (null = skip cache).
 */
function _mergeAndPersist(
  pnlTracker,
  closedEpochs,
  liveEpoch,
  updateBotState,
  cacheKey,
) {
  closedEpochs.sort((a, b) => a.openTime - b.openTime);
  closedEpochs.forEach((e, i) => {
    e.id = i + 1;
  });
  pnlTracker.restore({ closedEpochs, liveEpoch });
  if (updateBotState) updateBotState({ pnlEpochs: pnlTracker.serialize() });
  if (cacheKey) setCachedEpochs(cacheKey, closedEpochs);
}

async function reconstructEpochs({
  pnlTracker,
  rebalanceEvents,
  botState,
  updateBotState,
  fallbackPrices,
}) {
  if (!pnlTracker || !rebalanceEvents?.length) return 0;

  const current = pnlTracker.serialize();
  if (current.closedEpochs?.length > 0) return 0;

  const closedIds = rebalanceEvents
    .filter((e) => e.oldTokenId && e.oldTokenId !== "?" && e.newTokenId)
    .map((e) => e.oldTokenId);
  if (!closedIds.length) return 0;

  const cacheKey = _cacheKeyFromState(botState);

  // Try disk cache first (fast restart path)
  if (cacheKey) {
    const cached = getCachedEpochs(cacheKey);
    const cachedEpochs = cached?.closedEpochs || [];
    if (cachedEpochs.length > 0) {
      console.log(`[pnl] Restored ${cachedEpochs.length} epoch(s) from cache`);
      _mergeAndPersist(
        pnlTracker,
        cachedEpochs,
        current.liveEpoch,
        updateBotState,
        null,
      );
      return cachedEpochs.length;
    }
  }

  console.log(
    `[pnl] Reconstructing ${closedIds.length} historical epoch(s) from chain…`,
  );
  const _progress = updateBotState
    ? (done, total) =>
        updateBotState({
          rebalanceScanProgress: 95 + Math.round((done / total) * 5),
        })
    : null;
  const closedEpochs = await _fetchEpochsFromChain(
    closedIds,
    rebalanceEvents,
    botState.activePosition,
    fallbackPrices,
    _progress,
  );
  if (!closedEpochs.length) return 0;

  _mergeAndPersist(
    pnlTracker,
    closedEpochs,
    current.liveEpoch,
    updateBotState,
    cacheKey,
  );
  console.log(`[pnl] Reconstructed ${closedEpochs.length} historical epoch(s)`);
  return closedEpochs.length;
}

module.exports = {
  reconstructEpochs,
  _buildClosedEpoch,
  _cacheKeyFromState,
  _mergeAndPersist,
  _hasValidTimestamps,
  _assembleEpoch,
};
