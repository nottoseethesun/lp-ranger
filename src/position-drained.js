/**
 * @file src/position-drained.js
 * @module position-drained
 * @description
 * Whether a position holds no liquidity: its NFT drained, as after a
 * rebalance that emptied it and stopped before minting the next one, or a
 * closed position kept rather than burned. The one test every caller asks,
 * over the liquidity the position already keeps, which only two places
 * write: each poll's read from the chain (src/bot-cycle.js) and a
 * rebalance's new NFT (src/bot-recorder.js). Dependency-free.
 */

"use strict";

/**
 * Whether the position holds no liquidity. A position whose liquidity was
 * never read counts as holding none, as it always has.
 * @param {{liquidity?: string|number|bigint|null}|null|undefined} position
 * @returns {boolean}
 */
function isThisPositionDrained(position) {
  return BigInt(position?.liquidity ?? 0) === 0n;
}

module.exports = { isThisPositionDrained };
