/**
 * @file dashboard-history.js
 * @description Renders the Per-Day P&L table (up to 31 days) and the
 * Rebalance Events table (up to 5-year lookback) on the dashboard.
 * Data is fetched from /api/status.
 *
 * Depends on: dashboard-helpers.js (g, fmtDateTime).
 */

import { g, tzCode } from './dashboard-helpers.js';

/**
 * Format a number as a USD table cell value.
 * Zero shows without sign; negative puts sign before currency symbol.
 * @param {number} val  Numeric value.
 * @returns {string}  Formatted string, e.g. "$usd 1.23" or "\u2212$usd 1.23".
 */
function _tblUsd(val) {
  if (Math.round(val * 100) === 0) return '0.00';
  const sign = val < 0 ? '\u2212' : '';
  return sign + Math.abs(val).toFixed(2);
}

const _PAGE_SIZE = 8;

/** Rebalance events pagination state. */
let _rebEventsPage = 0;

/** Cached events for pagination without re-fetching. */
let _lastEvents = null;

/** Per-day P&L pagination state. */
let _pnlPage = 0, _lastDailyPnl = null;

/**
 * Render the per-day P&L table from daily P&L data.
 * @param {object[]} dailyPnl  Array of day records (newest first).
 */
export function renderDailyPnl(dailyPnl) {
  const tbody = g('dailyPnlBody'), pageLabel = g('pnlPageLabel');
  if (!tbody) return;
  if (!dailyPnl || dailyPnl.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="9mm-pos-mgr-table-empty">No P&L data yet</td></tr>';
    _setPnlPagBtns(0, 1); return;
  }
  _lastDailyPnl = dailyPnl;
  const totalPages = Math.max(1, Math.ceil(dailyPnl.length / _PAGE_SIZE));
  if (_pnlPage >= totalPages) _pnlPage = totalPages - 1;
  const page = _pnlPage, start = page * _PAGE_SIZE;
  const slice = dailyPnl.slice(start, start + _PAGE_SIZE);
  // Compute net + cumulative over the FULL array, then render only the page slice
  const nets = dailyPnl.map(d => (d.feePnl || d.fees || 0) + (d.priceChangePnl || 0) - (d.gasCost || d.gas || 0));
  const cums = new Array(nets.length); let cum = 0;
  for (let i = nets.length - 1; i >= 0; i--) { cum += nets[i]; cums[i] = cum; }
  tbody.innerHTML = slice.map((d, si) => {
    const i = start + si, fees = d.feePnl || d.fees || 0, gas = d.gasCost || d.gas || 0, ilg = d.priceChangePnl || 0;
    const profit = Math.round((fees - gas + ilg) * 100) / 100;
    const cc = (v) => Math.round(v * 100) === 0 ? '' : v > 0 ? 'pos' : 'neg';
    return '<tr><td>' + (d.date || '—') + '</td><td>' + _tblUsd(fees) + '</td>' +
      '<td>' + _tblUsd(gas) + '</td><td class="' + cc(ilg) + '">' + _tblUsd(ilg) + '</td>' +
      '<td class="' + cc(profit) + '">' + _tblUsd(profit) + '</td>' +
      '<td class="' + cc(nets[i]) + '">' + _tblUsd(nets[i]) + '</td><td class="' + cc(cums[i]) + '">' + _tblUsd(cums[i]) + '</td></tr>';
  }).join('');
  if (pageLabel) pageLabel.textContent = 'Page ' + (page + 1) + ' of ' + totalPages;
  _setPnlPagBtns(page, totalPages);
}

/** Update Per-Day P&L pagination button states. */
function _setPnlPagBtns(page, totalPages) {
  const prev = g('pnlPrevBtn'), next = g('pnlNextBtn');
  if (prev) prev.disabled = page <= 0;
  if (next) next.disabled = page >= totalPages - 1;
}

/**
 * Render the rebalance events table with pagination.
 * Uses data attributes for copy-icon event delegation instead of inline onclick.
 * @param {object[]} events  All rebalance events (oldest first).
 */
export function renderRebalanceEvents(events) {
  _lastEvents = events;
  const tbody = g('rebEventsBody');
  const pageLabel = g('rebPageLabel');
  const prevBtn = g('rebPrevBtn');
  const nextBtn = g('rebNextBtn');
  if (!tbody) return;

  if (!events || events.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:12px;">No rebalance events found</td></tr>';
    if (pageLabel) pageLabel.textContent = 'Page 1 of 1';
    if (prevBtn) prevBtn.disabled = true;
    if (nextBtn) nextBtn.disabled = true;
    return;
  }

  const sorted = [...events].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  const totalPages = Math.max(1, Math.ceil(sorted.length / _PAGE_SIZE));
  _rebEventsPage = Math.min(_rebEventsPage, totalPages - 1);
  const page = _rebEventsPage;
  const start = page * _PAGE_SIZE;
  const pageEvents = sorted.slice(start, start + _PAGE_SIZE);

  const rows = pageEvents.map(e => {
    const txShort = e.txHash ? e.txHash.slice(0, 10) + '\u2026' : '—';
    const ts = e.dateStr ? new Date(e.dateStr) : e.timestamp ? new Date(e.timestamp * 1000) : null;
    const utc = ts ? ts.toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '—';
    const local = ts ? ts.toLocaleDateString() + ' ' + ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' ' + tzCode() : '';
    const oldRange = e.oldRange || (e.oldTokenId ? 'ID ' + e.oldTokenId : '—');
    const newRange = e.newRange || (e.newTokenId ? 'ID ' + e.newTokenId : '—');
    return '<tr>' +
      '<td>' + (e.index || '') + '</td>' +
      '<td data-privacy="blur">' + utc + (local ? '<br><span class="9mm-pos-mgr-text-muted-sm">' + local + '</span>' : '') + '</td>' +
      '<td data-privacy="blur">' + oldRange + '</td>' +
      '<td data-privacy="blur">' + newRange + '</td>' +
      '<td data-privacy="blur" title="' + (e.txHash || '') + '">' + txShort +
        (e.txHash ? ' <span class="9mm-pos-mgr-copy-icon" data-copy-tx="' + e.txHash + '" title="Copy full TX hash">&#x274F;</span>' : '') +
      '</td>' +
      '</tr>';
  });

  tbody.innerHTML = rows.join('');
  if (pageLabel) pageLabel.textContent = 'Page ' + (page + 1) + ' of ' + totalPages;
  if (prevBtn) prevBtn.disabled = page <= 0;
  if (nextBtn) nextBtn.disabled = page >= totalPages - 1;
}

/**
 * Navigate rebalance events pages.
 * @param {number} dir  +1 for next, -1 for previous.
 */
export function rebChangePage(dir) {
  _rebEventsPage += dir;
  if (_lastEvents) renderRebalanceEvents(_lastEvents);
}

/** Navigate Per-Day P&L table pages. */
export function pnlChangePage(dir) {
  _pnlPage += dir;
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
export function clearHistory() {
  _lastEvents = null;
  _rebEventsPage = 0;
  renderDailyPnl(null);
  renderRebalanceEvents([]);
}
