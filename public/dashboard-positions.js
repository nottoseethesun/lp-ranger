/**
 * @file dashboard-positions.js
 * @description Position browser UI, scanning,
 *   routing, and activation for the 9mm v3
 *   Position Manager dashboard.
 *
 * Depends on: dashboard-helpers.js, dashboard-wallet.js,
 *             dashboard-positions-store.js.
 */

import { log } from "./dashboard-log.js";
import {
  g,
  act,
  ACT_ICONS,
  botConfig,
  emojiId,
  fetchWithCsrf,
} from "./dashboard-helpers.js";
import { applySyncBlur } from "./dashboard-data.js";
import { _posLabel } from "./dashboard-data-status.js";
import { setLeadingText as _setLeadingText } from "./dashboard-kpi-dom.js";
import { LT_BD_IDS } from "./dashboard-data-kpi-breakdown.js";
import { wallet } from "./dashboard-wallet.js";
import {
  posStore,
  _applyLocalPositionData,
  _applyPositionConfig,
  _setText,
  updatePosStripUI,
  isPositionManaged,
  isPositionClosed,
  bestAutoSelectIdx,
  setSyncRouteToState,
  setExitClosedPosView,
  setFetchUnmanagedDetails,
} from "./dashboard-positions-store.js";
import {
  readLastPosition,
  rememberLastPosition,
} from "./dashboard-chain-storage.js";
import {
  closePosBrowser,
  renderPosBrowser,
  getPosBrowserSelected,
} from "./dashboard-positions-browser.js";
import { paintManageUI, manageKey } from "./dashboard-manage-ui.js";
import { checkManagedOnSwitch } from "./dashboard-manage-check.js";
import { forgetThrottleState } from "./dashboard-throttle.js";
import { emptyPositionInputs } from "./dashboard-config-inputs.js";
import { closePositionDialogs } from "./dashboard-position-dialogs.js";
import { paintStatTokenLogos } from "./dashboard-token-logos.js";
import { forgetILDebugData } from "./dashboard-il-debug.js";

// ── Late-bound deps ──────────────────────────────

let _positionRangeVisual = null;
let _updateRouteForPosition = null;
let _syncRouteToState = null;
let _enterClosedPosView = null;
let _exitClosedPosView = null;
let _isViewingClosedPos = null;
let _refreshDepositLabel = null;
let _refreshLifetimeDaysLabel = null;
let _fetchUnmanagedDetails = null;
let _clearHistory = null;
let _resetHistoryFlag = null;
let _pollNow = null;
let _resetCurrentKpis = null;

/**
 * Inject data-module references after all modules
 * are loaded. Called once from dashboard-init.js.
 * @param {object} deps
 */
export function injectPositionDeps(deps) {
  _positionRangeVisual = deps.positionRangeVisual;
  if (deps.updateRouteForPosition)
    _updateRouteForPosition = deps.updateRouteForPosition;
  if (deps.syncRouteToState) {
    _syncRouteToState = deps.syncRouteToState;
    setSyncRouteToState(deps.syncRouteToState);
  }
  if (deps.enterClosedPosView) _enterClosedPosView = deps.enterClosedPosView;
  if (deps.exitClosedPosView) {
    _exitClosedPosView = deps.exitClosedPosView;
    setExitClosedPosView(deps.exitClosedPosView);
  }
  if (deps.isViewingClosedPos) _isViewingClosedPos = deps.isViewingClosedPos;
  if (deps.refreshDepositLabel) _refreshDepositLabel = deps.refreshDepositLabel;
  if (deps.refreshLifetimeDaysLabel)
    _refreshLifetimeDaysLabel = deps.refreshLifetimeDaysLabel;
  if (deps.clearHistory) _clearHistory = deps.clearHistory;
  if (deps.resetHistoryFlag) _resetHistoryFlag = deps.resetHistoryFlag;
  if (deps.pollNow) _pollNow = deps.pollNow;
  if (deps.resetCurrentKpis) _resetCurrentKpis = deps.resetCurrentKpis;
  if (deps.fetchUnmanagedDetails) {
    _fetchUnmanagedDetails = deps.fetchUnmanagedDetails;
    setFetchUnmanagedDetails(deps.fetchUnmanagedDetails);
  }
}

// ── Toggle helpers ───────────────────────────────

export function toggleShowClosed() {
  const el = g("posClosedToggle");
  if (el) el.checked = !el.checked;
  renderPosBrowser();
}
export function toggleOpenInNewTab() {
  const el = g("posNewTabToggle");
  if (el) el.checked = !el.checked;
}
export function isOpenInNewTab() {
  const el = g("posNewTabToggle");
  return el ? el.checked : false;
}

// ── Position browser modal ───────────────────────

/** Open the position browser modal. */
// Position browser functions are in dashboard-positions-browser.js.

// ── Activation ───────────────────────────────────

/** Exit any active closed-position view. */
function _exitClosedViewIfActive() {
  if (_isViewingClosedPos && _isViewingClosedPos() && _exitClosedPosView)
    _exitClosedPosView();
}

/**
 * Close the dialogs of the position on screen when another comes on
 * screen, the IL/G popover among them, whose figures go too. A dialog
 * open for the position on screen would save to, or tell of, the one
 * coming on screen instead. They close while the old position is still
 * on screen, so what a dialog records as it closes is recorded for its
 * own. Choosing the same position again leaves them open, and keeps the
 * popover's figures, which an unmanaged position's details, not asked
 * for again, would not bring back.
 * @param {number} idx  Position store index of the position coming on screen.
 */
function _closeDialogsOfPositionLeaving(idx) {
  if (manageKey(posStore.entries?.[idx]) === manageKey(posStore.getActive()))
    return;
  closePositionDialogs();
  forgetILDebugData();
}

/**
 * Core position activation — shared by all switch paths.
 * @param {number} idx  Position store index.
 * @param {object} [opts]
 * @param {boolean} [opts.updateRoute=true]  Push URL.
 * @param {boolean} [opts.syncRoute=false]  Replace URL (auto flows).
 * @returns {object|null}  Active position, or null.
 */
function _updateRoute(active, updateRoute, syncRoute) {
  if (updateRoute && _updateRouteForPosition) _updateRouteForPosition(active);
  else if (syncRoute && _syncRouteToState) _syncRouteToState(active);
}
function _activateCore(idx, opts) {
  const { updateRoute = true, syncRoute = false } = opts || {};
  const _entryTid = posStore.entries?.[idx]?.tokenId;
  log.info(
    "%c[lp-ranger] [activate] idx=%d tokenId=%s managed=%s",
    "color:#0ff;background:#013;padding:1px 4px;border-radius:2px",
    idx,
    _entryTid,
    isPositionManaged(_entryTid),
  );
  _closeDialogsOfPositionLeaving(idx);
  _exitClosedViewIfActive();
  if (_clearHistory) _clearHistory();
  if (_resetHistoryFlag) _resetHistoryFlag();
  emptyPositionInputs();
  if (_resetCurrentKpis) _resetCurrentKpis();
  applySyncBlur(true);
  posStore.select(idx);
  /*-
   *  The throttle badge, countdown and banner show only what the server
   *  reported for the position on screen, so the previous one's go now;
   *  the new one's arrive with the status answer the switch asks for.
   */
  forgetThrottleState();
  updatePosStripUI();
  const active = posStore.getActive();
  if (!active) return null;
  _applyLocalPositionData(active);
  if (_refreshDepositLabel) _refreshDepositLabel();
  if (_refreshLifetimeDaysLabel) _refreshLifetimeDaysLabel();
  _applyPositionConfig(active);
  if (_positionRangeVisual) _positionRangeVisual();
  /*-
   *  Repaint the Manage button + badge + Lifetime panel for the new
   *  active position.  paintManageUI() is the single owner — it reads
   *  posStore.getActive() + getLastStatus() + DOM, so we don't need
   *  to thread state through here.  Runs BEFORE the closed-position
   *  early-return below so closed switches also repaint (the historic
   *  bug).  The server is asked first whether the new position is
   *  managed, which marks the question as sent, so this paint draws the
   *  button disabled until the answer repaints it.
   */
  checkManagedOnSwitch(active);
  paintManageUI();
  if (isPositionClosed(active) && _enterClosedPosView) {
    _enterClosedPosView(active);
    _updateRoute(active, updateRoute, syncRoute);
    return active;
  }
  _updateRoute(active, updateRoute, syncRoute);
  try {
    rememberLastPosition(active.tokenId);
  } catch {
    /* */
  }
  _fetchUnmanagedIfNeeded(active);
  if (_pollNow) _pollNow();
  return active;
}

/** Make the highlighted position active and close the browser. */
export function activateSelectedPos() {
  const sel = getPosBrowserSelected();
  if (sel < 0) return;
  const active = _activateCore(sel);
  if (active && !isPositionClosed(active)) {
    const oor = botConfig.oorThreshold || "\u2014";
    const pl = _posLabel();
    act(
      ACT_ICONS.target,
      "fee",
      "View Different LP Position",
      "(OOR threshold: " + oor + "%)" + (pl ? "\n" + pl : ""),
    );
  } else if (active) {
    const pl = _posLabel();
    act(
      ACT_ICONS.grid,
      "fee",
      "View Closed Position",
      "NFT #" + active.tokenId + (pl ? "\n" + pl : ""),
    );
  }
  closePosBrowser();
}

// ── Routing ──────────────────────────────────────

/**
 * Activate a position by its NFT token ID (deep links).
 * @param {string} tokenId  NFT token ID.
 * @returns {boolean}  True if found and activated.
 */
export function activateByTokenId(tokenId) {
  const idx = posStore.entries.findIndex(
    (e) => e.positionType === "nft" && String(e.tokenId) === String(tokenId),
  );
  if (idx < 0) return false;
  _activateCore(idx);
  return true;
}

/** Fetch unmanaged details if position is not managed. */
function _fetchUnmanagedIfNeeded(active) {
  const isMgd = isPositionManaged(active.tokenId);
  const hasTok0 = !!active.token0;
  const hasCb = !!_fetchUnmanagedDetails;
  if (!isMgd && hasTok0 && hasCb) {
    log.info(
      "%c[lp-ranger] [fetch-unmgd-if] #%s → calling fetchUnmanagedDetails",
      "color:#0f0;background:#031;padding:1px 4px;border-radius:2px",
      active.tokenId,
    );
    _fetchUnmanagedDetails(active);
  } else {
    log.info(
      "%c[lp-ranger] [fetch-unmgd-if] #%s SKIPPED managed=%s hasToken0=%s hasCallback=%s",
      "color:#fa0;background:#310;padding:1px 4px;border-radius:2px",
      active.tokenId,
      isMgd,
      hasTok0,
      hasCb,
    );
  }
}

/** Restore last-viewed position from localStorage, preferring open positions. */
export function restoreLastPosition() {
  try {
    const t = readLastPosition();
    if (t) {
      const idx = posStore.entries.findIndex(
        (e) => e.positionType === "nft" && String(e.tokenId) === String(t),
      );
      if (idx >= 0 && !isPositionClosed(posStore.entries[idx]))
        return activateByTokenId(t);
      // Last-viewed position is closed — prefer youngest open position
      const best = bestAutoSelectIdx();
      if (best >= 0) {
        _activateCore(best);
        return true;
      }
    }
  } catch {
    /* */
  }
  return false;
}

// ── Display cleanup ──────────────────────────────

/** Reset all KPI card elements to empty. */
function _clearKpiElements() {
  for (const id of [
    "kpiPnl",
    "kpiNet",
    "curIL",
    "netIL",
    "curProfit",
    "ltProfit",
  ]) {
    const el = g(id);
    if (el) {
      _setLeadingText(el, "\u2014");
      el.className = "kpi-value 9mm-pos-mgr-kpi-pct-row neu";
    }
  }
  for (const id of ["kpiPnlPct", ...LT_BD_IDS, "kpiPosDuration", "pnlRealized"])
    _setText(id, "\u2014");
  for (const id of [
    "kpiPnlPctVal",
    "kpiPnlApr",
    "kpiNetPct",
    "kpiNetApr",
    "curILPct",
    "netILPct",
    "netILApr",
  ]) {
    const el = g(id);
    if (el) el.textContent = "";
  }
}

/** Reset ALL position-related UI to defaults. */
export function clearPositionDisplay() {
  _setText("sTL", "\u2014");
  _setText("sTU", "\u2014");
  _setText("sTC", "\u2014");
  _setText("statT0Name", "\u2014");
  _setText("statT1Name", "\u2014");
  paintStatTokenLogos(null);
  _setText("statShare0Label", "Pool Share \u2014");
  _setText("statShare1Label", "Pool Share \u2014");
  _setText("sShare0", "\u2014");
  _setText("sShare1", "\u2014");
  _setText("sWpls", "\u2014");
  _setText("sUsdc", "\u2014");
  _setText("sResidual0", "\u2014");
  _setText("sResidual1", "\u2014");
  _setText("cl0", "\u25A0 \u2014: 50%");
  _setText("cl1", "\u25A0 \u2014: 50%");
  const c0 = g("c0"),
    c1 = g("c1");
  if (c0) c0.style.width = "50%";
  if (c1) c1.style.width = "50%";
  _setText("wsPool", "\u2014");
  const statusEl = g("curPosStatus");
  if (statusEl) {
    statusEl.textContent = "\u2014";
    statusEl.className = "9mm-pos-mgr-pos-status";
  }
  botConfig.lower = 0;
  botConfig.upper = 0;
  botConfig.tL = 0;
  botConfig.tU = 0;
  _clearKpiElements();
  updatePosStripUI();
  const actList = g("actList");
  if (actList) actList.replaceChildren();
}

// ── No-positions dialog ──────────────────────────

function _showNoPositionsDialog() {
  const modal = g("noPositionsModal");
  if (!modal) return;
  modal.className = "modal-overlay";
  const dismiss = () => {
    modal.className = "modal-overlay hidden";
  };
  const ok = g("noPositionsOk");
  const close = g("noPositionsClose");
  if (ok) ok.onclick = dismiss;
  if (close) close.onclick = dismiss;
}

// ── Scanning ─────────────────────────────────────

/** Ask the server to scan the wallet, and add what it finds to the store. */
async function _fetchAndApplyScan() {
  /*- No rpcUrl in the body.  The server scans with its own configured
   *  provider and always ignored this field, so sending it only made it
   *  look as though the browser chose the endpoint for the scan. The
   *  saved RPC URL does now reach the server — via bot-config.json, at
   *  startup — which is what actually makes the setting effective. */
  const res = await fetchWithCsrf("/api/positions/scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error);
  const added = _addScannedPositions(data);
  const nftCount = (data.nftPositions || []).length;
  log.info(
    "%c[lp-ranger] [scan] %d NFTs returned, %d added, posStore: count=%d activeIdx=%d",
    "color:#0cf",
    nftCount,
    added,
    posStore.count(),
    posStore.activeIdx,
  );
  if (posStore.activeIdx < 0 && posStore.count() > 0) {
    const bestIdx = bestAutoSelectIdx();
    posStore.select(bestIdx >= 0 ? bestIdx : 0);
    const first = posStore.getActive();
    log.info(
      "%c[lp-ranger] [scan] auto-selected #%s %s (idx=%d)",
      "color:#0cf",
      first?.tokenId,
      first ? emojiId(first.tokenId) : "",
      bestIdx,
    );
    if (first) {
      _applyLocalPositionData(first);
      _applyPositionConfig(first);
      _fetchUnmanagedIfNeeded(first);
    }
  } else if (posStore.activeIdx >= 0) {
    const cur = posStore.getActive();
    log.info(
      "%c[lp-ranger] [scan] already selected #%s %s (idx=%d) — skipping",
      "color:#0cf",
      cur?.tokenId,
      cur ? emojiId(cur.tokenId) : "",
      posStore.activeIdx,
    );
  }
  updatePosStripUI();
  if (data.cached) _backgroundRefresh();
  return { data, added, nftCount };
}
/**
 * Scan the current wallet for LP positions via the server API.
 *
 * A silent scan reports nothing in the Activity Log and leaves the Scan
 * Wallet button alone; the scans the dashboard starts by itself use it.
 *
 * @param {object} [opts]  Options.
 * @param {boolean} [opts.silent=false]  Scan without a word to the user.
 * @returns {Promise<{ok: boolean, added?: number, nftCount?: number, error?: string}>}
 *   `ok:true` means the scan reached the server, returned a valid
 *   response, and `_addScannedPositions` ran.  `ok:false` covers any
 *   failure path; `dashboard-data-events.js` advances its rebalance
 *   tracker only on `ok:true`, so a transient failure (network, CSRF,
 *   rpc) is retried on its next poll rather than lost.
 */
export async function scanPositions(opts) {
  const silent = opts?.silent === true;
  if (!wallet.address) {
    if (!silent)
      act(
        ACT_ICONS.warn,
        "alert",
        "No Wallet Loaded",
        "Import a wallet first to scan for positions",
      );
    return { ok: false, error: "no wallet" };
  }
  const btn = g("posScanBtn");
  if (btn && !silent) {
    btn.disabled = true;
    btn.textContent = "\u27F3 Scanning\u2026";
    btn.title = "Scan in progress\u2026";
  }
  try {
    const { data, added, nftCount } = await _fetchAndApplyScan();
    if (!silent) {
      act(
        ACT_ICONS.scan,
        "start",
        data.cached ? "Loaded from Cache" : "Scan Complete",
        `Found ${nftCount} NFT positions. Added ${added} new.`,
      );
      if (nftCount === 0) _showNoPositionsDialog();
    }
    return { ok: true, added, nftCount };
  } catch (e) {
    log.error("[lp-ranger] Position scan failed:", e.message);
    if (!silent) act(ACT_ICONS.warn, "alert", "Scan Failed", e.message);
    return { ok: false, error: e.message };
  } finally {
    if (btn && !silent) {
      btn.disabled = false;
      btn.textContent = "\u27F3 Scan Wallet";
      btn.title = "";
    }
    renderPosBrowser();
    if (_pollNow) _pollNow();
  }
}

/** Add scanned positions from API response. */
function _addScannedPositions(data) {
  let added = 0;
  for (const pos of data.nftPositions || []) {
    if (!pos.fee || pos.fee <= 0) continue;
    const result = posStore.add({
      walletAddress: wallet.address,
      positionType: "nft",
      contractAddress: data.positionManagerAddress || null,
      tokenId: pos.tokenId,
      token0: pos.token0,
      token1: pos.token1,
      token0Symbol: pos.token0Symbol || null,
      token1Symbol: pos.token1Symbol || null,
      fee: pos.fee,
      tickLower: pos.tickLower,
      tickUpper: pos.tickUpper,
      liquidity: pos.liquidity,
      poolTick: pos.poolTick,
      scanInRange:
        pos.poolTick !== null && pos.poolTick !== undefined
          ? pos.poolTick >= pos.tickLower && pos.poolTick < pos.tickUpper
          : null,
    });
    if (result.ok) added++;
  }
  for (const pos of data.erc20Positions || []) {
    const result = posStore.add({
      walletAddress: wallet.address,
      positionType: "erc20",
      contractAddress: pos.contractAddress,
      balance: pos.balance,
      token0: pos.token0,
      token1: pos.token1,
      token0Symbol: pos.token0Symbol || null,
      token1Symbol: pos.token1Symbol || null,
      fee: pos.fee,
      tickLower: pos.tickLower,
      tickUpper: pos.tickUpper,
    });
    if (result.ok) added++;
  }
  return added;
}

/** Background refresh of mutable data after cache hit. */
async function _backgroundRefresh() {
  try {
    const res = await fetchWithCsrf("/api/positions/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const d = await res.json();
    if (!d.ok) return;
    for (let i = 0; i < posStore.count(); i++) {
      const p = posStore.entries[i];
      if (!p) continue;
      /*- Explicit `!== undefined && !== null` per the "Type Checks" rule
       *  in CLAUDE-BEST-PRACTICES.md — a bare `!== undefined` would let a
       *  server-sent null through and corrupt downstream isPositionClosed
       *  comparisons via `String(null)` = `"null"`. */
      const liq = d.liquidities[String(p.tokenId)];
      if (liq !== undefined && liq !== null) p.liquidity = liq;
      const tick = d.poolTicks[p.token0 + "-" + p.token1 + "-" + p.fee];
      if (tick !== undefined && tick !== null) p.poolTick = tick;
    }
    renderPosBrowser();
    /*- Refresh the "N Open Positions" badge — background refresh may have
     *  flipped a position between open and closed (liquidity=0), which the
     *  browser render alone won't reflect in the header strip. */
    updatePosStripUI();
  } catch (e) {
    log.warn("[lp-ranger] [dashboard] Background refresh failed:", e.message);
  }
}
