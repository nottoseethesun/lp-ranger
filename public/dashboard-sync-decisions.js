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
  /*- Order matters, and it was wrong.  The `!active` check used to come
   *  first and return complete:true, which paints the badge with the
   *  `done` class — green, no pulse — while its empty label fell back
   *  to the text "Syncing…".  The badge then said one thing and looked
   *  like another for the whole of startup, and this branch, written
   *  for exactly that case, was unreachable.
   *
   *  A wallet with no positions yet is still loading them: that is
   *  genuinely syncing, so say so and look it. */
  if (walletAddress && positionCount === 0) {
    /*- Zero positions means one of two very different things, and the
     *  scan status is what separates them.  "idle" or "scanning" means
     *  we do not know yet — still loading.  "ready" means the scan ran
     *  and this wallet genuinely holds no LP positions, which is an
     *  answer; pulsing at the operator forever would be a lie in the
     *  other direction. */
    /*- "ready" and "error" are both terminal: the scan is not coming
     *  back with more.  Only "idle" (never started) and "scanning" mean
     *  wait.  Treating an errored scan as pending would leave the badge
     *  pulsing and the panels blurred with nothing left to arrive. */
    const st = positionScan?.status;
    const scanFinished = st === "ready" || st === "error";
    return scanFinished
      ? { complete: true, label: "Synced" }
      : { complete: false, label: "Syncing…" };
  }
  /*- No wallet and nothing selected: there is nothing to sync, so the
   *  badge is honestly done.  Labelled explicitly — an empty label here
   *  is what allowed the text and the style to disagree. */
  if (!active) return { complete: true, label: "Synced" };
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
