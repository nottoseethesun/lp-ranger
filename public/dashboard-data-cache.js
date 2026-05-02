/**
 * @file dashboard-data-cache.js
 * @description Rebalance event localStorage cache and config input dirty-flag
 *   management. Extracted from dashboard-data.js for line-count compliance.
 */

import { compositeKey } from "./dashboard-helpers.js";
import { posStore } from "./dashboard-positions-store.js";

// ── Rebalance event cache ────────────────────────────────────────────────────

const _REB_CACHE_KEY = "9mm_rebalance_events_cache";

/*- Cache is keyed by POOL IDENTITY so the entry survives rebalances (which
    mint new tokenIds).  Shape:
      { [poolKey]: { [newTokenId]: eventObj } }
    poolKey = "pulsechain-{wallet}-{contract}-{token0}-{token1}-{fee}"
    Legacy shape (tokenId-keyed array) is migrated on first read/write. */

/** True when `x` is null or undefined. */
function _nil(x) {
  return x === null || x === undefined;
}

/** Get the active position's event id (newTokenId) as a string, or null. */
function _evtId(ev) {
  return _nil(ev?.newTokenId) ? null : String(ev.newTokenId);
}

/** Merge an events array into a dest object keyed by newTokenId. */
function _mergeEvents(dest, arr) {
  for (const ev of arr) {
    const id = _evtId(ev);
    if (id && !dest[id]) dest[id] = ev;
  }
}

/** Coerce an existing cache entry into a plain keyed object. */
function _coerceDest(existing) {
  return existing && typeof existing === "object" && !Array.isArray(existing)
    ? { ...existing }
    : {};
}

function _activePoolKey() {
  const a = posStore.getActive();
  if (
    !a?.walletAddress ||
    !a?.contractAddress ||
    !a?.token0 ||
    !a?.token1 ||
    _nil(a?.fee)
  ) {
    return null;
  }
  return (
    "pulsechain-" +
    a.walletAddress.toLowerCase() +
    "-" +
    a.contractAddress.toLowerCase() +
    "-" +
    a.token0.toLowerCase() +
    "-" +
    a.token1.toLowerCase() +
    "-" +
    a.fee
  );
}

/** Is `k` a legacy 4-segment tokenId-keyed entry for the active position? */
function _isLegacyKey(k, prefix, newKey) {
  if (k === newKey) return false;
  if (!k.toLowerCase().startsWith(prefix)) return false;
  /*- Legacy keys have 4 dash-segments (blockchain-wallet-contract-tokenId);
      new pool keys have 6.  Addresses and numeric IDs contain no dashes. */
  return k.split("-").length === 4;
}

/*- One-time migration: fold any legacy 4-segment (tokenId-keyed, array-
    valued) entries for the active wallet+contract into the new pool-keyed
    object.  Events are keyed by newTokenId so duplicates collapse. */
function _migrateLegacyCache(cache) {
  const a = posStore.getActive();
  if (!a?.walletAddress || !a?.contractAddress) return false;
  const newKey = _activePoolKey();
  if (!newKey) return false;
  const prefix =
    "pulsechain-" +
    a.walletAddress.toLowerCase() +
    "-" +
    a.contractAddress.toLowerCase() +
    "-";
  const dest = _coerceDest(cache[newKey]);
  let migrated = false;
  for (const k of Object.keys(cache)) {
    if (!_isLegacyKey(k, prefix, newKey)) continue;
    const v = cache[k];
    if (!Array.isArray(v)) continue;
    _mergeEvents(dest, v);
    delete cache[k];
    migrated = true;
  }
  if (migrated) cache[newKey] = dest;
  return migrated;
}

export function cacheRebalanceEvents(events) {
  const pk = _activePoolKey();
  if (!pk || !Array.isArray(events)) return;
  try {
    const r = localStorage.getItem(_REB_CACHE_KEY);
    const c = r ? JSON.parse(r) : {};
    _migrateLegacyCache(c);
    const dest = _coerceDest(c[pk]);
    for (const ev of events) {
      const id = _evtId(ev);
      if (id) dest[id] = ev;
    }
    c[pk] = dest;
    localStorage.setItem(_REB_CACHE_KEY, JSON.stringify(c));
  } catch {
    /* */
  }
}

export function loadCachedRebalanceEvents() {
  const pk = _activePoolKey();
  if (!pk) return null;
  try {
    const r = localStorage.getItem(_REB_CACHE_KEY);
    if (!r) return null;
    const c = JSON.parse(r);
    if (_migrateLegacyCache(c)) {
      localStorage.setItem(_REB_CACHE_KEY, JSON.stringify(c));
    }
    const entry = c[pk];
    if (!entry) return null;
    /*- Back-compat: a stray legacy array survives unchanged. */
    if (Array.isArray(entry)) return entry.length ? entry : null;
    const arr = Object.values(entry);
    return arr.length ? arr : null;
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

/*-
 * Last-logged direct-hit state per viewed-key.  flattenV2Status() runs
 * every poll (~3s); steady-state direct-hit=true would spam the console
 * forever.  We only log on transitions (first sight of a key, or
 * direct-hit flipping) and on the rebalance-follow path (which is
 * already an interesting event).
 */
const _lastFlattenHit = new Map();

/*-
 * Emit the flatten log only when the direct-hit state changes (or on
 * first sight of a viewed-key).  Steady state stays silent.
 */
function _logFlattenOnTransition(myKey, hit, active) {
  if (!myKey) return;
  if (_lastFlattenHit.get(myKey) === hit) return;
  console.log(
    "[lp-ranger] [flatten] viewed-key=%s direct-hit=%s active-tokenId=%s active-symbols=%s/%s",
    myKey,
    hit,
    active?.tokenId || "(none)",
    active?.token0Symbol || "?",
    active?.token1Symbol || "?",
  );
  _lastFlattenHit.set(myKey, hit);
}

/*-
 * Rebalance-follow: when the active entry's composite key is missing
 * from `positions` (e.g. after a rebalance mint), look for a managed
 * bucket whose `rebalanceEvents` contains a `{oldTokenId: active,
 * newTokenId: that bucket's tokenId}` edge and return its posData.
 * The event is the single source of truth — no same-pool heuristic.
 */
function _findRebalanceTargetPosData(active, positions) {
  if (!active?.tokenId) return null;
  const tid = String(active.tokenId);
  for (const [k, pd] of Object.entries(positions)) {
    const events = pd?.rebalanceEvents || [];
    const newTid = k.split("-").pop();
    const hit = events.some(
      (e) => String(e.oldTokenId) === tid && String(e.newTokenId) === newTid,
    );
    if (hit) {
      console.log(
        "[lp-ranger] [flatten] rebalance-follow MATCH: viewed #%s → managed #%s (key=%s, ap.symbols=%s/%s)",
        tid,
        newTid,
        k,
        pd?.activePosition?.token0Symbol || "?",
        pd?.activePosition?.token1Symbol || "?",
      );
      if (newTid !== tid) posStore.updateActiveTokenId(newTid);
      return pd;
    }
  }
  console.log(
    "[lp-ranger] [flatten] rebalance-follow NO-MATCH for viewed #%s (scanned %d managed buckets)",
    tid,
    Object.keys(positions).length,
  );
  return null;
}

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
  _logFlattenOnTransition(myKey, !!posData, active);
  if (!posData) {
    posData = _findRebalanceTargetPosData(active, positions);
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
