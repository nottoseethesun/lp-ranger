"use strict";

/**
 * @file test/helpers/il-snapshot.js
 * @description A poll's P&L snapshot as the Impermanent Loss Guard reads
 *   it: the Current panel's IL/G for the NFT held (`totalIL`), and the
 *   minted coins and prices it was measured with (`ilInputs`), in the
 *   shape `_computeIL` (src/bot-pnl-il.js) leaves them. For tests that
 *   need a position at some value against some holding value without
 *   building a whole snapshot; a test of how the two are worked out
 *   builds them with `_computeIL` itself.
 */

/**
 * @param {number} positionUsd  What the Guard projects: the position with
 *   the wallet's coins and without this NFT's compounds.
 * @param {number} holdUsd      What holding the minted coins is worth.
 * @returns {object}  The snapshot fields the Guard reads.
 */
function ilSnapshot(positionUsd, holdUsd) {
  return {
    totalIL: positionUsd - holdUsd,
    ilInputs: {
      price0: 1,
      price1: 1,
      cur: { hodlAmount0: holdUsd, hodlAmount1: 0 },
    },
  };
}

module.exports = { ilSnapshot };
