/**
 * @file dashboard-throttle.js
 * @description Trigger configuration, throttle state / UI, and the
 * Apply All function for the 9mm v3 Position Manager dashboard.
 *
 * Throttle state tracks daily rebalance counts and an optional
 * doubling-mode wait that activates when too many rebalances fire in
 * quick succession.  The UI badge, bar, and countdown are refreshed
 * every second by {@link updateThrottleUI}.
 *
 * Depends on: dashboard-helpers.js, dashboard-positions.js (posStore).
 */

import { g, act, fmtMs, fmtCountdown, nextMidnight, botConfig, savePositionRangeW } from './dashboard-helpers.js';
import { posStore } from './dashboard-positions.js';

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
  const newMin = parseInt(g('inMinInterval').value) || 10;
  throttle.minIntervalMs = newMin * 60 * 1000;
  throttle.dailyMax      = parseInt(g('inMaxReb').value) || 20;
  if (!throttle.doublingActive) throttle.currentWaitMs = throttle.minIntervalMs;
  g('dblWindowLabel').textContent = fmtMs(4 * throttle.minIntervalMs);
  updateThrottleUI();
}

/**
 * Render the throttle badge (OK / NEAR LIMIT / LIMIT HIT / DOUBLING).
 * @param {number} pct  Daily usage percentage.
 */
function _renderThrottleBadge(pct) {
  const badge = g('throttleBadge');
  if (throttle.dailyCount >= throttle.dailyMax) {
    badge.textContent = 'LIMIT HIT'; badge.className = 'warn-badge';
  } else if (throttle.doublingActive) {
    badge.textContent = 'DOUBLING \u00D7' + (throttle.doublingCount + 1); badge.className = 'dbl-badge';
  } else if (pct >= 80) {
    badge.textContent = 'NEAR LIMIT'; badge.className = 'warn-badge';
  } else {
    badge.textContent = 'OK'; badge.className = 'live-badge';
  }
}

/**
 * Render the range status banner based on price position and throttle state.
 * @param {{allowed:boolean, msUntilAllowed:number, reason:string}} can
 */
function _renderRangeBanner(can) {
  const banner = g('rangeBanner');
  if (!botConfig.price) { banner.style.display = 'none'; return; }
  banner.style.display = '';
  const inR    = botConfig.price >= botConfig.lower && botConfig.price <= botConfig.upper;
  if (!inR && !can.allowed) {
    const icon  = throttle.doublingActive ? '\u26A1' : '\u23F3';
    const cls   = throttle.doublingActive ? 'dbl' : 'wait';
    const label = throttle.doublingActive ? 'DOUBLING WAIT' : 'WAITING';
    banner.className = 'range-status-banner ' + cls;
    g('rangeIcon').textContent  = icon;
    g('rangeLabel').textContent = 'OUT OF RANGE \u2014 ' + label + ': ' + fmtCountdown(can.msUntilAllowed);
  } else if (!inR) {
    banner.className = 'range-status-banner out';
    g('rangeIcon').textContent  = '\u2717';
    g('rangeLabel').textContent = 'OUT OF RANGE \u2014 REBALANCE TRIGGERED';
  } else {
    banner.className = 'range-status-banner in';
    g('rangeIcon').textContent  = '\u2713';
    g('rangeLabel').textContent = 'PRICE IN RANGE \u2014 EARNING FEES';
  }
}

/** Refresh all throttle-related UI elements (badge, bar, countdown, banner). */
export function updateThrottleUI() {
  const can = canRebalance();
  const pct = Math.min(100, (throttle.dailyCount / throttle.dailyMax) * 100);
  const fill = g('throttleFill');
  fill.style.width      = pct + '%';
  fill.style.background = pct < 60 ? 'var(--accent3)' : pct < 90 ? 'var(--warn)' : 'var(--danger)';
  g('throttleLeft').textContent  = throttle.dailyCount + ' today';
  g('throttleRight').textContent = 'limit: ' + throttle.dailyMax;

  _renderThrottleBadge(pct);

  // Doubling panel
  const panel = g('dblPanel');
  if (throttle.doublingActive) {
    panel.className = 'dbl-panel';
    g('dblCurrentWait').textContent = fmtMs(throttle.currentWaitMs);
    g('dblCount').textContent       = throttle.doublingCount;
  } else {
    panel.className = 'dbl-panel hidden';
  }

  // Rebalance Interval KPI
  const msLeft = can.msUntilAllowed;
  const minIntervalEl = g('inMinInterval');
  const minIntervalMin = minIntervalEl ? parseInt(minIntervalEl.value, 10) || 10 : 10;
  if (can.allowed) {
    g('kpiCountdown').textContent = minIntervalMin + ' min';
    g('kpiCountdown').className   = 'kpi-value neu';
    g('kpiCDSub').textContent     = 'Only triggered when out-of-range';
  } else {
    g('kpiCountdown').textContent = fmtCountdown(msLeft);
    g('kpiCountdown').className   = 'kpi-value ' + (throttle.doublingActive ? 'dbl' : 'wrn');
    g('kpiCDSub').textContent     = can.reason === 'daily_limit'
      ? 'daily limit reached'
      : throttle.doublingActive ? 'volatility doubling' : 'waiting \u2014 ' + fmtCountdown(msLeft) + ' left';
  }

  _renderRangeBanner(can);

  // Doubling countdown
  if (throttle.doublingActive && !can.allowed) {
    g('dblCountdown').textContent      = fmtCountdown(msLeft);
    g('dblCountdown').className        = 'countdown';
    g('dblCountdownLabel').textContent = 'time until next rebalance allowed';
  } else if (throttle.doublingActive) {
    g('dblCountdown').textContent = 'READY';
    g('dblCountdown').className   = 'countdown ok';
  }
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
  g('wsToken').textContent = g('inNFT')?.value || '\u2014';
}

/** Save just the range width, update the preview, and persist to backend. */
export function saveRangeWidth() {
  botConfig.rangeW = Math.min(100, Math.max(1, parseFloat(g('inRangeW').value) || 20));
  g('inRangeW').value = botConfig.rangeW;
  g('activeRangeW').textContent = botConfig.rangeW;
  const activePos = posStore.getActive();
  if (activePos) savePositionRangeW(activePos, botConfig.rangeW);
  if (_positionRangeVisual) _positionRangeVisual();
  fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rangeWidthPct: botConfig.rangeW }),
  }).catch(function () { /* dashboard-only mode */ });
}

/** Save range width and immediately trigger a rebalance into the new range. */
export function saveAndRebalance() {
  saveRangeWidth();
  fetch('/api/rebalance', { method: 'POST' })
    .catch(function () { /* dashboard-only mode */ });
}

/** Read all settings from the UI and apply them, persisting to the backend. */
export function applyAll() {
  onParamChange();
  botConfig.rangeW = parseFloat(g('inRangeW').value) || 20;
  g('activeRangeW').textContent = botConfig.rangeW;

  // Persist range width for the active position in localStorage
  const activePos = posStore.getActive();
  if (activePos) savePositionRangeW(activePos, botConfig.rangeW);

  const tLbl = _triggerLabel();
  g('activeTriggerDisplay').textContent = tLbl;
  _updatePosTokenLabel();
  g('dblWindowLabel').textContent = fmtMs(4 * throttle.minIntervalMs);

  if (_positionRangeVisual) _positionRangeVisual();

  // Persist settings to the backend bot process
  const patch = {
    rangeWidthPct:           botConfig.rangeW,
    slippagePct:             parseFloat(g('inSlip').value) || 0.5,
    checkIntervalSec:        parseInt(g('inInterval').value, 10) || 60,
    minRebalanceIntervalMin: parseInt(g('inMinInterval').value, 10) || 10,
    maxRebalancesPerDay:     parseInt(g('inMaxReb').value, 10) || 20,
    gasStrategy:             g('inGas').value || 'auto',
    triggerType:             trigger.type,
  };
  fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }).catch(function () { /* dashboard-only mode — no backend running */ });

  const btn = g('applyAllBtn');
  btn.textContent = '\u2713 Applied';
  btn.className   = 'apply-btn saved';
  setTimeout(function () { btn.textContent = 'Apply All Settings'; btn.className = 'apply-btn'; }, 2000);
  act('\u2699', 'start', 'Settings applied',
    `Trigger: ${tLbl} \u00B7 \u00B1${botConfig.rangeW}% \u00B7 Min interval: ${g('inMinInterval').value}m \u00B7 Max ${g('inMaxReb').value}/day`);
}
