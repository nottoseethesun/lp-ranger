/**
 * @file dashboard-wallet.js
 * @description Core wallet state, generate flow, unlock,
 * tab switching, and utility functions for the 9mm v3
 * Position Manager dashboard.
 *
 * Re-exports everything from dashboard-wallet-import.js so
 * external consumers continue to import from this module.
 *
 * Depends on: dashboard-helpers.js (g, act, ACT_ICONS),
 * ethers-adapter.js (ethers).
 *
 * NOTE: Imports from positions (updatePosStripUI,
 * scanPositions, posStore) are resolved at call time, not
 * at parse time, so the circular reference between wallet
 * and positions is safe.
 */

import { g, act, ACT_ICONS, csrfHeaders } from "./dashboard-helpers.js";
import { saveMoralisApiKey } from "./dashboard-events.js";
import { flushPendingTelegramConfig } from "./dashboard-telegram.js";
import { ethers } from "./ethers-adapter.js";
import * as unlockLog from "./dashboard-unlock-log.js";

// ── Re-export the import module ───────────────────────────

export {
  validateSeed,
  importSeed,
  onSeedConfirmChange,
  validateKey,
  importKey,
  onKeyConfirmChange,
  openRevealModal,
  closeRevealModal,
  revealWallet,
  clearWalletUI,
  closeClearWalletModal,
  confirmClearWallet,
  checkOnChainActivity,
  _passwordsMatch,
} from "./dashboard-wallet-import.js";

// ── Late-bound deps ───────────────────────────────────────

// Populated by dashboard-init.js after all modules load.
let _updatePosStripUI = null;
let _scanPositions = null;
let _posStore = null;
let _updateRouteForWallet = null,
  _syncRouteToState = null;
let _resolvePendingRoute = null;
let _clearPositionDisplay = null;
let _resetPollingState = null;
let _clearHistory = null;
let _getPendingRouteWallet = null;
let _resetLastFetchedId = null;
let _fetchUnmanagedDetails = null;

/**
 * Inject position-module references. Called once from
 * dashboard-init.js.
 */
export function injectWalletDeps(deps) {
  _updatePosStripUI = deps.updatePosStripUI;
  _scanPositions = deps.scanPositions;
  _posStore = deps.posStore;
  if (deps.updateRouteForWallet)
    _updateRouteForWallet = deps.updateRouteForWallet;
  if (deps.syncRouteToState) _syncRouteToState = deps.syncRouteToState;
  if (deps.resolvePendingRoute) _resolvePendingRoute = deps.resolvePendingRoute;
  if (deps.clearPositionDisplay)
    _clearPositionDisplay = deps.clearPositionDisplay;
  if (deps.resetPollingState) _resetPollingState = deps.resetPollingState;
  if (deps.clearHistory) _clearHistory = deps.clearHistory;
  if (deps.getPendingRouteWallet)
    _getPendingRouteWallet = deps.getPendingRouteWallet;
  if (deps.resetLastFetchedId) _resetLastFetchedId = deps.resetLastFetchedId;
  if (deps.fetchUnmanagedDetails)
    _fetchUnmanagedDetails = deps.fetchUnmanagedDetails;
}

// ── Wallet state ──────────────────────────────────────────

/** Active wallet data. Mutated by import flows. */
export const wallet = {
  address: null,
  privateKey: null,
  mnemonic: null,
  source: null,
};

/**
 * Set of lowercase wallet addresses seen in this browser
 * session. Populated from posStore entries on load and from
 * each successful import. Also populated by on-chain
 * activity detection.
 */
export const knownWallets = new Set();

/**
 * Register an address as known. Accepts any casing.
 * @param {string} address  Checksummed or lowercased.
 */
export function markWalletKnown(address) {
  if (address) knownWallets.add(address.toLowerCase());
}

/**
 * Return true if the address has been seen (session or
 * on-chain).
 * @param {string} address
 * @returns {boolean}
 */
export function isKnownWallet(address) {
  return address ? knownWallets.has(address.toLowerCase()) : false;
}

// ── Internal position-state helpers ───────────────────────

/** Reset display, polling, and history state. */
function _resetDisplayState() {
  if (_clearPositionDisplay) _clearPositionDisplay();
  if (_resetPollingState) _resetPollingState();
  if (_clearHistory) _clearHistory();
}

/**
 * Remove positions from other wallets and reset display if
 * any were purged.
 */
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
  if (purged) _resetDisplayState();
  return purged;
}

/**
 * Clear all positions and reset all wallet-specific
 * display state. Exposed for the import module.
 */
export function clearAllPositionState() {
  if (_posStore) {
    while (_posStore.count() > 0) _posStore.remove(0);
  }
  _resetDisplayState();
}

/**
 * Return the late-bound _updateRouteForWallet callback.
 * Used by the import module for wallet clear.
 * @returns {Function|null}
 */
export function getUpdateRouteForWallet() {
  return _updateRouteForWallet;
}

// ── RPC URL ───────────────────────────────────────────────

/**
 * Get the RPC URL from the config input or use the
 * PulseChain default.
 */
export function getRpcUrl() {
  const el = g("inRpc");
  return (el && el.value.trim()) || "https://rpc-pulsechain.g4mm4.io";
}

// ── Tab switcher ──────────────────────────────────────────

/**
 * Switch the active tab inside the wallet modal.
 * @param {string} t  Tab key: 'generate' | 'seed' | 'key'
 */
export function wTab(t) {
  ["generate", "seed", "key"].forEach((k) => {
    g("wtab-" + k).className = "modal-tab" + (k === t ? " active" : "");
    g("wpanel-" + k).className = "modal-panel" + (k === t ? " active" : "");
  });
}

// ── Server wallet sync ────────────────────────────────────

/**
 * Send the wallet to the server for encrypted storage.
 * @param {object} w        Wallet data.
 * @param {string} password Session password.
 * @returns {Promise<boolean>} True if accepted.
 */
async function sendWalletToServer(w, password) {
  try {
    const res = await fetch("/api/wallet", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...csrfHeaders() },
      body: JSON.stringify({
        address: w.address,
        privateKey: w.privateKey,
        mnemonic: w.mnemonic || null,
        source: w.source,
        password,
      }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    return true;
  } catch (e) {
    act(ACT_ICONS.warn, "alert", "Server Sync Failed", e.message);
    return false;
  }
}

/** Map password field prefix to its import button ID. */
const _PW_BTN_MAP = {
  gen: "genConfirmBtn",
  seed: "seedImportBtn",
  key: "keyImportBtn",
};

/**
 * Check password match, update hint label, and
 * enable/disable import button.
 */
export function checkPasswordMatch(prefix) {
  const pw = g(prefix + "Password");
  const conf = g(prefix + "PasswordConfirm");
  const hint = g(prefix + "PwMatch");
  const btn = g(_PW_BTN_MAP[prefix]);
  if (!pw || !conf || !hint) return;

  const a = pw.value;
  const b = conf.value;
  const match = a && b && a === b;

  // Button requires both matching passwords AND valid
  // wallet credentials
  if (btn) btn.disabled = !match || !wallet._pending;

  if (!a && !b) {
    hint.textContent = "";
    return;
  }
  if (a && !b) {
    hint.textContent = "Please confirm your password";
    hint.style.color = "var(--warn)";
    return;
  }
  if (match) {
    hint.textContent = "\u2713 Passwords match";
    hint.style.color = "var(--accent3)";
  } else {
    hint.textContent = "\u2717 Passwords do not match";
    hint.style.color = "var(--danger)";
  }
}

/**
 * Read the session password from the active wallet tab
 * (empty if mismatched).
 */
function getActivePassword() {
  const prefixes = ["gen", "seed", "key"];
  for (const prefix of prefixes) {
    const el = g(prefix + "Password");
    const conf = g(prefix + "PasswordConfirm");
    if (el && el.offsetParent !== null && el.value.trim()) {
      if (!conf || conf.value !== el.value) return "";
      return el.value.trim();
    }
  }
  return "";
}

// ── Generate ──────────────────────────────────────────────

/** Generate a new random wallet and display the result. */
export async function generateWallet() {
  try {
    const w = ethers.Wallet.createRandom();
    g("genAddr").textContent = w.address;
    g("genMnemonic").textContent = w.mnemonic.phrase;
    g("genKey").textContent = w.privateKey;
    g("genResult").style.display = "block";
    g("genConfirmBtn").style.display = "block";
    const _mf = g("genMoralisField");
    if (_mf) _mf.style.display = "block";
    g("genPwField").style.display = "block";
    g("genBtn").textContent = "Regenerate";
    wallet._pending = {
      address: w.address,
      privateKey: w.privateKey,
      mnemonic: w.mnemonic.phrase,
      source: "generated",
    };
  } catch (e) {
    alert("Error: " + e.message);
  }
}

/** Save the optional Moralis API key from the setup dialog. */
async function _saveSetupMoralisKey(password) {
  const inputs = document.querySelectorAll(".setupMoralisKeyInput");
  const inp = Array.from(inputs).find((el) => el.value.trim());
  if (!inp) return;
  await saveMoralisApiKey(inp.value.trim(), password, inp);
}

/**
 * Confirm the pending wallet — encrypts on server, copies
 * _pending into the active wallet, updates the UI, and
 * closes the modal.
 */
export async function confirmWallet() {
  const p = wallet._pending;
  if (!p) return;

  const password = getActivePassword();
  if (!password) {
    alert(
      "Please set a session password and confirm it " +
        "(both fields must match).",
    );
    return;
  }

  const ok = await sendWalletToServer(p, password);
  if (!ok) {
    alert("Failed to sync wallet to server. " + "Check the activity log.");
    return;
  }

  wallet.address = p.address;
  wallet.privateKey = p.privateKey;
  wallet.mnemonic = p.mnemonic;
  wallet.source = p.source;
  _walletUnlocked = true;
  delete wallet._pending;

  const revealBtn = g("wsRevealBtn");
  if (revealBtn) revealBtn.style.display = "inline-block";
  const clearBtn = g("wsClearBtn");
  if (clearBtn) clearBtn.style.display = "inline-block";

  // Save optional Moralis API key if provided during setup
  await _saveSetupMoralisKey(password);

  // Flush Telegram config stashed during the setup dialog
  // (deferred because the wallet password wasn't set yet).
  await flushPendingTelegramConfig(password);

  clearAllPositionState();
  applyWalletUI();
  closeWalletModal();

  const routeResolved = _resolvePendingRoute ? _resolvePendingRoute() : false;
  if (!routeResolved && _updateRouteForWallet)
    _updateRouteForWallet(wallet.address);

  // Auto-scan for positions after wallet import
  // (navigate: false — let the polling loop navigate to
  // the bot's real active position once it responds)
  if (_scanPositions) {
    act(
      ACT_ICONS.scan,
      "start",
      "Auto-Scanning",
      "Looking for LP positions\u2026",
    );
    _scanPositions({ navigate: false });
  }
}

// ── Apply & close ─────────────────────────────────────────

/**
 * Update the wallet strip and header with the current
 * wallet state. Registers the address as known for future
 * import checks.
 */
export function applyWalletUI() {
  if (!wallet.address) {
    g("wsAddr").textContent = "No Wallet Loaded";
    g("wsBadge").textContent = "NOT SET";
    g("wsBadge").className = "ws-badge none";
    g("headerWalletLabel").textContent = "Set Wallet";
    if (_updatePosStripUI) _updatePosStripUI();
    return;
  }
  const addr = wallet.address;
  g("wsAddr").textContent = addr;
  const cpIcon = g("wsAddrCopy");
  if (cpIcon) cpIcon.style.display = "inline";
  g("wsBadge").textContent =
    wallet.source === "generated"
      ? "GENERATED"
      : wallet.source === "seed"
        ? "SEED IMPORT"
        : "KEY IMPORT";
  g("wsBadge").className =
    "ws-badge " + (wallet.source === "key" ? "imp" : "gen");
  g("headerWalletLabel").textContent = "Change Wallet Address";

  const revealBtn = g("wsRevealBtn");
  if (revealBtn) revealBtn.style.display = "inline-block";
  const clrBtn = g("wsClearBtn");
  if (clrBtn) clrBtn.style.display = "inline-block";

  markWalletKnown(addr);
  const shortAddr = addr.slice(0, 8) + "\u2026" + addr.slice(-6);
  act(
    ACT_ICONS.diamond,
    "wallet",
    "Wallet Loaded",
    shortAddr + " (" + wallet.source + ")",
  );
  if (_updatePosStripUI) _updatePosStripUI();
  // Sync URL with restored position (restoreLastPosition
  // runs before wallet loads)
  const active = _posStore?.getActive?.();
  if (active && _syncRouteToState) _syncRouteToState(active);
}

/** Open the wallet modal. */
export function openWalletModal() {
  g("walletModal").className = "modal-overlay";
}

/** Close the wallet modal. */
export function closeWalletModal() {
  g("walletModal").className = "modal-overlay hidden";
}

/**
 * Copy the text content of an element to the clipboard.
 * @param {string} id  Element id whose textContent to copy.
 */
export function copyText(id) {
  const el = g(id);
  if (!el) return;
  navigator.clipboard.writeText(el.textContent).catch(() => {});
  const btn = el.parentElement.querySelector(".copy-btn");
  if (btn) {
    btn.textContent = "copied!";
    setTimeout(() => {
      btn.textContent = "copy";
    }, 1500);
  }
}

// ── Init: check server wallet status on load ──────────────

/**
 * Restore a server-persisted wallet. Checks URL/server
 * wallet mismatch.
 */
function _restoreServerWallet(data) {
  // If the URL requests a different wallet, don't load
  // the server's wallet.
  const pendingWallet = _getPendingRouteWallet
    ? _getPendingRouteWallet()
    : null;
  if (pendingWallet && pendingWallet !== data.address.toLowerCase()) {
    clearAllPositionState();
    applyWalletUI();
    openWalletModal();
    return;
  }

  wallet.address = data.address;
  wallet.source = data.source;
  const revealBtn = g("wsRevealBtn");
  if (revealBtn) revealBtn.style.display = "inline-block";
  const clearBtn = g("wsClearBtn");
  if (clearBtn) clearBtn.style.display = "inline-block";

  _purgeOtherWalletPositions(data.address);
  applyWalletUI();
  const routeResolved = _resolvePendingRoute ? _resolvePendingRoute() : false;
  // Don't navigate to posStore's active position here —
  // it may be stale (e.g. a closed NFT from
  // localStorage). The polling loop's
  // setBotActiveTokenId will navigate to the bot's real
  // active position.
  const _active = _posStore?.getActive?.();
  if (!routeResolved && !_active && _updateRouteForWallet) {
    _updateRouteForWallet(data.address);
  }
}

/**
 * On page load, check if the server already has a wallet
 * loaded (e.g. from a previous session before page
 * refresh).
 */
export async function checkServerWalletStatus() {
  unlockLog.logInfo("checkServerWalletStatus: fetching status");
  try {
    const res = await fetch("/api/wallet/status");
    const data = await res.json();
    unlockLog.logStatus("checkServerWalletStatus", data);
    if (data.loaded && data.address) {
      _restoreServerWallet(data);
    } else {
      clearAllPositionState();
      applyWalletUI();
      openWalletModal();
    }
  } catch (err) {
    // Server not available yet — leave current state as-is
    unlockLog.logWarn("checkServerWalletStatus failed", err);
  }
}

/**
 * Get the current wallet address (convenience accessor).
 * @returns {string|null}
 */
export function getCurWalletAddress() {
  return wallet.address;
}

// ── Wallet unlock (password-security) ─────────────────────

let _viewOnly = false;
let _walletUnlocked = false;

/** @returns {boolean} True if in view-only mode. */
export function isViewOnly() {
  return _viewOnly;
}

/** @returns {boolean} True if the wallet has been unlocked this session. */
export function isWalletUnlocked() {
  return _walletUnlocked;
}

/** Check if the wallet is locked and show unlock modal. */
export async function checkWalletLocked() {
  unlockLog.logInfo("checkWalletLocked: fetching status");
  try {
    const s = await (await fetch("/api/wallet/status")).json();
    unlockLog.logStatus("checkWalletLocked", s);
    if (s.locked) {
      const m = g("walletUnlockModal");
      const pw = g("unlockPassword");
      unlockLog.logLockedBranch(m, pw);
      if (m) m.classList.remove("hidden");
      if (pw) pw.focus();
      const ub = g("unlockWalletBtn");
      if (ub) {
        ub.disabled = false;
        ub.title = "Unlock wallet to manage positions";
      }
      unlockLog.logInfo("modal shown; awaiting user submit of unlockForm");
    } else if (s.address) {
      // Wallet exists and is already unlocked (e.g. WALLET_PASSWORD env var).
      unlockLog.logInfo(
        "server reports already-unlocked wallet — skipping modal",
      );
      _walletUnlocked = true;
      _validateMoralisAfterUnlock();
      // Retry the active position's unmanaged details fetch, which may have
      // early-returned with "wallet-locked" before this async check resolved.
      const active = _posStore?.getActive?.();
      if (active && _resetLastFetchedId && _fetchUnmanagedDetails) {
        _resetLastFetchedId();
        _fetchUnmanagedDetails(active);
      }
    } else {
      unlockLog.logInfo("no wallet loaded on server — nothing to do");
    }
  } catch (err) {
    unlockLog.logWarn("checkWalletLocked failed", err);
  }
}

/** Submit the unlock password to the server. */
export async function submitUnlock(e) {
  const m = g("walletUnlockModal");
  const pw = g("unlockPassword");
  unlockLog.logSubmitEntry(e, m, pw);
  if (e) e.preventDefault();
  if (!pw) {
    unlockLog.logSubmitAbort("password field missing");
    return;
  }
  const errEl = g("unlockError");
  try {
    unlockLog.logSubmitPost(pw);
    const d = await (
      await fetch("/api/wallet/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...csrfHeaders() },
        body: JSON.stringify({ password: pw.value }),
      })
    ).json();
    unlockLog.logSubmitResponse(d);
    if (d.ok) {
      _viewOnly = false;
      _walletUnlocked = true;
      const m = g("walletUnlockModal");
      if (m) m.classList.add("hidden");
      const b = g("unlockWalletBtn");
      if (b) {
        b.disabled = true;
        b.title = "Wallet is already unlocked";
      }
      const mg = g("manageToggleBtn");
      if (mg) {
        mg.disabled = false;
        mg.title = "";
      }
      act(
        ACT_ICONS.play,
        "wallet",
        "Wallet Unlocked",
        "Position management enabled",
      );
      // Validate Moralis key after unlock — notify if corrupted
      _validateMoralisAfterUnlock();
      // Now that API keys are decrypted, fetch position details
      // (deferred from initial selection — prices need Moralis key).
      const active = _posStore?.getActive?.();
      if (active && _resetLastFetchedId && _fetchUnmanagedDetails) {
        _resetLastFetchedId();
        _fetchUnmanagedDetails(active);
      }
    } else if (errEl) {
      errEl.textContent = d.error || "Wrong password";
      errEl.classList.remove("hidden");
    }
  } catch {
    if (errEl) {
      errEl.textContent = "Server unreachable";
      errEl.classList.remove("hidden");
    }
  }
}

/** Validate Moralis key after wallet unlock; notify if invalid. */
async function _validateMoralisAfterUnlock() {
  try {
    const res = await fetch("/api/api-keys/status");
    const data = await res.json();
    if (data.moralis === "invalid")
      act(
        "\u26A0\uFE0F",
        "warning",
        "Moralis Key Invalid",
        "Your Moralis API key failed validation. Re-enter it in Settings.",
      );
  } catch {
    /* network error — skip */
  }
}

/** Dismiss the unlock modal and enter view-only mode. */
export function dismissToViewOnly() {
  _viewOnly = true;
  const m = g("walletUnlockModal");
  if (m) m.classList.add("hidden");
  const b = g("unlockWalletBtn");
  if (b) {
    b.disabled = false;
    b.title = "Unlock wallet to manage positions";
  }
  const mg = g("manageToggleBtn");
  if (mg) {
    mg.disabled = true;
    mg.title = "Unlock wallet to manage positions";
  }
}
