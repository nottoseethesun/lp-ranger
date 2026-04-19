/**
 * @file dashboard-data.js
 * @description Polls /api/status, updates live UI elements. Re-exports.
 */
import {
  g,
  botConfig,
  act,
  ACT_ICONS,
  csrfNeedsRefresh,
  refreshCsrfToken,
} from "./dashboard-helpers.js";
import {
  posStore,
  updateManagedPositions,
  isPositionManaged,
} from "./dashboard-positions.js";
import {
  updateHistoryFromStatus,
  updateHistorySyncLabels,
} from "./dashboard-history.js";
import { wallet } from "./dashboard-wallet.js";
import { reapplyPrivacyBlur, updateManageBadge } from "./dashboard-events.js";
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
} from "./dashboard-data-deposit.js";
import {
  _fmtUsd,
  setKpiValue,
  resetKpis,
  _updateKpis,
  _updateLifetimeKpis,
  checkHodlBaselineDialog,
  setPoolFirstDate,
  getPoolFirstDate,
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
  _createModal,
  _posLabel,
  _posContextHtml,
  _titled,
  _fmtTxCopy,
  _updateComposition,
  _updatePositionTicks,
  _updatePosStatus,
  _setStatusPill,
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
let _dataTimerId = null,
  _lastStatus = null,
  _historyPopulated = false,
  _configSynced = false;
export function getLastStatus() {
  return _lastStatus;
}
import {
  markInputDirty,
  isInputDirty,
  clearDirtyInputs,
  cacheRebalanceEvents,
  loadCachedRebalanceEvents,
  flattenV2Status,
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
};

/* Per-position defaults applied when the key is missing from server data,
 * so the input resets on switch instead of bleeding through the prior
 * position's value.  Omit keys that always come back from the bot state. */
const _CONFIG_INPUT_DEFAULTS = { offsetToken0Pct: 50 };

/** Populate config form inputs from a position's server data. */
function _populateConfigInputs(d) {
  for (const [key, elId] of Object.entries(_CONFIG_INPUT_MAP)) {
    const val = d[key] ?? _CONFIG_INPUT_DEFAULTS[key];
    if (val !== undefined && val !== null && !isInputDirty(elId)) {
      const el = g(elId);
      if (el) el.value = val;
    }
  }
  // Keep the complement offset input in sync
  const offEl0 = g("inOffsetToken0");
  const offEl1 = g("inOffsetToken1");
  if (offEl0 && offEl1) {
    offEl1.value = 100 - (parseInt(offEl0.value, 10) || 50);
  }
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
  }
  const synced = badge?.classList.contains("done");
  const cls = "9mm-pos-mgr-syncing-blur";
  for (const id of ["kpiGrid", "rangeRow", "historyRow"])
    g(id)?.classList.toggle(cls, !synced);
}

/**
 * Derive sync readiness from poll data.  The lifetime P&L scan is the
 * same work for managed and unmanaged positions — it is NOT a bot-loop
 * concern.  Both paths write rebalanceScanComplete to the server state,
 * so the poll is the single source of truth.  No client-side flag needed.
 */
function _syncStatus(d) {
  if (!posStore.getActive()) return { complete: true, label: "" };
  if (wallet.address && posStore.count() === 0)
    return { complete: false, label: "" };
  const ps = d._positionScan;
  if (ps && ps.status === "scanning") {
    const p = ps.progress;
    const tip = p?.total > 0 ? p.done + "/" + p.total + " positions" : "";
    return { complete: false, label: "Syncing\u2026", tip };
  }
  if (!d.rebalanceScanComplete)
    return { complete: false, label: "Syncing\u2026" };
  return { complete: true, label: "Synced" };
}
function _updateSyncBadge(d) {
  const badge = g("syncBadge");
  if (!badge) return;
  const { complete: c, label, tip } = _syncStatus(d);
  if (c !== badge.classList.contains("done"))
    console.log(
      `[lp-ranger] [sync-badge] ${c ? "Synced" : "Syncing"} active=#${posStore.getActive()?.tokenId} rsc=${d.rebalanceScanComplete} pscan=${d._positionScan?.status}`,
    );
  badge.textContent = label || "Syncing\u2026";
  badge.title = tip || "";
  badge.style.background = "";
  badge.classList.toggle("done", c);
  const t = !c ? 'Wait until Syncing badge reads "Synced".' : "";
  for (const id of [
    "manageToggleBtn",
    "posBrowserBtn",
    "rebalanceWithRangeBtn",
  ]) {
    const b = g(id);
    if (b) {
      b.disabled = !c;
      b.title = t;
    }
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
  const btn = g("manageToggleBtn"),
    rb = g("rebalanceWithRangeBtn");
  _setBtn(btn, on || !_scanWasComplete, on ? _REB_HELP : "");
  _setBtn(rb, on, on ? _REB_HELP : _REB_MANUAL);
  updateMissionStatusBadge(d);
  updateGasStatusBadge(d);
  _updateCompoundButton(d, on);
}

export function resetHistoryFlag() {
  _historyPopulated = false;
  _configSynced = false;
}
export function resetPollingState() {
  _lastStatus = null;
  setPoolFirstDate(null);
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
function _syncActivePosition(d) {
  if (!d.activePosition) return;
  const active = posStore.getActive();
  if (!active || active.positionType !== "nft") return;
  const ap = d.activePosition;
  if (ap.liquidity !== undefined) active.liquidity = String(ap.liquidity);
  if (ap.tickLower !== undefined) {
    active.tickLower = ap.tickLower;
    active.tickUpper = ap.tickUpper;
  }
  if (ap.token0) {
    active.token0 = ap.token0;
    active.token1 = ap.token1;
    active.fee = ap.fee;
  }
  if (ap.tokenId) active.tokenId = String(ap.tokenId);
}
function _populateHistoryOnce(data) {
  if (_historyPopulated || !data.rebalanceEvents?.length) return;
  if (data.running && data.rebalanceScanComplete !== true) return;
  _historyPopulated = true;
  const ctx = _posLabel() ? "\n" + _posLabel() : "";
  const _s = [...data.rebalanceEvents].sort(
    (a, b) => a.timestamp - b.timestamp,
  );
  for (const ev of _s) {
    const tx = ev.txHash ? "<br>" + _fmtTxCopy(ev.txHash) : "";
    act(
      ACT_ICONS.gear,
      "fee",
      "Rebalance",
      "NFT #" + ev.oldTokenId + " \u2192 #" + ev.newTokenId + tx + ctx,
      ev.dateStr ? new Date(ev.dateStr) : new Date(ev.timestamp * 1000),
    );
  }
}
function _resolveManagedTid(a, mp, states) {
  const tid = String(a.tokenId);
  if (mp.some((p) => String(p.tokenId) === tid)) return tid;
  if (!a.token0) return tid;
  const t0 = a.token0.toLowerCase(),
    f = a.fee;
  const m = mp.find((p) => {
    const ap = states[p.key]?.activePosition;
    return ap && ap.token0?.toLowerCase() === t0 && ap.fee === f;
  });
  if (m && String(m.tokenId) !== tid) {
    posStore.updateActiveTokenId(m.tokenId);
    return m.tokenId;
  }
  return tid;
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
  botConfig.pmName = data.positionManagerName || botConfig.pmName || "";
  botConfig.chainName = data.chainDisplayName || botConfig.chainName || "";
  if (data.defaultSlippagePct > 0)
    botConfig.defaultSlip = data.defaultSlippagePct;
  if (data.compoundMinFeeUsd > 0)
    botConfig.compoundMinFee = data.compoundMinFeeUsd;
  if (data.compoundDefaultThresholdUsd > 0)
    botConfig.compoundDefaultThreshold = data.compoundDefaultThresholdUsd;
  if (data.scanTimeoutMs > 0) botConfig.scanTimeoutMs = data.scanTimeoutMs;
}
const _LC = "color:#7df;background:#112;padding:1px 4px;border-radius:2px";
const _LW = "color:#ff0;background:#620;padding:1px 4px;border-radius:2px";
const _LO = "color:#0f0;background:#012;padding:1px 4px;border-radius:2px";
function _applyManagedUpdates(data, managed) {
  if (!managed) return;
  _syncActivePosition(data);
  _updatePositionTicks(data);
  _updateComposition(data);
  checkHodlBaselineDialog(data);
}

function updateDashboardFromStatus(data) {
  _lastStatus = data;
  const _tid = posStore.getActive()?.tokenId;
  console.debug(
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
  _syncConfigFromServer(data);
  _syncAutoCompound(data);
  _syncRebCache(data);
  _updateSyncBadge(data);
  _updateSwapSourcesBadge(data);
  _updateRebalanceButtons(data);
  if (!getPoolFirstDate() && data.poolFirstMintDate)
    setPoolFirstDate(data.poolFirstMintDate);
  updateHistorySyncLabels(data);
  _populateHistoryOnce(data);
  updateHistoryFromStatus(data);
  _updatePriceMarker(data);
  if (isViewingClosedPos()) return;
  const _a2 = posStore.getActive();
  const _managed = _a2 && isPositionManaged(_a2.tokenId);
  if (!_managed && !data._hasPositionData) {
    console.debug("%c[lp-ranger] [skip] #%s no data yet", _LW, _a2?.tokenId);
    return;
  }
  console.debug(
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
let _pollFailCount = 0;
function _onPollFail() {
  _pollFailCount++;
  if (_pollFailCount >= 3)
    _setStatusPill("status-pill danger", "dot red", "HALTED");
}
async function _pollStatus() {
  if (csrfNeedsRefresh()) refreshCsrfToken();
  try {
    const res = await fetch("/api/status");
    if (!res.ok) {
      _onPollFail();
      return;
    }
    _pollFailCount = 0;
    updateDashboardFromStatus(flattenV2Status(await res.json()));
  } catch (_) {
    _onPollFail();
  }
}
export function pollNow() {
  _pollStatus();
}
/** Start polling /api/status at 3s intervals. */
export function startDataPolling() {
  if (_dataTimerId) return;
  _pollStatus();
  _dataTimerId = setInterval(_pollStatus, 3000);
}
export function stopDataPolling() {
  if (_dataTimerId) {
    clearInterval(_dataTimerId);
    _dataTimerId = null;
  }
}
