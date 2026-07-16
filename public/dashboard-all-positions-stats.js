/**
 * @file dashboard-all-positions-stats.js
 * @description "All Positions Stats" header button + modal (modal
 *   itself lands in task 3-C — this file currently ships the button
 *   readiness gate and a click-handler stub).
 *
 *   Distinct gating from every other button in the header: this
 *   button only enables when EVERY currently-running managed
 *   position has finished BOTH its rebalance-history scan AND its
 *   lifetime-deposit scan AND has produced a populated pnlSnapshot.
 *   The rest of the dashboard gates on just the actively-viewed
 *   position; the All Positions Stats modal would show a partial
 *   ranking if we let it open while some positions were still
 *   syncing, so we hold it back until the whole managed set is ready.
 *
 *   Tooltip states (via the button's `title` attribute):
 *     - No managed positions             → "No managed positions — click Manage on a position to add one."
 *     - Some positions still loading     → "Waiting for X of Y managed positions to finish loading (rebalance history + lifetime deposit scans)."
 *     - All ready                        → "View ranked stats across all open managed positions."
 *
 *   The button uses the .9mm-pos-mgr-disabled-hoverable CSS modifier
 *   so hover events (and the title tooltip) keep firing while the
 *   button is disabled.
 */

import { log } from "./dashboard-log.js";
import { g } from "./dashboard-helpers.js";

/*- Track last-applied {disabled, title} so we don't touch the DOM on
 *  every 3-second poll when nothing has changed.  Prevents needless
 *  reflow + prevents the browser from re-arming the tooltip timer. */
let _lastState = { disabled: null, title: null };

/**
 * Compute readiness across every RUNNING managed position and update
 * the "All Positions Stats" header button's disabled state + title.
 * Called after each successful /api/status poll.
 * @param {object} data  Flattened poll payload (from flattenV2Status).
 */
export function updateAllPositionsStatsBtn(data) {
  const btn = g("allPositionsStatsBtn");
  if (!btn) return;
  const positions = data?._allPositionStates || {};
  let total = 0;
  let ready = 0;
  for (const key of Object.keys(positions)) {
    const p = positions[key];
    if (!p || p.status !== "running") continue;
    total += 1;
    if (
      p.rebalanceScanComplete === true &&
      p.lifetimeScanComplete === true &&
      p.pnlSnapshot
    )
      ready += 1;
  }
  let disabled;
  let title;
  if (total === 0) {
    disabled = true;
    title = "No managed positions — click Manage on a position to add one.";
  } else if (ready < total) {
    disabled = true;
    const missing = total - ready;
    const plural = total === 1 ? "" : "s";
    title = `Waiting for ${missing} of ${total} managed position${plural} to finish loading (rebalance history + lifetime deposit scans).`;
  } else {
    disabled = false;
    title = "View ranked stats across all open managed positions.";
  }
  if (_lastState.disabled === disabled && _lastState.title === title) return;
  _lastState = { disabled, title };
  btn.disabled = disabled;
  btn.title = title;
}

/**
 * Click handler stub — the modal itself is built in task 3-C.  Logs
 * the click so button-wiring can be verified in isolation while the
 * modal is under construction.
 */
export function openAllPositionsStatsModal() {
  log.info("[all-positions-stats] modal open (stub — modal impl in task 3-C)");
}
