/**
 * @file dashboard-data-range-width.js
 * @description Populate the Bot Settings "Range Width" input from
 * server data.  Split out of `dashboard-data.js` to keep that file
 * under the 500-line cap.
 *
 * Cadence: per-poll (called from `_syncManagedAndGlobals` in
 * `dashboard-data.js`, next to `_syncOorThreshold`).  A one-shot-per-
 * position-switch cadence — the naive approach — misses the
 * late-arriving `poolState` on the "bring under management" flow: the
 * first post-Manage poll has `activePosition` but no `poolState` yet
 * (bot cycle hasn't run getPoolState), so the fallback computation
 * returns early and never retries.  Per-poll with an internal
 * `_lastKnownPosKey` gate handles all the end-to-end flows:
 *   (a) Manage on open position: retries until poolState arrives,
 *       populates once, then skips subsequent polls (empty-input
 *       gate) — no drift as pool price moves.
 *   (b) unmanage → browse elsewhere → browse back → Manage:
 *       browsing changes posKey → forced re-populate (clears the
 *       stale value from the prior position, then fills for the
 *       current position when data is available).
 *   (c),(d) closed-position reopen: after the rebalance mints a new
 *       tokenId, `syncActivePosition` migrates posStore → posKey
 *       change → forced re-populate for the new mint.
 *   (e) no LP positions on wallet: `posStore.getActive()` returns
 *       null → early return, input stays empty.
 *   (f) app starts on a closed position: no `poolState` yet (bot
 *       loop retired for the closed NFT); saved value if any is
 *       written, else input stays empty until the user clicks Manage
 *       (recovery flow), which starts a bot loop, mints a new NFT,
 *       and populates via the (c)/(d) path.
 *
 * Mid-typing protection: user typing over a saved-override value is
 * gated by `isInputDirty` — the input event listener wired in
 * `dashboard-events.js` marks dirty on every keystroke; dirty is
 * cleared at end of poll (`clearDirtyInputs`).  Essential for the
 * case where a saved value already exists and the user is editing.
 *
 * Related:
 *  - `saveRangeWidth` / `resetRangeWidth` in `dashboard-throttle.js`
 *    write the value via POST /api/config.
 *  - `POSITION_KEYS` in `src/bot-config-v2.js` lists
 *    `rebalanceRangeWidthPct` so it's persisted per-position.
 *  - `bot-cycle-opts.js` reads the value via `deps._getConfig` so
 *    every rebalance (manual OR automatic) uses the saved override.
 */

"use strict";

import { g, isFullRangeSpread } from "./dashboard-helpers.js";
import { isInputDirty } from "./dashboard-data-cache.js";
import { posStore } from "./dashboard-positions-store.js";

/*- Last posKey (tokenId) we ran syncRangeWidth for.  Comparing to
 *  the current posStore.getActive()?.tokenId lets us detect a
 *  position switch and force-refresh the input (clearing whatever
 *  the prior position's value was so a stale display can't linger).
 *  Module-local so it survives across polls but is reset on page
 *  reload. */
let _lastKnownPosKey = null;

/** Compute the "preserveRange width" as a percentage — the width the
 *  rebalancer would produce for a position with the given tick spread
 *  and Position Offset.  Matches `src/range-math.js:preserveRange()`
 *  + `src/rebalancer.js:294-298`:
 *      belowTicks = spread * (100 - offset) / 100
 *      aboveTicks = spread * offset / 100
 *      widthPct   = (1.0001^aboveTicks - 1.0001^(-belowTicks)) * 100
 *  For offset=50 (centered) this simplifies to the symmetric form;
 *  for other offsets the exponents differ (asymmetric range).
 *  INDEPENDENT of `currentPrice` / `currentTick` — pure function of
 *  (spread, offset).  Returns a two-decimal string or null when
 *  inputs are missing / non-finite / produce a non-positive width. */
function _computeWidthWithOffset(spread, offset) {
  if (!Number.isFinite(spread) || !(spread > 0)) return null;
  if (!Number.isFinite(offset) || offset < 0 || offset > 100) return null;
  /*- Full-range positions produce astronomical widthPct values
   *  (Math.pow(1.0001, ~887200) ≈ 3.4e38 → widthPct ≈ 6.65e32) that
   *  render as truncated scientific notation in the input.  Full-range
   *  positions never go out of range so the value is purely cosmetic;
   *  show 100 as the convention. */
  if (isFullRangeSpread(spread)) return "100.00";
  const aboveTicks = (spread * offset) / 100;
  const belowTicks = (spread * (100 - offset)) / 100;
  const widthPct =
    (Math.pow(1.0001, aboveTicks) - Math.pow(1.0001, -belowTicks)) * 100;
  if (!Number.isFinite(widthPct) || !(widthPct > 0)) return null;
  return widthPct.toFixed(2);
}

/** Resolve the Position Offset (%) to use for the range-width
 *  computation.  Precedence:
 *   (a) `data.offsetToken0Pct` — server payload (saved value if the
 *       user has configured it, OR shipped default flowed through).
 *   (b) `#inOffsetToken0` input value — the AJAX-populated shipped
 *       default that hasn't reached us via `data` yet (edge case on
 *       cold load).
 *   (c) `50` — the centered fallback used by both `preserveRange()`
 *       (via `_DEFAULTS`) and every offset-aware path in the bot.
 *  Never returns undefined — always a number in `[0, 100]`. */
function _resolveOffsetPct(data) {
  const fromData = data?.offsetToken0Pct;
  if (
    fromData !== undefined &&
    fromData !== null &&
    Number.isFinite(fromData) &&
    fromData >= 0 &&
    fromData <= 100
  )
    return fromData;
  const raw = g("inOffsetToken0")?.value;
  const fromInput = raw !== undefined && raw !== "" ? parseFloat(raw) : NaN;
  if (Number.isFinite(fromInput) && fromInput >= 0 && fromInput <= 100)
    return fromInput;
  return 50;
}

/** Resolve the tick spread from data / posStore.  Prefers
 *  `data.activePosition` (managed positions) then falls back to
 *  `posStore` (unmanaged/closed positions).  Returns a positive
 *  spread or null. */
function _resolveSpread(data) {
  const ap = data.activePosition;
  const active = posStore.getActive();
  const tL = ap?.tickLower ?? active?.tickLower;
  const tU = ap?.tickUpper ?? active?.tickUpper;
  if (tL === undefined || tL === null || tU === undefined || tU === null)
    return null;
  if (!Number.isFinite(tL) || !Number.isFinite(tU)) return null;
  const spread = tU - tL;
  if (!Number.isFinite(spread) || !(spread > 0)) return null;
  return spread;
}

/** Compute the "preserveRange width" from the current position's
 *  tick spread + resolved Position Offset.  This lets us populate
 *  the field for every scanned position (managed, unmanaged, or
 *  closed) — no `poolState` dependency, no ever-empty/unset state
 *  per the user's mandate.  Returns a two-decimal string or null. */
function _computeFallbackWidthPct(data) {
  const spread = _resolveSpread(data);
  if (spread === null) return null;
  return _computeWidthWithOffset(spread, _resolveOffsetPct(data));
}

/** Handle the "saved override present" branch: write to input on
 *  position switch OR when input is empty; skip otherwise (respect
 *  mid-typing).  Always marks the posKey as known. */
function _applySavedOverride(el, saved, isNewPosition, posKey) {
  if (isNewPosition || el.value === "") el.value = String(saved);
  _lastKnownPosKey = posKey;
}

/**
 * Populate the "Range Width" input from `data.rebalanceRangeWidthPct`
 * on every poll.  Precedence:
 *   (a) `data.rebalanceRangeWidthPct` (persistent saved override) →
 *       display verbatim (on position switch OR when input is empty;
 *       otherwise skip so mid-typing isn't clobbered).
 *   (b) No override saved → compute the `preserveRange()` equivalent
 *       from active-position ticks + current pool price and display
 *       that (only if position switched OR input is empty).  Same
 *       formula the rebalancer logs at `src/rebalancer.js:294-298`,
 *       so the number in the input matches what a subsequent
 *       no-override rebalance will actually apply.
 *   (c) Insufficient inputs (no ticks / no price / non-finite) →
 *       on position switch: clear the input (so no stale value from
 *       the prior position lingers); otherwise leave alone.  Do NOT
 *       update `_lastKnownPosKey` — retry next poll when data arrives.
 *
 * Explicit `!== undefined && !== null` checks per CLAUDE-BEST-PRACTICES
 * §"Type Checks"; `Number.isFinite` also rejects `Infinity` / `NaN`.
 *
 * @param {object} data  Flattened poll payload (from `flattenV2Status`).
 */
export function syncRangeWidth(data) {
  const el = g("inRangeWidth");
  if (!el) return;
  if (isInputDirty("inRangeWidth")) return;
  const posKey = posStore.getActive()?.tokenId;
  if (!posKey) return;
  const isNewPosition = _lastKnownPosKey !== posKey;
  const saved = data.rebalanceRangeWidthPct;
  if (saved !== undefined && saved !== null && Number.isFinite(saved)) {
    _applySavedOverride(el, saved, isNewPosition, posKey);
    return;
  }
  /*- No saved override.  On a fresh position switch, clear the input
   *  so we don't show a stale value from the prior position while we
   *  wait for fallback data.  On the same position with a non-empty
   *  input, respect it (prior populate OR user typing). */
  if (isNewPosition) el.value = "";
  else if (el.value !== "") return;
  const widthPct = _computeFallbackWidthPct(data);
  /*- Fallback data not available yet — do NOT set `_lastKnownPosKey`
   *  so the next poll retries.  On flow (a) "Manage on unmanaged
   *  position", poolState arrives only after the bot's first
   *  pollCycle completes, one bot-poll interval after the manage
   *  response returns. */
  if (widthPct === null) return;
  el.value = widthPct;
  _lastKnownPosKey = posKey;
}

/**
 * Populate the "Range Width" input **synchronously** from the active
 * position's on-chain tick spread.  Called from the Manage-click
 * paths (both the open-position path in
 * `dashboard-events-manage.js` and the closed-position re-open
 * intro-modal path in `dashboard-reopen-flow.js`) so the field is
 * filled with the on-chain value the instant the user commits to
 * bringing the position under management — no waiting on the
 * 3-second poll, no ever-empty state.
 *
 * Guards:
 *  - Dirty input (user is typing) → skip.
 *  - Non-empty input (already populated or saved value present) →
 *    skip; the existing value is authoritative (user's Save-in-progress
 *    or prior populate).
 *  - No active position, or missing/non-finite ticks → skip.  In that
 *    case `syncRangeWidth` on the next poll will retry via its
 *    normal cadence.
 *
 * Sets `_lastKnownPosKey` on success so `syncRangeWidth` on the next
 * poll won't force-repopulate (the input already has the right
 * value).
 */
export function populateRangeWidthFromActive() {
  const el = g("inRangeWidth");
  if (!el) return;
  if (isInputDirty("inRangeWidth")) return;
  if (el.value !== "") return;
  const active = posStore.getActive();
  if (!active) return;
  const tL = active.tickLower;
  const tU = active.tickUpper;
  if (tL === undefined || tL === null || tU === undefined || tU === null)
    return;
  if (!Number.isFinite(tL) || !Number.isFinite(tU)) return;
  const spread = tU - tL;
  if (!Number.isFinite(spread) || !(spread > 0)) return;
  /*- Click-time populate — read offset from the input (which by this
   *  point is either the saved value or the AJAX-populated shipped
   *  default).  Falls back to 50 if the input is empty. */
  const widthPct = _computeWidthWithOffset(spread, _resolveOffsetPct({}));
  if (widthPct === null) return;
  el.value = widthPct;
  _lastKnownPosKey = active.tokenId;
}
