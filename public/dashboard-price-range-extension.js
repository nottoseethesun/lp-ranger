/**
 * @file dashboard-price-range-extension.js
 * @description Config handlers for the "Price Range Extension" input
 * and its companion "Full-Range" checkbox in Bot Settings → Range &
 * Execution.  Extracted from `dashboard-throttle.js` to keep that file
 * under the 500-line cap after the "Range Width" → "Price Range
 * Extension" rename brought a new Full-Range save handler in.
 *
 * Exports:
 *  - `saveRangeWidth` — Save button: persist the typed value if it's
 *    a legal number in [0.1, 200].
 *  - `resetRangeWidth` — No Override button: clear the saved value
 *    (POST null so the null-sweep in POST /api/config deletes the key
 *    from disk) and empty the input.
 *  - `setDefaultRangeWidth` — Default button: inject the shipped
 *    default into the input (user still has to click Save to persist).
 *  - `saveFullRangeToggle` — Change handler on the Full-Range
 *    checkbox: persist the boolean and disable/enable the input.
 *  - `wirePriceRangeExtensionEvents` — one-shot wire-up used by
 *    `dashboard-events.js:bindAllEvents`.
 */

"use strict";

import {
  g,
  act,
  ACT_ICONS,
  compositeKey,
  fetchWithCsrf,
  isFullRangeSpread,
} from "./dashboard-helpers.js";
import { posStore } from "./dashboard-positions.js";
import {
  _posLabel,
  markInputDirty,
  getInputDefault,
} from "./dashboard-data.js";
import { labelForKey } from "./dashboard-setting-labels.js";
import { _saveSingleConfig } from "./dashboard-throttle.js";

/**
 * Save the "Price Range Extension" input as a persistent per-position
 * override.  Rejects invalid input per
 * feedback_one_literal_per_shipped_default — no silent clamp-to-default;
 * the user must enter a valid number in [0.1, 200] to save.  Full-range
 * behavior is now a separate boolean (`fullRangeRebalanceEnabled`,
 * driven by the Full-Range checkbox) — 100 is NO LONGER a sentinel
 * here.  Empty input, NaN, out-of-range → skip the save (the No
 * Override button below is the explicit way to clear).
 */
export function saveRangeWidth() {
  const raw = parseFloat(g("inRangeWidth")?.value);
  if (!Number.isFinite(raw) || raw < 0.1 || raw > 200) return;
  _saveSingleConfig("inRangeWidth", "rebalanceRangeWidthPct", () => raw);
}

/**
 * Clear ALL persistent Price Range Extension overrides for this
 * position — the numeric override (`rebalanceRangeWidthPct`) AND the
 * Full-Range boolean (`fullRangeRebalanceEnabled`).  Empties the input
 * and syncs the Full-Range checkbox to on-chain reality: stays checked
 * only if the current NFT is genuinely full-range.  POSTs both keys as
 * `null` so the null-sweep in POST /api/config deletes them from disk,
 * leaving the bot on the existing `preserveRange()` fallback for the
 * next rebalance.
 */
export function resetRangeWidth() {
  const el = g("inRangeWidth");
  if (el) el.value = "";
  markInputDirty("inRangeWidth");
  const active = posStore.getActive();
  /*- Sync the Full-Range checkbox to on-chain reality NOW (don't
   *  wait for the next poll's `syncFullRangeCheckbox`).  If the NFT
   *  is genuinely full-range, the checkbox stays checked; otherwise
   *  it unchecks and the input re-enables. */
  const chk = g("chkFullRange");
  if (chk) {
    const tL = active?.tickLower;
    const tU = active?.tickUpper;
    const isFullRange =
      Number.isFinite(tL) && Number.isFinite(tU) && isFullRangeSpread(tU - tL);
    chk.checked = isFullRange;
    if (el) el.disabled = isFullRange;
  }
  const positionKey = active
    ? compositeKey(
        "pulsechain",
        active.walletAddress,
        active.contractAddress,
        active.tokenId,
      )
    : undefined;
  fetchWithCsrf("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      rebalanceRangeWidthPct: null,
      fullRangeRebalanceEnabled: null,
      positionKey,
    }),
  }).catch(() => {});
  const pl = _posLabel();
  act(
    ACT_ICONS.gear,
    "start",
    "Setting Saved",
    labelForKey("rebalanceRangeWidthPct") +
      " cleared — preserving current Range Width" +
      (pl ? "\n" + pl : ""),
  );
}

/**
 * Save the "Full-Range" checkbox state as a persistent per-position
 * boolean.  When checked, the rebalancer mints at MIN_TICK / MAX_TICK
 * (via `rangeMath.fullRange()`) on every subsequent rebalance,
 * ignoring any saved Price Range Extension.  When unchecked, the
 * normal precedence applies (Price Range Extension → preserveRange).
 * Also flips the disabled state of the Price Range Extension input.
 */
export function saveFullRangeToggle() {
  const chk = g("chkFullRange");
  if (!chk) return;
  const checked = !!chk.checked;
  const input = g("inRangeWidth");
  if (input) input.disabled = checked;
  const active = posStore.getActive();
  const positionKey = active
    ? compositeKey(
        "pulsechain",
        active.walletAddress,
        active.contractAddress,
        active.tokenId,
      )
    : undefined;
  fetchWithCsrf("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fullRangeRebalanceEnabled: checked,
      positionKey,
    }),
  }).catch(() => {});
  const pl = _posLabel();
  act(
    ACT_ICONS.gear,
    "start",
    "Setting Saved",
    (checked
      ? "Full-Range Rebalance enabled — Price Range Extension override ignored"
      : "Full-Range Rebalance disabled") + (pl ? "\n" + pl : ""),
  );
}

/**
 * Populate the Price Range Extension input with the shipped default
 * sourced from `bot-config-defaults.json` (loaded once at init via
 * `/api/bot-config-defaults` and cached in `_CONFIG_INPUT_DEFAULTS`).
 * Marks the input dirty so the next poll's `syncRangeWidth` won't
 * clobber the injected value; the user still has to click Save to
 * persist.  No-op when the default hasn't loaded yet (init AJAX
 * hasn't resolved) or the input is missing.
 */
export function setDefaultRangeWidth() {
  const def = getInputDefault("rebalanceRangeWidthPct");
  if (!Number.isFinite(def)) return;
  const el = g("inRangeWidth");
  if (!el) return;
  el.value = String(def);
  markInputDirty("inRangeWidth");
}

/**
 * Wire up every event for the Price Range Extension row (input, three
 * buttons, and the Full-Range checkbox).  Called once from
 * `dashboard-events.js:bindAllEvents`.  Accepts the helpers as
 * parameters to avoid a circular-import cycle back through
 * dashboard-events.js.
 * @param {(id:string,fn:Function)=>void} onClick
 * @param {(id:string,fn:Function)=>void} onInput
 * @param {(id:string,fn:Function)=>void} onChange
 */
export function wirePriceRangeExtensionEvents(onClick, onInput, onChange) {
  onClick("saveRangeWidthBtn", saveRangeWidth);
  onClick("resetRangeWidthBtn", resetRangeWidth);
  onClick("defaultRangeWidthBtn", setDefaultRangeWidth);
  onChange("chkFullRange", saveFullRangeToggle);
  /*- Mark the input dirty on every keystroke so the per-poll
   *  `syncRangeWidth` (dashboard-data-range-width.js) can't clobber
   *  mid-typing when a saved override already exists.  Dirty is
   *  cleared at end of poll (`clearDirtyInputs`); by the time Save
   *  fires and the next poll returns the persisted value, the
   *  saved-value overwrite is idempotent (matches typed value). */
  onInput("inRangeWidth", () => markInputDirty("inRangeWidth"));
}
