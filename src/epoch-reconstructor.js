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

const { log } = require("./log");
const config = require("./config");
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
 * Build a cache key from bot state, or null if insufficient metadata.
 *
 * The contract comes from `config.POSITION_MANAGER`, the same source the
 * other three builders use — `_persistEpochCache` (server-positions.js),
 * the startup restore (bot-loop-detect.js) and the unmanaged-position
 * read (position-details.js).  All four must agree, because the key is
 * the only thing joining them: a key built from a different source —
 * `botState.positionManager`, say, which nothing sets — yields
 * `pulsechain..0x4e44…` instead of `pulsechain.0xcc05bf….0x4e44…`, and
 * that is a second, private history for the same pool.
 *
 * The visible symptom would be Reload Current Position failing to
 * reload: it clears the entry under the shared key, then reconstruction
 * finds its own copy still populated and takes the fast-restart
 * shortcut instead of rebuilding from the chain.
 *
 * @param {object} botState  Bot state with activePosition and walletAddress.
 * @returns {object|null}
 */
function _cacheKeyFromState(botState) {
  const ap = botState.activePosition;
  if (!ap || !ap.token0 || !ap.token1) return null;
  return {
    contract: config.POSITION_MANAGER,
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
        log.info(
          `[pnl] Epoch #${closedEpochs.length}: NFT #${tokenId} — fees $${epoch.fees.toFixed(2)}`,
        );
      } else {
        log.info(`[pnl] NFT #${tokenId}: skipped (incomplete data)`);
      }
    } catch (err) {
      log.warn(
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

/**
 * Whether the epoch history we already hold covers the whole rebalance
 * chain, so reconstruction has nothing to add.
 *
 * Asks "do we have ALL of them?", not "do we have ANY?".  The previous
 * `closedEpochs.length > 0` test treated a partial history as a
 * finished one, and the position it broke was the one the bot had
 * rebalanced itself: eight epochs closed live as those rebalances
 * happened, so reconstruction bailed at the first line and never
 * rebuilt the 124 rebalances from before and after that window.  Every
 * other pool started with zero epochs, reconstructed in full, and
 * looked fine — which is why the gap stayed invisible.
 *
 * Same shape as the Fees Compounded bug in
 * `src/bot-recorder-lifetime.js`: presence of some data taken as proof
 * of complete data.
 *
 * Accepted cost of counting rather than marking: if reconstruction
 * cannot build an epoch for every closed NFT — a missing historical
 * price, say — the count stays short and the next start reconstructs
 * again.  That is the correct answer to a genuinely short history (it
 * fills in once the price is available) and it is what a stored
 * "already reconstructed" marker would get wrong, at the price of
 * repeating the chain queries.  Observed behaviour is a full build:
 * every pool that has reconstructed holds exactly as many epochs as its
 * chain has closed positions.
 *
 * @param {object[]|undefined} closedEpochs  Epochs already held.
 * @param {string[]} closedIds  Old token IDs the rebalance chain closed.
 * @returns {boolean}
 */
function isEpochHistoryComplete(closedEpochs, closedIds) {
  return (closedEpochs?.length || 0) >= closedIds.length;
}

/**
 * Whether this run must rebuild every epoch from chain, discarding what
 * the tracker holds.
 *
 * `Reload Current Position` clears the epoch cache on disk, but the bot
 * loop keeps its epochs in memory.  Without this the completeness guard
 * below saw a full history (132 of 132 on the pool that exposed it),
 * returned immediately, and the next poll wrote the untouched set back
 * over the cleared file — so Reload cleared a copy that memory restored
 * a few seconds later, and no correction to how an epoch is derived
 * could ever reach an existing install.
 *
 * Dropping the closed epochs here is what makes that safe, and it does
 * two jobs.  It stops the guard short-circuiting, and it means a
 * rebuild that fails leaves nothing stale behind to be persisted: the
 * tracker holds zero closed epochs, so the next scan sees an
 * incomplete history and rebuilds again on its own.  The open epoch is
 * kept — it is the live position, not history.
 *
 * The request is consumed on the attempt rather than on success, since
 * an empty tracker already guarantees the retry.
 *
 * Set by `_resetBotState` in src/server-reload-position.js.  Deliberately
 * NOT `_needsFullRescan`, which every rebalance sets — reusing that
 * would rebuild the whole chain from scratch after each one.
 *
 * @param {object} botState     Live bot state (same object the reload mutates).
 * @param {object} pnlTracker   Tracker to clear when a rebuild is requested.
 * @param {object} current      Already-serialized tracker state.
 * @returns {boolean}
 */
function _consumeRebuildRequest(botState, pnlTracker, current) {
  if (botState._needsEpochRebuild !== true) return false;
  botState._needsEpochRebuild = false;
  log.info("[pnl] Reload requested a full epoch rebuild — discarding cache");
  pnlTracker.restore({ closedEpochs: [], liveEpoch: current.liveEpoch });
  return true;
}

/**
 * Reconstruct closed P&L epochs from historical rebalance events.
 * Queries on-chain data for each closed NFT to get fees, entry/exit values.
 * Skips only when the history already covers every closed position in the
 * chain — see `isEpochHistoryComplete`.
 *
 * @param {object} opts
 * @param {object}   opts.pnlTracker       P&L tracker instance.
 * @param {Array}    opts.rebalanceEvents   Rebalance events from the scanner.
 * @param {object}   opts.botState          Bot state object.
 * @param {Function} opts.updateBotState    State update callback.
 * @returns {Promise<number>} Number of epochs reconstructed.
 */
async function reconstructEpochs({
  pnlTracker,
  rebalanceEvents,
  botState,
  updateBotState,
  fallbackPrices,
}) {
  if (!pnlTracker || !rebalanceEvents?.length) return 0;

  /*- Computed BEFORE the guards below: it is the yardstick they measure
   *  against, so it cannot come after them. */
  const closedIds = rebalanceEvents
    .filter((e) => e.oldTokenId && e.oldTokenId !== "?" && e.newTokenId)
    .map((e) => e.oldTokenId);
  if (!closedIds.length) return 0;

  const current = pnlTracker.serialize();
  const forced = _consumeRebuildRequest(botState, pnlTracker, current);
  if (!forced && isEpochHistoryComplete(current.closedEpochs, closedIds))
    return 0;

  const cacheKey = _cacheKeyFromState(botState);

  /*- Fast restart path — skipped on a forced rebuild.  Reload clears
   *  the cache entry, but a poll landing between the clear and this
   *  call can write the outgoing epochs straight back; taking the
   *  cache here would then hand back the very data being replaced. */
  if (cacheKey && !forced) {
    const cached = getCachedEpochs(cacheKey);
    const cachedEpochs = cached?.closedEpochs || [];
    if (isEpochHistoryComplete(cachedEpochs, closedIds)) {
      log.info(`[pnl] Restored ${cachedEpochs.length} epoch(s) from cache`);
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

  log.info(
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
  log.info(`[pnl] Reconstructed ${closedEpochs.length} historical epoch(s)`);
  return closedEpochs.length;
}

module.exports = {
  reconstructEpochs,
  _consumeRebuildRequest,
  isEpochHistoryComplete,
  _buildClosedEpoch,
  _cacheKeyFromState,
  _mergeAndPersist,
  _hasValidTimestamps,
  _assembleEpoch,
};
