/**
 * @file dashboard-compound-log.js
 * @description Pure formatter for compound Activity Log entries.  Lives in
 * its own file (no DOM imports) so the formatting + decision logic is
 * testable under `node:test` without a browser/jsdom shim.
 *
 * Consumed by `dashboard-data-events.js#_logCompound`.
 */

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
  const when = ev.timestamp ? new Date(ev.timestamp) : undefined;
  const trigger = ev.trigger === "manual" ? "Manual" : "Auto";
  const usd = Number.isFinite(ev.usdValue) ? ev.usdValue : 0;
  const tokenId = st.position?.tokenId ?? "?";
  const detail =
    "NFT #" +
    tokenId +
    " \u2014 $" +
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
