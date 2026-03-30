/**
 * @file dashboard-data.js
 * @description Polls /api/status, updates live UI elements. Re-exports.
 */
import {
  g, botConfig, compositeKey, fmtDateTime, act, ACT_ICONS,
  truncName, fmtNum,
} from './dashboard-helpers.js';
import {
  posStore, updateManagedPositions, isPositionManaged,
} from './dashboard-positions.js';
import { updateHistoryFromStatus, updateHistorySyncLabels } from './dashboard-history.js';
import { wallet } from './dashboard-wallet.js';
import {
  reapplyPrivacyBlur, updateManageBadge,
} from './dashboard-events.js';
import {
  isViewingClosedPos, refetchClosedPosHistory,
} from './dashboard-closed-pos.js';
import { updateILDebugData } from './dashboard-il-debug.js';
import {
  injectDataDeps, _wireDepositKpis, loadRealizedGains, loadInitialDeposit,
  refreshDepositLabel, refreshCurDepositDisplay, loadCurRealized,
  toggleRealizedInput, saveRealizedGains,
  toggleCurRealized, saveCurRealized,
  toggleInitialDeposit, saveInitialDeposit,
  toggleCurDeposit, saveCurDeposit,
  INITIAL_DEPOSIT_KEY, loadCurDeposit,
} from './dashboard-data-deposit.js';
import {
  _fmtUsd, setKpiValue, resetKpis,
  _fmtDuration, _updateKpis,
  _updateLifetimeKpis, checkHodlBaselineDialog,
  setPoolFirstDate, getPoolFirstDate,
  positionRangeVisual, updateRangePctLabels,
  _activeToken1Symbol,
} from './dashboard-data-kpi.js';
import { updateTriggerDisplay } from './dashboard-throttle.js';
export {
  injectDataDeps, loadRealizedGains,
  toggleRealizedInput, saveRealizedGains,
  loadCurRealized, toggleCurRealized, saveCurRealized, loadInitialDeposit,
  refreshDepositLabel, loadCurDeposit, refreshCurDepositDisplay,
  toggleCurDeposit, saveCurDeposit,
  toggleInitialDeposit, saveInitialDeposit,
  _fmtUsd, setKpiValue, resetKpis,
  checkHodlBaselineDialog,
  positionRangeVisual, updateRangePctLabels,
};
let _dataTimerId = null, _lastStatus = null, _historyPopulated = false,
  _lastRebalanceAt = null, _configSynced = false;
_wireDepositKpis(() => _lastStatus, (s) => _updateKpis(s));
let _errorModalShown = false, _recoveryModalShown = false,
  _rangeRoundedShown = false;
function _dismissRebalanceModal() {
  const el = document.getElementById('rebalanceErrorModal');
  if (el) el.remove(); _errorModalShown = false;
}
export function _createModal(id, cssClass, title, bodyHtml) {
  const o = document.createElement('div');
  o.className = '9mm-pos-mgr-modal-overlay'; if (id) o.id = id;
  o.innerHTML = '<div class="9mm-pos-mgr-modal ' + cssClass + '"><h3>' +
    title + '</h3><div class="9mm-pos-mgr-modal-body">' + bodyHtml +
    '</div><button class="9mm-pos-mgr-modal-close"' +
    ' data-dismiss-modal>OK</button></div>';
  document.body.appendChild(o);
}
function _showRebalanceErrorModal(message) {
  if (_errorModalShown || !message) return;
  _errorModalShown = true; _recoveryModalShown = false;
  const t = message.includes('liquidity is too thin') ||
    message.includes('no liquidity') ? 'thin'
    : message.includes('exceeds slippage') ? 'slip'
      : message.includes('insufficient gas') ? 'gas' : '';
  const footer = t === 'thin'
    ? 'Source tokens externally, recreate the ' +
      'LP position, then select the new NFT.'
    : t === 'slip'
      ? 'Adjust the slippage setting, then ' +
        'use the manual Rebalance button.'
      : t === 'gas'
        ? 'Send native tokens to the wallet' +
          ' address, then manual Rebalance.'
        : 'The bot will keep retrying. Check logs.';
  _createModal('rebalanceErrorModal', '',
    t ? 'Rebalance Paused' : 'Rebalance Failing',
    '<p>' + message + '</p><p class="9mm-pos-mgr-text-muted">' +
      footer + '</p>');
}
function _showRecoveryModal(minutes) {
  if (_recoveryModalShown) return; _recoveryModalShown = true;
  _createModal(null, '9mm-pos-mgr-modal-caution', 'Position Recovered',
    '<p>Price returned to range after ~<strong>' + minutes +
      ' min</strong> of failed attempts.</p>' +
      '<p class="9mm-pos-mgr-text-muted">No rebalance needed.</p>');
}
function _activeTokenNames() {
  const a = posStore.getActive();
  const t0 = a ? a.token0Symbol || 'Token 0' : 'Token 0',
    t1 = a ? a.token1Symbol || 'Token 1' : 'Token 1';
  return { t0: truncName(t0, 12), t1: truncName(t1, 12),
    t0Full: t0, t1Full: t1 };
}
function _updateComposition(d) {
  if (!d.positionStats) return;
  const r0 = d.positionStats.compositionRatio ?? 0.5;
  const c0 = g('c0'), c1 = g('c1');
  if (c0) c0.style.width = (r0 * 100).toFixed(1) + '%';
  if (c1) c1.style.width = ((1 - r0) * 100).toFixed(1) + '%';
  const tn = _activeTokenNames(), cl0 = g('cl0'), cl1 = g('cl1');
  if (cl0) {
    cl0.textContent = '\u25A0 ' + tn.t0 +
      ': ' + (r0 * 100).toFixed(0) + '%';
    cl0.title = tn.t0Full;
  }
  if (cl1) {
    cl1.textContent = '\u25A0 ' + tn.t1 + ': ' +
      ((1 - r0) * 100).toFixed(0) + '%';
    cl1.title = tn.t1Full;
  }
  const sl0 = g('statT0Label'), sl1 = g('statT1Label');
  if (sl0) { sl0.textContent = tn.t0; sl0.title = tn.t0Full; }
  if (sl1) { sl1.textContent = tn.t1; sl1.title = tn.t1Full; }
  const sh0 = g('statShare0Label'), sh1 = g('statShare1Label');
  if (sh0) {
    sh0.textContent = 'Pool Share ' + tn.t0;
    sh0.title = tn.t0Full;
  }
  if (sh1) {
    sh1.textContent = 'Pool Share ' + tn.t1;
    sh1.title = tn.t1Full;
  }
  if (d.positionStats.balance0 !== undefined) {
    const sw = g('sWpls');
    if (sw) sw.textContent = d.positionStats.balance0;
  }
  if (d.positionStats.balance1 !== undefined) {
    const su = g('sUsdc');
    if (su) su.textContent = d.positionStats.balance1;
  }
}
function _updatePositionTicks(d) {
  if (d.poolState) {
    const tc = g('sTC');
    if (tc) tc.textContent = d.poolState.tick ?? '\u2014';
  }
  if (!d.activePosition) return;
  const pos = d.activePosition, tl = g('sTL'), tu = g('sTU');
  if (tl) tl.textContent = pos.tickLower ?? '\u2014';
  if (tu) tu.textContent = pos.tickUpper ?? '\u2014';
  if (d.positionStats) {
    const s0 = g('sShare0'), s1 = g('sShare1');
    if (s0) s0.textContent = d.positionStats.poolShare0Pct !== undefined
      ? d.positionStats.poolShare0Pct.toFixed(4) + '%' : '\u2014';
    if (s1) s1.textContent = d.positionStats.poolShare1Pct !== undefined
      ? d.positionStats.poolShare1Pct.toFixed(4) + '%' : '\u2014';
  }
  const oor = g('sOorDuration');
  if (oor) oor.textContent = botConfig.oorSince
    ? _fmtDuration(Date.now() - botConfig.oorSince) : 'n/a';
}
function _fmtTxCopy(hash) {
  const short = hash.slice(0, 4) + '\u2026' + hash.slice(-4);
  return '<span class="9mm-pos-mgr-copy-icon" title="Copy full TX hash"' +
    ' data-copy-tx="' + hash + '">' + short + ' &#x274F;</span>';
}
function _updatePosStatus(d) {
  const el = g('curPosStatus');
  if (!el) return;
  const active = posStore.getActive();
  if (!active) {
    el.textContent = ''; el.className = '9mm-pos-mgr-pos-status'; return;
  }
  const liq = d.activePosition
    ? (d.activePosition.liquidity ?? active.liquidity) : active.liquidity;
  const isClosed = liq !== undefined && liq !== null && BigInt(liq) === 0n;
  el.textContent = isClosed ? 'CLOSED' : 'ACTIVE';
  el.className = '9mm-pos-mgr-pos-status ' +
    (isClosed ? 'closed' : 'active');
}
function _setStatusPill(pillCls, dotCls, label, tip) {
  const pill = g('botStatusPill'), dot = g('botDot'),
    text = g('botStatusText');
  if (pill) { pill.className = pillCls; pill.title = tip || ''; }
  if (dot) dot.className = dotCls;
  if (text) text.textContent = label;
}
function _updatePriceMarker(d) {
  if (!d.poolState) return;
  const a = posStore.getActive();
  if (a && !isPositionManaged(a.tokenId)) return;
  botConfig.price = d.poolState.price;
  const pml = g('pmlabel');
  if (pml) {
    pml.textContent = fmtNum(d.poolState.price) +
      ' ' + _activeToken1Symbol();
    pml.title = d.poolState.price.toString();
  }
  if (d.activePosition) {
    botConfig.tL = d.activePosition.tickLower || 0;
    botConfig.tU = d.activePosition.tickUpper || 0;
    const decAdj = d.poolState.decimals0 !== undefined &&
      d.poolState.decimals1 !== undefined
      ? Math.pow(10, d.poolState.decimals0 - d.poolState.decimals1) : 1;
    botConfig.lower = Math.pow(1.0001, botConfig.tL) * decAdj;
    botConfig.upper = Math.pow(1.0001, botConfig.tU) * decAdj;
  }
  updateRangePctLabels(
    d.poolState.price, botConfig.lower,
    botConfig.upper);
  positionRangeVisual();
}
function _setIdlePill(d) {
  _setStatusPill('status-pill warning', 'dot yellow', 'IDLE',
    (d._managedPositions || []).length === 0
      ? 'No positions are being managed. After syncing, select a position and click Manage.' : '');
}
function _updateBotStatus(d) {
  if (d.oorRecoveredMin > 0 &&
    !d.rebalancePaused && !_recoveryModalShown) {
    _dismissRebalanceModal();
    _showRecoveryModal(d.oorRecoveredMin);
  }
  if (d.rangeRounded && !_rangeRoundedShown) {
    _rangeRoundedShown = true;
    _createModal(null, '9mm-pos-mgr-modal-caution', 'Range Width Adjusted',
      '<p>Requested <strong>' + d.rangeRounded.requested +
        '%</strong> but tick spacing rounded to <strong>' +
        d.rangeRounded.effective + '%</strong>.</p>' +
        '<p class="9mm-pos-mgr-text-muted">' +
        'V3 uses tick-spacing multiples.</p>');
  }
  if (d.txCancelled && !d._txCancelLogged) {
    d._txCancelLogged = true;
    act(ACT_ICONS.warn, 'alert', 'TX Auto-Cancelled',
      d.txCancelled.message + (d.txCancelled.cancelTxHash
        ? ' (TX: ' + d.txCancelled.cancelTxHash.slice(0, 10) + '\u2026)'
        : ''));
  }
  if (d.rebalancePaused) {
    _setStatusPill('status-pill danger', 'dot red', 'RETRYING');
    _showRebalanceErrorModal(d.rebalanceError);
  } else if (d.halted) {
    _setStatusPill('status-pill danger', 'dot red', 'HALTED');
  } else if (d.running) {
    _setStatusPill('status-pill active', 'dot green', 'RUNNING');
  } else {
    _setIdlePill(d);
  }
  _updatePriceMarker(d);
  const tag = g('lastCheckTag');
  if (tag && d.updatedAt) {
    const ago = Math.floor(
      (Date.now() - new Date(d.updatedAt).getTime()) / 1000);
    tag.textContent = ago < 5 ? 'just now' : ago + 's ago';
    tag.title = fmtDateTime(d.updatedAt);
  }
  const lastLabel = g('lastCheckLabel');
  if (lastLabel && d.updatedAt)
    lastLabel.textContent = fmtDateTime(d.updatedAt);
}
function _fmtResetTime(dailyResetAt) {
  if (!dailyResetAt) return '';
  const d = new Date(dailyResetAt);
  const utc = d.toISOString().slice(11, 16) + ' UTC';
  const local = d.toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit' });
  const tz = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
    .formatToParts(d).find((p) => p.type === 'timeZoneName');
  return 'Resets ' + utc + ' (' + local +
    ' ' + (tz ? tz.value : 'local') + ')';
}
function _normalizedPoolKey(pos) {
  if (!pos?.token0 || !pos?.token1 || !pos?.fee) return null;
  const a = pos.token0.toLowerCase(), b = pos.token1.toLowerCase();
  return (a < b ? a + '-' + b : b + '-' + a) + '-' + pos.fee;
}
function _updateThrottleKpis(d) {
  const ts = d.throttleState, today = g('kpiToday');
  if (today) { const max = (ts && ts.dailyMax)
      || d.maxRebalancesPerDay || null;
    const pk = _normalizedPoolKey(posStore.getActive());
    const cnt = pk && d._poolDailyCounts
      ? d._poolDailyCounts[pk] || 0
      : ts ? ts.dailyCount : 0;
    if (!max) { today.textContent = '\u2014'; today.style.color = ''; }
    else { const ratio = cnt / max;
      today.textContent = cnt + ' / ' + max;
      today.style.color = ratio >= 0.9 ? '#ff3b5c'
        : ratio >= 0.66 ? '#ff6b35'
        : ratio >= 0.5 ? '#ffb800' : '#e0eaf4'; } }
  const todaySub = g('kpiTodaySub');
  if (todaySub) {
    const lt = d.rebalanceEvents
      ? d.rebalanceEvents.length : 0;
    todaySub.innerHTML = lt + ' Lifetime<br>'
      + _fmtResetTime(ts?.dailyResetAt); } }
function _syncConfigFromServer(d) {
  if (_configSynced) return;
  _configSynced = true;
  const map = { slippagePct: 'inSlip', checkIntervalSec: 'inInterval',
    minRebalanceIntervalMin: 'inMinInterval',
    maxRebalancesPerDay: 'inMaxReb',
    gasStrategy: 'inGas', rebalanceTimeoutMin: 'inOorTimeout' };
  for (const [key, elId] of Object.entries(map)) {
    if (d[key] !== undefined && d[key] !== null) {
      const el = g(elId);
      if (el) el.value = d[key];
    }
  }
  if (d.initialDepositUsd > 0 && !loadInitialDeposit())
    try { localStorage.setItem(INITIAL_DEPOSIT_KEY,
      String(d.initialDepositUsd)); } catch { /* */ }
  refreshDepositLabel();
}
const _REB_EVENTS_CACHE_KEY = '9mm_rebalance_events';
function _cacheRebalanceEvents(events) {
  try { localStorage.setItem(
    _REB_EVENTS_CACHE_KEY, JSON.stringify(events));
  } catch { /* */ } }
function _loadCachedRebalanceEvents() {
  try { const r = localStorage.getItem(_REB_EVENTS_CACHE_KEY);
    if (!r) return null; const p = JSON.parse(r);
    return Array.isArray(p) ? p : null; } catch { return null; } }
let _scanWasComplete = false, _unmanagedSyncing = false;
export function setUnmanagedSyncing(v) { _unmanagedSyncing = v; }
function _syncStatus(d) {
  if (wallet.address && posStore.count() === 0)
    return { complete: false, label: '' };
  const ps = d._positionScan;
  if (ps && ps.status === 'scanning') { const p = ps.progress;
    return { complete: false, label: p?.total > 0
      ? 'Syncing positions\u2026 ' + p.done + '/' + p.total
      : 'Syncing positions\u2026' }; }
  return { complete: true, label: 'Synced' }; }
function _updateSyncBadge(d) {
  const badge = g('syncBadge');
  if (!badge || _unmanagedSyncing) return;
  const { complete: c, label } = _syncStatus(d);
  badge.textContent = label || 'Syncing\u2026';
  badge.style.background = ''; badge.classList.toggle('done', c);
  const t = !c ? 'Wait until Syncing badge reads "Synced".' : '';
  ['manageToggleBtn', 'posBrowserBtn'].forEach(
    (id) => { const b = g(id);
      if (b) { b.disabled = !c; b.title = t; } });
  if (c && !_scanWasComplete && isViewingClosedPos())
    refetchClosedPosHistory();
  _scanWasComplete = c; }

const _REB_HELP = 'LP Ranger is currently submitting'
  + ' transactions to rebalance this LP Position.';
function _updateRebalanceButtons(d) {
  const on = !!d.rebalanceInProgress;
  const btn = g('manageToggleBtn'), rb = g('rebalanceWithRangeBtn');
  const h = g('rebalanceInProgressHelp');
  if (on) {
    if (btn) { btn.disabled = true; btn.title = _REB_HELP; }
    if (rb) { rb.disabled = true; rb.title = _REB_HELP; }
    if (h) { h.textContent = _REB_HELP; h.classList.remove('hidden'); }
  } else {
    if (btn && _scanWasComplete) { btn.disabled = false; btn.title = ''; }
    if (rb) { rb.disabled = false; rb.title = ''; }
    if (h) { h.textContent = ''; h.classList.add('hidden'); }
  } }
export function resetHistoryFlag() {
  _historyPopulated = false;
  try { localStorage.removeItem(
    _REB_EVENTS_CACHE_KEY); } catch { /* */ } }
export function resetPollingState() {
  _lastStatus = null; setPoolFirstDate(null); resetHistoryFlag();
  _lastRebalanceAt = null; _configSynced = false; _scanWasComplete = false;
  refreshCurDepositDisplay(0);
  const dd = g('lifetimeDepositDisplay'); if (dd) dd.textContent = '\u2014';
  const dl = g('initialDepositLabel'); if (dl) dl.textContent = 'Edit Initial Deposit'; }
function _syncActivePosition(d) {
  if (!d.activePosition) return;
  const active = posStore.getActive();
  if (!active || active.positionType !== 'nft') return;
  if (d.lastRebalanceAt && d.lastRebalanceAt !== _lastRebalanceAt) {
    _lastRebalanceAt = d.lastRebalanceAt;
    const evts = d.rebalanceEvents || [];
    const lastEv = evts.length ? evts[evts.length - 1] : null;
    if (lastEv) {
      const tx = lastEv.txHash
        ? ' ' + _fmtTxCopy(lastEv.txHash) : '';
      act(ACT_ICONS.gear, 'fee', 'Rebalance',
        'NFT #' + lastEv.oldTokenId +
          ' \u2192 #' + lastEv.newTokenId + tx);
    } }
  const ap = d.activePosition;
  if (ap.liquidity !== undefined)
    active.liquidity = String(ap.liquidity);
  if (ap.tickLower !== undefined) {
    active.tickLower = ap.tickLower;
    active.tickUpper = ap.tickUpper; } }
function _syncRebalanceCache(d) {
  const evts = d.rebalanceEvents;
  if (!evts || evts.length === 0) { const c = _loadCachedRebalanceEvents();
    if (c?.length > 0) d.rebalanceEvents = c;
  } else _cacheRebalanceEvents(evts); }
function _populateHistoryOnce(data) {
  if (_historyPopulated || !data.rebalanceEvents?.length) return;
  if (data.running && data.rebalanceScanComplete !== true) return;
  _historyPopulated = true;
  [...data.rebalanceEvents].sort((a, b) => a.timestamp - b.timestamp)
    .forEach((ev) => {
      const txPart = ev.txHash ? ' ' + _fmtTxCopy(ev.txHash) : '';
      act(ACT_ICONS.gear, 'fee', 'Rebalance',
        'NFT #' + ev.oldTokenId + ' \u2192 #' + ev.newTokenId + txPart,
        ev.dateStr ? new Date(ev.dateStr) : new Date(ev.timestamp * 1000));
    });
}
function updateDashboardFromStatus(data) {
  _lastStatus = data;
  if (data._managedPositions) {
    updateManagedPositions(
      data._managedPositions,
      data._allPositionStates);
    const active = posStore.getActive();
    if (active) updateManageBadge(
      data._managedPositions,
      active.tokenId,
      data.rebalanceInProgress,
    );
  }
  const _a = posStore.getActive();
  if (!_a || isPositionManaged(_a.tokenId))
    updateILDebugData(data, posStore);
  if (data.withinThreshold !== undefined)
    botConfig.withinThreshold = data.withinThreshold;
  botConfig.oorSince = data.oorSince || null;
  _updateBotStatus(data);
  _updateThrottleKpis(data);
  updateTriggerDisplay(data);
  const sw = data.walletAddress || data.wallet || '';
  if (sw && (!wallet.address ||
    wallet.address.toLowerCase() !== sw.toLowerCase())) return;
  _syncConfigFromServer(data); _syncRebalanceCache(data);
  _updateSyncBadge(data);
  _updateRebalanceButtons(data);
  if (!getPoolFirstDate() && data.poolFirstMintDate)
    setPoolFirstDate(data.poolFirstMintDate);
  updateHistorySyncLabels(data);
  _populateHistoryOnce(data); updateHistoryFromStatus(data);
  _updatePriceMarker(data); _updateLifetimeKpis(data);
  if (isViewingClosedPos()) return;
  const _act2 = posStore.getActive();
  if (_act2 && !isPositionManaged(_act2.tokenId)) return;
  _syncActivePosition(data); _updatePosStatus(data); _updateKpis(data);
  _updatePositionTicks(data); _updateComposition(data);
  checkHodlBaselineDialog(data); reapplyPrivacyBlur();
}
let _pollFailCount = 0;
function _onPollFail() {
  _pollFailCount++;
  if (_pollFailCount >= 3)
    _setStatusPill('status-pill danger', 'dot red', 'HALTED');
}
function _flattenV2Status(v2) {
  const global = v2.global || {}, positions = v2.positions || {};
  const active = posStore.getActive();
  const myKey = active ? compositeKey('pulsechain', global.walletAddress,
    active.contractAddress, active.tokenId) : null;
  let posData = myKey ? positions[myKey] : null;
  if (!posData && active?.token0 && active?.contractAddress &&
    global.walletAddress) {
    const pfx = 'pulsechain-' + global.walletAddress + '-' +
      active.contractAddress + '-';
    const mk = Object.keys(positions).find((k) => {
      if (!k.startsWith(pfx) || k === myKey) return false;
      const ap = positions[k]?.activePosition;
      return ap &&
        ap.token0?.toLowerCase() === active.token0.toLowerCase() &&
        ap.token1?.toLowerCase() === active.token1.toLowerCase() &&
        ap.fee === active.fee;
    });
    if (mk) {
      posData = positions[mk];
      const nid = mk.split('-').pop();
      if (nid !== active.tokenId) posStore.updateActiveTokenId(nid);
    }
  }
  const mp = global.managedPositions || [];
  const dc = global.poolDailyCounts || {};
  return { ...global, ...(posData || {}),
    _managedPositions: mp, _allPositionStates: positions,
    _poolDailyCounts: dc, _positionScan: global.positionScan || null };
}
async function _pollStatus() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) { _onPollFail(); return; }
    _pollFailCount = 0;
    updateDashboardFromStatus(_flattenV2Status(await res.json()));
  } catch (_) { _onPollFail(); }
}
/** Start polling /api/status at 3s intervals. */
export function startDataPolling() {
  if (_dataTimerId) return;
  _pollStatus();
  _dataTimerId = setInterval(_pollStatus, 3000);
}
export function stopDataPolling() {
  if (_dataTimerId) { clearInterval(_dataTimerId); _dataTimerId = null; }
}
