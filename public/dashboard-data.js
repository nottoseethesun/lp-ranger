/**
 * @file dashboard-data.js
 * @description Polls /api/status, updates live UI elements. Re-exports.
 */
import { log } from "./dashboard-log.js";
import { g, botConfig } from "./dashboard-helpers.js";
import {
  posStore,
  updateManagedPositions,
  isPositionManaged,
  isPositionClosed,
} from "./dashboard-positions.js";
import { syncActivePosition } from "./dashboard-active-sync.js";
import {
  syncRangeWidth,
  syncFullRangeCheckbox,
} from "./dashboard-data-range-width.js";
import {
  updateHistoryFromStatus,
  updateHistorySyncLabels,
} from "./dashboard-history.js";
import { wallet } from "./dashboard-wallet.js";
import { reapplyPrivacyBlur } from "./dashboard-events.js";
import { updateManageBadge } from "./dashboard-events-manage.js";
import { paintManageUI } from "./dashboard-manage-ui.js";
import {
  isViewingClosedPos,
  refetchClosedPosHistory,
} from "./dashboard-closed-pos.js";
import { updateILDebugData } from "./dashboard-il-debug.js";
import {
  injectDataDeps,
  _wireDepositKpis,
  loadRealizedGains,
  loadInitialDeposit,
  refreshDepositLabel,
  refreshCurDepositDisplay,
  loadCurRealized,
  toggleRealizedInput,
  saveRealizedGains,
  toggleCurRealized,
  saveCurRealized,
  toggleInitialDeposit,
  saveInitialDeposit,
  toggleCurDeposit,
  saveCurDeposit,
  _poolKey,
  loadCurDeposit,
  toggleLifetimeDays,
  saveLifetimeDays,
  refreshLifetimeDaysLabel,
  loadLifetimeStartDateOverride,
  loadLifetimeDaysDisplay,
} from "./dashboard-data-deposit.js";
import {
  _fmtUsd,
  setKpiValue,
  resetKpis,
  _updateKpis,
  _updateLifetimeKpis,
  checkHodlBaselineDialog,
  positionRangeVisual,
  updateRangePctLabels,
} from "./dashboard-data-kpi.js";
import { updateTriggerDisplay } from "./dashboard-throttle.js";
import { resetSoundTrackers } from "./dashboard-sounds.js";
import {
  setOptimisticSpecialAction,
  updateMissionStatusBadge,
} from "./dashboard-mission-badge.js";
import { updateGasStatusBadge } from "./dashboard-gas-badge.js";
import { AGGREGATOR_LABEL } from "./dashboard-routing-labels.js";
export { setOptimisticSpecialAction };
import {
  logAllPositionEvents,
  resetEventLogTrackers,
} from "./dashboard-data-events.js";
import {
  populateRebalanceHistoryOnce,
  populateCompoundHistoryOnce,
  resetPopulateHistoryFlags,
} from "./dashboard-populate-history.js";
import {
  _createModal,
  _posLabel,
  _posContextHtml,
  _titled,
  _updateComposition,
  _updatePositionTicks,
  _updatePosStatus,
  _updatePriceMarker,
  _updateBotStatus,
  _updateThrottleKpis,
  _syncAutoCompound,
  _updateCompoundButton,
} from "./dashboard-data-status.js";
export {
  injectDataDeps,
  loadRealizedGains,
  toggleRealizedInput,
  saveRealizedGains,
  loadCurRealized,
  toggleCurRealized,
  saveCurRealized,
  loadInitialDeposit,
  refreshDepositLabel,
  loadCurDeposit,
  refreshCurDepositDisplay,
  toggleCurDeposit,
  saveCurDeposit,
  toggleInitialDeposit,
  saveInitialDeposit,
  toggleLifetimeDays,
  saveLifetimeDays,
  refreshLifetimeDaysLabel,
  loadLifetimeStartDateOverride,
  loadLifetimeDaysDisplay,
  _fmtUsd,
  setKpiValue,
  resetKpis,
  checkHodlBaselineDialog,
  positionRangeVisual,
  updateRangePctLabels,
  _createModal,
  _posLabel,
  _posContextHtml,
  _titled,
};
let _lastStatus = null,
  _configSynced = false;
/*- Single source of truth for "is the dashboard's view of the active
 *  position fully synced?".  Set by `_updateSyncBadge` from the same
 *  `_syncStatus(d)` compute that drives the badge text/class — so
 *  render and logic share one value, never re-read the DOM to
 *  recover state.  See [[feedback-no-classlist-for-state]] for the
 *  rationale.  null = not yet computed (no poll has landed). */
let _lastSyncComplete = null;
export function getLastStatus() {
  return _lastStatus;
}
/**
 * Whether the dashboard's view of the currently-active position is
 * fully synced (i.e. the sync badge would read "Synced").  Use this
 * everywhere you would otherwise be tempted to read
 * `syncBadge.classList.contains("done")`.  Returns null until the
 * first poll lands.
 */
export function isSyncComplete() {
  return _lastSyncComplete;
}
import {
  markInputDirty,
  isInputDirty,
  clearDirtyInputs,
  cacheRebalanceEvents,
  loadCachedRebalanceEvents,
} from "./dashboard-data-cache.js";
export { markInputDirty };

_wireDepositKpis(
  () => _lastStatus,
  (s) => _updateKpis(s),
);
function _syncRebCache(d) {
  const e = d.rebalanceEvents;
  if (!e || !e.length) {
    const c = loadCachedRebalanceEvents();
    if (c?.length > 0) d.rebalanceEvents = c;
  } else cacheRebalanceEvents(e);
}
/* Map of server config key → form input id. */
const _CONFIG_INPUT_MAP = {
  slippagePct: "inSlip",
  checkIntervalSec: "inInterval",
  minRebalanceIntervalMin: "inMinInterval",
  maxRebalancesPerDay: "inMaxReb",
  gasStrategy: "inGas",
  rebalanceTimeoutMin: "inOorTimeout",
  rebalanceOutOfRangeThresholdPercent: "inOorThreshold",
  autoCompoundThresholdUsd: "autoCompoundThreshold",
  offsetToken0Pct: "inOffsetToken0",
  approvalMultiple: "inApprovalMultiple",
};

/* Map of GLOBAL server config key → form input id.  These keys live in
 * `_diskConfig.global` (spread into `/api/status` response), so they
 * sync regardless of which position is active.  Synced exactly once
 * per page load (`_globalSynced`) — subsequent in-page edits are
 * preserved by the dirty-input gate. */
const _GLOBAL_CONFIG_INPUT_MAP = {
  gasFeePct: "inGasFeePct",
};

/* Per-position defaults applied when the key is missing from server
 * data, so the input resets on switch instead of bleeding through the
 * prior position's value.  Starts empty — populated at init by
 * `setConfigInputDefault()` once the `/api/bot-config-defaults` fetch
 * resolves (the server reads the shipped JSON merged with any
 * operator override).  No literal defaults live here: per
 * feedback_one_literal_per_shipped_default, every shipped default
 * value lives in
 * `app-config/app-defaults-for-user-configurable/bot-config-defaults.json`
 * and nowhere else in code.  Until the AJAX call resolves, missing
 * keys leave their input untouched (existing behaviour: inputs that
 * have neither a per-position value nor a default skip rendering). */
const _CONFIG_INPUT_DEFAULTS = {};

/** Update a default value for a config input (called from init once the
 *  server tunables have been fetched). */
export function setConfigInputDefault(key, val) {
  if (val !== undefined && val !== null) _CONFIG_INPUT_DEFAULTS[key] = val;
}

/** Read a single Bot-Setting default sourced from the shipped JSON
 *  via `/api/bot-config-defaults` (populated by `setConfigInputDefault`).
 *  Returns `undefined` if the AJAX fetch hasn't resolved yet OR the
 *  key isn't a known default.  Consumers MUST handle the undefined
 *  case — no literal fallback is allowed per
 *  feedback_one_literal_per_shipped_default. */
export function getInputDefault(key) {
  return _CONFIG_INPUT_DEFAULTS[key];
}

/** Populate config form inputs from a position's server data. */
function _populateConfigInputs(d) {
  for (const [key, elId] of Object.entries(_CONFIG_INPUT_MAP)) {
    const val = d[key] ?? _CONFIG_INPUT_DEFAULTS[key];
    if (val !== undefined && val !== null && !isInputDirty(elId)) {
      const el = g(elId);
      if (el) el.value = val;
    }
  }
  /*- Keep the complement offset input in sync.  Skip when the
   *  primary input is empty (pre-AJAX init or after Clear Local
   *  Storage) — no literal fallback per
   *  feedback_one_literal_per_shipped_default; the next poll cycle
   *  re-populates once `_CONFIG_INPUT_DEFAULTS.offsetToken0Pct`
   *  arrives. */
  const offEl0 = g("inOffsetToken0");
  const offEl1 = g("inOffsetToken1");
  if (offEl0 && offEl1) {
    const n = parseInt(offEl0.value, 10);
    if (Number.isFinite(n)) offEl1.value = 100 - n;
  }
}

let _globalSynced = false;

/** Populate global-key inputs (e.g. Settings popover Gas Fee %) from
 *  /api/status global block.  Runs once per page load, only after a
 *  real value lands (skips the initial poll where global may be empty). */
function _syncGlobalConfig(d) {
  if (_globalSynced) return;
  let any = false;
  for (const [key, elId] of Object.entries(_GLOBAL_CONFIG_INPUT_MAP)) {
    const val = d[key];
    if (val === undefined || val === null) continue;
    any = true;
    if (isInputDirty(elId)) continue;
    const el = g(elId);
    if (el) el.value = val;
  }
  if (any) _globalSynced = true;
}

function _syncConfigFromServer(d) {
  // Skip until position-specific data is available (wallet may be locked,
  // so flattenV2Status can't match a position key). Re-syncs on switch.
  if (!d._hasPositionData) return;
  const posKey = posStore.getActive()?.tokenId;
  if (!posKey || _configSynced === posKey) return;
  _configSynced = posKey;
  _populateConfigInputs(d);
  _syncAutoCompound(d);
  const dpk = _poolKey("9mm_deposit_pool_");
  if (dpk && d.initialDepositUsd > 0 && !loadInitialDeposit())
    try {
      localStorage.setItem(dpk, String(d.initialDepositUsd));
    } catch {
      /* */
    }
  refreshDepositLabel();
}
let _scanWasComplete = false;

/** Apply or remove blur — mirrors the sync badge state.
 *  @param {boolean} [force] Reset badge to Syncing and force blur on. */
export function applySyncBlur(force) {
  const badge = g("syncBadge");
  if (force && badge) {
    badge.textContent = "Syncing\u2026";
    badge.classList.remove("done");
    /*- Mirror the badge reset into the state variable so any reader
     *  (computeManageUI, click guards, this very function on a re-
     *  entrant call) sees the same answer.  Per
     *  [[feedback-no-classlist-for-state]] the state variable is the
     *  source of truth; the badge class is a projection. */
    _lastSyncComplete = false;
  }
  const synced = _lastSyncComplete === true;
  const cls = "9mm-pos-mgr-syncing-blur";
  for (const id of ["kpiGrid", "rangeRow", "historyRow"])
    g(id)?.classList.toggle(cls, !synced);
}

/**
 * Derive sync readiness from poll data.  The lifetime P&L scan is the
 * same work for managed and unmanaged-open positions — it is NOT a
 * bot-loop concern.  Both paths write rebalanceScanComplete to the
 * server state, so the poll is the single source of truth for those.
 *
 * Exception: unmanaged-closed positions.  Their detail fetch short-
 * circuits in phase 1 (drained detected → closed view, phase 2 skipped)
 * so the server never writes rebalanceScanComplete for them.  Treat the
 * closed view itself as the synced signal: once isViewingClosedPos()
 * returns true, the one-shot closed-pos history fetch has landed and
 * there is nothing else to sync.
 */
function _syncStatus(d) {
  const active = posStore.getActive();
  if (!active) return { complete: true, label: "" };
  if (wallet.address && posStore.count() === 0)
    return { complete: false, label: "" };
  if (!isPositionManaged(active.tokenId) && isViewingClosedPos())
    return { complete: true, label: "Synced" };
  const ps = d._positionScan;
  if (ps && ps.status === "scanning") {
    const p = ps.progress;
    const tip = p?.total > 0 ? p.done + "/" + p.total + " positions" : "";
    return { complete: false, label: "Syncing\u2026", tip };
  }
  /*- `lifetimeScanComplete` gates only when the active position is
   *  managed.  Unmanaged positions don't render a Lifetime panel (the
   *  placeholder takes its place), so the flag is structurally
   *  irrelevant on their state \u2014 checking it would leave their badge
   *  stuck on "Syncing\u2026" forever.  See server-routes._syncLifetimeState
   *  for the matching server-side decision. */
  const managed = isPositionManaged(active.tokenId);
  if (!d.rebalanceScanComplete || (managed && !d.lifetimeScanComplete))
    return { complete: false, label: "Syncing\u2026" };
  return { complete: true, label: "Synced" };
}
function _updateSyncBadge(d) {
  const badge = g("syncBadge");
  if (!badge) return;
  const { complete: c, label, tip } = _syncStatus(d);
  /*- Compare against the previous JS-state value, not the rendered
   *  badge class \u2014 per [[feedback-no-classlist-for-state]] the DOM is
   *  a one-way projection and must never feed back into logic.  Also
   *  serves as the transition-log gate so we log only when the value
   *  actually changes. */
  if (c !== _lastSyncComplete)
    log.info(
      `[lp-ranger] [sync-badge] ${c ? "Synced" : "Syncing"} active=#${posStore.getActive()?.tokenId} rsc=${d.rebalanceScanComplete} lsc=${d.lifetimeScanComplete} pscan=${d._positionScan?.status}`,
    );
  _lastSyncComplete = c;
  badge.textContent = label || "Syncing\u2026";
  badge.title = tip || "";
  badge.style.background = "";
  badge.classList.toggle("done", c);
  /*- LP Browser stays enabled even during sync: it only opens a modal
   *  over posStore.entries (localStorage-backed, zero on-chain calls),
   *  and "Select" flows through _activateCore which is the canonical
   *  safe switch path.  Critically, this lets the user open the browser
   *  and Remove a position that is stuck retrying a force-rebalance the
   *  gas guard keeps deferring — the only graceful halt path for that
   *  scenario short of a server restart.
   *
   *  Manage button's sync gate moved to dashboard-manage-ui.js's
   *  computeManageUI() — paintManageUI() runs every poll and reads
   *  syncBadge.done as one of its inputs, so this loop no longer needs
   *  to write #manageToggleBtn directly.  Rebalance button (custom
   *  range) is still handled here because its decision tree is
   *  simpler and lives nowhere else. */
  const t = !c ? 'Wait until Syncing badge reads "Synced".' : "";
  const rb = g("rebalanceWithRangeBtn");
  if (rb) {
    rb.disabled = !c;
    rb.title = t;
  }
  if (c && !_scanWasComplete && isViewingClosedPos()) refetchClosedPosHistory();
  _scanWasComplete = c;
  applySyncBlur();
}

/** Update "Routing through: ..." badge. Always reverts to the default
 *  "9mm Aggregator" between rebalances — the badge is a live indicator,
 *  not a historical summary. Per-rebalance route detail lives in the
 *  Rebalance Events table. */
function _updateSwapSourcesBadge(d) {
  const badge = g("swapSourcesBadge");
  if (!badge) return;
  const sources = d.swapSources || AGGREGATOR_LABEL;
  badge.textContent = "Routing through: " + sources;
}

import {
  BUILD_COMMIT,
  BUILD_COMMIT_DATE,
  BUILD_RELEASE_TAG,
  BUILD_PACKAGE_VERSION,
} from "./build-info.js";

/** Populate About dialog from build-time constants (one-shot on load). */
function _populateAboutInfo() {
  const commitKnown =
    BUILD_COMMIT && BUILD_COMMIT !== "unknown" && BUILD_COMMIT !== "—";
  /*- Version row is a FALLBACK shown only when commit info is missing
   *  (production tarballs built without .git available). In a normal
   *  dev/release build the commit hash uniquely identifies the running
   *  code, so showing "Version: X.Y.Z" above it would be redundant and
   *  change the long-established dev-mode About layout. */
  if (
    !commitKnown &&
    BUILD_PACKAGE_VERSION &&
    BUILD_PACKAGE_VERSION !== "unknown"
  ) {
    const row = g("aboutVersionRow");
    if (row) {
      row.textContent = "Version: " + BUILD_PACKAGE_VERSION;
      row.classList.remove("9mm-pos-mgr-hidden");
    }
  }
  if (BUILD_RELEASE_TAG) {
    const row = g("aboutReleaseRow");
    if (row) {
      row.textContent = "Release: " + BUILD_RELEASE_TAG;
      row.classList.remove("9mm-pos-mgr-hidden");
    }
  }
  if (commitKnown) {
    const commitRow = g("aboutCommitRow");
    if (commitRow) commitRow.classList.remove("9mm-pos-mgr-hidden");
    const c = g("aboutCommit");
    if (c) c.textContent = BUILD_COMMIT;
    const dt = g("aboutCommitDate");
    if (dt && BUILD_COMMIT_DATE !== "unknown")
      dt.textContent = new Date(BUILD_COMMIT_DATE).toLocaleDateString();
  }
  const row = g("aboutUpdateRow");
  if (row) {
    row.dataset.commitDate = BUILD_COMMIT_DATE;
    row.dataset.packageVersion = BUILD_PACKAGE_VERSION || "";
  }
}
_populateAboutInfo();

const _REB_HELP =
  "LP Ranger is currently submitting transactions to rebalance this LP Position.";
const _REB_MANUAL =
  "Manually force a rebalance. Automatic rebalancing stays in effect.";
function _setBtn(el, disabled, title) {
  if (!el) return;
  el.disabled = disabled;
  el.title = title;
}
function _updateRebalanceButtons(d) {
  const on = !!d.rebalanceInProgress;
  const rb = g("rebalanceWithRangeBtn");
  /*- Rebalance-with-range button decision tree.  Manage button is
   *  no longer touched here — it's owned entirely by paintManageUI()
   *  in dashboard-manage-ui.js (called once per poll from
   *  updateDashboardFromStatus).  Each branch below sets ONLY rb. */
  const active = posStore.getActive();
  if (!active) {
    _setBtn(rb, true, "Select a position first");
  } else if (isPositionClosed(active)) {
    _setBtn(
      rb,
      true,
      'Cannot Rebalance a closed position — click "Manage" to re-open.',
    );
  } else if (on) {
    _setBtn(rb, true, _REB_HELP);
  } else {
    _setBtn(rb, false, _REB_MANUAL);
  }
  updateMissionStatusBadge(d);
  updateGasStatusBadge(d);
  _updateCompoundButton(d, on);
}

export function resetHistoryFlag() {
  resetPopulateHistoryFlags();
  _configSynced = false;
  _globalSynced = false;
}
export function resetPollingState() {
  _lastStatus = null;
  resetHistoryFlag();
  resetEventLogTrackers();
  resetSoundTrackers();
  _scanWasComplete = false;
  refreshCurDepositDisplay(0);
  const dd = g("lifetimeDepositDisplay");
  if (dd) dd.textContent = "\u2014";
  const dl = g("initialDepositLabel");
  if (dl) dl.textContent = "Edit Initial Deposit";
}
function _resolveManagedTid(a, mp, states) {
  const tid = String(a.tokenId);
  if (mp.some((p) => String(p.tokenId) === tid)) return tid;
  /*-
   * Rebalance-follow.  Migrate only when a rebalance event links the
   * active tokenId (drained) to a currently-managed new tokenId.  The
   * event is the single source of truth — no same-pool heuristic and
   * no multi-hop walk (the view converges 1-hop per poll).  This is
   * also robust when two managed positions share a pool.
   */
  for (const p of mp) {
    const events = states[p.key]?.rebalanceEvents || [];
    const hit = events.some(
      (e) =>
        String(e.oldTokenId) === tid &&
        String(e.newTokenId) === String(p.tokenId),
    );
    if (hit) {
      posStore.updateActiveTokenId(p.tokenId);
      return p.tokenId;
    }
  }
  return tid;
}
/*- Mirror the OOR threshold into botConfig so range-visual + display
 *  code can read a single source.  Prefer the per-position server
 *  value when present (data.rebalanceOutOfRangeThresholdPercent);
 *  otherwise fall back to the shipped default populated by the
 *  /api/bot-config-defaults AJAX into _CONFIG_INPUT_DEFAULTS.  No
 *  literal fallback per feedback_one_literal_per_shipped_default —
 *  remains undefined until either source resolves. */
function _syncOorThreshold(data) {
  const perPos = data.rebalanceOutOfRangeThresholdPercent;
  if (typeof perPos === "number" && perPos > 0) {
    botConfig.oorThreshold = perPos;
    return;
  }
  if (botConfig.oorThreshold !== undefined) return;
  const def = _CONFIG_INPUT_DEFAULTS.rebalanceOutOfRangeThresholdPercent;
  if (typeof def === "number" && def > 0) botConfig.oorThreshold = def;
}

function _syncManagedAndGlobals(data) {
  if (data._managedPositions) {
    updateManagedPositions(data._managedPositions, data._allPositionStates);
    const a = posStore.getActive();
    if (a)
      updateManageBadge(
        data._managedPositions,
        _resolveManagedTid(a, data._managedPositions, data._allPositionStates),
        data.rebalanceInProgress,
      );
  }
  const _a = posStore.getActive();
  if (!_a || isPositionManaged(_a.tokenId)) updateILDebugData(data, posStore);
  if (data.withinThreshold !== undefined)
    botConfig.withinThreshold = data.withinThreshold;
  botConfig.oorSince = data.oorSince || null;
  botConfig.residualCleanupInProgress = !!data.residualCleanupInProgress;
  botConfig.pmName = data.positionManagerName || botConfig.pmName || "";
  botConfig.chainName = data.chainDisplayName || botConfig.chainName || "";
  if (data.defaultSlippagePct > 0)
    botConfig.defaultSlip = data.defaultSlippagePct;
  if (data.compoundMinFeeUsd > 0)
    botConfig.compoundMinFee = data.compoundMinFeeUsd;
  if (data.compoundDefaultThresholdUsd > 0)
    botConfig.compoundDefaultThreshold = data.compoundDefaultThresholdUsd;
  if (data.scanTimeoutMs > 0) botConfig.scanTimeoutMs = data.scanTimeoutMs;
  _syncOorThreshold(data);
  /*- Per-poll so it retries on the "Manage on unmanaged position"
   *  flow.  Both self-throttle internally against dirty inputs and
   *  the last-seen posKey — cadence rationale in
   *  `dashboard-data-range-width.js`'s file header. */
  syncRangeWidth(data);
  syncFullRangeCheckbox(data);
}
const _LC = "color:#7df;background:#112;padding:1px 4px;border-radius:2px";
const _LW = "color:#ff0;background:#620;padding:1px 4px;border-radius:2px";
const _LO = "color:#0f0;background:#012;padding:1px 4px;border-radius:2px";
function _applyManagedUpdates(data, managed) {
  if (!managed) return;
  syncActivePosition(data);
  _updatePositionTicks(data);
  _updateComposition(data);
  checkHodlBaselineDialog(data);
}

function updateDashboardFromStatus(data) {
  _lastStatus = data;
  /*- Single Manage-UI paint per poll.  Runs BEFORE any branch that
   *  may early-return (e.g. cross-wallet skip below), so the button
   *  always reflects current server state every 3 s regardless of
   *  whether the rest of the dashboard updates this cycle.  Reads
   *  state via injected getLastStatus + posStore from
   *  dashboard-manage-ui.js — no need to thread `data` through. */
  paintManageUI();
  const _tid = posStore.getActive()?.tokenId;
  log.debug(
    "%c[lp-ranger] [poll] #%s hasPosData=%s stats=%s pool=%s",
    _LC,
    _tid,
    data._hasPositionData,
    !!data.positionStats,
    !!data.poolState,
  );
  _syncManagedAndGlobals(data);
  logAllPositionEvents(data);
  _updateBotStatus(data);
  _updateThrottleKpis(data);
  updateTriggerDisplay(data);
  const sw = data.walletAddress || data.wallet || "";
  if (
    sw &&
    (!wallet.address || wallet.address.toLowerCase() !== sw.toLowerCase())
  )
    return;
  _syncGlobalConfig(data);
  _syncConfigFromServer(data);
  _syncAutoCompound(data);
  _syncRebCache(data);
  _updateSyncBadge(data);
  _updateSwapSourcesBadge(data);
  _updateRebalanceButtons(data);
  updateHistorySyncLabels(data);
  const _pl = _posLabel();
  populateRebalanceHistoryOnce(data, _pl);
  populateCompoundHistoryOnce(data, _pl, posStore.getActive()?.tokenId);
  updateHistoryFromStatus(data);
  _updatePriceMarker(data);
  if (isViewingClosedPos()) return;
  const _a2 = posStore.getActive();
  const _managed = _a2 && isPositionManaged(_a2.tokenId);
  if (!_managed && !data._hasPositionData) {
    log.debug("%c[lp-ranger] [skip] #%s no data yet", _LW, _a2?.tokenId);
    return;
  }
  log.debug(
    "%c[lp-ranger] [update] #%s managed=%s comp=%s",
    _LO,
    _a2?.tokenId,
    _managed,
    data.positionStats?.compositionRatio,
  );
  _updateLifetimeKpis(data);
  _updatePosStatus(data, _scanWasComplete);
  _updateKpis(data);
  _applyManagedUpdates(data, _managed);
  reapplyPrivacyBlur();
  clearDirtyInputs();
}
import {
  initDataPoll,
  pollNow,
  startDataPolling,
  stopDataPolling,
} from "./dashboard-data-poll.js";
initDataPoll(updateDashboardFromStatus);
export { pollNow, startDataPolling, stopDataPolling };
