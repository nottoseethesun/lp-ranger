/**
 * @file dashboard-positions-store.js
 * @description In-browser position store with
 *   localStorage persistence, position rendering,
 *   strip UI, and management state. Manages up to
 *   300 LP positions with pagination, deduplication,
 *   and active-position selection.
 *
 * Split from dashboard-positions.js — data layer,
 * display helpers, and position rendering.
 *
 * Depends on: dashboard-helpers.js.
 */

import {
  g,
  botConfig,
  loadPositionOorThreshold,
  emojiId,
} from "./dashboard-helpers.js";

// ── Constants ────────────────────────────────────

/** Maximum positions the store can hold. */
export const MAX_POS = 300;

/** Positions shown per browser page. */
export const PAGE_SIZE = 20;

// ── Persistence ──────────────────────────────────

const _POS_STORE_KEY = "9mm_position_store";

/** Save posStore to localStorage. */
function _persistPosStore() {
  try {
    const data = {
      entries: posStore.entries,
      activeIdx: posStore.activeIdx,
    };
    localStorage.setItem(_POS_STORE_KEY, JSON.stringify(data));
  } catch {
    /* private mode or quota exceeded */
  }
}

/** Load posStore from localStorage, deduplicating. */
export function _loadPosStore() {
  try {
    const raw = localStorage.getItem(_POS_STORE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (Array.isArray(data.entries)) {
      const seen = new Set(),
        deduped = [];
      for (const e of data.entries) {
        const key =
          (e.walletAddress || "").toLowerCase() +
          "|" +
          e.positionType +
          "|" +
          (e.positionType === "nft"
            ? String(e.tokenId)
            : e.contractAddress || "");
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push({ ...e, index: deduped.length });
      }
      posStore.entries = deduped;
      let idx = typeof data.activeIdx === "number" ? data.activeIdx : -1;
      if (idx < 0 || idx >= deduped.length) idx = bestAutoSelectIdx();
      else if (isPositionClosed(deduped[idx])) idx = bestAutoSelectIdx();
      posStore.activeIdx = idx;
      console.log(
        "%c[lp-ranger] [posStore] loaded %d positions from localStorage, activeIdx=%d",
        "color:#cf8",
        deduped.length,
        idx,
      );
      _persistPosStore();
    }
  } catch {
    /* corrupt data — start fresh */
  }
}

// ── Late-bound callbacks ─────────────────────────

let _syncRouteToState = null;

/** Register syncRouteToState callback. */
export function setSyncRouteToState(fn) {
  _syncRouteToState = fn;
}

/** @deprecated Detail fetch moved to _activateCore — kept for API compat. */
export function setFetchUnmanagedDetails() {}

// ── Managed-position state ───────────────────────

/** Set of tokenIds currently managed by server. */
const _managedTokenIds = new Set();
/** All per-position bot states from server. */
let _allPositionStates = {};

/**
 * Update the set of managed tokenIds and all
 * position states from the server.
 */
const _MGD_KEY = "9mm_managed_token_ids";
export function updateManagedPositions(list, allStates) {
  _managedTokenIds.clear();
  if (Array.isArray(list))
    for (const p of list)
      if (p.tokenId && p.status === "running")
        _managedTokenIds.add(String(p.tokenId));
  _allPositionStates = allStates || {};
  try {
    localStorage.setItem(_MGD_KEY, JSON.stringify([..._managedTokenIds]));
  } catch {
    /* */
  }
}
/** Restore managed tokenIds from localStorage for instant badge render. */
export function restoreManagedPositions() {
  try {
    const s = localStorage.getItem(_MGD_KEY);
    if (s) for (const id of JSON.parse(s)) _managedTokenIds.add(String(id));
  } catch {
    /* */
  }
}

/** Whether the given tokenId is actively managed. */
export function isPositionManaged(tokenId) {
  return _managedTokenIds.has(String(tokenId));
}

/** Access the managed tokenId set (for browser row rendering). */
export function _getManagedTokenIds() {
  return _managedTokenIds;
}

// ── In-browser position store ────────────────────

/**
 * Lightweight in-browser position store (mirrors
 * src/position-store.js logic). Stores up to
 * MAX_POS entries, deduplicates by
 * (wallet + type + id), supports pagination and
 * active-position selection. Persisted to
 * localStorage across page reloads.
 */
export const posStore = {
  entries: [],
  activeIdx: -1,

  /** @param {object} entry  @returns {{ok:boolean, entry?:object, error?:string}} */
  add(entry) {
    if (this.entries.length >= MAX_POS)
      return { ok: false, error: "Store full (max 300)" };
    if (!entry.walletAddress || !entry.positionType)
      return { ok: false, error: "Missing required fields" };
    const dup = this.entries.findIndex(
      (e) =>
        e.walletAddress.toLowerCase() === entry.walletAddress.toLowerCase() &&
        e.positionType === entry.positionType &&
        (entry.positionType === "nft"
          ? e.tokenId === String(entry.tokenId)
          : e.contractAddress === entry.contractAddress),
    );
    if (dup !== -1) {
      const existing = this.entries[dup];
      if (entry.token0Symbol) existing.token0Symbol = entry.token0Symbol;
      if (entry.token1Symbol) existing.token1Symbol = entry.token1Symbol;
      if (entry.liquidity !== undefined) existing.liquidity = entry.liquidity;
      if (entry.contractAddress)
        existing.contractAddress = entry.contractAddress;
      if (entry.poolTick !== undefined && entry.poolTick !== null)
        existing.poolTick = entry.poolTick;
      if (entry.scanInRange !== undefined && entry.scanInRange !== null)
        existing.scanInRange = entry.scanInRange;
      _persistPosStore();
      return {
        ok: false,
        error: "Position already in store at index " + dup,
      };
    }
    const e2 = {
      ...entry,
      index: this.entries.length,
      tokenId:
        entry.tokenId !== null && entry.tokenId !== undefined
          ? String(entry.tokenId)
          : undefined,
      active: false,
      addedAt: Date.now(),
    };
    this.entries.push(e2);
    _persistPosStore();
    return { ok: true, entry: e2 };
  },

  /** @param {number} idx  @returns {boolean} */
  select(idx) {
    if (idx < 0 || idx >= this.entries.length) return false;
    if (this.activeIdx >= 0 && this.activeIdx < this.entries.length) {
      this.entries[this.activeIdx].active = false;
    }
    this.activeIdx = idx;
    this.entries[idx].active = true;
    _persistPosStore();
    return true;
  },

  /** @param {number} idx  @returns {boolean} */
  remove(idx) {
    if (idx < 0 || idx >= this.entries.length) return false;
    this.entries.splice(idx, 1);
    for (let i = idx; i < this.entries.length; i++) this.entries[i].index = i;
    if (this.entries.length === 0) {
      this.activeIdx = -1;
    } else if (this.activeIdx >= this.entries.length) {
      this.activeIdx = this.entries.length - 1;
      this.entries[this.activeIdx].active = true;
    } else if (this.activeIdx === idx) {
      this.activeIdx = Math.max(0, idx - 1);
      this.entries[this.activeIdx].active = true;
    }
    _persistPosStore();
    return true;
  },

  /** @returns {object|null} */
  getActive() {
    if (this.activeIdx < 0 || this.activeIdx >= this.entries.length)
      return null;
    return this.entries[this.activeIdx];
  },

  /** Update active entry's tokenId after rebalance key migration. */
  updateActiveTokenId(newId) {
    const a = this.getActive();
    if (!a) return;
    const old = a.tokenId;
    a.tokenId = String(newId);
    _persistPosStore();
    try {
      localStorage.setItem("9mm_last_position", String(newId));
    } catch {
      /* */
    }
    console.log("[lp-ranger] [pos] rebalance follow: #%s → #%s", old, newId);
    if (_syncRouteToState) _syncRouteToState(a);
    updatePosStripUI();
  },

  /** @param {number} [page=0]  @param {number} [size]  @returns {object} */
  getPage(page = 0, size = PAGE_SIZE) {
    const total = Math.max(1, Math.ceil(this.entries.length / size));
    const p = Math.max(0, Math.min(page, total - 1));
    return {
      items: this.entries.slice(p * size, p * size + size),
      page: p,
      totalPages: total,
      totalCount: this.entries.length,
      hasPrev: p > 0,
      hasNext: p < total - 1,
    };
  },

  /** @returns {number} */
  count() {
    return this.entries.length;
  },

  /** @returns {boolean} */
  isFull() {
    return this.entries.length >= MAX_POS;
  },
};

// ── Display helpers ──────────────────────────────

export function _setText(id, text) {
  const el = g(id);
  if (el) el.textContent = text;
}
export function _setHtml(id, html) {
  const el = g(id);
  if (el) el.innerHTML = html;
}

/** Resolve a display name: prefer symbol, fall back to short address. */
export function _tokenName(symbol, address) {
  if (symbol)
    return symbol.length > 20 ? symbol.slice(0, 20) + "\u2026" : symbol;
  if (address && address.length > 10)
    return address.slice(0, 6) + "\u2026" + address.slice(-4);
  return address || "?";
}

/** Build a token label with a copy-address button. */

/** Check if a position is closed (liquidity=0). */
export function isPositionClosed(pos) {
  if (pos.liquidity === undefined || pos.liquidity === null) {
    console.warn(
      "%c[lp-ranger] [posStore] NFT #%s %s has no liquidity data",
      "color:#cf8",
      pos.tokenId,
      emojiId(pos.tokenId),
    );
    return false;
  }
  return String(pos.liquidity) === "0";
}

/**
 * Find the best auto-select index.  Priority: managed > open > closed.
 * Within each tier, picks the youngest (highest tokenId) position.
 * @returns {number}  Index into posStore.entries, or -1 if empty.
 */
/** Classify a position as "managed", "closed", or "open". */
function _posTier(e) {
  if (isPositionManaged(e.tokenId)) return "managed";
  if (isPositionClosed(e)) return "closed";
  return "open";
}

export function bestAutoSelectIdx() {
  const best = { managed: -1, open: -1, closed: -1 };
  const maxId = { managed: -1, open: -1, closed: -1 };
  const counts = { managed: 0, open: 0, closed: 0, noLiq: 0 };
  for (let i = 0; i < posStore.entries.length; i++) {
    const e = posStore.entries[i];
    const id = Number(e.tokenId || 0);
    if (e.liquidity === undefined || e.liquidity === null) counts.noLiq++;
    const t = _posTier(e);
    counts[t]++;
    if (id > maxId[t]) {
      maxId[t] = id;
      best[t] = i;
    }
  }
  const pick =
    best.managed >= 0 ? best.managed : best.open >= 0 ? best.open : best.closed;
  const pe = pick >= 0 ? posStore.entries[pick] : null;
  const tier =
    best.managed >= 0 ? "managed" : best.open >= 0 ? "open" : "closed";
  console.log(
    "%c[lp-ranger] [posStore] bestAutoSelect: total=%d managed=%d open=%d closed=%d noLiq=%d → #%s %s (idx=%d, liq=%s, tier=%s)",
    "color:#cf8",
    posStore.entries.length,
    counts.managed,
    counts.open,
    counts.closed,
    counts.noLiq,
    pe?.tokenId || "none",
    pe ? emojiId(pe.tokenId) : "",
    pick,
    pe ? String(pe.liquidity) : "n/a",
    tier,
  );
  return pick;
}

/** Format a compact label for a position entry. */
export function formatPosLabel(e) {
  const pair =
    _tokenName(e.token0Symbol, e.token0) +
    "/" +
    _tokenName(e.token1Symbol, e.token1);
  return (
    (e.positionType === "nft" ? "NFT #" + e.tokenId : "ERC-20") +
    " \u00B7 " +
    pair
  );
}

// ── Position strip UI ────────────────────────────

/** Populate wallet-strip fields for active pos. */
function _updateActiveStripDetails(active) {
  const pair =
    _tokenName(active.token0Symbol, active.token0) +
    "/" +
    _tokenName(active.token1Symbol, active.token1);
  const isNft = active.positionType === "nft";
  const typeStr = isNft ? "NFT #" + active.tokenId : "ERC-20";
  const activeLabel = g("wsActivePosLabel");
  if (activeLabel) activeLabel.textContent = typeStr + " \u00B7 " + pair;
  const badge = g("ptBadge");
  if (badge) {
    badge.textContent = isNft ? "NFT POSITION" : "ERC-20 POSITION";
    badge.className = "pt-badge " + (isNft ? "nft" : "erc20");
  }
  const tokenLabel = g("posTokenLabel");
  if (tokenLabel)
    tokenLabel.textContent = isNft ? "Position NFT #" : "ERC-20: ";
  const wsToken = g("wsToken");
  if (wsToken)
    wsToken.textContent = isNft
      ? active.tokenId || "\u2014"
      : (active.contractAddress || "\u2014").slice(0, 10) + "\u2026";
  const wsPool = g("wsPool");
  if (wsPool) wsPool.textContent = pair;
  const wsFee = g("wsFee");
  if (wsFee) wsFee.textContent = (active.fee / 10000).toFixed(2) + "%";
}

/** Update the compact position strip beneath the header. */
export function updatePosStripUI() {
  const count = posStore.count();
  const openCount = posStore.entries.filter((e) => !isPositionClosed(e)).length;
  const active = posStore.getActive();
  const headerLabel = g("headerPosLabel");
  if (headerLabel)
    headerLabel.textContent =
      openCount + " Open Position" + (openCount !== 1 ? "s" : "");
  const posCount = g("wsPosCount");
  if (posCount) posCount.textContent = count + " total";

  if (active) {
    _updateActiveStripDetails(active);
    // Detail fetch is handled by _fetchUnmanagedIfNeeded in _activateCore —
    // do NOT call _fetchUnmanagedDetails here (would duplicate the request).
  } else {
    _setText("wsActivePosLabel", "No active position");
    _setText("wsToken", "\u2014");
    _setText("posTokenLabel", "");
    const badge = g("ptBadge");
    if (badge) {
      badge.textContent = "";
      badge.className = "pt-badge";
    }
  }

  const capWarn = g("posCapWarn");
  if (capWarn)
    capWarn.textContent = posStore.isFull()
      ? "\u26A0 Store full (300/300)"
      : "";
}

// ── Config application ───────────────────────────

/**
 * Apply OOR threshold and tick boundaries from a
 * position entry to botConfig and UI.
 * @param {object} active  Active posStore entry.
 * @returns {number}  Saved OOR threshold.
 */
export function _applyPositionConfig(active) {
  botConfig.lower = Math.pow(1.0001, active.tickLower || 0);
  botConfig.upper = Math.pow(1.0001, active.tickUpper || 0);
  botConfig.tL = active.tickLower || 0;
  botConfig.tU = active.tickUpper || 0;
  const savedOor = loadPositionOorThreshold(active);
  botConfig.oorThreshold = savedOor;
  const oorInput = g("inOorThreshold");
  if (oorInput) oorInput.value = savedOor;
  const oorDisplay = g("activeOorThreshold");
  if (oorDisplay) oorDisplay.textContent = savedOor;
  // Server is source of truth — _syncConfigFromServer() will populate
  // UI inputs from server config on the next poll cycle.
  return savedOor;
}

/**
 * Populate dashboard stat grid and labels from
 * local position data. Called when a position is
 * activated from the browser (no bot needed).
 * @param {object} pos  posStore entry.
 */
export function _applyLocalPositionData(pos) {
  _setText("sTL", pos.tickLower ?? "\u2014");
  _setText("sTU", pos.tickUpper ?? "\u2014");
  const t0Sym = _tokenName(pos.token0Symbol, pos.token0) || "\u2014";
  const t1Sym = _tokenName(pos.token1Symbol, pos.token1) || "\u2014";
  const t0Full = pos.token0Symbol || t0Sym;
  const t1Full = pos.token1Symbol || t1Sym;
  _setText("statT0Name", t0Sym);
  _setText("statT1Name", t1Sym);
  // Set copy-to-clipboard addresses for all copy icons
  for (const [id, addr] of [
    ["copyT0", pos.token0],
    ["copyT1", pos.token1],
    ["copyOffsetT0", pos.token0],
    ["copyOffsetT1", pos.token1],
  ]) {
    const el = g(id);
    if (el) el.dataset.copyAddr = addr || "";
  }
  // Offset row labels
  _setText("offsetT0Name", t0Sym);
  _setText("offsetT1Name", t1Sym);
  const _t = (id, t) => {
    const e = g(id);
    if (e) e.title = t;
  };
  _t("statT0Label", t0Full);
  _t("statT1Label", t1Full);
  _setText("statShare0Label", "Pool Share " + t0Sym);
  _setText("statShare1Label", "Pool Share " + t1Sym);
  _t("statShare0Label", t0Full);
  _t("statShare1Label", t1Full);
  _setText("cl0", "\u25A0 " + t0Sym + ": 50%");
  _setText("cl1", "\u25A0 " + t1Sym + ": 50%");
  _t("cl0", t0Full);
  _t("cl1", t1Full);
  _setText("wsPool", t0Sym + " / " + t1Sym);
  _setText("wsFee", (pos.fee / 10000).toFixed(2) + "%");
  _setText("ltPnlLabel", "Net Profit and Loss Return");
  _setText("kpiPnlPct", "");
  // Clear server-populated stat values so the previous position's data
  // doesn't flash while waiting for the new position's poll response.
  _setText("sTC", "\u2014");
  _setText("sShare0", "\u2014");
  _setText("sShare1", "\u2014");
  _setText("sWpls", "\u2014");
  _setText("sUsdc", "\u2014");
  _setText("sResidual0", "\u2014");
  _setText("sResidual1", "\u2014");
  _setText("sOorDuration", "n/a");
  _setText("pmlabel", "");
  const statusEl = g("curPosStatus");
  if (statusEl) {
    const closed = isPositionClosed(pos);
    statusEl.textContent = closed ? "CLOSED" : "ACTIVE";
    statusEl.className =
      "9mm-pos-mgr-pos-status " + (closed ? "closed" : "active");
  }
}

// ── Manage badge ─────────────────────────────────

/** Refresh the manage badge for a position. */
export function refreshManageBadge(active) {
  if (!active) return;
  const badge = g("manageBadge"),
    btn = g("manageToggleBtn");
  if (!badge || !btn) return;
  const closed = isPositionClosed(active);
  const m = !closed && _managedTokenIds.has(String(active.tokenId));
  badge.classList.toggle("managed", m);
  badge.innerHTML = closed
    ? "Position Closed"
    : m
      ? '<span class="9mm-pos-mgr-manage-dot"></span>Being Actively Managed'
      : "Not Actively Managed";
  btn.textContent = m ? "Stop Managing" : "Manage";
  btn.disabled = closed;
  btn.title = closed ? "Cannot manage a closed position (liquidity = 0)" : "";
}

// ── Position row rendering ───────────────────────

/** Check if a position is in range. */
export function checkInRange(e) {
  for (const [, st] of Object.entries(_allPositionStates)) {
    const ap = st.activePosition,
      ps = st.poolState;
    if (ap && String(ap.tokenId) === String(e.tokenId) && ps)
      return ps.tick >= e.tickLower && ps.tick < e.tickUpper;
  }
  if (e.poolTick !== undefined && e.poolTick !== null)
    return e.poolTick >= e.tickLower && e.poolTick < e.tickUpper;
  if (e.scanInRange !== undefined && e.scanInRange !== null)
    return e.scanInRange;
  return null;
}

// renderPosRow moved to dashboard-positions-browser.js
