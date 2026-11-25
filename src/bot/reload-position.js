/**
 * @file src/bot/reload-position.js
 * @module reload-position
 * @description
 * Reload Current Position (`POST /api/position/reload`), the Settings
 * action, the bot's part.  Wipes every on-chain-derived value for
 * the target position (compounded totals, HODL baseline, deposits, gas
 * per-NFT map, cached epochs, cached event log) and re-fires the
 * initial scan from pool creation, which rebuilds them all and the
 * Activity Log's records with them.  The compound list is the one
 * exception to the wipe: the scan replaces it whole, keeping what the
 * bot recorded live in it (see `CHAIN_DERIVED_POSITION_KEYS`).
 *
 * Fire-and-forget: it returns as soon as the reset is complete and the
 * scan is kicked off.  The dashboard then polls `/api/status` for
 * `lifetimeScanComplete=true` before reloading the page.  This avoids
 * holding an HTTP connection open for the full scan duration (which can
 * be several hours on a Pi-class RPC).  The server answers with what it
 * returns (src/server/bot-result.js).
 *
 * Reserved for that flow: only the Reload Current Position route asks
 * for it, through the bot's interface (src/bot/bot-interface.js). No bot
 * loop calls it.
 */

"use strict";

const { log } = require("../lib/log");
const config = require("../lib/config");
const { saveConfig, getPositionConfig } = require("../lib/bot-config-v2");
const { parseCompositeKey } = require("../lib/composite-key");
const { CHAIN_DERIVED_POSITION_KEYS } = require("../lib/bot-config-keys");
const _epochCache = require("./epoch-cache");
const { cancelPoolScan, clearPoolCache } = require("./pool-scanner");
const { resolveLiveKey } = require("./server-key-resolver");
const { logCtx } = require("./logger");
const { getTokenSymbol } = require("../lib/token-symbol-cache");
const {
  isAscanRunningOnThisPosition,
  isAcoinMoveUnderWayOnThisPosition,
} = require("./scan-state");
const { isStopping } = require("./app-phase");

/*- The words a Reload Current Position or Re-scan Prices is refused with
 *  while a coin move is under way on the position, the user's (2026-10-23). */
const _COIN_MOVE_UNDER_WAY =
  "A coin move (rebalance or compound) for this position has already started. Try again once it's complete.";

/*- Bot-state fields to reset so the fresh scan's persist-conditions all
 *  re-evaluate as "no data on disk" and the readiness gates re-engage. */
function _resetBotState(state) {
  state._catastrophicScanError = null;
  state._lifetimeScanError = null;
  state._lifetimeScanErrorAt = null;
  state._needsFullRescan = true;
  /*- Reload rebuilds every stored figure, and every one of them is an
   *  amount times a price — so asking for fresh prices is what this action
   *  already meant; it simply never said so. Raised explicitly because one
   *  figure reads it rather than the flag above: the first deposit's
   *  leftover, which is written once and returned ever after, and so is
   *  the only stored value a scan would otherwise leave untouched.
   *
   *  Deliberately not folded into `_needsFullRescan`. A rebalance raises
   *  that one too, and it must — a new NFT means the saved figures no
   *  longer describe the chain. But a rebalance is not an operator saying
   *  a price is wrong, and the prices this unlocks are cached with no
   *  expiry because they cannot change. */
  state._needsPriceRevalue = true;
  /*- Force epoch reconstruction to rebuild from chain instead of
   *  trusting what the tracker already holds.  Clearing the cache
   *  entry above is not enough on its own: the bot loop keeps its
   *  epochs in memory, so the completeness guard in
   *  `reconstructEpochs` saw a full history and returned before doing
   *  any work.  Consumed there — see `_consumeRebuildRequest`. */
  state._needsEpochRebuild = true;
  state.lifetimeScanComplete = false;
  state.rebalanceScanComplete = false;
  state.totalLifetimeDepositUsd = 0;
  state.depositUsedFallback = false;
  /*-
   *  `compoundHistory` stays: the rebuild replaces it whole, keeping the
   *  Auto or Manual and the Activity Log figures the bot recorded in it
   *  when each compound happened, and needs the old list to find them.
   *  Clearing the compounded totals below is what starts that rebuild.
   */
  /*- Null, not zero. `hasCompoundedTotal` reads these by presence, so a
   *  zero here would claim the chain had been classified and found
   *  nothing — the opposite of what a reload is asking for. Null matches
   *  what `_clearDiskConfigForKey` does to the same keys on disk. */
  state.compoundedAmount0 = null;
  state.compoundedAmount1 = null;
  state.nftCompoundedAmountsByTokenId = {};
  state.nftGasWeiByTokenId = {};
  state.hodlBaseline = null;
  state.lifetimeHodlAmounts = null;
  /*-
   *  The deposit count's own state goes with the results it adds to
   *  (src/bot/deposit-count.js): a poll's interim count, and the wallet's
   *  coins as the last poll saw them, so the first poll after the
   *  rebuild counts the deposits since the current NFT's mint again.
   */
  state._depositOverlay = null;
  state._depositWalletSeen = null;
}

/*- Wipe on-chain-derived keys in the SHARED in-memory `diskConfig`
 *  reference — the same object the bot loop reads via
 *  `readConfigValue(diskConfig, key, ...)`.  Loading a fresh copy from
 *  disk here would leave the shared reference stale and
 *  `_resolveDiskState` in bot-recorder-lifetime.js would keep seeing
 *  the old compounded coins, gating `_classifyAllCompounds` off and
 *  silently skipping the chain-wide rescan — exactly the July-2026
 *  reload-no-op bug. */
function _clearDiskConfigForKey(diskConfig, positionKey) {
  const posCfg = getPositionConfig(diskConfig, positionKey);
  if (!posCfg) return false;
  for (const k of CHAIN_DERIVED_POSITION_KEYS) {
    if (k in posCfg) delete posCfg[k];
  }
  saveConfig(diskConfig);
  return true;
}

/**
 * Build the pool-identity key opts for the epoch-cache clear: the same
 * fields every writer of that cache passes. The epoch cache supplies
 * the active chain itself, so the clear lands on the entry the writers
 * made, whichever chain this server runs.
 */
function _cacheKeyOpts(position, wallet) {
  return {
    contract: config.POSITION_MANAGER,
    wallet,
    token0: position.token0,
    token1: position.token1,
    fee: position.fee,
  };
}

/**
 * Validate the request's positionKey and split it into its raw text and
 * its parts. On any validation failure the answer is a refusal,
 * `invalid`, for the caller to return as it is.
 * @param {object} body  The request body, naming `positionKey`.
 * @returns {{rawKey: string, parsed: object}|{refusal: object}}
 */
function _validateKey(body) {
  const rawKey = body && body.positionKey;
  if (!rawKey || typeof rawKey !== "string") {
    return {
      refusal: { ok: false, reason: "invalid", error: "positionKey required" },
    };
  }
  const parsed = parseCompositeKey(rawKey);
  if (!parsed) {
    return {
      refusal: { ok: false, reason: "invalid", error: "invalid positionKey" },
    };
  }
  return { rawKey, parsed };
}

/**
 * Resolve the live bot state and the pool identity for `rawKey`. The pool
 * identity (token0/token1/fee) is read from `state.activePosition`, the
 * summary `bot-recorder._activePosSummary` publishes to the state map
 * (`emit({activePosition: ...})`) every poll cycle. It is deliberately
 * not read from `positionMgr.get(liveKey)`: that entry carries only the
 * loop's own fields (`key`, `tokenId`, `status`, `handle`, `starting`),
 * no pool identity, and would produce a false `missing`.
 * @param {string} rawKey  The position's composite key, as asked.
 * @param {Map<string, object>} states  The per-position bot states.
 * @param {object} positionMgr  The position manager, which resolves a
 *   key a rebalance moved.
 * @returns {{liveKey: string, state: object, position: object}
 *   |{refusal: object}}  The refusal, `missing`, when the position cannot
 *   be resolved.
 */
function _resolveStateAndPosition(rawKey, states, positionMgr) {
  const liveKey = resolveLiveKey(positionMgr, rawKey, (k) => states.get(k));
  const state = states.get(liveKey);
  const position = state?.activePosition || null;
  if (!position || !position.token0 || !position.token1 || !position.fee) {
    return {
      refusal: {
        ok: false,
        reason: "missing",
        error: "position not resolvable (token0/token1/fee unknown)",
      },
    };
  }
  return { liveKey, state, position };
}

/**
 * Shared in-flight guard for the reset operations: it refuses a position
 * that is mid-scan or has a coin move under way. Every in-progress
 * condition is `refused`, with an `error` code the client can tell apart
 * and a user-facing `message` it shows; null when the position is idle.
 *
 * The words are parameterised because Re-scan Prices (`rescan-prices.js`)
 * shares this guard and names its own feature and duration; the defaults
 * are Reload's.
 *
 * @param {object} state  Per-position bot state.
 * @param {object} [copy] `{ action, scanExtra }` overrides.
 * @returns {object|null}  The refusal, or null.
 */
function _checkInProgress(state, copy = {}) {
  const action = copy.action || "Reload Current Position";
  const scanExtra =
    copy.scanExtra === undefined
      ? " The scan can take up to four hours."
      : copy.scanExtra;
  if (!state) return null;
  /*- A stop the server holds until nothing is under way
   *  (src/server/stop-when-all-clear.js) waits for the scans running; one
   *  started now would be cut off, or hold the stop for its length. */
  if (isStopping()) {
    return {
      ok: false,
      reason: "refused",
      error: "server-stopping",
      message: `The server is stopping: ${action} is not available until it starts again.`,
    };
  }
  if (isAscanRunningOnThisPosition(state)) {
    return {
      ok: false,
      reason: "refused",
      error: "scan-in-progress",
      message:
        "A full lifetime scan is already running for this position." +
        ` Wait for it to finish before starting a new ${action}.` +
        scanExtra,
    };
  }
  /*- From the first gate of a rebalance or compound to its end, and
   *  while a Rebalance Now or Compound Now waits to be made: a reset
   *  then would clear what the move is about to read (src/bot/scan-state.js). */
  if (isAcoinMoveUnderWayOnThisPosition(state)) {
    return {
      ok: false,
      reason: "refused",
      error: "coin-move-under-way",
      message: _COIN_MOVE_UNDER_WAY,
    };
  }
  return null;
}

/*- Wipe the on-chain-derived data for the position and trigger the
 *  fresh scan.  Deliberately SYNCHRONOUS — no `await` in the body so
 *  no other bot poll cycle can slip in a rebalance / compound between
 *  the guards passing and the scan engaging.  The rebalance race
 *  window that existed with the earlier awaited version is closed by
 *  this: an async function's body runs to its first `await`
 *  synchronously with the caller, so calling `state._triggerScan()`
 *  (an async fn) here starts the scan BEFORE the endpoint returns 200
 *  (`isAscanRunningOnThisPosition`, src/bot/scan-state.js), and the
 *  rebalance/compound gates in bot-cycle engage before any subsequent
 *  poll can land.  The guard has just refused a position with a coin
 *  move under way (`isAcoinMoveUnderWayOnThisPosition`), so no move
 *  holds the scan back.
 *
 *  `clearPoolCache` and the scan promise are both fire-and-forget:
 *  the scan re-queries chain events from pool creation regardless of
 *  the cache state, and any cache-clear write failure is non-fatal
 *  (the next scan on the next boot would clear anyway). */
function _performReset(diskConfig, liveKey, state, position, wallet) {
  cancelPoolScan(position.token0, position.token1, position.fee, wallet);
  _clearDiskConfigForKey(diskConfig, liveKey);
  _epochCache.clearCacheEntry(_cacheKeyOpts(position, wallet));
  if (state) _resetBotState(state);
  /*- Fire-and-forget event-cache wipe.  Safe to run concurrently with
   *  the scan: on-chain Transfer events are immutable, so a partial
   *  overlap only affects the LP performance cache, never correctness. */
  clearPoolCache(position, wallet).catch((err) => {
    log.warn("[bot] clearPoolCache failed (non-fatal): %s", err.message);
  });
  /*- Starts the scan synchronously (before the first `await` in the
   *  trigger's body), engaging the rebalance/compound gates immediately
   *  (src/bot/scan-state.js).  The returned promise is
   *  deliberately not awaited — the scan runs for minutes to hours and
   *  the HTTP response must not block on it. */
  if (state && typeof state._triggerScan === "function") {
    state._triggerScan().catch((err) => {
      log.warn("[bot] Reload scan trigger failed: %s", err.message);
    });
  }
}

/**
 * Create Reload Current Position.
 * @param {object} deps
 * @param {Function} deps.getAllPositionBotStates
 * @param {object} deps.positionMgr  Position manager (getPosition, key resolution).
 * @param {object} deps.walletManager
 * @param {object} deps.diskConfig   Shared in-memory disk config reference
 *   (the same object the rest of the bot, its loops included, reads
 *   through `readConfigValue`).  Must be mutated in place, not reloaded from
 *   disk — see `_clearDiskConfigForKey`'s header comment.
 * @returns {(body: object) => object}  Reloads the position the request's
 *   `positionKey` names, and returns the result.
 */
function createReloadPosition(deps) {
  const { getAllPositionBotStates, positionMgr, walletManager, diskConfig } =
    deps;

  return function reloadPosition(body) {
    const v = _validateKey(body);
    if (v.refusal) return v.refusal;
    const wallet = v.parsed.wallet || walletManager.getAddress() || "";
    const states = getAllPositionBotStates();
    const r = _resolveStateAndPosition(v.rawKey, states, positionMgr);
    if (r.refusal) return r.refusal;
    const guard = _checkInProgress(r.state);
    if (guard) return guard;
    log.info(
      "[bot] [reload] %s: reset + trigger requested",
      logCtx({
        chain: config.CHAIN_NAME,
        wallet,
        factory: config.POSITION_MANAGER,
        tokenId: r.position.tokenId,
        symbol0: getTokenSymbol(r.position.token0),
        symbol1: getTokenSymbol(r.position.token1),
      }),
    );
    _performReset(diskConfig, r.liveKey, r.state, r.position, wallet);
    return { ok: true, message: "Reload started", liveKey: r.liveKey };
  };
}

module.exports = {
  createReloadPosition,
  _resetBotState, // exported for tests
  /*-
   *  Shared with rescan-prices.js, which performs the same
   *  key validation, position resolution and in-flight guarding
   *  before a narrower reset.  Exported rather than duplicated.
   */
  _validateKey,
  _resolveStateAndPosition,
  _checkInProgress,
};
