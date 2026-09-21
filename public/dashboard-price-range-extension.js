/**
 * @file dashboard-price-range-extension.js
 * @description Config handlers for the "Price Range Extension" input
 * and its companion "Full-Range" checkbox in Bot Settings → Range.
 * Extracted from `dashboard-throttle.js` to keep that file under the
 * 500-line cap after the "Range Width" → "Price Range Extension"
 * rename brought a new Full-Range save handler in.
 *
 * The row's old "No Override" button is gone: clearing the saved Range
 * settings became the section-level, non-destructive "No Override"
 * toggle in `dashboard-range-override.js`.  This row's field is now
 * either disabled (toggle on) or in force (toggle off) — there is no
 * per-field clear.
 *
 * **Nothing on this row persists until Save is clicked.**  These are
 * financial settings that reshape the position on the next rebalance, so
 * the app never applies a change the user has not committed.  The
 * Full-Range checkbox therefore only flips the field states on
 * `change`; `saveRangeWidth` writes both keys of the row in one
 * request, on Save.
 *
 * Exports:
 *  - `saveRangeWidth` — Save button: persist the row (the typed value if
 *    it's a legal number in [0.1, 200], plus the Full-Range boolean).
 *  - `setDefaultRangeWidth` — Default button: inject the shipped
 *    default into the input (user still has to click Save to persist).
 *  - `onFullRangeToggle` — Change handler on the Full-Range checkbox:
 *    re-apply the field states and mark the choice pending.  Persists
 *    nothing.
 *  - `wirePriceRangeExtensionEvents` — one-shot wire-up used by
 *    `dashboard-events.js:bindAllEvents`.
 */

"use strict";

import { g, act, ACT_ICONS, compositeKey } from "./dashboard-helpers.js";
import { posStore } from "./dashboard-positions.js";
import {
  _posLabel,
  markInputDirty,
  getInputDefault,
} from "./dashboard-data.js";
import { formatSettingChange } from "./dashboard-setting-labels.js";
import { saveConfigValues } from "./dashboard-config-save.js";
import {
  applyRangeFieldState,
  isRangeOverrideActive,
} from "./dashboard-range-override.js";

/**
 * Decide what a Save click on the Price Range Extension row should
 * persist.  Pure so the rules can be driven directly in tests.
 *
 * The row owns two config keys and Save commits both together — one
 * request, one Activity Log line.  Whether the width is a figure the
 * app can run on is decided by `src/config-bounds.js` on the server,
 * not here; this only decides whether the row is asking for a width at
 * all.  The Full-Range boolean always goes, since an unchecked box is a
 * meaningful state the user may be committing.  Full-range behavior is
 * its own boolean — 100 is NOT a sentinel.
 *
 * @param {string|undefined} rawWidth   The width input's raw value.
 * @param {boolean} fullRangeChecked    The Full-Range checkbox state.
 * @returns {{fullRangeRebalanceEnabled:boolean, rebalanceRangeWidthPct?:number}}
 */
export function computeRangeRowPatch(rawWidth, fullRangeChecked) {
  const patch = { fullRangeRebalanceEnabled: fullRangeChecked === true };
  const raw = parseFloat(rawWidth);
  /*- An empty field means "no width override", which is the one case
   *  the key is left out. A figure that is merely out of range IS sent:
   *  the server refuses it by name and the field goes back, where
   *  dropping it here logged "saved" over a width nothing stored. */
  if (!Number.isNaN(raw)) patch.rebalanceRangeWidthPct = raw;
  return patch;
}

/**
 * Save button for the Price Range Extension row: persist the width and
 * the Full-Range boolean in one POST.  This is the ONLY path on the row
 * that writes config — neither the Default button nor the Full-Range
 * checkbox persists anything on its own.
 *
 * There is no per-field clear: the section-level "No Override" toggle is
 * what takes this row out of force, and it does so without erasing it.
 */
export function saveRangeWidth() {
  const patch = computeRangeRowPatch(
    g("inRangeWidth")?.value,
    g("chkFullRange")?.checked === true,
  );
  markInputDirty("inRangeWidth");
  markInputDirty("chkFullRange");
  const active = posStore.getActive();
  const positionKey = active
    ? compositeKey(
        "pulsechain",
        active.walletAddress,
        active.contractAddress,
        active.tokenId,
      )
    : undefined;
  const announce = () => {
    const pl = _posLabel();
    const detail = patch.fullRangeRebalanceEnabled
      ? "Full-Range Rebalance enabled — Price Range Extension ignored"
      : formatSettingChange(
          "rebalanceRangeWidthPct",
          patch.rebalanceRangeWidthPct ?? "\u2014",
        );
    act(
      ACT_ICONS.gear,
      "start",
      "Setting Saved",
      detail + (pl ? "\n" + pl : ""),
    );
  };
  saveConfigValues({
    values: patch,
    positionKey,
    inputs: { rebalanceRangeWidthPct: "inRangeWidth" },
    onSaved: announce,
  });
}

/**
 * Change handler on the "Full-Range" checkbox.  Persists NOTHING — the
 * row's Save button is the only writer, because a checkbox that reshapes
 * the position on the next rebalance must not take effect on a stray
 * click.
 *
 * Two jobs: re-apply the Range section's field states so the Price Range
 * Extension input greys out immediately (`applyRangeFieldState` is the
 * sole owner of `disabled` across the section), and mark the checkbox
 * dirty so the per-poll `syncFullRangeCheckbox` cannot revert an
 * uncommitted choice out from under the user.
 */
export function onFullRangeToggle() {
  const chk = g("chkFullRange");
  if (!chk) return;
  markInputDirty("chkFullRange");
  applyRangeFieldState(isRangeOverrideActive() === true, !!chk.checked);
}

/**
 * Populate the Price Range Extension input with the shipped default
 * sourced from `bot-config-defaults.json` (loaded once at init via
 * `/api/bot-config-defaults` and cached in `_CONFIG_INPUT_DEFAULTS`).
 *
 * Also unchecks "Full-Range".  The two are mutually exclusive — the
 * rebalancer ignores the extension entirely while full-range is on — so
 * leaving the box ticked would leave a default sitting in a disabled
 * field that could never take effect, which reads as the button having
 * done nothing.  Asking for the default extension IS asking not to mint
 * full-range.
 *
 * Stages only: both changes are marked dirty so the per-poll syncs can't
 * clobber them, and the user still has to click Save to persist either
 * one.  No-op when the default hasn't loaded yet (init AJAX hasn't
 * resolved) or the input is missing.
 */
export function setDefaultRangeWidth() {
  const def = getInputDefault("rebalanceRangeWidthPct");
  if (!Number.isFinite(def)) return;
  const el = g("inRangeWidth");
  if (!el) return;
  const chk = g("chkFullRange");
  if (chk?.checked) {
    chk.checked = false;
    markInputDirty("chkFullRange");
  }
  el.value = String(def);
  markInputDirty("inRangeWidth");
  /*- Re-enable the extension input through the section's sole owner of
   *  `disabled` — unticking the box above is what makes it editable. */
  applyRangeFieldState(isRangeOverrideActive() === true, false);
}

/**
 * Wire up every event for the Price Range Extension row (input, the
 * Default and Save buttons, and the Full-Range checkbox).  Called once
 * from
 * `dashboard-events.js:bindAllEvents`.  Accepts the helpers as
 * parameters to avoid a circular-import cycle back through
 * dashboard-events.js.
 * @param {(id:string,fn:Function)=>void} onClick
 * @param {(id:string,fn:Function)=>void} onInput
 * @param {(id:string,fn:Function)=>void} onChange
 */
export function wirePriceRangeExtensionEvents(onClick, onInput, onChange) {
  onClick("saveRangeWidthBtn", saveRangeWidth);
  onClick("defaultRangeWidthBtn", setDefaultRangeWidth);
  onChange("chkFullRange", onFullRangeToggle);
  /*- Mark the input dirty on every keystroke so the per-poll
   *  `syncRangeWidth` (dashboard-data-range-width.js) can't clobber
   *  mid-typing when a saved override already exists.  Dirty is
   *  cleared at end of poll (`clearDirtyInputs`); by the time Save
   *  fires and the next poll returns the persisted value, the
   *  saved-value overwrite is idempotent (matches typed value). */
  onInput("inRangeWidth", () => markInputDirty("inRangeWidth"));
}
