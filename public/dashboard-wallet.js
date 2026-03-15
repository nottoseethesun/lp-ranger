/**
 * @file dashboard-wallet.js
 * @description Wallet management UI for the 9mm v3 Position Manager dashboard.
 * Handles wallet modal tab switching, three-state validation rendering,
 * generate / seed / key import flows, on-chain activity detection, the
 * known-wallet registry, server-side wallet sync, and key reveal.
 *
 * Depends on: dashboard-helpers.js (g, act), ethers.js (global from CDN).
 */

/* global g, act, updatePosStripUI, scanPositions, posStore, _9mmPositionMgr */
'use strict';

// ── Wallet state ────────────────────────────────────────────────────────────

/** Active wallet data. Mutated by import flows. */
let wallet = { address: null, privateKey: null, mnemonic: null, source: null };

/**
 * Set of lowercase wallet addresses seen in this browser session.
 * Populated from posStore entries on load and from each successful import.
 * Also populated by on-chain activity detection.
 */
const knownWallets = new Set();

/**
 * Register an address as known. Accepts any casing.
 * @param {string} address  Checksummed or lowercased address.
 */
function markWalletKnown(address) {
  if (address) knownWallets.add(address.toLowerCase());
}

/**
 * Return true if the address has been seen (session or on-chain).
 * @param {string} address
 * @returns {boolean}
 */
function isKnownWallet(address) {
  return address ? knownWallets.has(address.toLowerCase()) : false;
}

// ── On-chain activity check ─────────────────────────────────────────────────

/**
 * Get the RPC URL from the config input or use the PulseChain default.
 * @returns {string}
 */
_9mmPositionMgr.getRpcUrl = function getRpcUrl() {
  const el = g('inRpc');
  return (el && el.value.trim()) || 'https://rpc-pulsechain.g4mm4.io';
};

/**
 * Check if an address has on-chain transaction history.
 * Uses getTransactionCount (nonce) — count > 0 means the address has sent
 * at least one transaction.  Returns false on network error.
 * @param {string} address  Checksummed address.
 * @returns {Promise<boolean>}
 */
async function hasOnChainActivity(address) {
  try {
    const provider = new ethers.JsonRpcProvider(_9mmPositionMgr.getRpcUrl());
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
function wTab(t) {
  ['generate', 'seed', 'key'].forEach(k => {
    g('wtab-' + k).className  = 'modal-tab' + (k === t ? ' active' : '');
    g('wpanel-' + k).className = 'modal-panel' + (k === t ? ' active' : '');
  });
}

// ── Shared validation-status renderer ───────────────────────────────────────

/**
 * Render the three-state validation badge and confirmation panel.
 * @param {string} stateId  DOM prefix: 'seed' | 'key'
 * @param {'neutral'|'invalid'|'valid-known'|'valid-new'} state
 * @param {string} title    Badge heading text.
 * @param {string} detail   Badge detail text.
 * @param {string} [address]  Full address string (shown in badge).
 */
function wvSetStatus(stateId, state, title, detail, address) {
  const statusEl  = g(stateId + 'ValidStatus');
  const titleEl   = g(stateId + 'ValidTitle');
  const detailEl  = g(stateId + 'ValidDetail');
  const addrEl    = g(stateId + 'ValidAddr');
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

/**
 * Determine whether the import button should be enabled.
 * @param {'neutral'|'invalid'|'valid-known'|'valid-new'} state
 * @param {string} stateId  DOM prefix for the confirm checkbox.
 * @returns {boolean}
 */
function wvIsImportAllowed(state, stateId) {
  if (state === 'valid-known') return true;
  if (state === 'valid-new') {
    const cb = g(stateId + 'ConfirmCheck');
    return cb ? cb.checked : false;
  }
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
    act('\u26A0', 'alert', 'Server sync failed', e.message);
    return false;
  }
}

/**
 * Check whether password and confirm fields match, and update the hint label.
 * Disables/enables the import button based on match.
 * @param {string} prefix  Tab prefix: 'gen' | 'seed' | 'key'
 */
/** Map password field prefix to its import button ID. */
const _PW_BTN_MAP = {
  gen: 'genConfirmBtn', seed: 'seedImportBtn',
  key: 'keyImportBtn',
};

/**
 * Check whether the passwords match for a given tab prefix.
 * @param {string} prefix  Tab prefix: 'gen' | 'seed' | 'key'
 * @returns {boolean}
 */
function _passwordsMatch(prefix) {
  const pw   = g(prefix + 'Password');
  const conf = g(prefix + 'PasswordConfirm');
  return !!(pw && conf && pw.value && conf.value && pw.value === conf.value);
}

function checkPasswordMatch(prefix) {
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

/**
 * Read the session password from the active wallet tab.
 * Requires password and confirm fields to match.
 * Each tab has its own password field: genPassword, seedPassword, keyPassword.
 * @returns {string} The password, or empty string if not entered or mismatched.
 */
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
async function generateWallet() {
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
async function confirmWallet() {
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

  wallet = { ...p };
  delete wallet._pending;

  const revealBtn = g('wsRevealBtn');
  if (revealBtn) revealBtn.style.display = 'inline-block';
  const clearBtn = g('wsClearBtn');
  if (clearBtn) clearBtn.style.display = 'inline-block';

  applyWalletUI();
  closeWalletModal();

  // Auto-scan for positions after wallet import
  if (typeof scanPositions === 'function') {
    act('\u{1F50D}', 'start', 'Auto-scanning', 'Looking for LP positions\u2026');
    scanPositions();
  }
}

// ── Seed phrase ─────────────────────────────────────────────────────────────

let _validateSeedSeq = 0;

async function validateSeed() {
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

    const state  = known ? 'valid-known' : 'valid-new';
    const title  = known
      ? '\u2713 Valid phrase \u2014 existing wallet'
      : '\u26A0 Valid phrase \u2014 address not yet known';
    const detail = known
      ? 'This address has on-chain activity \u2014 safe to import.'
      : 'This address has not been seen before. Please confirm below before importing.';
    wvSetStatus('seed', state, title, detail, addr);
    btn.disabled = !wvIsImportAllowed(state, 'seed') || !_passwordsMatch('seed');
  } catch (e) {
    if (seq !== _validateSeedSeq) return;
    wvSetStatus('seed', 'invalid', 'Invalid seed phrase', e.message.slice(0, 80));
    wallet._pending = null;
    btn.disabled = true;
  }
}

function onSeedConfirmChange() {
  const btn = g('seedImportBtn');
  if (btn) btn.disabled = !wvIsImportAllowed('valid-new', 'seed') || !_passwordsMatch('seed');
}

async function importSeed() { await confirmWallet(); }

// ── Private key ─────────────────────────────────────────────────────────────

let _validateKeySeq = 0;

async function validateKey() {
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

    const state  = known ? 'valid-known' : 'valid-new';
    const title  = known
      ? '\u2713 Valid key \u2014 existing wallet'
      : '\u26A0 Valid key \u2014 address not yet known';
    const detail = known
      ? 'This address has on-chain activity \u2014 safe to import.'
      : 'This address has not been seen before. Please confirm below before importing.';
    wvSetStatus('key', state, title, detail, addr);
    btn.disabled = !wvIsImportAllowed(state, 'key') || !_passwordsMatch('key');
  } catch (e) {
    if (seq !== _validateKeySeq) return;
    wvSetStatus('key', 'invalid', 'Invalid private key', e.message.slice(0, 80));
    wallet._pending = null;
    btn.disabled = true;
  }
}

function onKeyConfirmChange() {
  const btn = g('keyImportBtn');
  if (btn) btn.disabled = !wvIsImportAllowed('valid-new', 'key') || !_passwordsMatch('key');
}

async function importKey() { await confirmWallet(); }

// ── Reveal key modal ────────────────────────────────────────────────────────

/** Auto-hide timer for revealed secrets. */
let _revealTimer = null;

/** Open the reveal-key modal. */
function openRevealModal() {
  if (!wallet.address) {
    act('\u26A0', 'alert', 'No wallet loaded', 'Import a wallet first');
    return;
  }
  g('revealPassword').value = '';
  g('revealResult').style.display = 'none';
  g('revealError').style.display  = 'none';
  g('revealBtn').disabled = false;
  g('revealModal').className = 'modal-overlay';
}

/** Close the reveal-key modal and clear displayed secrets. */
function closeRevealModal() {
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
async function revealWallet() {
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
      act('\u{1F512}', 'wallet', 'Key auto-hidden', 'Revealed key hidden after 60s timeout');
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
function applyWalletUI() {
  if (!wallet.address) {
    g('wsAddr').textContent  = 'No wallet loaded';
    g('wsBadge').textContent = 'NOT SET';
    g('wsBadge').className   = 'ws-badge none';
    g('headerWalletLabel').textContent = 'Set Wallet';
    updatePosStripUI();
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
  act('\u{1F511}', 'wallet', 'Wallet loaded', short + ' (' + wallet.source + ')');
  updatePosStripUI();
}

/** Open the wallet modal. */
function openWalletModal() { g('walletModal').className = 'modal-overlay'; }

/** Close the wallet modal. */
function closeWalletModal() { g('walletModal').className = 'modal-overlay hidden'; }

/**
 * Copy the text content of an element to the clipboard.
 * @param {string} id  Element id whose textContent to copy.
 */
function copyText(id) {
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

/**
 * On page load, check if the server already has a wallet loaded
 * (e.g. from a previous session before page refresh).
 */
async function checkServerWalletStatus() {
  try {
    const res  = await fetch('/api/wallet/status');
    const data = await res.json();
    if (data.loaded && data.address) {
      wallet.address = data.address;
      wallet.source  = data.source;
      const revealBtn = g('wsRevealBtn');
      if (revealBtn) revealBtn.style.display = 'inline-block';
      const clearBtn = g('wsClearBtn');
      if (clearBtn) clearBtn.style.display = 'inline-block';
      applyWalletUI();

      // Auto-scan for positions if none are loaded yet
      if (typeof scanPositions === 'function' && typeof posStore !== 'undefined' && posStore.count() === 0) {
        scanPositions();
      }
    } else {
      applyWalletUI();
      openWalletModal();
    }
  } catch {
    // Server not available yet — leave current state as-is
  }
}

/** Show the "Are you sure?" confirmation modal before clearing wallet. */
function clearWalletUI() {
  const modal = g('clearWalletModal');
  if (modal) modal.className = 'modal-overlay';
}

/** Close the clear wallet confirmation modal. */
function closeClearWalletModal() {
  const modal = g('clearWalletModal');
  if (modal) modal.className = 'modal-overlay hidden';
}

/** Execute wallet clear after user confirms. */
async function confirmClearWallet() {
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

  // Clear position store and related localStorage data
  if (typeof posStore !== 'undefined') {
    while (posStore.count() > 0) posStore.remove(0);
    if (typeof updatePosStripUI === 'function') updatePosStripUI();
  }
  try { localStorage.removeItem('9mm_posStore'); } catch { /* private mode */ }
  try { localStorage.removeItem('9mm_realized_gains'); } catch { /* private mode */ }

  applyWalletUI();
  act('\u{1F510}', 'wallet', 'Wallet cleared', 'All wallet data removed from server and browser');
}
