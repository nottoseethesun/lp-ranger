/**
 * @file dashboard-manage-refusal.js
 * @description What the page says when the server refuses to start
 * managing a position under the one-active-position-per-pool rule:
 * which position holds the pool and what to do about it, in place of the
 * code the server answers with. The page's own Manage check refuses the
 * same cases before it asks, so these words show only when its view lags
 * the server's: a second tab started a position in the pool a moment
 * ago, say. A Manage and a re-open ask the same route, so both show
 * them; the server logs the same refusal in its own words
 * (src/pool-already-managed.js).
 */

"use strict";

/**
 * The words for a Manage or re-open refused under the pool rule, or null
 * for any other answer.
 *
 * The answer names the position refused (`positionKey`, whose last part
 * is its NFT id) and, for a pool already taken, the position holding it.
 *
 * @param {object|string|null} answer  The server's answer, or the bare
 *   reason of a request that got none.
 * @returns {{title: string, text: string}|null}
 */
export function poolRuleRefusal(answer) {
  if (answer === null || typeof answer !== "object") return null;
  const key = answer.positionKey;
  const self =
    typeof key === "string" ? `NFT #${key.split("-").pop()}` : "this position";
  if (answer.error === "pool-already-managed") {
    const holder = `NFT #${answer.conflictTokenId}`;
    return {
      title: "Pool Already Managed",
      text:
        `LP Ranger already manages ${holder} in the pool of ${self}, ` +
        "and it manages one active position per pool. " +
        `To manage ${self} instead, stop managing ${holder} first.`,
    };
  }
  if (answer.error === "pool-has-open-position") {
    const open = `NFT #${answer.openTokenId}`;
    return {
      title: "Pool Has an Open Position",
      text:
        `Re-opening ${self}, which is closed, would put a second open ` +
        `position in its pool, where the wallet already holds open ${open}. ` +
        "LP Ranger manages one active position per pool. " +
        `Manage ${open} instead, or close it first.`,
    };
  }
  if (answer.error === "pool-info-unavailable")
    return {
      title: "Pool Info Unavailable",
      text:
        `LP Ranger could not read the pool of ${self} from the chain, ` +
        "so nothing was started. Try again in a moment; the LP Ranger log " +
        "in your terminal says what failed.",
    };
  return null;
}
