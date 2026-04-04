/**
 * @file dashboard-positions.js
 * @description Position browser UI, scanning,
 *   routing, and activation for the 9mm v3
 *   Position Manager dashboard. Re-exports the
 *   position store from dashboard-positions-store.
 *
 * Depends on: dashboard-helpers.js, dashboard-wallet.js,
 *             dashboard-positions-store.js.
 *
 * NOTE: Import of positionRangeVisual from data.js
 * creates a circular reference (data imports posStore
 * from here). This is safe because positionRangeVisual
 * is only called inside function bodies, not at module
 * evaluation time.
 */

import { g, act, ACT_ICONS, botConfig } from "./dashboard-helpers.js";
import { _posLabel } from "./dashboard-data.js";
import { wallet, getRpcUrl } from "./dashboard-wallet.js";
import {
  posStore,
  MAX_POS,
  PAGE_SIZE,
  _loadPosStore,
  _applyLocalPositionData,
  _applyPositionConfig,
  _setText,
  _setHtml,
  updatePosStripUI,
  updateManagedPositions,
  isPositionManaged,
  isPositionClosed,
  formatPosLabel,
  refreshManageBadge,
  renderPosRow,
  restoreManagedPositions,
  setSyncRouteToState,
  setFetchUnmanagedDetails,
} from "./dashboard-positions-store.js";

// ── Re-exports from store ────────────────────────
// All external importers continue to import from
// this module — these re-exports keep them working.
export {
  posStore,
  MAX_POS,
  PAGE_SIZE,
  _loadPosStore,
  _applyLocalPositionData,
  _applyPositionConfig,
  updatePosStripUI,
  updateManagedPositions,
  restoreManagedPositions,
  isPositionManaged,
  formatPosLabel,
};

// ── Late-bound deps ──────────────────────────────

let _positionRangeVisual = null;
let _updateRouteForPosition = null;
let _syncRouteToState = null;
let _enterClosedPosView = null;
let _exitClosedPosView = null;
let _isViewingClosedPos = null;
let _refreshDepositLabel = null;
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
  if (deps.exitClosedPosView) _exitClosedPosView = deps.exitClosedPosView;
  if (deps.isViewingClosedPos) _isViewingClosedPos = deps.isViewingClosedPos;
  if (deps.refreshDepositLabel) _refreshDepositLabel = deps.refreshDepositLabel;
  if (deps.clearHistory) _clearHistory = deps.clearHistory;
  if (deps.resetHistoryFlag) _resetHistoryFlag = deps.resetHistoryFlag;
  if (deps.pollNow) _pollNow = deps.pollNow;
  if (deps.resetCurrentKpis) _resetCurrentKpis = deps.resetCurrentKpis;
  if (deps.fetchUnmanagedDetails) {
    _fetchUnmanagedDetails = deps.fetchUnmanagedDetails;
    setFetchUnmanagedDetails(deps.fetchUnmanagedDetails);
  }
}

// ── Browser state ────────────────────────────────

let posBrowserPage = 0;
let posBrowserSelected = -1;

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
export function openPosBrowser() {
  posBrowserPage = 0;
  posBrowserSelected = -1;
  g("posBrowserModal").className = "modal-overlay";
  renderPosBrowser();
}

/** Close the position browser modal. */
export function closePosBrowser() {
  g("posBrowserModal").className = "modal-overlay hidden";
}

/** Render the paginated, filterable position list. */
export function renderPosBrowser() {
  const filter = (g("posSearchInput").value || "").toLowerCase();
  let all = posStore.entries;
  if (g("posManagedOnlyToggle")?.checked)
    all = all.filter((e) => isPositionManaged(e.tokenId));
  if (!g("posClosedToggle")?.checked)
    all = all.filter((e) => !isPositionClosed(e));
  const unsorted = filter
    ? all.filter((e) => {
        const hay = [
          e.token0,
          e.token1,
          e.tokenId,
          e.contractAddress,
          e.walletAddress,
          e.positionType,
        ]
          .join(" ")
          .toLowerCase();
        return hay.includes(filter);
      })
    : all;
  const filtered = [...unsorted].sort((a, b) => {
    const idA = Number(a.tokenId || 0),
      idB = Number(b.tokenId || 0);
    return idB - idA;
  });

  // Stats bar
  const nftCount = filtered.filter((e) => e.positionType === "nft").length;
  const inRangeCount = filtered.filter((e) => {
    const lp = Math.pow(1.0001, e.tickLower || 0);
    const up = Math.pow(1.0001, e.tickUpper || 0);
    return botConfig.price >= lp && botConfig.price <= up;
  }).length;
  g("posTotalCount").textContent = filtered.length;
  g("posNftCount").textContent = nftCount;
  g("posInRangeCount").textContent = inRangeCount;
  const capWarn = g("posCapWarn");
  if (capWarn)
    capWarn.textContent = posStore.isFull()
      ? "\u26A0 Store full (300/300)"
      : "";

  // Paginate
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const page = Math.min(posBrowserPage, totalPages - 1);
  posBrowserPage = page;
  const pageItems = filtered.slice(
    page * PAGE_SIZE,
    page * PAGE_SIZE + PAGE_SIZE,
  );

  // Render list
  const list = g("posList");
  if (!filtered.length) {
    list.innerHTML =
      '<div class="pos-empty">' +
      '<div class="pos-empty-icon">\u25CB</div>' +
      "<div>" +
      (all.length
        ? "No positions match your filter."
        : "No positions loaded. Import a wallet or click Scan.") +
      "</div></div>";
  } else {
    list.innerHTML = pageItems
      .map((e) => renderPosRow(e, posBrowserSelected))
      .join("");
    if (localStorage.getItem("9mm_privacy_mode") === "1")
      list
        .querySelectorAll(".pos-row-title, .pos-row-meta")
        .forEach((el) => el.classList.add("9mm-pos-mgr-privacy-blur"));
  }

  // Pagination controls
  g("posPageLabel").textContent = "Page " + (page + 1) + " of " + totalPages;
  g("posPrevBtn").disabled = page <= 0;
  g("posNextBtn").disabled = page >= totalPages - 1;

  // Action buttons
  g("posSelectBtn").disabled = posBrowserSelected < 0;
  g("posRemoveBtn").disabled = posBrowserSelected < 0;
}

/** Toggle row selection. */
export function posRowClick(idx) {
  posBrowserSelected = posBrowserSelected === idx ? -1 : idx;
  renderPosBrowser();
}

/** Navigate to next/previous page. */
export function posChangePage(dir) {
  posBrowserPage += dir;
  renderPosBrowser();
}

// ── Activation ───────────────────────────────────

/** Exit any active closed-position view. */
function _exitClosedViewIfActive() {
  if (_isViewingClosedPos && _isViewingClosedPos() && _exitClosedPosView)
    _exitClosedPosView();
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
  _exitClosedViewIfActive();
  if (_clearHistory) _clearHistory();
  if (_resetHistoryFlag) _resetHistoryFlag();
  if (_resetCurrentKpis) _resetCurrentKpis();
  posStore.select(idx);
  updatePosStripUI();
  const active = posStore.getActive();
  if (!active) return null;
  _applyLocalPositionData(active);
  if (_refreshDepositLabel) _refreshDepositLabel();
  if (isPositionClosed(active) && _enterClosedPosView) {
    _enterClosedPosView(active);
    _updateRoute(active, updateRoute, syncRoute);
    return active;
  }
  _applyPositionConfig(active);
  if (_positionRangeVisual) _positionRangeVisual();
  _updateRoute(active, updateRoute, syncRoute);
  try {
    localStorage.setItem("9mm_last_position", String(active.tokenId));
  } catch {
    /* */
  }
  refreshManageBadge(active);
  _fetchUnmanagedIfNeeded(active);
  if (_pollNow) _pollNow();
  return active;
}

/** Make the highlighted position active and close the browser. */
export function activateSelectedPos() {
  if (posBrowserSelected < 0) return;
  const active = _activateCore(posBrowserSelected);
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

/** Remove the highlighted position from store. */
export function removeSelectedPos() {
  if (posBrowserSelected < 0) return;
  const entry = posStore.entries[posBrowserSelected];
  if (!entry) return;
  posStore.remove(posBrowserSelected);
  posBrowserSelected = -1;
  updatePosStripUI();
  act(
    ACT_ICONS.cross,
    "alert",
    "Position Removed",
    formatPosLabel(entry) + " removed from store",
  );
  renderPosBrowser();
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
  if (
    !isPositionManaged(active.tokenId) &&
    active.token0 &&
    _fetchUnmanagedDetails
  )
    _fetchUnmanagedDetails(active);
}

/** Restore last-viewed position from localStorage. */
export function restoreLastPosition() {
  try {
    const t = localStorage.getItem("9mm_last_position");
    if (t) return activateByTokenId(t);
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
      el.textContent = "\u2014";
      el.className = "kpi-value 9mm-pos-mgr-kpi-pct-row neu";
    }
  }
  for (const id of [
    "kpiPnlPct",
    "kpiNetBreakdown",
    "kpiPosDuration",
    "pnlRealized",
  ])
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
  _setHtml("statT0Label", "\u2014");
  _setHtml("statT1Label", "\u2014");
  _setText("statShare0Label", "Pool Share \u2014");
  _setText("statShare1Label", "Pool Share \u2014");
  _setText("sShare0", "\u2014");
  _setText("sShare1", "\u2014");
  _setText("sWpls", "\u2014");
  _setText("sUsdc", "\u2014");
  _setText("cl0", "\u25A0 \u2014: 50%");
  _setText("cl1", "\u25A0 \u2014: 50%");
  const c0 = g("c0"),
    c1 = g("c1");
  if (c0) c0.style.width = "50%";
  if (c1) c1.style.width = "50%";
  _setText("wsPool", "\u2014");
  _setText("kpiDeposit", "\u2014");
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
  if (actList) actList.innerHTML = "";
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

/** Select bot's active position after manual scan. */
async function _syncAfterManualScan() {
  try {
    const st = await (await fetch("/api/status")).json();
    const tid = st.activePosition?.tokenId;
    if (!tid) return;
    const i = posStore.entries.findIndex(
      (e) => e.positionType === "nft" && String(e.tokenId) === String(tid),
    );
    if (i >= 0 && i !== posStore.activeIdx)
      _activateCore(i, {
        updateRoute: false,
        syncRoute: true,
      });
  } catch {
    /* next poll will sync */
  }
}

/**
 * Scan the current wallet for LP positions via the server API.
 * @param {object} [opts]  Options.
 * @param {boolean} [opts.navigate=true]  After scan, select bot's
 *   active position. Pass false for automatic scans.
 */
async function _fetchAndApplyScan() {
  const res = await fetch("/api/positions/scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rpcUrl: getRpcUrl() }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error);
  const added = _addScannedPositions(data);
  const nftCount = (data.nftPositions || []).length;
  if (posStore.activeIdx < 0 && posStore.count() > 0) {
    posStore.select(0);
    const first = posStore.getActive();
    if (first) {
      _applyLocalPositionData(first);
      _applyPositionConfig(first);
    }
  }
  updatePosStripUI();
  if (data.cached) _backgroundRefresh();
  return { data, added, nftCount };
}
export async function scanPositions(opts) {
  const silent = opts?.silent || false;
  if (!wallet.address) {
    if (!silent)
      act(
        ACT_ICONS.warn,
        "alert",
        "No Wallet Loaded",
        "Import a wallet first to scan for positions",
      );
    return;
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
      if (!opts || opts.navigate !== false) await _syncAfterManualScan();
    }
  } catch (e) {
    console.error("Position scan failed:", e.message);
    if (!silent) act(ACT_ICONS.warn, "alert", "Scan Failed", e.message);
  } finally {
    if (btn && !silent) {
      btn.disabled = false;
      btn.textContent = "\u27F3 Scan Wallet";
      btn.title = "";
    }
    renderPosBrowser();
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
    const res = await fetch("/api/positions/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const d = await res.json();
    if (!d.ok) return;
    for (let i = 0; i < posStore.count(); i++) {
      const p = posStore.get(i);
      if (!p) continue;
      const liq = d.liquidities[String(p.tokenId)];
      if (liq !== undefined) p.liquidity = liq;
      const tick = d.poolTicks[p.token0 + "-" + p.token1 + "-" + p.fee];
      if (tick !== undefined) p.poolTick = tick;
    }
    renderPosBrowser();
  } catch (e) {
    console.warn("[dashboard] Background refresh failed:", e.message);
  }
}
