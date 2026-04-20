/**
 * @file dashboard-history.js
 * @description Renders the Per-Day P&L table (up to 31 days) and the
 * Rebalance Events table (up to 5-year lookback) on the dashboard.
 * Data is fetched from /api/status.
 *
 * Depends on: dashboard-helpers.js (g, fmtDateTime).
 */

import { g, tzCode, cloneTpl } from "./dashboard-helpers.js";
import { posStore } from "./dashboard-positions.js";

/**
 * Format a number as a USD table cell value.
 * Zero shows without sign; negative puts sign before currency symbol.
 * @param {number} val  Numeric value.
 * @returns {string}  Formatted string, e.g. "$usd 1.23" or "\u2212$usd 1.23".
 */
function _tblUsd(val) {
  if (Math.round(val * 100) === 0) return "0.00";
  const sign = val < 0 ? "\u2212" : "";
  return sign + Math.abs(val).toFixed(2);
}

const _PNL_PAGE_SIZE = 11;
const _REB_PAGE_SIZE = 8;

/** Rebalance events pagination state. */
let _rebEventsPage = 0;

/** Cached events for pagination without re-fetching. */
let _lastEvents = null;

/** Per-day P&L pagination state. */
let _pnlPage = 0,
  _lastDailyPnl = null;

const _EMDASH = "\u2014";

/** Colour class for a numeric value (pos/neg/empty for near-zero). */
function _cc(v) {
  return Math.round(v * 100) === 0 ? "" : v > 0 ? "pos" : "neg";
}

/** Render the single "no data" empty row into a tbody. */
function _renderEmptyRow(tbody, colSpan, msg) {
  const frag = cloneTpl("tplTableEmptyRow");
  if (!frag) return;
  const cell = frag.querySelector('[data-tpl="cell"]');
  cell.colSpan = colSpan;
  cell.textContent = msg;
  tbody.replaceChildren(frag);
}

/** Build a single Daily P&L row fragment from a day record. */
function _buildPnlRow(d, netVal) {
  const frag = cloneTpl("tplDailyPnlRow");
  if (!frag) return null;
  const mp = d.missingPrice || d.noData;
  const fees = d.feePnl || d.fees || 0;
  const gas = d.gasCost || d.gas || 0;
  const ilg = d.priceChangePnl || 0;
  const res = d.residual || 0;
  const profit = Math.round((fees - gas + ilg) * 100) / 100;
  const v = (val) => (mp ? _EMDASH : _tblUsd(val));
  const set = (k, val, cls) => {
    const el = frag.querySelector(`[data-tpl="${k}"]`);
    if (!el) return;
    el.textContent = val;
    if (cls) el.classList.add(cls);
  };
  set("date", d.date || _EMDASH);
  set("fees", v(fees));
  set("gas", v(gas));
  set("ilg", v(ilg), mp ? "" : _cc(ilg));
  set("profit", v(profit), mp ? "" : _cc(profit));
  set("net", v(netVal), mp ? "" : _cc(netVal));
  set("residual", v(res), mp ? "" : _cc(res));
  return frag;
}

/** True when the active position is closed (liquidity exactly 0). */
function _activeIsClosed() {
  const active = posStore.getActive();
  return (
    active && active.liquidity !== undefined && String(active.liquidity) === "0"
  );
}

/**
 * Render the per-day P&L table from daily P&L data.
 * @param {object[]} dailyPnl  Array of day records (newest first).
 */
export function renderDailyPnl(dailyPnl) {
  const tbody = g("dailyPnlBody"),
    pageLabel = g("pnlPageLabel");
  if (!tbody) return;
  if (!dailyPnl || dailyPnl.length === 0) {
    _renderEmptyRow(
      tbody,
      8,
      _activeIsClosed() ? "Position Closed" : "No P&L data yet",
    );
    _setPnlPagBtns(0, 1);
    return;
  }
  _lastDailyPnl = dailyPnl;
  const totalPages = Math.max(1, Math.ceil(dailyPnl.length / _PNL_PAGE_SIZE));
  if (_pnlPage >= totalPages) _pnlPage = totalPages - 1;
  const page = _pnlPage,
    start = page * _PNL_PAGE_SIZE;
  const slice = dailyPnl.slice(start, start + _PNL_PAGE_SIZE);
  const nets = dailyPnl.map(
    (d) =>
      (d.feePnl || d.fees || 0) +
      (d.priceChangePnl || 0) -
      (d.gasCost || d.gas || 0),
  );
  tbody.replaceChildren();
  for (let si = 0; si < slice.length; si++) {
    const frag = _buildPnlRow(slice[si], nets[start + si]);
    if (frag) tbody.appendChild(frag);
  }
  if (pageLabel)
    pageLabel.textContent = "Page " + (page + 1) + " of " + totalPages;
  _setPnlPagBtns(page, totalPages);
}

/** Update Per-Day P&L pagination button states. */
function _setPnlPagBtns(page, totalPages) {
  const prev = g("pnlPrevBtn"),
    next = g("pnlNextBtn"),
    first = g("pnlFirstBtn"),
    last = g("pnlLastBtn");
  if (prev) prev.disabled = page <= 0;
  if (first) first.disabled = page <= 0;
  if (next) next.disabled = page >= totalPages - 1;
  if (last) last.disabled = page >= totalPages - 1;
}

/** Parse an event's timestamp (dateStr preferred, else unix timestamp). */
function _eventTs(e) {
  if (e.dateStr) return new Date(e.dateStr);
  if (e.timestamp) return new Date(e.timestamp * 1000);
  return null;
}

/** Format an event timestamp into a [utc, local] pair. */
function _fmtEventTs(ts) {
  if (!ts) return [_EMDASH, ""];
  const utc = ts.toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const local =
    ts.toLocaleDateString() +
    " " +
    ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) +
    " " +
    tzCode();
  return [utc, local];
}

/** Strip the local-time span and its preceding <br> when no local time exists. */
function _clearLocalSpan(localEl) {
  const br = localEl.previousSibling;
  if (br && br.nodeName === "BR") br.remove();
  localEl.remove();
}

/** Apply the TX hash cell contents, including the copy icon or its removal. */
function _applyTxCell(frag, e, txShort) {
  const txCell = frag.querySelector('[data-tpl="txCell"]');
  if (e.txHash) txCell.setAttribute("title", e.txHash);
  const shortEl = frag.querySelector('[data-tpl="txShort"]');
  if (shortEl) shortEl.textContent = txShort;
  const copyIcon = frag.querySelector('[data-tpl="copyIcon"]');
  if (e.txHash) {
    copyIcon.setAttribute("data-copy-tx", e.txHash);
  } else {
    const space = copyIcon.previousSibling;
    if (space && space.nodeType === 3) space.remove();
    copyIcon.remove();
  }
}

/** Build a single rebalance-event row fragment. */
function _buildRebRow(e, displayIdx) {
  const frag = cloneTpl("tplRebEventRow");
  if (!frag) return null;
  const txShort = e.txHash ? e.txHash.slice(0, 10) + "\u2026" : _EMDASH;
  const [utc, local] = _fmtEventTs(_eventTs(e));
  const oldRange = e.oldRange || (e.oldTokenId ? e.oldTokenId : _EMDASH);
  const newRange = e.newRange || (e.newTokenId ? e.newTokenId : _EMDASH);
  const set = (k, val) => {
    const el = frag.querySelector(`[data-tpl="${k}"]`);
    if (el) el.textContent = val;
  };
  /*- Ignore e.index: it comes from two sources (bot-recorder's running
      counter and event-scanner's re-sort) that don't share a scheme, so
      a merged list shows 1..11 mixed with 73..85. Assign a single
      chronological index here so the UI is always consistent. */
  set(
    "index",
    displayIdx !== null && displayIdx !== undefined
      ? displayIdx
      : e.index || "",
  );
  set("utc", utc);
  const localEl = frag.querySelector('[data-tpl="local"]');
  if (local) localEl.textContent = local;
  else _clearLocalSpan(localEl);
  set("oldRange", oldRange);
  set("newRange", newRange);
  set("swap", e.swapSources || _EMDASH);
  _applyTxCell(frag, e, txShort);
  return frag;
}

/** Update Rebalance Events pagination button states. */
function _setRebPagBtns(page, totalPages) {
  const prev = g("rebPrevBtn"),
    next = g("rebNextBtn"),
    first = g("rebFirstBtn"),
    last = g("rebLastBtn");
  if (prev) prev.disabled = page <= 0;
  if (first) first.disabled = page <= 0;
  if (next) next.disabled = page >= totalPages - 1;
  if (last) last.disabled = page >= totalPages - 1;
}

/**
 * Render the rebalance events table with pagination.
 * Uses data attributes for copy-icon event delegation instead of inline onclick.
 * @param {object[]} events  All rebalance events (oldest first).
 */
export function renderRebalanceEvents(events) {
  _lastEvents = events;
  const tbody = g("rebEventsBody");
  const pageLabel = g("rebPageLabel");
  if (!tbody) return;

  if (!events || events.length === 0) {
    const msg = _activeIsClosed()
      ? "Position Closed"
      : "No rebalance events found";
    _renderEmptyRow(tbody, 6, msg);
    if (pageLabel) pageLabel.textContent = "Page 1 of 1";
    _setRebPagBtns(0, 1);
    return;
  }

  const sorted = [...events].sort(
    (a, b) => (b.timestamp || 0) - (a.timestamp || 0),
  );
  const totalPages = Math.max(1, Math.ceil(sorted.length / _REB_PAGE_SIZE));
  _rebEventsPage = Math.min(_rebEventsPage, totalPages - 1);
  const page = _rebEventsPage;
  const start = page * _REB_PAGE_SIZE;
  const pageEvents = sorted.slice(start, start + _REB_PAGE_SIZE);
  const total = sorted.length;

  tbody.replaceChildren();
  for (let i = 0; i < pageEvents.length; i++) {
    /*- displayIdx: oldest = 1, newest = total. sorted is descending, so
        position (start + i) has index (total - start - i). */
    const displayIdx = total - start - i;
    const frag = _buildRebRow(pageEvents[i], displayIdx);
    if (frag) tbody.appendChild(frag);
  }
  if (pageLabel)
    pageLabel.textContent = "Page " + (page + 1) + " of " + totalPages;
  _setRebPagBtns(page, totalPages);
}

/**
 * Navigate rebalance events pages.
 * @param {number} dir  +1 for next, -1 for previous.
 */
export function rebChangePage(dir) {
  _rebEventsPage += dir;
  if (_lastEvents) renderRebalanceEvents(_lastEvents);
}
export function rebFirstPage() {
  _rebEventsPage = 0;
  if (_lastEvents) renderRebalanceEvents(_lastEvents);
}
export function rebLastPage() {
  _rebEventsPage = 9999;
  if (_lastEvents) renderRebalanceEvents(_lastEvents);
}

export function pnlChangePage(dir) {
  _pnlPage += dir;
  if (_lastDailyPnl) renderDailyPnl(_lastDailyPnl);
}
export function pnlFirstPage() {
  _pnlPage = 0;
  if (_lastDailyPnl) renderDailyPnl(_lastDailyPnl);
}
export function pnlLastPage() {
  _pnlPage = 9999;
  if (_lastDailyPnl) renderDailyPnl(_lastDailyPnl);
}

/**
 * Called by dashboard-data.js after each status poll to update history tables.
 * @param {object} data  Status response.
 */
export function updateHistoryFromStatus(data) {
  const dailyPnl = data.pnlSnapshot?.dailyPnl || data.dailyPnl;
  if (dailyPnl) renderDailyPnl(dailyPnl);
  if (data.rebalanceEvents) renderRebalanceEvents(data.rebalanceEvents);
}

/**
 * Clear both history tables and reset pagination.
 * Called when the active wallet changes to prevent stale data display.
 */
/**
 * Update the per-panel "Syncing..." labels for history tables.
 * @param {object} d  Flattened status data.
 */
export function updateHistorySyncLabels(d) {
  const active = posStore.getActive();
  const managed =
    active &&
    d._managedPositions &&
    d._managedPositions.some(
      (m) => String(m.tokenId) === String(active.tokenId),
    );
  const ok = !managed || d.rebalanceScanComplete === true;
  const p = d.rebalanceScanProgress || 0;
  const l = ok ? "" : p > 5 ? "Syncing\u2026 " + p + "%" : "Syncing\u2026";
  const a = g("dailyPnlSync");
  const b = g("rebEventsSync");
  if (a) a.textContent = l;
  if (b) b.textContent = l;
}
export function clearHistory() {
  _lastEvents = null;
  _rebEventsPage = 0;
  renderDailyPnl(null);
  renderRebalanceEvents([]);
}
