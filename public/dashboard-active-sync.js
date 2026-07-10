/**
 * @file dashboard-active-sync.js
 * @description Sync the posStore active entry from the server's
 * `data.activePosition` payload.  Extracted from dashboard-data.js to
 * keep that file under the 500-line cap.
 *
 * Why this exists: a position's pool-identity fields (token0/token1/
 * fee/ticks + symbols) can drift after a rebalance-follow migrates
 * `tokenId` in place — without re-syncing all of them and re-rendering,
 * the strip shows the new tokenId next to the previous position's pool
 * name and fee tier (the "tokenId correct, pool name stale" bug).
 */
"use strict";

import { log } from "./dashboard-log.js";
import {
  posStore,
  updatePosStripUI,
  renderPosBrowser,
} from "./dashboard-positions.js";

/**
 * Mutate the posStore active entry from `data.activePosition`.  Calls
 * `updatePosStripUI()` when any pool-identity field actually changed.
 *
 * @param {object} d  The /api/status payload (or flattened equivalent).
 */
function _snap(o) {
  return {
    tokenId: o?.tokenId,
    t0s: o?.token0Symbol,
    t1s: o?.token1Symbol,
    fee: o?.fee,
  };
}

function _logSync(before, ap, active, poolIdentityChanged) {
  log.info(
    "[lp-ranger] [active-sync] viewed=#%s ap=#%s poolIdentityChanged=%s before(%s/%s fee=%s) → after(%s/%s fee=%s) tokenId %s→%s%s",
    before.tokenId,
    ap.tokenId,
    poolIdentityChanged,
    before.t0s || "?",
    before.t1s || "?",
    before.fee,
    active.token0Symbol || "?",
    active.token1Symbol || "?",
    active.fee,
    before.tokenId,
    active.tokenId,
    poolIdentityChanged ? " [will updatePosStripUI]" : "",
  );
}

/** Copy liquidity + tick fields from an activePosition payload. */
function _applyLiqAndTicks(active, ap) {
  if (ap.liquidity !== undefined) active.liquidity = String(ap.liquidity);
  if (ap.tickLower !== undefined) {
    active.tickLower = ap.tickLower;
    active.tickUpper = ap.tickUpper;
  }
}

/** Copy pool-identity fields (token0/token1/fee).  Returns true when
 *  any of them changed. */
function _applyPoolFields(active, ap) {
  if (!ap.token0) return false;
  const changed =
    active.token0 !== ap.token0 ||
    active.token1 !== ap.token1 ||
    active.fee !== ap.fee;
  active.token0 = ap.token0;
  active.token1 = ap.token1;
  active.fee = ap.fee;
  return changed;
}

/** Copy token symbols.  Returns true when either symbol changed. */
function _applySymbols(active, ap) {
  let changed = false;
  if (ap.token0Symbol && active.token0Symbol !== ap.token0Symbol) {
    active.token0Symbol = ap.token0Symbol;
    changed = true;
  }
  if (ap.token1Symbol && active.token1Symbol !== ap.token1Symbol) {
    active.token1Symbol = ap.token1Symbol;
    changed = true;
  }
  return changed;
}

/*-
 * syncActivePosition runs on every poll (~3s).  In steady state the
 * skip-paths and the no-change render-pass would log forever.  Skip
 * logs are silent; the main log only fires when something actually
 * changed (poolIdentityChanged OR tokenId migration).
 */
export function syncActivePosition(d) {
  if (!d.activePosition) return;
  const active = posStore.getActive();
  if (!active || active.positionType !== "nft") return;
  const ap = d.activePosition;
  const before = _snap(active);
  const wasClosed = String(active.liquidity || "") === "0";
  _applyLiqAndTicks(active, ap);
  const poolFieldsChanged = _applyPoolFields(active, ap);
  const symbolsChanged = _applySymbols(active, ap);
  const poolIdentityChanged = poolFieldsChanged || symbolsChanged;
  _maybeLogSync(before, ap, active, poolIdentityChanged);
  if (ap.tokenId) active.tokenId = String(ap.tokenId);
  /*- Closed-state flip triggers strip + Position Browser re-render so the
   *  "Open Positions" badge count and the browser row's Closed styling
   *  reflect a fresh drain (or a re-mint back into liquidity) on the very
   *  next poll — without this the badge stayed stuck at the pre-drain
   *  count until the user switched positions manually. */
  const nowClosed = String(active.liquidity || "") === "0";
  const closedFlipped = wasClosed !== nowClosed;
  if (poolIdentityChanged || closedFlipped) updatePosStripUI();
  if (closedFlipped) renderPosBrowser();
}

/*-
 * Gate the sync log: only emit when something material changed
 * (poolIdentity OR tokenId migration).  Without this, every poll fires
 * a "no-change" line every 3s.
 */
function _maybeLogSync(before, ap, active, poolIdentityChanged) {
  const tokenIdChanged =
    ap.tokenId && String(ap.tokenId) !== String(before.tokenId);
  if (poolIdentityChanged || tokenIdChanged) {
    _logSync(before, ap, active, poolIdentityChanged);
  }
}
