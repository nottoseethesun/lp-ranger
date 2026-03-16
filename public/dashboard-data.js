/**
 * @file dashboard-data.js
 * @description Polls /api/status and updates all live UI elements on the
 * 9mm v3 Position Manager dashboard.  Replaces placeholder values with
 * real data from the bot backend.
 *
 * Depends on: dashboard-helpers.js, dashboard-positions.js,
 *             dashboard-history.js.
 */

import { g, botConfig, fmtDateTime, act } from './dashboard-helpers.js';
import { posStore, updatePosStripUI } from './dashboard-positions.js';
import { updateHistoryFromStatus } from './dashboard-history.js';

/** Polling interval handle. */
let _dataTimerId = null;

/** Last known status data (for other modules to read). */
let _lastStatus = null;

/** Whether historical rebalance events have been populated in the Activity Log. */
let _historyPopulated = false;

// ── Realized gains (user-entered, persisted in localStorage) ────────────────

const _REALIZED_GAINS_KEY = '9mm_realized_gains';

/** Load realized gains from localStorage. */
export function loadRealizedGains() {
  try {
    const v = parseFloat(localStorage.getItem(_REALIZED_GAINS_KEY));
    return Number.isFinite(v) && v >= 0 ? v : 0;
  } catch { return 0; }
}

/** Toggle the realized gains input field visibility. */
export function toggleRealizedInput() {
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
export function saveRealizedGains() {
  const inp = g('realizedGainsInput');
  if (!inp) return;
  const val = parseFloat(inp.value);
  const amount = Number.isFinite(val) && val >= 0 ? val : 0;
  try { localStorage.setItem(_REALIZED_GAINS_KEY, String(amount)); } catch { /* private mode */ }
  _setPnlVal('pnlRealized', amount);
  const wrap = g('realizedGainsInputWrap');
  if (wrap) wrap.style.display = 'none';
  if (_lastStatus) _updateKpis(_lastStatus);
}

// ── Initial deposit (user-entered, persisted in localStorage) ────────────────

const _INITIAL_DEPOSIT_KEY = '9mm_initial_deposit';

/** Load initial deposit from localStorage. */
export function loadInitialDeposit() {
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
export function toggleInitialDeposit() {
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
export function saveInitialDeposit() {
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

/** Track whether the error/recovery modal is already visible to avoid duplicates. */
let _errorModalShown = false, _recoveryModalShown = false;

/** Remove any active rebalance error modal (auto-dismiss on recovery). */
function _dismissRebalanceModal() {
  const el = document.getElementById('rebalanceErrorModal');
  if (el) el.remove();
  _errorModalShown = false;
}

/** Create and append a modal overlay with given CSS class, title, and body HTML. */
function _createModal(id, cssClass, title, bodyHtml) {
  const overlay = document.createElement('div');
  overlay.className = '9mm-pos-mgr-modal-overlay';
  if (id) overlay.id = id;
  overlay.innerHTML = '<div class="9mm-pos-mgr-modal ' + cssClass + '"><h3>' + title + '</h3>' +
    bodyHtml + '<button class="9mm-pos-mgr-modal-close" data-dismiss-modal>OK</button></div>';
  document.body.appendChild(overlay);
}

/**
 * Show a red danger modal while rebalance is actively failing.
 * @param {string|null} message  Error message from the bot.
 */
function _showRebalanceErrorModal(message) {
  if (_errorModalShown || !message) return;
  _errorModalShown = true;  _recoveryModalShown = false;
  _createModal('rebalanceErrorModal', '', 'Rebalance Failing',
    '<p>' + message + '</p><p class="9mm-pos-mgr-text-muted">The bot will keep retrying automatically. ' +
    'Check the server logs for details.</p>');
}

/**
 * Show a yellow caution modal after price returns to range following failures.
 * @param {number} minutes  Approximate minutes the position was out of range.
 */
function _showRecoveryModal(minutes) {
  if (_recoveryModalShown) return;
  _recoveryModalShown = true;
  const s = minutes === 1 ? '' : 's';
  _createModal(null, '9mm-pos-mgr-modal-caution', 'Position Recovered',
    '<p>Price returned to range after approximately <strong>' + minutes + ' minute' + s +
    '</strong> of failed rebalance attempts.</p>' +
    '<p class="9mm-pos-mgr-text-muted">No rebalance was needed. Check the server logs if the failures persist.</p>');
}

/**
 * Format a number as USD.
 * @param {number} val
 * @returns {string}
 */
export function _fmtUsd(val) {
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

  const deposit = userDeposit > 0 ? userDeposit
    : (d.initialDepositUsd > 0 ? d.initialDepositUsd
      : (d.pnlSnapshot ? d.pnlSnapshot.initialDeposit : 0));
  const priceChange = deposit > 0 ? currentValue - deposit : (d.pnlSnapshot ? (d.pnlSnapshot.priceChangePnl || 0) : 0);
  const total = priceChange + feesVal + realized;

  _updatePnlHeader(d, total, realized);

  _setPnlVal('pnlFees', feesVal);
  _setPnlVal('pnlPrice', priceChange);
  _setPnlVal('pnlRealized', realized);

  const val = g('kpiValue');
  const dep = g('kpiDeposit');
  if (d.pnlSnapshot) {
    val.textContent = _fmtUsd(currentValue);
    dep.textContent = 'deposit: ' + _fmtUsd(deposit);
  } else if (d.running) {
    dep.textContent = 'awaiting price data';
  }

  const fees = g('kpiFees');
  const apr = g('kpiApr');
  if (d.pnlSnapshot) {
    fees.textContent = _fmtUsd(feesVal);
    apr.textContent = 'APR: \u2014';
  }

  _updateNetReturn(d, total);
}

/**
 * Update the Net Return KPI card and its IL breakdown.
 * @param {object} d      Status response object.
 * @param {number} total  Computed net return value.
 */
function _updateNetReturn(d, total) {
  const net = g('kpiNet');
  if (d.pnlSnapshot) {
    net.textContent = _fmtUsd(total);
    net.className = 'kpi-value ' + (total >= 0 ? 'pos' : 'neg');
  }
  const ilEl = g('netIL');
  if (ilEl && d.pnlSnapshot) {
    const ilRaw = d.pnlSnapshot.totalIL || 0;
    const ilAbs = Math.abs(ilRaw).toFixed(2);
    const sign = ilRaw === 0 ? '' : ilRaw > 0 ? '+' : '\u2212';
    ilEl.textContent = sign + '$usd ' + ilAbs;
    ilEl.className = 'kpi-value '
      + (ilRaw === 0 ? 'neu' : ilRaw > 0 ? 'pos' : 'neg');
  }
}

/**
 * Show the HODL baseline confirmation dialog once when first detected.
 * Shows a warning variant when GeckoTerminal historical prices were unavailable
 * and live prices are being used as fallback.
 * @param {object} d  Status response object.
 */
function _checkHodlBaselineDialog(d) {
  const isFallback = d.hodlBaselineFallback
    && !localStorage.getItem('9mm_hodl_baseline_fallback_acked');
  const isNew = d.hodlBaselineNew && d.hodlBaseline
    && !localStorage.getItem('9mm_hodl_baseline_acked');
  if (!isFallback && !isNew) return;
  const amt = g('hodlBaselineAmt');
  const date = g('hodlBaselineDate');
  const msg = g('hodlBaselineMsg');
  if (!amt) return;
  if (isFallback && !isNew) {
    if (msg) msg.textContent = 'CoinGecko could not retrieve historical prices for this pool. '
      + 'The IL baseline will use current prices instead. '
      + 'For an accurate baseline, enter your original deposit in Initial Deposit at top left.';
    amt.textContent = '';
    if (date) date.textContent = '';
  } else {
    amt.textContent = _fmtUsd(d.hodlBaseline.entryValue);
    if (date) date.textContent = d.hodlBaseline.mintDate || '\u2014';
  }
  g('hodlBaselineModal').className = 'modal-overlay';
  const ok = g('hodlBaselineOk');
  const close = g('hodlBaselineClose');
  const dismiss = () => {
    localStorage.setItem('9mm_hodl_baseline_acked', '1');
    if (isFallback) localStorage.setItem('9mm_hodl_baseline_fallback_acked', '1');
    g('hodlBaselineModal').className = 'modal-overlay hidden';
  };
  if (ok) ok.onclick = dismiss;
  if (close) close.onclick = dismiss;
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
  const a = posStore.getActive();
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
 * Get the token1 symbol from the active position in posStore.
 * @returns {string}
 */
function _activeToken1Symbol() {
  const a = posStore.getActive();
  return a ? (a.token1Symbol || '?') : '?';
}

/**
 * Update the red range-width preview lines on the price monitor.
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
 * track based on current botConfig values.
 */
export function positionRangeVisual() {
  const lo = botConfig.lower;
  const hi = botConfig.upper;
  if (!lo || !hi || lo >= hi) return;

  const rw = botConfig.rangeW || 20;
  const previewLo = botConfig.price > 0 ? botConfig.price * (1 - rw / 100) : lo;
  const previewHi = botConfig.price > 0 ? botConfig.price * (1 + rw / 100) : hi;

  const allMin = Math.min(lo, previewLo);
  const allMax = Math.max(hi, previewHi);
  const fullSpan = allMax - allMin;
  const pad = fullSpan * 0.15;
  const vMin = Math.max(0, allMin - pad);
  const vMax = allMax + pad;
  const vSpan = vMax - vMin;

  const pct = (p) => ((p - vMin) / vSpan * 100).toFixed(2) + '%';

  const ra = g('rangeActive');
  if (ra) { ra.style.left = pct(lo); ra.style.width = ((hi - lo) / vSpan * 100).toFixed(2) + '%'; }
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
  positionRangeVisual();
}

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
  if (d.oorRecoveredMin > 0 && !d.rebalancePaused) {
    _dismissRebalanceModal();
    _showRecoveryModal(d.oorRecoveredMin);
  }
  if (d.rebalancePaused) {
    _setStatusPill('status-pill danger', 'dot red', 'RETRYING');
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
/** Format the throttle reset time from the server's dailyResetAt timestamp. */
function _fmtResetTime(dailyResetAt) {
  if (!dailyResetAt) return '';
  const d = new Date(dailyResetAt);
  const utc = d.toISOString().slice(11, 16) + ' UTC';
  const local = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const tz = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(d)
    .find(function (p) { return p.type === 'timeZoneName'; });
  return 'Resets ' + utc + ' (' + local + ' ' + (tz ? tz.value : 'local') + ')';
}

function _updateThrottleKpis(d) {
  if (!d.throttleState) return;
  const ts = d.throttleState;
  const today = g('kpiToday');
  if (today) today.textContent = ts.dailyCount + ' / ' + ts.dailyMax;
  const todaySub = g('kpiTodaySub');
  if (todaySub) {
    const lifetime = d.rebalanceEvents ? d.rebalanceEvents.length : 0;
    todaySub.innerHTML = lifetime + ' lifetime<br>' + _fmtResetTime(ts.dailyResetAt);
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
 * @param {object} d  Status response object.
 */
function _syncActivePosition(d) {
  if (!d.activePosition) return;
  const active = posStore.getActive();
  if (!active || active.positionType !== 'nft') return;
  const botPos = d.activePosition;

  const isNew = d.lastRebalanceAt && d.lastRebalanceAt !== _lastRebalanceAt;
  if (isNew) {
    _lastRebalanceAt = d.lastRebalanceAt;
    act('\u2699', 'fee', 'Rebalance complete',
      'NFT #' + botPos.tokenId + ' \u00B7 ticks [' + botPos.tickLower + ', ' + botPos.tickUpper + ']');
  }

  if (botPos.tokenId && String(botPos.tokenId) !== String(active.tokenId)) {
    active.tokenId   = String(botPos.tokenId);
    active.tickLower = botPos.tickLower;
    active.tickUpper = botPos.tickUpper;
    updatePosStripUI();
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
  _checkHodlBaselineDialog(data);

  if (!data.rebalanceEvents || data.rebalanceEvents.length === 0) {
    const cached = _loadCachedRebalanceEvents();
    if (cached && cached.length > 0) data.rebalanceEvents = cached;
  } else {
    _cacheRebalanceEvents(data.rebalanceEvents);
  }

  _updateSyncBadge(data.rebalanceScanComplete === true);

  if (!_historyPopulated && data.rebalanceEvents && data.rebalanceEvents.length > 0) {
    _historyPopulated = true;
    const sorted = [...data.rebalanceEvents].sort((a, b) => a.timestamp - b.timestamp);
    for (const ev of sorted) {
      const time = ev.dateStr || new Date(ev.timestamp * 1000).toISOString();
      act('\u2699', 'fee', 'Rebalance #' + ev.index,
        'NFT #' + ev.oldTokenId + ' \u2192 #' + ev.newTokenId + ' \u00B7 ' + time);
    }
  }

  updateHistoryFromStatus(data);
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
export function startDataPolling() {
  if (_dataTimerId) return;
  _pollStatus();
  _dataTimerId = setInterval(_pollStatus, 3000);
}

/** Stop polling. */
export function stopDataPolling() {
  if (_dataTimerId) {
    clearInterval(_dataTimerId);
    _dataTimerId = null;
  }
}
