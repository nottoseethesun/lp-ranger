/**
 * @file src/bot/position-views.js
 * @module position-views
 * @description
 * What the bot reads from the chain for a position the dashboard shows:
 * an unmanaged position's quick details and lifetime figures, and a
 * closed position's history. The details and lifetime figures return a
 * result the server answers with (src/server/bot-result.js); the history
 * is the record itself.
 *
 * The bot's own: the server reaches it only through the bot's interface
 * (src/bot/bot-interface.js).
 */

"use strict";

const ethers = require("ethers");
const { log } = require("../lib/log");
const config = require("../lib/config");
const { emojiId } = require("./logger");
const sendTx = require("./send-transaction");
const { compositeKey } = require("../lib/bot-config-v2");
const { resolveLiveKey } = require("./server-key-resolver");
const { getPositionHistory } = require("./position-history");
const {
  computeQuickDetails: _defaultComputeQuickDetails,
  computeLifetimeDetails: _defaultComputeLifetimeDetails,
} = require("./position-details");

/** Whether a details request names its position fully. */
function _namesPosition(body) {
  return !!(body.tokenId && body.token0 && body.token1 && body.fee);
}

/**
 * Create the position views.
 * @param {object} deps
 * @param {object} deps.diskConfig  The loaded bot-config.json.
 * @param {object} deps.positionMgr  For resolving a key a rebalance moved.
 * @param {object} deps.walletManager  The loaded wallet.
 * @param {Function} deps.getPrivateKey  The key the bot signs with, or null.
 * @param {Function} deps.getAllPositionBotStates  Per-position bot states.
 * @param {Function} [deps.computeQuickDetails]  Overridable from tests so
 *   they need not exercise a real RPC.
 * @param {Function} [deps.computeLifetimeDetails]  Likewise.
 * @returns {{positionDetails: Function, positionLifetime: Function,
 *   positionHistory: Function}}
 */
function createPositionViews(deps) {
  const {
    diskConfig,
    positionMgr,
    walletManager,
    getPrivateKey,
    getAllPositionBotStates,
    computeQuickDetails = _defaultComputeQuickDetails,
    computeLifetimeDetails = _defaultComputeLifetimeDetails,
  } = deps;

  /** The request's wallet and position manager, else this bot's. */
  function _fillOwner(body) {
    body.walletAddress = body.walletAddress || walletManager.getAddress() || "";
    body.contractAddress = body.contractAddress || config.POSITION_MANAGER;
  }

  /**
   * An unmanaged position's quick details.
   * @param {object} body  `tokenId`, `token0`, `token1`, `fee`, and
   *   optionally `walletAddress` and `contractAddress`.
   * @returns {Promise<object>}  The result (src/server/bot-result.js).
   */
  async function positionDetails(body) {
    if (!_namesPosition(body))
      return {
        ok: false,
        reason: "invalid",
        error: "Missing tokenId, token0, token1, or fee",
      };
    log.info(
      "[bot] Position selected: NFT #%s %s",
      body.tokenId,
      emojiId(String(body.tokenId)),
    );
    try {
      const prov = sendTx.getManagedReadProvider();
      _fillOwner(body);
      return await computeQuickDetails(
        prov,
        ethers,
        body,
        diskConfig,
        getPrivateKey(),
      );
    } catch (err) {
      log.error("[bot] Position details error:", err.message);
      return { ok: false, reason: "failed", error: err.message };
    }
  }

  /** Sync lifetime result into the position's bot state for poll access. */
  function _syncLifetimeState(pk, result) {
    if (!pk) return;
    const states = getAllPositionBotStates();
    const s = states.get(pk) || {};
    // For managed positions the bot loop owns the sync flag — setting it
    // here would cause a "Done Syncing" → "Syncing…" flash when the bot's
    // own scan starts moments later.
    const isManaged = diskConfig.positions[pk]?.status === "running";
    if (!isManaged) s.rebalanceScanComplete = true;
    /*-
     *  The snapshot belongs to the bot's loop on a managed position, and
     *  these details can still be asked for one: the dashboard suppresses
     *  its fetch only once a poll has landed, so a page load fires it
     *  before the first poll. What is built here covers what an UNMANAGED
     *  position shows — the Current panel's two figures — and writing it
     *  over the bot's would drop the Lifetime panel's figures until the
     *  next poll rebuilt them, which is one `CHECK_INTERVAL_SEC` away.
     */
    const snapshot = result.pnlSnapshot;
    if (!isManaged && snapshot !== undefined && snapshot !== null)
      s.pnlSnapshot = snapshot;
    if (result.entryValue) s.entryValue = result.entryValue;
    const bl = diskConfig.positions[pk]?.hodlBaseline;
    if (bl) s.hodlBaseline = bl;
    if (!states.has(pk)) states.set(pk, s);
    /*- Note: `lifetimeScanComplete` is intentionally NOT set here.
     *  Unmanaged positions don't render a Lifetime panel (the placeholder
     *  "Click Manage to get reporting of Lifetime values." takes its
     *  place), so the flag is structurally irrelevant on their state.
     *  The dashboard's `_syncStatus` gates on the flag only when the
     *  active position is managed. */
    const _sn = s.pnlSnapshot;
    log.info(
      "[bot] _syncLifetimeState %s: curFees=%s gas=%s comp=%s residual=%s entry=%s bl=%s",
      pk.split("-").pop(),
      _sn?.currentFeesUsd,
      _sn?.totalGas,
      _sn?.totalCompoundedUsd,
      _sn?.residualValueUsd,
      s.entryValue || "none",
      !!s.hodlBaseline,
    );
  }

  /** Start the rebalance history scan of a managed position, if one runs. */
  function _triggerManagedScan(tokenId) {
    for (const [, bs] of getAllPositionBotStates()) {
      const ap = bs.activePosition;
      if (ap && String(ap.tokenId) === String(tokenId) && bs._triggerScan) {
        bs._triggerScan();
        return;
      }
    }
  }

  /**
   * A position's lifetime figures, read from the chain.
   * @param {object} body  As for `positionDetails`.
   * @returns {Promise<object>}  The result (src/server/bot-result.js).
   */
  async function positionLifetime(body) {
    if (!_namesPosition(body))
      return { ok: false, reason: "invalid", error: "Missing fields" };
    try {
      // Trigger lazy rebalance history scan
      // for managed positions (fire-and-forget)
      _triggerManagedScan(body.tokenId);
      const prov = sendTx.getManagedReadProvider();
      _fillOwner(body);
      const result = await computeLifetimeDetails(
        prov,
        ethers,
        body,
        diskConfig,
      );
      // Mark scan complete in the position's state so the poll cycle
      // reports it — same path as managed positions.  This is the ONLY
      // way the dashboard detects "Synced" (no separate client flag).
      const pk = compositeKey(
        config.CHAIN_NAME,
        body.walletAddress,
        body.contractAddress,
        body.tokenId,
      );
      /*- Resolve to the LIVE composite key.  computeLifetimeDetails
       *  awaits multi-second on-chain event scans; during that window
       *  a parallel rebalance can migrate the key, leaving the stale
       *  `pk` pointing at a dead tokenId.  _syncLifetimeState would
       *  then create or update a phantom bot-state entry under that
       *  stale key (because `if (!states.has(pk)) states.set(pk, s)`
       *  inside it creates the entry on first access). */
      const livePk = resolveLiveKey(positionMgr, pk, (k) =>
        getAllPositionBotStates().get(k),
      );
      _syncLifetimeState(livePk, result);
      return result;
    } catch (err) {
      log.error("[bot] Lifetime details error:", err.message);
      return { ok: false, reason: "failed", error: err.message };
    }
  }

  /**
   * A closed position's history, from the rebalance log, the scanned
   * events and the chain, with the running position's events when it is
   * the active one of a bot loop.
   * @param {string} tokenId
   * @returns {Promise<object>}  The history record.
   */
  async function positionHistory(tokenId) {
    let posState = null;
    for (const [, s] of getAllPositionBotStates()) {
      if (s.activePosition && String(s.activePosition.tokenId) === tokenId) {
        posState = s;
        break;
      }
    }
    return getPositionHistory(tokenId, {
      rebalanceEvents: posState?.rebalanceEvents,
      activePosition: posState?.activePosition,
    });
  }

  return { positionDetails, positionLifetime, positionHistory };
}

module.exports = { createPositionViews };
