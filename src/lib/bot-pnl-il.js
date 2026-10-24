/**
 * @file src/lib/bot-pnl-il.js
 * @module bot-pnl-il
 * @description
 *   The two IL/G figures the dashboard shows, and the baseline resolution
 *   behind them.
 *
 *   `snap.totalIL` compares the position against the NFT it currently
 *   holds, at that NFT's own mint.  `snap.lifetimeIL` compares it against
 *   the first deposit of the whole rebalance chain.  They differ in more
 *   than window: each removes a different amount of compounded fees, for
 *   the reason spelled out in `ilFigures`, and they count the wallet's
 *   coins differently.
 *
 *   The current figure is an even comparison, the one the Impermanent
 *   Loss Guard measures with (src/lib/il-guard.js): the coins the NFT was
 *   minted with, held, against those coins as the position holds them
 *   now. It counts no coin in the wallet, so neither a rebalance's
 *   leftovers nor a deposit waiting there. The wallet's coins a compound
 *   took into the NFT after its mint, beyond its fees, are added to the
 *   coins it is measured against, since the position's value now holds
 *   them (`walletCoinsPutIn`, src/lib/compounded-coins.js).
 *
 *   The lifetime figure credits the wallet's coins to the position's
 *   side, and counts as put in the deposits the owner made since: the
 *   coins the deposit count found (src/lib/deposit-count.js) are added to the
 *   coins it measures against.
 *
 *   Split out of `bot-pnl-updater.js` at the 500-line cap.  The whole IL
 *   block moved together because the two figures share their baseline
 *   resolution and their fee-removal rule; separating them would leave
 *   two halves that only make sense read side by side.
 */

"use strict";

const { computeHodlIL } = require("./il-calculator");
const { nftCoinsToUsd } = require("./coin-value");
const { pollDeposits, plusDeposits } = require("./counted-deposits");
const { walletCoinsPutIn } = require("./compounded-coins");

/** Compute HODL IL for a given pair of token amounts.
 *  `residualValueUsd` (current pool-scoped wallet residual) is credited
 *  to the LP-side of the comparison — see computeHodlIL's JSDoc for
 *  why, and the original verbatim issue from the user: "Wallet
 *  Residual is not included in overall profit-loss - an oversight
 *  from our earlier work that is not visible with the bigger tokens
 *  since those swaps are always easy to do." The lifetime figure passes
 *  it; the current figure passes none (`ilFigures`). */
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

/**
 * Resolve lifetime HODL amounts from best available source, with the
 * deposits polls have counted since the last move's count. A move's
 * count is already in the scan result (src/lib/deposit-count.js).
 *
 * @param {object} deps  Bot deps; `_botState` holds the results.
 * @param {object} snap  P&L snapshot, for its first closed period.
 * @param {{decimals0: number, decimals1: number}} [decimals]  The pool's
 *   token decimals; without them the polls' deposits are not added.
 * @param {{amount0: number, amount1: number}} [shared]  The coins to add
 *   once each deposit of a coin another running position holds counts
 *   where its coins went (`depositAttribution`,
 *   src/lib/deposit-attribution-inputs.js); negative where the position
 *   lists more than its part.
 * @returns {{a0: number, a1: number}}
 */
function _lifetimeAmounts(deps, snap, decimals, shared) {
  const ltHodl = deps._botState?.lifetimeHodlAmounts;
  const bl = deps._botState?.hodlBaseline;
  const first = Array.isArray(snap.closedEpochs) ? snap.closedEpochs[0] : null;
  // Scan result is authoritative; fall back to first epoch or baseline.
  const held = {
    amount0: _first([ltHodl?.amount0, first?.hodlAmount0, bl?.hodlAmount0]),
    amount1: _first([ltHodl?.amount1, first?.hodlAmount1, bl?.hodlAmount1]),
  };
  const polled = decimals
    ? pollDeposits(
        ltHodl,
        deps._botState?._depositOverlay,
        decimals.decimals0,
        decimals.decimals1,
      )
    : { amount0: 0, amount1: 0 };
  const sum = plusDeposits(held, polled);
  const add = (v, d) => (typeof v === "number" ? v + (d ?? 0) : v);
  return {
    a0: add(sum.amount0, shared?.amount0),
    a1: add(sum.amount1, shared?.amount1),
  };
}

/**
 * The wallet's coins the current NFT's compounds took in beyond their
 * fees, from the position's compound list: coins put into the NFT after
 * its mint, which the Current IL/G measures against with its minted
 * coins.
 *
 * @param {object} deps  Bot deps; `_botState` holds the compound list.
 * @param {string|number} tokenId  The current NFT.
 * @param {{decimals0: number, decimals1: number}} [decimals]
 * @returns {{amount0: number, amount1: number}}
 */
function _coinsPutInSinceMint(deps, tokenId, decimals) {
  if (!decimals) return { amount0: 0, amount1: 0 };
  return walletCoinsPutIn(
    deps._botState?.compoundHistory,
    tokenId,
    decimals.decimals0,
    decimals.decimals1,
  );
}

/**
 * The two IL/G figures, from the values each one compares.
 *
 * The single expression of the rule. The bot tier reaches it through
 * `_computeIL` below; the view tier (`src/lib/position-details.js`, for an
 * unmanaged position) calls it directly. Both must answer identically
 * for the same position — an operator who stops managing one has
 * changed nothing on chain, so nothing on screen may move.
 *
 * Pure: no bot state, no snapshot, no I/O. Everything it needs is an
 * argument, which is what lets two tiers with different state shapes
 * share it rather than keep a copy each.
 *
 * The current figure counts no coin in the wallet. The user, 2026-10-23,
 * on the Impermanent Loss Guard, which measures with it: its purpose "is
 * to compare the existing position in its state when it was first
 * minted, directly against a hypothetical rebalanced one. If you add in
 * residual coins, it's not an even comparison." So a = the position's
 * value now, b = holding the coins the NFT was minted with, plus the
 * wallet's coins its compounds took in since, at current prices.
 *
 * The lifetime figure credits the current pool-scoped wallet residual to
 * the LP-side. Simple "a vs b" comparison per the user's mandate: a = (LP
 * value + wallet residual), b = HODL value at current prices. The
 * initial-mint residual is NOT subtracted even though the LP may have
 * absorbed some of it — the user chose the simple credit over full
 * LP-accounting symmetry, so the dashboard matches "the coins the LP
 * still has, valued today, vs the coins you put in, valued today."
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
 * @param {number} args.residualValueUsd  Pool-scoped wallet residual, for
 *   the lifetime figure only.
 * @param {number} args.price0    Token0 USD price.
 * @param {number} args.price1    Token1 USD price.
 * @param {{amount0: number, amount1: number}} args.curHodl  Deposited
 *   amounts for the NFT currently held: its own mint, and the wallet's
 *   coins its compounds took in since.
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
    totalIL: _ilFor(lpValue - curComp, curA0, curA1, price0, price1, 0),
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
 * @param {{decimals0: number, decimals1: number}} [decimals]  The pool's
 *   token decimals, for the coins the deposit count found and those the
 *   current NFT's compounds took from the wallet.
 * @param {{amount0: number, amount1: number}} [shared]  The change to the
 *   lifetime holding once each deposit of a coin another running position
 *   holds counts where its coins went (`_lifetimeAmounts`).
 */
function _computeIL(
  snap,
  deps,
  realValue,
  price0,
  price1,
  tokenId,
  decimals,
  shared,
) {
  const bl = deps._botState?.hodlBaseline;
  const { a0, a1 } = _lifetimeAmounts(deps, snap, decimals, shared);
  const putIn = _coinsPutInSinceMint(deps, tokenId, decimals);
  const figures = ilFigures({
    lpValue: realValue,
    residualValueUsd: snap.residualValueUsd,
    price0,
    price1,
    curHodl: plusDeposits(
      { amount0: bl?.hodlAmount0, amount1: bl?.hodlAmount1 },
      putIn,
    ),
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
