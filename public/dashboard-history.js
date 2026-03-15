/**
 * @file dashboard-history.js
 * @description Renders the Per-Day P&L table (up to 31 days) and the
 * Rebalance Events table (up to 5-year lookback) on the dashboard.
 * Data is fetched from /api/status.
 *
 * Depends on: dashboard-helpers.js (g).
 */

/* global g, _lastStatus, fmtDateTime */
'use strict';

/** Rebalance events pagination state. */
let _rebEventsPage = 0;
const _REB_PAGE_SIZE = 20;

/**
 * Render the per-day P&L table from daily P&L data.
 * @param {object[]} dailyPnl  Array of day records (newest first).
 */
function renderDailyPnl(dailyPnl) {
  const tbody = g('dailyPnlBody');
  if (!tbody) return;

  if (!dailyPnl || dailyPnl.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:12px;">No P&L data yet</td></tr>';
    return;
  }

  let cumulative = 0;
  const rows = dailyPnl.slice(0, 31).map(d => {
    const pricePnl = d.priceChangePnl || 0;
    const net = (d.feePnl || d.fees || 0) + pricePnl - (d.gasCost || d.gas || 0);
    cumulative += net;
    const netCls = net >= 0 ? 'pos' : 'neg';
    const cumCls = cumulative >= 0 ? 'pos' : 'neg';
    const pCls   = pricePnl >= 0 ? 'pos' : 'neg';
    return '<tr>' +
      '<td>' + (d.date || '—') + '</td>' +
      '<td>$' + (d.feePnl || d.fees || 0).toFixed(2) + '</td>' +
      '<td>$' + (d.gasCost || d.gas || 0).toFixed(2) + '</td>' +
      '<td class="' + pCls + '">$' + pricePnl.toFixed(2) + '</td>' +
      '<td class="' + netCls + '">$' + net.toFixed(2) + '</td>' +
      '<td class="' + cumCls + '">$' + cumulative.toFixed(2) + '</td>' +
      '</tr>';
  });

  tbody.innerHTML = rows.join('');
}

/**
 * Render the rebalance events table with pagination.
 * @param {object[]} events  All rebalance events (oldest first).
 */
function renderRebalanceEvents(events) {
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

  const totalPages = Math.max(1, Math.ceil(events.length / _REB_PAGE_SIZE));
  _rebEventsPage = Math.min(_rebEventsPage, totalPages - 1);
  const page = _rebEventsPage;
  const start = page * _REB_PAGE_SIZE;
  const pageEvents = events.slice(start, start + _REB_PAGE_SIZE);

  const rows = pageEvents.map(e => {
    const txShort = e.txHash ? e.txHash.slice(0, 10) + '\u2026' : '—';
    const time = e.dateStr || fmtDateTime(e.timestamp ? e.timestamp * 1000 : e.loggedAt);
    const oldRange = e.oldRange || (e.oldTokenId ? 'ID ' + e.oldTokenId : '—');
    const newRange = e.newRange || (e.newTokenId ? 'ID ' + e.newTokenId : '—');
    return '<tr>' +
      '<td>' + (e.index || '') + '</td>' +
      '<td>' + time + '</td>' +
      '<td>' + oldRange + '</td>' +
      '<td>' + newRange + '</td>' +
      '<td title="' + (e.txHash || '') + '">' + txShort +
        (e.txHash ? ' <span class="9mm-pos-mgr-copy-icon" onclick="navigator.clipboard.writeText(\'' + e.txHash + '\')" title="Copy full TX hash">&#x1F4CB;</span>' : '') +
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
function rebChangePage(dir) {
  _rebEventsPage += dir;
  if (_lastStatus && _lastStatus.rebalanceEvents) {
    renderRebalanceEvents(_lastStatus.rebalanceEvents);
  }
}

/**
 * Called by dashboard-data.js after each status poll to update history tables.
 * @param {object} data  Status response.
 */
function updateHistoryFromStatus(data) {
  if (data.dailyPnl) renderDailyPnl(data.dailyPnl);
  if (data.rebalanceEvents) renderRebalanceEvents(data.rebalanceEvents);
}
