/**
 * @file dashboard-data-cache.js
 * @description Rebalance event localStorage cache and config input dirty-flag
 *   management. Extracted from dashboard-data.js for line-count compliance.
 */

import { compositeKey } from "./dashboard-helpers.js";
import { posStore } from "./dashboard-positions-store.js";

// ── Rebalance event cache ────────────────────────────────────────────────────

const _REB_CACHE_KEY = "9mm_rebalance_events_cache";

function _rebPosKey() {
  const a = posStore.getActive();
  return a?.walletAddress && a?.contractAddress
    ? compositeKey("pulsechain", a.walletAddress, a.contractAddress, a.tokenId)
    : null;
}

export function cacheRebalanceEvents(events) {
  const pk = _rebPosKey();
  if (!pk) return;
  try {
    const r = localStorage.getItem(_REB_CACHE_KEY);
    const c = r ? JSON.parse(r) : {};
    c[pk] = events;
    localStorage.setItem(_REB_CACHE_KEY, JSON.stringify(c));
  } catch {
    /* */
  }
}

export function loadCachedRebalanceEvents() {
  const pk = _rebPosKey();
  if (!pk) return null;
  try {
    const r = localStorage.getItem(_REB_CACHE_KEY);
    const e = r ? JSON.parse(r)[pk] : null;
    return Array.isArray(e) ? e : null;
  } catch {
    return null;
  }
}

// ── Config input dirty-flag cache ────────────────────────────────────────────

/**
 * Dirty-flag cache for form inputs being edited by the user.
 * Key: fully-qualified string (blockchain-wallet-contract-tokenId-elementId).
 * Value: "EDITED" while the user has changed the input.
 * Cleared at the end of each poll cycle so future polls resume writing.
 */
const _dirtyInputs = new Map();

/** Mark a form input as dirty (user-edited). Skips poll overwrites this cycle. */
export function markInputDirty(elementId) {
  const active = posStore.getActive();
  if (!active) return;
  const key = `pulsechain-${active.walletAddress}-${active.contractAddress}-${active.tokenId}-${elementId}`;
  _dirtyInputs.set(key, "EDITED");
}

/** Check if a form input is dirty. */
export function isInputDirty(elementId) {
  const active = posStore.getActive();
  if (!active) return false;
  const key = `pulsechain-${active.walletAddress}-${active.contractAddress}-${active.tokenId}-${elementId}`;
  return _dirtyInputs.has(key);
}

/** Clear all dirty flags (called at end of each poll cycle). */
export function clearDirtyInputs() {
  _dirtyInputs.clear();
}

// ── V2 status flattening ────────────────────────────────────────────────────

/**
 * Flatten the V2 status response into a single object for the active position.
 * Merges global + per-position data, with tokenId reconciliation when the
 * server's active position differs from the browser's.
 */
export function flattenV2Status(v2) {
  const global = v2.global || {},
    positions = v2.positions || {};
  const active = posStore.getActive();
  const myKey = active
    ? compositeKey(
        "pulsechain",
        global.walletAddress,
        active.contractAddress,
        active.tokenId,
      )
    : null;
  let posData = myKey ? positions[myKey] : null;
  if (
    !posData &&
    active?.token0 &&
    active?.contractAddress &&
    global.walletAddress
  ) {
    const pfx =
      "pulsechain-" + global.walletAddress + "-" + active.contractAddress + "-";
    const at0 = active.token0.toLowerCase();
    const mk = Object.keys(positions).find((k) => {
      if (!k.startsWith(pfx) || k === myKey) return false;
      const ap = positions[k]?.activePosition;
      return ap && ap.fee === active.fee && ap.token0?.toLowerCase() === at0;
    });
    if (mk) {
      posData = positions[mk];
      const nid = mk.split("-").pop();
      if (nid !== active.tokenId) posStore.updateActiveTokenId(nid);
    }
  }
  return {
    ...global,
    ...(posData || {}),
    _hasPositionData: !!posData,
    _managedPositions: global.managedPositions || [],
    _allPositionStates: positions,
    _poolDailyCounts: global.poolDailyCounts || {},
    _positionScan: global.positionScan || null,
  };
}
