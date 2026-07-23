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

import { log } from "./dashboard-log.js";
import {
  g,
  botConfig,
  toggleSettingsPopover,
  clearLocalStorageAndCookies,
  fetchWithCsrf,
  showDisclosure,
  copyElText,
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
  posRowClick,
  posRowSelect,
} from "./dashboard-positions.js";
import { removeSelectedPos } from "./dashboard-positions-browser.js";
import {
  onParamChange,
  saveOorThreshold,
  saveOorTimeout,
  saveMinInterval,
  saveMaxReb,
  saveCheckInterval,
  saveGasStrategy,
  saveOffset,
  resetOffset,
  saveApprovalMultiple,
  updateOffsetComplement,
} from "./dashboard-throttle.js";
import { wirePriceRangeExtensionEvents } from "./dashboard-price-range-extension.js";
import { wirePerTokenSlippageEvents } from "./dashboard-per-token-slippage.js";
import {
  openRebalanceConfirm,
  closeRebalanceConfirm,
  confirmRebalance,
} from "./dashboard-rebalance-confirm.js";
import {
  compoundNow,
  toggleAutoCompound,
  saveCompoundThreshold,
} from "./dashboard-compound.js";
import { saveGasFeePct } from "./dashboard-gas-fee-settings.js";
import {
  closeAllPositionsStatsModal,
  wireAllPositionsStatsEvents,
} from "./dashboard-all-positions-stats.js";
import {
  toggleInitialDeposit,
  saveInitialDeposit,
  toggleRealizedInput,
  saveRealizedGains,
  toggleCurDeposit,
  saveCurDeposit,
  toggleCurRealized,
  saveCurRealized,
  toggleLifetimeDays,
  saveLifetimeDays,
} from "./dashboard-data.js";
/*- Direct import from the owning module per feedback-no-reexports —
 *  the reset handlers have no other consumer, so re-exporting them
 *  through dashboard-data.js would only pad that file's line count. */
import {
  resetLifetimeDays,
  resetInitialDeposit,
  resetRealizedGains,
  resetCurRealized,
  resetCurDeposit,
} from "./dashboard-data-deposit.js";
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
import { showILDebug, dismissILDebug } from "./dashboard-il-debug.js";
import {
  showNetPnlBreakdown,
  showCurPnlBreakdown,
} from "./dashboard-param-help.js";
import {
  _togglePrivacy,
  _bindCopyBtn,
  _openPoolDetailsModal,
  _toggleManagePosition,
  bindDelegatedEvents,
} from "./dashboard-events-manage.js";
import { _reloadCurrentPosition } from "./dashboard-reload-flow.js";

/*- Re-export only the symbols dashboard-events.js's external callers
 *  use that don't have a more specific owner.  `updateManageBadge` is
 *  imported directly from dashboard-events-manage.js by its sole caller
 *  (dashboard-data.js) — no barrel needed; closes a latent
 *  feedback_no_reexports violation. */
export {
  reapplyPrivacyBlur,
  restorePrivacyMode,
  injectPosStoreForEvents,
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
function _show(id) {
  const o = g(id);
  if (o) o.classList.remove("hidden");
}
function _hide(id) {
  const o = g(id);
  if (o) o.classList.add("hidden");
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
  fetchWithCsrf("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ [configKey]: el.value }),
  }).catch(() => {});
}

import {
  saveMoralisApiKey,
  saveMoralisKeyFromSettings as _saveMoralisKey,
} from "./dashboard-moralis-key.js";
export { saveMoralisApiKey };

import { checkForUpdate as _checkForUpdate } from "./dashboard-update-check.js";

/*- Table-driven wiring for the "Return to Automatic Detection" reset
 *  buttons and their paired Cancel buttons across every inline-edit
 *  dialog.  Extracted from `bindAllEvents` to keep that function's
 *  cyclomatic complexity under the 17-cap.  Cancel just removes the
 *  `open` class from the wrap; it never touches the stored value (see
 *  feedback-inline-edit-dialog-button-set). */
function _wireResetAndCancelButtons() {
  /*- Each row is a `[prefix, resetFn]` pair.  The three element IDs
   *  are derived by convention: `${prefix}InputWrap`, `${prefix}ResetBtn`,
   *  `${prefix}CancelBtn` — every inline-edit dialog follows the same
   *  naming, keeping this table maintenance-free as new ones are added. */
  const rows = [
    ["lifetimeDays", resetLifetimeDays],
    ["initialDeposit", resetInitialDeposit],
    ["realizedGains", resetRealizedGains],
    ["curDeposit", resetCurDeposit],
    ["curRealized", resetCurRealized],
  ];
  for (const [prefix, resetFn] of rows) {
    _click(`${prefix}ResetBtn`, resetFn);
    _click(`${prefix}CancelBtn`, () => {
      const wrap = g(`${prefix}InputWrap`);
      if (wrap) wrap.classList.remove("open");
    });
  }
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
  wireAllPositionsStatsEvents();
  _click("posPrevBtn", () => posChangePage(-1));
  _click("posNextBtn", () => posChangePage(1));
  _click("posSelectBtn", activateSelectedPos);
  _click("posRemoveBtn", removeSelectedPos);
  const posList = g("posList");
  if (posList) {
    /*- We can't use a native `dblclick` listener: each click runs
     *  posRowClick → renderPosBrowser → list.replaceChildren(), so the
     *  second click lands on a freshly-rendered DOM node and the browser
     *  never sees two clicks on the same target. Instead we detect a
     *  double-click ourselves: same row index + within 400 ms = open. */
    let _lastIdx = -1;
    let _lastTs = 0;
    const DBLCLICK_MS = 400;
    posList.addEventListener("click", (e) => {
      const row = e.target.closest("[data-pos-idx]");
      if (!row) return;
      const idx = parseInt(row.dataset.posIdx, 10);
      const now = Date.now();
      const isDbl = idx === _lastIdx && now - _lastTs < DBLCLICK_MS;
      log.info(
        "[posList] click idx=%d isDbl=%s (lastIdx=%d, dt=%dms)",
        idx,
        isDbl,
        _lastIdx,
        now - _lastTs,
      );
      if (isDbl) {
        _lastIdx = -1;
        _lastTs = 0;
        posRowSelect(idx);
        log.info("[posList] activating idx=%d", idx);
        activateSelectedPos();
        return;
      }
      _lastIdx = idx;
      _lastTs = now;
      posRowClick(idx);
    });
  }

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

  /*- Password-manager-friendly wrapper forms have no action/handler. Prevent
   *  Enter-key submissions from reloading the page. unlockForm has its own
   *  submit handler above, so the noop binding below is a no-op for it. */
  document
    .querySelectorAll('form[class~="9mm-pos-mgr-noop-form"]')
    .forEach((f) => f.addEventListener("submit", (e) => e.preventDefault()));
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
  _click("donateBtn", () => _show("donateOverlay"));
  _click("donateClose", () => _hide("donateOverlay"));
  _click("donateCopyBtn", () => copyElText("donateAddr", "donateCopyBtn"));
  _click("disclosuresBtn", showDisclosure);
  _click("reloadPositionBtn", _reloadCurrentPosition);
  _click("clearStorageBtn", clearLocalStorageAndCookies);
  _click("aboutBtn", () => {
    _show("aboutOverlay");
    _checkForUpdate();
  });
  _click("aboutClose", () => _hide("aboutOverlay"));
  _click("wsAddrCopy", () => copyElText("wsAddr", "wsAddrCopy"));
  _click("wsTokenCopy", () => copyElText("wsToken", "wsTokenCopy"));
  _click("moralisKeySaveBtn", _saveMoralisKey);
  _click("saveGasFeePctBtn", saveGasFeePct);

  /* ── Wallet strip ─────────────────────── */
  _click("wsRevealBtn", openRevealModal);
  _click("wsClearBtn", clearWalletUI);
  const ps = document.querySelector(".ws-pos-summary");
  if (ps) ps.addEventListener("click", openPosBrowser);

  /* ── Privacy toggle ───────────────────── */
  const priv = g("privacySwitch");
  if (priv) priv.addEventListener("change", _togglePrivacy);

  /* ── KPI / P&L section ────────────────── */
  /*- Table-driven binding for the three "inline edit" rows
   *  (initialDeposit / lifetimeDays / realizedGains).  Each row has a
   *  label that toggles the input open, a number input whose `change`
   *  event triggers save, and a `.realized-gains-save` button. */
  const _editRows = [
    [
      "initialDepositRow",
      "initialDepositLabel",
      "initialDepositInput",
      toggleInitialDeposit,
      saveInitialDeposit,
    ],
    [
      "lifetimeDaysRow",
      "lifetimeDaysLabel",
      "lifetimeDaysInput",
      toggleLifetimeDays,
      saveLifetimeDays,
    ],
    [
      "realizedGainsRow",
      "realizedGainsLabel",
      "realizedGainsInput",
      toggleRealizedInput,
      saveRealizedGains,
    ],
  ];
  for (const [rowId, labelId, inputId, toggleFn, saveFn] of _editRows) {
    _click(labelId, toggleFn);
    _change(inputId, saveFn);
    const btn = document.querySelector("#" + rowId + " .realized-gains-save");
    if (btn) btn.addEventListener("click", saveFn);
  }
  /*- Cancel + Return-to-Automatic buttons on the Lifetime Days and
   *  Lifetime Deposit rows.  Cancel is purely a visual-collapse
   *  affordance (does NOT clear the override).  Return-to-Automatic
   *  clears the override outright and reverts to auto-detection. */
  _wireResetAndCancelButtons();
  _click("curDepositLabel", toggleCurDeposit);
  _change("curDepositInput", saveCurDeposit);
  _click("curDepositSaveBtn", saveCurDeposit);
  _click("curRealizedLabel", toggleCurRealized);
  _change("curRealizedInput", saveCurRealized);
  _click("curRealizedSaveBtn", saveCurRealized);

  /* ── Bot configuration ────────────────── */
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
      ":not(#saveFactoryBtn)" +
      ":not(#saveOffsetBtn)" +
      ":not(#resetOffsetBtn)" +
      ":not(#saveRangeWidthBtn)" +
      ":not(#resetRangeWidthBtn)" +
      ":not(#defaultRangeWidthBtn)" +
      ":not(#saveApprovalMultipleBtn)",
    "click",
    saveOorThreshold,
  );
  _click("saveOorTimeoutBtn", saveOorTimeout);
  _click("savePMBtn", () => _saveGlobalConfig("inPM", "positionManager"));
  _click("saveFactoryBtn", () => _saveGlobalConfig("inFactory", "factory"));
  _click("saveMinIntervalBtn", saveMinInterval);
  _click("saveMaxRebBtn", saveMaxReb);
  _click("saveIntervalBtn", saveCheckInterval);
  _click("saveOffsetBtn", saveOffset);
  _click("resetOffsetBtn", resetOffset);
  wirePriceRangeExtensionEvents(_click, _input, _change);
  wirePerTokenSlippageEvents(_click, _input);
  _click("saveApprovalMultipleBtn", saveApprovalMultiple);

  /* ── Offset linked inputs ── */
  _change("inOffsetToken0", () => updateOffsetComplement("inOffsetToken0"));
  _change("inOffsetToken1", () => updateOffsetComplement("inOffsetToken1"));

  /* ── Offset copy icons (delegate on prow) ── */
  const offsetRow = g("copyOffsetT0")?.closest(".prow");
  if (offsetRow)
    offsetRow.addEventListener("click", (e) => {
      const b = e.target.closest("[data-copy-addr]");
      if (!b || !b.dataset.copyAddr) return;
      navigator.clipboard.writeText(b.dataset.copyAddr).catch(() => {});
      const orig = b.textContent;
      b.textContent = "\u2713";
      setTimeout(() => {
        b.textContent = orig;
      }, 1200);
    });

  /* ── Dirty-flag: mark config inputs as edited so poll skips overwrite ── */
  for (const id of [
    "inOorThreshold",
    "inOorTimeout",
    "inSlipToken0",
    "inSlipToken1",
    "inInterval",
    "inMinInterval",
    "inMaxReb",
    "autoCompoundThreshold",
    "inOffsetToken0",
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
  _click("rebalanceWithRangeBtn", openRebalanceConfirm);
  _click("ilWarnCancelBtn", closeRebalanceConfirm);
  _click("ilWarnConfirmBtn", confirmRebalance);
  _click("compoundNowBtn", compoundNow);
  _change("autoCompoundToggle", toggleAutoCompound);
  _click("saveCompoundThresholdBtn", () => {
    /*- No literal fallback per feedback_one_literal_per_shipped_default:
     *  shipped default lives only in app-runtime.json (COMPOUND_MIN_FEE_USD
     *  → botConfig.compoundMinFee).  Skip the save when the AJAX-
     *  populated value is undefined; the button is disabled in that
     *  state anyway (see dashboard-data-status._updateCompoundButton). */
    if (botConfig.compoundMinFee === undefined) return;
    saveCompoundThreshold(botConfig.compoundMinFee);
  });

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
  _click("curNetPnlInfo", showCurPnlBreakdown);
  _click("ltNetPnlInfo", showNetPnlBreakdown);

  /* ── Delegated events + Escape key ────── */
  bindDelegatedEvents({
    walletModal: closeWalletModal,
    posBrowser: closePosBrowser,
    revealModal: closeRevealModal,
    clearWallet: closeClearWalletModal,
    rebalanceIlWarning: closeRebalanceConfirm,
    throttleInfo: closeTI,
    ilDebug: dismissILDebug,
    donate: () => _hide("donateOverlay"),
    about: () => _hide("aboutOverlay"),
    allPositionsStats: closeAllPositionsStatsModal,
  });
}
