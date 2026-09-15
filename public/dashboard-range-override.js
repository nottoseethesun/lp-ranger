/**
 * @file dashboard-range-override.js
 * @description The "No Override" toggle that heads Bot Settings → Range,
 * plus the status badge beside it and the enable/disable state of every
 * field the toggle governs.
 *
 * Two modes, one per-position config key (`rangeOverrideEnabled`):
 *
 *   - toggle ON  → badge "Re-Use Existing Position Range".  Price Range
 *     Extension, Full-Range and Position Offset are all disabled, and
 *     the next rebalance re-uses the position's existing on-chain range
 *     re-centred on the current price.
 *   - toggle OFF → badge "Use Settings Below".  Those fields are live
 *     and the next rebalance applies them.
 *
 * The toggle is non-destructive.  Flipping it ON leaves every saved
 * Range value on disk — the fields grey out rather than emptying — so
 * flipping it back OFF restores the user's settings intact.  Clearing
 * the keys instead would make the toggle a one-way action: the user
 * could turn it on but not undo it.
 *
 * The server resolves the mode (`src/range-override.js`) and publishes
 * the answer in `GET /api/status`, so this module never re-derives the
 * unset-slot rule; it renders what the payload says and writes the
 * user's choice back.
 *
 * Exports:
 *  - `computeRangeOverrideUi` — pure decision: payload → what to render.
 *  - `applyRangeFieldState` — sole owner of the `disabled` flag on every
 *    control in the Range section.
 *  - `isRangeOverrideActive` — the mode as of the last poll, for callers
 *    that must not read it back off the DOM.
 *  - `syncRangeOverride` — per-poll render.
 *  - `saveRangeOverrideToggle` — change handler on the toggle.
 *  - `wireRangeOverrideEvents` — one-shot wire-up from
 *    `dashboard-events.js:bindAllEvents`.
 */

"use strict";

import {
  g,
  act,
  ACT_ICONS,
  compositeKey,
  fetchWithCsrf,
} from "./dashboard-helpers.js";
import { posStore } from "./dashboard-positions-store.js";
import { _posLabel } from "./dashboard-data.js";

/*- Badge copy.  Deliberately short: the badge sits on the left of the
 *  section's header line and the long-form explanation of both modes
 *  lives in the circle-i param-help dialog (`rangeOverrideToggle` in
 *  public/param-help-content.js). */
const _BADGE_REUSE = "Re-Use Existing Position Range";
const _BADGE_SETTINGS = "Use Settings Below";

/*- Every control the toggle governs.  `inRangeWidth` is listed here for
 *  the override gate; the Full-Range checkbox disables it a second way
 *  (see `applyRangeFieldState`). */
const _GATED_IDS = [
  "inRangeWidth",
  "chkFullRange",
  "defaultRangeWidthBtn",
  "saveRangeWidthBtn",
  "inOffsetToken0",
  "inOffsetToken1",
  "resetOffsetBtn",
  "saveOffsetBtn",
];

/*- The mode as of the last poll (or the last toggle click).  Module-
 *  local so that `onFullRangeToggle` can ask for it instead of reading
 *  `disabled` back off an input — see [[feedback-no-classlist-for-state]]
 *  and the identical `_lastSyncComplete` pattern in dashboard-data.js.
 *  null until the first poll lands. */
let _overrideActive = null;

/**
 * Pure decision for `syncRangeOverride`: given a poll payload, what
 * should the Range header line render?  The server publishes an already-
 * resolved boolean, so anything else (missing key, wallet locked, first
 * paint before any poll) means "No Override" — the shipped default for a
 * position nobody has configured.
 *
 * @param {object} data  Flattened poll payload (from `flattenV2Status`).
 * @returns {{overrideActive:boolean, badgeText:string, toggleChecked:boolean}}
 */
export function computeRangeOverrideUi(data) {
  const overrideActive = data?.rangeOverrideEnabled === true;
  return {
    overrideActive,
    badgeText: overrideActive ? _BADGE_SETTINGS : _BADGE_REUSE,
    /*- The checkbox is labelled "No Override", so it reads inverted
     *  against the config key it writes. */
    toggleChecked: !overrideActive,
  };
}

/**
 * The Range-override mode as of the last render, or `null` before the
 * first poll.  Use this anywhere you would otherwise be tempted to read
 * an input's `disabled` property back to recover the mode.
 * @returns {boolean|null}
 */
export function isRangeOverrideActive() {
  return _overrideActive;
}

/**
 * Sole owner of `disabled` across the Range section.  Two independent
 * reasons a control can be off:
 *   1. the "No Override" toggle is ON — nothing in the section applies;
 *   2. Full-Range is checked — the rebalancer ignores the Price Range
 *      Extension value, so only that one input greys out.
 *
 * @param {boolean} overrideActive   Whether the saved Range settings apply.
 * @param {boolean} fullRangeChecked Whether the Full-Range box is checked.
 */
export function applyRangeFieldState(overrideActive, fullRangeChecked) {
  for (const id of _GATED_IDS) {
    const el = g(id);
    if (el) el.disabled = !overrideActive;
  }
  const width = g("inRangeWidth");
  if (width && overrideActive) width.disabled = fullRangeChecked === true;
}

/**
 * Render the Range header line from a poll payload: badge text, badge
 * mode class, toggle position, and the disabled state of every field the
 * toggle governs.
 *
 * @param {object} data  Flattened poll payload (from `flattenV2Status`).
 */
export function syncRangeOverride(data) {
  const decision = computeRangeOverrideUi(data);
  _overrideActive = decision.overrideActive;
  _renderHeader(decision);
  applyRangeFieldState(
    decision.overrideActive,
    g("chkFullRange")?.checked === true,
  );
}

/*- Paint the badge and the toggle from a decision object.  Shared by the
 *  per-poll sync and the click handler so a click updates instantly
 *  instead of waiting up to 3 s for the next poll. */
function _renderHeader(decision) {
  const badge = g("rangeModeBadge");
  if (badge) {
    badge.textContent = decision.badgeText;
    badge.classList.toggle(
      "9mm-pos-mgr-range-mode-reuse",
      !decision.overrideActive,
    );
    /*- Ships hidden so the first paint can't flash a mode the server
     *  hasn't confirmed; reveal once we have a real answer. */
    badge.hidden = false;
  }
  const chk = g("rangeOverrideToggle");
  if (chk) chk.checked = decision.toggleChecked;
}

/**
 * Change handler on the "No Override" toggle.  Persists the new mode as
 * the per-position `rangeOverrideEnabled` key and repaints immediately.
 * Writes nothing else: the Price Range Extension, Full-Range and
 * Position Offset values stay exactly as saved so flipping back restores
 * them.
 */
export function saveRangeOverrideToggle() {
  const chk = g("rangeOverrideToggle");
  if (!chk) return;
  /*- Checkbox is "No Override": checked means the overrides are OFF. */
  const overrideActive = !chk.checked;
  _overrideActive = overrideActive;
  _renderHeader(
    computeRangeOverrideUi({ rangeOverrideEnabled: overrideActive }),
  );
  applyRangeFieldState(overrideActive, g("chkFullRange")?.checked === true);
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
    body: JSON.stringify({ rangeOverrideEnabled: overrideActive, positionKey }),
  }).catch(() => {});
  const pl = _posLabel();
  act(
    ACT_ICONS.gear,
    "start",
    "Setting Saved",
    (overrideActive
      ? "Range settings will be applied on the next rebalance"
      : "No Override — the existing position range will be re-used") +
      (pl ? "\n" + pl : ""),
  );
}

/**
 * Wire the toggle's change event.  Called once from
 * `dashboard-events.js:bindAllEvents`.  Takes the helper as a parameter
 * to avoid a circular import back through dashboard-events.js.
 * @param {(id:string,fn:Function)=>void} onChange
 */
export function wireRangeOverrideEvents(onChange) {
  onChange("rangeOverrideToggle", saveRangeOverrideToggle);
}
