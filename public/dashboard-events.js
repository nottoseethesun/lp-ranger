/**
 * @file dashboard-events.js
 * @description Centralized event binding for
 * the 9mm v3 Position Manager dashboard.
 * Replaces inline HTML event handlers with
 * addEventListener calls and event delegation.
 *
 * Called once from dashboard-init.js after all
 * modules are loaded.
 */

import {
  g,
  act,
  botConfig,
  toggleSettingsPopover,
  clearLocalStorageAndCookies,
  checkMoralisKeyStatus,
} from "./dashboard-helpers.js";
import { markInputDirty } from "./dashboard-data.js";
import {
  closeWalletModal,
  wTab,
  copyText,
  generateWallet,
  checkPasswordMatch,
  confirmWallet,
  validateSeed,
  onSeedConfirmChange,
  importSeed,
  validateKey,
  onKeyConfirmChange,
  importKey,
  closeRevealModal,
  revealWallet,
  openRevealModal,
  clearWalletUI,
  closeClearWalletModal,
  confirmClearWallet,
  openWalletModal,
  submitUnlock,
  dismissToViewOnly,
} from "./dashboard-wallet.js";
import {
  openPosBrowser,
  closePosBrowser,
  renderPosBrowser,
  scanPositions,
  posChangePage,
  activateSelectedPos,
  removeSelectedPos,
  posRowClick,
} from "./dashboard-positions.js";
import {
  onParamChange,
  saveOorThreshold,
  saveOorTimeout,
  saveMinInterval,
  saveMaxReb,
  saveSlippage,
  saveCheckInterval,
  saveGasStrategy,
  openRebalanceRangeModal,
  closeRebalanceRangeModal,
  updateRebalanceRangeHint,
  confirmRebalanceRange,
} from "./dashboard-throttle.js";
import {
  compoundNow,
  toggleAutoCompound,
  saveCompoundThreshold,
} from "./dashboard-compound.js";
import {
  toggleInitialDeposit,
  saveInitialDeposit,
  toggleRealizedInput,
  saveRealizedGains,
  toggleCurDeposit,
  saveCurDeposit,
  toggleCurRealized,
  saveCurRealized,
} from "./dashboard-data.js";
import {
  openPriceOverrideDialog,
  savePriceOverrideDialog,
  closePriceOverrideDialog,
} from "./dashboard-price-override.js";
import {
  rebChangePage,
  rebFirstPage,
  rebLastPage,
  pnlChangePage,
  pnlFirstPage,
  pnlLastPage,
} from "./dashboard-history.js";
import { showILDebug } from "./dashboard-il-debug.js";
import {
  _togglePrivacy,
  _bindCopyBtn,
  _openPoolDetailsModal,
  _toggleManagePosition,
  bindDelegatedEvents,
} from "./dashboard-events-manage.js";

/* Re-export manage module so existing
   importers don't need changes. */
export {
  reapplyPrivacyBlur,
  restorePrivacyMode,
  injectPosStoreForEvents,
  updateManageBadge,
} from "./dashboard-events-manage.js";

/** @param {string} id  @param {Function} fn */
function _click(id, fn) {
  const el = g(id);
  if (el) el.addEventListener("click", fn);
}
/** @param {string} id  @param {Function} fn */
function _input(id, fn) {
  const el = g(id);
  if (el) el.addEventListener("input", fn);
}
/** @param {string} id  @param {Function} fn */
function _change(id, fn) {
  const el = g(id);
  if (el) el.addEventListener("change", fn);
}
/** querySelectorAll + forEach addEventListener */
function _qa(sel, evt, fn) {
  document.querySelectorAll(sel).forEach((el) => el.addEventListener(evt, fn));
}

const _RPC_KEY = "9mm_rpc_url";
/** @param {string} url */
function _saveRpc(url) {
  try {
    localStorage.setItem(_RPC_KEY, url);
  } catch {
    /* private mode */
  }
  _saveGlobalConfig("inRpc", "rpcUrl");
}
/** Save a global config key from an input element to the server. */
function _saveGlobalConfig(inputId, configKey) {
  const el = g(inputId);
  if (!el) return;
  fetch("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ [configKey]: el.value }),
  }).catch(() => {});
}

/**
 * Save a Moralis API key (encrypted with the cached session password).
 * @param {string} key   - The API key value.
 * @param {string} [pw]  - Wallet password (optional; server uses cached).
 * @param {HTMLInputElement} [inp] - Input to clear on success.
 * @returns {Promise<boolean>} true if saved successfully.
 */
export async function saveMoralisApiKey(key, pw, inp) {
  const body = { service: "moralis", key };
  if (pw) body.password = pw;
  try {
    const res = await fetch("/api/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await res.json();
    if (d.ok) {
      if (inp) inp.value = "";
      act(
        "\u{1F511}",
        "info",
        "API Key Saved",
        "Moralis key encrypted & saved",
      );
      return true;
    }
    act("\u274C", "error", "Save Failed", d.error || "Unknown error");
  } catch (err) {
    act("\u274C", "error", "Save Failed", err.message);
  }
  return false;
}

/** Settings menu handler: saves using the cached session password. */
async function _saveMoralisKey() {
  const inp = g("moralisKeyInput");
  if (!inp || !inp.value.trim()) return;
  await saveMoralisApiKey(inp.value.trim(), null, inp);
  checkMoralisKeyStatus();
}

const _CLOSE = '[class~="9mm-pos-mgr-modal-close-btn"]';

/** Wire up all static event handlers. */
export function bindAllEvents() {
  /* ── Wallet modal ─────────────────────── */
  _click("wtab-generate", () => wTab("generate"));
  _click("wtab-seed", () => wTab("seed"));
  _click("wtab-key", () => wTab("key"));
  _qa(`#walletModal ${_CLOSE}`, "click", closeWalletModal);

  _click("genBtn", generateWallet);
  _input("genPassword", () => checkPasswordMatch("gen"));
  _input("genPasswordConfirm", () => checkPasswordMatch("gen"));
  _click("genConfirmBtn", confirmWallet);

  document
    .querySelectorAll(".copy-btn[data-copy-id]")
    .forEach((b) =>
      b.addEventListener("click", () => copyText(b.dataset.copyId)),
    );
  _bindCopyBtn("genAddr");
  _bindCopyBtn("genMnemonic");
  _bindCopyBtn("genKey");
  _bindCopyBtn("revealKey");
  _bindCopyBtn("revealMnemonic");

  _input("seedInput", validateSeed);
  _input("seedPath", validateSeed);
  _change("seedConfirmCheck", onSeedConfirmChange);
  _input("seedPassword", () => checkPasswordMatch("seed"));
  _input("seedPasswordConfirm", () => checkPasswordMatch("seed"));
  _click("seedImportBtn", importSeed);

  _input("keyInput", validateKey);
  _change("keyConfirmCheck", onKeyConfirmChange);
  _input("keyPassword", () => checkPasswordMatch("key"));
  _input("keyPasswordConfirm", () => checkPasswordMatch("key"));
  _click("keyImportBtn", importKey);

  /* ── Reveal key modal ─────────────────── */
  _qa(`#revealModal ${_CLOSE}`, "click", closeRevealModal);
  const revealPw = g("revealPassword");
  if (revealPw)
    revealPw.addEventListener("keydown", (e) => {
      if (e.key === "Enter") revealWallet();
    });
  _click("revealBtn", revealWallet);

  /* ── Clear wallet modal ───────────────── */
  _qa("#clearWalletModal .modal-btn.secondary", "click", closeClearWalletModal);
  _qa(
    "#clearWalletModal" + ' [class~="9mm-pos-mgr-btn-danger"]',
    "click",
    confirmClearWallet,
  );

  /* ── Position browser modal ───────────── */
  _qa(`#posBrowserModal ${_CLOSE}`, "click", closePosBrowser);
  _input("posSearchInput", () => {
    renderPosBrowser();
    const c = g("posSearchClear");
    if (c) c.classList.toggle("hidden", !g("posSearchInput")?.value);
  });
  _click("posSearchClear", () => {
    const inp = g("posSearchInput");
    if (inp) {
      inp.value = "";
      renderPosBrowser();
    }
    const c = g("posSearchClear");
    if (c) c.classList.add("hidden");
  });
  _click("posScanBtn", scanPositions);
  _click("posPrevBtn", () => posChangePage(-1));
  _click("posNextBtn", () => posChangePage(1));
  _click("posSelectBtn", activateSelectedPos);
  _click("posRemoveBtn", removeSelectedPos);
  const posList = g("posList");
  if (posList)
    posList.addEventListener("click", (e) => {
      const row = e.target.closest("[data-pos-idx]");
      if (row) posRowClick(parseInt(row.dataset.posIdx, 10));
    });

  /* ── Pool Details + Manage toggle ─────── */
  _click("poolDetailsBtn", _openPoolDetailsModal);
  _click("poolDetailsCloseBtn", () => {
    const m = g("poolDetailsModal");
    if (m) m.classList.add("hidden");
  });
  _click("manageToggleBtn", _toggleManagePosition);

  /* ── Token price override ─────────────── */
  _click("editPricesLink", openPriceOverrideDialog);
  _click("editPricesLinkLt", openPriceOverrideDialog);
  _click("priceOverrideSave", savePriceOverrideDialog);
  _click("priceOverrideCancel", closePriceOverrideDialog);
  _click("priceOverrideClose", closePriceOverrideDialog);

  /* ── Wallet unlock ────────────────────── */
  const uf = g("unlockForm");
  if (uf) uf.addEventListener("submit", submitUnlock);
  _click("viewOnlyBtn", dismissToViewOnly);
  _click("unlockWalletBtn", () => {
    const m = g("walletUnlockModal");
    if (m) m.classList.remove("hidden");
  });

  /* ── Eye toggle (password fields) ─────── */
  document.querySelectorAll("[data-eye]").forEach((b) =>
    b.addEventListener("click", () => {
      const i = g(b.dataset.eye);
      if (i) i.type = i.type === "password" ? "text" : "password";
    }),
  );

  /* ── Position Browser toggles ─────────── */
  const mgd = g("posManagedOnlyToggle");
  if (mgd) mgd.addEventListener("change", () => renderPosBrowser());
  const cld = g("posClosedToggle");
  if (cld) cld.addEventListener("change", () => renderPosBrowser());
  const ntb = g("posNewTabToggle");
  if (ntb) ntb.addEventListener("change", () => {});

  /* ── Header buttons ───────────────────── */
  document.querySelectorAll("header .pos-browser-btn").forEach((b) => {
    const t = b.textContent;
    if (t.includes("\u{1F4C2}") || t.includes("Position"))
      b.addEventListener("click", openPosBrowser);
    else if (t.includes("\u27F3") || t.includes("Scan"))
      b.addEventListener("click", scanPositions);
  });
  _qa(".hwbtn", "click", openWalletModal);
  _click("settingsBtn", toggleSettingsPopover);
  _click("clearStorageBtn", clearLocalStorageAndCookies);
  _click("moralisKeySaveBtn", _saveMoralisKey);

  /* ── Wallet strip ─────────────────────── */
  _click("wsRevealBtn", openRevealModal);
  _click("wsClearBtn", clearWalletUI);
  const ps = document.querySelector(".ws-pos-summary");
  if (ps) ps.addEventListener("click", openPosBrowser);

  /* ── Privacy toggle ───────────────────── */
  const priv = g("privacySwitch");
  if (priv) priv.addEventListener("change", _togglePrivacy);

  /* ── KPI / P&L section ────────────────── */
  _click("initialDepositLabel", toggleInitialDeposit);
  _change("initialDepositInput", saveInitialDeposit);
  const ds = document.querySelector("#initialDepositRow .realized-gains-save");
  if (ds) ds.addEventListener("click", saveInitialDeposit);
  _click("realizedGainsLabel", toggleRealizedInput);
  _change("realizedGainsInput", saveRealizedGains);
  const rs = document.querySelector("#realizedGainsRow .realized-gains-save");
  if (rs) rs.addEventListener("click", saveRealizedGains);
  _click("curDepositLabel", toggleCurDeposit);
  _change("curDepositInput", saveCurDeposit);
  _click("curDepositSaveBtn", saveCurDeposit);
  _click("curRealizedLabel", toggleCurRealized);
  _change("curRealizedInput", saveCurRealized);
  _click("curRealizedSaveBtn", saveCurRealized);

  /* ── Bot configuration ────────────────── */
  _input("inMinInterval", onParamChange);
  _input("inMaxReb", onParamChange);
  const rpcToggle = g("rpcToggle");
  const rpcList = g("rpcList");
  if (rpcToggle && rpcList) {
    rpcToggle.addEventListener("click", () => rpcList.classList.toggle("open"));
    rpcList.addEventListener("click", (e) => {
      const li = e.target.closest("[data-rpc]");
      if (!li) return;
      const inp = g("inRpc");
      if (inp) {
        inp.value = li.dataset.rpc;
        _saveRpc(inp.value);
      }
      rpcList.classList.remove("open");
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".rpc-combo")) rpcList.classList.remove("open");
    });
  }
  const rpcInp = g("inRpc");
  if (rpcInp) rpcInp.addEventListener("change", () => _saveRpc(rpcInp.value));
  _change("inGas", saveGasStrategy);

  _qa(
    ".save-range-btn" +
      ":not(.save-oor-timeout-btn)" +
      ":not(#savePMBtn)" +
      ":not(#saveFactoryBtn)",
    "click",
    saveOorThreshold,
  );
  _click("saveOorTimeoutBtn", saveOorTimeout);
  _click("savePMBtn", () => _saveGlobalConfig("inPM", "positionManager"));
  _click("saveFactoryBtn", () => _saveGlobalConfig("inFactory", "factory"));
  _click("saveMinIntervalBtn", saveMinInterval);
  _click("saveMaxRebBtn", saveMaxReb);
  _click("saveSlipBtn", saveSlippage);
  _click("saveIntervalBtn", saveCheckInterval);

  /* ── Dirty-flag: mark config inputs as edited so poll skips overwrite ── */
  for (const id of [
    "inOorThreshold",
    "inOorTimeout",
    "inSlip",
    "inInterval",
    "inMinInterval",
    "inMaxReb",
    "autoCompoundThreshold",
  ])
    _change(id, () => markInputDirty(id));

  /* ── Throttle info modal ──────────────── */
  _click("throttleInfoBtn", () => {
    const m = g("throttleInfoModal");
    if (m) m.classList.remove("hidden");
  });
  const closeTI = () => {
    const m = g("throttleInfoModal");
    if (m) m.classList.add("hidden");
  };
  _click("throttleInfoClose", closeTI);
  _click("throttleInfoOk", closeTI);

  /* ── Mission Control ──────────────────── */
  _click("rebalanceWithRangeBtn", openRebalanceRangeModal);
  _click("rebalanceRangeClose", closeRebalanceRangeModal);
  _click("rebalanceRangeCancelBtn", closeRebalanceRangeModal);
  _click("rebalanceRangeConfirmBtn", confirmRebalanceRange);
  _input("rebalanceRangeInput", updateRebalanceRangeHint);
  _click("compoundNowBtn", compoundNow);
  _change("autoCompoundToggle", toggleAutoCompound);
  _click("saveCompoundThresholdBtn", () =>
    saveCompoundThreshold(botConfig.compoundMinFee || 1),
  );

  /* ── Table pagination ─────────────────── */
  _click("rebFirstBtn", rebFirstPage);
  _click("rebPrevBtn", () => rebChangePage(-1));
  _click("rebNextBtn", () => rebChangePage(1));
  _click("rebLastBtn", rebLastPage);
  _click("pnlFirstBtn", pnlFirstPage);
  _click("pnlPrevBtn", () => pnlChangePage(-1));
  _click("pnlNextBtn", () => pnlChangePage(1));
  _click("pnlLastBtn", pnlLastPage);

  /* ── IL/G debug popover ───────────────── */
  _click("curILInfo", () => showILDebug("cur"));
  _click("ltILInfo", () => showILDebug("lt"));

  /* ── Delegated events + Escape key ────── */
  bindDelegatedEvents({
    walletModal: closeWalletModal,
    posBrowser: closePosBrowser,
    revealModal: closeRevealModal,
    clearWallet: closeClearWalletModal,
    rebalanceRange: closeRebalanceRangeModal,
    throttleInfo: closeTI,
  });
}
