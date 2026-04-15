/**
 * @file dashboard-init.js
 * @description Bootstrap / initialisation for the 9mm v3 Position Manager
 * dashboard.  Imports all modules, wires up cross-module dependencies,
 * binds event handlers, and starts intervals.
 *
 * This is the single entry-point module loaded by index.html.
 */

import {
  g,
  act,
  ACT_ICONS,
  botConfig,
  loadPositionOorThreshold,
  initDisclaimer,
  compositeKey,
  refreshCsrfToken,
  csrfHeaders,
} from "./dashboard-helpers.js";
import {
  markWalletKnown,
  checkServerWalletStatus,
  injectWalletDeps,
  wallet,
  checkWalletLocked,
} from "./dashboard-wallet.js";
import {
  posStore,
  updatePosStripUI,
  _loadPosStore,
  _applyLocalPositionData,
  isPositionManaged,
  restoreManagedPositions,
  injectPositionDeps,
  scanPositions,
  activateByTokenId,
  clearPositionDisplay,
  restoreLastPosition,
} from "./dashboard-positions.js";
import {
  onParamChange,
  updateThrottleUI,
  injectThrottleDeps,
} from "./dashboard-throttle.js";
import {
  startDataPolling,
  loadRealizedGains,
  loadInitialDeposit,
  _fmtUsd,
  positionRangeVisual,
  refreshCurDepositDisplay,
  resetPollingState,
  resetHistoryFlag,
  pollNow,
  injectDataDeps,
  refreshDepositLabel,
} from "./dashboard-data.js";
import {
  fetchUnmanagedDetails,
  resetLastFetchedId,
} from "./dashboard-unmanaged.js";
import { injectPriceOverrideDeps } from "./dashboard-price-override.js";
import { initTelegram } from "./dashboard-telegram.js";
import { bindParamHelpButtons } from "./dashboard-param-help.js";
import { _resetCurrentKpis } from "./dashboard-data-kpi.js";
import {
  bindAllEvents,
  restorePrivacyMode,
  injectPosStoreForEvents,
} from "./dashboard-events.js";
import { clearHistory } from "./dashboard-history.js";
import {
  injectRouterDeps,
  initRouter,
  updateRouteForPosition,
  updateRouteForWallet,
  resolvePendingRoute,
  syncRouteToState,
  getPendingRouteWallet,
} from "./dashboard-router.js";
import {
  enterClosedPosView,
  exitClosedPosView,
  isViewingClosedPos,
} from "./dashboard-closed-pos.js";

// ── Wire cross-module dependencies (breaks circular imports) ────────────────

injectRouterDeps({ posStore, scanPositions, wallet, activateByTokenId });
injectWalletDeps({
  updatePosStripUI,
  scanPositions,
  posStore,
  updateRouteForWallet,
  syncRouteToState,
  resolvePendingRoute,
  clearPositionDisplay,
  resetPollingState,
  clearHistory,
  getPendingRouteWallet,
  resetLastFetchedId,
  fetchUnmanagedDetails,
});
injectPositionDeps({
  positionRangeVisual,
  updateRouteForPosition,
  syncRouteToState,
  enterClosedPosView,
  exitClosedPosView,
  isViewingClosedPos,
  fetchUnmanagedDetails,
  refreshDepositLabel,
  clearHistory,
  resetHistoryFlag,
  pollNow,
  resetCurrentKpis: _resetCurrentKpis,
});
injectThrottleDeps({ positionRangeVisual });
injectPosStoreForEvents(posStore);
const _refetch = (pos) => {
  resetLastFetchedId();
  fetchUnmanagedDetails(pos);
};
injectDataDeps({ refetchUnmanaged: _refetch });
injectPriceOverrideDeps({ refetchUnmanaged: _refetch });

// ── Bind all event handlers ─────────────────────────────────────────────────

bindAllEvents();
bindParamHelpButtons();
restorePrivacyMode();

// ── Disclaimer gate (must resolve before any dashboard init) ────────────────

initDisclaimer().then(async () => {
  await refreshCsrfToken();
  _afterDisclaimer();
});

/** All dashboard init runs after the disclaimer is accepted. */
function _afterDisclaimer() {
  // Restore positions from localStorage (persisted across page reloads)
  _loadPosStore();
  restoreManagedPositions();

  // Populate the known-wallet registry from any positions already in the store
  posStore.entries.forEach((e) => markWalletKnown(e.walletAddress));
  updatePosStripUI();

  // Restore saved range width and position data for the active position
  (function restoreActivePosition() {
    const active = posStore.getActive();
    const saved = loadPositionOorThreshold(active);
    botConfig.oorThreshold = saved;
    const el = g("inOorThreshold");
    if (el) el.value = saved;
    const disp = g("activeOorThreshold");
    if (disp) disp.textContent = saved;
    // Server is source of truth for config — _syncConfigFromServer() in
    // dashboard-data.js will populate UI inputs from the server on first poll.

    // Populate stat grid from stored position data
    if (active) {
      botConfig.lower = Math.pow(1.0001, active.tickLower || 0);
      botConfig.upper = Math.pow(1.0001, active.tickUpper || 0);
      botConfig.tL = active.tickLower || 0;
      botConfig.tU = active.tickUpper || 0;
      _applyLocalPositionData(active);
      if (!isPositionManaged(active.tokenId)) fetchUnmanagedDetails(active);
    }
    refreshCurDepositDisplay();
  })();

  // ── Activity log ─────────────────────────────────────────────────────────────

  // Restore RPC URL from localStorage
  (function restoreRpcUrl() {
    try {
      const saved = localStorage.getItem("9mm_rpc_url");
      if (saved) {
        const el = g("inRpc");
        if (el) el.value = saved;
      }
    } catch {
      /* private mode */
    }
  })();

  act(ACT_ICONS.play, "start", "Dashboard Ready", "Import a wallet to begin");

  // Check if the server already has a wallet loaded (e.g. from a previous page load)
  checkServerWalletStatus();
  checkWalletLocked();

  // Initialise client-side URL routing (must run after wallet status check starts)
  initRouter();
  initTelegram();

  // Restore last-viewed position from localStorage (if URL doesn't specify one)
  const _path = window.location.pathname.replace(/\/+$/, "");
  if (!_path || _path === "/" || _path.split("/").length < 5)
    restoreLastPosition();

  // Populate realized gains and lifetime deposit displays from localStorage
  (function initSavedValues() {
    const rg = loadRealizedGains();
    const rgEl = g("pnlRealized");
    if (rgEl) rgEl.textContent = _fmtUsd(rg);
    const dep = loadInitialDeposit();
    const depDisp = g("lifetimeDepositDisplay");
    if (depDisp)
      depDisp.textContent = dep > 0 ? "$usd " + dep.toFixed(2) : "\u2014";
    const depLabel = g("initialDepositLabel");
    if (depLabel)
      depLabel.textContent =
        dep > 0
          ? "Total Lifetime Deposit: $" + dep.toFixed(2)
          : "Edit Total Lifetime Deposit";
    // Re-sync localStorage deposit to server (survives npm run clean)
    if (dep > 0) {
      const a = posStore.getActive(),
        pk = a
          ? compositeKey(
              "pulsechain",
              a.walletAddress,
              a.contractAddress,
              a.tokenId,
            )
          : undefined;
      fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...csrfHeaders() },
        body: JSON.stringify({ initialDepositUsd: dep, positionKey: pk }),
      }).catch(() => {});
    }
  })();

  // ── Start intervals ─────────────────────────────────────────────────────────

  onParamChange();
  setInterval(updateThrottleUI, 1000);
  startDataPolling();

  // One-shot: auto-scan on wallet load to populate symbols + fresh data from LP cache.
  // Navigate to the bot's active position only on fresh starts (no position selected yet).
  let _initScanDone = false;
  setTimeout(() => {
    if (_initScanDone) return;
    _initScanDone = true;
    if (wallet.address) {
      const fresh = posStore.activeIdx < 0;
      scanPositions({ navigate: fresh, silent: !fresh });
    }
  }, 5000);
} // end _afterDisclaimer
