/**
 * @file dashboard-rebalance-log.js
 * @description How a Rebalance entry in the Activity Log reads, from the
 * rebalance's event record. Pure (no DOM), so both paths that draw a
 * Rebalance entry share it: the live check, when a position's
 * `lastRebalanceAt` advances (`dashboard-data-events.js`), and the
 * history pass (`dashboard-populate-history.js`), which the log also runs
 * to draw a position's entries again once a scan of it has finished.
 *
 * An entry reads "NFT #old → #new", with what started the rebalance when
 * its record says: (Out of Range), (Manual) or (Residual Cleanup). The
 * bot records it with each rebalance it makes, in its own event list and
 * in the pool's event cache, and a rebuild from the chain takes it back
 * from this install's rebalance log. A rebalance found only on the chain
 * has none, since the chain does not say what started it.
 */

/** What started a rebalance, by its record's `trigger`, as its entry names it. */
const TRIGGER_LABELS = new Map([
  ["out-of-range", "Out of Range"],
  ["manual", "Manual"],
  ["residual-cleanup", "Residual Cleanup"],
]);

/**
 * A Rebalance entry's time and detail.
 *
 * The time is the rebalance's own, from the chain, so the Activity Log
 * agrees with the Rebalance Events table; an event with none is drawn at
 * the moment it is drawn.
 *
 * @param {object} ev  The rebalance's event record: `oldTokenId`,
 *   `newTokenId`, `dateStr` or `timestamp` (Unix seconds), and `trigger`
 *   when the bot recorded it.
 * @param {string} [ctx]  The position-context suffix, "\n"-prefixed.
 * @returns {{when: Date|undefined, detail: string}}
 */
export function formatRebalanceEntry(ev, ctx) {
  const when = ev.dateStr
    ? new Date(ev.dateStr)
    : ev.timestamp
      ? new Date(ev.timestamp * 1000)
      : undefined;
  const label = TRIGGER_LABELS.get(ev.trigger);
  const detail =
    "NFT #" +
    ev.oldTokenId +
    " → #" +
    ev.newTokenId +
    (label === undefined ? "" : " (" + label + ")") +
    (ctx || "");
  return { when, detail };
}
