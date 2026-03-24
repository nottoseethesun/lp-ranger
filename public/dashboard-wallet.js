/**
 * @file dashboard-wallet.js
 * @description Wallet management UI for the 9mm v3 Position Manager dashboard.
 * Handles wallet modal tab switching, three-state validation rendering,
 * generate / seed / key import flows, on-chain activity detection, the
 * known-wallet registry, server-side wallet sync, and key reveal.
 *
 * Depends on: dashboard-helpers.js (g, act), ethers-adapter.js (ethers).
 *
 * NOTE: Imports from positions (updatePosStripUI, scanPositions, posStore)
 * are resolved at call time, not at parse time, so the circular reference
 * between wallet and positions is safe.
 */

import { g, act, ACT_ICONS } from './dashboard-helpers.js';
import { ethers } from './ethers-adapter.js';

// Late-bound imports to avoid circular dep at evaluation time.
// Populated by dashboard-init.js after all modules load.
let _updatePosStripUI = null;
let _scanPositions = null;
let _posStore = null;
let _updateRouteForWallet = null, _syncRouteToState = null;
let _resolvePendingRoute = null;
let _clearPositionDisplay = null;
let _resetPollingState = null;
let _clearHistory = null;
let _getPendingRouteWallet = null;

/** Inject position-module references. Called once from dashboard-init.js. */
export function injectWalletDeps(deps) {
  _updatePosStripUI = deps.updatePosStripUI;
  _scanPositions = deps.scanPositions;
  _posStore = deps.posStore;
  if (deps.updateRouteForWallet) _updateRouteForWallet = deps.updateRouteForWallet;
  if (deps.syncRouteToState) _syncRouteToState = deps.syncRouteToState;
  if (deps.resolvePendingRoute) _resolvePendingRoute = deps.resolvePendingRoute;
  if (deps.clearPositionDisplay) _clearPositionDisplay = deps.clearPositionDisplay;
  if (deps.resetPollingState) _resetPollingState = deps.resetPollingState;
  if (deps.clearHistory) _clearHistory = deps.clearHistory;
  if (deps.getPendingRouteWallet) _getPendingRouteWallet = deps.getPendingRouteWallet;
}

// ── Wallet state ────────────────────────────────────────────────────────────

/** Active wallet data. Mutated by import flows. */
export const wallet = { address: null, privateKey: null, mnemonic: null, source: null };

/**
 * Set of lowercase wallet addresses seen in this browser session.
 * Populated from posStore entries on load and from each successful import.
 * Also populated by on-chain activity detection.
 */
export const knownWallets = new Set();

/**
 * Register an address as known. Accepts any casing.
 * @param {string} address  Checksummed or lowercased address.
 */
export function markWalletKnown(address) {
  if (address) knownWallets.add(address.toLowerCase());
}

/**
 * Return true if the address has been seen (session or on-chain).
 * @param {string} address
 * @returns {boolean}
 */
export function isKnownWallet(address) {
  return address ? knownWallets.has(address.toLowerCase()) : false;
}

/** Remove positions from other wallets and reset display if any were purged. */
function _purgeOtherWalletPositions(address) {
  if (!_posStore || !address) return false;
  const addr = address.toLowerCase();
  let purged = false;
  for (let i = _posStore.count() - 1; i >= 0; i--) {
    if (_posStore.entries[i].walletAddress.toLowerCase() !== addr) {
      _posStore.remove(i);
      purged = true;
    }
  }
  if (purged) {
    if (_clearPositionDisplay) _clearPositionDisplay();
    if (_resetPollingState) _resetPollingState();
    if (_clearHistory) _clearHistory();
  }
  return purged;
}

/** Clear all positions and reset all wallet-specific display state. */
function _clearAllPositionState() {
  if (_posStore) { while (_posStore.count() > 0) _posStore.remove(0); }
  if (_clearPositionDisplay) _clearPositionDisplay();
  if (_resetPollingState) _resetPollingState();
  if (_clearHistory) _clearHistory();
}

// ── On-chain activity check ─────────────────────────────────────────────────

/** Get the RPC URL from the config input or use the PulseChain default. */
export function getRpcUrl() {
  const el = g('inRpc');
  return (el && el.value.trim()) || 'https://rpc-pulsechain.g4mm4.io';
}

/** Check if an address has on-chain activity (getTransactionCount > 0). */
async function hasOnChainActivity(address) {
  try {
    const provider = new ethers.JsonRpcProvider(getRpcUrl());
    const txCount  = await provider.getTransactionCount(address);
    return txCount > 0;
  } catch {
    return false;
  }
}

// ── Tab switcher ────────────────────────────────────────────────────────────

/**
 * Switch the active tab inside the wallet modal.
 * @param {string} t  Tab key: 'generate' | 'seed' | 'key'
 */
export function wTab(t) {
  ['generate', 'seed', 'key'].forEach(k => {
    g('wtab-' + k).className  = 'modal-tab' + (k === t ? ' active' : '');
    g('wpanel-' + k).className = 'modal-panel' + (k === t ? ' active' : '');
  });
}

// ── Shared validation-status renderer ───────────────────────────────────────

/** Render the three-state validation badge and confirmation panel. */
function wvSetStatus(stateId, state, title, detail, address) {
  const statusEl = g(stateId + 'ValidStatus'), titleEl = g(stateId + 'ValidTitle');
  const detailEl = g(stateId + 'ValidDetail'), addrEl = g(stateId + 'ValidAddr');
  const confirmEl = g(stateId + 'ConfirmPanel');
  if (!statusEl) return;
  const ICON = {
    'neutral':     '\u{1F4AC}',
    'invalid':     '\u2717',
    'valid-known': '\u2713',
    'valid-new':   '\u26A0',
  };

  statusEl.className = 'wv-status ' + state;
  statusEl.querySelector('.wv-status-icon').textContent = ICON[state];
  if (titleEl)  titleEl.textContent  = title;
  if (detailEl) detailEl.textContent = detail;
  if (addrEl)   addrEl.textContent   = address || '';

  if (confirmEl) {
    confirmEl.style.display = (state === 'valid-new') ? 'block' : 'none';
    if (state !== 'valid-new') {
      const cb = confirmEl.querySelector('input[type=checkbox]');
      if (cb) cb.checked = false;
    }
  }
}

/** Check if import is allowed for the given validation state. */
function wvIsImportAllowed(state, stateId) {
  if (state === 'valid-known') return true;
  if (state === 'valid-new') { const cb = g(stateId + 'ConfirmCheck'); return cb ? cb.checked : false; }
  return false;
}

// ── Server wallet sync ──────────────────────────────────────────────────────

/**
 * Send the wallet to the server for encrypted storage.
 * @param {object} w        Wallet data (address, privateKey, mnemonic, source).
 * @param {string} password Session password for encryption.
 * @returns {Promise<boolean>} True if server accepted the wallet.
 */
async function sendWalletToServer(w, password) {
  try {
    const res = await fetch('/api/wallet', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        address:    w.address,
        privateKey: w.privateKey,
        mnemonic:   w.mnemonic || null,
        source:     w.source,
        password,
      }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    return true;
  } catch (e) {
    act(ACT_ICONS.warn, 'alert', 'Server Sync Failed', e.message);
    return false;
  }
}

/** Map password field prefix to its import button ID. */
const _PW_BTN_MAP = {
  gen: 'genConfirmBtn', seed: 'seedImportBtn',
  key: 'keyImportBtn',
};

function _passwordsMatch(prefix) {
  const pw   = g(prefix + 'Password');
  const conf = g(prefix + 'PasswordConfirm');
  return !!(pw && conf && pw.value && conf.value && pw.value === conf.value);
}

/** Check password match, update hint label, and enable/disable import button. */
export function checkPasswordMatch(prefix) {
  const pw   = g(prefix + 'Password');
  const conf = g(prefix + 'PasswordConfirm');
  const hint = g(prefix + 'PwMatch');
  const btn  = g(_PW_BTN_MAP[prefix]);
  if (!pw || !conf || !hint) return;

  const a = pw.value;
  const b = conf.value;
  const match = a && b && a === b;

  // Button requires both matching passwords AND valid wallet credentials
  if (btn) btn.disabled = !match || !wallet._pending;

  if (!a && !b) {
    hint.textContent = '';
    return;
  }
  if (a && !b) {
    hint.textContent = 'Please confirm your password';
    hint.style.color = 'var(--warn)';
    return;
  }
  if (match) {
    hint.textContent = '\u2713 Passwords match';
    hint.style.color = 'var(--accent3)';
  } else {
    hint.textContent = '\u2717 Passwords do not match';
    hint.style.color = 'var(--danger)';
  }
}

/** Read the session password from the active wallet tab (empty if mismatched). */
function getActivePassword() {
  const prefixes = ['gen', 'seed', 'key'];
  for (const prefix of prefixes) {
    const el   = g(prefix + 'Password');
    const conf = g(prefix + 'PasswordConfirm');
    if (el && el.offsetParent !== null && el.value.trim()) {
      if (!conf || conf.value !== el.value) return '';
      return el.value.trim();
    }
  }
  return '';
}

// ── Generate ────────────────────────────────────────────────────────────────

/** Generate a new random wallet and display the result. */
export async function generateWallet() {
  try {
    const w = ethers.Wallet.createRandom();
    g('genAddr').textContent     = w.address;
    g('genMnemonic').textContent = w.mnemonic.phrase;
    g('genKey').textContent      = w.privateKey;
    g('genResult').style.display   = 'block';
    g('genConfirmBtn').style.display = 'block';
    g('genPwField').style.display = 'block';
    g('genBtn').textContent = 'Regenerate';
    wallet._pending = {
      address: w.address, privateKey: w.privateKey,
      mnemonic: w.mnemonic.phrase, source: 'generated',
    };
  } catch (e) { alert('Error: ' + e.message); }
}

/**
 * Confirm the pending wallet — encrypts on server, copies _pending into
 * the active wallet, updates the UI, and closes the modal.
 */
export async function confirmWallet() {
  const p = wallet._pending;
  if (!p) return;

  const password = getActivePassword();
  if (!password) {
    alert('Please set a session password and confirm it (both fields must match).');
    return;
  }

  const ok = await sendWalletToServer(p, password);
  if (!ok) {
    alert('Failed to sync wallet to server. Check the activity log.');
    return;
  }

  wallet.address    = p.address;
  wallet.privateKey = p.privateKey;
  wallet.mnemonic   = p.mnemonic;
  wallet.source     = p.source;
  delete wallet._pending;

  const revealBtn = g('wsRevealBtn');
  if (revealBtn) revealBtn.style.display = 'inline-block';
  const clearBtn = g('wsClearBtn');
  if (clearBtn) clearBtn.style.display = 'inline-block';

  _clearAllPositionState();
  applyWalletUI();
  closeWalletModal();

  const routeResolved = _resolvePendingRoute ? _resolvePendingRoute() : false;
  if (!routeResolved && _updateRouteForWallet) _updateRouteForWallet(wallet.address);

  // Auto-scan for positions after wallet import (navigate: false — let the
  // polling loop navigate to the bot's real active position once it responds)
  if (_scanPositions) {
    act(ACT_ICONS.scan, 'start', 'Auto-Scanning', 'Looking for LP positions\u2026');
    _scanPositions({ navigate: false });
  }
}

// ── Seed phrase ─────────────────────────────────────────────────────────────

let _validateSeedSeq = 0;

/** Validate the seed phrase input and update the validation badge. */
export async function validateSeed() {
  const seq   = ++_validateSeedSeq;
  const raw   = g('seedInput').value;
  const words = raw.trim().split(/\s+/);
  const btn   = g('seedImportBtn');

  if (words.length !== 12 && words.length !== 24) {
    const n = raw.trim() ? words.length : 0;
    wvSetStatus('seed', 'neutral',
      n ? `${n} word${n !== 1 ? 's' : ''} \u2014 need 12 or 24` : 'Waiting for input',
      'Enter 12 or 24 space-separated BIP-39 words');
    btn.disabled = true;
    return;
  }

  try {
    const path = g('seedPath').value.trim() || "m/44'/60'/0'/0/0";
    const w    = ethers.HDNodeWallet.fromPhrase(raw.trim(), undefined, path);
    const addr = w.address;
    wallet._pending = {
      address: addr, privateKey: w.privateKey,
      mnemonic: raw.trim(), source: 'seed',
    };

    let known = isKnownWallet(addr);
    if (!known) {
      wvSetStatus('seed', 'neutral', 'Checking on-chain\u2026',
        'Querying balance for ' + addr.slice(0, 12) + '\u2026', addr);
      btn.disabled = true;
      known = await hasOnChainActivity(addr);
      if (seq !== _validateSeedSeq) return;
      if (known) markWalletKnown(addr);
    }

    const state = known ? 'valid-known' : 'valid-new';
    wvSetStatus('seed', state, known ? '\u2713 Valid phrase \u2014 existing wallet' : '\u26A0 Valid phrase \u2014 not yet known',
      known ? '\u2713 On-chain activity found \u2014 safe to import.' : 'Not seen before. Confirm below.', addr);
    btn.disabled = !wvIsImportAllowed(state, 'seed') || !_passwordsMatch('seed');
  } catch (e) {
    if (seq !== _validateSeedSeq) return;
    wvSetStatus('seed', 'invalid', 'Invalid seed phrase', e.message.slice(0, 80));
    wallet._pending = null;
    btn.disabled = true;
  }
}

/** Handle seed confirm checkbox change. */
export function onSeedConfirmChange() {
  const btn = g('seedImportBtn');
  if (btn) btn.disabled = !wvIsImportAllowed('valid-new', 'seed') || !_passwordsMatch('seed');
}

/** Import wallet from seed phrase. */
export async function importSeed() { await confirmWallet(); }

// ── Private key ─────────────────────────────────────────────────────────────

let _validateKeySeq = 0;

/** Validate the private key input and update the validation badge. */
export async function validateKey() {
  const seq = ++_validateKeySeq;
  const raw = g('keyInput').value.trim();
  const hex = raw.startsWith('0x') ? raw.slice(2) : raw;
  const btn = g('keyImportBtn');

  if (!raw) {
    wvSetStatus('key', 'neutral', 'Waiting for input', '64 hex characters expected');
    btn.disabled = true;
    return;
  }

  if (hex.length !== 64 || !/^[0-9a-fA-F]+$/.test(hex)) {
    const msg = hex.length !== 64
      ? `${hex.length} hex chars \u2014 need exactly 64`
      : 'Non-hex characters detected';
    wvSetStatus('key', 'invalid', 'Invalid private key', msg);
    wallet._pending = null;
    btn.disabled = true;
    return;
  }

  try {
    const w    = new ethers.Wallet('0x' + hex);
    const addr = w.address;
    wallet._pending = {
      address: addr, privateKey: '0x' + hex,
      mnemonic: null, source: 'key',
    };

    let known = isKnownWallet(addr);
    if (!known) {
      wvSetStatus('key', 'neutral', 'Checking on-chain\u2026',
        'Querying balance for ' + addr.slice(0, 12) + '\u2026', addr);
      btn.disabled = true;
      known = await hasOnChainActivity(addr);
      if (seq !== _validateKeySeq) return;
      if (known) markWalletKnown(addr);
    }

    const state = known ? 'valid-known' : 'valid-new';
    wvSetStatus('key', state, known ? '\u2713 Valid key \u2014 existing wallet' : '\u26A0 Valid key \u2014 not yet known',
      known ? '\u2713 On-chain activity found \u2014 safe to import.' : 'Not seen before. Confirm below.', addr);
    btn.disabled = !wvIsImportAllowed(state, 'key') || !_passwordsMatch('key');
  } catch (e) {
    if (seq !== _validateKeySeq) return;
    wvSetStatus('key', 'invalid', 'Invalid private key', e.message.slice(0, 80));
    wallet._pending = null;
    btn.disabled = true;
  }
}

/** Handle key confirm checkbox change. */
export function onKeyConfirmChange() {
  const btn = g('keyImportBtn');
  if (btn) btn.disabled = !wvIsImportAllowed('valid-new', 'key') || !_passwordsMatch('key');
}

/** Import wallet from private key. */
export async function importKey() { await confirmWallet(); }

// ── Reveal key modal ────────────────────────────────────────────────────────

/** Auto-hide timer for revealed secrets. */
let _revealTimer = null;

/** Open the reveal-key modal (checks wallet file exists first). */
export async function openRevealModal() {
  if (!wallet.address) { act(ACT_ICONS.warn, 'alert', 'No Wallet Loaded', 'Import a wallet first'); return; }
  try { const st = await (await fetch('/api/wallet/status')).json(); if (!st.fileExists) { _showWalletFileGoneDialog(); return; }
  } catch { /* server unreachable — fall through */ }
  g('revealPassword').value = '';
  g('revealResult').style.display = 'none'; g('revealError').style.display = 'none';
  g('revealBtn').disabled = false; g('revealModal').className = 'modal-overlay';
}

function _showWalletFileGoneDialog() {
  const id = '9mm-wallet-gone-modal';
  if (document.getElementById(id)) return;
  const o = document.createElement('div'); o.className = '9mm-pos-mgr-modal-overlay'; o.id = id;
  o.innerHTML = '<div class="9mm-pos-mgr-modal 9mm-pos-mgr-modal-warning"><h3>Wallet file not found</h3>' +
    '<p>The encrypted wallet file has been deleted (e.g. via <code>npm run clean</code>). Re-import your wallet to continue.</p>' +
    '<button class="9mm-pos-mgr-modal-close" data-dismiss-modal>OK</button></div>';
  o.querySelector('[data-dismiss-modal]').addEventListener('click', () => { o.remove(); openWalletModal(); });
  document.body.appendChild(o);
}

/** Close the reveal-key modal and clear displayed secrets. */
export function closeRevealModal() {
  g('revealModal').className = 'modal-overlay hidden';
  g('revealKey').textContent      = '\u2014';
  g('revealMnemonic').textContent = '\u2014';
  g('revealResult').style.display = 'none';
  if (_revealTimer) { clearTimeout(_revealTimer); _revealTimer = null; }
}

/**
 * Reveal the wallet key by sending the password to the server for decryption.
 * Secrets are displayed for 60 seconds then auto-hidden.
 */
export async function revealWallet() {
  const password = g('revealPassword').value.trim();
  if (!password) return;

  const btn = g('revealBtn');
  const err = g('revealError');
  btn.disabled = true;
  btn.textContent = 'Decrypting\u2026';
  err.style.display = 'none';

  try {
    const res  = await fetch('/api/wallet/reveal', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ password }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);

    g('revealAddr').textContent = data.address;
    g('revealKey').textContent  = data.privateKey;

    if (data.mnemonic) {
      g('revealMnemonic').textContent       = data.mnemonic;
      g('revealMnemonicSection').style.display = 'block';
      g('revealNoMnemonic').style.display      = 'none';
    } else {
      g('revealMnemonicSection').style.display = 'none';
      g('revealNoMnemonic').style.display      = 'block';
    }

    g('revealResult').style.display = 'block';

    // Auto-hide after 60 seconds
    if (_revealTimer) clearTimeout(_revealTimer);
    _revealTimer = setTimeout(() => {
      g('revealResult').style.display  = 'none';
      g('revealKey').textContent       = '\u2014';
      g('revealMnemonic').textContent  = '\u2014';
      act(ACT_ICONS.lock, 'wallet', 'Key Auto-Hidden', 'Revealed key hidden after 60s timeout');
    }, 60_000);
  } catch (e) {
    err.textContent   = e.message;
    err.style.display = 'block';
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Reveal';
  }
}

// ── Apply & close ───────────────────────────────────────────────────────────

/**
 * Update the wallet strip and header with the current wallet state.
 * Registers the address as known for future import checks.
 */
export function applyWalletUI() {
  if (!wallet.address) {
    g('wsAddr').textContent  = 'No Wallet Loaded';
    g('wsBadge').textContent = 'NOT SET';
    g('wsBadge').className   = 'ws-badge none';
    g('headerWalletLabel').textContent = 'Set Wallet';
    if (_updatePosStripUI) _updatePosStripUI();
    return;
  }
  const addr  = wallet.address;
  const short = addr.slice(0, 8) + '\u2026' + addr.slice(-6);
  g('wsAddr').textContent  = addr;
  g('wsBadge').textContent = wallet.source === 'generated' ? 'GENERATED'
    : wallet.source === 'seed' ? 'SEED IMPORT' : 'KEY IMPORT';
  g('wsBadge').className = 'ws-badge ' + (wallet.source === 'key' ? 'imp' : 'gen');
  g('headerWalletLabel').textContent = short;

  const revealBtn = g('wsRevealBtn');
  if (revealBtn) revealBtn.style.display = 'inline-block';
  const clrBtn = g('wsClearBtn');
  if (clrBtn) clrBtn.style.display = 'inline-block';

  markWalletKnown(addr);
  act(ACT_ICONS.diamond, 'wallet', 'Wallet Loaded', short + ' (' + wallet.source + ')');
  if (_updatePosStripUI) _updatePosStripUI();
  // Sync URL with restored position (restoreLastPosition runs before wallet loads)
  const active = _posStore?.getActive?.();
  if (active && _syncRouteToState) _syncRouteToState(active);
}

/** Open the wallet modal. */
export function openWalletModal() { g('walletModal').className = 'modal-overlay'; }

/** Close the wallet modal. */
export function closeWalletModal() { g('walletModal').className = 'modal-overlay hidden'; }

/**
 * Copy the text content of an element to the clipboard.
 * @param {string} id  Element id whose textContent to copy.
 */
export function copyText(id) {
  const el = g(id);
  if (!el) return;
  navigator.clipboard.writeText(el.textContent).catch(() => {});
  const btn = el.parentElement.querySelector('.copy-btn');
  if (btn) {
    btn.textContent = 'copied!';
    setTimeout(() => { btn.textContent = 'copy'; }, 1500);
  }
}

// ── Init: check server wallet status on load ────────────────────────────────

/** Restore a server-persisted wallet. Checks URL/server wallet mismatch. */
function _restoreServerWallet(data) {
  // If the URL requests a different wallet, don't load the server's wallet.
  const pendingWallet = _getPendingRouteWallet ? _getPendingRouteWallet() : null;
  if (pendingWallet && pendingWallet !== data.address.toLowerCase()) {
    _clearAllPositionState();
    applyWalletUI();
    openWalletModal();
    return;
  }

  wallet.address = data.address;
  wallet.source  = data.source;
  const revealBtn = g('wsRevealBtn');
  if (revealBtn) revealBtn.style.display = 'inline-block';
  const clearBtn = g('wsClearBtn');
  if (clearBtn) clearBtn.style.display = 'inline-block';

  _purgeOtherWalletPositions(data.address);
  applyWalletUI();
  const routeResolved = _resolvePendingRoute ? _resolvePendingRoute() : false;
  // Don't navigate to posStore's active position here — it may be stale
  // (e.g. a closed NFT from localStorage). The polling loop's
  // setBotActiveTokenId will navigate to the bot's real active position.
  const _active = _posStore?.getActive?.();
  if (!routeResolved && !_active && _updateRouteForWallet) {
    _updateRouteForWallet(data.address);
  }

}

/**
 * On page load, check if the server already has a wallet loaded
 * (e.g. from a previous session before page refresh).
 */
export async function checkServerWalletStatus() {
  try {
    const res  = await fetch('/api/wallet/status');
    const data = await res.json();
    if (data.loaded && data.address) {
      _restoreServerWallet(data);
    } else {
      _clearAllPositionState();
      applyWalletUI();
      openWalletModal();
    }
  } catch {
    // Server not available yet — leave current state as-is
  }
}

/** Show the "Are you sure?" confirmation modal before clearing wallet. */
export function clearWalletUI() {
  const modal = g('clearWalletModal');
  if (modal) modal.className = 'modal-overlay';
}

/** Close the clear wallet confirmation modal. */
export function closeClearWalletModal() {
  const modal = g('clearWalletModal');
  if (modal) modal.className = 'modal-overlay hidden';
}

/** Execute wallet clear after user confirms. */
export async function confirmClearWallet() {
  closeClearWalletModal();
  try {
    await fetch('/api/wallet', { method: 'DELETE' });
  } catch { /* server unavailable */ }
  wallet.address    = null;
  wallet.privateKey = null;
  wallet.source     = null;
  wallet.mnemonic   = null;
  const revealBtn = g('wsRevealBtn');
  if (revealBtn) revealBtn.style.display = 'none';
  const clearBtn = g('wsClearBtn');
  if (clearBtn) clearBtn.style.display = 'none';

  _clearAllPositionState();
  try { localStorage.removeItem('9mm_posStore'); } catch { /* private mode */ }
  try { localStorage.removeItem('9mm_realized_gains'); } catch { /* private mode */ }

  applyWalletUI();
  if (_updateRouteForWallet) _updateRouteForWallet(null);
  act(ACT_ICONS.clear, 'wallet', 'Wallet Cleared', 'All wallet data removed from server and browser');
}
