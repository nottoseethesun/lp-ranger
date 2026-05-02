/**
 * @file src/bot-pnl-initial-residual.js
 * @module bot-pnl-initial-residual
 * @description
 * Surface the cached initial-residual snapshot (the wallet's token0/token1
 * balances captured at the END of `firstMintBlock` — i.e. what was left over
 * after the very first IncreaseLiquidity TX consumed its inputs) onto the
 * P&L snap, valued at FROZEN first-mint-block prices.  The dashboard
 * subtracts this from Lifetime Net P&L as its own line item so that the
 * unavoidable leftover from the initial mint does not inflate profit.
 * Frozen valuation is critical: if we used current prices, the subtracted
 * dollar amount would move with the market and erase price-appreciation
 * credit on those very tokens.
 *
 * Extracted from bot-pnl-updater.js to keep that file under the 500-line cap.
 */

"use strict";

const { loadInitialResidualData } = require("./liquidity-pair-details");
const { liquidityPairScopeKey } = require("./cache-store");

/**
 * Best-effort: read the shared liquidity-pair-details cache for the given
 * scope and write the initial-residual fields onto `snap`. Used by the
 * unmanaged one-shot detail path, which has no historical scan but can
 * surface data populated by a previous managed run for the same scope.
 *
 * @param {object} snap     Snapshot object to mutate.
 * @param {object} scope    { blockchain, factory, wallet, token0, token1, fee }
 */
function applyInitialResidualFromCache(snap, scope) {
  const ird = loadInitialResidualData(liquidityPairScopeKey(scope));
  if (!ird) return;
  const a0 = Number(ird.token0Amount) || 0;
  const a1 = Number(ird.token1Amount) || 0;
  const ip0 = Number(ird.token0Price) || 0;
  const ip1 = Number(ird.token1Price) || 0;
  snap.initialResidualAmount0 = a0;
  snap.initialResidualAmount1 = a1;
  snap.initialResidualPrice0 = ip0;
  snap.initialResidualPrice1 = ip1;
  snap.initialResidualUsd0 = a0 * ip0;
  snap.initialResidualUsd1 = a1 * ip1;
  snap.initialResidualUsd = a0 * ip0 + a1 * ip1;
  snap.initialResidualDate = ird.date || null;
}

/** Set the snapshot's initial-residual fields, defaulting to zeros. */
function applyInitialResidual(snap, deps) {
  const data = deps?._botState?.initialResidualData;
  if (!data) {
    snap.initialResidualUsd = 0;
    snap.initialResidualUsd0 = 0;
    snap.initialResidualUsd1 = 0;
    snap.initialResidualAmount0 = 0;
    snap.initialResidualAmount1 = 0;
    return;
  }
  const a0 = Number(data.token0Amount) || 0;
  const a1 = Number(data.token1Amount) || 0;
  const p0 = Number(data.token0Price) || 0;
  const p1 = Number(data.token1Price) || 0;
  const usd0 = a0 * p0;
  const usd1 = a1 * p1;
  snap.initialResidualUsd0 = usd0;
  snap.initialResidualUsd1 = usd1;
  snap.initialResidualUsd = usd0 + usd1;
  snap.initialResidualAmount0 = a0;
  snap.initialResidualAmount1 = a1;
  snap.initialResidualDate = data.date || null;
  snap.initialResidualPrice0 = p0;
  snap.initialResidualPrice1 = p1;
}

module.exports = { applyInitialResidual, applyInitialResidualFromCache };
