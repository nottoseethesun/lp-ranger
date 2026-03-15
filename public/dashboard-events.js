/**
 * @file dashboard-events.js
 * @description Centralized event binding for the 9mm v3 Position Manager
 * dashboard.  Replaces all inline HTML event handlers (onclick, oninput,
 * onchange, onkeydown) with addEventListener calls and event delegation.
 *
 * Called once from dashboard-init.js after all modules are loaded.
 */

import { g, toggleHelpPopover } from './dashboard-helpers.js';
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
} from './dashboard-positions.js';
import {
  setTType, onParamChange, saveRangeWidth, applyAll,
  TRIGGER_OOR, TRIGGER_EDGE, TRIGGER_TIME,
} from './dashboard-throttle.js';
import {
  optUrlChanged, optPing, optTogglePolling, optQueryNow,
  optToggleAutoApply, optApplyLast,
} from './dashboard-optimizer.js';
import {
  toggleInitialDeposit, saveInitialDeposit, toggleRealizedInput, saveRealizedGains,
} from './dashboard-data.js';
import { rebChangePage } from './dashboard-history.js';

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

  // ── Wallet strip ──────────────────────────────────────────────────────────
  _click('wsRevealBtn', openRevealModal);
  _click('wsClearBtn', clearWalletUI);
  const posSummary = document.querySelector('.ws-pos-summary');
  if (posSummary) posSummary.addEventListener('click', openPosBrowser);

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

  // ── Bot configuration ─────────────────────────────────────────────────────
  _click('tb-oor',  () => setTType(TRIGGER_OOR));
  _click('tb-edge', () => setTType(TRIGGER_EDGE));
  _click('tb-time', () => setTType(TRIGGER_TIME));

  _input('inMinInterval', onParamChange);
  _input('inMaxReb', onParamChange);

  // Save Range Width button
  document.querySelectorAll('.save-range-btn').forEach(btn => {
    btn.addEventListener('click', saveRangeWidth);
  });

  _click('applyAllBtn', applyAll);

  // ── Rebalance events pagination ───────────────────────────────────────────
  _click('rebPrevBtn', () => rebChangePage(-1));
  _click('rebNextBtn', () => rebChangePage(1));

  // ── Optimizer ─────────────────────────────────────────────────────────────
  _input('optUrl', optUrlChanged);
  _click('optPingBtn', optPing);
  _click('optToggle', optTogglePolling);
  _click('optQueryBtn', optQueryNow);
  _click('optAutoApplyToggle', optToggleAutoApply);
  _click('optApplyBtn', optApplyLast);

  // ── Event delegation for dynamically generated elements ───────────────────

  // TX hash copy icons in rebalance events table
  const rebEvents = g('rebEventsBody');
  if (rebEvents) {
    rebEvents.addEventListener('click', e => {
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
        setTimeout(() => { btn.textContent = '\u{1F4CB}'; }, 1200);
      }
    });
  }

  // Dismiss dynamic error modals
  document.body.addEventListener('click', e => {
    const btn = e.target.closest('[data-dismiss-modal]');
    if (btn) {
      const overlay = btn.closest('[class~="9mm-pos-mgr-modal-overlay"]');
      if (overlay) overlay.remove();
    }
  });

  // ── Escape key dismisses all modals ───────────────────────────────────────
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const modals = [
      { id: 'walletModal',      close: closeWalletModal },
      { id: 'posBrowserModal',  close: closePosBrowser },
      { id: 'revealModal',      close: closeRevealModal },
      { id: 'clearWalletModal', close: closeClearWalletModal },
    ];
    for (const m of modals) {
      const el = g(m.id);
      if (el && !el.classList.contains('hidden')) { m.close(); return; }
    }
    // Dismiss help popover
    const pop = g('helpPopover');
    if (pop && pop.classList.contains('9mm-pos-mgr-visible')) {
      toggleHelpPopover();
    }
  });
}

/**
 * Bind a copy button adjacent to a display element.
 * @param {string} id  ID of the element whose textContent should be copied.
 */
function _bindCopyBtn(id) {
  const el = g(id);
  if (!el) return;
  const btn = el.parentElement?.querySelector('.copy-btn');
  if (btn) btn.addEventListener('click', () => copyText(id));
}
