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
 *          when full-range is on).
 *
 *   3. **Position switch** (posKey changes): force a fresh sync of both
 *      the input and the checkbox from the new position's data.  Clears
 *      any lingering value from the prior position.
 *
 * Related:
 *  - `saveRangeWidth` / `resetRangeWidth` / `saveFullRangeToggle` in
 *    `dashboard-throttle.js` write via POST /api/config.
 *  - `POSITION_KEYS` in `src/bot-config-v2.js` lists
 *    `rebalanceRangeWidthPct` and `fullRangeRebalanceEnabled`.
 *  - `bot-cycle-opts.js` reads both via `deps._getConfig` so every
 *    rebalance (manual OR automatic) honors them.
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
 * Populate the "Full-Range" checkbox from `data.fullRangeRebalanceEnabled`
 * on every poll.  When the config flag is unset (null/undefined), fall
 * back to reflecting on-chain reality: checked iff the current position
 * itself is full-range.  Always keeps the Price Range Extension input's
 * `disabled` attribute in sync with the checkbox's checked state — a
 * checked box means the input value is going to be ignored by the
 * rebalancer, so it visually communicates that by greying out.
 *
 * @param {object} data  Flattened poll payload (from `flattenV2Status`).
 */
export function syncFullRangeCheckbox(data) {
  const chk = g("chkFullRange");
  if (!chk) return;
  const input = g("inRangeWidth");
  const checked = computeFullRangeChecked(data, posStore.getActive());
  chk.checked = checked;
  if (input) input.disabled = checked;
}
