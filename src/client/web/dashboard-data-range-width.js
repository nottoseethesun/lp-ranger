/**
 * @file dashboard-data-range-width.js
 * @description Populate the Bot Settings "Price Range Extension" input
 * and the "Full-Range" checkbox from server poll data.  Split out of
 * `dashboard-data.js` to keep that file under the 500-line cap.
 *
 * Behavior (as of the "rename Range Width → Price Range Extension" work):
 *
 *   1. **Input** (`#inRangeWidth`):
 *        - If `data.rebalanceRangeWidthPct` has a saved value, populate
 *          the input verbatim (unless the user is mid-typing on the same
 *          position — dirty-flag gate).
 *        - If NO saved value, LEAVE THE INPUT EMPTY.  We do NOT display
 *          a fallback computed from the position's on-chain tick spread
 *          any more (that was misleading — it looked like a saved value
 *          when the user hadn't set one).  Empty means "preserve the
 *          current Range Width on rebalance" (via `preserveRange()`).
 *
 *   2. **Full-Range checkbox** (`#chkFullRange`):
 *        - If `data.fullRangeRebalanceEnabled === true` → checked.
 *        - If `data.fullRangeRebalanceEnabled === false` → unchecked.
 *        - Otherwise (unset / null), the checkbox reflects on-chain
 *          reality: checked iff the current position IS full-range
 *          (detected via `isFullRangeSpread(spread)`).  This lets a
 *          brand-new user who set up a full-range NFT elsewhere see
 *          that reality reflected without having to save an explicit
 *          config flag first.
 *        - When the checkbox ends up checked, the Price Range Extension
 *          input is disabled (its value is ignored by the rebalancer
 *          when full-range is on).  The `disabled` flag itself is
 *          written by `applyRangeFieldState` in
 *          `dashboard-range-override.js` — the sole owner across the
 *          Range section, since the "No Override" toggle can disable
 *          the same input for an unrelated reason.
 *        - Synced on POSITION SWITCH ONLY, not every poll.  The
 *          checkbox does not save on `change` any more (only the row's
 *          Save button writes config), so a per-poll write would untick
 *          an uncommitted choice within 3 seconds.
 *
 *   3. **Position switch** (posKey changes): force a fresh sync of both
 *      the input and the checkbox from the new position's data.  Clears
 *      any lingering value from the prior position.
 *
 * Related:
 *  - `saveRangeWidth` in `dashboard-price-range-extension.js` is the
 *    ONLY writer of either key — one POST for the whole row.
 *  - `POSITION_KEYS` in `src/lib/bot-config-v2.js` lists
 *    `rebalanceRangeWidthPct` and `fullRangeRebalanceEnabled`.
 *  - `bot-cycle-opts.js` reads both via `deps._getConfig` so every
 *    rebalance (manual OR automatic) honors them — but only when the
 *    section's "No Override" toggle resolves to "apply the settings"
 *    (`src/lib/range-override.js`).
 */

"use strict";

import { g, isFullRangeSpread } from "./dashboard-helpers.js";
import { isInputDirty } from "./dashboard-data-cache.js";
import { posStore } from "./dashboard-positions-store.js";

/*- Last posKey (tokenId) we ran syncRangeWidth for.  Comparing to the
 *  current posStore.getActive()?.tokenId lets us detect a position
 *  switch and force-refresh the input (clearing whatever the prior
 *  position's value was so a stale display can't linger).  Module-
 *  local so it survives across polls but is reset on page reload. */
let _lastKnownPosKey = null;

/*- The same idea for the Full-Range checkbox, tracked separately
 *  because `syncRangeWidth` runs first each poll and would otherwise
 *  advance the shared key before the checkbox sync ever saw the
 *  switch. */
let _lastFullRangePosKey = null;

/**
 * Compute whether an activePosition + posStore-active pair is
 * on-chain full-range.  Pure decision extracted from
 * `_isActivePositionFullRange` so tests can drive it without setting
 * up posStore state.
 * @param {{tickLower?:number, tickUpper?:number}|null|undefined} activeFromPayload
 * @param {{tickLower?:number, tickUpper?:number}|null|undefined} activeFromStore
 * @returns {boolean}
 */
export function isActivePositionFullRange(activeFromPayload, activeFromStore) {
  const tL = activeFromPayload?.tickLower ?? activeFromStore?.tickLower;
  const tU = activeFromPayload?.tickUpper ?? activeFromStore?.tickUpper;
  if (tL === undefined || tL === null || tU === undefined || tU === null)
    return false;
  if (!Number.isFinite(tL) || !Number.isFinite(tU)) return false;
  return isFullRangeSpread(tU - tL);
}

/**
 * Pure decision for `syncRangeWidth`.  Given the payload and the
 * relevant DOM/state fragments, returns what the sync path should do:
 *   - `shouldWrite`: whether to write to the input.
 *   - `newValue`: the value to write (only meaningful when `shouldWrite`).
 *   - `newLastKnownPosKey`: the value to update the module cache to
 *     (present only when the decision advances past the guard checks).
 *
 * Extracted so tests can drive the decision without a live posStore or
 * dirty-flag cache.
 *
 * @param {object} data  Flattened poll payload.
 * @param {{posKey:string|null|undefined, lastKnownPosKey:string|null,
 *          currentValue:string, isDirty:boolean}} ctx
 * @returns {{shouldWrite:boolean, newValue?:string, newLastKnownPosKey?:string}}
 */
export function computeRangeWidthDecision(data, ctx) {
  if (ctx.isDirty) return { shouldWrite: false };
  if (!ctx.posKey) return { shouldWrite: false };
  const isNewPosition = ctx.lastKnownPosKey !== ctx.posKey;
  const saved = data.rebalanceRangeWidthPct;
  if (saved !== undefined && saved !== null && Number.isFinite(saved)) {
    if (isNewPosition || ctx.currentValue === "") {
      return {
        shouldWrite: true,
        newValue: saved.toFixed(2),
        newLastKnownPosKey: ctx.posKey,
      };
    }
    return { shouldWrite: false, newLastKnownPosKey: ctx.posKey };
  }
  if (isNewPosition) {
    return {
      shouldWrite: true,
      newValue: "",
      newLastKnownPosKey: ctx.posKey,
    };
  }
  return { shouldWrite: false, newLastKnownPosKey: ctx.posKey };
}

/**
 * Pure decision for `syncFullRangeCheckbox`.  Given the payload and
 * the current active-position info, returns whether the checkbox
 * should end up checked.  Extracted so tests can drive the decision
 * without a live posStore.
 * @param {object} data  Flattened poll payload.
 * @param {{tickLower?:number, tickUpper?:number}|null|undefined} activeFromStore
 * @returns {boolean}
 */
export function computeFullRangeChecked(data, activeFromStore) {
  const saved = data.fullRangeRebalanceEnabled;
  if (typeof saved === "boolean") return saved;
  return isActivePositionFullRange(data.activePosition, activeFromStore);
}

/**
 * Populate the "Price Range Extension" input from
 * `data.rebalanceRangeWidthPct` on every poll.
 *   (a) Saved override present → display verbatim (on position switch OR
 *       when input is empty; otherwise skip so mid-typing isn't clobbered).
 *   (b) No override → LEAVE INPUT EMPTY.  No fallback computation.
 *
 * @param {object} data  Flattened poll payload (from `flattenV2Status`).
 */
export function syncRangeWidth(data) {
  const el = g("inRangeWidth");
  if (!el) return;
  const decision = computeRangeWidthDecision(data, {
    posKey: posStore.getActive()?.tokenId,
    lastKnownPosKey: _lastKnownPosKey,
    currentValue: el.value,
    isDirty: isInputDirty("inRangeWidth"),
  });
  if (decision.shouldWrite) el.value = decision.newValue;
  if (decision.newLastKnownPosKey !== undefined) {
    _lastKnownPosKey = decision.newLastKnownPosKey;
  }
}

/**
 * Pure decision for `syncFullRangeCheckbox`: should this poll write the
 * checkbox, and to what?
 *
 * The checkbox no longer saves on its own `change` event — only the
 * row's Save button writes config — so a ticked-but-unsaved box has to
 * survive until the user commits or leaves.  A blanket per-poll write
 * would silently untick it within 3 seconds, which reads as the click
 * not registering.  Hence: write only when the position changed.
 *
 * That mirrors `computeRangeWidthDecision`, which likewise only writes
 * the width input on a position switch or when it is empty.  The saved
 * value cannot change behind the dashboard's back anyway — this tab is
 * the only thing that writes it.
 *
 * The dirty gate covers the same poll the user clicked in, before
 * `_lastFullRangePosKey` has caught up.
 *
 * @param {object} data  Flattened poll payload.
 * @param {{posKey:string|null|undefined, lastKnownPosKey:string|null,
 *          isDirty:boolean, activeFromStore:object|null|undefined}} ctx
 * @returns {{shouldWrite:boolean, newValue?:boolean, newLastKnownPosKey?:string}}
 */
export function computeFullRangeDecision(data, ctx) {
  if (ctx.isDirty) return { shouldWrite: false };
  if (!ctx.posKey) return { shouldWrite: false };
  if (ctx.lastKnownPosKey === ctx.posKey)
    return { shouldWrite: false, newLastKnownPosKey: ctx.posKey };
  return {
    shouldWrite: true,
    newValue: computeFullRangeChecked(data, ctx.activeFromStore),
    newLastKnownPosKey: ctx.posKey,
  };
}

/**
 * Populate the "Full-Range" checkbox from `data.fullRangeRebalanceEnabled`
 * on position switch.  When the config flag is unset (null/undefined),
 * fall back to reflecting on-chain reality: checked iff the current
 * position itself is full-range.
 *
 * Does NOT touch the input's `disabled` attribute: `syncRangeOverride`
 * runs immediately after this in `syncBotSettingsConfigInputs` and
 * routes every Range-section `disabled` write through
 * `applyRangeFieldState`, which accounts for both this checkbox and the
 * section's "No Override" toggle.
 *
 * @param {object} data  Flattened poll payload (from `flattenV2Status`).
 */
export function syncFullRangeCheckbox(data) {
  const chk = g("chkFullRange");
  if (!chk) return;
  const decision = computeFullRangeDecision(data, {
    posKey: posStore.getActive()?.tokenId,
    lastKnownPosKey: _lastFullRangePosKey,
    isDirty: isInputDirty("chkFullRange"),
    activeFromStore: posStore.getActive(),
  });
  if (decision.shouldWrite) chk.checked = decision.newValue;
  if (decision.newLastKnownPosKey !== undefined) {
    _lastFullRangePosKey = decision.newLastKnownPosKey;
  }
}
