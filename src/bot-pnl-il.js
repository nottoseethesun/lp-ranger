/**
 * @file src/bot-pnl-il.js
 * @module bot-pnl-il
 * @description
 *   The two IL/G figures the dashboard shows, and the baseline resolution
 *   behind them.
 *
 *   `snap.totalIL` compares the position against the NFT it currently
 *   holds, at that NFT's own mint.  `snap.lifetimeIL` compares it against
 *   the first deposit of the whole rebalance chain.  They differ in more
 *   than window: each removes a different amount of compounded fees, for
 *   the reason spelled out in `_computeIL`.
 *
 *   Split out of `bot-pnl-updater.js` at the 500-line cap.  The whole IL
 *   block moved together because the two figures share their baseline
 *   resolution and their fee-removal rule; separating them would leave
 *   two halves that only make sense read side by side.
 */

"use strict";

const { computeHodlIL } = require("./il-calculator");
const { nftCoinsToUsd } = require("./coin-value");

/** Compute HODL IL for a given pair of token amounts.
 *  `residualValueUsd` (current pool-scoped wallet residual) is credited
 *  to the LP-side of the comparison — see computeHodlIL's JSDoc for
 *  why, and the original verbatim issue from the user: "Wallet
 *  Residual is not included in overall profit-loss - an oversight
 *  from our earlier work that is not visible with the bigger tokens
 *  since those swaps are always easy to do." */
function _ilFor(realValue, a0, a1, price0, price1, residualValueUsd) {
  return a0 > 0 || a1 > 0
    ? computeHodlIL({
        lpValue: realValue,
        hodlAmount0: a0,
        hodlAmount1: a1,
        currentPrice0: price0,
        currentPrice1: price1,
        residualValueUsd: residualValueUsd || 0,
      })
    : undefined;
}

/** First non-zero value from a list of candidates. */
function _first(vals) {
  for (const v of vals) if (v > 0) return v;
  return 0;
}

/** Resolve lifetime HODL amounts from best available source. */
function _lifetimeAmounts(deps, snap) {
  const ltHodl = deps._botState?.lifetimeHodlAmounts;
  const bl = deps._botState?.hodlBaseline;
  const first = Array.isArray(snap.closedEpochs) ? snap.closedEpochs[0] : null;
  // Scan result is authoritative; fall back to first epoch or baseline.
  return {
    a0: _first([ltHodl?.amount0, first?.hodlAmount0, bl?.hodlAmount0]),
    a1: _first([ltHodl?.amount1, first?.hodlAmount1, bl?.hodlAmount1]),
  };
}

/**
 * The two IL/G figures, from the values each one compares.
 *
 * The single expression of the rule. The bot tier reaches it through
 * `_computeIL` below; the view tier (`src/position-details.js`, for an
 * unmanaged position) calls it directly. Both must answer identically
 * for the same position — an operator who stops managing one has
 * changed nothing on chain, so nothing on screen may move.
 *
 * Pure: no bot state, no snapshot, no I/O. Everything it needs is an
 * argument, which is what lets two tiers with different state shapes
 * share it rather than keep a copy each.
 *
 * Credit the current pool-scoped wallet residual to the LP-side.
 * Simple "a vs b" comparison per the user's mandate: a = (LP value +
 * wallet residual), b = HODL value at current prices. The initial-mint
 * residual is NOT subtracted even though the LP may have absorbed some
 * of it — the user chose the simple credit over full LP-accounting
 * symmetry, so the dashboard matches "the coins the LP still has,
 * valued today, vs the coins you put in, valued today." Accepted edge
 * case: a freshly minted LP that has not rebalanced shows +$X of IL/G
 * equal to its initial-mint leftover until the first rebalance folds
 * that leftover in.
 *
 * Fees are not impermanent loss. Compounding calls `increaseLiquidity`,
 * so compounded fees are part of the liquidity `lpValue` measures while
 * the HODL side stays fixed at the deposited amounts. Left in, a $100
 * compound reads as $100 of LP outperformance and Profit adds the same
 * $100 again as earnings. Taking them out keeps IL/G what the standard
 * definition says it is — divergence only, fees counted separately —
 * and matches `_epochIl` in pnl-tracker.js, which subtracts an epoch's
 * fees from its exit value for the Per-Day table.
 *
 * The two removals differ because the two comparisons start at
 * different points: the lifetime figure compares against the first
 * deposit, so every compound ever made sits in today's liquidity; the
 * current-NFT figure compares against this NFT's mint, which already
 * contained the earlier ones, so only compounds made since that mint
 * come off.
 *
 * Both removals are saved COINS priced at the caller's current prices.
 * A stored dollar total would drift by whatever the pair had done since
 * the compound — an error that grows with the position's age.
 *
 * @param {object} args
 * @param {number} args.lpValue   LP position value now (USD), fees included.
 * @param {number} args.residualValueUsd  Pool-scoped wallet residual.
 * @param {number} args.price0    Token0 USD price.
 * @param {number} args.price1    Token1 USD price.
 * @param {{amount0: number, amount1: number}} args.curHodl  Deposited
 *   amounts for the NFT currently held (its own mint).
 * @param {{amount0: number, amount1: number}} args.ltHodl   Deposited
 *   amounts across the position's whole life.
 * @param {number} args.curCompoundedUsd  What this NFT compounded, now.
 * @param {number} args.ltCompoundedUsd   What the position compounded, now.
 * @returns {{totalIL: number|undefined, lifetimeIL: number|undefined,
 *   ilInputs: object}}  `undefined` for a figure whose HODL side is
 *   empty, which the dashboard renders as a dash rather than a zero.
 */
function ilFigures({
  lpValue,
  residualValueUsd,
  price0,
  price1,
  curHodl,
  ltHodl,
  curCompoundedUsd,
  ltCompoundedUsd,
}) {
  const rUsd = residualValueUsd ?? 0;
  const curComp = curCompoundedUsd ?? 0;
  const ltComp = ltCompoundedUsd ?? 0;
  const curA0 = curHodl?.amount0 ?? 0,
    curA1 = curHodl?.amount1 ?? 0;
  const ltA0 = ltHodl?.amount0 ?? 0,
    ltA1 = ltHodl?.amount1 ?? 0;
  return {
    totalIL: _ilFor(lpValue - curComp, curA0, curA1, price0, price1, rUsd),
    lifetimeIL: _ilFor(lpValue - ltComp, ltA0, ltA1, price0, price1, rUsd),
    ilInputs: {
      lpValue,
      residualValueUsd: rUsd,
      price0,
      price1,
      cur: {
        hodlAmount0: curA0,
        hodlAmount1: curA1,
        compoundedRemoved: curComp,
      },
      lt: { hodlAmount0: ltA0, hodlAmount1: ltA1, compoundedRemoved: ltComp },
    },
  };
}

/**
 * Write `totalIL` and `lifetimeIL` onto the snapshot — the bot tier's
 * wrapper around `ilFigures`, supplying the figures from bot state.
 *
 * @param {object} snap       P&L snapshot, mutated in place.
 * @param {object} deps       Bot deps; `_botState` supplies the baselines.
 * @param {number} realValue  LP position value now (USD), fees included.
 * @param {number} price0     Token0 USD price.
 * @param {number} price1     Token1 USD price.
 * @param {string|number} tokenId  Current NFT, for its compounded total.
 */
function _computeIL(snap, deps, realValue, price0, price1, tokenId) {
  const bl = deps._botState?.hodlBaseline;
  const { a0, a1 } = _lifetimeAmounts(deps, snap);
  const figures = ilFigures({
    lpValue: realValue,
    residualValueUsd: snap.residualValueUsd,
    price0,
    price1,
    curHodl: { amount0: bl?.hodlAmount0, amount1: bl?.hodlAmount1 },
    ltHodl: { amount0: a0, amount1: a1 },
    /*- Valued a few lines earlier in `overridePnlWithRealValues`, from
     *  the same saved coins. */
    curCompoundedUsd: nftCoinsToUsd(
      deps._botState?.nftCompoundedAmountsByTokenId,
      tokenId,
      price0,
      price1,
    ),
    ltCompoundedUsd: snap.totalCompoundedUsd,
  });
  snap.totalIL = figures.totalIL;
  snap.lifetimeIL = figures.lifetimeIL;
  snap.ilInputs = figures.ilInputs;
}

module.exports = { _ilFor, _lifetimeAmounts, _computeIL, ilFigures };
