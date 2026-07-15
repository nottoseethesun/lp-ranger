/**
 * @file dashboard-data-range-width.js
 * @description Populate the Bot Settings "Range Width" input from
 * server data on every poll.  Split out of `dashboard-data.js` to keep
 * that file under the 500-line cap.
 *
 * Consumers: `_syncManagedAndGlobals` in `dashboard-data.js` calls
 * `syncRangeWidth(data)` once per poll (next to `_syncOorThreshold`).
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

import { g } from "./dashboard-helpers.js";
import { isInputDirty } from "./dashboard-data-cache.js";

/**
 * Populate the "Range Width" input from `data.rebalanceRangeWidthPct`
 * on every poll.  Precedence:
 *   (a) `data.rebalanceRangeWidthPct` (persistent saved override) →
 *       display verbatim.
 *   (b) No override saved → compute the `preserveRange()` equivalent
 *       from active-position ticks + current pool price and display
 *       that.  Same formula the rebalancer logs at
 *       `src/rebalancer.js:294-298`, so the number in the input
 *       matches what a subsequent no-override rebalance will actually
 *       apply.
 *   (c) Insufficient inputs (no ticks / no price) → leave the input
 *       alone (previous value or empty).
 *
 * Skipped when the input is dirty so mid-edit typing isn't clobbered.
 * All presence checks use explicit `!== undefined && !== null` per
 * CLAUDE-BEST-PRACTICES §"Type Checks".
 *
 * @param {object} data  Flattened poll payload (from `flattenV2Status`).
 */
export function syncRangeWidth(data) {
  const el = g("inRangeWidth");
  if (!el) return;
  if (isInputDirty("inRangeWidth")) return;
  const saved = data.rebalanceRangeWidthPct;
  if (saved !== undefined && saved !== null && Number.isFinite(saved)) {
    el.value = String(saved);
    return;
  }
  const ap = data.activePosition;
  const tL = ap?.tickLower;
  const tU = ap?.tickUpper;
  const p = data.poolState?.price;
  if (
    tL === undefined ||
    tL === null ||
    tU === undefined ||
    tU === null ||
    typeof p !== "number" ||
    !(p > 0)
  )
    return;
  const lowerP = Math.pow(1.0001, tL);
  const upperP = Math.pow(1.0001, tU);
  const widthPct = ((upperP - lowerP) / p) * 100;
  if (Number.isFinite(widthPct) && widthPct > 0) el.value = widthPct.toFixed(2);
}
