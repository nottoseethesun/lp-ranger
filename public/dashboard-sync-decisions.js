/**
 * @file dashboard-sync-decisions.js
 * @description Pure decisions extracted from `public/dashboard-data.js`
 *   so they can be tested directly (no posStore / wallet / view-mode
 *   singleton setup) and to keep `dashboard-data.js` under its 500-loc
 *   cap.  The exported functions are called from the thin adapters
 *   `_syncStatus` and `_resolveManagedTid` in `dashboard-data.js`.
 */

"use strict";

/**
 * Pure sync-status decision.  See docs in the caller (`_syncStatus`
 * in `dashboard-data.js`) for the composed adapter that resolves the
 * singletons and delegates here.
 * @param {object} inputs
 * @param {object|null} inputs.active                Active posStore entry (or null).
 * @param {string|null|undefined} inputs.walletAddress
 * @param {number} inputs.positionCount              posStore.count()
 * @param {boolean} inputs.positionManaged           isPositionManaged(tokenId)
 * @param {boolean} inputs.viewingClosed             isViewingClosedPos()
 * @param {object|null} inputs.positionScan          d._positionScan
 * @param {boolean} inputs.rebalanceScanComplete     d.rebalanceScanComplete
 * @param {boolean} inputs.lifetimeScanComplete      d.lifetimeScanComplete
 * @returns {{complete:boolean, label:string, tip?:string}}
 */
export function _computeSyncStatus(inputs) {
  const {
    active,
    walletAddress,
    positionCount,
    positionManaged,
    viewingClosed,
    positionScan,
    rebalanceScanComplete,
    lifetimeScanComplete,
  } = inputs;
  if (!active) return { complete: true, label: "" };
  if (walletAddress && positionCount === 0)
    return { complete: false, label: "" };
  if (!positionManaged && viewingClosed)
    return { complete: true, label: "Synced" };
  if (positionScan && positionScan.status === "scanning") {
    const p = positionScan.progress;
    const tip = p?.total > 0 ? p.done + "/" + p.total + " positions" : "";
    return { complete: false, label: "Syncing…", tip };
  }
  /*- `lifetimeScanComplete` gates only when the active position is
   *  managed.  Unmanaged positions don't render a Lifetime panel, so
   *  the flag is structurally irrelevant on their state — checking it
   *  would leave their badge stuck on "Syncing…" forever.  See
   *  server-routes._syncLifetimeState for the matching server-side
   *  decision. */
  if (!rebalanceScanComplete || (positionManaged && !lifetimeScanComplete))
    return { complete: false, label: "Syncing…" };
  return { complete: true, label: "Synced" };
}

/**
 * Pure rebalance-follow decision.  See docs in the caller
 * (`_resolveManagedTid` in `dashboard-data.js`).
 * @param {{tokenId:string|number}} a
 * @param {Array<{tokenId:string|number, key:string}>} mp
 * @param {Record<string, {rebalanceEvents?:Array}>} states
 * @returns {{migrateTo: string|null}}
 */
export function _computeRebalanceFollow(a, mp, states) {
  const tid = String(a.tokenId);
  if (mp.some((p) => String(p.tokenId) === tid)) return { migrateTo: null };
  for (const p of mp) {
    const events = states[p.key]?.rebalanceEvents || [];
    const hit = events.some(
      (e) =>
        String(e.oldTokenId) === tid &&
        String(e.newTokenId) === String(p.tokenId),
    );
    if (hit) return { migrateTo: String(p.tokenId) };
  }
  return { migrateTo: null };
}
