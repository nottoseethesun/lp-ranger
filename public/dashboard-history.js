/**
 * @file dashboard-history.js
 * @description Renders the Per-Day P&L table (up to 31 days) and the
 * Rebalance Events table (up to 5-year lookback) on the dashboard.
 * Data is fetched from /api/status.
 *
 * Depends on: dashboard-helpers.js (g, fmtDateTime).
 */

import { g, tzCode } from "./dashboard-helpers.js";
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
const _REB_PAGE_SIZE = 4;

/** Rebalance events pagination state. */
let _rebEventsPage = 0;

/** Cached events for pagination without re-fetching. */
let _lastEvents = null;

/** Per-day P&L pagination state. */
let _pnlPage = 0,
  _lastDailyPnl = null;

/**
 * Render the per-day P&L table from daily P&L data.
 * @param {object[]} dailyPnl  Array of day records (newest first).
 */
export function renderDailyPnl(dailyPnl) {
  const tbody = g("dailyPnlBody"),
    pageLabel = g("pnlPageLabel");
  if (!tbody) return;
  if (!dailyPnl || dailyPnl.length === 0) {
    const active = posStore.getActive();
    const closed =
      active &&
      active.liquidity !== undefined &&
      String(active.liquidity) === "0";
    tbody.innerHTML =
      '<tr><td colspan="8" class="9mm-pos-mgr-table-empty">' +
      (closed ? "Position Closed" : "No P&L data yet") +
      "</td></tr>";
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
  const _d = "\u2014";
  tbody.innerHTML = slice
    .map((d, si) => {
      const i = start + si,
        mp = d.missingPrice || d.noData,
        fees = d.feePnl || d.fees || 0,
        gas = d.gasCost || d.gas || 0,
        ilg = d.priceChangePnl || 0,
        res = d.residual || 0;
      const profit = Math.round((fees - gas + ilg) * 100) / 100;
      const cc = (v) =>
        Math.round(v * 100) === 0 ? "" : v > 0 ? "pos" : "neg";
      const v = (val) => (mp ? _d : _tblUsd(val));
      return (
        "<tr><td>" +
        (d.date || _d) +
        "</td><td>" +
        v(fees) +
        "</td>" +
        "<td>" +
        v(gas) +
        '</td><td class="9mm-pos-mgr-text-right ' +
        (mp ? "" : cc(ilg)) +
        '">' +
        v(ilg) +
        "</td>" +
        '<td class="9mm-pos-mgr-text-right ' +
        (mp ? "" : cc(profit)) +
        '">' +
        v(profit) +
        "</td>" +
        '<td class="9mm-pos-mgr-text-right ' +
        (mp ? "" : cc(nets[i])) +
        '">' +
        v(nets[i]) +
        '</td><td class="9mm-pos-mgr-text-right ' +
        (mp ? "" : cc(res)) +
        '">' +
        v(res) +
        "</td></tr>"
      );
    })
    .join("");
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

/**
 * Render the rebalance events table with pagination.
 * Uses data attributes for copy-icon event delegation instead of inline onclick.
 * @param {object[]} events  All rebalance events (oldest first).
 */
export function renderRebalanceEvents(events) {
  _lastEvents = events;
  const tbody = g("rebEventsBody");
  const pageLabel = g("rebPageLabel");
  const prevBtn = g("rebPrevBtn"),
    nextBtn = g("rebNextBtn"),
    firstBtn = g("rebFirstBtn"),
    lastBtn = g("rebLastBtn");
  if (!tbody) return;

  if (!events || events.length === 0) {
    const active = posStore.getActive();
    const closed =
      active &&
      active.liquidity !== undefined &&
      String(active.liquidity) === "0";
    const msg = closed ? "Position Closed" : "No rebalance events found";
    tbody.innerHTML =
      '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:12px;">' +
      msg +
      "</td></tr>";
    if (pageLabel) pageLabel.textContent = "Page 1 of 1";
    if (prevBtn) prevBtn.disabled = true;
    if (nextBtn) nextBtn.disabled = true;
    if (firstBtn) firstBtn.disabled = true;
    if (lastBtn) lastBtn.disabled = true;
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

  const rows = pageEvents.map((e) => {
    const txShort = e.txHash ? e.txHash.slice(0, 10) + "\u2026" : "—";
    const ts = e.dateStr
      ? new Date(e.dateStr)
      : e.timestamp
        ? new Date(e.timestamp * 1000)
        : null;
    const utc = ts
      ? ts.toISOString().slice(0, 16).replace("T", " ") + " UTC"
      : "—";
    const local = ts
      ? ts.toLocaleDateString() +
        " " +
        ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) +
        " " +
        tzCode()
      : "";
    const oldRange = e.oldRange || (e.oldTokenId ? e.oldTokenId : "\u2014");
    const newRange = e.newRange || (e.newTokenId ? e.newTokenId : "\u2014");
    return (
      "<tr>" +
      "<td>" +
      (e.index || "") +
      "</td>" +
      '<td data-privacy="blur">' +
      utc +
      (local
        ? '<br><span class="9mm-pos-mgr-text-muted-sm">' + local + "</span>"
        : "") +
      "</td>" +
      '<td data-privacy="blur">' +
      oldRange +
      "</td>" +
      '<td data-privacy="blur">' +
      newRange +
      "</td>" +
      "<td>" +
      (e.swapSources || "\u2014") +
      "</td>" +
      '<td data-privacy="blur" title="' +
      (e.txHash || "") +
      '">' +
      txShort +
      (e.txHash
        ? ' <span class="9mm-pos-mgr-copy-icon" data-copy-tx="' +
          e.txHash +
          '" title="Copy full TX hash">&#x274F;</span>'
        : "") +
      "</td>" +
      "</tr>"
    );
  });

  tbody.innerHTML = rows.join("");
  if (pageLabel)
    pageLabel.textContent = "Page " + (page + 1) + " of " + totalPages;
  if (prevBtn) prevBtn.disabled = page <= 0;
  if (firstBtn) firstBtn.disabled = page <= 0;
  if (nextBtn) nextBtn.disabled = page >= totalPages - 1;
  if (lastBtn) lastBtn.disabled = page >= totalPages - 1;
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
