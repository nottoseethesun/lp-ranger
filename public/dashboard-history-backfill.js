/**
 * @file dashboard-history-backfill.js
 * @description One-shot cold-load backfill of historical events into the
 *   Activity Log.  Two entrypoints, one per event type, both share the
 *   same shape: fire once per position-view, sorted ascending, gated on
 *   the server-side scan-complete flag when the position is running.
 *
 *   `populateRebalanceHistoryOnce`  — iterates `data.rebalanceEvents[]`.
 *   `populateCompoundHistoryOnce`   — iterates `data.compoundHistory[]`.
 *
 *   Position switch / wallet switch / hard-reset flows call
 *   `resetHistoryBackfillFlags()` (wired via `resetHistoryFlag()` in
 *   `dashboard-data.js`) so each newly-viewed position gets one fresh
 *   backfill on its own cold load.
 *
 *   Extracted from `dashboard-data.js` for line-count compliance.
 */

import { act, ACT_ICONS } from "./dashboard-helpers.js";
import { formatCompoundHistoryEntry } from "./dashboard-compound-log.js";

let _rebalanceHistoryPopulated = false;
let _compoundHistoryPopulated = false;

/** Reset both latches — called on position-switch and wallet-switch. */
export function resetHistoryBackfillFlags() {
  _rebalanceHistoryPopulated = false;
  _compoundHistoryPopulated = false;
}

/**
 * Backfill historical rebalance rows into the Activity Log.
 * One-shot per viewed position (latch = `_rebalanceHistoryPopulated`).
 *
 * @param {object} data      Flattened `/api/status` response for the
 *                           active position.
 * @param {string} [posLabel] Position-context label (from
 *                           `_posLabel()`).  Appended as a "\n"-prefixed
 *                           suffix in each Activity Log row.
 */
export function populateRebalanceHistoryOnce(data, posLabel) {
  if (_rebalanceHistoryPopulated || !data.rebalanceEvents?.length) return;
  if (data.running && data.rebalanceScanComplete !== true) return;
  _rebalanceHistoryPopulated = true;
  const ctx = posLabel ? "\n" + posLabel : "";
  const _s = [...data.rebalanceEvents].sort(
    (a, b) => a.timestamp - b.timestamp,
  );
  for (const ev of _s) {
    act(
      ACT_ICONS.lasso,
      "fee",
      "Rebalance",
      "NFT #" + ev.oldTokenId + " → #" + ev.newTokenId + ctx,
      ev.dateStr ? new Date(ev.dateStr) : new Date(ev.timestamp * 1000),
      ev.txHash,
    );
  }
}

/**
 * Backfill historical compound rows into the Activity Log.
 * One-shot per viewed position (latch = `_compoundHistoryPopulated`).
 * Mirrors `populateRebalanceHistoryOnce` line-for-line.
 *
 * @param {object} data              Flattened `/api/status` response.
 * @param {string} [posLabel]        Position-context label.
 * @param {string|number} [fallbackTokenId]  Used when an event lacks its
 *                                   own `tokenId`.
 */
export function populateCompoundHistoryOnce(data, posLabel, fallbackTokenId) {
  if (_compoundHistoryPopulated || !data.compoundHistory?.length) return;
  if (data.running && data.lifetimeScanComplete !== true) return;
  _compoundHistoryPopulated = true;
  const ctx = posLabel ? "\n" + posLabel : "";
  const _s = [...data.compoundHistory].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
  for (const ev of _s) {
    const entry = formatCompoundHistoryEntry(ev, ctx, fallbackTokenId);
    if (!entry) continue;
    act(
      ACT_ICONS.acorn,
      entry.type,
      entry.title,
      entry.detail,
      entry.when,
      entry.txHash,
    );
  }
}
