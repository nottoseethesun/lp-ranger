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

import { g, act, botConfig, loadPositionOorThreshold } from './dashboard-helpers.js';
import { wallet, getRpcUrl } from './dashboard-wallet.js';

// Late-bound import to avoid circular dep at evaluation time.
// Populated by dashboard-init.js after all modules load.
let _positionRangeVisual = null;
let _updateRouteForPosition = null;
let _syncRouteToState = null;
let _enterClosedPosView = null;

/** The bot's actual active tokenId (from server), distinct from posStore selection. */
let _botActiveTokenId = null;
let _exitClosedPosView = null;
let _isViewingClosedPos = null;

/**
 * Inject data-module references after all modules are loaded.
 * Called once from dashboard-init.js.
 * @param {object} deps  { positionRangeVisual, updateRouteForPosition, syncRouteToState }
 */
export function injectPositionDeps(deps) {
  _positionRangeVisual = deps.positionRangeVisual;
  if (deps.updateRouteForPosition) _updateRouteForPosition = deps.updateRouteForPosition;
  if (deps.syncRouteToState) _syncRouteToState = deps.syncRouteToState;
  if (deps.enterClosedPosView) _enterClosedPosView = deps.enterClosedPosView;
  if (deps.exitClosedPosView) _exitClosedPosView = deps.exitClosedPosView;
  if (deps.isViewingClosedPos) _isViewingClosedPos = deps.isViewingClosedPos;
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

/** Load posStore from localStorage, deduplicating entries. */
export function _loadPosStore() {
  try {
    const raw = localStorage.getItem(_POS_STORE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (Array.isArray(data.entries)) {
      const seen = new Set(), deduped = [];
      for (const e of data.entries) {
        const key = (e.walletAddress || '').toLowerCase() + '|' + e.positionType + '|' +
          (e.positionType === 'nft' ? String(e.tokenId) : (e.contractAddress || ''));
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push({ ...e, index: deduped.length });
      }
      posStore.entries = deduped;
      const idx = typeof data.activeIdx === 'number' ? data.activeIdx : -1;
      posStore.activeIdx = idx >= 0 && idx < deduped.length ? idx : (deduped.length > 0 ? 0 : -1);
      _persistPosStore();
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
      if (entry.contractAddress) existing.contractAddress = entry.contractAddress;
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

/**
 * Populate wallet-strip fields for the active position.
 * @param {object} active  Active position entry from posStore.
 */
function _updateActiveStripDetails(active) {
  const pair    = _tokenName(active.token0Symbol, active.token0) + '/' + _tokenName(active.token1Symbol, active.token1);
  const isNft   = active.positionType === 'nft';
  const typeStr = isNft ? 'NFT #' + active.tokenId : 'ERC-20';
  const activeLabel = g('wsActivePosLabel');
  if (activeLabel) activeLabel.textContent = typeStr + ' \u00B7 ' + pair;
  const badge = g('ptBadge');
  if (badge) {
    badge.textContent = isNft ? 'NFT POSITION' : 'ERC-20 POSITION';
    badge.className   = 'pt-badge ' + (isNft ? 'nft' : 'erc20');
  }
  const tokenLabel = g('posTokenLabel');
  if (tokenLabel) tokenLabel.textContent = isNft ? 'Position NFT #' : 'ERC-20: ';
  const wsToken = g('wsToken');
  if (wsToken) wsToken.textContent = isNft
    ? (active.tokenId || '\u2014')
    : (active.contractAddress || '\u2014').slice(0, 10) + '\u2026';
  const wsPool = g('wsPool');
  if (wsPool) wsPool.textContent = pair + ' \u00B7 ' + (active.fee / 10000).toFixed(2) + '%';
}

/** Update the compact position strip shown beneath the header. */
export function updatePosStripUI() {
  const count  = posStore.count();
  const active = posStore.getActive();
  const headerLabel = g('headerPosLabel');
  if (headerLabel) headerLabel.textContent = count + ' Position' + (count !== 1 ? 's' : '');
  const posCount = g('wsPosCount');
  if (posCount) posCount.textContent = count + ' total';

  if (active) {
    _updateActiveStripDetails(active);
  } else {
    _setText('wsActivePosLabel', 'No active position');
    _setText('wsToken', '\u2014');
    _setText('posTokenLabel', '');
    const badge = g('ptBadge');
    if (badge) { badge.textContent = ''; badge.className = 'pt-badge'; }
  }

  const capWarn = g('posCapWarn');
  if (capWarn) capWarn.textContent = posStore.isFull() ? '\u26A0 Store full (300/300)' : '';
}

// ── Position browser modal ──────────────────────────────────────────────────

/** Open the position browser modal. */
export function openPosBrowser() {
  posBrowserPage = 0; posBrowserSelected = -1;
  g('posBrowserModal').className = 'modal-overlay'; renderPosBrowser();
}

/** Close the position browser modal. */
export function closePosBrowser() { g('posBrowserModal').className = 'modal-overlay hidden'; }

/** Render the paginated, filterable position list inside the browser modal. */
export function renderPosBrowser() {
  const filter   = (g('posSearchInput').value || '').toLowerCase();
  const all      = posStore.entries;
  const unsorted = filter
    ? all.filter(e => {
      const hay = [e.token0, e.token1, e.tokenId, e.contractAddress,
        e.walletAddress, e.positionType].join(' ').toLowerCase();
      return hay.includes(filter);
    })
    : all;
  const filtered = [...unsorted].sort((a, b) => {
    const idA = Number(a.tokenId || 0), idB = Number(b.tokenId || 0);
    return idB - idA;
  });

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
    if (localStorage.getItem('9mm_privacy_mode') === '1') list.querySelectorAll('.pos-row-title, .pos-row-meta').forEach(el => el.classList.add('9mm-pos-mgr-privacy-blur'));
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

/**
 * Exit any active closed-position view.
 */
function _exitClosedViewIfActive() {
  if (_isViewingClosedPos && _isViewingClosedPos() && _exitClosedPosView) _exitClosedPosView();
}

/**
 * Apply OOR threshold and tick boundaries from a position entry to botConfig and UI.
 * @param {object} active  Active position entry from posStore.
 * @returns {number}  The saved OOR threshold value.
 */
function _applyPositionConfig(active) {
  botConfig.lower = Math.pow(1.0001, active.tickLower || 0);
  botConfig.upper = Math.pow(1.0001, active.tickUpper || 0);
  botConfig.tL = active.tickLower || 0;
  botConfig.tU = active.tickUpper || 0;
  const savedOor = loadPositionOorThreshold(active);
  botConfig.oorThreshold = savedOor;
  const oorInput = g('inOorThreshold');
  if (oorInput) oorInput.value = savedOor;
  const oorDisplay = g('activeOorThreshold');
  if (oorDisplay) oorDisplay.textContent = savedOor;
  // Sync per-position threshold to server so the bot rebalancer uses the correct value
  fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rebalanceOutOfRangeThresholdPercent: savedOor }) }).catch(() => {});
  return savedOor;
}

/**
 * Check if a position is closed (liquidity=0).
 * @param {object} pos  Position entry.
 * @returns {boolean}
 */
function _isPositionClosed(pos) {
  return pos.liquidity !== undefined && pos.liquidity !== null && String(pos.liquidity) === '0';
}

/** Tell the server to switch the bot to the given NFT position. */
function _notifyServerSwitch(active) {
  if (!active.tokenId || active.positionType !== 'nft') return;
  fetch('/api/position/switch', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tokenId: active.tokenId }) })
    .then(r => r.json()).then(data => { if (data.queued) _showSwitchQueuedDialog(); }).catch(() => {});
}

/** Show a caution dialog when position switch is queued (bot busy). */
function _showSwitchQueuedDialog() {
  if (document.getElementById('switchQueuedModal')) return;
  const o = document.createElement('div'); o.className = '9mm-pos-mgr-modal-overlay'; o.id = 'switchQueuedModal';
  o.innerHTML = '<div class="9mm-pos-mgr-modal 9mm-pos-mgr-modal-caution"><h3>Position Switch Queued</h3>' +
    '<p>The bot is currently busy with the current LP position. The app will switch to the LP position you ' +
    'requested as soon as possible. It may be up to a few minutes or you may need to review that any pending ' +
    'transactions on your wallet from a rebalance have completed.</p>' +
    '<button class="9mm-pos-mgr-modal-close" data-dismiss-modal>OK</button></div>';
  document.body.appendChild(o);
}

/** Make the highlighted position the active one and close the browser. */
export function activateSelectedPos() {
  if (posBrowserSelected < 0) return;
  _exitClosedViewIfActive();

  posStore.select(posBrowserSelected);
  updatePosStripUI();

  const active = posStore.getActive();
  if (!active) return;

  _applyLocalPositionData(active);

  if (_isPositionClosed(active) && _enterClosedPosView) {
    // Don't apply tick config — keep botConfig showing the bot's active position
    _enterClosedPosView(active);
    if (_updateRouteForPosition) _updateRouteForPosition(active);
    act('\u{1F4C2}', 'fee', 'View closed position', 'NFT #' + active.tokenId);
    closePosBrowser();
    return;
  }

  const savedOor = _applyPositionConfig(active);
  if (_positionRangeVisual) _positionRangeVisual();
  _notifyServerSwitch(active);
  if (_updateRouteForPosition) _updateRouteForPosition(active);
  act('\u{1F4CD}', 'fee', 'Position switched', 'Now managing: ' + formatPosLabel(active) + ' (OOR threshold: ' + savedOor + '%)');
  closePosBrowser();
}

/**
 * Activate a position by its NFT token ID (used by the router for deep links).
 * @param {string} tokenId  NFT token ID to activate.
 * @returns {boolean}  True if the position was found and activated.
 */
export function activateByTokenId(tokenId) {
  const idx = posStore.entries.findIndex(
    e => e.positionType === 'nft' && String(e.tokenId) === String(tokenId)
  );
  if (idx < 0) return false;
  _exitClosedViewIfActive();

  posStore.select(idx);
  updatePosStripUI();

  const active = posStore.getActive();
  if (!active) return true;

  _applyLocalPositionData(active);

  if (_isPositionClosed(active) && _enterClosedPosView) {
    // Don't apply tick config — keep botConfig showing the bot's active position
    _enterClosedPosView(active);
    act('\u{1F4C2}', 'fee', 'View closed position', 'NFT #' + active.tokenId);
    return true;
  }

  _applyPositionConfig(active);
  if (_positionRangeVisual) _positionRangeVisual();
  _notifyServerSwitch(active);
  return true;
}

/** Resolve a display name for a token: prefer symbol, fall back to short address. */
function _tokenName(symbol, address) {
  if (symbol) return symbol;
  if (address && address.length > 10) return address.slice(0, 6) + '\u2026' + address.slice(-4);
  return address || '?';
}

/** Select a position by tokenId, apply its data, and sync the URL. */
function _selectAndSync(tokenId) {
  const idx = posStore.entries.findIndex(e => String(e.tokenId) === tokenId);
  if (idx < 0) return;
  _exitClosedViewIfActive();
  posStore.select(idx);
  const s = posStore.getActive(); if (!s) return;
  _applyLocalPositionData(s); updatePosStripUI();
  if (_syncRouteToState) _syncRouteToState(s);
  console.log('[dash] selected #%s at idx=%d, URL synced', tokenId, idx);
}

/** Update the bot's active tokenId, auto-select in store, and sync URL. */
let _rescanPending = false;
export function setBotActiveTokenId(tid) {
  _botActiveTokenId = tid ? String(tid) : null; if (!_botActiveTokenId) return;
  const cur = posStore.getActive();
  const alreadyActive = cur && String(cur.tokenId) === _botActiveTokenId;
  const entry = alreadyActive ? cur : posStore.entries.find(e => String(e.tokenId) === _botActiveTokenId) || null;
  const bad = !entry || !entry.contractAddress || !entry.token0Symbol || /^0x[0-9a-fA-F]{40}$/i.test(entry.token0Symbol);
  if (bad && !_rescanPending) {
    console.log('[dash] setBotActiveTokenId: rescan for #%s (exists=%s)', _botActiveTokenId, !!entry);
    _rescanPending = true;
    scanPositions({ navigate: false }).then(() => _selectAndSync(_botActiveTokenId)).finally(() => { _rescanPending = false; });
    if (!entry) return;
  }
  if (!alreadyActive && !(_isViewingClosedPos && _isViewingClosedPos())) _selectAndSync(_botActiveTokenId);
}

/** Determine status CSS class and label for a position row. */
function _posRowStatus(e, isBotActive, inRange) {
  if (e.liquidity !== undefined && e.liquidity !== null && String(e.liquidity) === '0') return { cls: 'closed', label: 'CLOSED' };
  if (isBotActive) return inRange ? { cls: 'in', label: '\u2713 IN' } : { cls: 'out', label: '\u2717 OUT' };
  return { cls: 'closed', label: '\u2014' };
}

/**
 * Render a single position row for the browser modal.
 * Uses data-pos-idx for event delegation instead of inline onclick.
 * @param {object} e  Position entry from posStore.
 * @returns {string}  HTML string for the row.
 */
function _renderPosRow(e) {
  const lp = Math.pow(1.0001, e.tickLower || 0), up = Math.pow(1.0001, e.tickUpper || 0);
  const inR = botConfig.price >= lp && botConfig.price <= up;
  const pair = _tokenName(e.token0Symbol, e.token0) + '/' + _tokenName(e.token1Symbol, e.token1);
  const feePct = e.fee ? (e.fee / 10000).toFixed(2) + '%' : '\u2014';
  const idStr = e.positionType === 'nft' ? 'NFT #' + e.tokenId : e.contractAddress ? e.contractAddress.slice(0, 10) + '\u2026' : 'ERC-20';
  const ws = e.walletAddress.slice(0, 8) + '\u2026' + e.walletAddress.slice(-4);
  const hl = e.index === posBrowserSelected, ba = e.positionType === 'nft' && _botActiveTokenId && String(e.tokenId) === _botActiveTokenId;
  const { cls, label } = _posRowStatus(e, ba, inR);
  return `<div class="pos-row ${e.active ? 'active-pos' : ''} ${hl ? 'selected' : ''}" data-pos-idx="${e.index}">` +
    `<div class="pos-row-idx ${ba ? 'active-idx' : ''}">${e.index + 1}</div>` +
    `<span class="pos-type-chip ${e.positionType}">${e.positionType.toUpperCase()}</span>` +
    `<div class="pos-row-body"><div class="pos-row-title">${idStr} \u00B7 ${pair} \u00B7 ${feePct}${ba ? ' \u2605' : ''}</div>` +
    `<div class="pos-row-meta">${ws} \u00B7 ticks [${e.tickLower || 0}, ${e.tickUpper || 0}]</div></div>` +
    `<div class="pos-row-status ${cls}">${label}</div></div>`;
}

/** Build a token label with a copy-address button. */
function _tokenLabelHtml(symbol, address) {
  if (!address || address === '\u2014') return symbol || '\u2014';
  const escaped = address.replace(/'/g, '&#39;');
  return symbol +
    '<button class="9mm-pos-mgr-token-copy-btn" data-copy-addr="' +
    escaped + '" title="Copy contract address: ' + escaped + '">\u274F</button>';
}

function _setText(id, text) { const el = g(id); if (el) el.textContent = text; }
function _setHtml(id, html) { const el = g(id); if (el) el.innerHTML = html; }

/** Show a dialog explaining that no LP positions were found. */
function _showNoPositionsDialog() {
  const modal = g('noPositionsModal');
  if (!modal) return;
  modal.className = 'modal-overlay';
  const dismiss = () => { modal.className = 'modal-overlay hidden'; };
  const ok = g('noPositionsOk');
  const close = g('noPositionsClose');
  if (ok) ok.onclick = dismiss;
  if (close) close.onclick = dismiss;
}

/**
 * Reset ALL position-related UI to defaults.
 * This is the single point of display cleanup when the wallet changes.
 * Clears: stat grid, KPIs, composition, pool shares, position strip,
 * active duration, IL breakdown, and the activity log.
 */
export function clearPositionDisplay() {
  _botActiveTokenId = null;
  // Stat grid: ticks, token labels, pool shares, balances
  _setText('sTL', '\u2014'); _setText('sTU', '\u2014'); _setText('sTC', '\u2014');
  _setHtml('statT0Label', '\u2014'); _setHtml('statT1Label', '\u2014');
  _setText('statShare0Label', 'Pool Share —'); _setText('statShare1Label', 'Pool Share —');
  _setText('sShare0', '\u2014'); _setText('sShare1', '\u2014');
  _setText('sWpls', '\u2014'); _setText('sUsdc', '\u2014');
  _setText('cl0', '\u25A0 —: 50%'); _setText('cl1', '\u25A0 —: 50%');
  const c0 = g('c0'), c1 = g('c1'); if (c0) c0.style.width = '50%'; if (c1) c1.style.width = '50%';
  _setText('wsPool', '\u2014'); _setText('kpiDeposit', '\u2014');
  const statusEl = g('curPosStatus'); if (statusEl) { statusEl.textContent = '\u2014'; statusEl.className = '9mm-pos-mgr-pos-status'; }
  botConfig.lower = 0; botConfig.upper = 0; botConfig.tL = 0; botConfig.tU = 0;
  _clearKpiElements(); updatePosStripUI();
  const actList = g('actList'); if (actList) actList.innerHTML = '';
}

/** Reset all KPI card elements to default empty state. */
function _clearKpiElements() {
  for (const id of ['kpiPnl', 'kpiNet', 'curIL', 'netIL', 'curProfit', 'ltProfit']) { const el = g(id); if (el) { el.textContent = '\u2014'; el.className = 'kpi-value 9mm-pos-mgr-kpi-pct-row neu'; } }
  for (const id of ['kpiPnlPct', 'kpiNetBreakdown', 'kpiPosDuration', 'pnlRealized']) _setText(id, '\u2014');
  for (const id of ['kpiPnlPctVal', 'kpiPnlApr', 'kpiNetPct', 'kpiNetApr', 'curILPct', 'netILPct', 'netILApr']) { const el = g(id); if (el) el.textContent = ''; }
}

/**
 * Populate dashboard stat grid and labels from local position data.
 * Called when a position is activated from the browser (no bot needed).
 * @param {object} pos  Position entry from posStore.
 */
export function _applyLocalPositionData(pos) {
  _setText('sTL', pos.tickLower ?? '\u2014'); _setText('sTU', pos.tickUpper ?? '\u2014');
  const t0Sym = _tokenName(pos.token0Symbol, pos.token0) || '\u2014';
  const t1Sym = _tokenName(pos.token1Symbol, pos.token1) || '\u2014';
  _setHtml('statT0Label', _tokenLabelHtml(t0Sym, pos.token0 || '')); _setHtml('statT1Label', _tokenLabelHtml(t1Sym, pos.token1 || ''));
  _setText('statShare0Label', 'Pool Share ' + t0Sym); _setText('statShare1Label', 'Pool Share ' + t1Sym);
  _setText('cl0', '\u25A0 ' + t0Sym + ': 50%');
  _setText('cl1', '\u25A0 ' + t1Sym + ': 50%');
  _setText('wsPool', t0Sym + ' / ' + t1Sym + ' \u00B7 ' + (pos.fee / 10000).toFixed(2) + '%');
  _setText('kpiDeposit', '—');
  const statusEl = g('curPosStatus'); if (statusEl) {
    const closed = pos.liquidity !== undefined && pos.liquidity !== null && String(pos.liquidity) === '0';
    statusEl.textContent = closed ? 'CLOSED' : 'ACTIVE'; statusEl.className = '9mm-pos-mgr-pos-status ' + (closed ? 'closed' : 'active');
  }
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

/** Exit closed-position view and navigate back to the bot's active position. */
export async function returnToActivePosition() {
  _exitClosedViewIfActive();
  let tid = null;
  try { tid = (await (await fetch('/api/status')).json()).activePosition?.tokenId; } catch { /* */ }
  const findIdx = tid
    ? posStore.entries.findIndex(e => e.positionType === 'nft' && String(e.tokenId) === String(tid))
    : posStore.entries.findIndex(e => !_isPositionClosed(e));
  if (findIdx >= 0 && findIdx !== posStore.activeIdx) posStore.select(findIdx);
  updatePosStripUI();
  const active = posStore.getActive(); if (!active) return;
  _applyPositionConfig(active); _applyLocalPositionData(active);
  if (_positionRangeVisual) _positionRangeVisual();
  if (_updateRouteForPosition) _updateRouteForPosition(active);
}

/** Select the bot's active position, apply config, and update the URL (manual scan only). */
async function _syncAfterManualScan() {
  try { const tid = (await (await fetch('/api/status')).json()).activePosition?.tokenId;
    if (tid) { const i = posStore.entries.findIndex(e => e.positionType === 'nft' && String(e.tokenId) === String(tid)); if (i >= 0 && i !== posStore.activeIdx) posStore.select(i); }
  } catch { /* next poll will sync */ }
  const active = posStore.getActive(); if (!active) return;
  _applyPositionConfig(active); _applyLocalPositionData(active);
  if (_positionRangeVisual) _positionRangeVisual();
  if (_syncRouteToState) _syncRouteToState(active);
}

/**
 * Scan the current wallet for LP positions via the server API.
 * @param {object} [opts]  Options.
 * @param {boolean} [opts.navigate=true]  After scan, select the bot's active position,
 *   apply config, and update the URL.  Pass `false` for automatic scans (wallet
 *   import/restore) — the 3-second polling loop handles all of that instead.
 */
export async function scanPositions(opts) {
  const navigate = !opts || opts.navigate !== false;
  if (!wallet.address) {
    act('\u26A0', 'alert', 'No wallet loaded', 'Import a wallet first to scan for positions');
    return;
  }
  const btn = g('posScanBtn');
  if (btn) { btn.disabled = true; btn.textContent = '\u27F3 Scanning\u2026'; }

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
    act('\u{1F50D}', 'start', 'Scan complete',
      `Found ${nftCount} NFT positions. Added ${added} new.`);
    if (navigate) updatePosStripUI();
    if (nftCount === 0) _showNoPositionsDialog();

    // Manual scans (position browser): sync to bot's active position + navigate.
    // Automatic scans (wallet import/restore): skip — the poll loop does this.
    if (navigate) await _syncAfterManualScan();
  } catch (e) {
    act('\u26A0', 'alert', 'Scan failed', e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '\u27F3 Scan Wallet'; }
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
      contractAddress: data.positionManagerAddress || null,
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
