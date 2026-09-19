/**
 * @file src/epoch-reconstructor.js
 * @module epochReconstructor
 * @description
 * Reconstructs historical P&L epochs from on-chain rebalance events.
 * When the P&L tracker has no closed epochs (e.g. after wallet re-import),
 * this module queries each closed NFT in the rebalance chain via
 * `getPositionHistory()` and builds closed epoch objects that the tracker
 * can restore.  The on-chain Collect/DecreaseLiquidity history behind
 * those queries is read for the whole chain in one pass first, rather
 * than once per NFT — see `_readChainHistories`.  Results are cached in
 * the epoch cache (`src/epoch-cache.js`), keyed by pool identity, for
 * fast restarts.
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
const {
  scanChainCollectAndDrain,
  collectAndDrainOf,
} = require("./position-history-scan-helpers");
const { eventsFor } = require("./nft-events-batch");
const { getCachedEpochs, setCachedEpochs } = require("./epoch-cache");
const { actualGasCostUsd } = require("./bot-pnl-updater");
const {
  fetchTokenPriceUsd,
  withFreshPricesAllowed,
} = require("./price-fetcher");

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
  /*- Fees follow the same rule as the exit value, and for the same
   *  reason. `feesEarnedUsd` is initialised to null and becomes a number
   *  only when the rebalance log carried one or the chain scan
   *  succeeded, so null means "not known" — never "zero". Admit it and
   *  a zero fallback answers on its behalf, writing a fee figure that
   *  reads exactly like a real one and understating the position for as
   *  long as the epoch stands.
   *
   *  `scanCollectAndDrain` returns null rather than [] to keep the same
   *  distinction one layer down; the guard belongs here too. */
  if (h.feesEarnedUsd === null || h.feesEarnedUsd === undefined) return null;
  /*- Gas is the third input to `epochPnl` and gets the third guard, for
   *  the same reason as the other two. Left unguarded it runs the other
   *  way: an unknown cost subtracted as zero reports MORE profit than
   *  the position made.
   *
   *  `_fetchEpochsFromChain` sets `gasCostUsd` only when it actually
   *  resolved one — both when the wei amount is unknown and when the
   *  USD price behind it is — so an absent value here always means "not
   *  known", never "free". A rebalance always costs gas. */
  if (h.gasCostUsd === null || h.gasCostUsd === undefined) return null;
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
  /*- No `|| 0` here: `_buildClosedEpoch` has already rejected a null or
   *  undefined value, so a zero reaching this line is a real zero. A
   *  fallback would quietly restore the behaviour the guard removes. */
  const fees = h.feesEarnedUsd;
  /*- No `|| 0` here either, and for the same reason as the fees above:
   *  `_buildClosedEpoch` rejected the unknowns, so a zero reaching this
   *  line is a rebalance that genuinely cost nothing to make. */
  const gas = h.gasCostUsd;
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
 * When an epoch's gas was spent, for pricing it.
 *
 * The gas charged to an epoch is the rebalance that closed it, so the
 * close is the moment to price at: the date for GeckoTerminal, whose
 * historical candles are per-day, and the block for Moralis, which is
 * exact. A record carrying neither returns `undefined`, and the charge
 * is valued at today's price instead.
 *
 * @param {object} h  History record for one NFT in the chain.
 * @param {boolean} [refresh]  Read past the price cache and replace what
 *   it holds — the Re-scan Prices path, for a day cached at a bad price.
 * @returns {{timestamp: number, blockNumber: number|undefined,
 *   refresh: boolean}|undefined}
 */
function _gasSpentAt(h, refresh = false) {
  if (h.closeDate === undefined || h.closeDate === null) return undefined;
  const ms = new Date(h.closeDate).getTime();
  /*-
   *  An unparseable date gives NaN, which would travel as a timestamp
   *  and price the gas against nothing.
   */
  if (Number.isNaN(ms) || ms <= 0) return undefined;
  return {
    timestamp: Math.floor(ms / 1000),
    blockNumber: h.closeBlockNumber,
    refresh,
  };
}

/**
 * Resolve the native token's USD price once, before converting any gas.
 *
 * Gas is priced at the day it was spent, like every other figure on an
 * epoch. This warms the CURRENT price because that is gas's fallback:
 * when no historical source can answer for a given day, the charge is
 * valued at today's market rather than at nothing.
 *
 * That fallback is the reason this matters at all.
 * `actualGasCostUsd` reports a failed price lookup as `0`, and a
 * zero USD on a non-zero wei amount is what `_fetchEpochsFromChain`
 * reads as "price unknown", so without a resolved price every epoch in
 * the chain is rejected and the history never builds.
 *
 * That is not hypothetical: `bot.js` pauses price lookups at startup
 * unless `--start-with-price-lookups-unpaused` is passed, and the only
 * thing that lifts the pause is browser activity — which a headless run
 * never has. A paused lookup returns the last cached value or `0`, and
 * a process that has never fetched has nothing cached.
 *
 * One fetch, inside `withFreshPricesAllowed` so the pause does not
 * apply to it, and every later reader of the CURRENT price takes it from
 * cache. The historical lookups each epoch makes are a separate matter:
 * they are not behind the pause at all, and they are bounded by the
 * number of distinct days the chain closed on rather than by the number
 * of NFTs, because the day cache answers the repeats.
 *
 * Failure is left to speak for itself: a genuinely unresolvable price
 * still yields `0`, the epochs are still rejected, and the rescan
 * retries. Rejecting beats recording a gas cost of nothing.
 *
 * @returns {Promise<void>}
 */
async function _warmNativePrice() {
  try {
    await withFreshPricesAllowed(() =>
      fetchTokenPriceUsd(config.CHAIN.nativeWrappedToken),
    );
  } catch {
    /*- Swallowed deliberately: the price is an input to gas, not to the
     *  scan. A failure here surfaces as rejected epochs and a retry,
     *  which is the same path any other unresolved gas cost takes. */
  }
}

/**
 * A closed NFT's buffered history from an earlier attempt, if any.
 *
 * A closed NFT is inert: it was drained and the app never returns to
 * it, so its history cannot change between one attempt and the next.
 * Reusing a buffered read is therefore exact, not a cache with a
 * staleness window.
 *
 * @param {Map<string, object>|undefined} resumeBuffer
 * @param {string} tokenId
 * @returns {object|undefined}
 */
function _buffered(resumeBuffer, tokenId) {
  return resumeBuffer instanceof Map ? resumeBuffer.get(tokenId) : undefined;
}

/**
 * Read the Collect/DecreaseLiquidity history of every closed NFT this
 * pass will build, in one batch, before the per-NFT loop starts.
 *
 * Read one NFT at a time, each from its own mint block to the chain
 * head, those histories would overlap almost entirely. On a long chain
 * that would be hours of paced requests on every rebuild. See
 * `scanChainCollectAndDrain`.
 *
 * Covers exactly the NFTs the loop will fetch — the ones not in the
 * resume buffer, by the same test the loop applies — so every lookup the
 * loop makes was prepared, and a buffered NFT is not read again.
 *
 * When another consumer in the same pass is going to read the whole chain
 * anyway (`readChainEvents`), the histories come out of that read instead
 * of a second one. With nothing left to read, neither read is started on
 * this function's behalf.
 *
 * A failed read is not an exception here, for the same reason no
 * per-NFT failure is: the pass must finish. It returns null, and every
 * NFT then takes its history as unknown, the same answer a failed
 * per-NFT read gives. An NFT whose exit value and fee the rebalance log
 * already holds still builds; the rest are skipped, which flags the
 * history for another attempt.
 *
 * @param {string[]} closedIds
 * @param {Array} events  Rebalance events.
 * @param {Map<string, object>|undefined} resumeBuffer
 * @param {() => Promise<Map<string, object>>} [readChainEvents]  The
 *   pass's shared whole-chain read, when there is one.
 * @returns {Promise<Map<string, object|null>|null>}  Null when the read
 *   failed.
 */
async function _readChainHistories(
  closedIds,
  events,
  resumeBuffer,
  readChainEvents,
) {
  const unread = closedIds.filter(
    (id) => _buffered(resumeBuffer, id) === undefined,
  );
  if (unread.length === 0) return new Map();
  try {
    if (readChainEvents === undefined || readChainEvents === null) {
      return await scanChainCollectAndDrain(unread, events);
    }
    const chainEvents = await readChainEvents();
    log.info(
      "[pnl] Taking %d closed NFT(s)' Collect/DecreaseLiquidity history from the lifetime read of the same chain",
      unread.length,
    );
    return collectAndDrainOf(chainEvents, unread);
  } catch (err) {
    log.warn(
      "[pnl] Could not read Collect/DecreaseLiquidity history for %d closed NFT(s): %s",
      unread.length,
      err.message,
    );
    return null;
  }
}

/**
 * One closed NFT's history, read from chain.
 *
 * @param {string} tokenId
 * @param {object} ctx
 * @param {Map<string, object|null>|null} ctx.histories  From
 *   `_readChainHistories`.
 * @param {Array} ctx.events  Rebalance events.
 * @param {object|null} ctx.activePos
 * @param {object|null} ctx.fallbackPrices
 * @returns {Promise<object>}
 */
async function _readHistory(tokenId, ctx) {
  /*-
   *  `eventsFor` throws for an NFT the batch was not prepared with,
   *  rather than answering "no history" for it.
   */
  const collectAndDrain =
    ctx.histories === null ? null : eventsFor(ctx.histories, tokenId);
  return getPositionHistory(tokenId, {
    rebalanceEvents: ctx.events,
    activePosition: ctx.activePos,
    fallbackPrices: ctx.fallbackPrices,
    collectAndDrain,
    refreshPrices: ctx.refreshPrices === true,
  });
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
 * @param {Map<string, object>} [resumeBuffer]  NFTs already read by an
 *   earlier attempt; see `reconstructEpochs`.
 * @param {() => Promise<Map<string, object>>} [readChainEvents]  The
 *   pass's shared whole-chain read; see `_readChainHistories`.
 * @param {boolean} [refreshPrices]  Read past the price cache while
 *   rebuilding — the Re-scan Prices opt-in, not an ordinary Reload.
 * @returns {Promise<object[]>}   Array of closed Epoch objects (unsorted).
 */
async function _fetchEpochsFromChain(
  closedIds,
  events,
  activePos,
  fallbackPrices,
  onProgress,
  resumeBuffer,
  readChainEvents,
  refreshPrices = false,
) {
  await _warmNativePrice();
  const histories = await _readChainHistories(
    closedIds,
    events,
    resumeBuffer,
    readChainEvents,
  );
  const ctx = { histories, events, activePos, fallbackPrices, refreshPrices };
  const closedEpochs = [];
  for (let i = 0; i < closedIds.length; i++) {
    if (onProgress) onProgress(i, closedIds.length);
    const tokenId = closedIds[i];
    try {
      const buffered = _buffered(resumeBuffer, tokenId);
      const h = buffered ?? (await _readHistory(tokenId, ctx));
      /*- Explicit, not truthiness: a genuine zero must convert rather
       *  than fall through and be read as an unknown. */
      const gasKnown = h.gasCostWei !== null && h.gasCostWei !== undefined;
      if (buffered === undefined && gasKnown) {
        const wei = BigInt(h.gasCostWei);
        const usd = await actualGasCostUsd(
          wei,
          _gasSpentAt(h, ctx.refreshPrices === true),
        );
        /*- A second way to a fabricated $0.00, and the likelier one:
         *  the wei amount is known but the price behind it is not.
         *  `actualGasCostUsd` answers 0 both when its price lookup
         *  throws and when `fetchTokenPriceUsd` returns 0 — which is
         *  what the idle pause returns with no cached price.
         *
         *  Since usd = (wei / 1e18) × price, a positive wei can only
         *  yield zero when the price was zero. So the pair below is
         *  decidable without changing `actualGasCostUsd`, whose nine
         *  callers include one that feeds `tracker.addGas()` directly
         *  and would break on a null.
         *
         *  Left unset otherwise, so the guard in `_buildClosedEpoch`
         *  skips this NFT and the next pass reads it again. */
        if (wei === 0n || usd > 0) {
          h.gasNative = Number(wei) / 1e18;
          h.gasCostUsd = usd;
        }
      }
      const epoch = _buildClosedEpoch(h, closedEpochs.length);
      if (epoch) {
        closedEpochs.push(epoch);
        /*- Buffered only once the epoch built, which is what makes an
         *  unknown fee behave as a failed read: it is left out, so the
         *  next attempt fetches exactly that NFT again rather than
         *  inheriting the gap. */
        if (resumeBuffer instanceof Map) resumeBuffer.set(tokenId, h);
        log.info(
          `[pnl] Epoch #${closedEpochs.length}: NFT #${tokenId}${buffered === undefined ? "" : " (buffered)"} — fees $${epoch.fees.toFixed(2)}`,
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
  /*- A short result is the normal shape of a failed reconstruction, not
   *  an exception: every per-NFT failure above is caught and skipped, so
   *  the loop always finishes and "Reconstructed 90 historical epoch(s)"
   *  reads exactly like "Reconstructed 132". Saying how many were
   *  expected is what makes the difference visible in a log. The
   *  completeness guard already forces a rebuild next time; this is so
   *  the operator can see why one happened. */
  if (closedEpochs.length < closedIds.length) {
    log.warn(
      "[pnl] Reconstruction incomplete: %d of %d epochs built — %d NFT(s) could not be read. Figures derived from these epochs understate until a later scan completes.",
      closedEpochs.length,
      closedIds.length,
      closedIds.length - closedEpochs.length,
    );
    /*- Second line, deliberately: the first says what happened, this
     *  says what to do about it. An operator reading the first alone
     *  cannot tell whether the app is going to fix this by itself. */
    log.warn(
      "[pnl] Recommended: leave it running. A rescan is already scheduled, and it re-reads only the %d missing NFT(s) — the ones already read are held in memory and are not fetched again. Restarting discards them and starts this chain over. If the shortfall repeats, the cause is upstream: look for [send-tx] RPC failover lines above.",
      closedIds.length - closedEpochs.length,
    );
  }
  return closedEpochs;
}

/**
 * Read the chain and return the whole closed-epoch set.
 *
 * Ordinarily that means every closed NFT. Under a windowed re-value it
 * means only the recent ones, with the older epochs carried over from
 * what is already held — `_splitByWindow` decides which is which, and
 * hands back an empty `keep` for every non-windowed caller, so their
 * behaviour is unchanged.
 *
 * The set returned is always measured against the WHOLE chain by the
 * completeness check downstream, never against the window. A windowed
 * pass that re-read everything it meant to therefore reports the table
 * as complete rather than arming the thirty-minute retry.
 *
 * @param {object} o  See `reconstructEpochs`; `cachedEpochs` is the set
 *   already held, and `windowDays` 0 means the whole chain.
 * @param {Function} [o._fetch]  Stands in for `_fetchEpochsFromChain`
 *   in tests, so the short-read fallback can run without a chain.
 * @returns {Promise<object[]>} Closed epochs, unsorted.
 */
async function _rebuildClosedEpochs(o) {
  /*- Injected in tests so the short-read fallback can be exercised
   *  without a chain; the same shape as `_detect` in
   *  position-details-compound.js. */
  const fetchEpochs = o._fetch ?? _fetchEpochsFromChain;
  /*- Both reads below differ only in which NFTs they cover, so the rest
   *  of the arguments are named once. */
  const read = (nftIds) =>
    fetchEpochs(
      nftIds,
      o.rebalanceEvents,
      o.botState.activePosition,
      o.fallbackPrices,
      o.onProgress,
      o.botState._epochResumeBuffer,
      o.readChainEvents,
      o.refreshPrices,
    );
  const { ids, keep } = _splitByWindow(
    o.rebalanceEvents,
    o.closedIds,
    o.cachedEpochs ?? [],
    o.windowDays,
  );
  const rebuilt = await read(ids);
  if (keep.length === 0) return rebuilt;
  /*-
   *  A windowed pass that came back short cannot be merged, and the
   *  reason is in `setCachedEpochs`: its "never lose historical epochs"
   *  rule reads a short incoming set as one whose OLD periods are
   *  missing, and prepends that many from the existing cache. That
   *  premise holds for every other caller. It does not hold here —
   *  `keep` is already carrying those old periods — so the prepend
   *  would add a second copy of the oldest ones while the period that
   *  actually failed stayed missing. The Per-Day table would show a
   *  duplicated old row, and its gas would be counted twice.
   *
   *  So on a short read the window is abandoned and the whole chain is
   *  rebuilt in this same pass. The NFTs just read are in the resume
   *  buffer and are not read again, so the cost is only the periods the
   *  window had skipped — and the result is a set whose length means
   *  what every reader downstream assumes it means.
   */
  if (rebuilt.length >= ids.length) return [...keep, ...rebuilt];
  log.warn(
    "[pnl] Re-scan window abandoned — %d of %d period(s) came back; rebuilding the whole chain rather than merging a short set",
    rebuilt.length,
    ids.length,
  );
  return read(o.closedIds);
}

/**
 * Merge closed epochs into the P&L tracker and persist.
 *
 * The live epoch goes to disk with the closed ones, so both writes below
 * say the same thing. `setCachedEpochs` reads a bare array as "no live
 * epoch" and stores `null` for one, which would undo the full state
 * written a line above it.
 *
 * It has to persist because it carries a figure nothing can rebuild.
 * Its entry value, fees and compounded coins are all re-derived on the
 * next poll, so those would cost nothing to drop. Its GAS would: gas
 * only accumulates, so a dropped charge is gone, and a charge restored
 * without its "already counted" mark is added a second time. See
 * `addMintGas` in `pnl-tracker.js` and `_recordCancelGas` in
 * `bot-cycle.js` for the two charges that depend on this.
 *
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
  if (cacheKey) setCachedEpochs(cacheKey, pnlTracker.serialize());
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
 * @returns {{forced: boolean, refreshPrices: boolean, windowDays: number}}
 *   Whether to rebuild from scratch, whether to read past the price cache
 *   while doing so, and how many days back to reach (0 = no limit).
 */
function _consumeRebuildRequest(botState, pnlTracker, current) {
  const rebuild = botState._needsEpochRebuild === true;
  const revalue = botState._needsEpochPriceRevalue === true;
  if (!rebuild && !revalue)
    return { forced: false, refreshPrices: false, windowDays: 0 };
  /*- Only a re-value is date-scoped. Reload's purpose is to replace the
   *  whole history, so a window on it would leave behind exactly the
   *  stale rows it was asked to discard. */
  const days = revalue ? botState._epochRevalueWindowDays : 0;
  const windowDays = Number.isInteger(days) && days > 0 ? days : 0;
  botState._needsEpochRebuild = false;
  botState._needsEpochPriceRevalue = false;
  botState._epochRevalueWindowDays = 0;
  log.info(
    "[pnl] %s requested a full epoch rebuild%s",
    revalue ? "Re-scan Prices" : "Reload",
    revalue
      ? windowDays > 0
        ? ` — re-reading prices from the last ${windowDays} day(s)`
        : " — re-reading every price"
      : " — discarding cache",
  );
  /*-
   *  Reload empties the history first because its whole purpose is to
   *  replace what is held with what the chain says; keeping the old set
   *  would let a stale epoch survive the rebuild it asked for.
   *
   *  A re-value is the opposite request. Only the prices are in doubt,
   *  and the figures stand until their replacements exist —
   *  `_mergeAndPersist` overwrites the set once the rebuild returns. So
   *  the epochs are left alone here: emptying them would blank the
   *  Per-Day table for the whole run, and a re-scan interrupted halfway
   *  would leave nothing behind rather than what it started with.
   *
   *  `forced` still does the work either way: it bypasses the
   *  completeness guard and the cache fast path below, and discards the
   *  resume buffer, so the chain is genuinely re-read.
   */
  if (rebuild)
    pnlTracker.restore({ closedEpochs: [], liveEpoch: current.liveEpoch });
  return { forced: true, refreshPrices: revalue, windowDays };
}

/**
 * Split the chain's closed NFTs into the ones a windowed re-value has to
 * re-read and the epochs it can leave alone.
 *
 * The window exists so an operator who spots one bad recent price does
 * not pay for a whole chain. It is a date cutoff because that is the
 * only axis the stored data supports: an epoch records `closeTime` but
 * NOT the NFT it came from, so "rebuild just this one" is not
 * expressible — see the *Rebuild Only the Missing Epoch* nice-to-have.
 *
 * That same gap decides the guard below. A history missing entries
 * cannot be repaired within a window, because there is no way to tell a
 * gap from a period that legitimately predates the cutoff. So an
 * incomplete history ignores the window and rebuilds in full: slower
 * than asked for, but it cannot silently preserve a hole.
 *
 * @param {object[]} rebalanceEvents  Chain events; each carries the
 *   `oldTokenId` it closed and the `timestamp` it closed at.
 * @param {string[]} closedIds        Every closed NFT in the chain.
 * @param {object[]} cachedEpochs     Epochs already held.
 * @param {number} windowDays         Days back to reach; 0 = no limit.
 * @param {number} nowMs              Clock, injected for tests.
 * @returns {{ids: string[], keep: object[]}} NFTs to re-read, and the
 *   epochs to carry over untouched.
 */
function _splitByWindow(
  rebalanceEvents,
  closedIds,
  cachedEpochs,
  windowDays,
  nowMs = Date.now(),
) {
  if (windowDays <= 0) return { ids: closedIds, keep: [] };
  if (!isEpochHistoryComplete(cachedEpochs, closedIds)) {
    log.info(
      "[pnl] Re-scan window ignored — history holds %d of %d period(s); a partial set cannot tell a gap from an old period",
      cachedEpochs.length,
      closedIds.length,
    );
    return { ids: closedIds, keep: [] };
  }
  const cutoffMs = nowMs - windowDays * 24 * 60 * 60 * 1000;
  const closedAt = new Map();
  for (const e of rebalanceEvents || []) {
    /*- `timestamp` is Unix SECONDS on these events. */
    if (e.oldTokenId && typeof e.timestamp === "number")
      closedAt.set(String(e.oldTokenId), e.timestamp * 1000);
  }
  /*- An NFT with no usable close time is re-read rather than skipped:
   *  the window is an optimisation, and an unknown date must not be
   *  read as "old enough to ignore". */
  const ids = closedIds.filter((id) => {
    const ts = closedAt.get(String(id));
    return ts === undefined || ts >= cutoffMs;
  });
  const keep = cachedEpochs.filter(
    (e) => typeof e.closeTime === "number" && e.closeTime < cutoffMs,
  );
  /*- The two sides have to account for every period between them. They
   *  can disagree when an epoch's closeTime and its rebalance event's
   *  timestamp fall on opposite sides of the cutoff — minutes apart at
   *  worst, but enough to drop or duplicate a row. Rebuilding in full is
   *  the only answer that cannot corrupt the table. */
  if (ids.length + keep.length !== closedIds.length) {
    log.warn(
      "[pnl] Re-scan window ignored — %d to re-read + %d kept ≠ %d period(s); rebuilding in full",
      ids.length,
      keep.length,
      closedIds.length,
    );
    return { ids: closedIds, keep: [] };
  }
  log.info(
    "[pnl] Re-scan window: re-reading %d of %d period(s), keeping %d older than %d day(s)",
    ids.length,
    closedIds.length,
    keep.length,
    windowDays,
  );
  return { ids, keep };
}

/**
 * Record whether this position's epoch history now covers its whole chain.
 *
 * Sole owner of `_epochHistoryIncomplete`.  The rescan timer in
 * `src/bot-loop.js` reads it, and its other conditions all describe the
 * lifetime scan, so a short epoch history is retried only because of
 * this flag.  Every path that settles completeness must come through
 * here — including the ones that settle it by finding nothing to
 * reconstruct — because a flag raised by one pass and never lowered has
 * the timer running a full scan every thirty minutes for the rest of the
 * process's life.
 *
 * Tolerates a missing `botState`: the two "nothing to do" callers return
 * before anything else touches it, and a caller that omits it is asking
 * for a calculation, not for state to be kept.
 *
 * @param {object} [botState]  Live bot state.
 * @param {boolean} complete   Whether the history covers every closed NFT.
 * @returns {void}
 */
function _markHistoryComplete(botState, complete) {
  if (botState === undefined || botState === null) return;
  botState._epochHistoryIncomplete = !complete;
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
 * @param {object}   [opts.fallbackPrices]  Current prices {price0, price1}.
 * @param {() => Promise<Map<string, object>>} [opts.readChainEvents]
 *   A whole-chain read another consumer in the same pass will make anyway.
 *   When given, the closed NFTs' histories come out of it rather than a
 *   read of their own; see `_readChainHistories`.
 * @returns {Promise<number>} Number of epochs reconstructed.
 */
async function reconstructEpochs({
  pnlTracker,
  rebalanceEvents,
  botState,
  updateBotState,
  fallbackPrices,
  readChainEvents,
}) {
  /*- Nothing to reconstruct is a complete history, not a short one: the
   *  yardstick is empty, so nothing can fall short of it. Saying so
   *  matters because a position CAN arrive here with the flag already
   *  standing from an earlier pass — a cleared event cache rescanning to
   *  a smaller set reaches both of these returns — and without the
   *  clear that flag would outlive the condition that raised it. */
  if (!pnlTracker || !rebalanceEvents?.length) {
    _markHistoryComplete(botState, true);
    return 0;
  }

  /*- Computed BEFORE the guards below: it is the yardstick they measure
   *  against, so it cannot come after them. */
  const closedIds = rebalanceEvents
    .filter((e) => e.oldTokenId && e.oldTokenId !== "?" && e.newTokenId)
    .map((e) => e.oldTokenId);
  if (!closedIds.length) {
    _markHistoryComplete(botState, true);
    return 0;
  }

  const current = pnlTracker.serialize();
  const { forced, refreshPrices, windowDays } = _consumeRebuildRequest(
    botState,
    pnlTracker,
    current,
  );
  /*- Reached with a complete history when a live epoch closed and filled
   *  the last gap — no rebuild needed, but completeness still has to be
   *  recorded; see `_markHistoryComplete`. */
  if (!forced && isEpochHistoryComplete(current.closedEpochs, closedIds)) {
    _markHistoryComplete(botState, true);
    return 0;
  }

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
      _markHistoryComplete(botState, true);
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
  /*- Per-NFT resume buffer, in memory and per position.
   *
   *  Reconstructing a long chain takes hours, and every per-NFT failure
   *  in the loop below is caught and skipped, so the pass always
   *  finishes. Without somewhere to keep the NFTs already read, a
   *  failure near the end costs the whole pass and the next attempt
   *  starts from the first NFT again.
   *
   *  Holds only NFTs whose epoch actually built, so an unknown fee or a
   *  failed read leaves that NFT to be fetched again. Lives on botState
   *  rather than disk: a restart is a deliberate act and re-reading is
   *  defensible there, whereas an on-disk copy would be a second store
   *  of epoch data to keep honest. Cleared once the chain completes —
   *  see `isEpochHistoryComplete` below — because the buffer carries one
   *  reconstruction across a failure and must not answer a later one,
   *  whose chain head has moved on. */
  /*- A forced rebuild discards it first. `forced` is Reload Current
   *  Position, whose whole purpose is to re-read this chain from the
   *  chain — answering it from a buffer would hand back the very data
   *  the operator asked to replace, and Reload would appear to do
   *  nothing. The same reasoning as `_consumeRebuildRequest` emptying
   *  the tracker: a rebuild must start with nothing to inherit. */
  if (forced) botState._epochResumeBuffer = null;
  botState._epochResumeBuffer =
    botState._epochResumeBuffer instanceof Map
      ? botState._epochResumeBuffer
      : new Map();
  const closedEpochs = await _rebuildClosedEpochs({
    botState,
    closedIds,
    rebalanceEvents,
    cachedEpochs: current.closedEpochs,
    fallbackPrices,
    readChainEvents,
    refreshPrices,
    windowDays,
    onProgress: _progress,
  });
  /*- Short history flags itself for another go.
   *
   *  The entry guard above rebuilds whenever reconstruction next runs,
   *  but it cannot cause a run. The rescan timer in `src/bot-loop.js`
   *  decides that, and its other conditions all describe the LIFETIME
   *  scan — so without this flag a short history is retried only when
   *  that scan fails too. An outage clearing between the two passes
   *  would leave the epochs short, the lifetime scan green, and the
   *  understated figures standing until the next restart. */
  const complete = isEpochHistoryComplete(closedEpochs, closedIds);
  _markHistoryComplete(botState, complete);
  if (complete) botState._epochResumeBuffer = null;
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
  _splitByWindow, // exported for tests
  _rebuildClosedEpochs, // exported for tests
  _hasValidTimestamps,
  _assembleEpoch,
  _fetchEpochsFromChain,
};
