"use strict";

/**
 * @file src/lib/deposit-attribution-inputs.js
 * @module deposit-attribution-inputs
 * @description
 * The running positions' deposits and moves, gathered for the replay in
 * src/lib/deposit-attribution.js, and what that replay changes in one
 * position's Lifetime figures.
 *
 * Each managed position's bot state holds what the replay needs: its
 * pool's two coins (`activePosition`), its deposit list
 * (`lifetimeHodlAmounts.deposits`, with what polls have found since in
 * `_depositOverlay`), its rebalance events (`rebalanceEvents`, each at
 * its new NFT's mint block) and its compound list (`compoundHistory`).
 * `walletStates` picks the running states of one wallet, which
 * src/lib/server-positions.js hands each state as `_walletDepositStates`.
 *
 * Every poll, `depositAttribution` replays each of the position's two
 * coins across those states, and answers how much the position's
 * Lifetime figures change: the coins its holding counts and the dollars
 * its Total Lifetime Deposit counts, for the deposits it lists, are
 * replaced by its part of every deposit of those coins
 * (`countedFor`). A deposit only this position holds the coin of comes
 * out the same either way. At the end of a scan pass, `depositTakenAt`
 * answers what one of its rebalances took, for that rebalance's Activity
 * Log figures (src/lib/rebalance-activity-figures.js).
 *
 * A deposit brings one of its pool's two coins, never both: a
 * transaction in which both come in is a drain or a fee collection, not
 * a deposit (`_isDeposit`, src/lib/wallet-deposits.js), and a wrap brings
 * only the wrapped coin. So a deposit's dollar figure (`usd`) is that one
 * coin's, and nothing more is kept to divide it.
 */

const { isCountedEntry, pollDeposits } = require("./counted-deposits");
const { isPlainObject } = require("./plain-object");
const { attributeCoin, countedFor, takenAt } = require("./deposit-attribution");

/** No change: the answer when there is nothing to replay. */
const _NONE = Object.freeze({ amount0: 0, amount1: 0, usd: 0 });

/** An amount in a coin's smallest unit, as a number; 0 when malformed. */
function _units(raw) {
  if (typeof raw === "bigint") return Number(raw);
  return typeof raw === "string" && /^[0-9]+$/.test(raw)
    ? Number(BigInt(raw))
    : 0;
}

/** An amount in a coin's smallest unit, or null when none is recorded. */
function _unitsOrNull(raw) {
  return typeof raw === "string" && /^[0-9]+$/.test(raw)
    ? Number(BigInt(raw))
    : null;
}

/**
 * A deposit's dollar figure by coin: all of it on the one coin it brought
 * (see the file header), or null while it is unpriced.
 *
 * @param {object} e  A deposit entry.
 * @returns {Array<number|null>}
 */
function _usdByCoin(e) {
  const usd = typeof e.usd === "number" && e.usd > 0 ? e.usd : null;
  return _units(e.raw0) > 0 ? [usd, 0] : [0, usd];
}

/**
 * A state's deposits, each once: those its list holds, and those polls
 * have found since.
 *
 * @param {object} s  A bot state.
 * @returns {object[]}  The entries, each naming its transaction.
 */
function _entriesOf(s) {
  const listed = s.lifetimeHodlAmounts?.deposits;
  const polled = s._depositOverlay?.entries;
  const out = new Map();
  for (const e of [
    ...(Array.isArray(listed) ? listed : []),
    ...(Array.isArray(polled) ? polled : []),
  ])
    if (isCountedEntry(e) && !out.has(e.txHash.toLowerCase()))
      out.set(e.txHash.toLowerCase(), e);
  return out;
}

/**
 * A state's compounds that take the wallet's coins: each with its block,
 * the coins its deposit took beyond its fees, and the wallet's two coins
 * before its collect when it read them.
 *
 * @param {object} s  A bot state.
 * @returns {object[]}
 */
function _compoundsOf(s) {
  const out = [];
  for (const c of Array.isArray(s.compoundHistory) ? s.compoundHistory : []) {
    if (!isPlainObject(c) || !Number.isInteger(c.blockNumber)) continue;
    const fee0 = _unitsOrNull(c.amount0Compounded);
    const fee1 = _unitsOrNull(c.amount1Compounded);
    if (fee0 === null || fee1 === null) continue;
    out.push({
      block: c.blockNumber,
      take: [
        Math.max(0, _units(c.amount0Deposited) - fee0),
        Math.max(0, _units(c.amount1Deposited) - fee1),
      ],
      walletBefore: [
        _unitsOrNull(c.amount0WalletBefore),
        _unitsOrNull(c.amount1WalletBefore),
      ],
    });
  }
  return out;
}

/** The mint blocks of a state's rebalances. */
function _mintsOf(events) {
  return (Array.isArray(events) ? events : [])
    .map((e) => e?.blockNumber)
    .filter((b) => Number.isInteger(b));
}

/**
 * The replay's view of the running positions, and which one is `self`.
 *
 * @param {object[]} states  From `walletStates`.
 * @param {object} self  The position asking.
 * @param {object[]} [selfEvents]  Its rebalance events, when the caller
 *   holds a newer list than its state does.
 * @returns {{holders: object[], selfId: string|null}}
 */
function holdersOf(states, self, selfEvents) {
  const holders = [];
  let selfId = null;
  states.forEach((s, i) => {
    const ap = s.activePosition;
    if (!ap?.token0 || !ap?.token1) return;
    const id = String(i);
    if (s === self) selfId = id;
    const deposits = [];
    for (const [key, e] of _entriesOf(s))
      deposits.push({
        key,
        block: e.block,
        raw: [_units(e.raw0), _units(e.raw1)],
        usd: _usdByCoin(e),
      });
    holders.push({
      id,
      coins: [ap.token0.toLowerCase(), ap.token1.toLowerCase()],
      deposits,
      mints: _mintsOf(
        s === self && selfEvents ? selfEvents : s.rebalanceEvents,
      ),
      compounds: _compoundsOf(s),
    });
  });
  return { holders, selfId };
}

/**
 * The running bot states of one position's wallet, that position first.
 *
 * @param {Map<string, object>} map  Every position's bot state.
 * @param {object} self  The position asking.
 * @returns {object[]}
 */
function walletStates(map, self) {
  const wallet = String(self.walletAddress ?? "").toLowerCase();
  const out = [self];
  for (const s of map.values())
    if (
      s !== self &&
      s.running === true &&
      String(s.walletAddress ?? "").toLowerCase() === wallet
    )
      out.push(s);
  return out;
}

/**
 * What a position's Lifetime figures count now of the deposits it
 * lists, in each coin's smallest unit and in dollars: every entry its
 * list holds, and what polls have found after the newest mint the list
 * covers, as `pollDeposits` adds them (src/lib/counted-deposits.js).
 *
 * @param {object} self  The position's bot state.
 * @returns {{raw: number[], usd: number}}
 */
function _listedNow(self) {
  const lt = self.lifetimeHodlAmounts;
  const covered = typeof lt?.lastBlock === "number" ? lt.lastBlock : 0;
  const listed = (Array.isArray(lt?.deposits) ? lt.deposits : []).filter(
    isCountedEntry,
  );
  const polled = (
    Array.isArray(self._depositOverlay?.entries)
      ? self._depositOverlay.entries
      : []
  ).filter((e) => isCountedEntry(e) && e.block > covered);
  const raw = [0, 0];
  let usd = 0;
  const seen = new Set();
  for (const e of [...listed, ...polled]) {
    const key = e.txHash.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    raw[0] += _units(e.raw0);
    raw[1] += _units(e.raw1);
    if (typeof e.usd === "number" && e.usd > 0) usd += e.usd;
  }
  return { raw, usd };
}

/**
 * How much a position's Lifetime figures change once each deposit of its
 * two coins counts where its coins went: the coins to add to its holding,
 * and the dollars to add to its Total Lifetime Deposit, each negative
 * where it counted more than its part.
 *
 * @param {object} deps  The poll's deps: `_botState`, and
 *   `_walletDepositStates`, without which nothing changes.
 * @param {object} residuals  From `walletResiduals`: `fraction0`,
 *   `fraction1`, the position's share of the wallet's balance of each
 *   coin.
 * @param {{decimals0: number, decimals1: number}} decimals
 * @returns {{amount0: number, amount1: number, usd: number}}
 */
function depositAttribution(deps, residuals, decimals) {
  const self = deps?._botState;
  if (typeof deps?._walletDepositStates !== "function") return _NONE;
  if (!isPlainObject(self?.lifetimeHodlAmounts)) return _NONE;
  const { holders, selfId } = holdersOf(deps._walletDepositStates(), self);
  const me = holders.find((h) => h.id === selfId);
  if (me === undefined) return _NONE;
  const now = _listedNow(self);
  const shares = [residuals?.fraction0, residuals?.fraction1];
  const delta = [0, 0];
  let usd = -now.usd;
  for (const i of [0, 1]) {
    const share = Number.isFinite(shares[i]) ? shares[i] : 0;
    const counted = countedFor(
      attributeCoin(holders, me.coins[i]),
      selfId,
      share,
    );
    delta[i] = counted.raw - now.raw[i];
    usd += counted.usd;
  }
  return {
    amount0: delta[0] / 10 ** decimals.decimals0,
    amount1: delta[1] / 10 ** decimals.decimals1,
    usd,
  };
}

/**
 * Total Lifetime Deposit as the Lifetime panel shows it: the saved total
 * of the position's deposit list, with what polls have counted since the
 * last move's count, which the saved total does not hold yet
 * (`pollDeposits`), and the change `depositAttribution` works out. Null
 * while no total is saved.
 *
 * @param {object} deps  The poll's deps; `_botState` holds the totals.
 * @param {{decimals0: number, decimals1: number}} decimals
 * @param {{usd: number}} shared  From `depositAttribution`.
 * @returns {{total: number, usedFallback: boolean}|null}
 */
function lifetimeDepositFigure(deps, decimals, shared) {
  const st = deps?._botState;
  if (!(st?.totalLifetimeDepositUsd > 0)) return null;
  const polled = pollDeposits(
    st.lifetimeHodlAmounts,
    st._depositOverlay,
    decimals.decimals0,
    decimals.decimals1,
  );
  return {
    total: st.totalLifetimeDepositUsd + polled.usd + shared.usd,
    usedFallback: st.depositUsedFallback || false,
  };
}

/**
 * The deposits one of a position's rebalances took into its new NFT, in
 * whole coins, or null when the position cannot see the running
 * positions' deposits.
 *
 * @param {object} botState  The position's bot state.
 * @param {object[]} events  Its rebalance events, as the caller holds them.
 * @param {number} block  The rebalance's mint block.
 * @param {{decimals0: number, decimals1: number}} decimals
 * @returns {{amount0: number, amount1: number}|null}
 */
function depositTakenAt(botState, events, block, decimals) {
  if (typeof botState?._walletDepositStates !== "function") return null;
  const { holders, selfId } = holdersOf(
    botState._walletDepositStates(),
    botState,
    events,
  );
  const me = holders.find((h) => h.id === selfId);
  if (me === undefined) return null;
  const raw = me.coins.map((coin) =>
    takenAt(attributeCoin(holders, coin), selfId, block),
  );
  return {
    amount0: raw[0] / 10 ** decimals.decimals0,
    amount1: raw[1] / 10 ** decimals.decimals1,
  };
}

module.exports = {
  depositAttribution,
  depositTakenAt,
  holdersOf,
  lifetimeDepositFigure,
  walletStates,
};
