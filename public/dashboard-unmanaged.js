/**
 * @file dashboard-unmanaged.js
 * @description One-shot detail fetch for unmanaged LP positions.
 *   When the user views an unmanaged position, this module fetches live
 *   pool state, token prices, composition, and value from the server
 *   and populates the dashboard KPIs using shared rendering functions.
 */

import { g, botConfig, csrfHeaders, cloneTpl } from "./dashboard-helpers.js";
import { resetKpis, pollNow } from "./dashboard-data.js";
import {
  loadPriceOverrides,
  loadForceOverride,
} from "./dashboard-price-override.js";
import { _apply, _applyLifetime } from "./dashboard-unmanaged-apply.js";
import { enterClosedPosView } from "./dashboard-closed-pos.js";
import { isWalletUnlocked } from "./dashboard-wallet.js";
import { LT_BD_IDS } from "./dashboard-data-kpi-breakdown.js";

const _ALL_KPIS = [
  "kpiValue",
  "pnlFees",
  "pnlPrice",
  "kpiPnl",
  "curProfit",
  "curIL",
  "pnlRealized",
  "kpiNet",
  "ltProfit",
  "netIL",
  ...LT_BD_IDS,
  "kpiPosDuration",
  "ltCurrentValue",
];

/** Build the request body for position detail endpoints. */
function _detailBody(pos) {
  return {
    tokenId: pos.tokenId,
    token0: pos.token0,
    token1: pos.token1,
    fee: pos.fee,
    tickLower: pos.tickLower,
    tickUpper: pos.tickUpper,
    liquidity: String(pos.liquidity || 0),
    walletAddress: pos.walletAddress,
    contractAddress: pos.contractAddress,
    ...(() => {
      const ov = loadPriceOverrides(),
        r = {};
      if (ov.price0 > 0) r.priceOverride0 = ov.price0;
      if (ov.price1 > 0) r.priceOverride1 = ov.price1;
      if (loadForceOverride()) r.priceOverrideForce = true;
      return r;
    })(),
  };
}

let _lastFetchedId = null,
  _fetchGen = 0;

/*- Position recorded when fetchUnmanagedDetails was called before the
 *  wallet was unlocked.  flushPendingUnmanagedFetch() drains it on
 *  unlock so the one-shot fetch fires for the position the user is
 *  actually looking at — not whatever posStore.getActive() happens to
 *  return at unlock time (which is racy on cold loads). */
let _pendingPos = null;

/** Reset the dedup guard so the next fetchUnmanagedDetails call will re-fetch. */
export function resetLastFetchedId() {
  _lastFetchedId = null;
}

/**
 * Fire any pending unmanaged-details fetch that was deferred because the
 * wallet was still locked when the activation path tried to fetch.  Called
 * from the wallet unlock paths (auto-unlock, manual submit, import).  No-op
 * when nothing is pending.
 */
export function flushPendingUnmanagedFetch() {
  const pos = _pendingPos;
  _pendingPos = null;
  if (!pos) return;
  /*- Reset the dedup guard so a same-tokenId fetch from earlier (e.g. a
   *  stale completed request) doesn't entry-skip this one. */
  _lastFetchedId = null;
  console.log(
    "%c[lp-ranger] [unmanaged] FLUSH-PENDING #%s",
    "color:#0f0;background:#031;padding:1px 4px;border-radius:2px",
    pos?.tokenId,
  );
  fetchUnmanagedDetails(pos);
}

/**
 * Check if the server response indicates a fully drained (closed) position.
 * Both token amounts and USD value must be zero.
 * @param {object} d  Phase-1 API response.
 * @returns {boolean}
 */
function _isResponseDrained(d) {
  return (
    d.amounts &&
    d.amounts.amount0 === 0 &&
    d.amounts.amount1 === 0 &&
    d.value === 0
  );
}

/**
 * Run phase-1 (fast) detail fetch.  If the server reveals the position was
 * fully drained, updates posStore and switches to the closed-pos history view.
 * @param {object} pos   posStore entry.
 * @param {object} body  Request body (mutated: feesUsd added on success).
 * @returns {Promise<boolean>}  True if switched to closed-pos view.
 */
async function _phase1(pos, body) {
  const _t0 = Date.now();
  console.log(
    "%c[lp-ranger] [unmanaged] phase1 START #%s liquidity=%s",
    "color:#f80;background:#310;padding:1px 4px;border-radius:2px",
    pos?.tokenId,
    body?.liquidity,
  );
  try {
    const r = await fetch("/api/position/details", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...csrfHeaders() },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!d.ok) {
      console.warn(
        "[lp-ranger] [unmanaged] phase1 FAIL #%s details error: %s (%dms)",
        pos?.tokenId,
        d.error,
        Date.now() - _t0,
      );
      return false;
    }
    if (_isResponseDrained(d)) {
      console.log(
        "%c[lp-ranger] [unmanaged] phase1 DRAINED #%s → closed view (%dms)",
        "color:#f80;background:#310;padding:1px 4px;border-radius:2px",
        pos?.tokenId,
        Date.now() - _t0,
      );
      pos.liquidity = "0";
      enterClosedPosView(pos);
      return true;
    }
    _apply(d, pos);
    body.feesUsd = d.feesUsd;
    console.log(
      "%c[lp-ranger] [unmanaged] phase1 DONE #%s value=%s feesUsd=%s (%dms)",
      "color:#f80;background:#310;padding:1px 4px;border-radius:2px",
      pos?.tokenId,
      d.value,
      d.feesUsd,
      Date.now() - _t0,
    );
  } catch (e) {
    console.warn(
      "[lp-ranger] [unmanaged] phase1 EXCEPTION #%s %s (%dms)",
      pos?.tokenId,
      e.message,
      Date.now() - _t0,
    );
  }
  return false;
}

/** Trigger an immediate poll so the badge updates from server state.
 *  The server writes rebalanceScanComplete when the lifetime scan
 *  finishes (same path for managed and unmanaged) — no client flag. */
function _markSynced() {
  pollNow();
}

/** Show a modal informing the user the scan timed out. */
function _showScanTimeoutDialog() {
  const existing = document.getElementById("scanTimeoutModal");
  if (existing) existing.remove();
  const el = document.createElement("div");
  el.className = "9mm-pos-mgr-il-popover";
  el.id = "scanTimeoutModal";
  const frag = cloneTpl("tplScanTimeoutPopover");
  if (frag) el.appendChild(frag);
  el.querySelector("[data-dismiss]").addEventListener("click", () =>
    el.remove(),
  );
  el.addEventListener("click", (e) => {
    if (e.target === el) el.remove();
  });
  document.body.appendChild(el);
}

/** Phase 2: slow — lifetime P&L (event scan + epoch reconstruction). */
async function _phase2(body, gen) {
  const timeoutMs = botConfig.scanTimeoutMs || 7_200_000;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const r2 = await fetch("/api/position/lifetime", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...csrfHeaders() },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (gen === _fetchGen) {
      const d2 = await r2.json();
      if (d2.ok) _applyLifetime(d2);
    }
  } catch (e) {
    if (e.name === "AbortError") {
      console.warn(
        "[lp-ranger] [unmanaged] phase 2 timed out after %ds",
        timeoutMs / 1000,
      );
      if (gen === _fetchGen) _showScanTimeoutDialog();
    } else {
      console.warn("[lp-ranger] [unmanaged] phase 2 failed:", e.message);
    }
  }
  // Always clear Syncing badge — even on timeout or gen mismatch
  _markSynced();
}

/** Check entry guards; return reason string if blocked, null if OK to proceed. */
function _entryGuardReason(pos) {
  if (!pos?.tokenId || !pos?.token0 || !pos?.token1 || !pos?.fee)
    return "missing-fields";
  if (!isWalletUnlocked()) return "wallet-locked";
  if (String(pos.tokenId) === _lastFetchedId) return "lastFetchedId-match";
  return null;
}

/** Fetch and display details for an unmanaged position (two-phase). */
export async function fetchUnmanagedDetails(pos) {
  const _tid = pos?.tokenId;
  const _skip = _entryGuardReason(pos);
  if (_skip) {
    console.log(
      "%c[lp-ranger] [unmanaged] ENTRY-SKIP #%s %s",
      "color:#f80;background:#310;padding:1px 4px;border-radius:2px",
      _tid,
      _skip,
    );
    /*- When skipped because the wallet hasn't unlocked yet, record the
     *  position so flushPendingUnmanagedFetch() can fire the fetch as
     *  soon as unlock completes.  Requires the structural fields (the
     *  "missing-fields" skip can't be recovered by retry). */
    if (_skip === "wallet-locked" && pos?.tokenId && pos?.token0) {
      _pendingPos = pos;
    }
    return;
  }
  const tid = String(pos.tokenId);
  _lastFetchedId = tid;
  const gen = ++_fetchGen;
  console.log(
    "%c[lp-ranger] [unmanaged] ENTRY #%s gen=%d → starting phase1+phase2",
    "color:#f80;background:#310;padding:1px 4px;border-radius:2px",
    _tid,
    gen,
  );
  resetKpis(_ALL_KPIS);
  const sub = g("kpiPnlPct");
  if (sub) sub.textContent = "";
  const badge = g("syncBadge");
  if (badge) {
    badge.textContent = "Syncing\u2026";
    badge.classList.remove("done");
    badge.style.background = "";
  }
  const body = _detailBody(pos);
  // Phase 1: fast — pool state, value, composition, current P&L.
  // If the position turns out to be closed (fully drained), phase 1
  // switches to the closed-pos history view and skips phase 2.
  if (await _phase1(pos, body)) {
    if (gen === _fetchGen) _markSynced();
    return;
  }
  if (gen !== _fetchGen) return;
  await _phase2(body, gen);
}
