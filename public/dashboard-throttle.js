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
 * Depends on: dashboard-helpers.js (g, act, fmtMs, fmtCountdown, nextMidnight, botConfig).
 *
 * NOTE: References to optSyncParamsFromUI and optState are resolved at call
 * time (not parse time), so dashboard-optimizer.js can load after this file.
 */

/* global g, act, fmtMs, fmtCountdown, nextMidnight, botConfig, posStore,
          optSyncParamsFromUI, optState, savePositionRangeW,
          _9mmPositionMgr */
'use strict';

// ── Namespace & trigger type constants ──────────────────────────────────────

/**
 * Namespaced constants for the 9mm Position Manager.
 * Frozen to prevent accidental mutation (acts as final/enum).
 */
const _9mmPosMgr = Object.freeze({
  TRIGGER_OOR:  'oor',
  TRIGGER_EDGE: 'edge',
  TRIGGER_TIME: 'time',
  TRIGGER_TYPES: Object.freeze(['oor', 'edge', 'time']),
});

// ── Trigger config ──────────────────────────────────────────────────────────

/** Active trigger configuration. */
const trigger = { type: _9mmPosMgr.TRIGGER_OOR, edgePct: 5, schedHours: 24 };

/**
 * Switch the active trigger type and update button styling.
 * @param {string} t  Trigger key: 'oor' | 'edge' | 'time'
 */
function setTType(t) {
  trigger.type = t;
  botConfig.triggerType = t;
  _9mmPosMgr.TRIGGER_TYPES.forEach(k => {
    g('tb-' + k).className = 'ttype-btn' + (k === t ? ' active' : '');
  });
  renderTParams();

  // Show/hide range boundary lines based on trigger mode
  const hide = t === _9mmPosMgr.TRIGGER_TIME;
  const lnL = g('rangeLnL');
  const lnR = g('rangeLnR');
  if (lnL) lnL.style.display = hide ? 'none' : '';
  if (lnR) lnR.style.display = hide ? 'none' : '';
}

/** Render the trigger-specific parameter inputs. */
function renderTParams() {
  const p = g('tparams');
  if (trigger.type === _9mmPosMgr.TRIGGER_OOR) {
    p.innerHTML =
      '<div class="9mm-pos-mgr-info-box">' +
      'Fires the moment tick exits [tickLower, tickUpper].</div>';
  } else if (trigger.type === _9mmPosMgr.TRIGGER_EDGE) {
    p.innerHTML =
      '<div class="prow 9mm-pos-mgr-mt-md"><span class="plbl">Fire when price within X% of edge</span>' +
      '<div class="9mm-pos-mgr-input-row">' +
      `<input type="number" class="pinput w55" id="inEdge" value="${trigger.edgePct}" min="1" max="49" step="0.5">` +
      '<span class="punit">%</span></div></div>';
  } else {
    p.innerHTML =
      '<div class="prow 9mm-pos-mgr-mt-md"><span class="plbl">Rebalance every N hours</span>' +
      '<div class="9mm-pos-mgr-input-row">' +
      `<input type="number" class="pinput w55" id="inSched" value="${trigger.schedHours}" min="1" max="168" step="1">` +
      '<span class="punit">hrs</span></div></div>';
  }
}

// ── Throttle state ──────────────────────────────────────────────────────────

/** Mutable throttle state. */
const throttle = {
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
function canRebalance() {
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
function onParamChange() {
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
function updateThrottleUI() {
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
    g('kpiCDSub').textContent     = trigger.type === _9mmPosMgr.TRIGGER_EDGE
      ? 'Triggered within ' + trigger.edgePct + '% of range edge'
      : trigger.type === _9mmPosMgr.TRIGGER_TIME
        ? 'Scheduled every ' + trigger.schedHours + ' hour' + (trigger.schedHours !== 1 ? 's' : '')
        : 'Only triggered when out-of-range';
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
  if (trigger.type === _9mmPosMgr.TRIGGER_EDGE) return `WITHIN ${trigger.edgePct}% OF EDGE`;
  if (trigger.type === _9mmPosMgr.TRIGGER_TIME) return `EVERY ${trigger.schedHours}H`;
  return 'OUT OF RANGE';
}

/** Read trigger-specific parameters from the UI inputs. */
function _readTriggerParams() {
  if (trigger.type === _9mmPosMgr.TRIGGER_EDGE) trigger.edgePct   = parseFloat(g('inEdge')?.value || 5);
  if (trigger.type === _9mmPosMgr.TRIGGER_TIME) trigger.schedHours = parseFloat(g('inSched')?.value || 24);
}

/** Update the position token label from the active position. */
function _updatePosTokenLabel() {
  const posType = posStore.getActive()?.positionType || 'nft';
  g('wsToken').textContent = posType === 'nft'
    ? (g('inNFT')?.value || '\u2014')
    : (g('inERC20Addr')?.value || '\u2014');
}

/** Sync optimizer URL and API key from UI inputs. */
function _syncOptimizerFromUI() {
  optSyncParamsFromUI();
  optState.url    = (g('optUrl')?.value || '').trim();
  optState.apiKey = (g('optApiKey')?.value || '').trim();
}

/** Save just the range width, update the preview, and persist to backend. */
function saveRangeWidth() {
  botConfig.rangeW = Math.min(100, Math.max(1, parseFloat(g('inRangeW').value) || 20));
  g('inRangeW').value = botConfig.rangeW;
  g('activeRangeW').textContent = botConfig.rangeW;
  const activePos = posStore.getActive();
  if (activePos) savePositionRangeW(activePos, botConfig.rangeW);
  if (_9mmPositionMgr.positionRangeVisual) _9mmPositionMgr.positionRangeVisual();
  fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rangeWidthPct: botConfig.rangeW }),
  }).catch(function () { /* dashboard-only mode */ });
}

/** Read all settings from the UI and apply them, persisting to the backend. */
function applyAll() {
  _readTriggerParams();
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

  _syncOptimizerFromUI();
  if (_9mmPositionMgr.positionRangeVisual) _9mmPositionMgr.positionRangeVisual();

  // Persist settings to the backend bot process
  const patch = {
    rangeWidthPct:           botConfig.rangeW,
    slippagePct:             parseFloat(g('inSlip').value) || 0.5,
    checkIntervalSec:        parseInt(g('inInterval').value, 10) || 60,
    minRebalanceIntervalMin: parseInt(g('inMinInterval').value, 10) || 10,
    maxRebalancesPerDay:     parseInt(g('inMaxReb').value, 10) || 20,
    gasStrategy:             g('inGas').value || 'auto',
    triggerType:             trigger.type,
    triggerEdgePct:          trigger.edgePct,
    triggerSchedHours:       trigger.schedHours,
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
