/**
 * @file dashboard-optimizer.js
 * @description LP Optimization Engine interface for the 9mm v3 Position
 * Manager dashboard.  Handles health probing, auto-poll toggle, fetch cycles,
 * recommendation rendering, parameter application, and history tracking.
 *
 * Depends on: dashboard-helpers.js  (g, act, fmtMs, botConfig),
 *             dashboard-throttle.js (trigger, throttle, setTType).
 */

/* global g, act, fmtMs, fmtDateTime, botConfig, trigger, throttle, setTType */
'use strict';

// ── Constants ───────────────────────────────────────────────────────────────

/** Default optimizer port (mirrors src/config.js OPTIMIZER_PORT default). */
const OPT_DEFAULT_PORT = 3693;

/** Default optimizer base URL. */
const OPT_DEFAULT_URL  = `http://localhost:${OPT_DEFAULT_PORT}`;

/** How often the dashboard probes the engine's /health endpoint (ms). */
const OPT_PROBE_INTERVAL_MS = 15_000;

// ── Bot parameters ──────────────────────────────────────────────────────────

/**
 * The full set of parameters the optimizer can read/write.
 * Mirrors src/optimizer-applicator.js MANAGED_KEYS.
 */
const botParams = {
  rangeWidthPct:           20,
  triggerType:             'oor',
  edgePct:                 5,
  schedHours:              24,
  minRebalanceIntervalMin: 10,
  maxRebalancesPerDay:     20,
  slippagePct:             0.5,
  checkIntervalSec:        60,
};

/** In-memory optimizer state. */
const optState = {
  connected:      false,
  enabled:        false,
  autoApply:      false,
  url:            OPT_DEFAULT_URL,
  apiKey:         '',
  intervalMs:     10 * 60 * 1000,
  lastRec:        null,
  totalFetches:   0,
  successFetches: 0,
  lastError:      null,
  lastFetchAt:    null,
  nextFetchAt:    null,
  history:        [],
  timer:          null,
  probeTimer:     null,
};

// ── Control enable / disable ────────────────────────────────────────────────

/**
 * Enable or disable the interactive optimizer controls.
 * @param {boolean} enabled
 */
function _optSetControlsEnabled(enabled) {
  const DIMMED = 'opacity:0.38;pointer-events:none;';
  const tw = g('optToggleWrap');
  if (tw) tw.setAttribute('style', enabled ? '' : DIMMED);
  const qb = g('optQueryBtn');
  if (qb) qb.disabled = !enabled;
  const at = g('optAutoApplyToggle');
  if (at) at.setAttribute('style', enabled ? '' : DIMMED);
  const notice = g('optDisabledNotice');
  if (notice) notice.style.display = enabled ? 'none' : '';

  if (!enabled && optState.enabled) {
    optState.enabled = false;
    clearTimeout(optState.timer);
    optState.timer      = null;
    optState.nextFetchAt = null;
    const tog = g('optToggle');
    if (tog) tog.className = 'toggle';
    const lbl = g('optToggleLabel');
    if (lbl) lbl.textContent = 'OFF';
    g('optNextLabel').textContent = '';
    act('\u23F8', 'alert', 'Optimizer auto-poll stopped', 'Engine went offline');
  }
}

// ── Connection state ────────────────────────────────────────────────────────

/**
 * Update the connection state indicator and enable/disable controls.
 * @param {'ok'|'err'|'unknown'} state
 * @param {number} [latencyMs]
 */
function optSetConnState(state, latencyMs) {
  const dot   = g('optConnDot');
  const label = g('optConnLabel');
  if (!dot || !label) return;

  const wasConnected = optState.connected;
  optState.connected = (state === 'ok');

  dot.className    = 'opt-conn-dot ' + (state === 'ok' ? 'ok' : state === 'err' ? 'err' : 'unknown');
  label.textContent =
    state === 'ok'  ? `Connected${latencyMs !== undefined ? ` (${latencyMs}ms)` : ''}`
      : state === 'err' ? 'Unreachable' : 'Probing\u2026';

  const probeEl = g('optProbeUrl');
  if (probeEl) probeEl.textContent = optState.url || OPT_DEFAULT_URL;

  _optSetControlsEnabled(optState.connected);

  if (!wasConnected && optState.connected) {
    act('\u{1F7E2}', 'fee', 'Optimizer engine connected', optState.url);
  } else if (wasConnected && !optState.connected) {
    act('\u{1F534}', 'alert', 'Optimizer engine disconnected', optState.url);
  }
}

/** Handle URL input changes: reset connection and restart probing. */
function optUrlChanged() {
  optState.url = (g('optUrl').value || '').trim() || OPT_DEFAULT_URL;
  optSetConnState('unknown');
  _optSetControlsEnabled(false);
  _optRestartProbe();
}

// ── Health-probe loop ───────────────────────────────────────────────────────

/** Probe the engine's /health endpoint once. */
async function _optProbeOnce() {
  const url = (optState.url || OPT_DEFAULT_URL).replace(/\/$/, '') + '/health';
  const t0  = Date.now();
  try {
    const headers = {};
    if (optState.apiKey) headers['Authorization'] = 'Bearer ' + optState.apiKey;
    const resp = await fetch(url, {
      method: 'GET', headers,
      signal: AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined,
    });
    optSetConnState(resp.ok ? 'ok' : 'err', Date.now() - t0);
  } catch (_) {
    optSetConnState('err');
  }
}

/** Stop and restart the health-probe loop. */
function _optRestartProbe() {
  clearTimeout(optState.probeTimer);
  _optProbeOnce().then(() => {
    optState.probeTimer = setInterval(_optProbeOnce, OPT_PROBE_INTERVAL_MS);
  });
}

// ── Manual ping ─────────────────────────────────────────────────────────────

/** Ping the optimizer engine and log the result. */
async function optPing() {
  optState.url = (g('optUrl').value || '').trim() || OPT_DEFAULT_URL;
  const btn = g('optPingBtn');
  if (btn) { btn.disabled = true; btn.textContent = '\u23F1 \u2026'; }
  const t0 = Date.now();
  await _optProbeOnce();
  const latency = Date.now() - t0;
  if (btn) { btn.disabled = false; btn.textContent = '\u23F1 Ping'; }
  act('\u{1F50C}', optState.connected ? 'fee' : 'alert', 'Optimizer ping',
    optState.connected
      ? `${optState.url} reachable (${latency}ms)`
      : `${optState.url} unreachable`);
}

// ── Toggle auto-poll ────────────────────────────────────────────────────────

/** Toggle the optimizer auto-poll on/off. */
function optTogglePolling() {
  if (!optState.connected) return;
  optState.enabled = !optState.enabled;
  const tog   = g('optToggle');
  const label = g('optToggleLabel');
  if (tog)   tog.className     = 'toggle ' + (optState.enabled ? 'on' : '');
  if (label) label.textContent = optState.enabled ? 'ON' : 'OFF';
  if (optState.enabled) {
    _optScheduleNext();
    act('\u26A1', 'fee', 'Optimizer enabled',
      `Auto-polling every ${Math.round(optState.intervalMs / 60000)} min`);
  } else {
    clearTimeout(optState.timer);
    optState.timer      = null;
    optState.nextFetchAt = null;
    const nl = g('optNextLabel');
    if (nl) nl.textContent = '';
    act('\u23F8', 'alert', 'Optimizer disabled', 'Auto-polling stopped');
  }
  _optRenderStatus();
}

/** Toggle the auto-apply setting on/off. */
function optToggleAutoApply() {
  if (!optState.connected) return;
  optState.autoApply = !optState.autoApply;
  const tog   = g('optAutoApplyToggle');
  const label = g('optAutoApplyLabel');
  if (tog)   tog.className     = 'toggle ' + (optState.autoApply ? 'on' : '');
  if (label) label.textContent = optState.autoApply ? 'ON' : 'OFF';
  const applyBtn = g('optApplyBtn');
  if (applyBtn) applyBtn.style.display = optState.autoApply ? 'none' : '';
}

// ── Sync helpers ────────────────────────────────────────────────────────────

/** Read current UI values into botParams. */
function optSyncParamsFromUI() {
  botParams.rangeWidthPct           = parseFloat(g('inRangeW')?.value) || 20;
  botParams.triggerType             = trigger.type;
  botParams.edgePct                 = trigger.edgePct || 5;
  botParams.schedHours              = trigger.schedHours || 24;
  botParams.minRebalanceIntervalMin = parseInt(g('inMinInterval')?.value) || 10;
  botParams.maxRebalancesPerDay     = parseInt(g('inMaxReb')?.value) || 20;
  botParams.slippagePct             = parseFloat(g('inSlip')?.value) || 0.5;
  botParams.checkIntervalSec        = parseInt(g('inInterval')?.value) || 60;
}

/**
 * Apply parameter values to the UI inputs and bot configuration.
 * @param {object} params  Key-value pairs to apply.
 */
function optApplyParamsToUI(params) {
  if (params.rangeWidthPct !== undefined) {
    const el = g('inRangeW');
    if (el) el.value = params.rangeWidthPct;
    botConfig.rangeW = params.rangeWidthPct;
    const rw = g('activeRangeW');
    if (rw) rw.textContent = params.rangeWidthPct;
  }
  if (params.triggerType !== undefined) setTType(params.triggerType);
  if (params.minRebalanceIntervalMin !== undefined) {
    const el = g('inMinInterval');
    if (el) el.value = params.minRebalanceIntervalMin;
    throttle.minIntervalMs = params.minRebalanceIntervalMin * 60 * 1000;
    if (!throttle.doublingActive) throttle.currentWaitMs = throttle.minIntervalMs;
    const dbl = g('dblWindowLabel');
    if (dbl) dbl.textContent = fmtMs(4 * throttle.minIntervalMs);
  }
  if (params.maxRebalancesPerDay !== undefined) {
    const el = g('inMaxReb');
    if (el) el.value = params.maxRebalancesPerDay;
    throttle.dailyMax = params.maxRebalancesPerDay;
  }
  if (params.slippagePct !== undefined) {
    const el = g('inSlip'); if (el) el.value = params.slippagePct;
  }
  if (params.checkIntervalSec !== undefined) {
    const el = g('inInterval'); if (el) el.value = params.checkIntervalSec;
  }
}

// ── Fetch cycle ─────────────────────────────────────────────────────────────

/** Run one fetch cycle against the optimizer engine. */
async function _optRunCycle() {
  if (!optState.connected) return;
  optState.totalFetches++;
  optState.lastFetchAt = new Date().toISOString();
  optSyncParamsFromUI();

  const url = optState.url || OPT_DEFAULT_URL;
  let rec, ok, errorMsg;

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (optState.apiKey) headers['Authorization'] = 'Bearer ' + optState.apiKey;
    const resp = await fetch(`${url}/api/recommend`, {
      method: 'POST', headers,
      body: JSON.stringify({
        rangeWidthPct:           botParams.rangeWidthPct,
        triggerType:             botParams.triggerType,
        minRebalanceIntervalMin: botParams.minRebalanceIntervalMin,
        maxRebalancesPerDay:     botParams.maxRebalancesPerDay,
        slippagePct:             botParams.slippagePct,
        checkIntervalSec:        botParams.checkIntervalSec,
      }),
    });
    if (!resp.ok) { errorMsg = `Engine returned HTTP ${resp.status}`; ok = false; }
    else { rec = _optNormaliseRec(await resp.json()); ok = true; }
  } catch (err) {
    optSetConnState('err');
    errorMsg = err.message;
    ok = false;
  }

  if (ok && rec) {
    optState.successFetches++;
    optState.lastError = null;
    optState.lastRec   = rec;
    _optPushHistory({ ok: true, fetchedAt: optState.lastFetchAt, rec });
    _optRenderRec(rec);
    act('\u{1F916}', 'fee', 'Optimizer recommendation received',
      `Confidence: ${(rec.confidence * 100).toFixed(0)}% \u00B7 ` +
      `${rec.changes.length} suggestion${rec.changes.length !== 1 ? 's' : ''}`);
    if (optState.autoApply) optApplyRec(rec);
    else { const ab = g('optApplyBtn'); if (ab) ab.disabled = false; }
  } else {
    optState.lastError = errorMsg;
    _optPushHistory({ ok: false, fetchedAt: optState.lastFetchAt, error: errorMsg });
    act('\u26A0', 'alert', 'Optimizer fetch failed', errorMsg);
  }
  _optRenderStatus();
}

/**
 * Normalise a raw API response into the internal recommendation shape.
 * @param {object} raw  Raw JSON from the engine.
 * @returns {object}
 */
function _optNormaliseRec(raw) {
  const BOUNDS = {
    rangeWidthPct: [1, 200], edgePct: [1, 49], schedHours: [1, 168],
    minRebalanceIntervalMin: [1, 1440], maxRebalancesPerDay: [1, 200],
    slippagePct: [0.01, 10], checkIntervalSec: [10, 3600],
  };
  const suggested = {};
  const changes   = [];
  for (const [key, [lo, hi]] of Object.entries(BOUNDS)) {
    if (raw[key] !== undefined) {
      const v = Math.max(lo, Math.min(hi, Number(raw[key])));
      if (isFinite(v) && v !== botParams[key]) { suggested[key] = v; changes.push(key); }
    }
  }
  if (raw.triggerType && ['oor', 'edge', 'time'].includes(raw.triggerType) &&
      raw.triggerType !== botParams.triggerType) {
    suggested.triggerType = raw.triggerType;
    changes.push('triggerType');
  }
  return {
    suggested, changes,
    confidence: typeof raw.confidence === 'number'
      ? Math.max(0, Math.min(1, raw.confidence)) : 0.75,
    rationale: typeof raw.rationale === 'string' ? raw.rationale.slice(0, 500) : '',
    fetchedAt: new Date().toISOString(),
  };
}

/** Schedule the next auto-poll cycle. */
function _optScheduleNext() {
  clearTimeout(optState.timer);
  optState.nextFetchAt = Date.now() + optState.intervalMs;
  optState.timer = setTimeout(async () => {
    if (!optState.connected || !optState.enabled) return;
    await _optRunCycle();
    if (optState.connected && optState.enabled) _optScheduleNext();
  }, optState.intervalMs);
  _optRenderNextLabel();
}

/** Update the "Next: MM:SS" countdown label. */
function _optRenderNextLabel() {
  const el = g('optNextLabel');
  if (!el) return;
  if (!optState.enabled || !optState.nextFetchAt) { el.textContent = ''; return; }
  const ms = Math.max(0, optState.nextFetchAt - Date.now());
  const m  = Math.floor(ms / 60000);
  const s  = Math.floor((ms % 60000) / 1000);
  el.textContent = `Next: ${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ── Manual query ────────────────────────────────────────────────────────────

/** Manually trigger one fetch cycle. */
async function optQueryNow() {
  if (!optState.connected) return;
  const btn = g('optQueryBtn');
  if (btn) { btn.disabled = true; btn.textContent = '\u23F3 Querying\u2026'; }
  await _optRunCycle();
  if (btn) { btn.disabled = !optState.connected; btn.textContent = '\u26A1 Query Now'; }
}

// ── Render recommendation ───────────────────────────────────────────────────

/**
 * Render a recommendation in the UI panel.
 * @param {object} rec  Normalised recommendation.
 */
function _optRenderRec(rec) {
  const panel = g('optRecPanel');
  if (panel) panel.classList.remove('hidden');
  const timeEl = g('optRecTime');
  if (timeEl) timeEl.textContent = fmtDateTime(rec.fetchedAt);

  const confWrap = g('optConfWrap');
  const confFill = g('optConfFill');
  const confPct  = g('optConfPct');
  if (confWrap && rec.confidence !== undefined) {
    confWrap.style.display = '';
    const pct = Math.round(rec.confidence * 100);
    confFill.style.width      = pct + '%';
    confFill.style.background = pct >= 80 ? 'var(--accent3)' : pct >= 60 ? 'var(--warn)' : 'var(--danger)';
    confPct.textContent       = pct + '%';
  }

  const ratEl = g('optRationale');
  if (ratEl && rec.rationale) { ratEl.style.display = ''; ratEl.textContent = rec.rationale; }

  const grid = g('optChangesGrid');
  if (!grid) return;
  if (!rec.changes || rec.changes.length === 0) {
    grid.innerHTML = '<div class="opt-no-changes">No parameter changes suggested.</div>';
    return;
  }
  grid.innerHTML = rec.changes.map(field => {
    const cur = botParams[field];
    const nxt = rec.suggested[field];
    return `<div class="opt-change-item">
      <div class="opt-change-field">${_optFieldLabel(field)}</div>
      <div class="opt-change-val">
        <span class="opt-change-from">${_optFmtVal(field, cur)}</span>
        <span class="opt-change-arrow">\u2192</span>
        <span class="opt-change-to">${_optFmtVal(field, nxt)}</span>
      </div>
    </div>`;
  }).join('');
}

/**
 * Return a human-readable label for a bot parameter field.
 * @param {string} f  Field name.
 * @returns {string}
 */
function _optFieldLabel(f) {
  return {
    rangeWidthPct: 'Range Width', triggerType: 'Trigger', edgePct: 'Edge %',
    schedHours: 'Schedule', minRebalanceIntervalMin: 'Min Interval',
    maxRebalancesPerDay: 'Max/Day', slippagePct: 'Slippage',
    checkIntervalSec: 'Poll Interval',
  }[f] || f;
}

/**
 * Format a bot parameter value for display.
 * @param {string} field  Parameter name.
 * @param {*}      v      Parameter value.
 * @returns {string}
 */
function _optFmtVal(field, v) {
  if (v === undefined || v === null) return '\u2014';
  if (field === 'rangeWidthPct')           return `\u00B1${v}%`;
  if (field === 'slippagePct')             return `${v}%`;
  if (field === 'edgePct')                 return `${v}%`;
  if (field === 'minRebalanceIntervalMin') return `${v}m`;
  if (field === 'schedHours')              return `${v}h`;
  if (field === 'checkIntervalSec')        return `${v}s`;
  return String(v);
}

// ── Apply recommendation ────────────────────────────────────────────────────

/**
 * Apply a recommendation's suggested values to botParams and the UI.
 * @param {object} rec  Normalised recommendation.
 */
function optApplyRec(rec) {
  if (!rec || !rec.suggested) return;
  const applied = [];
  for (const [field, val] of Object.entries(rec.suggested)) {
    applied.push(`${_optFieldLabel(field)}: ${_optFmtVal(field, botParams[field])} \u2192 ${_optFmtVal(field, val)}`);
    botParams[field] = val;
  }
  optApplyParamsToUI(rec.suggested);
  const ab = g('optApplyBtn');
  if (ab) ab.disabled = true;
  act('\u2705', 'fee', 'Optimizer params applied',
    applied.length > 0 ? applied.join(' \u00B7 ') : 'No changes');
}

/** Apply the most recently received recommendation. */
function optApplyLast() {
  if (optState.lastRec) optApplyRec(optState.lastRec);
}

// ── History ─────────────────────────────────────────────────────────────────

/**
 * Push a history entry and re-render. Ring buffer capped at 50.
 * @param {object} entry
 */
function _optPushHistory(entry) {
  optState.history.unshift(entry);
  if (optState.history.length > 50) optState.history.pop();
  _optRenderHistory();
}

/** Render the last 8 history entries. */
function _optRenderHistory() {
  const el = g('optHistory');
  if (!el || optState.history.length === 0) return;
  el.innerHTML = optState.history.slice(0, 8).map(h => {
    const t   = h.fetchedAt ? fmtDateTime(h.fetchedAt) : '\u2014';
    const cnt = h.ok && h.rec ? h.rec.changes.length : 0;
    const cf  = h.ok && h.rec ? Math.round(h.rec.confidence * 100) + '%' : '';
    const msg = h.ok
      ? `${cnt} suggestion${cnt !== 1 ? 's' : ''}${cf ? ' \u00B7 ' + cf + ' conf' : ''}`
      : (h.error || 'Failed');
    return `<div class="opt-hist-row ${h.ok ? 'ok-row' : 'err-row'}">
      <span class="opt-hist-time">${t}</span>
      <span class="opt-hist-msg">${h.ok ? '\u2713' : '\u2717'} ${msg}</span>
    </div>`;
  }).join('');
}

/** Update the fetch-count and error status labels. */
function _optRenderStatus() {
  const tf  = g('optTotalFetches');
  const sf  = g('optSuccessFetches');
  const err = g('optLastErrLabel');
  if (tf)  tf.textContent = optState.totalFetches;
  if (sf)  sf.textContent = optState.successFetches;
  if (err) err.innerHTML  = optState.lastError
    ? `<span class="opt-status-err">\u26A0 ${optState.lastError}</span>` : '';
}

// Refresh countdown label every second
setInterval(_optRenderNextLabel, 1000);
