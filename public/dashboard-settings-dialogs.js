/**
 * @file dashboard-settings-dialogs.js
 * @description Open/close wiring for the three dialogs claimed out of the
 *   Settings menu — Privacy Mode, Moralis API Key, and Gas Fee Threshold —
 *   so that menu carries menu items only, no inline forms.
 *
 *   Deliberately thin. The controls kept every id they had inline, so all
 *   of their behaviour still lives where it always did
 *   (dashboard-events.js wires the Save buttons, dashboard-events-manage.js
 *   the privacy switches, dashboard-moralis-key.js and
 *   dashboard-gas-fee-settings.js the persistence). This module only moves
 *   visibility, which is why it holds no state of its own.
 *
 *   Opening any of them closes the Settings popover first: the popover is
 *   anchored to the gear and would otherwise hover over the dialog it just
 *   launched.
 */

import { g, clearLocalStorageAndCookies } from "./dashboard-helpers.js";
import { confirmViaDialog } from "./dashboard-confirm-dialog.js";
import { refreshMoralisToggle } from "./dashboard-moralis-key.js";

/*- Dialog overlay ids, in the order they appear in the Settings menu. */
const _PRIVACY = "privacyModal";
const _MORALIS = "moralisKeyModal";
const _GAS_FEE = "gasFeeModal";

/**
 * Hide the Settings popover if it is showing.
 *
 * Imported lazily through a DOM lookup rather than by importing
 * `toggleSettingsPopover` from dashboard-events-manage.js: that module
 * already imports this one's callers, and reaching back into it would
 * close an import cycle.
 * @returns {void}
 */
function _closeSettingsPopover() {
  const sp = g("settingsPopover");
  if (sp) sp.classList.remove("9mm-pos-mgr-visible");
}

/**
 * Show one settings dialog and dismiss the Settings popover behind it.
 * @param {string} id  Overlay element id.
 * @returns {void}
 */
function _open(id) {
  _closeSettingsPopover();
  const m = g(id);
  if (m) m.classList.remove("hidden");
}

/**
 * Hide one settings dialog.
 * @param {string} id  Overlay element id.
 * @returns {void}
 */
function _close(id) {
  const m = g(id);
  if (m) m.classList.add("hidden");
}

/** Open the Privacy Mode dialog. @returns {void} */
export function openPrivacyModal() {
  _open(_PRIVACY);
}

/** Close the Privacy Mode dialog. @returns {void} */
export function closePrivacyModal() {
  _close(_PRIVACY);
}

/** Open the Moralis API Key dialog. @returns {void} */
export function openMoralisKeyModal() {
  _open(_MORALIS);
  /*- Populate on open rather than at page load: the control depends on
   *  whether a key exists, which can change while the dashboard is up. */
  refreshMoralisToggle();
}

/** Close the Moralis API Key dialog. @returns {void} */
export function closeMoralisKeyModal() {
  _close(_MORALIS);
}

/** Open the Gas Fee Threshold dialog. @returns {void} */
export function openGasFeeModal() {
  _open(_GAS_FEE);
}

/** Close the Gas Fee Threshold dialog. @returns {void} */
export function closeGasFeeModal() {
  _close(_GAS_FEE);
}

/**
 * Confirm, then wipe this browser's stored settings.
 *
 * The confirmation used to be a native `confirm()` inside
 * `clearLocalStorageAndCookies`; it now goes through the same tool-grey
 * Action Dialog as Re-scan Prices and Reload Current Position. The guard
 * lives here rather than in dashboard-helpers.js so that module — which
 * nearly every dashboard file imports — takes no dialog dependency.
 * @returns {Promise<void>}
 */
export async function confirmClearStorage() {
  const ok = await confirmViaDialog("tplClearStorageConfirmModal", {
    overlayId: "clearStorageConfirmModal",
  });
  if (ok) clearLocalStorageAndCookies();
}

/**
 * Wire each menu item to its dialog and each dialog's Close button.
 *
 * Lives here rather than in dashboard-events.js so this module owns its
 * three dialogs end to end — and because folding six more `_click` calls
 * into that file pushed it past the 500-line ceiling. Extracted, not
 * compacted.
 *
 * The Save buttons are deliberately NOT wired here: those controls kept
 * the ids they had inline, so dashboard-events.js still binds them
 * exactly as before.
 * @returns {void}
 */
export function bindSettingsDialogEvents() {
  const pairs = [
    ["privacySettingsBtn", openPrivacyModal],
    ["privacyCloseBtn", closePrivacyModal],
    ["moralisKeyBtn", openMoralisKeyModal],
    ["moralisKeyCloseBtn", closeMoralisKeyModal],
    ["gasFeeSettingsBtn", openGasFeeModal],
    ["gasFeeCloseBtn", closeGasFeeModal],
    ["clearStorageBtn", confirmClearStorage],
  ];
  for (const [id, fn] of pairs) {
    const el = g(id);
    if (el) el.addEventListener("click", fn);
  }
}
