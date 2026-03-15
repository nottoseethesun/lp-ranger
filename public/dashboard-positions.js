/**
 * @file dashboard-positions.js
 * @description Position store and browser UI for the 9mm v3 Position Manager
 * dashboard.  Manages up to 300 LP positions in memory with pagination,
 * selection, and text filtering.  Updates {@link botConfig} when a
 * position is activated.
 *
 * Depends on: dashboard-helpers.js (g, act, botConfig, loadPositionRangeW),
 *             dashboard-wallet.js  (wallet, getRpcUrl).
 *
 * NOTE: Import of positionRangeVisual from data.js creates a circular
 * reference (data imports posStore from here). This is safe because
 * positionRangeVisual is only called inside function bodies, not at
 * module evaluation time.
 */

import { g, act, botConfig, loadPositionRangeW } from './dashboard-helpers.js';
import { wallet, getRpcUrl } from './dashboard-wallet.js';

// Late-bound import to avoid circular dep at evaluation time.
// Populated by dashboard-init.js after all modules load.
let _positionRangeVisual = null;

/**
 * Inject data-module references after all modules are loaded.
 * Called once from dashboard-init.js.
 * @param {object} deps  { positionRangeVisual }
 */
export function injectPositionDeps(deps) {
  _positionRangeVisual = deps.positionRangeVisual;
}

// ── Constants ───────────────────────────────────────────────────────────────

/** Maximum number of positions the store can hold. */
const MAX_POS  = 300;

/** Number of positions shown per browser page. */
const PAGE_SIZE = 20;

// ── Position store persistence ──────────────────────────────────────────────

const _POS_STORE_KEY = '9mm_position_store';

/** Save posStore to localStorage. */
function _persistPosStore() {
  try {
    const data = { entries: posStore.entries, activeIdx: posStore.activeIdx };
    localStorage.setItem(_POS_STORE_KEY, JSON.stringify(data));
  } catch { /* private mode or quota exceeded */ }
}

/** Load posStore from localStorage. */
export function _loadPosStore() {
  try {
    const raw = localStorage.getItem(_POS_STORE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (Array.isArray(data.entries)) {
      posStore.entries   = data.entries;
      posStore.activeIdx = typeof data.activeIdx === 'number' ? data.activeIdx : -1;
    }
  } catch { /* corrupt data — start fresh */ }
}

// ── In-browser position store ───────────────────────────────────────────────

/**
 * Lightweight in-browser position store (mirrors src/position-store.js logic).
 * Stores up to MAX_POS entries, deduplicates by (wallet + type + id),
 * supports pagination and active-position selection.
 * Persisted to localStorage across page reloads.
 */
export const posStore = {
  entries:   [],
  activeIdx: -1,

  /** @param {object} entry  @returns {{ok:boolean, entry?:object, error?:string}} */
  add(entry) {
    if (this.entries.length >= MAX_POS) return { ok: false, error: 'Store full (max 300)' };
    if (!entry.walletAddress || !entry.positionType) return { ok: false, error: 'Missing required fields' };
    const dup = this.entries.findIndex(e =>
      e.walletAddress.toLowerCase() === entry.walletAddress.toLowerCase() &&
      e.positionType === entry.positionType &&
      (entry.positionType === 'nft'
        ? e.tokenId === String(entry.tokenId)
        : e.contractAddress === entry.contractAddress)
    );
    if (dup !== -1) {
      const existing = this.entries[dup];
      if (entry.token0Symbol) existing.token0Symbol = entry.token0Symbol;
      if (entry.token1Symbol) existing.token1Symbol = entry.token1Symbol;
      if (entry.liquidity !== undefined) existing.liquidity = entry.liquidity;
      _persistPosStore();
      return { ok: false, error: 'Position already in store at index ' + dup };
    }
    const e2 = {
      ...entry, index: this.entries.length,
      tokenId: entry.tokenId !== null && entry.tokenId !== undefined ? String(entry.tokenId) : undefined,
      active: false, addedAt: Date.now(),
    };
    this.entries.push(e2);
    if (this.entries.length === 1) { this.activeIdx = 0; this.entries[0].active = true; }
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
    if (this.activeIdx < 0 || this.activeIdx >= this.entries.length) return null;
    return this.entries[this.activeIdx];
  },

  /** @param {number} [page=0]  @param {number} [size]  @returns {object} */
  getPage(page = 0, size = PAGE_SIZE) {
    const total = Math.max(1, Math.ceil(this.entries.length / size));
    const p = Math.max(0, Math.min(page, total - 1));
    return {
      items: this.entries.slice(p * size, p * size + size),
      page: p, totalPages: total, totalCount: this.entries.length,
      hasPrev: p > 0, hasNext: p < total - 1,
    };
  },

  /** @returns {number} */
  count() { return this.entries.length; },

  /** @returns {boolean} */
  isFull() { return this.entries.length >= MAX_POS; },
};

// ── Position strip UI ───────────────────────────────────────────────────────

/** Browser page index and highlighted row. */
let posBrowserPage     = 0;
let posBrowserSelected = -1;

/** Update the compact position strip shown beneath the header. */
export function updatePosStripUI() {
  const count  = posStore.count();
  const active = posStore.getActive();
  g('headerPosLabel').textContent = count + ' Position' + (count !== 1 ? 's' : '');
  g('wsPosCount').textContent     = count + ' total';

  if (active) {
    const pair    = _tokenName(active.token0Symbol, active.token0) + '/' + _tokenName(active.token1Symbol, active.token1);
    const typeStr = active.positionType === 'nft' ? 'NFT #' + active.tokenId : 'ERC-20';
    g('wsActivePosLabel').textContent = typeStr + ' \u00B7 ' + pair;
    g('ptBadge').textContent  = active.positionType === 'nft' ? 'NFT POSITION' : 'ERC-20 POSITION';
    g('ptBadge').className    = 'pt-badge ' + (active.positionType === 'nft' ? 'nft' : 'erc20');
    g('posTokenLabel').textContent = active.positionType === 'nft' ? 'Position NFT #' : 'ERC-20: ';
    g('wsToken').textContent = active.positionType === 'nft'
      ? (active.tokenId || '\u2014')
      : (active.contractAddress || '\u2014').slice(0, 10) + '\u2026';
    g('wsPool').textContent = pair + ' \u00B7 ' + (active.fee / 10000).toFixed(2) + '%';
  } else {
    g('wsActivePosLabel').textContent = 'No active position';
  }

  const capWarn = g('posCapWarn');
  if (capWarn) capWarn.textContent = posStore.isFull() ? '\u26A0 Store full (300/300)' : '';
}

// ── Position browser modal ──────────────────────────────────────────────────

/** Open the position browser modal. */
export function openPosBrowser() {
  posBrowserPage = 0;
  posBrowserSelected = -1;
  g('posBrowserModal').className = 'modal-overlay';
  renderPosBrowser();
}

/** Close the position browser modal. */
export function closePosBrowser() { g('posBrowserModal').className = 'modal-overlay hidden'; }

/** Render the paginated, filterable position list inside the browser modal. */
export function renderPosBrowser() {
  const filter   = (g('posSearchInput').value || '').toLowerCase();
  const all      = posStore.entries;
  const filtered = filter
    ? all.filter(e => {
      const hay = [e.token0, e.token1, e.tokenId, e.contractAddress,
        e.walletAddress, e.positionType].join(' ').toLowerCase();
      return hay.includes(filter);
    })
    : all;

  // Stats bar
  const nftCount = filtered.filter(e => e.positionType === 'nft').length;
  const ercCount = filtered.filter(e => e.positionType === 'erc20').length;
  const inRangeCount = filtered.filter(e => {
    const lp = Math.pow(1.0001, e.tickLower || 0);
    const up = Math.pow(1.0001, e.tickUpper || 0);
    return botConfig.price >= lp && botConfig.price <= up;
  }).length;
  g('posTotalCount').textContent   = filtered.length;
  g('posNftCount').textContent     = nftCount;
  g('posErcCount').textContent     = ercCount;
  g('posInRangeCount').textContent = inRangeCount;
  const capWarn = g('posCapWarn');
  if (capWarn) capWarn.textContent = posStore.isFull() ? '\u26A0 Store full (300/300)' : '';

  // Paginate
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const page = Math.min(posBrowserPage, totalPages - 1);
  posBrowserPage = page;
  const pageItems = filtered.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  // Render list
  const list = g('posList');
  if (!filtered.length) {
    list.innerHTML = '<div class="pos-empty"><div class="pos-empty-icon">\u{1F4C2}</div><div>' +
      (all.length ? 'No positions match your filter.' : 'No positions loaded. Import a wallet or click Scan.') +
      '</div></div>';
  } else {
    list.innerHTML = pageItems.map(e => _renderPosRow(e)).join('');
  }

  // Pagination controls
  g('posPageLabel').textContent = 'Page ' + (page + 1) + ' of ' + totalPages;
  g('posPrevBtn').disabled = page <= 0;
  g('posNextBtn').disabled = page >= totalPages - 1;

  // Action buttons
  g('posSelectBtn').disabled = posBrowserSelected < 0;
  g('posRemoveBtn').disabled = posBrowserSelected < 0;
}

/**
 * Toggle row selection in the position browser.
 * @param {number} idx  Position index.
 */
export function posRowClick(idx) {
  posBrowserSelected = (posBrowserSelected === idx) ? -1 : idx;
  renderPosBrowser();
}

/**
 * Navigate to the next/previous page of positions.
 * @param {number} dir  +1 for next, -1 for previous.
 */
export function posChangePage(dir) {
  posBrowserPage += dir;
  renderPosBrowser();
}

/** Make the highlighted position the active one and close the browser. */
export function activateSelectedPos() {
  if (posBrowserSelected < 0) return;
  posStore.select(posBrowserSelected);
  updatePosStripUI();

  const active = posStore.getActive();
  if (active) {
    botConfig.lower = Math.pow(1.0001, active.tickLower || 0);
    botConfig.upper = Math.pow(1.0001, active.tickUpper || 0);
    botConfig.tL = active.tickLower || 0;
    botConfig.tU = active.tickUpper || 0;

    const savedRangeW = loadPositionRangeW(active);
    botConfig.rangeW = savedRangeW;
    const rangeInput = g('inRangeW');
    if (rangeInput) rangeInput.value = savedRangeW;
    const rangeDisplay = g('activeRangeW');
    if (rangeDisplay) rangeDisplay.textContent = savedRangeW;

    _applyLocalPositionData(active);
    if (_positionRangeVisual) _positionRangeVisual();
    act('\u{1F4CD}', 'fee', 'Position switched', 'Now managing: ' + formatPosLabel(active) + ' (\u00B1' + savedRangeW + '%)');
    closePosBrowser();
  }
}

/**
 * Resolve a display name for a token: prefer symbol, fall back to short address.
 * @param {string|null} symbol   Token symbol from on-chain lookup.
 * @param {string|null} address  Full contract address.
 * @returns {string}
 */
function _tokenName(symbol, address) {
  if (symbol) return symbol;
  if (address && address.length > 10) return address.slice(0, 6) + '\u2026' + address.slice(-4);
  return address || '?';
}

/**
 * Render a single position row for the browser modal.
 * Uses data-pos-idx for event delegation instead of inline onclick.
 * @param {object} e  Position entry from posStore.
 * @returns {string}  HTML string for the row.
 */
function _renderPosRow(e) {
  const lp    = Math.pow(1.0001, e.tickLower || 0);
  const up    = Math.pow(1.0001, e.tickUpper || 0);
  const inR   = botConfig.price >= lp && botConfig.price <= up;
  const pair  = _tokenName(e.token0Symbol, e.token0) + '/' + _tokenName(e.token1Symbol, e.token1);
  const feePct = e.fee ? (e.fee / 10000).toFixed(2) + '%' : '\u2014';
  const idStr  = e.positionType === 'nft'
    ? 'NFT #' + e.tokenId
    : e.contractAddress ? e.contractAddress.slice(0, 10) + '\u2026' : 'ERC-20';
  const walletShort   = e.walletAddress.slice(0, 8) + '\u2026' + e.walletAddress.slice(-4);
  const isHighlighted = e.index === posBrowserSelected;
  const isActive      = e.active;
  return `<div class="pos-row ${isActive ? 'active-pos' : ''} ${isHighlighted ? 'selected' : ''}" data-pos-idx="${e.index}">
    <div class="pos-row-idx ${isActive ? 'active-idx' : ''}">${e.index + 1}</div>
    <span class="pos-type-chip ${e.positionType}">${e.positionType.toUpperCase()}</span>
    <div class="pos-row-body">
      <div class="pos-row-title">${idStr} \u00B7 ${pair} \u00B7 ${feePct}${isActive ? ' \u2605' : ''}</div>
      <div class="pos-row-meta">${walletShort} \u00B7 ticks [${e.tickLower || 0}, ${e.tickUpper || 0}]</div>
    </div>
    <div class="pos-row-status ${inR ? 'in' : 'out'}">${inR ? '\u2713 IN' : '\u2717 OUT'}</div>
  </div>`;
}

/**
 * Build a token label with a copy-address button using data attributes.
 * @param {string} symbol   Token symbol (e.g. "WPLS").
 * @param {string} address  Full contract address.
 * @returns {string}  HTML string.
 */
function _tokenLabelHtml(symbol, address) {
  if (!address || address === '\u2014') return symbol || '\u2014';
  const escaped = address.replace(/'/g, '&#39;');
  return symbol +
    '<button class="9mm-pos-mgr-token-copy-btn" data-copy-addr="' +
    escaped + '" title="Copy contract address: ' + escaped + '">\u{1F4CB}</button>';
}

/**
 * Set an element's text content if the element exists.
 * @param {string} id   Element ID.
 * @param {string} text Text to set.
 */
function _setText(id, text) {
  const el = g(id);
  if (el) el.textContent = text;
}

/**
 * Set an element's innerHTML if the element exists.
 * @param {string} id   Element ID.
 * @param {string} html HTML to set.
 */
function _setHtml(id, html) {
  const el = g(id);
  if (el) el.innerHTML = html;
}

/**
 * Populate dashboard stat grid and labels from local position data.
 * Called when a position is activated from the browser (no bot needed).
 * @param {object} pos  Position entry from posStore.
 */
export function _applyLocalPositionData(pos) {
  _setText('sTL', pos.tickLower ?? '\u2014');
  _setText('sTU', pos.tickUpper ?? '\u2014');
  _setText('sLiq', pos.liquidity ? String(pos.liquidity) : '\u2014');

  const t0Sym = _tokenName(pos.token0Symbol, pos.token0) || '\u2014';
  const t1Sym = _tokenName(pos.token1Symbol, pos.token1) || '\u2014';

  _setHtml('statT0Label', _tokenLabelHtml(t0Sym, pos.token0 || ''));
  _setHtml('statT1Label', _tokenLabelHtml(t1Sym, pos.token1 || ''));
  _setText('cl0', '\u25A0 ' + t0Sym + ': 50%');
  _setText('cl1', '\u25A0 ' + t1Sym + ': 50%');
  _setText('wsPool', t0Sym + ' / ' + t1Sym + ' \u00B7 ' + (pos.fee / 10000).toFixed(2) + '%');
  _setText('kpiDeposit', 'start bot for USD values');
}

/** Remove the highlighted position from the store. */
export function removeSelectedPos() {
  if (posBrowserSelected < 0) return;
  const entry = posStore.entries[posBrowserSelected];
  if (!entry) return;
  posStore.remove(posBrowserSelected);
  posBrowserSelected = -1;
  updatePosStripUI();
  act('\u{1F5D1}', 'alert', 'Position removed', formatPosLabel(entry) + ' removed from store');
  renderPosBrowser();
}

/**
 * Format a compact label for a position entry.
 * @param {object} e  Position entry.
 * @returns {string}
 */
export function formatPosLabel(e) {
  const pair = _tokenName(e.token0Symbol, e.token0) + '/' + _tokenName(e.token1Symbol, e.token1);
  return (e.positionType === 'nft' ? 'NFT #' + e.tokenId : 'ERC-20') + ' \u00B7 ' + pair;
}

/**
 * Scan the current wallet for LP positions via the server API.
 * Requires a connected wallet (imported via the wallet modal).
 */
export async function scanPositions() {
  if (!wallet.address) {
    act('\u26A0', 'alert', 'No wallet loaded', 'Import a wallet first to scan for positions');
    return;
  }
  const btn = g('posScanBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '\u27F3 Scanning\u2026';
  }

  try {
    const res = await fetch('/api/positions/scan', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ rpcUrl: getRpcUrl() }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);

    const added = _addScannedPositions(data);
    const nftCount = (data.nftPositions || []).length;
    const ercCount = (data.erc20Positions || []).length;
    act('\u{1F50D}', 'start', 'Scan complete',
      `Found ${nftCount} NFT + ${ercCount} ERC-20 positions. Added ${added} new.`);
    updatePosStripUI();

    const active = posStore.getActive();
    if (active) {
      botConfig.lower = Math.pow(1.0001, active.tickLower || 0);
      botConfig.upper = Math.pow(1.0001, active.tickUpper || 0);
      botConfig.tL = active.tickLower || 0;
      botConfig.tU = active.tickUpper || 0;
      _applyLocalPositionData(active);
      if (_positionRangeVisual) _positionRangeVisual();
    }
  } catch (e) {
    act('\u26A0', 'alert', 'Scan failed', e.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '\u27F3 Scan Wallet';
    }
    renderPosBrowser();
  }
}

/**
 * Add scanned positions from an API response to posStore.
 * @param {object} data  Parsed scan response with nftPositions / erc20Positions.
 * @returns {number}     Number of positions successfully added.
 */
function _addScannedPositions(data) {
  let added = 0;
  for (const pos of (data.nftPositions || [])) {
    if (!pos.fee || ![100, 500, 2500, 3000, 10000].includes(pos.fee)) continue;
    const result = posStore.add({
      walletAddress: wallet.address, positionType: 'nft',
      tokenId: pos.tokenId, token0: pos.token0, token1: pos.token1,
      token0Symbol: pos.token0Symbol || null, token1Symbol: pos.token1Symbol || null,
      fee: pos.fee, tickLower: pos.tickLower, tickUpper: pos.tickUpper,
      liquidity: pos.liquidity,
    });
    if (result.ok) added++;
  }
  for (const pos of (data.erc20Positions || [])) {
    const result = posStore.add({
      walletAddress: wallet.address, positionType: 'erc20',
      contractAddress: pos.contractAddress, balance: pos.balance,
      token0: pos.token0, token1: pos.token1,
      token0Symbol: pos.token0Symbol || null, token1Symbol: pos.token1Symbol || null,
      fee: pos.fee, tickLower: pos.tickLower, tickUpper: pos.tickUpper,
    });
    if (result.ok) added++;
  }
  return added;
}
