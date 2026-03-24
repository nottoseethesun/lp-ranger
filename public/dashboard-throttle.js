/**
 * @file dashboard-throttle.js
 * @description Trigger configuration, throttle state / UI, and the
 * Apply All function for the 9mm v3 Position Manager dashboard.
 *
 * Throttle state tracks daily rebalance counts and an optional
 * doubling-mode wait that activates when too many rebalances fire in
 * quick succession.  The UI badge and countdown are refreshed
 * every second by {@link updateThrottleUI}.
 *
 * Depends on: dashboard-helpers.js, dashboard-positions.js (posStore).
 */

import { g, act, ACT_ICONS, fmtCountdown, nextMidnight, botConfig, savePositionOorThreshold } from './dashboard-helpers.js';
import { posStore, isPositionManaged } from './dashboard-positions.js';
import { _createModal } from './dashboard-data.js';
import { isViewingClosedPos } from './dashboard-closed-pos.js';

// Late-bound import to avoid circular dep issues at evaluation time.
// Populated by dashboard-init.js after all modules load.
let _positionRangeVisual = null;

/**
 * Inject data references after all modules are loaded.
 * Called once from dashboard-init.js.
 * @param {object} deps  { positionRangeVisual }
 */
export function injectThrottleDeps(deps) {
  _positionRangeVisual = deps.positionRangeVisual;
}

// ── Trigger type ────────────────────────────────────────────────────────────

/** Trigger type: out of range (only supported type). */
export const TRIGGER_OOR  = 'oor';

/** Active trigger configuration. */
export const trigger = { type: TRIGGER_OOR };

// ── Throttle state ──────────────────────────────────────────────────────────

/** Mutable throttle state. */
export const throttle = {
  minIntervalMs:  10 * 60 * 1000,
  rebTimestamps:  [],
  doublingActive: false,
  doublingCount:  0,
  currentWaitMs:  10 * 60 * 1000,
  lastRebTime:    0,
  dailyCount:     0,
  dailyMax:       20,
  dailyResetAt:   nextMidnight(),
};

/**
 * Check whether a rebalance is currently allowed.
 * @returns {{allowed:boolean, msUntilAllowed:number, reason:string}}
 */
export function canRebalance() {
  const now = Date.now();
  if (throttle.dailyCount >= throttle.dailyMax) {
    return { allowed: false, msUntilAllowed: throttle.dailyResetAt - now, reason: 'daily_limit' };
  }
  const wait  = throttle.doublingActive ? throttle.currentWaitMs : throttle.minIntervalMs;
  const since = now - throttle.lastRebTime;
  if (throttle.lastRebTime > 0 && since < wait) {
    return { allowed: false, msUntilAllowed: wait - since,
      reason: throttle.doublingActive ? 'doubling' : 'min_interval' };
  }
  return { allowed: true, msUntilAllowed: 0, reason: 'ok' };
}

/** Re-read UI inputs and update throttle parameters. */
export function onParamChange() {
  const minEl = g('inMinInterval'), maxEl = g('inMaxReb');
  throttle.minIntervalMs = (parseInt(minEl?.value) || 10) * 60 * 1000;
  throttle.dailyMax      = parseInt(maxEl?.value) || 20;
  if (!throttle.doublingActive) throttle.currentWaitMs = throttle.minIntervalMs;
  updateThrottleUI();
}

/**
 * Render the throttle badge (OK / NEAR LIMIT / LIMIT HIT / DOUBLING).
 * @param {number} pct  Daily usage percentage.
 */
function _renderThrottleBadge(pct) {
  const badge = g('throttleBadge');
  if (!badge) return;
  const check = canRebalance();
  if (throttle.dailyCount >= throttle.dailyMax) {
    badge.textContent = 'CAPPED'; badge.className = 'warn-badge';
  } else if (throttle.doublingActive) {
    badge.textContent = 'DOUBLING \u00D7' + (throttle.doublingCount + 1); badge.className = 'dbl-badge';
  } else if (!check.allowed && check.reason === 'min_interval') {
    badge.textContent = 'THROTTLED'; badge.className = 'warn-badge';
  } else if (pct >= 80) {
    badge.textContent = 'NEAR LIMIT'; badge.className = 'warn-badge';
  } else {
    badge.textContent = 'OK'; badge.className = 'live-badge';
  }
}

/**
 * Check banner visibility and handle closed-position display.
 * @param {HTMLElement} banner  The range banner element.
 * @returns {boolean}  true if the caller should continue rendering OOR state.
 */
function _checkBannerVisibility(banner) {
  if (isViewingClosedPos()) {
    if (!botConfig.price || !botConfig.lower || !botConfig.upper) { banner.style.display = 'none'; return false; }
    banner.style.display = '';
    return true;
  }
  const active = posStore.getActive();
  const liq = active ? active.liquidity : undefined;
  if (!botConfig.price || !botConfig.lower || !botConfig.upper || liq === undefined || liq === null) { banner.style.display = 'none'; return false; }
  banner.style.display = '';
  if (String(liq) === '0') {
    banner.className = 'range-status-banner wait';
    g('rangeIcon').textContent  = '\u2014';
    g('rangeLabel').textContent = 'POSITION CLOSED';
    return false;
  }
  return true;
}

/** Render OOR sub-state for a managed position (threshold, doubling, triggered). */
function _renderManagedOor(banner, can) {
  if (botConfig.withinThreshold) {
    banner.className = 'range-status-banner wait';
    g('rangeIcon').textContent  = '\u26A0';
    let threshLabel = 'OUT OF RANGE \u2014 WITHIN THRESHOLD';
    const timeoutMin = parseInt(g('inOorTimeout')?.value, 10) || 0;
    if (timeoutMin > 0 && botConfig.oorSince) {
      const remaining = (botConfig.oorSince + timeoutMin * 60000) - Date.now();
      threshLabel += ' \u00B7 Timeout: ' + fmtCountdown(remaining);
    }
    g('rangeLabel').textContent = threshLabel;
  } else if (!can.allowed) {
    const icon  = throttle.doublingActive ? '\u26A1' : '\u23F3';
    const cls   = throttle.doublingActive ? 'dbl' : 'wait';
    const label = throttle.doublingActive ? 'DOUBLING WAIT' : 'WAITING';
    banner.className = 'range-status-banner ' + cls;
    g('rangeIcon').textContent  = icon;
    g('rangeLabel').textContent = 'OUT OF RANGE \u2014 ' + label + ': ' + fmtCountdown(can.msUntilAllowed);
  } else {
    banner.className = 'range-status-banner out';
    g('rangeIcon').textContent  = '\u2717';
    g('rangeLabel').textContent = 'OUT OF RANGE \u2014 REBALANCE TRIGGERED';
  }
}

/**
 * Render the range status banner based on price position and throttle state.
 * @param {{allowed:boolean, msUntilAllowed:number, reason:string}} can
 */
function _renderRangeBanner(can) {
  const banner = g('rangeBanner');
  if (!banner || !_checkBannerVisibility(banner)) return;
  const inR = botConfig.price >= botConfig.lower && botConfig.price <= botConfig.upper;
  if (inR) {
    banner.className = 'range-status-banner in';
    g('rangeIcon').textContent  = '\u2713';
    g('rangeLabel').textContent = 'PRICE IN RANGE \u2014 EARNING FEES';
    return;
  }
  const active = posStore.getActive();
  if (active && isPositionManaged(active.tokenId)) { _renderManagedOor(banner, can); return; }
  banner.className = 'range-status-banner out';
  g('rangeIcon').textContent  = '\u2717';
  g('rangeLabel').textContent = 'OUT OF RANGE';
}

/** Update the rebalance interval KPI. */
function _renderCountdownKpi(can) {
  const minIntervalEl = g('inMinInterval');
  const minIntervalMin = minIntervalEl ? parseInt(minIntervalEl.value, 10) || 10 : 10;
  const cd = g('kpiCountdown'), cds = g('kpiCDSub');
  if (can.allowed) {
    if (cd) { cd.textContent = minIntervalMin + ' min'; cd.className = 'kpi-value neu'; }
    if (cds) cds.textContent = 'Rebalance is only triggered when the position is out-of-range by the % set below.';
  } else {
    if (cd) { cd.textContent = fmtCountdown(can.msUntilAllowed); cd.className = 'kpi-value ' + (throttle.doublingActive ? 'dbl' : 'wrn'); }
    if (cds) cds.textContent = can.reason === 'daily_limit'
      ? 'Daily Limit Reached'
      : throttle.doublingActive ? 'Volatility Doubling' : 'Waiting \u2014 ' + fmtCountdown(can.msUntilAllowed) + ' Left';
  }
}

/** Refresh all throttle-related UI elements (badge, countdown, banner). */
export function updateThrottleUI() {
  const can = canRebalance();
  const pct = Math.min(100, (throttle.dailyCount / throttle.dailyMax) * 100);
  _renderThrottleBadge(pct);
  _renderCountdownKpi(can);
  _renderRangeBanner(can);
}

// ── Apply All ───────────────────────────────────────────────────────────────

/**
 * Build a human-readable label for the active trigger type.
 * @returns {string}
 */
function _triggerLabel() {
  return 'OUT OF RANGE';
}

/** Update the position token label from the active position. */
function _updatePosTokenLabel() {
  const ws = g('wsToken'); if (ws) ws.textContent = g('inNFT')?.value || '\u2014';
}

/** Save the OOR timeout setting and persist to backend. */
export function saveOorTimeout() {
  const el = g('inOorTimeout');
  const val = parseInt(el?.value, 10);
  const timeoutMin = Number.isFinite(val) && val >= 0 ? val : 180;
  if (el) el.value = timeoutMin;
  fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rebalanceTimeoutMin: timeoutMin }),
  }).catch(function () { /* dashboard-only mode */ });
}

/** Save just the OOR threshold, update the preview, and persist to backend. */
export function saveOorThreshold() {
  botConfig.oorThreshold = Math.min(100, Math.max(1, parseFloat(g('inOorThreshold')?.value) || 5));
  const inp = g('inOorThreshold'); if (inp) inp.value = botConfig.oorThreshold;
  const disp = g('activeOorThreshold'); if (disp) disp.textContent = botConfig.oorThreshold;
  const activePos = posStore.getActive();
  if (activePos) savePositionOorThreshold(activePos, botConfig.oorThreshold);
  if (_positionRangeVisual) _positionRangeVisual();
  fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rebalanceOutOfRangeThresholdPercent: botConfig.oorThreshold }),
  }).catch(function () { /* dashboard-only mode */ });
}


/** Save a single config key from an input element. */
function _saveSingleConfig(inputId, key, parse) {
  const val = parse(g(inputId)?.value);
  fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [key]: val }) }).catch(() => {});
  act(ACT_ICONS.gear, 'start', 'Setting Saved', key + ' = ' + val);
}

/** Save min rebalance interval. */
export function saveMinInterval() { _saveSingleConfig('inMinInterval', 'minRebalanceIntervalMin', v => parseInt(v, 10) || 10); }
/** Save max rebalances per day. */
export function saveMaxReb() {
  const val = parseInt(g('inMaxReb')?.value, 10) || 20;
  _saveSingleConfig('inMaxReb', 'maxRebalancesPerDay', () => val);
  const el = g('kpiToday'); if (el) el.textContent = el.textContent.replace(/\/\s*\d+/, '/ ' + val);
}
/** Save slippage tolerance. */
export function saveSlippage() { _saveSingleConfig('inSlip', 'slippagePct', v => parseFloat(v) || 0.5); }
/** Save check interval. */
export function saveCheckInterval() { _saveSingleConfig('inInterval', 'checkIntervalSec', v => parseInt(v, 10) || 60); }

// ── Apply All dirty tracking ─────────────────────────────────────────────────

/** IDs of all config inputs in the Bot Configuration panel. */
const _CONFIG_IDS = ['inMinInterval', 'inMaxReb', 'inOorThreshold', 'inOorTimeout', 'inSlip', 'inInterval', 'inGas', 'inRpc', 'inPM', 'inFactory'];

/** Snapshot of last-applied values. */
let _appliedSnapshot = {};

/** Take a snapshot of current config input values. */
function _snapshot() {
  const snap = {};
  for (const id of _CONFIG_IDS) { const el = g(id); if (el) snap[id] = el.value; }
  return snap;
}

/** Check whether any config input differs from the last-applied snapshot. */
function _isDirty() {
  for (const id of _CONFIG_IDS) {
    const el = g(id);
    if (el && el.value !== _appliedSnapshot[id]) return true;
  }
  return false;
}

/**
 * Update the Apply All button disabled state based on whether inputs changed.
 * Called on every config input event.
 */
export function checkApplyDirty() {
  const btn = g('applyAllBtn');
  if (btn) btn.disabled = !_isDirty();
}

/** Capture the current config values as the "applied" baseline. */
export function snapshotApplied() {
  _appliedSnapshot = _snapshot();
  checkApplyDirty();
}

/** Build the config patch from current UI input values. */
function _buildConfigPatch() {
  return {
    rebalanceOutOfRangeThresholdPercent: botConfig.oorThreshold,
    slippagePct:             parseFloat(g('inSlip')?.value) || 0.5,
    checkIntervalSec:        parseInt(g('inInterval')?.value, 10) || 60,
    minRebalanceIntervalMin: parseInt(g('inMinInterval')?.value, 10) || 10,
    maxRebalancesPerDay:     parseInt(g('inMaxReb')?.value, 10) || 20,
    gasStrategy:             g('inGas')?.value || 'auto',
    triggerType:             trigger.type,
    rebalanceTimeoutMin:     parseInt(g('inOorTimeout')?.value, 10) || 0,
  };
}

/** Read all settings from the UI and apply them, persisting to the backend. */
export function applyAll() {
  onParamChange();
  botConfig.oorThreshold = parseFloat(g('inOorThreshold')?.value) || 5;
  const aot = g('activeOorThreshold'); if (aot) aot.textContent = botConfig.oorThreshold;
  const activePos = posStore.getActive();
  if (activePos) savePositionOorThreshold(activePos, botConfig.oorThreshold);
  const atd = g('activeTriggerDisplay'); if (atd) atd.textContent = _triggerLabel();
  _updatePosTokenLabel();
  if (_positionRangeVisual) _positionRangeVisual();

  fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(_buildConfigPatch()),
  }).catch(function () { /* dashboard-only mode */ });

  snapshotApplied();
  const btn = g('applyAllBtn');
  if (btn) {
    btn.textContent = '\u2713 Applied'; btn.className = 'apply-btn saved'; btn.disabled = true;
    setTimeout(function () { btn.textContent = 'Apply All Settings'; btn.className = 'apply-btn'; }, 2000);
  }
  act(ACT_ICONS.gear, 'start', 'Settings Applied', 'OOR threshold: ' + botConfig.oorThreshold + '%');
}

// ── Rebalance with Updated Range ─────────────────────────────────────────────

/** Open the Rebalance with Updated Range modal. */
export function openRebalanceRangeModal() {
  const modal = g('rebalanceRangeModal');
  if (modal) modal.classList.remove('hidden');
  _updateRangeHint();
}

/** Close the Rebalance with Updated Range modal. */
export function closeRebalanceRangeModal() {
  const modal = g('rebalanceRangeModal');
  if (modal) modal.classList.add('hidden');
}

/** Update the hint text showing per-side percentage. */
export function updateRebalanceRangeHint() { _updateRangeHint(); }

/** @private */
function _updateRangeHint() {
  const input = g('rebalanceRangeInput');
  const hint = g('rebalanceRangeHint');
  if (!input || !hint) return;
  const total = parseFloat(input.value) || 10;
  const half = (total / 2).toFixed(3).replace(/\.?0+$/, '');
  hint.textContent = `${half}% on either side of the current price`;
}

/** Confirm and trigger a rebalance with the custom range width. */
export async function confirmRebalanceRange() {
  const input = g('rebalanceRangeInput');
  const total = parseFloat(input?.value) || 10;
  closeRebalanceRangeModal();
  try {
    const res = await fetch('/api/rebalance', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customRangeWidthPct: total }),
    });
    const data = await res.json();
    if (!data.ok) { _createModal(null, '9mm-pos-mgr-modal-caution', 'Rebalance Blocked', '<p>' + (data.error || 'Unknown error') + '</p>'); act(ACT_ICONS.warn, 'alert', 'Rebalance Blocked', data.error); return; }
  } catch { _createModal(null, '9mm-pos-mgr-modal-caution', 'Rebalance Failed', '<p>Server unreachable</p>'); act(ACT_ICONS.warn, 'alert', 'Rebalance Failed', 'Server unreachable'); return; }
  act(ACT_ICONS.swap, 'start', 'Rebalance with Custom Range',
    `Total width: ${total}% (${(total / 2).toFixed(3).replace(/\.?0+$/, '')}% per side)`);
}
