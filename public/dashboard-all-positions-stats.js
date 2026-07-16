/**
 * @file dashboard-all-positions-stats.js
 * @description "All Positions Stats" header button + modal.
 *
 *   Header-button readiness gate: the button only enables when EVERY
 *   currently-running managed position has finished BOTH its
 *   rebalance-history scan AND its lifetime-deposit scan AND has a
 *   populated pnlSnapshot.  Distinct from every other button on the
 *   dashboard — those gate on the actively-viewed position only.
 *
 *   Modal: single sortable table across all currently-open managed
 *   positions.  Columns: Position (identity), Lifetime P&L, Profit,
 *   Impermanent Loss/Gain, and a per-row [Go to position] deep link.
 *   Numeric columns sort DESC on first click, toggle ASC on repeat
 *   click; default sort is Lifetime P&L DESC.  Rows re-render on
 *   each /api/status poll while the modal is open, so numbers stay
 *   live without the user needing to reopen.
 *
 *   Row filter: only positions with liquidity > 0 appear.  A drained
 *   managed position won't show up until it re-mints; the "closed"
 *   state isn't useful for a ranked open-position stats view.
 *
 *   Lifetime numeric derivation mirrors the existing Lifetime panel
 *   (`_resolveKpiTotals` in dashboard-data-kpi.js), applied per row
 *   instead of only to the active position.  Per-pool localStorage
 *   entries (Realized Gains, Initial Deposit override) are looked up
 *   through the parameterized loaders in dashboard-data-deposit.js.
 */

import { log } from "./dashboard-log.js";
import { g } from "./dashboard-helpers.js";
import { getLastStatus } from "./dashboard-data.js";
import {
  getProviderDisplayName,
  getProviderLabel,
} from "./dashboard-lp-providers.js";
import {
  loadInitialDepositForPool,
  loadRealizedGainsForPool,
} from "./dashboard-data-deposit.js";

/*- Track last-applied {disabled, title} so we don't touch the DOM on
 *  every 3-second poll when nothing has changed.  Prevents needless
 *  reflow + prevents the browser from re-arming the tooltip timer. */
let _lastButtonState = { disabled: null, title: null };

/*- Modal open flag + sort state.  Sort defaults to Lifetime P&L DESC
 *  per the design.  Clicking the current column toggles direction;
 *  clicking a different column jumps to DESC on that column. */
let _isOpen = false;
let _sortCol = "ltNetPnl";
let _sortDir = "desc";

/*- Truncate a token symbol to at most 6 characters, appending an
 *  ellipsis when trimmed.  Matches the row-identity spec in the task
 *  description ("token pair truncated to six characters each with an
 *  ellipsis"). */
function _truncSym(s) {
  const v = s || "?";
  return v.length > 6 ? v.slice(0, 6) + "…" : v;
}

/*- Fee in basis-points-times-100 (e.g. 2500 for 0.25%) → display
 *  string like "0.25%".  Uses parseFloat + toFixed so 100 → "0.01%"
 *  and 10000 → "1%" both round-trip cleanly. */
function _feePct(fee) {
  const n = Number(fee) || 0;
  return (n / 10000).toFixed(2) + "%";
}

/*- Format a signed USD amount with 2 decimals and thousands sep.
 *  Returns "—" for null/undefined so we don't render "$NaN". */
function _fmtUsd(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}$${abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/*- Compute the three sortable numerics (ltNetPnl, ltProfit, ltIL)
 *  from a pnlSnapshot + realized-gains override + lifetime deposit.
 *  Mirror of the formulas the Lifetime panel uses in
 *  dashboard-data-kpi._resolveKpiTotals — applied per row here
 *  instead of only to the active position. */
function _computeNumerics(snap, ltRealized, ltDep) {
  const currentValue = snap.currentValue || 0;
  const ltPc = ltDep > 0 ? currentValue - ltDep : 0;
  const compounded = snap.totalCompoundedUsd || 0;
  const ltCurrentFees = snap.currentFeesUsd || 0;
  const ltGas = snap.totalGas || 0;
  const ltResidual = snap.residualValueUsd || 0;
  const ltInitialResidual = snap.initialResidualUsd || 0;
  const il = snap.lifetimeIL ?? snap.totalIL ?? 0;
  const ltNetPnl =
    ltPc +
    compounded +
    ltCurrentFees +
    ltRealized -
    ltGas +
    ltResidual -
    ltInitialResidual;
  const ltProfit = ltCurrentFees + compounded - ltGas + il;
  return { ltNetPnl, ltProfit, ltIL: il };
}

/*- Derive a single row from a per-position bot state + wallet-scope
 *  globals.  Returns null when the position isn't currently open
 *  (liq === 0) or when the bot state hasn't produced a pnlSnapshot
 *  yet (gate should have prevented the modal from opening in that
 *  case, but the check keeps the render function honest under
 *  eventual-consistency polling). */
function _computeRow(key, posState, globalCtx) {
  const ap = posState?.activePosition;
  const snap = posState?.pnlSnapshot;
  if (!ap || !snap) return null;
  if (parseFloat(ap.liquidity || 0) <= 0) return null;
  const poolCtx = {
    walletAddress: globalCtx.walletAddress,
    contractAddress: globalCtx.positionManager,
    token0: ap.token0,
    token1: ap.token1,
    fee: ap.fee,
  };
  const ltRealized = loadRealizedGainsForPool(poolCtx);
  const ltDepOverride = loadInitialDepositForPool(poolCtx);
  const ltDep =
    ltDepOverride > 0 ? ltDepOverride : snap.totalLifetimeDeposit || 0;
  const nums = _computeNumerics(snap, ltRealized, ltDep);
  const lpName =
    getProviderDisplayName(globalCtx.factory, globalCtx.positionManager) ||
    getProviderLabel(globalCtx.positionManager) ||
    "?";
  return {
    key,
    blockchain: globalCtx.chainName || "pulsechain",
    symbol0: ap.token0Symbol,
    symbol1: ap.token1Symbol,
    feePct: _feePct(ap.fee),
    lpProviderName: lpName,
    walletAddress: globalCtx.walletAddress,
    contractAddress: globalCtx.positionManager,
    tokenId: ap.tokenId,
    ...nums,
  };
}

/*- Build the row array from a flattened poll payload.  Filters +
 *  computes per-position numerics; the caller sorts + renders. */
function _computeRows(data) {
  if (!data) return [];
  const positions = data._allPositionStates || {};
  const globalCtx = {
    walletAddress: data.walletAddress,
    factory: data.factory,
    positionManager: data.positionManager,
    chainName: data.chainName,
  };
  const rows = [];
  for (const key of Object.keys(positions)) {
    const p = positions[key];
    if (!p || p.status !== "running") continue;
    const row = _computeRow(key, p, globalCtx);
    if (row) rows.push(row);
  }
  return rows;
}

/*- Pure sort by the given column + direction.  Nulls / undefineds
 *  bubble to the bottom regardless of direction so the "not yet
 *  computed" rows never headline a ranking. */
function _sortRows(rows, col, dir) {
  const sign = dir === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    const av = a[col];
    const bv = b[col];
    const an = av === null || av === undefined || Number.isNaN(av);
    const bn = bv === null || bv === undefined || Number.isNaN(bv);
    if (an && bn) return 0;
    if (an) return 1;
    if (bn) return -1;
    if (av === bv) return 0;
    return av < bv ? -sign : sign;
  });
}

/*- Deep-link URL for the row's position.  Uses lowercase addresses
 *  to match the URLs the router emits everywhere else in the app —
 *  the router canonicalises on read. */
function _positionHref(row) {
  const chain = (row.blockchain || "pulsechain").toLowerCase();
  const wallet = (row.walletAddress || "").toLowerCase();
  const contract = (row.contractAddress || "").toLowerCase();
  return `/${chain}/${wallet}/${contract}/${row.tokenId}`;
}

/*- Build the identity cell HTML for one row.  Structure: pair line
 *  (truncated symbols) + meta line (fee · LP-provider · blockchain).
 *  Deliberately class-scoped strings — no dynamic user input reaches
 *  innerHTML (see feedback_no_new_html_in_js).  Symbols and provider
 *  names are text-content'd, not html-injected. */
function _renderIdentityCell(row) {
  const wrap = document.createElement("div");
  wrap.className = "9mm-pos-mgr-all-positions-identity";
  const pair = document.createElement("div");
  pair.className = "9mm-pos-mgr-all-positions-pair";
  pair.textContent = `${_truncSym(row.symbol0)} / ${_truncSym(row.symbol1)}`;
  const meta = document.createElement("div");
  meta.className = "9mm-pos-mgr-all-positions-meta";
  meta.textContent = `${row.feePct} · ${row.lpProviderName} · ${row.blockchain}`;
  wrap.appendChild(pair);
  wrap.appendChild(meta);
  return wrap;
}

/*- Numeric cell with sign colouring (pos/neg classes drive var(--accent3)
 *  vs var(--danger)).  Zero neither colour — reads as neutral. */
function _renderNumCell(value) {
  const td = document.createElement("td");
  td.className = "9mm-pos-mgr-all-positions-num";
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 0) td.classList.add("9mm-pos-mgr-pos");
    else if (value < 0) td.classList.add("9mm-pos-mgr-neg");
  }
  td.textContent = _fmtUsd(value);
  return td;
}

/*- Full table render: update sort markers in the header + swap the
 *  tbody rows.  Empty-state placeholder shows when there are zero
 *  currently-open managed positions. */
function _renderTable(data) {
  const tbody = g("allPositionsStatsTableBody");
  const empty = g("allPositionsStatsEmpty");
  if (!tbody) return;
  const rows = _sortRows(_computeRows(data), _sortCol, _sortDir);
  tbody.replaceChildren();
  for (const row of rows) {
    const tr = document.createElement("tr");
    const idTd = document.createElement("td");
    idTd.appendChild(_renderIdentityCell(row));
    tr.appendChild(idTd);
    tr.appendChild(_renderNumCell(row.ltNetPnl));
    tr.appendChild(_renderNumCell(row.ltProfit));
    tr.appendChild(_renderNumCell(row.ltIL));
    const gotoTd = document.createElement("td");
    const a = document.createElement("a");
    a.className = "9mm-pos-mgr-all-positions-goto";
    a.href = _positionHref(row);
    a.textContent = "Go to position";
    a.title = `Navigate to NFT #${row.tokenId}`;
    gotoTd.appendChild(a);
    tr.appendChild(gotoTd);
    tbody.appendChild(tr);
  }
  if (empty) empty.hidden = rows.length > 0;
  _updateSortMarkers();
}

/*- Sort-marker paint: ▼/▲ on the active column, blank on inactive
 *  columns.  Marker slot is a placeholder <span> already in the
 *  HTML template so we don't need to insert/remove nodes. */
function _updateSortMarkers() {
  const markers = document.querySelectorAll("[data-marker-for]");
  for (const m of markers) {
    const col = m.getAttribute("data-marker-for");
    if (col === _sortCol) m.textContent = _sortDir === "desc" ? "▼" : "▲";
    else m.textContent = "";
  }
}

/*- Sort-header click: same column → toggle direction; different
 *  column → jump to DESC on the new column. */
function _onSortHeaderClick(col) {
  if (_sortCol === col) _sortDir = _sortDir === "desc" ? "asc" : "desc";
  else {
    _sortCol = col;
    _sortDir = "desc";
  }
  _renderTable(getLastStatus());
}

/*- Overlay backdrop click closes the modal.  Modal-body clicks
 *  bubble to the overlay too, so we check e.target vs the overlay
 *  itself to distinguish "outside the modal" from "inside." */
function _onBackdropClick(e) {
  const overlay = g("allPositionsStatsModal");
  if (e.target === overlay) closeAllPositionsStatsModal();
}

/**
 * Compute readiness across every RUNNING managed position and update
 * the "All Positions Stats" header button's disabled state + title.
 * Also re-renders the modal table if it's currently open.  Called
 * after each successful /api/status poll.
 * @param {object} data  Flattened poll payload (from flattenV2Status).
 */
export function updateAllPositionsStatsBtn(data) {
  const btn = g("allPositionsStatsBtn");
  if (btn) {
    const positions = data?._allPositionStates || {};
    let total = 0;
    let ready = 0;
    for (const key of Object.keys(positions)) {
      const p = positions[key];
      if (!p || p.status !== "running") continue;
      total += 1;
      if (
        p.rebalanceScanComplete === true &&
        p.lifetimeScanComplete === true &&
        p.pnlSnapshot
      )
        ready += 1;
    }
    let disabled;
    let title;
    if (total === 0) {
      disabled = true;
      title = "No managed positions — click Manage on a position to add one.";
    } else if (ready < total) {
      disabled = true;
      const missing = total - ready;
      const plural = total === 1 ? "" : "s";
      title = `Waiting for ${missing} of ${total} managed position${plural} to finish loading (rebalance history + lifetime deposit scans).`;
    } else {
      disabled = false;
      title = "View ranked stats across all open managed positions.";
    }
    if (
      _lastButtonState.disabled !== disabled ||
      _lastButtonState.title !== title
    ) {
      _lastButtonState = { disabled, title };
      btn.disabled = disabled;
      btn.title = title;
    }
  }
  if (_isOpen) _renderTable(data);
}

/** Open the modal, render current rows, wire per-open listeners. */
export function openAllPositionsStatsModal() {
  const overlay = g("allPositionsStatsModal");
  if (!overlay) return;
  _isOpen = true;
  overlay.classList.remove("hidden");
  _renderTable(getLastStatus());
  overlay.addEventListener("click", _onBackdropClick);
  log.info("[all-positions-stats] modal opened");
}

/** Hide the modal, tear down per-open listeners. */
export function closeAllPositionsStatsModal() {
  const overlay = g("allPositionsStatsModal");
  if (!overlay) return;
  _isOpen = false;
  overlay.classList.add("hidden");
  overlay.removeEventListener("click", _onBackdropClick);
}

/** Wire the header trigger button + sort-header clicks + close-X.
 *  Called once at dashboard init from bindAllEvents.  Colocating
 *  every wire for this feature in one place keeps the huge
 *  dashboard-events.js from having to know about the modal's
 *  internals — it just calls this one function. */
export function wireAllPositionsStatsEvents() {
  const openBtn = g("allPositionsStatsBtn");
  if (openBtn) openBtn.addEventListener("click", openAllPositionsStatsModal);
  const table = g("allPositionsStatsTable");
  if (table) {
    table.addEventListener("click", (e) => {
      const th = e.target.closest("[data-sort-col]");
      if (!th) return;
      const col = th.getAttribute("data-sort-col");
      if (col) _onSortHeaderClick(col);
    });
  }
  const closeBtn = g("allPositionsStatsCloseBtn");
  if (closeBtn) closeBtn.addEventListener("click", closeAllPositionsStatsModal);
}
