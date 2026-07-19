/**
 * @file src/server-reload-position.js
 * @module server-reload-position
 * @description
 * Handler for `POST /api/position/reload` — the "Reload Current
 * Position" Settings action.  Wipes every on-chain-derived value for
 * the target position (compound history, HODL baseline, deposits, gas
 * per-NFT map, cached epochs, cached event log) and re-fires the
 * initial scan from pool creation.  Extracted from `server-scan.js`
 * to keep that file under the 500-line cap.
 *
 * Fire-and-forget: the endpoint returns as soon as the reset is
 * complete and the scan is kicked off.  The dashboard then polls
 * `/api/status` for `lifetimeScanComplete=true` before reloading the
 * page.  This avoids holding an HTTP connection open for the full
 * scan duration (which can be several hours on a Pi-class RPC).
 *
 * Reserved for the escape-hatch flow.  Not called by any bot code path.
 */

"use strict";

const { log } = require("./log");
const config = require("./config");
const {
  saveConfig,
  getPositionConfig,
  parseCompositeKey,
} = require("./bot-config-v2");
const _epochCache = require("./epoch-cache");
const { cancelPoolScan, clearPoolCache } = require("./pool-scanner");
const { resolveLiveKey } = require("./server-key-resolver");
const { logCtx } = require("./logger");
const { getTokenSymbol } = require("./server-scan");

/*- Config keys that hold on-chain-derived values for a single position.
 *  These are wiped on reload so the fresh scan is authoritative and no
 *  stale figure survives to compete with it. */
const _ON_CHAIN_DERIVED_KEYS = [
  "compoundHistory",
  "totalCompoundedUsd",
  "collectedFeesUsd",
  "nftCompoundedUsdByTokenId",
  "nftGasWeiByTokenId",
  "hodlBaseline",
  "lifetimeHodlAmounts",
  "totalLifetimeDepositUsd",
];

/*- Bot-state fields to reset so the fresh scan's persist-conditions all
 *  re-evaluate as "no data on disk" and the readiness gates re-engage. */
function _resetBotState(state) {
  state._catastrophicScanError = null;
  state._lifetimeScanError = null;
  state._lifetimeScanErrorAt = null;
  state._needsFullRescan = true;
  state.lifetimeScanComplete = false;
  state.rebalanceScanComplete = false;
  state.totalLifetimeDepositUsd = 0;
  state.compoundHistory = [];
  state.totalCompoundedUsd = 0;
  state.collectedFeesUsd = 0;
  state.nftCompoundedUsdByTokenId = {};
  state.nftGasWeiByTokenId = {};
  state.hodlBaseline = null;
  state.lifetimeHodlAmounts = null;
}

/*- Wipe on-chain-derived keys in the SHARED in-memory `diskConfig`
 *  reference — the same object the bot loop reads via
 *  `readConfigValue(diskConfig, key, ...)`.  Loading a fresh copy from
 *  disk here would leave the shared reference stale and
 *  `_resolveDiskState` in bot-recorder-lifetime.js would keep seeing
 *  the old `compoundHistory` / `totalCompoundedUsd`, gating
 *  `_classifyAllCompounds` off and silently skipping the chain-wide
 *  rescan — exactly the July-2026 reload-no-op bug. */
function _clearDiskConfigForKey(diskConfig, positionKey) {
  const posCfg = getPositionConfig(diskConfig, positionKey);
  if (!posCfg) return false;
  for (const k of _ON_CHAIN_DERIVED_KEYS) {
    if (k in posCfg) delete posCfg[k];
  }
  saveConfig(diskConfig);
  return true;
}

/** Build the pool-identity key opts for cache clears. */
function _cacheKeyOpts(position, wallet) {
  return {
    blockchain: "pulsechain",
    contract: config.POSITION_MANAGER,
    wallet,
    token0: position.token0,
    token1: position.token1,
    fee: position.fee,
  };
}

/*- Validate the request body's positionKey and split it into
 *  {rawKey, parsed}.  Returns { error: {code, message} } on any
 *  validation failure so the caller can early-return a 400. */
function _validateKey(body) {
  const rawKey = body && body.positionKey;
  if (!rawKey || typeof rawKey !== "string") {
    return {
      error: { code: 400, body: { ok: false, error: "positionKey required" } },
    };
  }
  const parsed = parseCompositeKey(rawKey);
  if (!parsed) {
    return {
      error: { code: 400, body: { ok: false, error: "invalid positionKey" } },
    };
  }
  return { rawKey, parsed };
}

/*- Resolve the live bot state + the pool identity for `rawKey`.
 *  Pool identity (token0/token1/fee) is read from `state.activePosition`
 *  — the summary object `bot-recorder._activePosSummary` publishes to
 *  the state map via `emit({activePosition: ...})` every poll cycle.
 *  We deliberately do NOT read `positionMgr.get(liveKey)` for the
 *  fields — that manager entry carries only `{key, tokenId, status}`
 *  and would produce a false-negative 404.  Returns { error } on 404. */
function _resolveStateAndPosition(rawKey, states, positionMgr) {
  const liveKey = resolveLiveKey(positionMgr, rawKey, (k) => states.get(k));
  const state = states.get(liveKey);
  const position = state?.activePosition || null;
  if (!position || !position.token0 || !position.token1 || !position.fee) {
    return {
      error: {
        code: 404,
        body: {
          ok: false,
          error: "position not resolvable (token0/token1/fee unknown)",
        },
      },
    };
  }
  return { liveKey, state, position };
}

/*- Guard against reloading a position that is mid-scan, mid-rebalance,
 *  or mid-compound.  Every in-progress condition returns 409 with a
 *  user-facing `message` the client surfaces in the yellow retry
 *  modal.  Returns null when the position is idle. */
function _checkInProgress(state) {
  if (!state) return null;
  if (state._scanRunning) {
    return {
      code: 409,
      body: {
        ok: false,
        error: "scan-in-progress",
        message:
          "A full lifetime scan is already running for this position. Wait for it to finish before starting a new Reload Current Position. The scan can take up to four hours.",
      },
    };
  }
  if (state.rebalanceInProgress) {
    return {
      code: 409,
      body: {
        ok: false,
        error: "rebalance-in-progress",
        message:
          "Cannot reload this position: it is currently rebalancing. Wait for the rebalance to finish and try again.",
      },
    };
  }
  if (state.compoundInProgress) {
    return {
      code: 409,
      body: {
        ok: false,
        error: "compound-in-progress",
        message:
          "Cannot reload this position: it is currently compounding. Wait for the compound to finish and try again.",
      },
    };
  }
  return null;
}

/*- Wipe the on-chain-derived data for the position and trigger the
 *  fresh scan.  Deliberately SYNCHRONOUS — no `await` in the body so
 *  no other bot poll cycle can slip in a rebalance / compound between
 *  the guards passing and `_scanRunning` engaging.  The rebalance
 *  race window that existed with the earlier awaited version is
 *  closed by this: an async function's body runs to its first
 *  `await` synchronously with the caller, so calling
 *  `state._triggerScan()` (an async fn) here sets `_scanRunning=true`
 *  BEFORE the endpoint returns 200, and the rebalance/compound gates
 *  in bot-cycle engage before any subsequent poll can land.
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
    log.warn("[server] clearPoolCache failed (non-fatal): %s", err.message);
  });
  /*- Sets `_scanRunning=true` synchronously (before the first `await`
   *  in the trigger's body), engaging the rebalance/compound gates
   *  immediately.  The returned promise is deliberately not awaited —
   *  the scan runs for minutes to hours and the HTTP response must
   *  not block on it. */
  if (state && typeof state._triggerScan === "function") {
    state._triggerScan().catch((err) => {
      log.warn("[server] Reload scan trigger failed: %s", err.message);
    });
  }
}

/**
 * Create the `POST /api/position/reload` handler.
 * @param {object} deps
 * @param {Function} deps.jsonResponse
 * @param {Function} deps.readJsonBody
 * @param {Function} deps.getAllPositionBotStates
 * @param {object} deps.positionMgr  Position manager (getPosition, key resolution).
 * @param {object} deps.walletManager
 * @param {object} deps.diskConfig   Shared in-memory disk config reference
 *   (same object every other server route + the bot loop reads through
 *   `readConfigValue`).  Must be mutated in place, not reloaded from
 *   disk — see `_clearDiskConfigForKey`'s header comment.
 * @returns {Function}
 */
function createReloadPositionHandler(deps) {
  const {
    jsonResponse,
    readJsonBody,
    getAllPositionBotStates,
    positionMgr,
    walletManager,
    diskConfig,
  } = deps;

  return async function _handlePositionReload(req, res) {
    const body = await readJsonBody(req);
    const v = _validateKey(body);
    if (v.error) return jsonResponse(res, v.error.code, v.error.body);
    const wallet = v.parsed.wallet || walletManager.getAddress() || "";
    const states = getAllPositionBotStates();
    const r = _resolveStateAndPosition(v.rawKey, states, positionMgr);
    if (r.error) return jsonResponse(res, r.error.code, r.error.body);
    const guard = _checkInProgress(r.state);
    if (guard) return jsonResponse(res, guard.code, guard.body);
    log.info(
      "[server] [reload] %s: reset + trigger requested",
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
    return jsonResponse(res, 200, {
      ok: true,
      message: "Reload started",
      liveKey: r.liveKey,
    });
  };
}

module.exports = {
  createReloadPositionHandler,
  _ON_CHAIN_DERIVED_KEYS, // exported for tests
  _resetBotState, // exported for tests
};
