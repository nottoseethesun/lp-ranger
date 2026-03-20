/**
 * @file dashboard-init.js
 * @description Bootstrap / initialisation for the 9mm v3 Position Manager
 * dashboard.  Imports all modules, wires up cross-module dependencies,
 * binds event handlers, and starts intervals.
 *
 * This is the single entry-point module loaded by index.html.
 */

import { g, act, botConfig, loadPositionOorThreshold, initDisclaimer } from './dashboard-helpers.js';
import {
  markWalletKnown, checkServerWalletStatus, injectWalletDeps, wallet,
} from './dashboard-wallet.js';
import {
  posStore, updatePosStripUI, _loadPosStore, _applyLocalPositionData,
  injectPositionDeps, scanPositions, activateByTokenId, clearPositionDisplay,
} from './dashboard-positions.js';
import {
  onParamChange, updateThrottleUI, injectThrottleDeps, snapshotApplied,
} from './dashboard-throttle.js';
import {
  startDataPolling, loadRealizedGains, loadInitialDeposit, _fmtUsd, positionRangeVisual,
  refreshCurDepositDisplay, resetPollingState,
} from './dashboard-data.js';
import { bindAllEvents, restorePrivacyMode } from './dashboard-events.js';
import { clearHistory } from './dashboard-history.js';
import {
  injectRouterDeps, initRouter, updateRouteForPosition, updateRouteForWallet,
  resolvePendingRoute, syncRouteToState, getPendingRouteWallet,
} from './dashboard-router.js';
import {
  enterClosedPosView, exitClosedPosView, isViewingClosedPos,
} from './dashboard-closed-pos.js';

// ── Wire cross-module dependencies (breaks circular imports) ────────────────

injectRouterDeps({ posStore, scanPositions, wallet, activateByTokenId });
injectWalletDeps({ updatePosStripUI, scanPositions, posStore, updateRouteForWallet, resolvePendingRoute, clearPositionDisplay, resetPollingState, clearHistory, getPendingRouteWallet });
injectPositionDeps({ positionRangeVisual, updateRouteForPosition, syncRouteToState, enterClosedPosView, exitClosedPosView, isViewingClosedPos });
injectThrottleDeps({ positionRangeVisual });

// ── Bind all event handlers ─────────────────────────────────────────────────

bindAllEvents();
restorePrivacyMode();

// ── Disclaimer gate (must resolve before any dashboard init) ────────────────

initDisclaimer().then(() => { _afterDisclaimer(); });

/** All dashboard init runs after the disclaimer is accepted. */
function _afterDisclaimer() {

// Restore positions from localStorage (persisted across page reloads)
_loadPosStore();

// Populate the known-wallet registry from any positions already in the store
posStore.entries.forEach(e => markWalletKnown(e.walletAddress));
updatePosStripUI();

// Restore saved range width and position data for the active position
(function restoreActivePosition() {
  const active = posStore.getActive();
  const saved = loadPositionOorThreshold(active);
  botConfig.oorThreshold = saved;
  const el = g('inOorThreshold');
  if (el) el.value = saved;
  const disp = g('activeOorThreshold');
  if (disp) disp.textContent = saved;
  // Sync per-position threshold to server so the bot uses the correct value
  fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rebalanceOutOfRangeThresholdPercent: saved }) }).catch(() => {});

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

// Initialise client-side URL routing (must run after wallet status check starts)
initRouter();

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

} // end _afterDisclaimer
