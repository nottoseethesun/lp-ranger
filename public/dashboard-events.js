/**
 * @file dashboard-events.js
 * @description Centralized event binding for the 9mm v3 Position Manager
 * dashboard.  Replaces all inline HTML event handlers (onclick, oninput,
 * onchange, onkeydown) with addEventListener calls and event delegation.
 *
 * Called once from dashboard-init.js after all modules are loaded.
 */

import { g, toggleHelpPopover, toggleSettingsPopover, clearLocalStorageAndCookies } from './dashboard-helpers.js';
import {
  closeWalletModal, wTab, copyText, generateWallet, checkPasswordMatch,
  confirmWallet, validateSeed, onSeedConfirmChange, importSeed,
  validateKey, onKeyConfirmChange, importKey, closeRevealModal, revealWallet,
  openRevealModal, clearWalletUI, closeClearWalletModal, confirmClearWallet,
  openWalletModal,
} from './dashboard-wallet.js';
import {
  openPosBrowser, closePosBrowser, renderPosBrowser, scanPositions,
  posChangePage, activateSelectedPos, removeSelectedPos, posRowClick,
  returnToActivePosition, toggleShowClosed, toggleOpenInNewTab,
} from './dashboard-positions.js';
import {
  onParamChange, saveOorThreshold, saveOorTimeout, applyAll, checkApplyDirty, saveMinInterval, saveMaxReb, saveSlippage, saveCheckInterval,
  openRebalanceRangeModal, closeRebalanceRangeModal, updateRebalanceRangeHint,
  confirmRebalanceRange,
} from './dashboard-throttle.js';
import {
  toggleInitialDeposit, saveInitialDeposit, toggleRealizedInput, saveRealizedGains,
  toggleCurDeposit, saveCurDeposit, toggleCurRealized, saveCurRealized,
} from './dashboard-data.js';
import { rebChangePage, pnlChangePage } from './dashboard-history.js';
import { isViewingClosedPos } from './dashboard-closed-pos.js';
import { showILDebug } from './dashboard-il-debug.js';

/**
 * Bind a click handler to an element by ID.
 * @param {string}   id  Element ID.
 * @param {Function} fn  Click handler.
 */
function _click(id, fn) {
  const el = g(id);
  if (el) el.addEventListener('click', fn);
}

/**
 * Bind an input handler to an element by ID.
 * @param {string}   id  Element ID.
 * @param {Function} fn  Input handler.
 */
function _input(id, fn) {
  const el = g(id);
  if (el) el.addEventListener('input', fn);
}

/**
 * Bind a change handler to an element by ID.
 * @param {string}   id  Element ID.
 * @param {Function} fn  Change handler.
 */
function _change(id, fn) {
  const el = g(id);
  if (el) el.addEventListener('change', fn);
}

/** localStorage key for persisted RPC URL. */
const _RPC_KEY = '9mm_rpc_url';

/**
 * Persist the current RPC URL to localStorage.
 * @param {string} url  RPC URL to save.
 */
function _saveRpc(url) {
  try { localStorage.setItem(_RPC_KEY, url); } catch { /* private mode */ }
}

/** Wire up all static event handlers and event delegation. */
export function bindAllEvents() {
  // ── Wallet modal ──────────────────────────────────────────────────────────
  _click('wtab-generate', () => wTab('generate'));
  _click('wtab-seed',     () => wTab('seed'));
  _click('wtab-key',      () => wTab('key'));

  // Close buttons (multiple modals share the pattern)
  document.querySelectorAll('#walletModal [class~="9mm-pos-mgr-modal-close-btn"]').forEach(btn => {
    btn.addEventListener('click', closeWalletModal);
  });

  // Generate tab
  _click('genBtn', generateWallet);
  _input('genPassword',        () => checkPasswordMatch('gen'));
  _input('genPasswordConfirm', () => checkPasswordMatch('gen'));
  _click('genConfirmBtn', confirmWallet);

  // Copy buttons (by data attribute)
  document.querySelectorAll('.copy-btn[data-copy-id]').forEach(btn => {
    btn.addEventListener('click', () => copyText(btn.dataset.copyId));
  });
  // Fallback: copy buttons adjacent to elements with known IDs
  _bindCopyBtn('genAddr');
  _bindCopyBtn('genMnemonic');
  _bindCopyBtn('genKey');
  _bindCopyBtn('revealKey');
  _bindCopyBtn('revealMnemonic');

  // Seed tab
  _input('seedInput', validateSeed);
  _input('seedPath', validateSeed);
  _change('seedConfirmCheck', onSeedConfirmChange);
  _input('seedPassword',        () => checkPasswordMatch('seed'));
  _input('seedPasswordConfirm', () => checkPasswordMatch('seed'));
  _click('seedImportBtn', importSeed);

  // Key tab
  _input('keyInput', validateKey);
  _change('keyConfirmCheck', onKeyConfirmChange);
  _input('keyPassword',        () => checkPasswordMatch('key'));
  _input('keyPasswordConfirm', () => checkPasswordMatch('key'));
  _click('keyImportBtn', importKey);

  // ── Reveal key modal ──────────────────────────────────────────────────────
  document.querySelectorAll('#revealModal [class~="9mm-pos-mgr-modal-close-btn"]').forEach(btn => {
    btn.addEventListener('click', closeRevealModal);
  });
  const revealPw = g('revealPassword');
  if (revealPw) revealPw.addEventListener('keydown', e => { if (e.key === 'Enter') revealWallet(); });
  _click('revealBtn', revealWallet);

  // ── Clear wallet modal ────────────────────────────────────────────────────
  document.querySelectorAll('#clearWalletModal .modal-btn.secondary').forEach(btn => {
    btn.addEventListener('click', closeClearWalletModal);
  });
  document.querySelectorAll('#clearWalletModal [class~="9mm-pos-mgr-btn-danger"]').forEach(btn => {
    btn.addEventListener('click', confirmClearWallet);
  });

  // ── Position browser modal ────────────────────────────────────────────────
  document.querySelectorAll('#posBrowserModal [class~="9mm-pos-mgr-modal-close-btn"]').forEach(btn => {
    btn.addEventListener('click', closePosBrowser);
  });
  _input('posSearchInput', renderPosBrowser);
  _click('posScanBtn', scanPositions);

  // "Import Wallet" button inside position browser
  document.querySelectorAll('#posBrowserModal [class~="9mm-pos-mgr-btn-green"]').forEach(btn => {
    btn.addEventListener('click', openWalletModal);
  });

  _click('posPrevBtn', () => posChangePage(-1));
  _click('posNextBtn', () => posChangePage(1));
  _click('posSelectBtn', activateSelectedPos);
  _click('posRemoveBtn', removeSelectedPos);

  // Event delegation for position rows (dynamically generated)
  const posList = g('posList');
  if (posList) {
    posList.addEventListener('click', e => {
      const row = e.target.closest('[data-pos-idx]');
      if (row) posRowClick(parseInt(row.dataset.posIdx, 10));
    });
  }

  // ── Closed-position history banner ─────────────────────────────────────
  _click('closedPosReturnBtn', () => {
    if (isViewingClosedPos()) returnToActivePosition();
  });

  // ── Pool Details modal + Manage toggle ───────────────────────────────────
  _click('poolDetailsBtn', _openPoolDetailsModal);
  _click('manageToggleBtn', _toggleManagePosition);

  // ── Position Browser toggles ────────────────────────────────────────────
  _click('posClosedToggle', toggleShowClosed);
  _click('posNewTabToggle', toggleOpenInNewTab);

  // ── Header buttons ────────────────────────────────────────────────────────
  document.querySelectorAll('header .pos-browser-btn').forEach(btn => {
    const text = btn.textContent;
    if (text.includes('\u{1F4C2}') || text.includes('Position')) {
      btn.addEventListener('click', openPosBrowser);
    } else if (text.includes('\u27F3') || text.includes('Scan')) {
      btn.addEventListener('click', scanPositions);
    }
  });
  document.querySelectorAll('header .hwbtn').forEach(btn => {
    btn.addEventListener('click', openWalletModal);
  });
  _click('helpBtn', toggleHelpPopover);

  // Help popover close button
  document.querySelectorAll('[class~="9mm-pos-mgr-help-close"]').forEach(btn => {
    btn.addEventListener('click', toggleHelpPopover);
  });

  // Settings popover
  _click('settingsBtn', toggleSettingsPopover);
  _click('clearStorageBtn', clearLocalStorageAndCookies);

  // ── Wallet strip ──────────────────────────────────────────────────────────
  _click('wsRevealBtn', openRevealModal);
  _click('wsClearBtn', clearWalletUI);
  const posSummary = document.querySelector('.ws-pos-summary');
  if (posSummary) posSummary.addEventListener('click', openPosBrowser);

  // ── Privacy toggle ────────────────────────────────────────────────────────
  const privSwitch = g('privacySwitch');
  if (privSwitch) privSwitch.addEventListener('change', _togglePrivacy);

  // ── KPI / P&L section ─────────────────────────────────────────────────────
  _click('initialDepositLabel', toggleInitialDeposit);
  _change('initialDepositInput', saveInitialDeposit);
  // Save button for initial deposit (use querySelector within the row)
  const depSaveBtn = document.querySelector('#initialDepositRow .realized-gains-save');
  if (depSaveBtn) depSaveBtn.addEventListener('click', saveInitialDeposit);

  _click('realizedGainsLabel', toggleRealizedInput);
  _change('realizedGainsInput', saveRealizedGains);
  const realSaveBtn = document.querySelector('#realizedGainsRow .realized-gains-save');
  if (realSaveBtn) realSaveBtn.addEventListener('click', saveRealizedGains);

  // Current-position deposit
  _click('curDepositLabel', toggleCurDeposit);
  _change('curDepositInput', saveCurDeposit);
  _click('curDepositSaveBtn', saveCurDeposit);

  // Current-position realized gains
  _click('curRealizedLabel', toggleCurRealized);
  _change('curRealizedInput', saveCurRealized);
  _click('curRealizedSaveBtn', saveCurRealized);

  // ── Bot configuration ─────────────────────────────────────────────────────
  _input('inMinInterval', onParamChange);
  _input('inMaxReb', onParamChange);

  // Track dirty state for Apply All button
  ['inMinInterval', 'inMaxReb', 'inOorThreshold', 'inSlip', 'inInterval', 'inGas', 'inRpc', 'inPM', 'inFactory'].forEach(id => {
    _input(id, checkApplyDirty);
    _change(id, checkApplyDirty);
  });

  // RPC URL combo dropdown + localStorage persistence
  const rpcToggle = g('rpcToggle');
  const rpcList = g('rpcList');
  if (rpcToggle && rpcList) {
    rpcToggle.addEventListener('click', () => rpcList.classList.toggle('open'));
    rpcList.addEventListener('click', e => {
      const li = e.target.closest('[data-rpc]');
      if (!li) return;
      const inp = g('inRpc');
      if (inp) { inp.value = li.dataset.rpc; _saveRpc(inp.value); checkApplyDirty(); }
      rpcList.classList.remove('open');
    });
    document.addEventListener('click', e => {
      if (!e.target.closest('.rpc-combo')) rpcList.classList.remove('open');
    });
  }
  const rpcInput = g('inRpc');
  if (rpcInput) rpcInput.addEventListener('change', () => _saveRpc(rpcInput.value));

  // Save Range Width button (exclude the timeout button)
  document.querySelectorAll('.save-range-btn:not(.save-oor-timeout-btn)').forEach(btn => {
    btn.addEventListener('click', saveOorThreshold);
  });

  // Save OOR Timeout button
  _click('saveOorTimeoutBtn', saveOorTimeout);


  _click('applyAllBtn', applyAll);
  _click('saveMinIntervalBtn', saveMinInterval);
  _click('saveMaxRebBtn', saveMaxReb);
  _click('saveSlipBtn', saveSlippage);
  _click('saveIntervalBtn', saveCheckInterval);

  // ── Throttle info modal ─────────────────────────────────────────────────
  _click('throttleInfoBtn', () => { const m = g('throttleInfoModal'); if (m) m.classList.remove('hidden'); });
  const _closeThrottleInfo = () => { const m = g('throttleInfoModal'); if (m) m.classList.add('hidden'); };
  _click('throttleInfoClose', _closeThrottleInfo);
  _click('throttleInfoOk', _closeThrottleInfo);

  // ── Rebalance with Updated Range modal ──────────────────────────────────
  _click('rebalanceWithRangeBtn', openRebalanceRangeModal);
  _click('rebalanceRangeClose', closeRebalanceRangeModal);
  _click('rebalanceRangeCancelBtn', closeRebalanceRangeModal);
  _click('rebalanceRangeConfirmBtn', confirmRebalanceRange);
  _input('rebalanceRangeInput', updateRebalanceRangeHint);

  // ── Table pagination ─────────────────────────────────────────────────────
  _click('rebPrevBtn', () => rebChangePage(-1));
  _click('rebNextBtn', () => rebChangePage(1));
  _click('pnlPrevBtn', () => pnlChangePage(-1));
  _click('pnlNextBtn', () => pnlChangePage(1));

  // ── IL/G debug popover ──────────────────────────────────────────────────
  _click('curILInfo', () => showILDebug('cur'));
  _click('ltILInfo',  () => showILDebug('lt'));

  // ── Event delegation for dynamically generated elements ───────────────────

  // TX hash copy icons in rebalance events table + activity log
  for (const id of ['rebEventsBody', 'actList']) {
    const el = g(id);
    if (el) el.addEventListener('click', e => {
      const icon = e.target.closest('[data-copy-tx]');
      if (icon) navigator.clipboard.writeText(icon.dataset.copyTx).catch(() => {});
    });
  }

  // Token address copy buttons in stat grid
  const statGrid = document.querySelector('.stat-grid');
  if (statGrid) {
    statGrid.addEventListener('click', e => {
      const btn = e.target.closest('[data-copy-addr]');
      if (btn) {
        navigator.clipboard.writeText(btn.dataset.copyAddr).catch(() => {});
        btn.textContent = '\u2713';
        setTimeout(() => { btn.textContent = '\u274F'; }, 1200);
      }
    });
  }

  // Dismiss dynamic error modals
  document.body.addEventListener('click', e => {
    const btn = e.target.closest('[data-dismiss-modal]');
    if (btn) {
      const overlay = btn.closest('[class*="modal-overlay"]');
      if (overlay) overlay.remove();
    }
  });

  // ── Escape key dismisses all modals ───────────────────────────────────────
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const modals = [
      { id: 'walletModal',         close: closeWalletModal },
      { id: 'posBrowserModal',     close: closePosBrowser },
      { id: 'revealModal',         close: closeRevealModal },
      { id: 'clearWalletModal',    close: closeClearWalletModal },
      { id: 'rebalanceRangeModal', close: closeRebalanceRangeModal },
      { id: 'throttleInfoModal',   close: () => { const m = g('throttleInfoModal'); if (m) m.classList.add('hidden'); } },
    ];
    for (const m of modals) {
      const el = g(m.id);
      if (el && !el.classList.contains('hidden')) { m.close(); return; }
    }
    // Dismiss dynamic error/recovery modals (class starts with digit, use attribute selector)
    const dynModal = document.querySelector('[class*="pos-mgr-modal-overlay"]');
    if (dynModal) { dynModal.remove(); return; }
    // Dismiss help popover
    const pop = g('helpPopover');
    if (pop && pop.classList.contains('9mm-pos-mgr-visible')) {
      toggleHelpPopover(); return;
    }
    // Dismiss settings popover
    const sp = g('settingsPopover');
    if (sp && sp.classList.contains('9mm-pos-mgr-visible')) {
      toggleSettingsPopover();
    }
  });

  // Close settings popover on outside click
  document.addEventListener('click', e => {
    const sp = g('settingsPopover');
    if (sp && sp.classList.contains('9mm-pos-mgr-visible') && !e.target.closest('.9mm-pos-mgr-settings-wrap')) {
      toggleSettingsPopover();
    }
  });
}

/** IDs and selectors of elements that show sensitive addresses/NFT IDs. */
const _PRIVACY_TARGETS = [
  'wsAddr', 'wsToken', 'headerWalletLabel',
  'genAddr', 'genKey', 'genMnemonic',
  'revealAddr', 'revealKey', 'revealMnemonic',
  'seedValidAddr', 'keyValidAddr',
];
const _PRIVACY_SELECTORS = [
  '.pos-row-title', '.pos-row-meta',
  '[data-privacy="blur"]', '.adt',
];

function _togglePrivacy() {
  const on = g('privacySwitch')?.checked;
  const cls = '9mm-pos-mgr-privacy-blur';
  for (const id of _PRIVACY_TARGETS) { const el = g(id); if (el) el.classList.toggle(cls, on); }
  for (const sel of _PRIVACY_SELECTORS) document.querySelectorAll(sel).forEach(el => el.classList.toggle(cls, on));
  const icon = g('privacyIcon'); if (icon) icon.classList.toggle('9mm-pos-mgr-privacy-active', on);
  try { localStorage.setItem('9mm_privacy_mode', on ? '1' : '0'); } catch { /* */ }
}

/** Re-apply privacy blur to dynamically rendered content. Call after DOM updates. */
export function reapplyPrivacyBlur() {
  if (localStorage.getItem('9mm_privacy_mode') !== '1') return;
  const cls = '9mm-pos-mgr-privacy-blur';
  for (const id of _PRIVACY_TARGETS) { const el = g(id); if (el) el.classList.add(cls); }
  for (const sel of _PRIVACY_SELECTORS) document.querySelectorAll(sel).forEach(el => el.classList.add(cls));
}

/** Restore privacy mode from localStorage on page load. */
export function restorePrivacyMode() {
  const on = localStorage.getItem('9mm_privacy_mode') === '1';
  const sw = g('privacySwitch'); if (sw) sw.checked = on;
  if (on) _togglePrivacy();
}

function _bindCopyBtn(id) {
  const el = g(id);
  if (!el) return;
  const btn = el.parentElement?.querySelector('.copy-btn');
  if (btn) btn.addEventListener('click', () => copyText(id));
}

// ── Pool Details modal + Manage toggle handlers ────────────────────────────

function _openPoolDetailsModal() {
  const active = _posStoreRef?.getActive?.();
  if (!active) return;
  const m = g('poolDetailsModal'); if (!m) return;
  const pair = (active.token0Symbol || '?') + '/' + (active.token1Symbol || '?');
  const fee = active.fee ? (active.fee / 10000).toFixed(2) + '%' : '—';
  const el = (id, txt) => { const e = g(id); if (e) e.textContent = txt; };
  el('pdType', active.positionType === 'nft' ? 'NFT (ERC-721)' : 'ERC-20');
  el('pdTokenId', active.tokenId || '—');
  el('pdPair', pair);
  el('pdFee', fee);
  el('pdContract', active.contractAddress || '—');
  m.classList.remove('hidden');
}

let _posStoreRef = null;
/** Inject posStore reference for Pool Details modal (avoids circular dep). */
export function injectPosStoreForEvents(posStore) { _posStoreRef = posStore; }

function _toggleManagePosition() {
  const active = _posStoreRef?.getActive?.();
  if (!active?.tokenId || active.positionType !== 'nft') return;
  const badge = g('manageBadge');
  const isManaged = badge?.classList.contains('managed');
  if (isManaged) {
    // Build composite key and pause
    const w = _posStoreRef.getActive()?.walletAddress;
    const c = active.contractAddress;
    const key = `pulsechain-${w}-${c}-${active.tokenId}`;
    fetch('/api/position/pause', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }) }).catch(() => {});
  } else {
    fetch('/api/position/manage', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokenId: active.tokenId, contract: active.contractAddress }) }).catch(() => {});
  }
}

/** Update the manage badge based on managed positions from status poll. */
export function updateManageBadge(managedList, activeTokenId) {
  const badge = g('manageBadge'); if (!badge) return;
  const btn = g('manageToggleBtn'); if (!btn) return;
  const isManaged = Array.isArray(managedList) && managedList.some(p => String(p.tokenId) === String(activeTokenId) && p.status === 'running');
  badge.classList.toggle('managed', isManaged);
  badge.textContent = isManaged ? 'Being Actively Managed' : 'Not Actively Managed';
  btn.textContent = isManaged ? 'Stop Managing' : 'Manage';
}
