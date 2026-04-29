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
  csrfRefreshIntervalMs,
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
  setConfigInputDefault,
} from "./dashboard-data.js";
import {
  fetchUnmanagedDetails,
  resetLastFetchedId,
  flushPendingUnmanagedFetch,
} from "./dashboard-unmanaged.js";
import { injectPriceOverrideDeps } from "./dashboard-price-override.js";
import { initTelegram } from "./dashboard-telegram.js";
import { bindParamHelpButtons } from "./dashboard-param-help.js";
import { _resetCurrentKpis } from "./dashboard-data-kpi.js";
import { loadNftProviders } from "./dashboard-nft-providers.js";
import { loadChartProviders } from "./dashboard-chart-providers.js";
import {
  bindAllEvents,
  restorePrivacyMode,
  injectPosStoreForEvents,
} from "./dashboard-events.js";
import {
  restoreSoundsToggle,
  bindSoundsToggle,
  bindAboutEasterEgg,
  bindTitleTune,
} from "./dashboard-sounds.js";
import {
  bindPrivacySubform,
  restorePrivacySubform,
} from "./dashboard-privacy-subform.js";
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
import {
  BUILD_COMMIT,
  BUILD_COMMIT_DATE,
  BUILD_RELEASE_TAG,
  BUILD_PACKAGE_VERSION,
} from "./build-info.js";

/*- Very first statement of the browser app — light gray text on black,
 *  rocket emoji before and after "Started."  Mirrors the server-side
 *  banner in server.js / bot.js. */
console.log(
  "%c[lp-ranger app] \uD83D\uDE80 Started. \uD83D\uDE80",
  "color: lightgray; background: black; padding: 2px 4px;",
);

/*-
 * Second log: version/commit banner for support triage. Logged before
 * any other bootstrap work so it is always near the top of the browser
 * console. Mirrors the server.js startup banner.
 *
 * Display-version priority — same rule as src/build-info.js
 * `_displayVersion`:
 *   1. Git tag (authoritative for release tarballs — pkg.json still
 *      reads "0.0.0-dev" inside the tarball, but the tag is baked in).
 *   2. package.json version (when not the dev sentinel).
 *   3. Suppress the `version=` segment — unreleased dev build on an
 *      untagged commit.
 */
const _DEV_VERSION_SENTINEL = "0.0.0-dev";
const _displayVersion =
  BUILD_RELEASE_TAG ||
  (BUILD_PACKAGE_VERSION && BUILD_PACKAGE_VERSION !== _DEV_VERSION_SENTINEL
    ? BUILD_PACKAGE_VERSION
    : null);
if (_displayVersion === null) {
  console.log(
    "[lp-ranger] LP Ranger commit=%s commitDate=%s tag=%s",
    BUILD_COMMIT,
    BUILD_COMMIT_DATE,
    BUILD_RELEASE_TAG || "(none)",
  );
} else {
  console.log(
    "[lp-ranger] LP Ranger version=%s commit=%s commitDate=%s tag=%s",
    _displayVersion,
    BUILD_COMMIT,
    BUILD_COMMIT_DATE,
    BUILD_RELEASE_TAG || "(none)",
  );
}

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
  flushPendingUnmanagedFetch,
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
bindSoundsToggle();
bindAboutEasterEgg();
bindTitleTune();
bindPrivacySubform();
restorePrivacyMode();
restoreSoundsToggle();
restorePrivacySubform();

// ── Disclaimer gate (must resolve before any dashboard init) ────────────────

initDisclaimer().then(async () => {
  await refreshCsrfToken();
  /*- Schedule periodic CSRF refresh. Interval comes from the server
      (app-config/static-tunables/csrf.json) so operators can tune
      without a client rebuild. Fires regardless of poll-loop health —
      auto-fired background POSTs on long-running servers (e.g. Pi 5
      during a multi-hour phase-2 scan) always have a fresh token. */
  setInterval(refreshCsrfToken, csrfRefreshIntervalMs());
  _afterDisclaimer();
});

/** All dashboard init runs after the disclaimer is accepted. */
function _afterDisclaimer() {
  // Fetch NFT-provider label map so the Fee Tier row can render the
  // short provider label (e.g. "9mm v3").  When it resolves we re-paint
  // the strip so a late-arriving map still shows up without waiting for
  // the next user-driven render.
  loadNftProviders().then(() => updatePosStripUI());

  /*- Fetch the per-chain Chart Links list (DexScreener / GeckoTerminal /
   *  DexTools) so the Pool Details modal can render hrefs without any
   *  hard-coded chain slug. Silent on failure — the section simply
   *  renders empty links rather than blocking the modal. */
  loadChartProviders();

  /*- Fetch Bot Config tunable defaults so each input shows the value
   *  declared in app-config/static-tunables/bot-config-defaults.json
   *  instead of relying on a hard-coded `value=` attribute in
   *  index.html.  Server is the single source for first-visit defaults;
   *  per-position overrides arrive later via _syncConfigFromServer().
   *  Silent on failure — inputs simply stay empty until poll data
   *  arrives. */
  const _DEFAULT_INPUT_MAP = {
    approvalMultiple: "inApprovalMultiple",
    rebalanceOutOfRangeThresholdPercent: "inOorThreshold",
    rebalanceTimeoutMin: "inOorTimeout",
    slippagePct: "inSlip",
    checkIntervalSec: "inInterval",
    minRebalanceIntervalMin: "inMinInterval",
    maxRebalancesPerDay: "inMaxReb",
    offsetToken0Pct: "inOffsetToken0",
  };
  fetch("/api/bot-config-defaults")
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (!d) return;
      for (const [key, elId] of Object.entries(_DEFAULT_INPUT_MAP)) {
        const v = d[key];
        if (typeof v !== "number") continue;
        setConfigInputDefault(key, v);
        const el = g(elId);
        if (el && !el.dataset.userDirty) el.value = v;
      }
      /*- Keep the complement offset input in sync with the offsetToken0
       *  default so the row reads correctly on first paint. */
      if (typeof d.offsetToken0Pct === "number") {
        const el1 = g("inOffsetToken1");
        if (el1 && !el1.dataset.userDirty) el1.value = 100 - d.offsetToken0Pct;
      }
    })
    .catch(() => {});

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
      /*- Prime the pending unmanaged-fetch slot for the active position.
       *  The wallet is always still locked at init time, so the call
       *  itself entry-skips with "wallet-locked" and records pos as
       *  pending.  flushPendingUnmanagedFetch() (called from the unlock
       *  paths) drains it once the wallet is ready.  We do NOT gate on
       *  isPositionManaged here — the localStorage managed-tokenIds Set
       *  may be stale across sessions (e.g. server auto-retired the
       *  position while the page was closed), and a one-shot fetch for
       *  a position that turns out to be managed is a harmless no-op
       *  that the dedup guard prevents from re-firing. */
      fetchUnmanagedDetails(active);
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
    if (depDisp) depDisp.textContent = dep > 0 ? _fmtUsd(dep) : "\u2014";
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

  /*- Every 10 minutes, log the JS heap size.  The dashboard is designed to
      stay open indefinitely, so a steadily-rising `used` line across hours
      indicates a leak (event listeners, closures, cached arrays held in
      JS).  Chrome-only (`performance.memory` is non-standard); silent on
      other browsers. */
  if (performance && performance.memory) {
    const _logHeap = () => {
      const m = performance.memory;
      console.log(
        "[lp-ranger] [js heap] %s MB used / %s MB allocated",
        (m.usedJSHeapSize / 1048576).toFixed(1),
        (m.totalJSHeapSize / 1048576).toFixed(1),
      );
    };
    _logHeap();
    setInterval(_logHeap, 10 * 60 * 1000);
  }

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
