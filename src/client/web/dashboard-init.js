/**
 * @file dashboard-init.js
 * @description Bootstrap / initialisation for the LP Ranger
 * dashboard.  Imports all modules, wires up cross-module dependencies,
 * binds event handlers, and starts intervals.
 *
 * This is the single entry-point module loaded by index.html.
 */

import { log } from "./dashboard-log.js";
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
  fetchWithCsrf,
} from "./dashboard-helpers.js";
import {
  markWalletKnown,
  checkServerWalletStatus,
  injectWalletDeps,
  wallet,
  checkWalletLocked,
} from "./dashboard-wallet.js";
import {
  injectPositionDeps,
  scanPositions,
  activateByTokenId,
  clearPositionDisplay,
  restoreLastPosition,
} from "./dashboard-positions.js";
import {
  posStore,
  updatePosStripUI,
  _loadPosStore,
  _applyLocalPositionData,
  restoreManagedPositions,
} from "./dashboard-positions-store.js";
import { updateThrottleUI, injectThrottleDeps } from "./dashboard-throttle.js";
import {
  resetPollingState,
  resetHistoryFlag,
  getLastStatus,
  isSyncComplete,
  initDataDepositWiring,
} from "./dashboard-data.js";
import {
  loadRealizedGains,
  loadInitialDeposit,
  refreshCurDepositDisplay,
  injectDataDeps,
  refreshDepositLabel,
  refreshLifetimeDaysLabel,
  loadLifetimeStartDateOverride,
} from "./dashboard-data-deposit.js";
import { _fmtUsd } from "./dashboard-fmt-usd.js";
import { positionRangeVisual } from "./dashboard-data-range.js";
import { setConfigInputDefault } from "./dashboard-config-inputs.js";
import { injectManageUIDeps, paintManageUI } from "./dashboard-manage-ui.js";
import {
  fetchUnmanagedDetails,
  resetLastFetchedId,
  flushPendingUnmanagedFetch,
} from "./dashboard-unmanaged.js";
import { injectPriceOverrideDeps } from "./dashboard-price-override.js";
import { initTelegram } from "./dashboard-telegram.js";
import { startBrowserIdleTracker } from "./dashboard-idle.js";
import { loadUiSettings, uiSetting } from "./dashboard-ui-settings.js";
import { startStaleDataWatch } from "./dashboard-stale-data.js";
import { bindParamHelpButtons } from "./dashboard-param-help.js";
import { _resetCurrentKpis } from "./dashboard-data-kpi.js";
import { loadLpProviders } from "./dashboard-lp-providers.js";
import {
  loadTokenLogos,
  paintStatTokenLogos,
} from "./dashboard-token-logos.js";
import { loadChartProviders } from "./dashboard-chart-providers.js";
import { initRpcEndpoints } from "./dashboard-rpc-endpoints.js";
import { loadSettingLabels } from "./dashboard-setting-labels.js";
import { bindAllEvents } from "./dashboard-events.js";
import { loadHelpFigures } from "./dashboard-help-figures.js";
import {
  restorePrivacyMode,
  injectPosStoreForEvents,
} from "./dashboard-events-manage.js";
import { injectPosStoreForReload } from "./dashboard-reload-flow.js";
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
import {
  activeChainId,
  loadActiveChain,
  paintChainLink,
} from "./dashboard-chain.js";
import {
  countAnsweredQuestion,
  countUnansweredQuestion,
  pollNow,
  startDataPolling,
} from "./dashboard-data-poll.js";

/*- Very first statement of the browser app — light gray text on black,
 *  rocket emoji before and after "Started."  Mirrors the server-side
 *  banner in server.js / bot.js. */
log.info(
  "%c[lp-ranger app] \uD83D\uDE80 Started. \uD83D\uDE80",
  "color: lightgray; background: black; padding: 2px 4px;",
);

/*-
 * Second log: version/commit banner for support triage. Logged before
 * any other bootstrap work so it is always near the top of the browser
 * console. Mirrors the server.js startup banner.
 *
 * Display-version priority — same rule as src/lib/build-info.js
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
  log.info(
    "[lp-ranger] LP Ranger commit=%s commitDate=%s tag=%s",
    BUILD_COMMIT,
    BUILD_COMMIT_DATE,
    BUILD_RELEASE_TAG || "(none)",
  );
} else {
  log.info(
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
  refreshLifetimeDaysLabel,
  clearHistory,
  resetHistoryFlag,
  pollNow,
  resetCurrentKpis: _resetCurrentKpis,
});
injectThrottleDeps({ positionRangeVisual, getLastStatus });
injectPosStoreForEvents(posStore);
injectPosStoreForReload(posStore);
/*- Wire the Manage-UI single owner with read access to posStore and
 *  the latest /api/status payload.  Done once at init; subsequent
 *  paintManageUI() calls (from poll, activation, click, wallet
 *  transitions, etc.) gather their own inputs through these refs. */
injectManageUIDeps({ posStore, getLastStatus, isSyncComplete });
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
  /*- Schedule periodic CSRF refresh. Interval comes from the server,
      backed by the layered defaults+user-override loader (shipped
      default at app-config/app-defaults-for-user-configurable/csrf.json;
      operators override by copying that file to
      app-config/user-configurable/csrf.json and editing the copy).
      Tunable without a client rebuild. Fires regardless of poll-loop health —
      auto-fired background POSTs on long-running servers (e.g. Pi 5
      during a multi-hour phase-2 scan) always have a fresh token. */
  setInterval(refreshCsrfToken, csrfRefreshIntervalMs());
  /*- Refresh on visibilitychange + focus: Chrome heavily throttles
      setInterval for hidden tabs (often coalesced to ≥1 min, sometimes
      paused entirely on tab discard / OS sleep), so the periodic timer
      alone can let a held token age past the 60-min server TTL during
      long idle windows.  Listen to both events because they cover
      overlapping but non-identical cases:
        - `visibilitychange` fires when the tab becomes visible (tab
          foregrounded, OS un-suspended).
        - `focus` fires when the window gains keyboard focus — a tab
          can be visible-but-unfocused (e.g. another window of the same
          browser is active, or devtools is focused).
      Both fire ahead of any user-driven POST. */
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshCsrfToken();
  });
  window.addEventListener("focus", () => refreshCsrfToken());
  /*-
   *  Before anything builds a position key or registers a route: the
   *  active chain is the first segment of both, so startup waits here
   *  until the server names it. Each request that ends without naming it
   *  counts toward the HALTED pill, as an unanswered status poll does.
   */
  await loadActiveChain({
    onUnanswered: countUnansweredQuestion,
    onAnswered: countAnsweredQuestion,
  });
  paintChainLink();
  /*-
   *  The dashboard settings the server sends, the poll interval among
   *  them: waited for, because everything started below reads them. Each
   *  request that ends without them counts toward the HALTED pill, as
   *  the chain's does.
   */
  await loadUiSettings({
    onUnanswered: countUnansweredQuestion,
    onAnswered: countAnsweredQuestion,
  });
  /*-
   *  The figures the help quotes, as this install runs: not waited for,
   *  because only the help and the Doubling Trigger Window label read
   *  them, and the page's figure spans stay empty until they land.
   */
  loadHelpFigures({
    onUnanswered: countUnansweredQuestion,
    onAnswered: countAnsweredQuestion,
  });
  _afterDisclaimer();
});

/** All dashboard init runs after the disclaimer is accepted. */
function _afterDisclaimer() {
  /*-
   *  Fetch the LP-provider label map so the Fee Tier row can render the
   *  short provider label (e.g. "9mm v3").  When it resolves we re-paint
   *  the strip so a late-arriving map still shows up without waiting for
   *  the next user-driven render.
   */
  loadLpProviders().then(() => updatePosStripUI());
  /*-
   *  Read the chain's token list, then repaint the token logos in the
   *  Pool line and atop Position Stats, which show placeholders until it
   *  lands.
   */
  loadTokenLogos().then(() => {
    updatePosStripUI();
    paintStatTokenLogos(posStore.getActive());
  });

  /*- Fetch the per-chain Chart Links list (DexScreener / GeckoTerminal /
   *  DexTools) so the Pool Details modal can render hrefs without any
   *  hard-coded chain slug. Silent on failure — the section simply
   *  renders empty links rather than blocking the modal. */
  loadChartProviders();
  /*- Fetch human-readable label map for Activity Log 'Setting Saved'
   *  formatter.  Silent on failure — the client falls back to raw
   *  '<key> = <value>' form when the label map is empty. */
  loadSettingLabels();

  /*- Fetch Bot Config tunable defaults so each input shows the value
   *  declared in app-config/app-defaults-for-user-configurable/bot-config-defaults.json
   *  instead of relying on a hard-coded `value=` attribute in
   *  index.html.  Server is the single source for first-visit defaults;
   *  per-position overrides arrive later via _syncConfigFromServer().
   *  Silent on failure — inputs simply stay empty until poll data
   *  arrives. */
  const _DEFAULT_INPUT_MAP = {
    approvalMultiple: "inApprovalMultiple",
    impermanentLossGuardPct: "inIlGuard",
    rebalanceOutOfRangeThresholdPercent: "inOorThreshold",
    rebalanceTimeoutMin: "inOorTimeout",
    minRebalanceIntervalMin: "inMinInterval",
    maxRebalancesPerDay: "inMaxReb",
    offsetToken0Pct: "inOffsetToken0",
    gasFeePct: "inGasFeePct",
  };
  /*- Per-token slippage inputs (inSlipToken0 / inSlipToken1) both
   *  seed from the same `slippagePct` shipped default (0.75) — see
   *  `syncPerTokenSlippage` in dashboard-per-token-slippage.js.  Not
   *  in the main map because both point to the SAME config key. */
  /*- Store-only defaults: shipped values that must be reachable via
   *  `getInputDefault(key)` (e.g. the "Default" button on the Price
   *  Range Extension row reads its value from here) but must NOT
   *  auto-populate their input on init.  For Price Range Extension,
   *  the input either shows a saved-override or stays empty (empty
   *  ⇒ preserve current Range Width on rebalance).  Auto-injecting
   *  the shipped default at init would look like a saved value the
   *  user never made. */
  /*- `rescanPricesRecentWindowDays` joins them for the same reason from
   *  the other direction: it has no input at all. It only labels the
   *  Re-scan Prices window checkbox, and caching it here keeps the one
   *  literal in the shipped JSON rather than in the dialog's markup. */
  const _STORE_ONLY_DEFAULT_KEYS = [
    "rebalanceRangeWidthPct",
    "rescanPricesRecentWindowDays",
    /*- Seeds BOTH per-token slippage inputs, which is why it is here
     *  rather than in the map above — that map drives one input per
     *  key. Without it `getInputDefault("slippagePct")` was never
     *  populated at all, so the two Slippage fields rendered empty
     *  while every swap went on using this very number. */
    "slippagePct",
  ];
  /*- No input carries a min/max any more. Whether a value is acceptable
   *  is `src/lib/config-bounds.js`'s answer, on the server, because the core
   *  has more than one frontend and a bound stamped onto an element
   *  binds only this one. */
  fetch("/api/bot-config-defaults")
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (!d) return;
      for (const [key, elId] of Object.entries(_DEFAULT_INPUT_MAP)) {
        const v = d[key];
        if (typeof v !== "number") continue;
        setConfigInputDefault(key, v);
        const el = g(elId);
        if (el) el.value = v;
      }
      for (const key of _STORE_ONLY_DEFAULT_KEYS) {
        const v = d[key];
        if (typeof v === "number") setConfigInputDefault(key, v);
      }
      /*- Keep the complement offset input in sync with the offsetToken0
       *  default so the row reads correctly on first paint. */
      if (typeof d.offsetToken0Pct === "number") {
        const el1 = g("inOffsetToken1");
        if (el1) el1.value = 100 - d.offsetToken0Pct;
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
    /*-
     *  If no per-position value is stored, leave botConfig.oorThreshold
     *  and the input/display blank until either (a) the user enters a
     *  value or (b) the server's /api/bot-config-defaults AJAX populates
     *  _CONFIG_INPUT_DEFAULTS, after which _syncConfigFromServer +
     *  populateConfigInputs fills the input from the default in force.
     *  No literal fallback per
     *  feedback_one_literal_per_shipped_default.
     */
    if (saved !== undefined) {
      botConfig.oorThreshold = saved;
      const el = g("inOorThreshold");
      if (el) el.value = saved;
      const disp = g("activeOorThreshold");
      if (disp) disp.textContent = saved;
    }
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
       *  paths) drains it once the wallet is ready.
       *
       *  Still no isPositionManaged gate HERE, and for the original
       *  reason: no /api/status response has necessarily landed this
       *  early, so the managed-tokenIds Set may be a localStorage
       *  carry-over from a previous session (the server may have
       *  retired the position while the page was closed).
       *
       *  The gate moved to the flush, where a poll has landed and the
       *  answer is authoritative.  It had to move: the claim that a
       *  fetch for a managed position is "a harmless no-op" stopped
       *  being true once every RPC request went through the paced
       *  global queue — it is a multi-minute chain scan racing the bot
       *  for that queue.  See `shouldSkipUnmanagedFetch` in
       *  dashboard-unmanaged.js. */
      fetchUnmanagedDetails(active);
    }
    refreshCurDepositDisplay();
  })();

  // ── Activity log ─────────────────────────────────────────────────────────────

  /*- The endpoint list, in the failover order the bot actually walks.
   *  Read-only — Add RPC has its own dialog.  The list is no longer
   *  mirrored into localStorage: the server holds it, and a browser
   *  copy could disagree with the endpoints the bot is really using. */
  initRpcEndpoints();

  act(ACT_ICONS.play, "start", "Dashboard Ready", "Import a wallet to begin");

  /*- First paint of the Manage button + badge + Lifetime panel.
   *  Runs once at boot so the user sees the correct state from frame
   *  one — "Select a position first" if no posStore entries,
   *  "Loading position state…" if active but /api/status hasn't
   *  landed yet, or "Unlock wallet to manage positions" if the
   *  wallet is locked.  Subsequent triggers (poll, activation,
   *  wallet-unlock) continue to call paintManageUI() through the
   *  same single owner. */
  paintManageUI();

  // Check if the server already has a wallet loaded (e.g. from a previous page load)
  const walletStatusChecked = checkServerWalletStatus();
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
        chain = activeChainId(),
        pk = a
          ? compositeKey(chain, a.walletAddress, a.contractAddress, a.tokenId)
          : undefined;
      fetchWithCsrf("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initialDepositUsd: dep, positionKey: pk }),
      }).catch(() => {});
    }
    // Restore Lifetime Days override label + re-sync to server
    refreshLifetimeDaysLabel();
    const ltStart = loadLifetimeStartDateOverride();
    if (ltStart) {
      const a = posStore.getActive(),
        chain = activeChainId(),
        pk = a
          ? compositeKey(chain, a.walletAddress, a.contractAddress, a.tokenId)
          : undefined;
      if (pk) {
        fetchWithCsrf("/api/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            lifetimeStartDateOverrideUtc: ltStart,
            positionKey: pk,
          }),
        }).catch(() => {});
      }
    }
  })();

  // ── Start intervals ─────────────────────────────────────────────────────────

  /*- Wire the deposit module's live-status callbacks before polling
   *  starts.  Previously a top-level side effect in dashboard-data.js,
   *  which tripped an ESM temporal-dead-zone error under direct-ESM
   *  tests of dashboard-data-deposit.  Runtime behaviour unchanged
   *  under the esbuild bundle. */
  initDataDepositWiring();

  updateThrottleUI();
  setInterval(updateThrottleUI, 1000);
  startDataPolling();
  /*-
   *  From here on, while the figures on screen may still be another
   *  position's, they show as dashes and nothing but the disclaimer and
   *  the wallet unlock can be used. See dashboard-stale-data.js.
   */
  startStaleDataWatch(uiSetting("staleDataCheckIntervalMs"));

  /*- Browser-side idle detection for the idle-driven price-lookup pause
   *  (component 4 of 4).  Posts /api/pause-price-lookups after 2-min
   *  blur or 15-min no-input; posts /api/unpause-price-lookups on the
   *  next throttled activity event.  See docs/architecture.md
   *  "Idle-Driven Price-Lookup Pause". */
  startBrowserIdleTracker();

  /*-
   *  Every `heapLogIntervalMs`, log the JS heap size.  The dashboard is
   *  designed to stay open indefinitely, so a steadily-rising `used` line
   *  across hours indicates a leak (event listeners, closures, cached
   *  arrays held in JS).  Chrome-only (`performance.memory` is
   *  non-standard); silent on other browsers.
   */
  if (performance && performance.memory) {
    const _logHeap = () => {
      const m = performance.memory;
      log.info(
        "[lp-ranger] [js heap] %s MB used / %s MB allocated",
        (m.usedJSHeapSize / 1048576).toFixed(1),
        (m.totalJSHeapSize / 1048576).toFixed(1),
      );
    };
    _logHeap();
    setInterval(_logHeap, uiSetting("heapLogIntervalMs"));
  }

  /*-
   *  Once the server has said whether it holds a wallet, scan that
   *  wallet, to fill in token symbols and fresh data from the LP cache.
   *  The scan reports itself only when no position is selected yet,
   *  which is when the operator is waiting on it. A wallet imported
   *  later is scanned by the import flow instead.
   */
  walletStatusChecked.then(() => {
    if (wallet.address) scanPositions({ silent: posStore.activeIdx >= 0 });
  });
} // end _afterDisclaimer
