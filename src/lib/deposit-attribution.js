"use strict";

/**
 * @file src/lib/deposit-attribution.js
 * @module deposit-attribution
 * @description
 * How much of each deposit to the wallet each managed position counts as
 * money put in, when more than one of them holds the deposited coin.
 *
 * A deposit is a transaction that brings one of a pool's coins into the
 * wallet from outside (src/lib/wallet-deposits.js). Each managed position
 * finds the deposits of its own two coins, so a deposit of a coin two
 * positions hold is in both positions' deposit lists. Counted in full by
 * each, it would be money put in twice for coins that arrived once.
 *
 * Where the coins go decides who counts them:
 *
 * - **While the coins wait in the wallet**, each position holding the
 *   coin counts the share of them the Wallet Residual (Pool) credits it:
 *   its own holding of the coin over all the running managed positions'
 *   holdings of it (`walletResiduals`, src/lib/bot-pnl-updater.js). What a
 *   position counts as put in then matches the coins it is credited with,
 *   so the deposit moves none of its Lifetime figures. The share moves
 *   from poll to poll as prices move the positions' holdings, and the
 *   counted part moves with it.
 * - **A rebalance takes them all**: it mints with the wallet's whole
 *   balance of its two coins (src/lib/rebalancer.js, step 7), so from its
 *   mint on, the position it minted for counts every deposit of those
 *   coins still waiting, and the others count none of it.
 * - **A compound takes part**: its deposit takes from the wallet the
 *   coins its record shows beyond its fees (src/lib/compounded-coins.js).
 *   The wallet then also holds coins that are no deposit, such as a
 *   rebalance's leftovers, so the deposits' part of that take is in
 *   proportion to their share of the wallet's balance of the coin just
 *   before the compound, which the compound reads before its collect
 *   (`amount0WalletBefore`, `amount1WalletBefore`). That part counts for
 *   the compounding position from then on, and only the rest still waits.
 *   A compound recorded without that reading takes the deposits' coins
 *   first.
 *
 * This module replays each coin's deposits and those moves in block
 * order, from what the running positions already hold: their deposit
 * lists, their rebalance events and their compound lists. Nothing is
 * saved; each poll replays again. A deposit and a move in the same block
 * are taken in that order, as the Lifetime scan's windows end at a mint's
 * block. A compound with no block recorded, or without its fees told
 * apart, takes nothing here. The first mint of a position is no take: the
 * position counts its minted coins as its first deposit already.
 *
 * Amounts are in each coin's smallest unit, as numbers, and every deposit
 * keeps its dollar figure at its own block's price (`usd`), so a counted
 * part of it is that part of the figure.
 *
 * Pure: no files, no chain, no logging.
 */

/**
 * Add a fraction to a position's part of one deposit.
 *
 * @param {Map<string, number>} parts  By position.
 * @param {string} holder  The position.
 * @param {number} fraction  Of the deposit.
 */
function _add(parts, holder, fraction) {
  parts.set(holder, (parts.get(holder) ?? 0) + fraction);
}

/**
 * Each deposit of one coin, once, from every list it is in: its block,
 * its amount of the coin and its dollar figure for that coin.
 *
 * @param {object[]} holders  From `holdersOf` (deposit-attribution-inputs).
 * @param {string} coin  The coin, lower-cased.
 * @returns {Map<string, {block: number, raw: number, usd: number|null}>}
 */
function _depositsOf(holders, coin) {
  const out = new Map();
  for (const h of holders) {
    const i = h.coins.indexOf(coin);
    if (i < 0) continue;
    for (const d of h.deposits) {
      if (!(d.raw[i] > 0)) continue;
      const seen = out.get(d.key);
      if (seen === undefined)
        out.set(d.key, { block: d.block, raw: d.raw[i], usd: d.usd[i] });
      else if (seen.usd === null && d.usd[i] !== null) seen.usd = d.usd[i];
    }
  }
  return out;
}

/**
 * The moves that take a coin's waiting deposits, in block order, each
 * after the deposits of its own block.
 *
 * @param {object[]} holders  From `holdersOf`.
 * @param {string} coin  The coin, lower-cased.
 * @param {Map} deposits  From `_depositsOf`.
 * @returns {object[]}
 */
function _eventsOf(holders, coin, deposits) {
  const events = [];
  for (const [key, d] of deposits)
    events.push({ block: d.block, order: 0, kind: "deposit", key });
  for (const h of holders) {
    const i = h.coins.indexOf(coin);
    if (i < 0) continue;
    for (const block of h.mints)
      events.push({ block, order: 2, kind: "rebalance", holder: h.id });
    for (const c of h.compounds)
      if (c.take[i] > 0)
        events.push({
          block: c.block,
          order: 1,
          kind: "compound",
          holder: h.id,
          take: c.take[i],
          walletBefore: c.walletBefore[i],
        });
  }
  return events.sort((a, b) => a.block - b.block || a.order - b.order);
}

/**
 * The share of the waiting deposits a compound took: the deposits' part
 * of what it took from the wallet, over the deposits waiting.
 *
 * @param {number} waiting  The deposits' coins waiting, in all.
 * @param {number} take  What the compound took from the wallet beyond its
 *   fees.
 * @param {number|null} walletBefore  The wallet's balance of the coin
 *   just before the compound, or null when it was not recorded.
 * @returns {number}  From 0 to 1.
 */
function _compoundShare(waiting, take, walletBefore) {
  if (!(waiting > 0)) return 0;
  const deposits =
    walletBefore === null
      ? Math.min(take, waiting)
      : walletBefore > 0
        ? Math.min(take, (waiting * take) / walletBefore)
        : 0;
  return Math.min(1, deposits / waiting);
}

/**
 * Move a share of every waiting deposit to the position that took it.
 *
 * @param {Map} state  Each deposit's waiting fraction and positions' parts.
 * @param {Map} deposits  From `_depositsOf`.
 * @param {object} event  The move.
 * @param {number} share  Of each waiting deposit, from 0 to 1.
 * @returns {{raw: number, usd: number}}  What it took.
 */
function _take(state, deposits, event, share) {
  let raw = 0;
  let usd = 0;
  for (const [key, t] of state) {
    if (!(t.waiting > 0)) continue;
    const moved = t.waiting * share;
    _add(t.parts, event.holder, moved);
    t.waiting -= moved;
    const d = deposits.get(key);
    raw += d.raw * moved;
    usd += (d.usd ?? 0) * moved;
  }
  return { raw, usd };
}

/**
 * Replay one coin's deposits and the moves that take them.
 *
 * @param {object[]} holders  Each running position, from `holdersOf`:
 *   `id`, `coins` (its two coins, lower-cased), `deposits` (`key`,
 *   `block`, `raw` and `usd` for each coin), `mints` (its rebalances'
 *   mint blocks) and `compounds` (`block`, `take` and `walletBefore` for
 *   each coin).
 * @param {string} coin  The coin, lower-cased.
 * @returns {{deposits: Map<string, {raw: number, usd: number|null,
 *   waiting: number, parts: Map<string, number>}>, takes: Array<{holder:
 *   string, block: number, kind: string, raw: number, usd: number}>}}
 *   Each deposit with the fraction of it still waiting and each
 *   position's part of the rest; and each move with what it took.
 */
function attributeCoin(holders, coin) {
  const deposits = _depositsOf(holders, coin);
  const state = new Map();
  const takes = [];
  for (const ev of _eventsOf(holders, coin, deposits)) {
    if (ev.kind === "deposit") {
      state.set(ev.key, { waiting: 1, parts: new Map() });
      continue;
    }
    let waiting = 0;
    for (const [key, t] of state) waiting += deposits.get(key).raw * t.waiting;
    const share =
      ev.kind === "rebalance"
        ? 1
        : _compoundShare(waiting, ev.take, ev.walletBefore);
    if (!(waiting > 0) || !(share > 0)) continue;
    const taken = _take(state, deposits, ev, share);
    takes.push({ holder: ev.holder, block: ev.block, kind: ev.kind, ...taken });
  }
  const out = new Map();
  for (const [key, d] of deposits) out.set(key, { ...d, ...state.get(key) });
  return { deposits: out, takes };
}

/**
 * What one position counts of a coin's deposits: its part of those moves
 * took, and its share of what still waits.
 *
 * @param {object} result  From `attributeCoin`.
 * @param {string} holder  The position.
 * @param {number} share  Its share of the wallet's balance of the coin,
 *   as the Wallet Residual (Pool) credits it.
 * @returns {{raw: number, usd: number}}  In the coin's smallest unit, and
 *   dollars at each deposit's own block's price.
 */
function countedFor(result, holder, share) {
  let raw = 0;
  let usd = 0;
  for (const d of result.deposits.values()) {
    const fraction = (d.parts.get(holder) ?? 0) + share * d.waiting;
    raw += d.raw * fraction;
    usd += (d.usd ?? 0) * fraction;
  }
  return { raw, usd };
}

/**
 * The deposits one position's rebalance took at its mint block, for the
 * Activity Log entry's figures (src/lib/rebalance-activity-figures.js).
 *
 * @param {object} result  From `attributeCoin`.
 * @param {string} holder  The position.
 * @param {number} block  The rebalance's mint block.
 * @returns {number}  In the coin's smallest unit.
 */
function takenAt(result, holder, block) {
  let raw = 0;
  for (const t of result.takes)
    if (t.holder === holder && t.block === block && t.kind === "rebalance")
      raw += t.raw;
  return raw;
}

module.exports = { attributeCoin, countedFor, takenAt };
