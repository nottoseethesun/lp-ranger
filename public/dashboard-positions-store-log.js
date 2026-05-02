/**
 * @file dashboard-positions-store-log.js
 * @description Diagnostic log helpers for posStore renders + dedup
 * refresh.  Extracted so each call site stays under the 17-complexity
 * cap and dashboard-positions-store.js stays under the 500-line cap.
 *
 * These logs trace the "tokenId correct, pool name stale" mixed-state
 * render bug — every renderer that paints token symbols on the page
 * announces what entry it's rendering from, so a mismatched render is
 * visible in the browser console without DOM inspection.
 */
"use strict";

/**
 * Log an entry being passed to `_updateActiveStripDetails` (Pool/Fee
 * at the top of the page + active-pos label).
 */
export function logStripRender(active) {
  console.log(
    "[lp-ranger] [strip-render] tokenId=#%s symbols=%s/%s fee=%s addrs=%s/%s",
    active.tokenId,
    active.token0Symbol || "?",
    active.token1Symbol || "?",
    active.fee,
    (active.token0 || "?").slice(0, 10),
    (active.token1 || "?").slice(0, 10),
  );
}

/**
 * Log an entry being passed to `_applyLocalPositionData` (Position
 * Stats labels + holdings + token-composition labels).
 */
export function logLocalRender(pos) {
  console.log(
    "[lp-ranger] [local-render] tokenId=#%s symbols=%s/%s fee=%s addrs=%s/%s — paints Position Stats labels + wsPool",
    pos.tokenId,
    pos.token0Symbol || "?",
    pos.token1Symbol || "?",
    pos.fee,
    (pos.token0 || "?").slice(0, 10),
    (pos.token1 || "?").slice(0, 10),
  );
}

/*-
 * Re-scans hit `_refreshDuplicateEntry` for every position on every
 * scan; logging unconditionally produced hundreds of "X → X (fee Y → Y)"
 * lines per scan.  This helper detects whether anything pool-identity-
 * relevant actually differs so the caller can skip the log entirely
 * when the entry is unchanged — the diagnostic value is in catching
 * silent drift, not in announcing every re-scan.
 */
function _diffsPoolIdentity(existing, entry) {
  if (entry.token0Symbol && existing.token0Symbol !== entry.token0Symbol)
    return true;
  if (entry.token1Symbol && existing.token1Symbol !== entry.token1Symbol)
    return true;
  if (entry.token0 && existing.token0 !== entry.token0) return true;
  if (entry.token1 && existing.token1 !== entry.token1) return true;
  if (
    entry.fee !== undefined &&
    entry.fee !== null &&
    existing.fee !== entry.fee
  )
    return true;
  return false;
}

/**
 * Log a posStore.add() dedup-refresh: which fields are about to change.
 * No-op when nothing pool-identity-relevant differs (steady-state silence).
 */
export function logDedupRefresh(existing, entry) {
  if (!_diffsPoolIdentity(existing, entry)) return;
  const newFee =
    entry.fee !== undefined && entry.fee !== null ? entry.fee : "(unchanged)";
  console.log(
    "[lp-ranger] [posStore] dedup-refresh #%s: %s/%s → %s/%s (fee %s → %s)",
    existing.tokenId,
    existing.token0Symbol || "?",
    existing.token1Symbol || "?",
    entry.token0Symbol || "(unchanged)",
    entry.token1Symbol || "(unchanged)",
    existing.fee,
    newFee,
  );
}
