"use strict";

/**
 * @file src/compound-activity-figures.js
 * @module compound-activity-figures
 * @description
 * The figures a Compound entry in the Activity Log keeps on its record in
 * `compoundHistory` (app-data/position-records.json): the fee coins the
 * compound collected (`feesCollected`), and what share of the position
 * those fees were at the moment of the compound
 * (`historical.percentGainForPosition`). The dashboard shows the stored
 * share as Historical, and works out Current from the same fee coins at
 * today's prices against the position's value today
 * (`shareOfValuePct`, src/coin-value.js).
 *
 * **The share.** Within one NFT, at any one price, value is proportional
 * to liquidity. So the position's value right after a compound is the
 * deposit's value times the NFT's liquidity after the deposit, divided by
 * the liquidity the deposit added; and the fees' share of that position
 * is the fees' value times the liquidity added, divided by the deposit's
 * value times the liquidity after, all at the compound's prices. The fees
 * and the deposit are not the same coins: the deposit takes only what
 * fits the range, leaving the rest in the wallet, and a ratio swap can
 * sweep in coins that were already there. Using the fees keeps a deposit
 * the owner made, swept in by a compound, from counting as a gain.
 *
 * **When it is worked out.** A compound the bot makes records both
 * figures at once (`recordCompound`, src/bot-cycle-compound.js). A rebuild
 * of the compound list from the chain (`_classifyAllCompounds`,
 * src/bot-recorder-lifetime.js) works them out for each compound it finds
 * (`compoundHistoryFrom`): the collect is found among the NFT's events by
 * the shared rule (`collectBeforeDeposit`, src/nft-move-rules.js), the
 * NFT's liquidity before the deposit is the running total of its events,
 * and the prices are those at the deposit's block, through the
 * historical-price cache (`compoundPricesFor`): Moralis's for that block
 * when a key is saved, else GeckoTerminal's for that day. A deposit with
 * no collect before it is coins the owner added; it collected no fees, so
 * its share is 0.
 *
 * **Keeping what was recorded.** A rebuild replaces the whole list, but
 * an entry the bot recorded when the compound happened (trigger `auto` or
 * `manual`, `recordedCompounds`, src/compounded-coins.js) keeps its
 * trigger, its figures and the fees its deposit put back, matched by
 * transaction. So whether a compound was Auto or Manual stays recorded,
 * its figure stays the one taken at that moment, and no rebuild counts the
 * wallet's coins its deposit took in as fees. A figure the bot could not take,
 * because a price was missing then, is stored as unknown, which the
 * Activity Log shows as a dash; a rebuild works that one out from the
 * chain like any other, at the deposit's block, and keeps the trigger.
 * A compound found only on the chain gets trigger `unknown`, since the
 * chain does not say what started it.
 *
 * **Keeping what a lookup could not replace.** Every other entry is
 * written afresh: its figure worked out from the chain, its dollar
 * amount at the scan's prices. A price that does not come back, from a
 * lookup that fails or a service that has no price for the coin, cannot
 * give a new value, so the entry keeps the one it already had: a figure
 * an earlier rebuild worked out, and an amount, with the prices it was
 * worked out at. A failed lookup during Re-scan Prices therefore leaves
 * an entry as it was, rather than a dash where a figure stood.
 */

const {
  coinsToUsd,
  coinsFromUnits,
  isPositiveNumber,
  isCoinPair,
} = require("./coin-value");
const {
  collectBeforeDeposit,
  chainOrder,
  sameHex,
  isBefore,
} = require("./nft-move-rules");
const { isPlainObject } = require("./plain-object");
const { recordedCompounds } = require("./compounded-coins");
const { readBotConfigDefaults } = require("./bot-config-defaults");
const { fetchHistoricalPriceGecko } = require("./price-fetcher");
const { log } = require("./log");
const { emojiId } = require("./logger");

/** How finely a liquidity share is kept: ten decimal places. */
const SHARE_SCALE = 10n ** 10n;

/**
 * Liquidity added as a share of the NFT's liquidity after the deposit, a
 * number from 0 to 1, or null when either figure is not a whole number.
 * Worked out in whole-number arithmetic, since liquidity can exceed what
 * a JavaScript number holds exactly.
 */
function _shareOfLiquidity(added, before) {
  try {
    const a = BigInt(added);
    const b = BigInt(before);
    if (a <= 0n || b < 0n) return null;
    const scaled = (a * SHARE_SCALE) / (a + b);
    return Number(scaled) / Number(SHARE_SCALE);
  } catch {
    return null;
  }
}

/**
 * The fees' share of the position, as a percent: fees value × liquidity
 * added ÷ (deposit value × liquidity after), at one set of prices, the
 * two values worked out at `prices`. Null unless both prices are known:
 * without one coin's price, both values would count only the other coin,
 * and the share would come out as a figure rather than as unknown.
 * @returns {number|null}
 */
function _gainPct(feesUsd, depositUsd, prices, added, before) {
  if (!isPositiveNumber(prices?.price0) || !isPositiveNumber(prices?.price1))
    return null;
  const share = _shareOfLiquidity(added, before);
  if (share === null || !isPositiveNumber(depositUsd)) return null;
  if (typeof feesUsd !== "number" || !Number.isFinite(feesUsd)) return null;
  return (feesUsd / depositUsd) * share * 100;
}

/**
 * The figures a compound records the moment it succeeds: the fee coins
 * it collected, and their share of the position at the compound's
 * prices. Never throws: it runs inside the compound's bookkeeping, where
 * a throw would report a compound that happened as one that failed.
 *
 * @param {object} result  The compound's result: `feesCollected`,
 *   `collectedUsd` and `usdValue` at its prices `price0` and `price1`,
 *   and `liquidity`, the liquidity it added.
 * @param {object|undefined} position  The live position, whose
 *   `liquidity` is still the NFT's liquidity before the deposit: the bot
 *   reads it again only after the compound's bookkeeping.
 * @returns {{feesCollected: object|null,
 *   historical: {percentGainForPosition: number|null}}}
 */
function compoundFiguresAtCreation(result, position) {
  const fees = result?.feesCollected;
  const prices = { price0: result?.price0, price1: result?.price1 };
  const pct = _gainPct(
    result?.collectedUsd,
    result?.usdValue,
    prices,
    result?.liquidity,
    position?.liquidity,
  );
  return {
    feesCollected: isCoinPair(fees) ? fees : null,
    historical: { percentGainForPosition: pct },
  };
}

/**
 * The NFT's liquidity just before a deposit: everything its earlier
 * deposits added, less everything its earlier drains took out. The
 * deposit itself is set aside by its transaction.
 * @returns {bigint}
 */
function _liquidityBefore(nft, own) {
  const sum = (list) =>
    (Array.isArray(list) ? list : [])
      .filter((e) => !sameHex(e.txHash, own.txHash) && isBefore(e, own))
      .reduce((s, e) => s + BigInt(e.liquidity ?? 0), 0n);
  return sum(nft.ilEvents) - sum(nft.dlEvents);
}

/**
 * The two prices at a compound's deposit, or null when there are none to
 * be had: the lookup failed, or the caller gave no way to look. A rebuild
 * values every compound it finds inside the Lifetime scan, so a failed
 * lookup leaves that one compound's figure unknown, to be worked out
 * again by the next rebuild, rather than failing the scan.
 *
 * @param {object} compound  Its `timestamp`, `tokenId` and `txHash`.
 * @param {number|undefined} blockNumber  The deposit's block.
 * @param {object} opts  `compoundPrices`; the token symbols, for the log.
 * @returns {Promise<{price0: number, price1: number}|null>}
 */
async function _pricesAt(compound, blockNumber, opts) {
  if (typeof opts.compoundPrices !== "function") return null;
  try {
    return await opts.compoundPrices(compound.timestamp, blockNumber);
  } catch (err) {
    log.warn(
      "[bot] %s/%s NFT #%s %s: no prices for compound %s at block %s, so its Activity Log figure stays unknown: %s",
      opts.token0Symbol,
      opts.token1Symbol,
      String(compound.tokenId),
      emojiId(String(compound.tokenId)),
      compound.txHash,
      String(blockNumber),
      err.message,
    );
    return null;
  }
}

/**
 * A compound's figures worked out from the chain.
 *
 * @param {object} compound  As the rebuild found it: `txHash`,
 *   `timestamp`, `amount0Deposited`, `amount1Deposited`.
 * @param {object|undefined} nft  The NFT's events: `ilEvents`,
 *   `collectEvents`, `dlEvents`, each event with `blockNumber`, `txHash`,
 *   amounts and, for deposits and drains, `liquidity`.
 * @param {object} opts  `decimals0`, `decimals1`, and `compoundPrices`,
 *   which answers a timestamp and the deposit's block with the two prices
 *   then (`compoundPricesFor`); the token symbols, for the log.
 * @returns {Promise<{feesCollected: object|null, historical: object}>}
 *   A figure that cannot be worked out, for want of its prices or
 *   anything else, is null.
 */
async function compoundFiguresFromChain(compound, nft, opts) {
  const unknown = {
    feesCollected: null,
    historical: { percentGainForPosition: null },
  };
  if (!isPlainObject(nft)) return unknown;
  const own = (nft.ilEvents ?? []).find((e) =>
    sameHex(e.txHash, compound.txHash),
  );
  if (own === undefined) return unknown;
  const kinds = [
    ...(nft.collectEvents ?? []).map((e) => ({ ...e, kind: "collect" })),
    ...(nft.ilEvents ?? []).map((e) => ({ ...e, kind: "deposit" })),
  ].sort(chainOrder);
  // The collect rule looks back one log search's span of blocks.
  const span = readBotConfigDefaults().getLogsChunkSize;
  const collect = collectBeforeDeposit(kinds, own, span);
  const { decimals0: d0, decimals1: d1 } = opts;
  const fees =
    collect === null
      ? { amount0: 0, amount1: 0 }
      : coinsFromUnits(collect.amount0, collect.amount1, d0, d1);
  if (fees === null) return unknown;
  if (fees.amount0 === 0 && fees.amount1 === 0)
    return { feesCollected: fees, historical: { percentGainForPosition: 0 } };
  const prices = await _pricesAt(compound, own.blockNumber, opts);
  const deposit = coinsFromUnits(own.amount0, own.amount1, d0, d1);
  const feesUsd = coinsToUsd(fees, prices?.price0, prices?.price1);
  const depositUsd = coinsToUsd(deposit, prices?.price0, prices?.price1);
  const liquidityBefore = _liquidityBefore(nft, own);
  const pct = _gainPct(
    feesUsd,
    depositUsd,
    prices,
    own.liquidity,
    liquidityBefore,
  );
  return { feesCollected: fees, historical: { percentGainForPosition: pct } };
}

/** Whether a saved entry happened after the chain read began. */
function _afterRead(entry, readStartedAt) {
  const t = Date.parse(entry.timestamp);
  return Number.isFinite(t) && typeof readStartedAt === "number"
    ? t > readStartedAt
    : false;
}

/** The compound list as saved at this moment, from the caller's getter. */
function _savedList(opts) {
  const getSaved = opts.savedCompoundHistory;
  return typeof getSaved === "function" ? getSaved() : [];
}

/** A compound's transaction, lower-cased, or null when it has none. */
function _txKey(compound) {
  return typeof compound.txHash === "string"
    ? compound.txHash.toLowerCase()
    : null;
}

/** Every saved entry, whatever started it, by lower-cased transaction. */
function _byTransaction(saved) {
  const out = new Map();
  for (const e of Array.isArray(saved) ? saved : [])
    if (isPlainObject(e) && typeof e.txHash === "string")
      out.set(e.txHash.toLowerCase(), e);
  return out;
}

/** Whether a record holds a Historical figure that is a number. */
function _hasFigure(entry) {
  return Number.isFinite(entry?.historical?.percentGainForPosition);
}

/*-
 *  The figures worked out from the chain, unless their Historical came
 *  back unknown while the entry as saved holds one: a lookup that
 *  answered nothing is no reason to forget a figure an earlier one gave.
 *  The fee coins are the chain's, else the ones the entry holds.
 */
function _chainOrEarlier(chainFigures, earlier) {
  const historical =
    _hasFigure(chainFigures) || !_hasFigure(earlier)
      ? chainFigures.historical
      : earlier.historical;
  return {
    feesCollected: chainFigures.feesCollected ?? earlier?.feesCollected ?? null,
    historical,
  };
}

/*-
 *  A compound's dollar amount in the rebuilt list: the rebuild's own when
 *  the scan has both prices. Without one, the rebuild's amount counts
 *  only the other coin, so the entry as saved keeps its amount, and the
 *  prices it was worked out at, which mark it as at the compound's time.
 */
function _amountOf(compound, earlier, pricesKnown) {
  if (pricesKnown || !Number.isFinite(earlier?.usdValue))
    return { usdValue: compound.usdValue || 0 };
  const kept = { usdValue: earlier.usdValue };
  if (Number.isFinite(earlier.price0) && Number.isFinite(earlier.price1)) {
    kept.price0 = earlier.price0;
    kept.price1 = earlier.price1;
  }
  return kept;
}

/**
 * The fees a compound's deposit put back, and those it left in the
 * wallet, as the bot's record of it names them, for a rebuilt entry to
 * keep: the chain shows only the whole deposit (src/compounded-coins.js).
 * @param {object|undefined} saved  The bot's record of the compound.
 * @returns {{amount0Compounded?: string, amount1Compounded?: string,
 *   amount0FeesLeft?: string, amount1FeesLeft?: string}}
 */
function _feesKept(saved) {
  if (saved?.amount0Compounded === undefined) return {};
  if (saved.amount1Compounded === undefined) return {};
  const kept = {
    amount0Compounded: saved.amount0Compounded,
    amount1Compounded: saved.amount1Compounded,
  };
  if (
    saved.amount0FeesLeft !== undefined &&
    saved.amount1FeesLeft !== undefined
  ) {
    kept.amount0FeesLeft = saved.amount0FeesLeft;
    kept.amount1FeesLeft = saved.amount1FeesLeft;
  }
  return kept;
}

/**
 * A compound's entry in the rebuilt list: as the chain shows it, with the
 * trigger the bot recorded when it happened where it did, else trigger
 * `unknown`; the fees its deposit put back, where the bot recorded them;
 * and the figures the bot recorded, where it recorded a figure, else the
 * figures worked out from the chain. `chainFigures` is null only when the
 * bot's record held a figure, so none was worked out.
 */
function _entryOf(compound, saved, chainFigures, amount) {
  const figures =
    _hasFigure(saved) || chainFigures === null
      ? {
          feesCollected: saved?.feesCollected ?? null,
          historical: saved?.historical ?? { percentGainForPosition: null },
        }
      : chainFigures;
  return {
    timestamp: compound.timestamp || null,
    txHash: compound.txHash || null,
    tokenId: compound.tokenId,
    amount0Deposited: compound.amount0Deposited,
    amount1Deposited: compound.amount1Deposited,
    ..._feesKept(saved),
    ...amount,
    ...figures,
    trigger: saved === undefined ? "unknown" : saved.trigger,
  };
}

/**
 * The compound list a rebuild writes: every compound the chain shows,
 * each with its figures, keeping what the bot recorded live.
 *
 * The saved list is read twice. Before the figures are worked out, so
 * none is looked up for a compound the bot recorded with its figures;
 * and again once every figure is in, to carry what the list holds by
 * then. A Compound Now can run while this waits on a compound's prices, and
 * the caller writes what this returns with no wait in between, so the
 * second read is what keeps that compound.
 *
 * A compound's prices are asked for at its own deposit's block, so two
 * compounds on one day are two lookups, each cached under its block.
 *
 * @param {object[]} allCompounds  The compounds the rebuild found, each
 *   with its `tokenId` and its `usdValue` at the scan's prices.
 * @param {Map<string, object>} allNftEvents  Each NFT's events.
 * @param {object} opts  `decimals0`, `decimals1`, `compoundPrices`;
 *   `price0` and `price1`, the scan's prices, which each `usdValue` was
 *   worked out at; `savedCompoundHistory`, a getter for the list as saved
 *   at the moment it is asked; and `readStartedAt`, when the rebuild's
 *   chain read began, in milliseconds.
 * @returns {Promise<object[]>}  The list to save.
 */
async function compoundHistoryFrom(allCompounds, allNftEvents, opts) {
  const recordedBefore = recordedCompounds(_savedList(opts));
  const worked = [];
  for (const c of allCompounds) {
    const key = _txKey(c);
    const known = key === null ? undefined : recordedBefore.get(key);
    let figures = null;
    if (!_hasFigure(known)) {
      const nft = allNftEvents.get(String(c.tokenId));
      figures = await compoundFiguresFromChain(c, nft, opts);
    }
    worked.push({ c, key, figures });
  }
  const savedNow = _savedList(opts);
  const recorded = recordedCompounds(savedNow);
  const earlierByTx = _byTransaction(savedNow);
  const pricesKnown =
    isPositiveNumber(opts.price0) && isPositiveNumber(opts.price1);
  const out = [];
  for (const { c, key, figures } of worked) {
    const saved = key === null ? undefined : recorded.get(key);
    if (saved !== undefined) recorded.delete(key);
    const earlier = key === null ? undefined : earlierByTx.get(key);
    const chain = figures === null ? null : _chainOrEarlier(figures, earlier);
    out.push(_entryOf(c, saved, chain, _amountOf(c, earlier, pricesKnown)));
  }
  /*-
   *  A compound the bot recorded while this rebuild was reading the chain
   *  is not in what the rebuild read. Kept, it stays in the list; an
   *  older entry the chain does not show is dropped.
   */
  for (const e of recorded.values())
    if (_afterRead(e, opts.readStartedAt)) out.push(e);
  return out;
}

/**
 * The prices a rebuild values a compound at: those at its deposit's
 * block, through the price cache, which keeps them for good
 * (`fetchHistoricalPriceGecko`, src/price-fetcher.js). With a Moralis key
 * saved, Moralis prices each coin at that block; otherwise, or for a coin
 * Moralis has no price for, the pool's GeckoTerminal candle for that day
 * does, which is why the timestamp is asked for too.
 *
 * @param {object} position  The live position: its two tokens.
 * @param {object} botState  For the pool's address, if the cache lacks it.
 * @param {object|null} cachedHodl  The epoch cache's lifetime figures,
 *   which carry the pool's address.
 * @param {boolean} refresh  Read past the cache (Re-scan Prices).
 * @returns {(timestamp: string|null, blockNumber: number|undefined) =>
 *   Promise<{price0: number, price1: number}|null>}
 */
function compoundPricesFor(position, botState, cachedHodl, refresh) {
  const pool = cachedHodl?.poolAddress ?? botState?.poolAddress;
  return async (timestamp, blockNumber) => {
    const t = Date.parse(timestamp);
    if (!Number.isFinite(t)) return null;
    return fetchHistoricalPriceGecko(pool, Math.floor(t / 1000), {
      token0Address: position.token0,
      token1Address: position.token1,
      blockNumber,
      refresh: refresh === true,
    });
  };
}

module.exports = {
  compoundFiguresAtCreation,
  compoundFiguresFromChain,
  compoundHistoryFrom,
  compoundPricesFor,
};
