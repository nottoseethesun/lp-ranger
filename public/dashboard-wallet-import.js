/**
 * @file dashboard-wallet-import.js
 * @description Wallet import flows (seed phrase, private key),
 * on-chain activity detection, key reveal modal, wallet clear,
 * and shared validation helpers.
 *
 * Split from dashboard-wallet.js — imported by that module
 * and re-exported so external consumers are unaffected.
 *
 * Depends on: dashboard-helpers.js (g, act, ACT_ICONS),
 * ethers-adapter.js (ethers),
 * dashboard-wallet.js (wallet state, confirmWallet, etc.).
 */

import { g, act, ACT_ICONS, csrfHeaders } from "./dashboard-helpers.js";
import { ethers } from "./ethers-adapter.js";
import {
  wallet,
  isKnownWallet,
  markWalletKnown,
  getRpcUrl,
  confirmWallet,
  applyWalletUI,
  openWalletModal,
  clearAllPositionState,
  getUpdateRouteForWallet,
} from "./dashboard-wallet.js";

// ── Shared validation-status renderer ─────────────────────

/**
 * Render the three-state validation badge and confirmation
 * panel.
 */
function wvSetStatus(stateId, state, title, detail, address) {
  const statusEl = g(stateId + "ValidStatus"),
    titleEl = g(stateId + "ValidTitle");
  const detailEl = g(stateId + "ValidDetail"),
    addrEl = g(stateId + "ValidAddr");
  const confirmEl = g(stateId + "ConfirmPanel");
  if (!statusEl) return;
  const ICON = {
    neutral: "\u{1F4AC}",
    invalid: "\u2717",
    "valid-known": "\u2713",
    "valid-new": "\u26A0",
  };

  statusEl.className = "wv-status " + state;
  statusEl.querySelector(".wv-status-icon").textContent = ICON[state];
  if (titleEl) titleEl.textContent = title;
  if (detailEl) detailEl.textContent = detail;
  if (addrEl) addrEl.textContent = address || "";

  if (confirmEl) {
    confirmEl.style.display = state === "valid-new" ? "block" : "none";
    if (state !== "valid-new") {
      const cb = confirmEl.querySelector("input[type=checkbox]");
      if (cb) cb.checked = false;
    }
  }
}

/**
 * Check if import is allowed for the given validation
 * state.
 */
function wvIsImportAllowed(state, stateId) {
  if (state === "valid-known") return true;
  if (state === "valid-new") {
    const cb = g(stateId + "ConfirmCheck");
    return cb ? cb.checked : false;
  }
  return false;
}

// ── Password matching helpers ─────────────────────────────

/** @param {string} prefix  'gen' | 'seed' | 'key' */
export function _passwordsMatch(prefix) {
  const pw = g(prefix + "Password");
  const conf = g(prefix + "PasswordConfirm");
  return !!(pw && conf && pw.value && conf.value && pw.value === conf.value);
}

// ── On-chain activity check ───────────────────────────────

/**
 * Check if an address has on-chain activity
 * (getTransactionCount > 0).
 */
async function hasOnChainActivity(address) {
  try {
    const provider = new ethers.JsonRpcProvider(getRpcUrl());
    const txCount = await provider.getTransactionCount(address);
    return txCount > 0;
  } catch {
    return false;
  }
}

/**
 * Public wrapper: check on-chain activity for an address.
 * @param {string} address
 * @returns {Promise<boolean>}
 */
export async function checkOnChainActivity(address) {
  return hasOnChainActivity(address);
}

// ── Seed phrase ───────────────────────────────────────────

let _validateSeedSeq = 0;

/**
 * Validate the seed phrase input and update the validation
 * badge.
 */
export async function validateSeed() {
  const seq = ++_validateSeedSeq;
  const raw = g("seedInput").value;
  const words = raw.trim().split(/\s+/);
  const btn = g("seedImportBtn");

  if (words.length !== 12 && words.length !== 24) {
    const n = raw.trim() ? words.length : 0;
    wvSetStatus(
      "seed",
      "neutral",
      n
        ? `${n} word${n !== 1 ? "s" : ""} \u2014 need 12 or 24`
        : "Waiting for input",
      "Enter 12 or 24 space-separated BIP-39 words",
    );
    btn.disabled = true;
    return;
  }

  try {
    const path = g("seedPath").value.trim() || "m/44'/60'/0'/0/0";
    const w = ethers.HDNodeWallet.fromPhrase(raw.trim(), undefined, path);
    const addr = w.address;
    wallet._pending = {
      address: addr,
      privateKey: w.privateKey,
      mnemonic: raw.trim(),
      source: "seed",
    };

    let known = isKnownWallet(addr);
    if (!known) {
      wvSetStatus(
        "seed",
        "neutral",
        "Checking on-chain\u2026",
        "Querying balance for " + addr.slice(0, 12) + "\u2026",
        addr,
      );
      btn.disabled = true;
      known = await hasOnChainActivity(addr);
      if (seq !== _validateSeedSeq) return;
      if (known) markWalletKnown(addr);
    }

    const state = known ? "valid-known" : "valid-new";
    wvSetStatus(
      "seed",
      state,
      known
        ? "\u2713 Valid phrase \u2014 existing wallet"
        : "\u26A0 Valid phrase \u2014 not yet known",
      known
        ? "\u2713 On-chain activity found \u2014 safe to import."
        : "Not seen before. Confirm below.",
      addr,
    );
    btn.disabled =
      !wvIsImportAllowed(state, "seed") || !_passwordsMatch("seed");
  } catch (e) {
    if (seq !== _validateSeedSeq) return;
    wvSetStatus(
      "seed",
      "invalid",
      "Invalid seed phrase",
      e.message.slice(0, 80),
    );
    wallet._pending = null;
    btn.disabled = true;
  }
}

/** Handle seed confirm checkbox change. */
export function onSeedConfirmChange() {
  const btn = g("seedImportBtn");
  if (btn)
    btn.disabled =
      !wvIsImportAllowed("valid-new", "seed") || !_passwordsMatch("seed");
}

/** Import wallet from seed phrase. */
export async function importSeed() {
  await confirmWallet();
}

// ── Private key ───────────────────────────────────────────

let _validateKeySeq = 0;

/**
 * Validate the private key input and update the validation
 * badge.
 */
export async function validateKey() {
  const seq = ++_validateKeySeq;
  const raw = g("keyInput").value.trim();
  const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
  const btn = g("keyImportBtn");

  if (!raw) {
    wvSetStatus(
      "key",
      "neutral",
      "Waiting for input",
      "64 hex characters expected",
    );
    btn.disabled = true;
    return;
  }

  if (hex.length !== 64 || !/^[0-9a-fA-F]+$/.test(hex)) {
    const msg =
      hex.length !== 64
        ? `${hex.length} hex chars \u2014 need exactly 64`
        : "Non-hex characters detected";
    wvSetStatus("key", "invalid", "Invalid private key", msg);
    wallet._pending = null;
    btn.disabled = true;
    return;
  }

  try {
    const w = new ethers.Wallet("0x" + hex);
    const addr = w.address;
    wallet._pending = {
      address: addr,
      privateKey: "0x" + hex,
      mnemonic: null,
      source: "key",
    };

    let known = isKnownWallet(addr);
    if (!known) {
      wvSetStatus(
        "key",
        "neutral",
        "Checking on-chain\u2026",
        "Querying balance for " + addr.slice(0, 12) + "\u2026",
        addr,
      );
      btn.disabled = true;
      known = await hasOnChainActivity(addr);
      if (seq !== _validateKeySeq) return;
      if (known) markWalletKnown(addr);
    }

    const state = known ? "valid-known" : "valid-new";
    wvSetStatus(
      "key",
      state,
      known
        ? "\u2713 Valid key \u2014 existing wallet"
        : "\u26A0 Valid key \u2014 not yet known",
      known
        ? "\u2713 On-chain activity found \u2014 safe to import."
        : "Not seen before. Confirm below.",
      addr,
    );
    btn.disabled = !wvIsImportAllowed(state, "key") || !_passwordsMatch("key");
  } catch (e) {
    if (seq !== _validateKeySeq) return;
    wvSetStatus(
      "key",
      "invalid",
      "Invalid private key",
      e.message.slice(0, 80),
    );
    wallet._pending = null;
    btn.disabled = true;
  }
}

/** Handle key confirm checkbox change. */
export function onKeyConfirmChange() {
  const btn = g("keyImportBtn");
  if (btn)
    btn.disabled =
      !wvIsImportAllowed("valid-new", "key") || !_passwordsMatch("key");
}

/** Import wallet from private key. */
export async function importKey() {
  await confirmWallet();
}

// ── Reveal key modal ──────────────────────────────────────

/** Auto-hide timer for revealed secrets. */
let _revealTimer = null;

/**
 * Open the reveal-key modal (checks wallet file exists
 * first).
 */
export async function openRevealModal() {
  if (!wallet.address) {
    act(ACT_ICONS.warn, "alert", "No Wallet Loaded", "Import a wallet first");
    return;
  }
  try {
    const st = await (await fetch("/api/wallet/status")).json();
    if (!st.fileExists) {
      _showWalletFileGoneDialog();
      return;
    }
  } catch {
    /* server unreachable — fall through */
  }
  g("revealPassword").value = "";
  g("revealResult").style.display = "none";
  g("revealError").style.display = "none";
  g("revealBtn").disabled = false;
  g("revealModal").className = "modal-overlay";
}

function _showWalletFileGoneDialog() {
  const id = "9mm-wallet-gone-modal";
  if (document.getElementById(id)) return;
  const o = document.createElement("div");
  o.className = "9mm-pos-mgr-modal-overlay";
  o.id = id;
  o.innerHTML =
    '<div class="9mm-pos-mgr-modal ' +
    '9mm-pos-mgr-modal-warning">' +
    "<h3>Wallet file not found</h3>" +
    "<p>The encrypted wallet file has been deleted " +
    "(e.g. via <code>npm run clean</code>). " +
    "Re-import your wallet to continue.</p>" +
    '<button class="9mm-pos-mgr-modal-close" ' +
    "data-dismiss-modal>OK</button></div>";
  o.querySelector("[data-dismiss-modal]").addEventListener("click", () => {
    o.remove();
    openWalletModal();
  });
  document.body.appendChild(o);
}

/** Close the reveal-key modal and clear displayed
 *  secrets.
 */
export function closeRevealModal() {
  g("revealModal").className = "modal-overlay hidden";
  g("revealKey").textContent = "\u2014";
  g("revealMnemonic").textContent = "\u2014";
  g("revealResult").style.display = "none";
  if (_revealTimer) {
    clearTimeout(_revealTimer);
    _revealTimer = null;
  }
}

/**
 * Reveal the wallet key by sending the password to the
 * server for decryption. Secrets are displayed for
 * 60 seconds then auto-hidden.
 */
export async function revealWallet() {
  const password = g("revealPassword").value.trim();
  if (!password) return;

  const btn = g("revealBtn");
  const err = g("revealError");
  btn.disabled = true;
  btn.textContent = "Decrypting\u2026";
  err.style.display = "none";

  try {
    const res = await fetch("/api/wallet/reveal", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...csrfHeaders() },
      body: JSON.stringify({ password }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);

    g("revealAddr").textContent = data.address;
    g("revealKey").textContent = data.privateKey;

    if (data.mnemonic) {
      g("revealMnemonic").textContent = data.mnemonic;
      g("revealMnemonicSection").style.display = "block";
      g("revealNoMnemonic").style.display = "none";
    } else {
      g("revealMnemonicSection").style.display = "none";
      g("revealNoMnemonic").style.display = "block";
    }

    g("revealResult").style.display = "block";

    // Auto-hide after 60 seconds
    if (_revealTimer) clearTimeout(_revealTimer);
    _revealTimer = setTimeout(() => {
      g("revealResult").style.display = "none";
      g("revealKey").textContent = "\u2014";
      g("revealMnemonic").textContent = "\u2014";
      act(
        ACT_ICONS.lock,
        "wallet",
        "Key Auto-Hidden",
        "Revealed key hidden after 60s timeout",
      );
    }, 60_000);
  } catch (e) {
    err.textContent = e.message;
    err.style.display = "block";
  } finally {
    btn.disabled = false;
    btn.textContent = "Reveal";
  }
}

// ── Wallet clear ──────────────────────────────────────────

/**
 * Show the "Are you sure?" confirmation modal before
 * clearing wallet.
 */
export function clearWalletUI() {
  const modal = g("clearWalletModal");
  if (modal) modal.className = "modal-overlay";
}

/** Close the clear wallet confirmation modal. */
export function closeClearWalletModal() {
  const modal = g("clearWalletModal");
  if (modal) modal.className = "modal-overlay hidden";
}

/** Execute wallet clear after user confirms. */
export async function confirmClearWallet() {
  closeClearWalletModal();
  try {
    await fetch("/api/wallet", { method: "DELETE", headers: csrfHeaders() });
  } catch {
    /* server unavailable */
  }
  wallet.address = null;
  wallet.privateKey = null;
  wallet.source = null;
  wallet.mnemonic = null;
  const revealBtn = g("wsRevealBtn");
  if (revealBtn) revealBtn.style.display = "none";
  const clearBtn = g("wsClearBtn");
  if (clearBtn) clearBtn.style.display = "none";

  clearAllPositionState();
  applyWalletUI();
  const updateRoute = getUpdateRouteForWallet();
  if (updateRoute) updateRoute(null);
  act(
    ACT_ICONS.clear,
    "wallet",
    "Wallet Cleared",
    "All wallet data removed from server and browser",
  );
}
