/**
 * @file src/server-key-resolver.js
 * @module server-key-resolver
 * @description
 * Pure helpers for resolving a possibly-stale composite key (captured
 * by an async request handler at entry time) to the live key currently
 * in use by `positionMgr`, after one or more key migrations may have
 * occurred during the handler's awaits.
 *
 * **Adds zero state.**  Reads existing structures only:
 *   - `positionMgr.get` / `positionMgr.getAll` (already exists).
 *   - The bot state object's `rebalanceEvents` array (already
 *     maintained by the bot loop; preserved across migrations because
 *     `updatePositionState` re-keys the state object under the new
 *     key without copying the events).
 *
 * Callers: every request handler that captures a composite key from
 * the request body and writes to disk after a long await — see
 * `handleRemove`, `_handleApiConfig`, `_handlePositionLifetime`,
 * `_handlePositionScanCancel`.  `handleManage` does NOT use this
 * because it has its own `keyRef.current` already in scope (the
 * single-callback pattern wired at startBotLoop).
 */

"use strict";

const { parseCompositeKey } = require("./bot-config-v2");

/**
 * Map an `originalKey` (possibly captured before a key migration) to
 * the live current key in `positionMgr`.
 *
 * Returns:
 *   - `direct.key` when `positionMgr` has an entry under `originalKey`
 *     (the fast/common path).  Note that `entry.key` always reflects
 *     the post-migration key because `positionMgr.migrateKey` mutates
 *     the entry object in place.
 *   - The migrated key when a same-blockchain/wallet/contract entry
 *     exists under a different tokenId AND its bot state's
 *     `rebalanceEvents` show a chain from `originalKey`'s tokenId.
 *     Supports multi-hop migrations because the bot state's events
 *     array is preserved across all rekey hops.
 *   - `originalKey` unchanged when no live match is found (the
 *     position is stopped, or never existed) — callers should treat
 *     the result as authoritative and 404 if disk lookup fails.
 *
 * @param {object}  positionMgr  Must expose `get(key)` and `getAll()`.
 * @param {string}  originalKey  Composite key captured pre-await.
 * @param {Function} [getBotState]  Optional `(key) => state|undefined`
 *   accessor used to read the bot state's `rebalanceEvents` for the
 *   multi-hop migration chain.  When omitted, only the fast path runs.
 * @returns {string}  Live composite key (post-migration), or
 *   originalKey if no live match.
 */
function resolveLiveKey(positionMgr, originalKey, getBotState) {
  if (!positionMgr || !originalKey) return originalKey;
  const direct = positionMgr.get(originalKey);
  if (direct) return direct.key;
  let parsed;
  try {
    parsed = parseCompositeKey(originalKey);
  } catch {
    return originalKey;
  }
  if (typeof positionMgr.getAll !== "function") return originalKey;
  for (const e of positionMgr.getAll()) {
    if (String(e.tokenId) === String(parsed.tokenId)) continue;
    let eParsed;
    try {
      eParsed = parseCompositeKey(e.key);
    } catch {
      continue;
    }
    if (
      eParsed.blockchain !== parsed.blockchain ||
      eParsed.wallet !== parsed.wallet ||
      eParsed.contract !== parsed.contract
    )
      continue;
    if (wasMigratedFrom(e.key, parsed.tokenId, getBotState)) return e.key;
  }
  return originalKey;
}

/**
 * True when the bot state at `currentKey` has a `rebalanceEvents`
 * entry whose `oldTokenId` matches `oldTokenId` — i.e., this position
 * was migrated FROM that tokenId (possibly via a chain of rebalances).
 *
 * @param {string}   currentKey
 * @param {string}   oldTokenId
 * @param {Function} [getBotState]
 * @returns {boolean}
 */
function wasMigratedFrom(currentKey, oldTokenId, getBotState) {
  if (typeof getBotState !== "function") return false;
  const state = getBotState(currentKey);
  if (!state || !Array.isArray(state.rebalanceEvents)) return false;
  const needle = String(oldTokenId);
  return state.rebalanceEvents.some(
    (ev) => ev && String(ev.oldTokenId) === needle,
  );
}

module.exports = { resolveLiveKey, wasMigratedFrom };
