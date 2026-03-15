/**
 * @file dashboard-init.js
 * @description Bootstrap / initialisation for the 9mm v3 Position Manager
 * dashboard.  Populates the known-wallet registry, starts the optimizer
 * probe, and kicks off the throttle UI interval.
 *
 * Must be loaded last — after all other dashboard-*.js scripts.
 */

/* global g, act, setTType, renderTParams, initDisclaimer,
          posStore, markWalletKnown, updatePosStripUI, OPT_DEFAULT_URL, optState,
          _optRestartProbe, onParamChange, updateThrottleUI, startDataPolling,
          loadPositionRangeW, botConfig, checkServerWalletStatus,
          loadRealizedGains, _fmtUsd, _loadPosStore, _applyLocalPositionData,
          _9mmPosMgr */
'use strict';

// ── Disclaimer gate (must run before any dashboard init) ───────────────────
initDisclaimer();

// ── Initialise trigger UI ──────────────────────────────────────────────────

setTType(_9mmPosMgr.TRIGGER_OOR);
renderTParams();

// Restore positions from localStorage (persisted across page reloads)
_loadPosStore();

// Populate the known-wallet registry from any positions already in the store
posStore.entries.forEach(e => markWalletKnown(e.walletAddress));
updatePosStripUI();

// Restore saved range width and position data for the active position
(function restoreActivePosition() {
  const active = posStore.getActive();
  const saved = loadPositionRangeW(active);
  botConfig.rangeW = saved;
  const el = g('inRangeW');
  if (el) el.value = saved;
  const disp = g('activeRangeW');
  if (disp) disp.textContent = saved;

  // Populate stat grid from stored position data
  if (active) {
    botConfig.lower = Math.pow(1.0001, active.tickLower || 0);
    botConfig.upper = Math.pow(1.0001, active.tickUpper || 0);
    botConfig.tL = active.tickLower || 0;
    botConfig.tU = active.tickUpper || 0;
    if (typeof _applyLocalPositionData === 'function') _applyLocalPositionData(active);
  }
}());

// ── Initialise optimizer ────────────────────────────────────────────────────

(function initOptimizer() {
  const urlField = g('optUrl');
  if (urlField && !urlField.value) urlField.value = OPT_DEFAULT_URL;
  optState.url = OPT_DEFAULT_URL;
  const probeEl = g('optProbeUrl');
  if (probeEl) probeEl.textContent = OPT_DEFAULT_URL;
  _optRestartProbe();
}());

// ── Activity log ─────────────────────────────────────────────────────────────

act('\u{1F680}', 'start', 'Dashboard ready', 'Import a wallet to begin');

// Check if the server already has a wallet loaded (e.g. from a previous page load)
checkServerWalletStatus();

// Populate realized gains display from localStorage
(function initRealizedGains() {
  const val = loadRealizedGains();
  const el = g('pnlRealized');
  if (el) el.textContent = _fmtUsd(val);
}());

// ── Start intervals ─────────────────────────────────────────────────────────

onParamChange();
setInterval(updateThrottleUI, 1000);
startDataPolling();
