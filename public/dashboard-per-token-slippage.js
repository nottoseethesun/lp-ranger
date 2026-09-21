/**
 * @file dashboard-per-token-slippage.js
 * @description Config handlers for the two per-token slippage inputs
 * ("Slippage (Token 0)" / "Slippage (Token 1)") in Bot Settings →
 * Execution.
 *
 * Confirmation on Save.  Whether a figure is acceptable at all is the
 * server's question (`src/config-bounds.js`); these tiers only ask the
 * operator to mean it, because a high slippage is accepted and costly
 * rather than wrong:
 *   - v up to 5: save immediately.
 *   - v in (5, 10): show "Elevated Slippage" confirm modal (Confirm /
 *     Cancel).  Confirm → save; Cancel → revert input to previous
 *     value (saved server value or shipped default).
 *   - v of 10 or more: show "Extreme Slippage" type-Confirm modal —
 *     user must type "Confirm" (case-sensitive) into an
 *     autofill-resistant text box.  Confirm → save; Cancel → revert.
 *   - A figure outside what the server accepts comes back as a 400 and
 *     the field is put back to the last accepted value.
 *
 * The per-poll sync populates the input with either the saved value
 * or the shipped default (0.75%), so the input is never empty.
 *
 * The legacy `slippagePct` field on disk is dormant — the swap layer
 * (see src/slippage-resolver.js) uses only the per-token values.
 */

"use strict";

import { g } from "./dashboard-helpers.js";
import {
  markInputDirty,
  getInputDefault,
  getLastStatus,
} from "./dashboard-data.js";
import { isInputDirty } from "./dashboard-data-cache.js";
import { posStore } from "./dashboard-positions-store.js";
import { _saveSingleConfig } from "./dashboard-throttle.js";

let _lastKnownPosKey = null;

/*- Per-Save-attempt state.  Set when a validation modal is shown;
 *  read by the modal's Confirm / Cancel handlers.  A single set of
 *  fields is sufficient because only one modal can be visible at a
 *  time (both slippage rows share the same modal DOM). */
const _pending = { inputId: null, configKey: null, raw: null };

/** Fallback used by Cancel: server-saved value if any, else shipped
 *  default.  Same value the per-poll sync would populate. */
function _revertValue(configKey) {
  const saved = getLastStatus()?.[configKey];
  if (saved !== undefined && saved !== null && Number.isFinite(saved)) {
    return saved.toFixed(2);
  }
  const def = getInputDefault("slippagePct");
  return Number.isFinite(def) ? def.toFixed(2) : "";
}

/** Modal-open helper — removes the `hidden` class. */
function _showModal(id) {
  const m = g(id);
  if (m) m.classList.remove("hidden");
}

/** Modal-close helper — adds the `hidden` class. */
function _hideModal(id) {
  const m = g(id);
  if (m) m.classList.add("hidden");
}

/** Actually commit the save (no more prompts). */
function _commitSave(inputId, configKey, raw) {
  _saveSingleConfig(inputId, configKey, () => raw);
}

/** Cancel handler shared by both confirm modals: revert the input to
 *  the previous saved value / shipped default and clear pending state. */
function _cancelPending() {
  if (!_pending.inputId) return;
  const el = g(_pending.inputId);
  if (el) {
    el.value = _revertValue(_pending.configKey);
    markInputDirty(_pending.inputId);
  }
  _pending.inputId = null;
  _pending.configKey = null;
  _pending.raw = null;
}

/** Confirm handler shared by both confirm modals: commit the pending
 *  save and clear state. */
function _confirmPending() {
  if (!_pending.inputId) return;
  _commitSave(_pending.inputId, _pending.configKey, _pending.raw);
  _pending.inputId = null;
  _pending.configKey = null;
  _pending.raw = null;
}

/** Reset the type-Confirm modal's text input + disabled state so
 *  every open starts fresh. */
function _resetTypeConfirmInput() {
  const input = g("slipAbove10ConfirmInput");
  if (input) input.value = "";
  const btn = g("slipAbove10ConfirmBtn");
  if (btn) btn.disabled = true;
}

/** Save-button entrypoint: reads the input, validates, routes to the
 *  appropriate modal or commits the save. */
function _handleSave(inputId, configKey) {
  const el = g(inputId);
  const raw = parseFloat(el?.value);
  const valueLabel = Number.isFinite(raw) ? raw.toFixed(2) : String(el?.value);
  /*- Whether the figure is one the app can run on is the server's
   *  question — it answers 400 and the field goes back. The two modals
   *  below are not that: they are confirmations for a value that IS
   *  accepted and is merely expensive, so they stay in the browser
   *  where the operator can be asked before anything is sent. */
  /*- Extreme tier — require typed confirmation. */
  if (raw >= 10) {
    _pending.inputId = inputId;
    _pending.configKey = configKey;
    _pending.raw = raw;
    const disp = g("slipAbove10Value");
    if (disp) disp.textContent = valueLabel;
    _resetTypeConfirmInput();
    _showModal("slippageAbove10TypeConfirmModal");
    return;
  }
  /*- Elevated tier — one-click confirm. */
  if (raw > 5) {
    _pending.inputId = inputId;
    _pending.configKey = configKey;
    _pending.raw = raw;
    const disp = g("slipAbove5Value");
    if (disp) disp.textContent = valueLabel;
    _showModal("slippageAbove5ConfirmModal");
    return;
  }
  /*- Normal tier — save immediately. */
  _commitSave(inputId, configKey, raw);
}

/** Save Token 0's slippage. */
export function saveSlipToken0() {
  _handleSave("inSlipToken0", "slippagePctToken0");
}

/** Save Token 1's slippage. */
export function saveSlipToken1() {
  _handleSave("inSlipToken1", "slippagePctToken1");
}

/** Shared per-poll populator for one per-token slippage input.  When
 *  no saved value exists, seed the input with the shipped
 *  `slippagePct` default so the user sees the same number the swap
 *  layer would apply.  Zero-empty-state by design. */
function _syncOne(inputId, savedValue, isNewPosition, shippedDefault) {
  const el = g(inputId);
  if (!el) return;
  if (isInputDirty(inputId)) return;
  if (
    savedValue !== undefined &&
    savedValue !== null &&
    Number.isFinite(savedValue)
  ) {
    if (isNewPosition || el.value === "") el.value = savedValue.toFixed(2);
    return;
  }
  if (isNewPosition || el.value === "") {
    el.value = Number.isFinite(shippedDefault) ? shippedDefault.toFixed(2) : "";
  }
}

/**
 * Populate both per-token slippage inputs from the poll payload.
 * Empty saved value → seed input with the shipped `slippagePct`
 * default so the visible value matches what the swap layer will use.
 */
export function syncPerTokenSlippage(data) {
  const posKey = posStore.getActive()?.tokenId;
  if (!posKey) return;
  const isNewPosition = _lastKnownPosKey !== posKey;
  const shippedDefault = getInputDefault("slippagePct");
  _syncOne(
    "inSlipToken0",
    data?.slippagePctToken0,
    isNewPosition,
    shippedDefault,
  );
  _syncOne(
    "inSlipToken1",
    data?.slippagePctToken1,
    isNewPosition,
    shippedDefault,
  );
  _lastKnownPosKey = posKey;
}

/**
 * Wire up every event for the two per-token slippage rows AND for
 * the three validation modals.  Called once from
 * `dashboard-events.js:bindAllEvents`.
 * @param {(id:string,fn:Function)=>void} onClick
 * @param {(id:string,fn:Function)=>void} onInput
 */
export function wirePerTokenSlippageEvents(onClick, onInput) {
  onClick("saveSlipToken0Btn", saveSlipToken0);
  onClick("saveSlipToken1Btn", saveSlipToken1);
  onInput("inSlipToken0", () => markInputDirty("inSlipToken0"));
  onInput("inSlipToken1", () => markInputDirty("inSlipToken1"));

  /* ── Validation modal wiring ─────────────────────────────────── */
  onClick("slipAbove5ConfirmBtn", () => {
    _hideModal("slippageAbove5ConfirmModal");
    _confirmPending();
  });
  onClick("slipAbove5CancelBtn", () => {
    _hideModal("slippageAbove5ConfirmModal");
    _cancelPending();
  });
  onClick("slipAbove10ConfirmBtn", () => {
    _hideModal("slippageAbove10TypeConfirmModal");
    _confirmPending();
  });
  onClick("slipAbove10CancelBtn", () => {
    _hideModal("slippageAbove10TypeConfirmModal");
    _cancelPending();
  });
  /*- Enable the Confirm button ONLY when the user has typed the exact
   *  string "Confirm" (case-sensitive) — matches the modal copy. */
  onInput("slipAbove10ConfirmInput", () => {
    const val = g("slipAbove10ConfirmInput")?.value;
    const btn = g("slipAbove10ConfirmBtn");
    if (btn) btn.disabled = val !== "Confirm";
  });
}
