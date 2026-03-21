/**
 * @file dashboard-data.js
 * @description Polls /api/status and updates all live UI elements on the
 * 9mm v3 Position Manager dashboard.  Depends on: dashboard-helpers.js,
 * dashboard-positions.js, dashboard-history.js, dashboard-il-debug.js.
 */

import { g, botConfig, fmtDateTime, act } from './dashboard-helpers.js';
import { posStore, updatePosStripUI, setBotActiveTokenId } from './dashboard-positions.js';
import { updateHistoryFromStatus } from './dashboard-history.js';
import { wallet } from './dashboard-wallet.js';
import { reapplyPrivacyBlur } from './dashboard-events.js';
import { isViewingClosedPos, refetchClosedPosHistory } from './dashboard-closed-pos.js';
import { updateILDebugData } from './dashboard-il-debug.js';

let _dataTimerId = null, _lastStatus = null, _historyPopulated = false, _poolFirstDate = null;

/** Format a tx hash as "0x…wxyz" with a copy-to-clipboard icon. */
function _fmtTxCopy(hash) {
  const short = hash.slice(0, 4) + '\u2026' + hash.slice(-4);
  return `<span class="9mm-pos-mgr-copy-icon" title="Copy full TX hash" data-copy-tx="${hash}">${short} &#x274F;</span>`;
}

// ── Realized gains (user-entered, persisted in localStorage) ────────────────

const _REALIZED_GAINS_KEY = '9mm_realized_gains';

/** Load lifetime realized gains — pool-scoped key takes priority, then global fallback. */
export function loadRealizedGains() { const v = _loadNum(_poolKey('9mm_realized_pool_'), true); return v > 0 ? v : _loadNum(_REALIZED_GAINS_KEY, true); }
/** Toggle the lifetime realized gains input. */
export function toggleRealizedInput() { _toggleWrap('realizedGainsInputWrap', 'realizedGainsInput', loadRealizedGains); }
/** Save lifetime realized gains to pool-scoped key. */ export function saveRealizedGains() { const key = _poolKey('9mm_realized_pool_') || _REALIZED_GAINS_KEY; _saveInput(key, 'realizedGainsInput', 'realizedGainsInputWrap', () => { if (_lastStatus) _updateKpis(_lastStatus); }, true); }

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

/** Load realized gains for the current position. */ export function loadCurRealized() { return _loadNum(_posKey('9mm_realized_pos_'), true); }
/** Toggle the current-position realized gains input. */ export function toggleCurRealized() { _toggleWrap('curRealizedInputWrap', 'curRealizedInput', loadCurRealized); }
/** Save current-position realized gains. */ export function saveCurRealized() { _saveInput(_posKey('9mm_realized_pos_'), 'curRealizedInput', 'curRealizedInputWrap', () => { if (_lastStatus) _updateKpis(_lastStatus); }, true); }

// ── Initial deposit (user-entered, persisted in localStorage) ────────────────

const _INITIAL_DEPOSIT_KEY = '9mm_initial_deposit';
/** Load initial deposit — pool-scoped key takes priority, then global fallback. */
export function loadInitialDeposit() { const v = _loadNum(_poolKey('9mm_deposit_pool_'), false); return v > 0 ? v : _loadNum(_INITIAL_DEPOSIT_KEY, false); }
function _refreshDepositLabel() { const s = loadInitialDeposit(), d = g('lifetimeDepositDisplay'); if (d) d.textContent = s > 0 ? '$usd ' + s.toFixed(2) : '—'; }

// ── Current-position deposit ─────────────────────────────────────────────────

/** Load the current position's deposit. */
export function loadCurDeposit() { return _loadNum(_posKey('9mm_deposit_pos_'), false); }
export function refreshCurDepositDisplay(fallback) { const v = loadCurDeposit() || (fallback || 0), d = g('curDepositDisplay'); if (d) d.textContent = v > 0 ? '$usd ' + v.toFixed(2) : '—'; }
/** Toggle the current-position deposit input. */ export function toggleCurDeposit() { _toggleWrap('curDepositInputWrap', 'curDepositInput', loadCurDeposit); }
/** Save the current-position deposit. */ export function saveCurDeposit() { _saveInput(_posKey('9mm_deposit_pos_'), 'curDepositInput', 'curDepositInputWrap', () => refreshCurDepositDisplay(), false); }
/** Toggle the initial deposit input. */ export function toggleInitialDeposit() { _toggleWrap('initialDepositInputWrap', 'initialDepositInput', loadInitialDeposit); }
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
  if (val === null || val === undefined || isNaN(val)) return '\u2014';
  const abs = Math.abs(val).toFixed(2);
  return abs === '0.00' ? '$usd 0.00' : (val < 0 ? '-' : '') + '$usd ' + abs;
}
/** Check if a value rounds to zero at 2 decimal places. */
function _isDisplayZero(val) { return Math.abs(val).toFixed(2) === '0.00'; }

/** Format a percentage value with sign and set it on an element. */
function _setPctSpan(id, val, deposit) {
  const el = g(id); if (!el) return;
  if (!deposit || deposit <= 0) { el.textContent = ''; return; }
  const pct = (val / deposit) * 100;
  const rounded = pct.toFixed(2);
  const isZero = rounded === '0.00' || rounded === '-0.00';
  const sign = isZero ? '' : pct > 0 ? '+' : '';
  el.textContent = sign + (isZero ? '0.00' : rounded) + '%';
}

/** Compute annualized APR and display on a span. Green/red/white coloring. */
function _setAprSpan(id, val, deposit, firstDate) {
  const el = g(id); if (!el) return;
  if (!deposit || deposit <= 0 || !firstDate) { el.textContent = '\u2014'; return; }
  const elapsedSec = (Date.now() - new Date(firstDate + 'T00:00:00Z').getTime()) / 1000;
  if (elapsedSec <= 0) { el.textContent = '\u2014'; return; }
  const apr = (val / deposit) / (elapsedSec / (365.25 * 24 * 3600)) * 100;
  if (Math.abs(apr) < 0.005) { el.textContent = 'APR 0.00%'; el.style.color = ''; return; }
  el.textContent = apr > 0 ? 'APR ' + apr.toFixed(2) + '%' : 'APR \u2212' + Math.abs(apr).toFixed(2) + '%';
  el.style.color = apr > 0 ? '#0f0' : '#f44';
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
  const pnl = g('kpiPnl'), pnlSub = g('kpiPnlPct');
  if (d.pnlSnapshot) {
    _setLeadingText(pnl, _fmtUsd(total));
    pnl.className = 'kpi-value 9mm-pos-mgr-kpi-pct-row ' + (_isDisplayZero(total) ? 'neu' : total > 0 ? 'pos' : 'neg');
    _setPctSpan('kpiPnlPctVal', total, curDeposit);
    const posStart = d.hodlBaseline?.mintDate || null;
    _setAprSpan('kpiPnlApr', total, curDeposit, posStart);
    if (posStart) {
      pnlSub.textContent = fmtDateTime(posStart + 'T00:00:00Z', { dateOnly: true }) + ' \u2192 ' + fmtDateTime(d.pnlSnapshot.snapshotDateUtc + 'T00:00:00Z', { dateOnly: true });
    } else { pnlSub.textContent = 'cumulative'; }
  } else if (d.running) {
    if (realized > 0) { _setLeadingText(pnl, _fmtUsd(realized)); pnl.className = 'kpi-value 9mm-pos-mgr-kpi-pct-row pos'; }
    pnlSub.textContent = 'Awaiting First P\u0026L Snapshot';
  }
}

/** Format a duration in ms as "Xd Yh Zm". */
function _fmtDuration(ms) {
  const d = Math.floor(ms / 86400000), h = Math.floor((ms % 86400000) / 3600000), m = Math.floor((ms % 3600000) / 60000);
  return (d > 0 ? d + 'd ' : '') + (h > 0 || d > 0 ? h + 'h ' : '') + m + 'm';
}

function _updateCurIL(d, deposit) {
  const raw = d.pnlSnapshot ? d.pnlSnapshot.totalIL : undefined, el = g('curIL');
  if (el) { if (raw === null || raw === undefined) { _setLeadingText(el, '\u2014'); el.className = 'kpi-value 9mm-pos-mgr-kpi-pct-row neu'; }
    else { _setLeadingText(el, _fmtUsd(raw)); el.className = 'kpi-value 9mm-pos-mgr-kpi-pct-row ' + (_isDisplayZero(raw) ? 'neu' : raw > 0 ? 'pos' : 'neg'); } }
  _setPctSpan('curILPct', raw ?? 0, deposit);
}
function _updatePosDuration(d) {
  const el = g('kpiPosDuration'); if (!el) return;
  const mt = d.positionMintTimestamp || d.hodlBaseline?.mintTimestamp || d.hodlBaseline?.mintDate;
  if (!mt) { el.textContent = '\u2014'; return; }
  const ms = Date.now() - (mt.includes('T') ? new Date(mt).getTime() : new Date(mt + 'T00:00:00Z').getTime());
  el.textContent = ms > 0 ? 'Active: ' + _fmtDuration(ms) + ' \u00B7 Minted: ' + fmtDateTime(mt) : '';
}

function _applySnapshotKpis(d, deposit, curRealized) {
  const ep = d.pnlSnapshot.liveEpoch, cv = d.pnlSnapshot.currentValue || 0;
  const val = g('kpiValue'); if (val) val.textContent = _fmtUsd(cv);
  _setPnlVal('pnlFees', ep ? (ep.fees || 0) : 0);
  _setPnlVal('pnlPrice', deposit > 0 ? cv - deposit : 0);
  _setPnlVal('pnlRealized', curRealized);
  const dep = g('kpiDeposit'); if (dep) dep.textContent = _fmtUsd(deposit);
  _updateCurIL(d, deposit); _updatePosDuration(d);
  _setProfitKpi('curProfit', ep ? (ep.fees || 0) : 0, ep ? (ep.gas || 0) : 0, d.pnlSnapshot.totalIL);
}

/** Resolve the bot-detected deposit (excluding user-entered lifetime value). */
function _botDetectedDeposit(d) {
  if (d.initialDepositUsd > 0) return d.initialDepositUsd;
  if (d.hodlBaseline?.entryValue > 0) return d.hodlBaseline.entryValue;
  return d.pnlSnapshot ? (d.pnlSnapshot.initialDeposit || 0) : 0;
}

/** Resolve current-position deposit: user-entered → GeckoTerminal historical → epoch entry. */
function _resolveCurDeposit(d) {
  const saved = loadCurDeposit(); if (saved > 0) return saved;
  return d.hodlBaseline?.entryValue > 0 ? d.hodlBaseline.entryValue : (d.pnlSnapshot?.liveEpoch?.entryValue || 0);
}

/** Price change P&L: on-chain currentValue minus deposit (user-entered or GeckoTerminal historical). */
function _priceChangePnl(d, deposit) {
  return d.pnlSnapshot && deposit > 0 ? (d.pnlSnapshot.currentValue || 0) - deposit : 0;
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
  const curDep = _resolveCurDeposit(d), ltUserDep = loadInitialDeposit();
  const ltDep = ltUserDep > 0 ? ltUserDep : _botDetectedDeposit(d);
  const curPc = _priceChangePnl(d, curDep), ltPc = _priceChangePnl(d, ltDep);
  return { curTotal: curPc + curFees + curRealized, ltTotal: ltPc + ltFees + ltRealized,
    curDep, ltDep, curRealized, ltFees, ltRealized, ltPriceChange: ltPc };
}

/** Update Lifetime (Net Return) panel — runs regardless of closed-position view. */
function _updateLifetimeKpis(d) {
  if (!posStore.getActive() || !d.pnlSnapshot || (d.running && !d.rebalanceScanComplete)) return;
  const t = _resolveKpiTotals(d);
  _updateNetReturn(d, t.ltTotal, t.ltDep, t.ltFees, t.ltPriceChange, t.ltRealized);
  const dd = g('lifetimeDepositDisplay');
  if (dd) dd.textContent = t.ltDep > 0 ? '$usd ' + t.ltDep.toFixed(2) : '\u2014';
}
function _updateKpis(d) {
  if (!posStore.getActive()) return;
  const t = _resolveKpiTotals(d);
  _updatePnlHeader(d, t.curTotal, t.curRealized, t.curDep);
  if (d.pnlSnapshot) { _applySnapshotKpis(d, t.curDep, t.curRealized); }
  else if (d.running) { const dep = g('kpiDeposit'); if (dep) dep.textContent = 'Awaiting Price Data'; }
  if (d.pnlSnapshot) {
    if (!d.running || d.rebalanceScanComplete) { _updateNetReturn(d, t.ltTotal, t.ltDep, t.ltFees, t.ltPriceChange, t.ltRealized);
      const ld = g('lifetimeDepositDisplay'); if (ld) ld.textContent = t.ltDep > 0 ? '$usd ' + t.ltDep.toFixed(2) : '\u2014'; }
    refreshCurDepositDisplay(d.hodlBaseline?.entryValue || d.pnlSnapshot.liveEpoch?.entryValue || 0); }
}
/** Render the "fees + priceChange + realized" breakdown, or "—" while pending. */
function _updateNetBreakdown(bd, fees, priceChange, realized) {
  if (fees === undefined && priceChange === undefined) { bd.textContent = '\u2014'; return; }
  const f = (fees || 0).toFixed(2), p = priceChange || 0, r = (realized || 0).toFixed(2);
  bd.textContent = f + (p >= 0 ? ' + ' : ' \u2212 ') + Math.abs(p).toFixed(2) + ' + ' + r; }
/** Set a Profit KPI element: fees - gas + ilg. */
function _setProfitKpi(id, fees, gas, ilg) {
  const el = g(id); if (!el) return;
  if (ilg === null || ilg === undefined) { _setLeadingText(el, '\u2014'); el.className = 'kpi-value 9mm-pos-mgr-kpi-pct-row neu'; return; }
  const p = (fees || 0) - (gas || 0) + ilg; _setLeadingText(el, _fmtUsd(p));
  el.className = 'kpi-value 9mm-pos-mgr-kpi-pct-row ' + (_isDisplayZero(p) ? 'neu' : p > 0 ? 'pos' : 'neg');
}

/** Update the Net Return KPI card and its IL breakdown. */
function _updateNetReturn(d, total, ltDeposit, ltFees, ltPriceChange, ltRealized) {
  const net = g('kpiNet'); if (d.pnlSnapshot) {
    _setLeadingText(net, _fmtUsd(total)); net.className = 'kpi-value 9mm-pos-mgr-kpi-pct-row ' + (_isDisplayZero(total) ? 'neu' : total > 0 ? 'pos' : 'neg');
    _setPctSpan('kpiNetPct', total, ltDeposit);
    _setAprSpan('kpiNetApr', total, ltDeposit, _poolFirstDate || d.pnlSnapshot.firstEpochDateUtc);
    const bd = g('kpiNetBreakdown'); if (bd) _updateNetBreakdown(bd, ltFees, ltPriceChange, ltRealized);
  }
  const il = d.pnlSnapshot ? (d.pnlSnapshot.lifetimeIL ?? d.pnlSnapshot.totalIL ?? null) : null;
  const ilEl = g('netIL'); if (ilEl && d.pnlSnapshot) {
    if (il === null) { _setLeadingText(ilEl, '\u2014'); ilEl.className = 'kpi-value 9mm-pos-mgr-kpi-pct-row neu'; }
    else { _setLeadingText(ilEl, _fmtUsd(il)); ilEl.className = 'kpi-value 9mm-pos-mgr-kpi-pct-row ' + (_isDisplayZero(il) ? 'neu' : il > 0 ? 'pos' : 'neg');
      _setPctSpan('netILPct', il, ltDeposit); _setAprSpan('netILApr', il, ltDeposit, _poolFirstDate || d.pnlSnapshot.firstEpochDateUtc); } }
  _setProfitKpi('ltProfit', ltFees, d.pnlSnapshot?.totalGas || 0, il);
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
  const oor = g('sOorDuration'); if (oor) oor.textContent = botConfig.oorSince ? _fmtDuration(Date.now() - botConfig.oorSince) : 'n/a';
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

  // Red threshold bars: X% of range width beyond each boundary.
  // Bot's _isBeyondThreshold uses the same formula.
  const threshPct = (botConfig.oorThreshold || 5) / 100;
  const rangeSpan = hi - lo;
  const previewLo = lo - rangeSpan * threshPct;
  const previewHi = hi + rangeSpan * threshPct;

  // Viewport padding ensures threshold bars are always visible
  const pad = rangeSpan * Math.max(0.6, threshPct * 1.5);
  const vMin = Math.max(0, lo - pad);
  const vMax = hi + pad;
  const vSpan = vMax - vMin;

  const pct = (p) => ((p - vMin) / vSpan * 100).toFixed(2) + '%';

  const ra = g('rangeActive');
  if (ra) { ra.style.left = pct(lo); ra.style.width = ((hi - lo) / vSpan * 100).toFixed(2) + '%'; }
  const hl = g('hl'), hr = g('hr');
  if (hl) hl.style.left = pct(lo);  if (hr) hr.style.left = pct(hi);
  const rsym = _activeToken1Symbol(), rlL = g('rlL'), rlR = g('rlR');
  if (rlL) { rlL.style.left = pct(lo); rlL.textContent = lo.toFixed(6) + ' ' + rsym; }
  if (rlR) { rlR.style.left = pct(hi); rlR.textContent = hi.toFixed(6) + ' ' + rsym; }
  const pm = g('pm');  if (pm && botConfig.price > 0) { pm.style.left = pct(botConfig.price); pm.style.visibility = 'visible'; }
  const lnL = g('rangeLnL'), lnR = g('rangeLnR'), rsym2 = _activeToken1Symbol();
  if (lnL) { lnL.style.left = pct(previewLo); lnL.title = 'Rebalance trigger: ' + previewLo.toFixed(6) + ' ' + rsym2 + ' (' + botConfig.oorThreshold + '% below lower)'; }
  if (lnR) { lnR.style.left = pct(previewHi); lnR.title = 'Rebalance trigger: ' + previewHi.toFixed(6) + ' ' + rsym2 + ' (' + botConfig.oorThreshold + '% above upper)'; }
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
    const decAdj = (d.poolState.decimals0 !== undefined && d.poolState.decimals1 !== undefined) ? Math.pow(10, d.poolState.decimals0 - d.poolState.decimals1) : 1;
    botConfig.lower = Math.pow(1.0001, botConfig.tL) * decAdj;
    botConfig.upper = Math.pow(1.0001, botConfig.tU) * decAdj;
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
  if (d.oorRecoveredMin > 0 && !d.rebalancePaused && !_recoveryModalShown) {
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
  if (today) today.textContent = ts.dailyCount + ' / ' + (d.maxRebalancesPerDay || ts.dailyMax);
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
  // OOR threshold excluded — localStorage per-position value is the source of truth,
  // synced to server on startup and position switch via POST /api/config.
  const map = { slippagePct: 'inSlip', checkIntervalSec: 'inInterval',
    minRebalanceIntervalMin: 'inMinInterval', maxRebalancesPerDay: 'inMaxReb',
    gasStrategy: 'inGas', rebalanceTimeoutMin: 'inOorTimeout' };
  for (const [key, elId] of Object.entries(map)) { if (d[key] !== undefined && d[key] !== null) { const el = g(elId); if (el) el.value = d[key]; } }
  if (d.initialDepositUsd > 0 && !loadInitialDeposit()) {
    try { localStorage.setItem(_INITIAL_DEPOSIT_KEY, String(d.initialDepositUsd)); } catch { /* */ }
  }
  _refreshDepositLabel();
}

const _REB_EVENTS_CACHE_KEY = '9mm_rebalance_events';
function _cacheRebalanceEvents(events) { try { localStorage.setItem(_REB_EVENTS_CACHE_KEY, JSON.stringify(events)); } catch { /* */ } }
function _loadCachedRebalanceEvents() { try { const r = localStorage.getItem(_REB_EVENTS_CACHE_KEY); if (!r) return null; const p = JSON.parse(r); return Array.isArray(p) ? p : null; } catch { return null; } }

let _scanWasComplete = false;
function _updateSyncBadge(complete, progress) {
  const badge = g('syncBadge'); if (!badge) return;
  const pct = typeof progress === 'number' ? progress : 0;
  badge.textContent = complete ? 'Synced' : pct > 0 ? 'Syncing ' + pct + '%' : 'Syncing\u2026';
  badge.style.background = !complete && pct > 0
    ? 'linear-gradient(to right, rgb(255 184 0 / 20%) ' + pct + '%, rgb(255 184 0 / 6%) ' + pct + '%)' : '';
  badge.classList.toggle('done', complete);
  if (complete && !_scanWasComplete && isViewingClosedPos()) refetchClosedPosHistory();
  _scanWasComplete = complete;
}

/** Reset all wallet-specific polling state. Called on wallet change. */
export function resetPollingState() {
  _lastStatus = null; _historyPopulated = false; _poolFirstDate = null;
  _lastRebalanceAt = null; _configSynced = false; _scanWasComplete = false;
  try { localStorage.removeItem(_REB_EVENTS_CACHE_KEY); } catch { /* */ }
  _scanWasComplete = false; refreshCurDepositDisplay(0);
  const dd = g('lifetimeDepositDisplay'); if (dd) dd.textContent = '\u2014';
}

/** Auto-add the bot's active position to the store if the store is empty and bot is running.
 *  Skipped when store is empty — the rescan in setBotActiveTokenId handles discovery with full metadata. */
function _ensureActiveInStore(d) {
  if (posStore.count() > 0 || !d.activePosition?.tokenId || !d.running) return;
  // Store is empty — a rescan is needed to get full metadata (symbols, contractAddress).
  // setBotActiveTokenId triggers the rescan; no need to add incomplete entries here.
}

/** Ensure the bot's active tokenId is in posStore; select if found, skip if missing.
 *  Missing positions are discovered by the rescan triggered in setBotActiveTokenId. */
function _ensureBotPosSelected(d, active) {
  const bp = d.activePosition;
  if (!bp.tokenId || String(bp.tokenId) === String(active.tokenId)) return false;
  const idx = posStore.entries.findIndex(e => e.positionType === 'nft' && String(e.tokenId) === String(bp.tokenId));
  if (idx < 0) return false; // Not in store yet — rescan will add it with full metadata
  if (idx !== posStore.activeIdx) { posStore.select(idx); updatePosStripUI(); return true; }
  return false;
}

/** Sync the active position from bot status back to the browser posStore. */
function _syncActivePosition(d) {
  if (!d.activePosition) return;
  _ensureActiveInStore(d);
  const active = posStore.getActive();
  if (!active || active.positionType !== 'nft') return;
  const botPos = d.activePosition;
  if (_ensureBotPosSelected(d, active)) return;

  const isNew = d.lastRebalanceAt && d.lastRebalanceAt !== _lastRebalanceAt;
  if (isNew) {
    _lastRebalanceAt = d.lastRebalanceAt;
    // Use the last rebalance event for accurate old→new tokenId
    const evts = d.rebalanceEvents || [];
    const lastEv = evts.length ? evts[evts.length - 1] : null;
    if (lastEv) {
      const txPart = lastEv.txHash ? ' ' + _fmtTxCopy(lastEv.txHash) : '';
      act('\u2699', 'fee', 'Rebalance',
        'NFT #' + lastEv.oldTokenId + ' \u2192 #' + lastEv.newTokenId + txPart);
    }
  }

  if (botPos.liquidity !== undefined) active.liquidity = String(botPos.liquidity);
  // Don't mutate active entry's tokenId — setBotActiveTokenId handles the switch
  // via rescan, which adds the new NFT with full metadata (symbols, contractAddress).
}

/** Load cached rebalance events if server provided none, or cache new ones. */
function _syncRebalanceCache(d) {
  const evts = d.rebalanceEvents;
  if (!evts || evts.length === 0) { const c = _loadCachedRebalanceEvents(); if (c && c.length > 0) d.rebalanceEvents = c; }
  else _cacheRebalanceEvents(evts);
}

/** Confirm trigger settings in the header row from server data. */
function _updateTriggerDisplay(d) {
  const th = g('activeOorThreshold'); if (th && d.rebalanceOutOfRangeThresholdPercent !== undefined) th.textContent = d.rebalanceOutOfRangeThresholdPercent;
  const to = g('activeOorTimeout'); if (to) to.textContent = d.rebalanceTimeoutMin > 0 ? d.rebalanceTimeoutMin : d.rebalanceTimeoutMin === 0 ? 'disabled' : '\u2014';
}

/** Populate the activity log with historical rebalance events (once scan completes). */
function _populateHistoryOnce(data) {
  if (_historyPopulated || !data.rebalanceEvents || !data.rebalanceEvents.length) return;
  // Wait for the event scanner to finish so we get the full set, not stale localStorage cache
  if (data.rebalanceScanComplete !== true) return;
  _historyPopulated = true;
  [...data.rebalanceEvents].sort((a, b) => a.timestamp - b.timestamp).forEach(ev => {
    const txPart = ev.txHash ? ' ' + _fmtTxCopy(ev.txHash) : '';
    act('\u2699', 'fee', 'Rebalance', 'NFT #' + ev.oldTokenId + ' \u2192 #' + ev.newTokenId + txPart,
      ev.dateStr ? new Date(ev.dateStr) : new Date(ev.timestamp * 1000));
  });
}

/** Main update function — routes /api/status data to all UI elements. */
function updateDashboardFromStatus(data) {
  _lastStatus = data;
  updateILDebugData(data, posStore);

  if (data.withinThreshold !== undefined) botConfig.withinThreshold = data.withinThreshold;
  botConfig.oorSince = data.oorSince || null; _updateBotStatus(data);
  _updateThrottleKpis(data);
  _updateTriggerDisplay(data);

  // Skip all wallet-specific updates when client has no wallet or wallets don't match
  const sw = data.walletAddress || data.wallet || '';
  if (sw && (!wallet.address || wallet.address.toLowerCase() !== sw.toLowerCase())) return;

  if (data.activePosition?.tokenId) console.log('[dash] poll: server activePosition=#%s', data.activePosition.tokenId);
  _syncConfigFromServer(data); setBotActiveTokenId(data.activePosition?.tokenId);
  _syncRebalanceCache(data);  _updateSyncBadge(data.rebalanceScanComplete === true, data.rebalanceScanProgress);

  if (!_poolFirstDate && data.poolFirstMintDate) _poolFirstDate = data.poolFirstMintDate;
  _populateHistoryOnce(data);

  updateHistoryFromStatus(data);

  // Always update the range monitor so the chart shows the bot's active position
  _updatePriceMarker(data);
  // Lifetime panel updates regardless of closed-position view
  _updateLifetimeKpis(data);

  // While viewing a closed position, keep non-KPI updates running above
  // but skip position/KPI overwrites so historical data stays visible.
  if (isViewingClosedPos()) return;

  _syncActivePosition(data);
  _updatePosStatus(data);
  _updateKpis(data);
  _updatePositionTicks(data);
  _updateComposition(data); _checkHodlBaselineDialog(data); reapplyPrivacyBlur();
}

let _pollFailCount = 0;
function _onPollFail() { _pollFailCount++; if (_pollFailCount >= 3) _setStatusPill('status-pill danger', 'dot red', 'HALTED'); }
async function _pollStatus() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) { _onPollFail(); return; }
    _pollFailCount = 0;
    updateDashboardFromStatus(await res.json());
  } catch (_) { _onPollFail(); }
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
