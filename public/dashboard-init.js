/**
 * @file dashboard-init.js
 * @description Bootstrap / initialisation for the 9mm v3 Position Manager
 * dashboard.  Imports all modules, wires up cross-module dependencies,
 * binds event handlers, and starts intervals.
 *
 * This is the single entry-point module loaded by index.html.
 */

import { g, act, botConfig, loadPositionRangeW, initDisclaimer } from './dashboard-helpers.js';
import {
  markWalletKnown, checkServerWalletStatus, injectWalletDeps,
} from './dashboard-wallet.js';
import {
  posStore, updatePosStripUI, _loadPosStore, _applyLocalPositionData,
  injectPositionDeps, scanPositions,
} from './dashboard-positions.js';
import {
  onParamChange, updateThrottleUI, injectThrottleDeps, snapshotApplied,
} from './dashboard-throttle.js';
import {
  startDataPolling, loadRealizedGains, loadInitialDeposit, _fmtUsd, positionRangeVisual,
  refreshCurDepositDisplay,
} from './dashboard-data.js';
import { bindAllEvents } from './dashboard-events.js';

// ── Wire cross-module dependencies (breaks circular imports) ────────────────

injectWalletDeps({ updatePosStripUI, scanPositions, posStore });
injectPositionDeps({ positionRangeVisual });
injectThrottleDeps({ positionRangeVisual });

// ── Bind all event handlers ─────────────────────────────────────────────────

bindAllEvents();

// ── Disclaimer gate (must run before any dashboard init) ───────────────────

initDisclaimer();

// ── Initialise trigger UI ──────────────────────────────────────────────────

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
    _applyLocalPositionData(active);
  }
  refreshCurDepositDisplay();
}());

// ── Activity log ─────────────────────────────────────────────────────────────

// Restore RPC URL from localStorage
(function restoreRpcUrl() {
  try {
    const saved = localStorage.getItem('9mm_rpc_url');
    if (saved) {
      const el = g('inRpc');
      if (el) el.value = saved;
    }
  } catch { /* private mode */ }
}());

act('\u{1F680}', 'start', 'Dashboard ready', 'Import a wallet to begin');

// Check if the server already has a wallet loaded (e.g. from a previous page load)
checkServerWalletStatus();

// Populate realized gains and lifetime deposit displays from localStorage
(function initSavedValues() {
  const rg = loadRealizedGains();
  const rgEl = g('pnlRealized');
  if (rgEl) rgEl.textContent = _fmtUsd(rg);
  const dep = loadInitialDeposit();
  const depDisp = g('lifetimeDepositDisplay');
  if (depDisp) depDisp.textContent = dep > 0 ? '$usd ' + dep.toFixed(2) : '—';
  const depLabel = g('initialDepositLabel');
  if (depLabel) depLabel.textContent = dep > 0 ? 'Initial Deposit: $' + dep.toFixed(2) : 'Edit Initial Deposit';
}());

// ── Start intervals ─────────────────────────────────────────────────────────

onParamChange();
snapshotApplied();
setInterval(updateThrottleUI, 1000);
startDataPolling();
