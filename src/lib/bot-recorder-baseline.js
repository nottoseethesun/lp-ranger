/**
 * @file src/lib/bot-recorder-baseline.js
 * @module bot-recorder-baseline
 * @description
 * The HODL baseline a rebalance starts: what the new NFT held at its
 * mint, the dollar value of that at the rebalance's prices, and the
 * mint's gas. Split out of `src/lib/bot-recorder.js` at the 500-line cap; the
 * recorder calls it once a rebalance has minted.
 *
 * The baseline is what the Impermanent Loss Guard and the Current panel's
 * IL/G measure the new NFT against, so it is replaced, not merged: the
 * NFT it described is drained.
 */

"use strict";

const { coinDecimals } = require("./coin-decimals");
const { toFloat } = require("./bot-pnl-updater");

/**
 * Set `botState.hodlBaseline` from a rebalance result.
 *
 * @param {object} botState  The position's bot state, changed in place.
 * @param {object} result    The rebalance result: the minted amounts,
 *   their decimals, the tokens' USD prices and the mint's gas.
 * @param {string} mintNow   When the mint landed, as an ISO string.
 */
function updateHodlBaseline(botState, result, mintNow) {
  const { d0, d1 } = coinDecimals(
    result,
    "the rebalance result",
    "the new HODL baseline",
  );
  const a0 = toFloat(result.amount0Minted, d0),
    a1 = toFloat(result.amount1Minted, d1),
    p0 = result.token0UsdPrice || 0,
    p1 = result.token1UsdPrice || 0;
  /*-
   *  mintNow is an ISO string (used elsewhere as a position-mint label).
   *  Canonical hodlBaseline.mintTimestamp is Unix seconds, so convert
   *  here.  See src/client/web/dashboard-date-utils.js#toMintTsSeconds.
   */
  const mintTs = Math.floor(new Date(mintNow).getTime() / 1000);
  botState.hodlBaseline = {
    mintDate: mintNow.slice(0, 10),
    mintTimestamp: mintTs,
    entryValue: a0 * p0 + a1 * p1,
    hodlAmount0: a0,
    hodlAmount1: a1,
    token0UsdPrice: p0,
    token1UsdPrice: p1,
    /*-
     *  The new NFT's mint gas, kept on the baseline because that is
     *  where the lifetime scan and `position-history` read it from: it
     *  seeds `totalNftGasWei` for this NFT, which the Current panel
     *  prices at today and a reconstructed period prices at its own
     *  close day.
     */
    mintGasWei: result.mintGasCostWei ? String(result.mintGasCostWei) : "0",
  };
}

module.exports = { updateHodlBaseline };
