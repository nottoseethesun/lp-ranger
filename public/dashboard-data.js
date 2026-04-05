/**
 * @file dashboard-data.js
 * @description Polls /api/status, updates live UI elements. Re-exports.
 */
import {
  g,
  botConfig,
  compositeKey,
  act,
  ACT_ICONS,
} from "./dashboard-helpers.js";
import {
  posStore,
  updateManagedPositions,
  isPositionManaged,
  scanPositions,
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
import {
  _createModal,
  _posLabel,
  _posContextHtml,
  _titled,
  _logCtx,
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
const _lastRebAt = new Map(),
  _txCancelSeen = new Set();
_wireDepositKpis(
  () => _lastStatus,
  (s) => _updateKpis(s),
);
function _syncRebCache(d) {
  const e = d.rebalanceEvents;
  if (!e || !e.length) {
    const c = _loadCachedRebalanceEvents();
    if (c?.length > 0) d.rebalanceEvents = c;
  } else _cacheRebalanceEvents(e);
}
function _syncConfigFromServer(d) {
  // Skip until position-specific data is available (wallet may be locked,
  // so _flattenV2Status can't match a position key). Re-syncs on switch.
  if (!d._hasPositionData) return;
  const posKey = posStore.getActive()?.tokenId;
  if (!posKey || _configSynced === posKey) return;
  _configSynced = posKey;
  const map = {
    slippagePct: "inSlip",
    checkIntervalSec: "inInterval",
    minRebalanceIntervalMin: "inMinInterval",
    maxRebalancesPerDay: "inMaxReb",
    gasStrategy: "inGas",
    rebalanceTimeoutMin: "inOorTimeout",
    rebalanceOutOfRangeThresholdPercent: "inOorThreshold",
    autoCompoundThresholdUsd: "autoCompoundThreshold",
  };
  for (const [key, elId] of Object.entries(map)) {
    if (d[key] !== undefined && d[key] !== null) {
      const el = g(elId);
      if (el) el.value = d[key];
    }
  }
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
const _REB_CACHE_KEY = "9mm_rebalance_events_cache";
function _rebPosKey() {
  const a = posStore.getActive();
  return a?.walletAddress && a?.contractAddress
    ? compositeKey("pulsechain", a.walletAddress, a.contractAddress, a.tokenId)
    : null;
}
function _cacheRebalanceEvents(events) {
  const pk = _rebPosKey();
  if (!pk) return;
  try {
    const r = localStorage.getItem(_REB_CACHE_KEY);
    const c = r ? JSON.parse(r) : {};
    c[pk] = events;
    localStorage.setItem(_REB_CACHE_KEY, JSON.stringify(c));
  } catch {
    /* */
  }
}
function _loadCachedRebalanceEvents() {
  const pk = _rebPosKey();
  if (!pk) return null;
  try {
    const r = localStorage.getItem(_REB_CACHE_KEY);
    const e = r ? JSON.parse(r)[pk] : null;
    return Array.isArray(e) ? e : null;
  } catch {
    return null;
  }
}
let _scanWasComplete = false,
  _unmanagedSyncing = false;
export function setUnmanagedSyncing(v) {
  _unmanagedSyncing = v;
}
function _syncStatus(d) {
  if (wallet.address && posStore.count() === 0)
    return { complete: false, label: "" };
  const ps = d._positionScan;
  if (ps && ps.status === "scanning") {
    const p = ps.progress;
    return {
      complete: false,
      label: "Syncing\u2026",
      tip: p?.total > 0 ? p.done + "/" + p.total + " positions" : "",
    };
  }
  if (d.running && d.rebalanceScanComplete !== true)
    return { complete: false, label: "Syncing\u2026" };
  return { complete: true, label: "Synced" };
}
function _updateSyncBadge(d) {
  const badge = g("syncBadge");
  if (!badge || _unmanagedSyncing) return;
  const { complete: c, label, tip } = _syncStatus(d);
  badge.textContent = label || "Syncing\u2026";
  badge.title = tip || "";
  badge.style.background = "";
  badge.classList.toggle("done", c);
  const t = !c ? 'Wait until Syncing badge reads "Synced".' : "";
  ["manageToggleBtn", "posBrowserBtn", "rebalanceWithRangeBtn"].forEach(
    (id) => {
      const b = g(id);
      if (b) {
        b.disabled = !c;
        b.title = t;
      }
    },
  );
  if (c && !_scanWasComplete && isViewingClosedPos()) refetchClosedPosHistory();
  _scanWasComplete = c;
}

const _REB_HELP =
  "LP Ranger is currently submitting transactions to rebalance this LP Position.";
function _updateRebalanceButtons(d) {
  const on = !!d.rebalanceInProgress;
  const btn = g("manageToggleBtn"),
    rb = g("rebalanceWithRangeBtn"),
    h = g("rebalanceInProgressHelp");
  if (on) {
    if (btn) {
      btn.disabled = true;
      btn.title = _REB_HELP;
    }
    if (rb) {
      rb.disabled = true;
      rb.title = _REB_HELP;
    }
    if (h) {
      h.textContent = _REB_HELP;
      h.classList.remove("hidden");
    }
  } else {
    if (btn && _scanWasComplete) {
      btn.disabled = false;
      btn.title = "";
    }
    if (rb) {
      rb.disabled = false;
      rb.title =
        "Manually force a rebalance. Automatic rebalancing stays in effect.";
    }
    if (h) {
      h.textContent = "";
      h.classList.add("hidden");
    }
  }
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
  _lastRebAt.clear();
  _txCancelSeen.clear();
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
function _logAllPositionEvents(data) {
  for (const [key, st] of Object.entries(data._allPositionStates || {})) {
    const ctx = _logCtx(key, st);
    if (st.lastRebalanceAt && st.lastRebalanceAt !== _lastRebAt.get(key)) {
      _lastRebAt.set(key, st.lastRebalanceAt);
      const evts = st.rebalanceEvents || [];
      const ev = evts.length ? evts[evts.length - 1] : null;
      if (ev) {
        const tx = ev.txHash ? "<br>" + _fmtTxCopy(ev.txHash) : "";
        act(
          ACT_ICONS.gear,
          "fee",
          "Rebalance",
          "NFT #" + ev.oldTokenId + " \u2192 #" + ev.newTokenId + tx + ctx,
        );
      }
      scanPositions({ silent: true }).catch(() => {});
    }
    const tc = st.txCancelled;
    if (tc && !_txCancelSeen.has(key + tc.at)) {
      _txCancelSeen.add(key + tc.at);
      act(
        ACT_ICONS.warn,
        "alert",
        "TX Auto-Cancelled",
        tc.message +
          (tc.cancelTxHash
            ? " (TX: " + tc.cancelTxHash.slice(0, 10) + "\u2026)"
            : "") +
          ctx,
      );
    }
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
}
function updateDashboardFromStatus(data) {
  _lastStatus = data;
  _syncManagedAndGlobals(data);
  _logAllPositionEvents(data);
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
  _updateRebalanceButtons(data);
  if (!getPoolFirstDate() && data.poolFirstMintDate)
    setPoolFirstDate(data.poolFirstMintDate);
  updateHistorySyncLabels(data);
  _populateHistoryOnce(data);
  updateHistoryFromStatus(data);
  _updatePriceMarker(data);
  if (isViewingClosedPos()) return;
  const _a2 = posStore.getActive();
  if (_a2 && !isPositionManaged(_a2.tokenId)) return;
  _updateLifetimeKpis(data);
  _syncActivePosition(data);
  _updatePosStatus(data, _scanWasComplete);
  _updateKpis(data);
  _updatePositionTicks(data);
  _updateComposition(data);
  checkHodlBaselineDialog(data);
  reapplyPrivacyBlur();
}
let _pollFailCount = 0;
function _onPollFail() {
  _pollFailCount++;
  if (_pollFailCount >= 3)
    _setStatusPill("status-pill danger", "dot red", "HALTED");
}
function _flattenV2Status(v2) {
  const global = v2.global || {},
    positions = v2.positions || {};
  const active = posStore.getActive();
  const myKey = active
    ? compositeKey(
        "pulsechain",
        global.walletAddress,
        active.contractAddress,
        active.tokenId,
      )
    : null;
  let posData = myKey ? positions[myKey] : null;
  if (
    !posData &&
    active?.token0 &&
    active?.contractAddress &&
    global.walletAddress
  ) {
    const pfx =
      "pulsechain-" + global.walletAddress + "-" + active.contractAddress + "-";
    const at0 = active.token0.toLowerCase();
    const mk = Object.keys(positions).find((k) => {
      if (!k.startsWith(pfx) || k === myKey) return false;
      const ap = positions[k]?.activePosition;
      return ap && ap.fee === active.fee && ap.token0?.toLowerCase() === at0;
    });
    if (mk) {
      posData = positions[mk];
      const nid = mk.split("-").pop();
      if (nid !== active.tokenId) posStore.updateActiveTokenId(nid);
    }
  }
  return {
    ...global,
    ...(posData || {}),
    _hasPositionData: !!posData,
    _managedPositions: global.managedPositions || [],
    _allPositionStates: positions,
    _poolDailyCounts: global.poolDailyCounts || {},
    _positionScan: global.positionScan || null,
  };
}
async function _pollStatus() {
  try {
    const res = await fetch("/api/status");
    if (!res.ok) {
      _onPollFail();
      return;
    }
    _pollFailCount = 0;
    updateDashboardFromStatus(_flattenV2Status(await res.json()));
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
  if (!_dataTimerId) return;
  clearInterval(_dataTimerId);
  _dataTimerId = null;
}
