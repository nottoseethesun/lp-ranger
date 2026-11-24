/**
 * @file dashboard-data-kpi-fees.js
 * @description The Current panel's fee decision: how much this position
 *   has earned and not yet collected.
 *
 *   Split from dashboard-data-kpi.js at the 500-line cap, and kept as a
 *   pure function of the status payload so it can be driven directly by
 *   a test rather than through the DOM.
 */

/**
 * Fees earned and not yet collected, in USD.
 *
 * `liveEpoch.fees` is not that figure, though its name suggests it.
 * `pnl-tracker.js` builds it as `feesAccrued + compoundedAccrued`, so it
 * already contains the fees a compound swept back into liquidity — the
 * same ones the Fees Compounded row reports. The Current panel shows the
 * two as separate rows and sums them into Profit, so anything present in
 * both is counted twice.
 *
 * `currentFeesUsd` is the unclaimed figure alone, published by
 * `overridePnlWithRealValues` from the same reading that feeds the
 * tracker. Where it is missing, the compounded part is subtracted back
 * out of the epoch figure rather than the epoch figure being used raw:
 * the two differ by exactly that, by construction, so the fallback
 * cannot reintroduce the double count it exists to avoid.
 *
 * @param {object} d              Status payload.
 * @param {number} curCompounded  This NFT's compounded fees, in USD.
 * @returns {number}  Unclaimed fees in USD.
 */
export function currentUnclaimedFees(d, curCompounded) {
  const direct = d?.pnlSnapshot?.currentFeesUsd;
  if (typeof direct === "number" && Number.isFinite(direct)) return direct;
  /*- Only subtract from a figure that exists. With no live epoch there is
   *  nothing to back the compounded part out of, and subtracting from
   *  zero would report negative unclaimed fees — which would then read as
   *  a loss in Profit and disable the Compound button for the wrong
   *  reason. */
  const epoch = d?.pnlSnapshot?.liveEpoch?.fees;
  if (typeof epoch !== "number" || !Number.isFinite(epoch)) return 0;
  return epoch - (curCompounded || 0);
}

/*-
 *  The unclaimed-fee figure the unmanaged detail flow last applied, and
 *  the NFT it belongs to.
 *
 *  An unmanaged position has no bot poll publishing `currentFeesUsd`, so
 *  its one-shot details response is the only place that figure exists —
 *  and the Compound button's threshold gate needs it. Holding it here
 *  lets that gate read a value instead of reading back the text it
 *  rendered, which the DOM-as-state rule forbids.
 *
 *  It lives in this module rather than in the one that applies it because
 *  this module imports nothing. The writer and the reader would otherwise
 *  close a cycle through `dashboard-data.js`.
 *
 *  Stored with its tokenId so it expires by itself: a different position
 *  never matches, so no reset wiring is needed on a switch and a stale
 *  figure cannot gate the wrong NFT's button.
 */
let _unmanagedFees = { tokenId: null, usd: null };

/**
 * Record the unclaimed fees an unmanaged details response reported.
 *
 * @param {string|number|undefined} tokenId  The NFT it describes.
 * @param {*} usd  Unclaimed fees in USD, as the response gave them.
 */
export function rememberUnmanagedUnclaimedFees(tokenId, usd) {
  _unmanagedFees = {
    tokenId: tokenId === undefined || tokenId === null ? null : String(tokenId),
    usd: typeof usd === "number" && Number.isFinite(usd) ? usd : null,
  };
}

/**
 * The unclaimed fees last recorded for `tokenId`, or null when none were
 * recorded for that position.
 *
 * @param {string|number|undefined} tokenId  NFT to ask about.
 * @returns {number|null}
 */
export function unmanagedUnclaimedFees(tokenId) {
  if (tokenId === undefined || tokenId === null) return null;
  return _unmanagedFees.tokenId === String(tokenId) ? _unmanagedFees.usd : null;
}
