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

let _dataTimerId = null, _lastStatus = null, _historyPopulated = false;

// ── Realized gains (user-entered, persisted in localStorage) ────────────────

const _REALIZED_GAINS_KEY = '9mm_realized_gains';

/** Load lifetime realized gains — pool-scoped key takes priority, then global fallback. */
export function loadRealizedGains() { const v = _loadNum(_poolKey('9mm_realized_pool_'), true); return v > 0 ? v : _loadNum(_REALIZED_GAINS_KEY, true); }
/** Toggle the lifetime realized gains input. */
export function toggleRealizedInput() { _toggleWrap('realizedGainsInputWrap', 'realizedGainsInput', loadRealizedGains); }
/** Save lifetime realized gains to pool-scoped key. */
export function saveRealizedGains() { const key = _poolKey('9mm_realized_pool_') || _REALIZED_GAINS_KEY; _saveInput(key, 'realizedGainsInput', 'realizedGainsInputWrap', () => { if (_lastStatus) _updateKpis(_lastStatus); }, true); }

// ── Shared toggle/save helpers ───────────────────────────────────────────────

/** Build a per-position localStorage key with the given prefix. */
function _posKey(prefix) {
  const a = posStore.getActive();
  return a ? prefix + (a.tokenId || 'unknown') : null;
}
/** Build a per-pool localStorage key (token0/token1/fee). */
function _poolKey(prefix) {
  const a = posStore.getActive();
  if (!a || !a.token0 || !a.token1) return null;
  return prefix + a.token0.toLowerCase() + '_' + a.token1.toLowerCase() + '_' + (a.fee || 0);
}
/** Load a numeric value from localStorage (returns 0 if missing/invalid). */
function _loadNum(key, allowZero) {
  if (!key) return 0;
  try { const v = parseFloat(localStorage.getItem(key)); return Number.isFinite(v) && (allowZero ? v >= 0 : v > 0) ? v : 0; } catch { return 0; }
}
/** Toggle an input-wrap open/closed and populate the input. */
function _toggleWrap(wrapId, inputId, loadFn) {
  const wrap = g(wrapId); if (!wrap) return;
  const show = !wrap.classList.contains('open');
  wrap.classList.toggle('open', show);
  if (show) { const inp = g(inputId); if (inp) { inp.value = loadFn() || ''; inp.focus(); } }
}
/** Save a numeric input to localStorage, close wrap, then call afterSave. */
function _saveInput(key, inputId, wrapId, afterSave, allowZero) {
  const inp = g(inputId); if (!key || !inp) return;
  const val = parseFloat(inp.value);
  const amount = Number.isFinite(val) && (allowZero ? val >= 0 : val > 0) ? val : 0;
  try { localStorage.setItem(key, String(amount)); } catch { /* private mode */ }
  const wrap = g(wrapId); if (wrap) wrap.classList.remove('open');
  if (afterSave) afterSave(amount);
}

// ── Per-position realized gains ──────────────────────────────────────────────

/** Load realized gains for the current position. */
export function loadCurRealized() { return _loadNum(_posKey('9mm_realized_pos_'), true); }
/** Toggle the current-position realized gains input. */
export function toggleCurRealized() { _toggleWrap('curRealizedInputWrap', 'curRealizedInput', loadCurRealized); }
/** Save current-position realized gains. */
export function saveCurRealized() { _saveInput(_posKey('9mm_realized_pos_'), 'curRealizedInput', 'curRealizedInputWrap', () => { if (_lastStatus) _updateKpis(_lastStatus); }, true); }

// ── Initial deposit (user-entered, persisted in localStorage) ────────────────

const _INITIAL_DEPOSIT_KEY = '9mm_initial_deposit';
/** Load initial deposit — pool-scoped key takes priority, then global fallback. */
export function loadInitialDeposit() { const v = _loadNum(_poolKey('9mm_deposit_pool_'), false); return v > 0 ? v : _loadNum(_INITIAL_DEPOSIT_KEY, false); }

function _refreshDepositLabel() { const s = loadInitialDeposit(), d = g('lifetimeDepositDisplay'); if (d) d.textContent = s > 0 ? '$usd ' + s.toFixed(2) : '—'; }

// ── Current-position deposit ─────────────────────────────────────────────────

/** Load the current position's deposit. */
export function loadCurDeposit() { return _loadNum(_posKey('9mm_deposit_pos_'), false); }

export function refreshCurDepositDisplay(fallback) { const v = loadCurDeposit() || (fallback || 0), d = g('curDepositDisplay'); if (d) d.textContent = v > 0 ? '$usd ' + v.toFixed(2) : '—'; }
/** Toggle the current-position deposit input. */
export function toggleCurDeposit() { _toggleWrap('curDepositInputWrap', 'curDepositInput', loadCurDeposit); }
/** Save the current-position deposit. */
export function saveCurDeposit() { _saveInput(_posKey('9mm_deposit_pos_'), 'curDepositInput', 'curDepositInputWrap', () => refreshCurDepositDisplay(), false); }
/** Toggle the initial deposit input. */
export function toggleInitialDeposit() { _toggleWrap('initialDepositInputWrap', 'initialDepositInput', loadInitialDeposit); }
/** Save initial deposit to pool-scoped key + server. */
export function saveInitialDeposit() {
  const key = _poolKey('9mm_deposit_pool_') || _INITIAL_DEPOSIT_KEY;
  _saveInput(key, 'initialDepositInput', 'initialDepositInputWrap', (amount) => {
    fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initialDepositUsd: amount }) }).catch(() => {});
    _refreshDepositLabel(); if (_lastStatus) _updateKpis(_lastStatus);
  }, false);
}

let _errorModalShown = false, _recoveryModalShown = false;

function _dismissRebalanceModal() {
  const el = document.getElementById('rebalanceErrorModal'); if (el) el.remove(); _errorModalShown = false;
}

function _createModal(id, cssClass, title, bodyHtml) {
  const o = document.createElement('div'); o.className = '9mm-pos-mgr-modal-overlay'; if (id) o.id = id;
  o.innerHTML = '<div class="9mm-pos-mgr-modal ' + cssClass + '"><h3>' + title + '</h3>' + bodyHtml + '<button class="9mm-pos-mgr-modal-close" data-dismiss-modal>OK</button></div>';
  document.body.appendChild(o);
}

function _showRebalanceErrorModal(message) {
  if (_errorModalShown || !message) return; _errorModalShown = true; _recoveryModalShown = false;
  _createModal('rebalanceErrorModal', '', 'Rebalance Failing', '<p>' + message + '</p><p class="9mm-pos-mgr-text-muted">The bot will keep retrying. Check server logs.</p>');
}
function _showRecoveryModal(minutes) {
  if (_recoveryModalShown) return; _recoveryModalShown = true;
  _createModal(null, '9mm-pos-mgr-modal-caution', 'Position Recovered', '<p>Price returned to range after ~<strong>' + minutes + ' min</strong> of failed attempts.</p><p class="9mm-pos-mgr-text-muted">No rebalance needed. Check server logs if failures persist.</p>');
}

/** Format a number as USD. */
export function _fmtUsd(val) {
  if (val === null || val === undefined || isNaN(val)) return '—';
  const abs = Math.abs(val).toFixed(2);
  if (abs === '0.00') return '$usd 0.00';
  const sign = val < 0 ? '-' : '';
  return sign + '$usd ' + abs;
}

/** Check if a value rounds to zero at 2 decimal places. */
function _isDisplayZero(val) {
  return Math.abs(val).toFixed(2) === '0.00';
}

/** Format a percentage value with sign and set it on an element. */
function _setPctSpan(id, val, deposit) {
  const el = g(id); if (!el) return;
  if (!deposit || deposit <= 0) { el.textContent = ''; return; }
  const pct = (val / deposit) * 100;
  const sign = pct > 0 ? '+' : '';
  el.textContent = sign + pct.toFixed(2) + '%';
}

/** Compute annualized APR and display on a span. Green/red/white coloring. */
function _setAprSpan(id, val, deposit, firstDate) {
  const el = g(id); if (!el) return;
  if (!deposit || deposit <= 0 || !firstDate) { el.textContent = ''; return; }
  const startMs = new Date(firstDate + 'T00:00:00Z').getTime();
  const elapsedSec = (Date.now() - startMs) / 1000;
  if (elapsedSec <= 0) { el.textContent = ''; return; }
  const apr = (val / deposit) / (elapsedSec / (365.25 * 24 * 3600)) * 100;
  if (Math.abs(apr) < 0.005) { el.textContent = 'APR 0.00%'; el.style.color = ''; return; }
  if (apr > 0) { el.textContent = 'APR ' + apr.toFixed(2) + '%'; el.style.color = '#0f0'; }
  else { el.textContent = 'APR \u2212' + Math.abs(apr).toFixed(2) + '%'; el.style.color = '#f44'; }
}

/** Set only the leading text node of an element, preserving child spans. */
function _setLeadingText(el, text) {
  if (!el) return;
  if (el.firstChild && el.firstChild.nodeType === 3) el.firstChild.textContent = text;
  else el.insertBefore(document.createTextNode(text), el.firstChild);
}

/** Apply a sign-colored CSS class to a P&L breakdown value span. */
function _setPnlVal(id, val) {
  const el = g(id); if (!el) return;
  el.textContent = _fmtUsd(val);
  el.className = _isDisplayZero(val) ? '9mm-pos-mgr-pnl-val-neu' : val > 0 ? '9mm-pos-mgr-pnl-val-pos' : '9mm-pos-mgr-pnl-val-neg';
}

/** Update the main P&L card header (value + sub-label). */
function _updatePnlHeader(d, total, realized, curDeposit) {
  const pnl = g('kpiPnl');
  const pnlSub = g('kpiPnlPct');
  if (d.pnlSnapshot) {
    _setLeadingText(pnl, _fmtUsd(total));
    pnl.className = 'kpi-value 9mm-pos-mgr-kpi-pct-row ' + (_isDisplayZero(total) ? 'neu' : total > 0 ? 'pos' : 'neg');
    _setPctSpan('kpiPnlPctVal', total, curDeposit);
    const epoch = d.pnlSnapshot.liveEpoch;
    const epochStart = epoch ? new Date(epoch.openTime).toISOString().slice(0, 10) : null;
    _setAprSpan('kpiPnlApr', epoch ? (epoch.fees || 0) : 0, curDeposit, epochStart);
    const from = epochStart, to = d.pnlSnapshot.snapshotDateUtc;
    if (from) {
      const fmtFrom = fmtDateTime(from + 'T00:00:00Z', { dateOnly: true });
      const fmtTo   = fmtDateTime(to + 'T00:00:00Z', { dateOnly: true });
      pnlSub.textContent = fmtFrom + ' \u2192 ' + fmtTo;
    } else { pnlSub.textContent = 'cumulative'; }
  } else if (d.running) {
    _setLeadingText(pnl, _fmtUsd(realized));
    pnl.className = 'kpi-value 9mm-pos-mgr-kpi-pct-row ' + (realized > 0 ? 'pos' : 'neu');
    pnlSub.textContent = 'Awaiting First P&L Snapshot';
  }
}

/** Format a duration in ms as "Xd Yh Zm". */
function _fmtDuration(ms) {
  const d = Math.floor(ms / 86400000), h = Math.floor((ms % 86400000) / 3600000), m = Math.floor((ms % 3600000) / 60000);
  return (d > 0 ? d + 'd ' : '') + (h > 0 || d > 0 ? h + 'h ' : '') + m + 'm';
}

/** Update the current-position IL value and percentage. */
function _updateCurIL(d, deposit) {
  const curIlVal = d.pnlSnapshot ? (d.pnlSnapshot.totalIL || 0) : 0;
  const curIlEl = g('curIL');
  if (curIlEl) {
    _setLeadingText(curIlEl, _fmtUsd(curIlVal));
    curIlEl.className = 'kpi-value 9mm-pos-mgr-kpi-pct-row ' + (_isDisplayZero(curIlVal) ? 'neu' : curIlVal > 0 ? 'pos' : 'neg');
  }
  _setPctSpan('curILPct', curIlVal, deposit);
}

/** Update the position duration display using on-chain mint date. */
function _updatePosDuration(d) {
  const el = g('kpiPosDuration'); if (!el) return;
  const mintDate = d.hodlBaseline?.mintDate;
  if (!mintDate) { el.textContent = ''; return; }
  const mintMs = new Date(mintDate + 'T00:00:00Z').getTime();
  const ms = Date.now() - mintMs;
  el.textContent = ms > 0 ? 'Position Duration: ' + _fmtDuration(ms) : '';
}

function _applySnapshotKpis(d, deposit, curRealized) {
  const epoch = d.pnlSnapshot.liveEpoch;
  const curFees = epoch ? (epoch.fees || 0) : 0;
  const currentValue = d.pnlSnapshot.currentValue || 0;
  const val = g('kpiValue'); if (val) val.textContent = _fmtUsd(currentValue);
  _setPnlVal('pnlFees', curFees);
  _setPnlVal('pnlPrice', deposit > 0 ? currentValue - deposit : (d.pnlSnapshot.priceChangePnl || 0));
  _setPnlVal('pnlRealized', curRealized);
  const dep = g('kpiDeposit'); if (dep) dep.textContent = _fmtUsd(deposit);
  _updateCurIL(d, deposit);
  _updatePosDuration(d);
}

/** Resolve the bot-detected deposit (excluding user-entered lifetime value). */
function _botDetectedDeposit(d) {
  if (d.initialDepositUsd > 0) return d.initialDepositUsd;
  return d.pnlSnapshot ? (d.pnlSnapshot.initialDeposit || 0) : 0;
}

/** Resolve the current-position deposit (per-position saved, or epoch entry). */
function _resolveCurDeposit(d) {
  const saved = loadCurDeposit();
  if (saved > 0) return saved;
  return d.pnlSnapshot?.liveEpoch?.entryValue || 0;
}

/** Compute price change P&L for a given deposit. */
function _priceChangePnl(d, deposit, currentValue) {
  if (deposit > 0) return currentValue - deposit;
  return d.pnlSnapshot ? (d.pnlSnapshot.priceChangePnl || 0) : 0;
}

/** Update the position status badge (CLOSED / ACTIVE / hidden). */
function _updatePosStatus(d) {
  const el = g('curPosStatus');
  if (!el) return;
  const active = posStore.getActive();
  if (!active) { el.textContent = ''; el.className = '9mm-pos-mgr-pos-status'; return; }
  const liq = d.activePosition ? (d.activePosition.liquidity ?? active.liquidity) : active.liquidity;
  const isClosed = liq !== undefined && liq !== null && BigInt(liq) === 0n;
  el.textContent = isClosed ? 'CLOSED' : 'ACTIVE';
  el.className = '9mm-pos-mgr-pos-status ' + (isClosed ? 'closed' : 'active');
}

/** Resolve lifetime and current-position totals for KPI display. */
function _resolveKpiTotals(d) {
  const ltRealized = loadRealizedGains(), curRealized = loadCurRealized();
  const ltFees = d.pnlSnapshot ? (d.pnlSnapshot.totalFees || 0) : 0;
  const curFees = d.pnlSnapshot?.liveEpoch?.fees || 0;
  const cv = d.pnlSnapshot ? (d.pnlSnapshot.currentValue || 0) : 0;
  const curDep = _resolveCurDeposit(d), ltUserDep = loadInitialDeposit();
  const ltDep = ltUserDep > 0 ? ltUserDep : _botDetectedDeposit(d);
  return { curTotal: _priceChangePnl(d, curDep, cv) + curFees + curRealized,
    ltTotal: _priceChangePnl(d, ltDep, cv) + ltFees + ltRealized,
    curDep, ltDep, curRealized };
}

function _updateKpis(d) {
  const t = _resolveKpiTotals(d);
  _updatePnlHeader(d, t.curTotal, t.curRealized, t.curDep);
  if (d.pnlSnapshot) { _applySnapshotKpis(d, t.curDep, t.curRealized); }
  else if (d.running) { const dep = g('kpiDeposit'); if (dep) dep.textContent = 'Awaiting Price Data'; }
  _updateNetReturn(d, t.ltTotal, t.ltDep);
  const ltDisp = g('lifetimeDepositDisplay');
  if (ltDisp) ltDisp.textContent = t.ltDep > 0 ? '$usd ' + t.ltDep.toFixed(2) : '—';
  refreshCurDepositDisplay(d.pnlSnapshot?.liveEpoch?.entryValue || 0);
}

/** Update the Net Return KPI card and its IL breakdown. */
function _updateNetReturn(d, total, ltDeposit) {
  const net = g('kpiNet');
  if (d.pnlSnapshot) {
    _setLeadingText(net, _fmtUsd(total));
    net.className = 'kpi-value 9mm-pos-mgr-kpi-pct-row ' + (_isDisplayZero(total) ? 'neu' : total > 0 ? 'pos' : 'neg');
    _setPctSpan('kpiNetPct', total, ltDeposit);
    _setAprSpan('kpiNetApr', total, ltDeposit, d.pnlSnapshot.firstEpochDateUtc);
    const bd = g('kpiNetBreakdown'), s = d.pnlSnapshot;
    if (bd) bd.textContent = (s.totalFees || 0).toFixed(2) + ' + ' + (s.priceChangePnl || 0).toFixed(2) + ' \u2212 ' + (s.totalGas || 0).toFixed(2);
  }
  const ilEl = g('netIL');
  if (ilEl && d.pnlSnapshot) {
    const il = d.pnlSnapshot.totalIL || 0;
    _setLeadingText(ilEl, _fmtUsd(il));
    ilEl.className = 'kpi-value 9mm-pos-mgr-kpi-pct-row ' + (_isDisplayZero(il) ? 'neu' : il > 0 ? 'pos' : 'neg');
    _setPctSpan('netILPct', il, ltDeposit);
    _setAprSpan('netILApr', il, ltDeposit, d.pnlSnapshot.firstEpochDateUtc);
  }
}

/** Show the HODL baseline confirmation dialog once when first detected. */
function _checkHodlBaselineDialog(d) {
  const isFallback = d.hodlBaselineFallback && !localStorage.getItem('9mm_hodl_baseline_fallback_acked');
  const isNew = d.hodlBaselineNew && d.hodlBaseline && !localStorage.getItem('9mm_hodl_baseline_acked');
  if (!isFallback && !isNew) return;
  const amt = g('hodlBaselineAmt'), date = g('hodlBaselineDate'), msg = g('hodlBaselineMsg');
  if (!amt) return;
  if (isFallback && !isNew) {
    if (msg) msg.textContent = 'CoinGecko could not retrieve historical prices. IL baseline uses current prices. Enter your deposit in Initial Deposit to override.';
    amt.textContent = '';  if (date) date.textContent = '';
  } else {
    amt.textContent = _fmtUsd(d.hodlBaseline.entryValue);
    if (date) date.textContent = d.hodlBaseline.mintDate || '\u2014';
  }
  g('hodlBaselineModal').className = 'modal-overlay';
  const ok = g('hodlBaselineOk'), close = g('hodlBaselineClose');
  const dismiss = () => { localStorage.setItem('9mm_hodl_baseline_acked', '1');
    if (isFallback) localStorage.setItem('9mm_hodl_baseline_fallback_acked', '1');
    g('hodlBaselineModal').className = 'modal-overlay hidden'; };
  if (ok) ok.onclick = dismiss;  if (close) close.onclick = dismiss;
}

/** Update position ticks and pool share from active position data. */
function _updatePositionTicks(d) {
  if (d.poolState) { const tc = g('sTC'); if (tc) tc.textContent = d.poolState.tick ?? '—'; }
  if (!d.activePosition) return;
  const pos = d.activePosition;
  const tl = g('sTL'), tu = g('sTU');
  if (tl) tl.textContent = pos.tickLower ?? '—';
  if (tu) tu.textContent = pos.tickUpper ?? '—';
  if (d.positionStats) {
    const s0 = g('sShare0'), s1 = g('sShare1');
    if (s0) s0.textContent = d.positionStats.poolShare0Pct !== undefined ? d.positionStats.poolShare0Pct.toFixed(4) + '%' : '—';
    if (s1) s1.textContent = d.positionStats.poolShare1Pct !== undefined ? d.positionStats.poolShare1Pct.toFixed(4) + '%' : '—';
  }
}

/** Get the active position's token names. */
function _activeTokenNames() {
  const a = posStore.getActive();
  return { t0: a ? (a.token0Symbol || 'Token 0') : 'Token 0', t1: a ? (a.token1Symbol || 'Token 1') : 'Token 1' };
}

/** Update composition bars and balances from positionStats. */
function _updateComposition(d) {
  if (!d.positionStats) return;
  const r0 = d.positionStats.compositionRatio ?? 0.5;
  const c0 = g('c0'), c1 = g('c1');
  if (c0) c0.style.width = (r0 * 100).toFixed(1) + '%';
  if (c1) c1.style.width = ((1 - r0) * 100).toFixed(1) + '%';
  const tn = _activeTokenNames(), cl0 = g('cl0'), cl1 = g('cl1');
  if (cl0) cl0.textContent = '\u25A0 ' + tn.t0 + ': ' + (r0 * 100).toFixed(0) + '%';
  if (cl1) cl1.textContent = '\u25A0 ' + tn.t1 + ': ' + ((1 - r0) * 100).toFixed(0) + '%';
  const sl0 = g('statT0Label'), sl1 = g('statT1Label');
  if (sl0) sl0.textContent = tn.t0;  if (sl1) sl1.textContent = tn.t1;
  const sh0 = g('statShare0Label'), sh1 = g('statShare1Label');
  if (sh0) sh0.textContent = 'Pool Share ' + tn.t0;  if (sh1) sh1.textContent = 'Pool Share ' + tn.t1;
  if (d.positionStats.balance0 !== undefined) { const sw = g('sWpls'); if (sw) sw.textContent = d.positionStats.balance0; }
  if (d.positionStats.balance1 !== undefined) { const su = g('sUsdc'); if (su) su.textContent = d.positionStats.balance1; }
}

function _activeToken1Symbol() { const a = posStore.getActive(); return a ? (a.token1Symbol || '?') : '?'; }

/** Position the range bar, handles, labels, and price marker on the visual track. */
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
  const hl = g('hl'), hr = g('hr');
  if (hl) hl.style.left = pct(lo);  if (hr) hr.style.left = pct(hi);
  const rsym = _activeToken1Symbol(), rlL = g('rlL'), rlR = g('rlR');
  if (rlL) { rlL.style.left = pct(lo); rlL.textContent = lo.toFixed(6) + ' ' + rsym; }
  if (rlR) { rlR.style.left = pct(hi); rlR.textContent = hi.toFixed(6) + ' ' + rsym; }
  const pm = g('pm');  if (pm && botConfig.price > 0) pm.style.left = pct(botConfig.price);
  const lnL = g('rangeLnL'), lnR = g('rangeLnR');
  if (lnL) lnL.style.left = pct(previewLo);  if (lnR) lnR.style.left = pct(previewHi);
}

function _updateRangePctLabels(price, lower, upper) {
  const lo = g('rangePctLower'), hi = g('rangePctUpper');
  if (!lo || !hi || !price || price <= 0) return;
  lo.textContent = ((lower - price) / price * 100).toFixed(2) + '% below price';
  hi.textContent = '+' + ((upper - price) / price * 100).toFixed(2) + '% above price';
}

/** Update the price marker on the range monitor from pool/position state. */
function _updatePriceMarker(d) {
  if (!d.poolState) return;
  botConfig.price = d.poolState.price;
  const pml = g('pmlabel');
  if (pml) pml.textContent = d.poolState.price.toFixed(6) + ' ' + _activeToken1Symbol();
  if (d.activePosition) {
    botConfig.tL = d.activePosition.tickLower || 0;  botConfig.tU = d.activePosition.tickUpper || 0;
    botConfig.lower = Math.pow(1.0001, botConfig.tL); botConfig.upper = Math.pow(1.0001, botConfig.tU);
  }
  _updateRangePctLabels(d.poolState.price, botConfig.lower, botConfig.upper);
  positionRangeVisual();
}

/** Set the status pill, dot, and label to a given state. */
function _setStatusPill(pillCls, dotCls, label) {
  const pill = g('botStatusPill'), dot = g('botDot'), text = g('botStatusText');
  if (pill) pill.className = pillCls;  if (dot) dot.className = dotCls;  if (text) text.textContent = label;
}

/** Update bot status pill and timestamps from /api/status. */
function _updateBotStatus(d) {
  if (d.oorRecoveredMin > 0 && !d.rebalancePaused) {
    _dismissRebalanceModal();
    _showRecoveryModal(d.oorRecoveredMin);
  }
  if (d.rebalancePaused) { _setStatusPill('status-pill danger', 'dot red', 'RETRYING'); _showRebalanceErrorModal(d.rebalanceError); }
  else if (d.halted) { _setStatusPill('status-pill danger', 'dot red', 'HALTED'); }
  else if (d.running) { _setStatusPill('status-pill active', 'dot green', 'RUNNING'); }
  else { _setStatusPill('status-pill warning', 'dot yellow', 'IDLE'); }

  _updatePriceMarker(d);

  const tag = g('lastCheckTag');
  if (tag && d.updatedAt) { const ago = Math.floor((Date.now() - new Date(d.updatedAt).getTime()) / 1000);
    tag.textContent = ago < 5 ? 'just now' : ago + 's ago';  tag.title = fmtDateTime(d.updatedAt); }
  const lastLabel = g('lastCheckLabel');
  if (lastLabel && d.updatedAt) lastLabel.textContent = fmtDateTime(d.updatedAt);
}

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
    todaySub.innerHTML = lifetime + ' Lifetime<br>' + _fmtResetTime(ts.dailyResetAt);
  }
}

let _lastRebalanceAt = null, _configSynced = false;

/** One-time sync of server-persisted bot config into UI inputs. */
function _syncConfigFromServer(d) {
  if (_configSynced) return;
  _configSynced = true;
  const map = { rangeWidthPct: 'inRangeW', slippagePct: 'inSlip', checkIntervalSec: 'inInterval',
    minRebalanceIntervalMin: 'inMinInterval', maxRebalancesPerDay: 'inMaxReb', gasStrategy: 'inGas' };
  for (const [key, elId] of Object.entries(map)) { if (d[key] !== undefined && d[key] !== null) { const el = g(elId); if (el) el.value = d[key]; } }
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

const _REB_EVENTS_CACHE_KEY = '9mm_rebalance_events';
function _cacheRebalanceEvents(events) {
  try { localStorage.setItem(_REB_EVENTS_CACHE_KEY, JSON.stringify(events)); } catch { /* */ }
}

/** Load cached rebalance events from localStorage. */
function _loadCachedRebalanceEvents() {
  try { const r = localStorage.getItem(_REB_EVENTS_CACHE_KEY); if (!r) return null;
    const p = JSON.parse(r); return Array.isArray(p) ? p : null; } catch { return null; }
}

/**
 * Update the sync status badge in the Cumulative P&L panel.
 * @param {boolean} complete  Whether the 5-year scan is complete.
 */
function _updateSyncBadge(complete) {
  const badge = g('syncBadge'); if (!badge) return;
  badge.textContent = complete ? 'Done Syncing' : 'Syncing\u2026';
  badge.classList.toggle('done', complete);
}

/** Sync the active position from bot status back to the browser posStore. */
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

/** Main update function — routes /api/status data to all UI elements. */
function updateDashboardFromStatus(data) {
  _lastStatus = data;
  _syncConfigFromServer(data);
  _syncActivePosition(data);
  _updatePosStatus(data);
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

let _pollFailCount = 0;
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

function _showHalted() { _setStatusPill('status-pill danger', 'dot red', 'HALTED'); }
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
