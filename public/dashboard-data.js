/**
 * @file dashboard-data.js
 * @description Polls /api/status and updates all live UI elements on the
 * 9mm v3 Position Manager dashboard.  Replaces placeholder values with
 * real data from the bot backend.
 *
 * Depends on: dashboard-helpers.js (g, botConfig, fmtMs).
 */

/* global g, botConfig, updateHistoryFromStatus, fmtDateTime, posStore,
          updatePosStripUI, act, _9mmPositionMgr */
'use strict';

/** Polling interval handle. */
let _dataTimerId = null;

/** Last known status data (for other modules to read). */
let _lastStatus = null;

/** Whether historical rebalance events have been populated in the Activity Log. */
let _historyPopulated = false;

// ── Realized gains (user-entered, persisted in localStorage) ────────────────

const _REALIZED_GAINS_KEY = '9mm_realized_gains';

/** Load realized gains from localStorage. */
function loadRealizedGains() {
  try {
    const v = parseFloat(localStorage.getItem(_REALIZED_GAINS_KEY));
    return Number.isFinite(v) && v >= 0 ? v : 0;
  } catch { return 0; }
}

/** Toggle the realized gains input field visibility. */
function toggleRealizedInput() {
  const wrap = g('realizedGainsInputWrap');
  if (!wrap) return;
  const show = wrap.style.display === 'none';
  wrap.style.display = show ? 'flex' : 'none';
  if (show) {
    const inp = g('realizedGainsInput');
    if (inp) { inp.value = loadRealizedGains() || ''; inp.focus(); }
  }
}

/** Save realized gains to localStorage and update the display. */
function saveRealizedGains() {
  const inp = g('realizedGainsInput');
  if (!inp) return;
  const val = parseFloat(inp.value);
  const amount = Number.isFinite(val) && val >= 0 ? val : 0;
  try { localStorage.setItem(_REALIZED_GAINS_KEY, String(amount)); } catch { /* private mode */ }
  _setPnlVal('pnlRealized', amount);
  const wrap = g('realizedGainsInputWrap');
  if (wrap) wrap.style.display = 'none';
  // Re-render P&L with updated realized gains
  if (_lastStatus) _updateKpis(_lastStatus);
}

// ── Initial deposit (user-entered, persisted in localStorage) ────────────────

const _INITIAL_DEPOSIT_KEY = '9mm_initial_deposit';

/** Load initial deposit from localStorage. */
function loadInitialDeposit() {
  try {
    const v = parseFloat(localStorage.getItem(_INITIAL_DEPOSIT_KEY));
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch { return 0; }
}

/** Update the initial deposit label to reflect the saved value. */
function _refreshDepositLabel() {
  const label = g('initialDepositLabel');
  if (!label) return;
  const saved = loadInitialDeposit();
  label.textContent = saved > 0 ? 'Initial deposit: $' + saved.toFixed(2) : 'Edit initial deposit';
}

/** Toggle the initial deposit input field visibility. */
function toggleInitialDeposit() {
  const wrap = g('initialDepositInputWrap');
  if (!wrap) return;
  const show = wrap.style.display === 'none';
  wrap.style.display = show ? 'flex' : 'none';
  if (show) {
    const inp = g('initialDepositInput');
    if (inp) { inp.value = loadInitialDeposit() || ''; inp.focus(); }
  }
}

/** Save initial deposit to localStorage + server and update the display. */
function saveInitialDeposit() {
  const inp = g('initialDepositInput');
  if (!inp) return;
  const val = parseFloat(inp.value);
  const amount = Number.isFinite(val) && val > 0 ? val : 0;
  try { localStorage.setItem(_INITIAL_DEPOSIT_KEY, String(amount)); } catch { /* private mode */ }
  fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ initialDepositUsd: amount }) }).catch(() => {});
  const wrap = g('initialDepositInputWrap');
  if (wrap) wrap.style.display = 'none';
  _refreshDepositLabel();
  if (_lastStatus) _updateKpis(_lastStatus);
}

/** Track whether the error modal is already visible to avoid duplicates. */
let _errorModalShown = false;

/**
 * Show an informational modal when rebalance has been failing for over 1 hour.
 * @param {string|null} message  Error message from the bot.
 */
function _showRebalanceErrorModal(message) {
  if (_errorModalShown || !message) return;
  _errorModalShown = true;

  const overlay = document.createElement('div');
  overlay.className = '9mm-pos-mgr-modal-overlay';
  overlay.innerHTML =
    '<div class="9mm-pos-mgr-modal">' +
    '<h3>Rebalance Paused</h3>' +
    '<p>' + message + '</p>' +
    '<p class="9mm-pos-mgr-text-muted">The bot has been unable to rebalance for over 1 hour. ' +
    'Check the server logs for details. You may need to rebalance manually or adjust slippage settings.</p>' +
    '<button class="9mm-pos-mgr-modal-close" onclick="this.closest(\'.9mm-pos-mgr-modal-overlay\').remove()">OK</button>' +
    '</div>';
  document.body.appendChild(overlay);
}

/**
 * Format a number as USD.
 * @param {number} val
 * @returns {string}
 */
function _fmtUsd(val) {
  if (val === null || val === undefined || isNaN(val)) return '—';
  const abs = Math.abs(val).toFixed(2);
  if (abs === '0.00') return '$usd 0.00';
  const sign = val > 0 ? '+' : '-';
  return sign + '$usd ' + abs;
}

/**
 * Check if a value rounds to zero at 2 decimal places.
 * @param {number} val
 * @returns {boolean}
 */
function _isDisplayZero(val) {
  return Math.abs(val).toFixed(2) === '0.00';
}

/**
 * Apply a sign-colored CSS class to a P&L breakdown value span.
 * @param {string} id   Element ID.
 * @param {number} val  Numeric value.
 */
function _setPnlVal(id, val) {
  const el = g(id);
  if (!el) return;
  el.textContent = _fmtUsd(val);
  el.className = _isDisplayZero(val) ? '9mm-pos-mgr-pnl-val-neu'
    : val > 0 ? '9mm-pos-mgr-pnl-val-pos'
      : val < 0 ? '9mm-pos-mgr-pnl-val-neg' : '9mm-pos-mgr-pnl-val-neu';
}

/**
 * Update the main P&L card header (value + sub-label).
 * @param {object} d        Status response object.
 * @param {number} total    Total P&L including realized.
 * @param {number} realized Realized gains from localStorage.
 */
function _updatePnlHeader(d, total, realized) {
  const pnl = g('kpiPnl');
  const pnlSub = g('kpiPnlPct');
  if (d.pnlSnapshot) {
    pnl.textContent = _fmtUsd(total);
    pnl.className = 'kpi-value ' + (total >= 0 ? 'pos' : 'neg');
    const dep = d.pnlSnapshot.initialDeposit || 0;
    const pctLabel = dep > 0 ? ((total / dep) * 100).toFixed(2) + '% return' : 'cumulative';
    const from = d.pnlSnapshot.firstEpochDateUtc;
    const to = d.pnlSnapshot.snapshotDateUtc;
    if (from) {
      const fmtFrom = fmtDateTime(from + 'T00:00:00Z', { dateOnly: true });
      const fmtTo   = fmtDateTime(to + 'T00:00:00Z', { dateOnly: true });
      pnlSub.textContent = pctLabel + ' \u00B7 ' + fmtFrom + ' \u2192 ' + fmtTo;
    } else {
      pnlSub.textContent = pctLabel;
    }
  } else if (d.running) {
    pnl.textContent = _fmtUsd(realized);
    pnl.className = 'kpi-value ' + (realized > 0 ? 'pos' : 'neu');
    pnlSub.textContent = 'awaiting first P&L snapshot';
  }
}

/**
 * Update all KPI cards from /api/status data.
 * @param {object} d  Status response object.
 */
function _updateKpis(d) {
  const realized = loadRealizedGains();
  const userDeposit = loadInitialDeposit();
  const feesVal  = d.pnlSnapshot ? (d.pnlSnapshot.totalFees || 0) : 0;
  const currentValue = d.pnlSnapshot ? (d.pnlSnapshot.currentValue || 0) : 0;

  // Use user-entered deposit for lifetime P&L; fall back to server-persisted, then bot-detected
  const deposit = userDeposit > 0 ? userDeposit
    : (d.initialDepositUsd > 0 ? d.initialDepositUsd
      : (d.pnlSnapshot ? d.pnlSnapshot.initialDeposit : 0));
  const priceChange = deposit > 0 ? currentValue - deposit : (d.pnlSnapshot ? (d.pnlSnapshot.priceChangePnl || 0) : 0);
  const total = priceChange + feesVal + realized;

  _updatePnlHeader(d, total, realized);

  // Breakdown rows
  _setPnlVal('pnlFees', feesVal);
  _setPnlVal('pnlPrice', priceChange);
  _setPnlVal('pnlRealized', realized);

  // Current Value
  const val = g('kpiValue');
  const dep = g('kpiDeposit');
  if (d.pnlSnapshot) {
    val.textContent = _fmtUsd(currentValue);
    dep.textContent = 'deposit: ' + _fmtUsd(deposit);
  } else if (d.running) {
    dep.textContent = 'awaiting price data';
  }

  // Total Fees
  const fees = g('kpiFees');
  const apr = g('kpiApr');
  if (d.pnlSnapshot) {
    fees.textContent = _fmtUsd(feesVal);
    apr.textContent = 'APR: \u2014';
  }

  // Net Return = currentValue + realized + fees - deposit
  const net = g('kpiNet');
  if (d.pnlSnapshot) {
    const nr = total;
    net.textContent = _fmtUsd(nr);
    net.className = 'kpi-value ' + (nr >= 0 ? 'pos' : 'neg');
  }
}

/**
 * Update position tick/liquidity from active position data.
 * @param {object} d  Status response object.
 */
function _updatePositionTicks(d) {
  if (!d.activePosition) return;
  const pos = d.activePosition;
  const tl = g('sTL');
  const tu = g('sTU');
  const liq = g('sLiq');
  if (tl) tl.textContent = pos.tickLower ?? '—';
  if (tu) tu.textContent = pos.tickUpper ?? '—';
  if (liq) liq.textContent = pos.liquidity ? String(pos.liquidity) : '—';
  if (d.poolState) {
    const tc = g('sTC');
    if (tc) tc.textContent = d.poolState.tick ?? '—';
  }
}

/**
 * Get the active position's token names (from name() resolution).
 * @returns {{t0: string, t1: string}}
 */
function _activeTokenNames() {
  const a = typeof posStore !== 'undefined' ? posStore.getActive() : null;
  return {
    t0: a ? (a.token0Symbol || 'Token 0') : 'Token 0',
    t1: a ? (a.token1Symbol || 'Token 1') : 'Token 1',
  };
}

/**
 * Update composition bars and balances from positionStats.
 * @param {object} d  Status response object.
 */
function _updateComposition(d) {
  if (!d.positionStats) return;
  const r0 = d.positionStats.compositionRatio ?? 0.5;
  const c0 = g('c0');
  const c1 = g('c1');
  if (c0) c0.style.width = (r0 * 100).toFixed(1) + '%';
  if (c1) c1.style.width = ((1 - r0) * 100).toFixed(1) + '%';
  const cl0 = g('cl0');
  const cl1 = g('cl1');
  const tn = _activeTokenNames();
  if (cl0) cl0.textContent = '\u25A0 ' + tn.t0 + ': ' + (r0 * 100).toFixed(0) + '%';
  if (cl1) cl1.textContent = '\u25A0 ' + tn.t1 + ': ' + ((1 - r0) * 100).toFixed(0) + '%';
  const sl0 = g('statT0Label');
  const sl1 = g('statT1Label');
  if (sl0) sl0.textContent = tn.t0;
  if (sl1) sl1.textContent = tn.t1;
  if (d.positionStats.balance0 !== undefined) {
    const sw = g('sWpls');
    if (sw) sw.textContent = d.positionStats.balance0;
  }
  if (d.positionStats.balance1 !== undefined) {
    const su = g('sUsdc');
    if (su) su.textContent = d.positionStats.balance1;
  }
}

/**
 * Update the price marker on the range monitor from pool/position state.
 * @param {object} d  Status response object.
 */
function _updatePriceMarker(d) {
  if (!d.poolState || !d.activePosition) return;
  botConfig.price = d.poolState.price;
  const pmlabel = g('pmlabel');
  if (pmlabel) pmlabel.textContent = d.poolState.price.toFixed(6) + ' ' + _activeToken1Symbol();
  botConfig.tL = d.activePosition.tickLower || 0;
  botConfig.tU = d.activePosition.tickUpper || 0;
  botConfig.lower = Math.pow(1.0001, botConfig.tL);
  botConfig.upper = Math.pow(1.0001, botConfig.tU);
  _9mmPositionMgr.positionRangeVisual();
}

/**
 * Get the token1 symbol from the active position in posStore.
 * @returns {string}
 */
function _activeToken1Symbol() {
  if (typeof posStore === 'undefined') return '';
  const a = posStore.getActive();
  return a ? (a.token1Symbol || '?') : '?';
}

/**
 * Update the red range-width preview lines on the price monitor.
 * Shows where the *next* rebalance range would be, centered on current price.
 * @param {Function} pct       Price-to-CSS-percent converter.
 * @param {number}   previewLo Preview lower price.
 * @param {number}   previewHi Preview upper price.
 */
function _updateRangePreviewLines(pct, previewLo, previewHi) {
  const isScheduled = botConfig.triggerType === 'time';
  const lnL = g('rangeLnL');
  const lnR = g('rangeLnR');
  if (lnL) { lnL.style.left = pct(previewLo); lnL.style.display = isScheduled ? 'none' : ''; }
  if (lnR) { lnR.style.left = pct(previewHi); lnR.style.display = isScheduled ? 'none' : ''; }
}

/**
 * Position the range bar, handles, labels, and price marker on the visual
 * track based on current botConfig values.  Maps prices to 0–100% using a
 * window that pads 30% beyond the lower/upper bounds.
 */
_9mmPositionMgr.positionRangeVisual = function _positionRangeVisual() {
  const lo = botConfig.lower;
  const hi = botConfig.upper;
  if (!lo || !hi || lo >= hi) return;

  // Viewport is anchored to the position range with fixed 30% padding.
  // Preview lines are placed within this viewport and clipped if they fall outside.
  const rw = botConfig.rangeW || 20;
  const previewLo = botConfig.price > 0 ? botConfig.price * (1 - rw / 100) : lo;
  const previewHi = botConfig.price > 0 ? botConfig.price * (1 + rw / 100) : hi;

  const span = hi - lo;
  const pad = span * 0.3;
  let vMin = Math.max(0, lo - pad);
  let vMax = hi + pad;
  // Extend viewport to include preview lines if they exceed position bounds
  if (previewLo < vMin) vMin = Math.max(0, previewLo - span * 0.1);
  if (previewHi > vMax) vMax = previewHi + span * 0.1;
  const vSpan = vMax - vMin;

  /** Convert a price to a CSS left percentage. */
  const pct = (p) => ((p - vMin) / vSpan * 100).toFixed(2) + '%';

  const ra = g('rangeActive');
  if (ra) { ra.style.left = pct(lo); ra.style.width = (span / vSpan * 100).toFixed(2) + '%'; }
  const hl = g('hl');
  if (hl) hl.style.left = pct(lo);
  const hr = g('hr');
  if (hr) hr.style.left = pct(hi);
  const rlL = g('rlL');
  const rsym = _activeToken1Symbol();
  if (rlL) { rlL.style.left = pct(lo); rlL.textContent = lo.toFixed(6) + ' ' + rsym; }
  const rlR = g('rlR');
  if (rlR) { rlR.style.left = pct(hi); rlR.textContent = hi.toFixed(6) + ' ' + rsym; }

  const pm = g('pm');
  if (pm && botConfig.price > 0) pm.style.left = pct(botConfig.price);

  _updateRangePreviewLines(pct, previewLo, previewHi);
};

/**
 * Set the status pill, dot, and label to a given state.
 * @param {string} pillCls  CSS class for the pill.
 * @param {string} dotCls   CSS class for the dot.
 * @param {string} label    Text label.
 */
function _setStatusPill(pillCls, dotCls, label) {
  const pill = g('botStatusPill');
  const dot = g('botDot');
  const text = g('botStatusText');
  if (pill) pill.className = pillCls;
  if (dot) dot.className = dotCls;
  if (text) text.textContent = label;
}

/**
 * Update bot status pill and timestamps from /api/status.
 * @param {object} d  Status response object.
 */
function _updateBotStatus(d) {
  if (d.rebalancePaused) {
    _setStatusPill('status-pill danger', 'dot red', 'PAUSED');
    _showRebalanceErrorModal(d.rebalanceError);
  } else if (d.halted) {
    _setStatusPill('status-pill danger', 'dot red', 'HALTED');
  } else if (d.running) {
    _setStatusPill('status-pill active', 'dot green', 'RUNNING');
  } else {
    _setStatusPill('status-pill warning', 'dot yellow', 'IDLE');
  }

  _updatePriceMarker(d);

  const tag = g('lastCheckTag');
  if (tag && d.updatedAt) {
    const ago = Math.floor((Date.now() - new Date(d.updatedAt).getTime()) / 1000);
    tag.textContent = ago < 5 ? 'just now' : ago + 's ago';
    tag.title = fmtDateTime(d.updatedAt);
  }
  const lastLabel = g('lastCheckLabel');
  if (lastLabel && d.updatedAt) lastLabel.textContent = fmtDateTime(d.updatedAt);
}

/**
 * Update throttle KPIs from /api/status.
 * @param {object} d  Status response object.
 */
function _updateThrottleKpis(d) {
  if (!d.throttleState) return;
  const ts = d.throttleState;
  const today = g('kpiToday');
  if (today) today.textContent = ts.dailyCount + ' / ' + ts.dailyMax;
  const todaySub = g('kpiTodaySub');
  if (todaySub && d.rebalanceEvents && d.rebalanceEvents.length > 0) {
    todaySub.textContent = d.rebalanceEvents.length + ' lifetime \u00B7 resets at midnight';
  }
}

/** Track the last known rebalance timestamp to detect new rebalances. */
let _lastRebalanceAt = null;

/** Whether we've already synced bot config from the server. */
let _configSynced = false;

/**
 * One-time sync of server-persisted bot config into UI inputs.
 * @param {object} d  Status response.
 */
function _syncConfigFromServer(d) {
  if (_configSynced) return;
  _configSynced = true;
  const map = {
    rangeWidthPct: 'inRangeW',
    slippagePct: 'inSlip',
    checkIntervalSec: 'inInterval',
    minRebalanceIntervalMin: 'inMinInterval',
    maxRebalancesPerDay: 'inMaxReb',
    gasStrategy: 'inGas',
  };
  for (const [key, elId] of Object.entries(map)) {
    if (d[key] !== undefined && d[key] !== null) {
      const el = g(elId);
      if (el) el.value = d[key];
    }
  }
  if (d.rangeWidthPct !== undefined) {
    botConfig.rangeW = d.rangeWidthPct;
    const disp = g('activeRangeW');
    if (disp) disp.textContent = d.rangeWidthPct;
  }
  // Sync initial deposit from server if not already in localStorage
  if (d.initialDepositUsd > 0 && !loadInitialDeposit()) {
    try { localStorage.setItem(_INITIAL_DEPOSIT_KEY, String(d.initialDepositUsd)); } catch { /* */ }
  }
  _refreshDepositLabel();
}

/** localStorage key for cached rebalance events. */
const _REB_EVENTS_CACHE_KEY = '9mm_rebalance_events';

/**
 * Cache rebalance events to localStorage so they survive page reloads.
 * @param {object[]} events  Array of rebalance event objects.
 */
function _cacheRebalanceEvents(events) {
  try { localStorage.setItem(_REB_EVENTS_CACHE_KEY, JSON.stringify(events)); } catch { /* */ }
}

/**
 * Load cached rebalance events from localStorage.
 * @returns {object[]|null}
 */
function _loadCachedRebalanceEvents() {
  try {
    const raw = localStorage.getItem(_REB_EVENTS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

/**
 * Update the sync status badge in the Cumulative P&L panel.
 * @param {boolean} complete  Whether the 5-year scan is complete.
 */
function _updateSyncBadge(complete) {
  const badge = g('syncBadge');
  if (!badge) return;
  if (complete) {
    badge.textContent = 'Done Syncing';
    badge.classList.add('done');
  } else {
    badge.textContent = 'Syncing\u2026';
    badge.classList.remove('done');
  }
}

/**
 * Sync the active position from bot status back to the browser posStore.
 * Updates token ID, ticks, and fee when a rebalance produces a new NFT.
 * @param {object} d  Status response object.
 */
function _syncActivePosition(d) {
  if (!d.activePosition || typeof posStore === 'undefined') return;
  const active = posStore.getActive();
  if (!active || active.positionType !== 'nft') return;
  const botPos = d.activePosition;

  // Detect new rebalance by comparing tokenId or lastRebalanceAt
  const isNew = d.lastRebalanceAt && d.lastRebalanceAt !== _lastRebalanceAt;
  if (isNew) {
    _lastRebalanceAt = d.lastRebalanceAt;
    act('\u2699', 'fee', 'Rebalance complete',
      'NFT #' + botPos.tokenId + ' \u00B7 ticks [' + botPos.tickLower + ', ' + botPos.tickUpper + ']');
  }

  // Update posStore entry if token ID changed
  if (botPos.tokenId && String(botPos.tokenId) !== String(active.tokenId)) {
    active.tokenId   = String(botPos.tokenId);
    active.tickLower = botPos.tickLower;
    active.tickUpper = botPos.tickUpper;
    if (typeof updatePosStripUI === 'function') updatePosStripUI();
  }
}

/**
 * Main update function — routes /api/status data to all UI elements.
 * @param {object} data  Parsed JSON from /api/status.
 */
function updateDashboardFromStatus(data) {
  _lastStatus = data;
  _syncConfigFromServer(data);
  _syncActivePosition(data);
  _updateKpis(data);
  _updatePositionTicks(data);
  _updateComposition(data);
  _updateBotStatus(data);
  _updateThrottleKpis(data);

  // Use cached rebalance events if server hasn't sent any yet
  if (!data.rebalanceEvents || data.rebalanceEvents.length === 0) {
    const cached = _loadCachedRebalanceEvents();
    if (cached && cached.length > 0) data.rebalanceEvents = cached;
  } else {
    _cacheRebalanceEvents(data.rebalanceEvents);
  }

  // Update sync status indicator
  _updateSyncBadge(data.rebalanceScanComplete === true);

  // Populate Activity Log with historical rebalance events (once)
  if (!_historyPopulated && data.rebalanceEvents && data.rebalanceEvents.length > 0) {
    _historyPopulated = true;
    const sorted = [...data.rebalanceEvents].sort((a, b) => a.timestamp - b.timestamp);
    for (const ev of sorted) {
      const time = ev.dateStr || new Date(ev.timestamp * 1000).toISOString();
      act('\u2699', 'fee', 'Rebalance #' + ev.index,
        'NFT #' + ev.oldTokenId + ' \u2192 #' + ev.newTokenId + ' \u00B7 ' + time);
    }
  }

  if (typeof updateHistoryFromStatus === 'function') {
    updateHistoryFromStatus(data);
  }
}

/** Count consecutive poll failures for HALTED detection. */
let _pollFailCount = 0;

/** Fetch /api/status and update the dashboard. */
async function _pollStatus() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) {
      _pollFailCount++;
      if (_pollFailCount >= 3) _showHalted();
      return;
    }
    _pollFailCount = 0;
    const data = await res.json();
    updateDashboardFromStatus(data);
  } catch (_) {
    _pollFailCount++;
    if (_pollFailCount >= 3) _showHalted();
  }
}

/** Set the status pill to HALTED (red) when the bot is unreachable. */
function _showHalted() {
  _setStatusPill('status-pill danger', 'dot red', 'HALTED');
}

/** Start polling /api/status at 3-second intervals. */
function startDataPolling() {
  if (_dataTimerId) return;
  _pollStatus();
  _dataTimerId = setInterval(_pollStatus, 3000);
}

/** Stop polling. */
function stopDataPolling() {
  if (_dataTimerId) {
    clearInterval(_dataTimerId);
    _dataTimerId = null;
  }
}
