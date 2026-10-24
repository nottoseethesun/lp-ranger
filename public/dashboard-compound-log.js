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
 *   `formatCompoundHistoryEntry`  — cold-load history-populate path,
 *                                   called by
 *                                   `dashboard-populate-history.js#populateCompoundHistoryOnce`
 *                                   once per entry in `data.compoundHistory`.
 */

/*-
 *  The marker after "reinvested", for a compound the bot recorded when it
 *  happened. A compound found by rebuilding the list from the chain
 *  (trigger `unknown`, or `historical` in a record written before that)
 *  gets none, since the chain does not say what started it.
 */
const TRIGGER_LABELS = {
  manual: "Manual",
  auto: "Auto",
};

/** The mark after an amount that is at the prices of its compound's time. */
const HISTORICAL_USD_MARK = " (historical $usd)";

/**
 * Whether a compound's $usd amount is at the prices of the time of the
 * compound. A compound the bot makes is recorded with the prices its
 * amount was worked out at (`price0`, `price1`). An entry written from
 * the chain, when a position is first scanned or by Re-scan Prices or
 * Reload Current Position, carries none: its amount is at the prices of
 * that moment (`_entryOf`, src/compound-activity-figures.js).
 * @param {object} ev  The compound's record.
 * @returns {boolean}
 */
function _usdAtCompoundTime(ev) {
  return Number.isFinite(ev.price0) && Number.isFinite(ev.price1);
}

/**
 * Build the `act()` payload from a single compound event object.
 * Pure — no DOM, no side effects.
 *
 * @param {object} ev              Compound event: `{ timestamp, tokenId,
 *                                 usdValue, trigger, txHash }`, and
 *                                 `price0` and `price1` when its amount
 *                                 is at the prices of its own time.
 * @param {string} ctx             Position-context suffix.
 * @param {string|number} [fallbackTokenId]  Token id to use when the event
 *                                 lacks its own (e.g., current active
 *                                 position for live-runtime entries).
 * @returns {object}               `{ title, type, detail, when, txHash,
 *                                 event }` for `act()`; `event` is `ev`,
 *                                 for the entry's figures.
 */
function _formatCompoundAct(ev, ctx, fallbackTokenId) {
  const when = ev.timestamp ? new Date(ev.timestamp) : undefined;
  const label = TRIGGER_LABELS[ev.trigger];
  const marker = label === undefined ? "" : " (" + label + ")";
  const usd = Number.isFinite(ev.usdValue) ? ev.usdValue : 0;
  const usdMark = _usdAtCompoundTime(ev) ? HISTORICAL_USD_MARK : "";
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
    " — $usd " +
    usd.toFixed(2) +
    usdMark +
    " reinvested" +
    marker +
    (ctx || "");
  return {
    title: "Compound",
    type: "fee",
    detail,
    when,
    txHash: ev.txHash || undefined,
    event: ev,
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
 * @returns {object|null}        `{ title, type, detail, when, txHash,
 *                               event }` for `act()`, or null when no
 *                               new compound is present.
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
 * Format a single historical compound event for the cold-load history-populate pass.
 * Mirrors the shape of `_populateHistoryOnce`'s per-event loop in
 * `dashboard-data.js`.
 *
 * @param {object} ev              Compound event from `data.compoundHistory`.
 * @param {string} ctx             Position-context suffix.
 * @param {string|number} [fallbackTokenId]  Token id to use when the event
 *                                 lacks its own.
 * @returns {object|null}          `{ title, type, detail, when, txHash,
 *                                 event }` or `null` if `ev` is missing.
 */
export function formatCompoundHistoryEntry(ev, ctx, fallbackTokenId) {
  if (!ev) return null;
  return _formatCompoundAct(ev, ctx, fallbackTokenId);
}
