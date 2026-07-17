/**
 * @file dashboard-compound-log.js
 * @description Pure formatter for compound Activity Log entries.  Lives in
 * its own file (no DOM imports) so the formatting + decision logic is
 * testable under `node:test` without a browser/jsdom shim.
 *
 * Two entrypoints share `_formatCompoundAct`:
 *   `formatCompoundEntry`         — live-runtime path, called by
 *                                   `dashboard-data-events.js#_logCompound`
 *                                   when `st.lastCompoundAt` advances.
 *   `formatCompoundHistoryEntry`  — cold-load backfill path, called by
 *                                   `dashboard-data.js#_populateCompoundHistoryOnce`
 *                                   once per entry in `data.compoundHistory`.
 */

const TRIGGER_LABELS = {
  manual: "Manual",
  historical: "Historical",
  auto: "Auto",
};

/**
 * Build the `act()` payload from a single compound event object.
 * Pure — no DOM, no side effects.
 *
 * @param {object} ev              Compound event: `{ timestamp, tokenId,
 *                                 usdValue, trigger, txHash }`.
 * @param {string} ctx             Position-context suffix.
 * @param {string|number} [fallbackTokenId]  Token id to use when the event
 *                                 lacks its own (e.g., current active
 *                                 position for live-runtime entries).
 * @returns {object}               `{ title, type, detail, when, txHash }`
 *                                 for `act()`.
 */
function _formatCompoundAct(ev, ctx, fallbackTokenId) {
  const when = ev.timestamp ? new Date(ev.timestamp) : undefined;
  const trigger = TRIGGER_LABELS[ev.trigger] || "Auto";
  const usd = Number.isFinite(ev.usdValue) ? ev.usdValue : 0;
  /*-
   *  Prefer the event's own tokenId so historical compounds — including
   *  those that occurred on a now-drained NFT earlier in the rebalance
   *  chain — show the correct NFT label.  Falling back to the active
   *  position would render every historical row with the current
   *  tokenId, even when the row's compound happened on a different NFT.
   */
  const tokenId =
    ev.tokenId !== undefined && ev.tokenId !== null
      ? ev.tokenId
      : fallbackTokenId !== undefined && fallbackTokenId !== null
        ? fallbackTokenId
        : "?";
  const detail =
    "NFT #" +
    tokenId +
    " — $" +
    usd.toFixed(2) +
    " reinvested (" +
    trigger +
    ")" +
    (ctx || "");
  return {
    title: "Compound",
    type: "fee",
    detail,
    when,
    txHash: ev.txHash || undefined,
  };
}

/**
 * Decide whether a compound just executed and, if so, return the
 * `act()` payload describing it.
 *
 * @param {object} st            Per-position server state slice.
 * @param {string} st.lastCompoundAt    ISO timestamp of last compound.
 * @param {object[]} [st.compoundHistory]  Append-only compound log.
 * @param {object} [st.position]        Position metadata (for tokenId).
 * @param {string} ctx           Position-context suffix from `_logCtx`.
 * @param {string|null} prevSeen Previously-seen `lastCompoundAt` for this
 *                               key, or `null`/`undefined` if first poll.
 * @returns {object|null}        `{ title, type, detail, when, txHash }`
 *                               for `act()`, or null when no new
 *                               compound is present.
 */
export function formatCompoundEntry(st, ctx, prevSeen) {
  if (!st || !st.lastCompoundAt) return null;
  if (st.lastCompoundAt === prevSeen) return null;
  const ch = st.compoundHistory || [];
  const ev = ch.length ? ch[ch.length - 1] : null;
  if (!ev) return null;
  return _formatCompoundAct(ev, ctx, st.position?.tokenId);
}

/**
 * Format a single historical compound event for the cold-load backfill.
 * Mirrors the shape of `_populateHistoryOnce`'s per-event loop in
 * `dashboard-data.js`.
 *
 * @param {object} ev              Compound event from `data.compoundHistory`.
 * @param {string} ctx             Position-context suffix.
 * @param {string|number} [fallbackTokenId]  Token id to use when the event
 *                                 lacks its own.
 * @returns {object|null}          `{ title, type, detail, when, txHash }`
 *                                 or `null` if `ev` is missing.
 */
export function formatCompoundHistoryEntry(ev, ctx, fallbackTokenId) {
  if (!ev) return null;
  return _formatCompoundAct(ev, ctx, fallbackTokenId);
}
