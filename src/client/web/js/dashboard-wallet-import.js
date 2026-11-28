/**
 * @file dashboard-wallet-import.js
 * @description Wallet import flows (seed phrase, private key; whether
 * the server would take an import now is painted by
 * dashboard-import-buttons.js), on-chain activity detection, key reveal modal,
 * wallet clear (Clear Wallet's state on each status answer,
 * `paintClearWalletButton`), what an unlock does when the server holds
 * no wallet (`walletGoneAtUnlock`), and shared validation helpers.
 *
 * Split from dashboard-wallet.js — dashboard-events.js, dashboard-init.js
 * and dashboard-data.js import this module directly; dashboard-wallet.js
 * does not import or re-export it.
 *
 * Depends on the modules it imports below, a list kept nowhere else:
 * dashboard-wallet.js among them, for the wallet's state and
 * `confirmWallet`.
 */

import {
  g,
  act,
  ACT_ICONS,
  fetchWithCsrf,
  cloneTpl,
} from "./dashboard-helpers.js";
import { ethers } from "./ethers-adapter.js";
import { log } from "./dashboard-log.js";
import { paintUnlockButton } from "./dashboard-unlock-button.js";
import {
  WALLET_NOT_CLEARED_NOTICE_ID,
  WALLET_CLEARED_LEFT_NOTICE_ID,
  WALLET_GONE_NOTICE_ID,
} from "./dashboard-app-notices.js";
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
    const url = await getRpcUrl();
    if (!url) {
      /*- No endpoint to ask.  Returning false here would report a
       *  funded wallet as "not seen before" purely because we could not
       *  reach the server — an answer we have not earned.  Say so
       *  instead of guessing. */
      console.log(
        "[lp-ranger] on-chain activity check skipped: no RPC endpoint available",
      );
      return false;
    }
    const provider = new ethers.JsonRpcProvider(url);
    const txCount = await provider.getTransactionCount(address);
    return txCount > 0;
  } catch (e) {
    console.log("[lp-ranger] on-chain activity check failed:", e.message);
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
  const id = WALLET_GONE_NOTICE_ID;
  if (document.getElementById(id)) return;
  const o = document.createElement("div");
  o.className = "9mm-pos-mgr-modal-overlay";
  o.id = id;
  const frag = cloneTpl("tplWalletGoneModal");
  if (!frag) return;
  o.appendChild(frag);
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
    const res = await fetchWithCsrf("/api/wallet/reveal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const data = await res.json();
    if (data.walletReplaced === true) {
      /*- Another tab's import replaced the wallet during the decrypt:
       *  nothing is wrong, and this tab follows the new wallet once the
       *  import has finished (dashboard-wallet-change.js). No error. */
      log.info("[lp-ranger] [wallet] Reveal Key overtaken by an import");
      g("revealPassword").value = "";
      closeRevealModal();
      return;
    }
    if (!data.ok) throw new Error(data.error);
    // The server has checked the password; the tab keeps no copy.
    g("revealPassword").value = "";

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

/**
 * Forget the wallet on this page once the server holds none, after a
 * Clear it confirmed or an unlock it answered with no wallet: its address
 * and source, the Reveal and Clear buttons, Unlock Wallet, every
 * position's state, and the wallet in the address bar.
 */
function _forgetWalletOnThisPage() {
  wallet.address = null;
  wallet.source = null;
  const revealBtn = g("wsRevealBtn");
  if (revealBtn) revealBtn.style.display = "none";
  const clearBtn = g("wsClearBtn");
  if (clearBtn) clearBtn.style.display = "none";
  /*- Unlock Wallet, which a tab left in View-Only enables: with no
   *  wallet, there is nothing to unlock. */
  paintUnlockButton("none");

  clearAllPositionState();
  applyWalletUI();
  const updateRoute = getUpdateRouteForWallet();
  if (updateRoute) updateRoute(null);
}

/**
 * What an unlock does when the server answers that it holds no wallet
 * (404), as after a Clear in another tab since this page loaded
 * (src/server/server-unlock.js): close the Unlock dialog, forget
 * the wallet on this page as the Clear did in its own, and show the
 * Wallet file not found notice, whose OK opens Wallet Setup to import a
 * wallet or generate one. Handed to dashboard-wallet.js as
 * `walletGoneAtUnlock` (dashboard-init.js).
 */
export function walletGoneAtUnlock() {
  const m = g("walletUnlockModal");
  if (m) m.classList.add("hidden");
  _forgetWalletOnThisPage();
  act(
    ACT_ICONS.clear,
    "wallet",
    "Wallet Not Found",
    "The server holds no wallet; set one up to continue",
  );
  _showWalletFileGoneDialog();
}

// Clear Wallet's tooltip while a Clear may go ahead, as in index.html.
const _CLEAR_TITLE = "Clear wallet from server and browser";

/**
 * Hold Clear Wallet to the server's rule on every status answer
 * (dashboard-data.js): disabled, the reason its tooltip, while the answer
 * says a Clear would be refused (`clearWalletRefusal`,
 * src/server/wallet-clear.js): while the server, having refused to
 * start, waits to exit; while a wallet import or the start-up of the
 * saved positions is under way; while a rebalance or compound is under
 * way, or a position is starting; or while an unlock, a Reveal Key or
 * the launch's key step uses the wallet. Enabled otherwise.
 * @param {string|null|undefined} refusal  The answer's `clearWalletRefusal`.
 */
export function paintClearWalletButton(refusal) {
  const clearBtn = g("wsClearBtn");
  if (!clearBtn) return;
  const refused = typeof refusal === "string";
  clearBtn.disabled = refused;
  clearBtn.title = refused ? refusal : _CLEAR_TITLE;
}

/**
 * Why a Clear the server did not confirm was not done, in the operator's
 * words: no answer at all, the server's refusal (409), or the error it
 * answered with.
 * @param {Response|null} res  The answer, or null when the server could
 *   not be reached.
 * @returns {Promise<string>}
 */
async function _whyNotCleared(res) {
  if (res === null)
    return (
      "No answer came from the server, so this page cannot tell whether " +
      "the wallet was cleared. Once the server is running, reload the " +
      "page to see the wallet as the server holds it."
    );
  let error = null;
  try {
    const d = await res.json();
    if (typeof d.error === "string") error = d.error;
  } catch {
    /* no body: the status alone says what happened */
  }
  if (res.status === 409 && error !== null)
    return `${error} Nothing was changed.`;
  const said = error === null ? "" : `: ${error}`;
  return (
    `The server answered with an error (${res.status}${said}). ` +
    "Reload the page to see the wallet as the server holds it."
  );
}

/**
 * Show one of the Clear's notices: the template `tplId`, filled by
 * `fill`, in an overlay with the id `id`, replacing one already shown,
 * and gone when its OK is clicked.
 * @param {string} id  The overlay's id.
 * @param {string} tplId  The template's id.
 * @param {(frag: DocumentFragment) => void} fill
 */
function _showClearNotice(id, tplId, fill) {
  document.getElementById(id)?.remove();
  const frag = cloneTpl(tplId);
  if (!frag) return;
  fill(frag);
  const o = document.createElement("div");
  o.className = "9mm-pos-mgr-modal-overlay";
  o.id = id;
  o.appendChild(frag);
  o.querySelector("[data-dismiss-modal]").addEventListener("click", () =>
    o.remove(),
  );
  document.body.appendChild(o);
}

/**
 * Say that a Clear was not done, or got no answer, and why: in the
 * browser's log, in the Activity Log, and in the Wallet not cleared
 * dialog, headed Clear Wallet: no answer when no answer came, since a
 * server stopped partway may have cleared the wallet. The page keeps its
 * wallet, since the server did not say it cleared it.
 * @param {string} reason
 * @param {boolean} answered  Whether the server answered at all.
 */
function _showNotCleared(reason, answered) {
  if (answered) {
    log.warn("[lp-ranger] [wallet] Clear Wallet not done: %s", reason);
    act("⚠️", "warning", "Wallet Not Cleared", reason);
  } else {
    log.warn("[lp-ranger] [wallet] Clear Wallet got no answer: %s", reason);
    act("⚠️", "warning", "Clear Wallet: No Answer", reason);
  }
  _showClearNotice(
    WALLET_NOT_CLEARED_NOTICE_ID,
    "tplWalletNotClearedModal",
    (frag) => {
      if (!answered)
        frag.querySelector('[data-tpl="heading"]').textContent =
          "Clear Wallet: no answer";
      frag.querySelector('[data-tpl="reason"]').textContent = reason;
    },
  );
}

/**
 * What a Clear the server did could not remove, from its answer
 * (`warnings`): a `.env` it could not rewrite, or a setting from the
 * environment the server was started from.
 * @param {Response} res  The 200 answer.
 * @returns {Promise<string[]>}  Empty when nothing was left.
 */
async function _clearWarnings(res) {
  try {
    const d = await res.json();
    return Array.isArray(d.warnings)
      ? d.warnings.filter((w) => typeof w === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * Say what a Clear could not remove: in the browser's log, in the
 * Activity Log, and in the Wallet cleared: finish by hand dialog, one
 * paragraph for each.
 * @param {string[]} warnings
 */
function _showClearedLeft(warnings) {
  for (const w of warnings) {
    log.warn("[lp-ranger] [wallet] Clear Wallet left: %s", w);
    act("⚠️", "warning", "Wallet Cleared: Finish by Hand", w);
  }
  _showClearNotice(
    WALLET_CLEARED_LEFT_NOTICE_ID,
    "tplWalletClearedLeftModal",
    (frag) => {
      const where = frag.querySelector('[data-tpl="warnings"]');
      for (const w of warnings) {
        const p = document.createElement("p");
        p.textContent = w;
        where.appendChild(p);
      }
    },
  );
}

/**
 * Clear Wallet, once the operator confirms. The page forgets the wallet
 * only when the server answers that it cleared it (200): it then holds
 * no wallet and no key, and has stopped every position. What the server
 * could not remove, it names in its answer, and the page shows it
 * (`_showClearedLeft`). Any other outcome keeps the wallet and says why
 * (`_showNotCleared`).
 */
export async function confirmClearWallet() {
  closeClearWalletModal();
  let res = null;
  try {
    res = await fetchWithCsrf("/api/wallet", { method: "DELETE" });
  } catch {
    /* the server could not be reached: no answer */
  }
  if (res === null || res.status !== 200) {
    _showNotCleared(await _whyNotCleared(res), res !== null);
    return;
  }
  const warnings = await _clearWarnings(res);
  _forgetWalletOnThisPage();
  log.info("[lp-ranger] [wallet] Clear Wallet done");
  act(
    ACT_ICONS.clear,
    "wallet",
    "Wallet Cleared",
    "Wallet and key removed from server and browser; every position stopped",
  );
  if (warnings.length > 0) _showClearedLeft(warnings);
}
