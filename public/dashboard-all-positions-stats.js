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
 *
 *   Type discipline: every presence test uses explicit
 *   `x === null || x === undefined` rather than `!x` or `x || default`
 *   so 0 / "" / false never coerce into the fallback path.  Numeric
 *   defaulting uses `??` (nullish coalescing), not `||`, for the same
 *   reason.
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
import { ltStartDate } from "./dashboard-date-utils.js";

/*- Track last-applied {disabled, title} so we don't touch the DOM on
 *  every 3-second poll when nothing has changed.  Prevents needless
 *  reflow + prevents the browser from re-arming the tooltip timer. */
let _lastButtonState = { disabled: null, title: null };

/*- Modal open flag + sort state.  Sort defaults to Lifetime P&L DESC
 *  per the design.  Clicking the current column toggles direction;
 *  clicking a different column jumps to DESC on that column.
 *  `_showPerDay` toggles the per-day normalization: when true, every
 *  numeric column is divided by the number of days the position has
 *  been alive (same "Lifetime" span the KPI panel uses).  Off by
 *  default; not persisted across sessions per user preference. */
let _isOpen = false;
let _sortCol = "ltNetPnl";
let _sortDir = "desc";
let _showPerDay = false;

/*- Return a finite number or the fallback.  Explicit type + finiteness
 *  check instead of `x || default`, which would coerce 0 / NaN / ""
 *  into the fallback path — legitimate 0 values (e.g. no fees earned
 *  yet) would otherwise get quietly promoted to the default and skew
 *  the totals. */
function _num(v, fallback) {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/*- Truncate a string to at most `max` characters, appending an
 *  ellipsis when trimmed.  Used for the row-identity cell:
 *    - token symbols: max 6  ("token pair truncated to six characters each with an ellipsis")
 *    - LP provider display name: max 6
 *    - blockchain display name: max 18
 *  Explicit null/undefined check rather than `s || "?"` so an empty-
 *  string input renders as "" (not "?"), reserving "?" for genuinely-
 *  missing values. */
function _trunc(s, max) {
  if (s === null || s === undefined) return "?";
  if (typeof s !== "string") return "?";
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/*- Fee in basis-points-times-100 (e.g. 2500 for 0.25%) → display
 *  string like "0.25%".  Returns "0.00%" for anything non-numeric
 *  instead of silently coercing via Number(). */
function _feePct(fee) {
  if (typeof fee !== "number" || !Number.isFinite(fee)) return "0.00%";
  return (fee / 10000).toFixed(2) + "%";
}

/*- Format a signed USD amount with 2 decimals and thousands sep.
 *  Returns "—" for null/undefined/non-finite so we don't render "$NaN". */
function _fmtUsd(n) {
  if (n === null || n === undefined) return "—";
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}$${abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/*- Days between the position's Lifetime start (per `ltStartDate` —
 *  same source the Lifetime panel uses) and `now`.  Returns null
 *  when no start date is available OR when the span is not a
 *  positive number of days (guards against div-by-zero and negative
 *  denominators from a future-dated start).  Injectable `now` so
 *  tests can drive it deterministically without freezing Date. */
export function daysAliveFor(posState, now) {
  const startDate = ltStartDate(posState);
  if (typeof startDate !== "string" || startDate.length < 10) return null;
  const startMs = Date.parse(startDate + "T00:00:00Z");
  if (!Number.isFinite(startMs)) return null;
  const days = (now - startMs) / 86400000;
  return Number.isFinite(days) && days > 0 ? days : null;
}

/*- Divide a numerics bundle (`{ ltNetPnl, ltProfit, ltIL }`) by
 *  `days` when per-day mode is on AND we have a positive span.
 *  Falls back to the raw bundle otherwise so the toggle-off path is
 *  a strict pass-through.  Pure — no module state read. */
export function applyPerDay(nums, showPerDay, days) {
  if (!showPerDay) return nums;
  if (days === null || days === undefined || days <= 0) return nums;
  return {
    ltNetPnl: nums.ltNetPnl / days,
    ltProfit: nums.ltProfit / days,
    ltIL: nums.ltIL / days,
  };
}

/*- Compute the three sortable numerics (ltNetPnl, ltProfit, ltIL)
 *  from a pnlSnapshot + realized-gains override + lifetime deposit.
 *  Mirror of the formulas the Lifetime panel uses in
 *  dashboard-data-kpi._resolveKpiTotals — applied per row here
 *  instead of only to the active position.  All `?? 0` defaults use
 *  nullish coalescing so a legitimate 0 (e.g. no fees yet) stays 0
 *  instead of coercing through `||`. */
function _computeNumerics(snap, ltRealized, ltDep) {
  const currentValue = _num(snap.currentValue, 0);
  const ltPc = ltDep > 0 ? currentValue - ltDep : 0;
  const compounded = _num(snap.totalCompoundedUsd, 0);
  const ltCurrentFees = _num(snap.currentFeesUsd, 0);
  const ltGas = _num(snap.totalGas, 0);
  const ltResidual = _num(snap.residualValueUsd, 0);
  const ltInitialResidual = _num(snap.initialResidualUsd, 0);
  const il = _num(snap.lifetimeIL ?? snap.totalIL, 0);
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
  const ap = posState.activePosition;
  const snap = posState.pnlSnapshot;
  if (ap === null || ap === undefined) return null;
  if (snap === null || snap === undefined) return null;
  if (typeof ap.liquidity !== "string") return null;
  const liq = parseFloat(ap.liquidity);
  if (!Number.isFinite(liq) || liq <= 0) return null;
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
    ltDepOverride > 0 ? ltDepOverride : _num(snap.totalLifetimeDeposit, 0);
  const rawNums = _computeNumerics(snap, ltRealized, ltDep);
  const days = daysAliveFor(posState, Date.now());
  const nums = applyPerDay(rawNums, _showPerDay, days);
  const lpName =
    getProviderDisplayName(globalCtx.factory, globalCtx.positionManager) ??
    getProviderLabel(globalCtx.positionManager) ??
    "?";
  return {
    key,
    blockchainDisplayName: globalCtx.chainDisplayName ?? "PulseChain",
    blockchainId: globalCtx.chainId ?? "pulsechain",
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
  if (data === null || data === undefined) return [];
  const positions = data._allPositionStates ?? {};
  const globalCtx = {
    walletAddress: data.walletAddress,
    factory: data.factory,
    positionManager: data.positionManager,
    /*- Two distinct fields: the display name goes into the row's
     *  identity cell for user-facing text, the id goes into the deep-
     *  link URL slug.  Never derive one from the other with
     *  toLowerCase() — that conflates the ID-vs-displayName concepts
     *  we're intentionally keeping separate everywhere else. */
    chainDisplayName: data.chainDisplayName,
    chainId: data.chainId,
  };
  const rows = [];
  for (const key of Object.keys(positions)) {
    const p = positions[key];
    if (p === null || p === undefined) continue;
    if (p.status !== "running") continue;
    const row = _computeRow(key, p, globalCtx);
    if (row !== null) rows.push(row);
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

/*- Return a lower-cased string for a URL slot, or an empty string
 *  when the value isn't a string.  Explicit type check so a non-
 *  string doesn't reach .toLowerCase() (would throw) and doesn't
 *  coerce via `|| ""` (would strip legitimate 0-length input from a
 *  future different code path). */
function _lcSlot(v) {
  return typeof v === "string" ? v.toLowerCase() : "";
}

/*- Deep-link URL for the row's position.  Uses the canonical chain
 *  id (KEY of chains.json) as the URL slug — NOT the display name.
 *  Wallet and contract addresses are lower-cased to match the URLs
 *  the router emits everywhere else in the app (the router
 *  canonicalises on read). */
function _positionHref(row) {
  const chain =
    typeof row.blockchainId === "string" && row.blockchainId.length > 0
      ? row.blockchainId
      : "pulsechain";
  const wallet = _lcSlot(row.walletAddress);
  const contract = _lcSlot(row.contractAddress);
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
  pair.textContent = `${_trunc(row.symbol0, 6)} / ${_trunc(row.symbol1, 6)}`;
  const meta = document.createElement("div");
  meta.className = "9mm-pos-mgr-all-positions-meta";
  meta.textContent = `${row.feePct} · ${_trunc(row.lpProviderName, 6)}`;
  const chain = document.createElement("div");
  chain.className = "9mm-pos-mgr-all-positions-meta";
  chain.textContent = _trunc(row.blockchainDisplayName, 18);
  wrap.appendChild(pair);
  wrap.appendChild(meta);
  wrap.appendChild(chain);
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
  if (tbody === null) return;
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
    a.textContent = "Position";
    a.title = `Navigate to NFT #${row.tokenId}`;
    gotoTd.appendChild(a);
    tr.appendChild(gotoTd);
    tbody.appendChild(tr);
  }
  if (empty !== null) empty.hidden = rows.length > 0;
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

/*- Pure decision from a poll payload: how many running positions
 *  are there, and how many are scan-complete + pnlSnapshot-ready?
 *  Extracted so the mirror-test can drive it directly without the
 *  DOM-write side effect. */
function _countReadiness(data) {
  const positions = data?._allPositionStates ?? {};
  let total = 0;
  let ready = 0;
  for (const key of Object.keys(positions)) {
    const p = positions[key];
    if (p === null || p === undefined) continue;
    if (p.status !== "running") continue;
    total += 1;
    if (
      p.rebalanceScanComplete === true &&
      p.lifetimeScanComplete === true &&
      p.pnlSnapshot !== null &&
      p.pnlSnapshot !== undefined
    )
      ready += 1;
  }
  return { total, ready };
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
  if (btn !== null) {
    const { total, ready } = _countReadiness(data);
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
  if (overlay === null) return;
  _isOpen = true;
  overlay.classList.remove("hidden");
  _renderTable(getLastStatus());
  overlay.addEventListener("click", _onBackdropClick);
  log.info("[all-positions-stats] modal opened");
}

/** Hide the modal, tear down per-open listeners. */
export function closeAllPositionsStatsModal() {
  const overlay = g("allPositionsStatsModal");
  if (overlay === null) return;
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
  if (openBtn !== null)
    openBtn.addEventListener("click", openAllPositionsStatsModal);
  const table = g("allPositionsStatsTable");
  if (table !== null) {
    table.addEventListener("click", (e) => {
      const th = e.target.closest("[data-sort-col]");
      if (th === null) return;
      const col = th.getAttribute("data-sort-col");
      if (col === null || col.length === 0) return;
      _onSortHeaderClick(col);
    });
  }
  const closeBtn = g("allPositionsStatsCloseBtn");
  if (closeBtn !== null)
    closeBtn.addEventListener("click", closeAllPositionsStatsModal);
  const perDayToggle = g("allPositionsStatsPerDayToggle");
  if (perDayToggle !== null)
    perDayToggle.addEventListener("change", (e) => {
      _showPerDay = e.target.checked === true;
      log.info("[all-positions-stats] Show Per-Day = %s", _showPerDay);
      _renderTable(getLastStatus());
    });
}
