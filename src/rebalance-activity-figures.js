"use strict";

/**
 * @file src/rebalance-activity-figures.js
 * @module rebalance-activity-figures
 * @description
 * The figures a Rebalance entry in the Activity Log keeps on its event
 * record: the pool's two coins before the rebalance's swaps and after
 * them (`beforeRebalance`, `afterRebalance`), and the impermanent loss or
 * gain those swaps left, as a percent of the position, at the moment the
 * rebalance happened (`historical`). The dashboard shows that stored
 * percent as Historical, and works out Current from the same coins at
 * today's prices (`rebalanceIlPct`, src/coin-value.js).
 *
 * **What the coins are.** A rebalance mints with the wallet's whole
 * balance of the pool's two coins, so it reads that balance three times
 * as it goes: before the drain, after it, and just before the mint
 * (`walletReadings`, src/rebalancer-execute.js). The balance after the
 * drain is everything the rebalance had to work with, and the balance
 * before the mint is the same coins once the swaps are done. A deposit
 * the owner made since the last rebalance sits in both, though it was
 * never part of the position, so it is set aside: `beforeRebalance` is
 * the after-drain balance less the deposit, and `afterRebalance` is the
 * before-mint balance less the deposit's share of it. The swaps can trade
 * the deposit's coins along with the rest, and the two cannot be told
 * apart afterwards; taking the deposit out as its share of the value,
 * rather than as the coins it arrived as, never leaves a negative coin,
 * and leaves the deposit carrying its share of the swaps' cost. The
 * percent at the rebalance's own prices therefore does not depend on the
 * deposit at all, which is why the bot can store it the moment the
 * rebalance succeeds (`historicalAtCreation`).
 *
 * **Where the deposit comes from.** The Lifetime accounting already
 * counts deposits: for each mint, the coins that came into the wallet
 * from outside since the mint before it, kept in the epoch cache as
 * `lifetimeHodlAmounts.deposits` (src/lifetime-hodl.js). A rebalance's
 * are the deposits recorded after the old NFT's mint and up to the new
 * NFT's: the deposit count's entries, each at its own block
 * (src/deposit-count.js), and the one the Lifetime scan tags `fresh` at
 * the mint block for whatever arrived after the count's last read. They
 * are capped, coin by coin, at what the wallet held before the drain,
 * because a deposit a compound has since swept into the position is no
 * longer in the wallet; it came out with the old NFT's coins and belongs
 * to the rebalance. The accounting counts a mint's deposits in the scan
 * that follows the rebalance, so the four coin figures are finished then.
 *
 * **Finishing an entry.** A Rebalance event waiting for its figures
 * carries `figuresDue: true`: one the bot made, from the moment it
 * succeeds, and one the event scanner read fresh from the chain, after a
 * Reload or on a position's first scan (src/event-scanner.js). After the
 * Lifetime scan, `finishRebalanceFigures` works each one out:
 *
 * - its wallet readings come from the event itself, else from this
 *   install's rebalance log, else from the chain, read as of the blocks
 *   around the drain and the mint. The drain is found among the NFT
 *   events the pass has already read, by the shared rule
 *   (`drainBefore`, src/nft-move-rules.js);
 * - its prices come from the rebalance log, with the operator's price
 *   overrides applied as when the figure was first stored, else from
 *   the historical-price lookup at the new NFT's mint block, which the
 *   epoch rebuild has usually already cached;
 * - its deposit comes from the Lifetime accounting, as above.
 *
 * An event stays due while the deposits do not yet cover its mint, or
 * while it needs the chain and the pass read no NFT events. A price that
 * does not come back, a wallet reading that fails, or a drain that
 * cannot be found finishes the entry with those figures null, which the
 * dashboard shows as dashes, rather than asking again on every pass.
 * Reload Current Position reads every event again, so each is due once
 * more, and a Historical figure stored as a dash, on the event or in the
 * rebalance log, counts as missing: its prices are asked for again, and
 * a lookup that again answers nothing leaves the dash.
 */

const {
  coinsToUsd,
  coinsFromUnits,
  rebalanceIlPct,
  shareOfValuePct,
  isPositiveNumber,
  isCoinPair,
} = require("./coin-value");
const { drainBefore, sameHex } = require("./nft-move-rules");
const { applyPriceOverrides, pricesOrZero } = require("./price-overrides");
const { isPlainObject } = require("./plain-object");
const {
  isCountedEntry,
  countedCoinsAfter,
  nftMintBlock,
} = require("./counted-deposits");
const { mintBlocksByTokenId } = require("./nft-mint-blocks");

/**
 * The Historical figure a rebalance stores the moment it succeeds: the
 * impermanent loss or gain its swaps left, from the wallet's balance
 * after the drain to its balance before the mint, at the rebalance's own
 * prices. The deposit set aside later does not change it (see the file
 * header), so it is final from the start.
 *
 * @param {object|null|undefined} walletReadings  From the rebalance.
 * @param {{price0: number, price1: number}} prices  The rebalance's
 *   prices, the operator's overrides applied.
 * @returns {{impermanentLossGainPct: number|null}}
 */
function historicalAtCreation(walletReadings, prices) {
  return {
    impermanentLossGainPct: rebalanceIlPct(
      walletReadings?.afterDrain,
      walletReadings?.beforeMint,
      prices?.price0,
      prices?.price1,
    ),
  };
}

/**
 * The fields a successful rebalance carries into its records the moment
 * it succeeds: its Historical figure, priced as the panels price the
 * position (the prices fetched right after the mint, with the operator's
 * overrides applied), and the marker that leaves its four coin figures
 * for the scan that follows to finish. Never throws, since the caller
 * writes the rebalance log next.
 *
 * @param {object} result  The rebalance result, with `walletReadings`
 *   and the `token0UsdPrice`/`token1UsdPrice` it was enriched with.
 * @param {Function} [getConfig]  The position's settings, for the
 *   price overrides.
 * @returns {{historical: {impermanentLossGainPct: number|null},
 *   figuresDue: true}}
 */
function figuresAtCreation(result, getConfig) {
  const fetched = {
    price0: result?.token0UsdPrice,
    price1: result?.token1UsdPrice,
  };
  const prices = applyPriceOverrides(pricesOrZero(fetched), getConfig);
  return {
    historical: historicalAtCreation(result?.walletReadings, prices),
    figuresDue: true,
  };
}

/**
 * The Activity Log fields a rebalance result hands on to its event
 * record: its wallet readings, its Historical figure, and the marker
 * that its coin figures are still to be finished. The bot's own event
 * list and the pool's event cache both build their record of a new
 * rebalance with these, so the two agree. Empty for a result that
 * carries none.
 *
 * @param {object} result  A rebalance result, as `figuresAtCreation`
 *   left it.
 * @returns {object}  The fields to spread into the event record.
 */
function activityFieldsOf(result) {
  if (result?.figuresDue !== true) return {};
  return {
    walletReadings: result.walletReadings ?? null,
    historical: result.historical ?? null,
    figuresDue: true,
  };
}

/**
 * The deposit the Lifetime accounting counted for a mint, in whole coins,
 * or null when that accounting has not reached the mint yet: the deposit
 * count's entries after the old NFT's mint, up to this one, and the
 * Lifetime scan's own entry at this mint.
 *
 * @param {object|null|undefined} lifetimeHodl  The epoch cache's
 *   `lifetimeHodlAmounts`: `deposits` (each `{raw0, raw1, block, kind}`,
 *   with `txHash` when the deposit count recorded it) and `lastBlock`,
 *   the latest mint its deposits cover.
 * @param {number} mintBlock  The rebalance's mint block.
 * @param {number} decimals0  Token0's decimals.
 * @param {number} decimals1  Token1's decimals.
 * @param {number} [priorMintBlock]  The old NFT's mint block. The count's
 *   entries before it were swept into an earlier mint.
 * @returns {{amount0: number, amount1: number}|null}  Zero coins when the
 *   mint took in no deposit.
 */
function cachedDepositFor(
  lifetimeHodl,
  mintBlock,
  decimals0,
  decimals1,
  priorMintBlock = 0,
) {
  if (!isPlainObject(lifetimeHodl)) return null;
  const covered = lifetimeHodl.lastBlock;
  if (typeof covered !== "number" || covered < mintBlock) return null;
  const all = Array.isArray(lifetimeHodl.deposits) ? lifetimeHodl.deposits : [];
  const atMint = all.filter(
    (d) => isPlainObject(d) && !isCountedEntry(d) && d.block === mintBlock,
  );
  /*-
   *  A deposit counted before entries carried a kind has none. The first
   *  one counted for a block is the mint's own, since the deposits added
   *  to an NFT later are counted after it.
   */
  const fresh =
    atMint.find((d) => d.kind === "fresh") ??
    atMint.find((d) => d.kind === undefined);
  const zero = { amount0: 0, amount1: 0 };
  const lump =
    fresh === undefined
      ? zero
      : (coinsFromUnits(fresh.raw0, fresh.raw1, decimals0, decimals1) ?? zero);
  const counted = countedCoinsAfter(
    lifetimeHodl,
    null,
    priorMintBlock,
    decimals0,
    decimals1,
    mintBlock,
  );
  return {
    amount0: lump.amount0 + counted.amount0,
    amount1: lump.amount1 + counted.amount1,
  };
}

/**
 * The figures this install's rebalance log holds, by new NFT, for one
 * chain, position manager and wallet. Entries for another scope, entries
 * the test suite wrote (another wallet), and anything that is not an
 * entry are skipped, so a damaged log costs only its damaged entries.
 *
 * Each also says what started the rebalance (`trigger`), which a rebuild
 * of the event list from the chain cannot know: the finished record takes
 * it back, so its Activity Log entry names it again.
 *
 * @param {Array} entries  The log, as `readLog` returns it.
 * @param {{chain: string, contract: string, wallet: string}} scope
 * @returns {Map<string, {walletReadings: object|null,
 *   historical: object|null, prices: {price0: number, price1: number},
 *   trigger: string|null}>}
 */
function loggedRebalanceFigures(entries, scope) {
  const out = new Map();
  if (!Array.isArray(entries)) return out;
  for (const e of entries) {
    if (!isPlainObject(e) || e.chain !== scope.chain) continue;
    if (
      !sameHex(e.contract, scope.contract) ||
      !sameHex(e.wallet, scope.wallet)
    )
      continue;
    if (e.newTokenId === undefined || e.newTokenId === null) continue;
    out.set(String(e.newTokenId), {
      walletReadings: isPlainObject(e.walletReadings) ? e.walletReadings : null,
      historical: isPlainObject(e.historical) ? e.historical : null,
      prices: { price0: e.token0UsdPrice, price1: e.token1UsdPrice },
      trigger: typeof e.trigger === "string" ? e.trigger : null,
    });
  }
  return out;
}

/**
 * The four coin figures, from the wallet readings, the deposit and the
 * rebalance's prices.
 *
 * @param {object} readings  `beforeDrain`, `afterDrain`, `beforeMint`.
 * @param {{amount0: number, amount1: number}} deposit  The Lifetime
 *   accounting's deposit at this mint.
 * @param {{price0: number, price1: number}|null} prices
 * @returns {{beforeRebalance: object, afterRebalance: object}|null}  Null
 *   when a reading is missing, or when a deposit must be set aside and
 *   the prices to value its share are missing.
 */
function fourNumbers(readings, deposit, prices) {
  const { beforeDrain, afterDrain, beforeMint } = readings ?? {};
  const read = [beforeDrain, afterDrain, beforeMint];
  if (!read.every(isCoinPair)) return null;
  const set0 = Math.min(deposit.amount0, beforeDrain.amount0);
  const set1 = Math.min(deposit.amount1, beforeDrain.amount1);
  const before = {
    amount0: Math.max(0, afterDrain.amount0 - set0),
    amount1: Math.max(0, afterDrain.amount1 - set1),
  };
  if (set0 <= 0 && set1 <= 0)
    return { beforeRebalance: before, afterRebalance: { ...beforeMint } };
  /*-
   *  The rebalance's share of everything after the drain, by value: the
   *  rest is the deposit's, and so is the same share of each coin after
   *  the swaps.
   */
  const whole = coinsToUsd(afterDrain, prices?.price0, prices?.price1);
  const sharePct = shareOfValuePct(
    before,
    prices?.price0,
    prices?.price1,
    whole,
  );
  if (sharePct === null) return null;
  const share = sharePct / 100;
  return {
    beforeRebalance: before,
    afterRebalance: {
      amount0: beforeMint.amount0 * share,
      amount1: beforeMint.amount1 * share,
    },
  };
}

/**
 * The wallet readings of a rebalance rebuilt from the chain: the
 * wallet's balance at the end of the block before its drain, at the end
 * of the drain's block, and at the end of the block before its mint.
 * LP Ranger waits for each transaction of a rebalance to be mined before
 * sending the next, so those blocks fall between its steps.
 *
 * @returns {Promise<{due: boolean, readings?: object|null}>}  `due` when
 *   the pass read no NFT events to find the drain in.
 */
async function _chainReadings(ev, ctx) {
  const nftEvents = await ctx.readNftEvents();
  const old = nftEvents?.get(String(ev.oldTokenId));
  if (old === undefined || old === null) return { due: true };
  const drain = drainBefore(old.dlEvents, ev.blockNumber);
  if (drain === null) return { due: false, readings: null };
  try {
    const [beforeDrain, afterDrain, beforeMint] = await Promise.all([
      ctx.readBalances(drain.blockNumber - 1),
      ctx.readBalances(drain.blockNumber),
      ctx.readBalances(ev.blockNumber - 1),
    ]);
    return { due: false, readings: { beforeDrain, afterDrain, beforeMint } };
  } catch (err) {
    ctx.onReadFailure?.(ev, err);
    return { due: false, readings: null };
  }
}

/**
 * The rebalance's prices: the ones its log entry recorded, with the
 * operator's overrides applied as when its Historical figure was first
 * stored, else the historical price at its mint block.
 */
async function _pricesFor(ev, logged, ctx) {
  if (logged !== undefined) {
    const used = applyPriceOverrides(
      pricesOrZero(logged.prices),
      ctx.getConfig,
    );
    if (isPositiveNumber(used.price0) && isPositiveNumber(used.price1))
      return used;
  }
  return ctx.historicalPrices(ev);
}

/**
 * An event record with finished figures put in and its due marker taken
 * away. The bot's own event list and the pool's event cache each keep a
 * record of every rebalance, so both take a finished entry's figures
 * through this.
 *
 * @param {object} entry  The record to finish.
 * @param {object} figures  `walletReadings`, `beforeRebalance`,
 *   `afterRebalance` and `historical`, each null when unknown; and
 *   `trigger`, what started the rebalance, put in when it is known.
 * @returns {object}  A new record; `entry` is left as it was.
 */
function withFinishedFigures(entry, figures) {
  const merged = {
    ...entry,
    walletReadings: figures.walletReadings ?? null,
    beforeRebalance: figures.beforeRebalance ?? null,
    afterRebalance: figures.afterRebalance ?? null,
    historical: figures.historical ?? null,
  };
  if (typeof figures.trigger === "string") merged.trigger = figures.trigger;
  delete merged.figuresDue;
  return merged;
}

/**
 * Whether a deposit has to be set aside from these readings: whether any
 * of it was still in the wallet before the drain.
 */
function _setsAside(readings, deposit) {
  const bd = readings?.beforeDrain;
  if (!isCoinPair(bd)) return false;
  return (
    Math.min(deposit.amount0, bd.amount0) > 0 ||
    Math.min(deposit.amount1, bd.amount1) > 0
  );
}

/**
 * What started a rebalance: as its own record says, else as this
 * install's log does, for an event a rebuild read from the chain.
 * @returns {string|null|undefined}
 */
function _triggerOf(ev, logged) {
  return ev.trigger ?? logged?.trigger;
}

/**
 * The old NFT's mint block: the chain's record of it, else the latest
 * mint the chain records before this rebalance's, else none. The
 * deposit count records a deposit after the mint of the NFT held when
 * it counts, so a later block bounds the rebalance's deposits.
 */
function _priorMintOf(ev, chainEvents) {
  const named = nftMintBlock(ev.oldTokenId, chainEvents);
  if (named !== null) return named;
  let latest = 0;
  for (const block of mintBlocksByTokenId(chainEvents).values())
    if (block < ev.blockNumber && block > latest) latest = block;
  return latest;
}

/**
 * A stored Historical figure, or null when what is stored is a dash: a
 * price was missing when it was worked out, so it is worked out again.
 */
function _withFigure(historical) {
  return Number.isFinite(historical?.impermanentLossGainPct)
    ? historical
    : null;
}

/**
 * Work out one due event's figures, or answer null to leave it due.
 * Prices are asked for only when they are needed: to value a deposit's
 * share, or for an entry with no stored Historical figure.
 * @returns {Promise<object|null>}  The finished event record.
 */
async function _finishOne(ev, ctx) {
  const deposit = cachedDepositFor(
    ctx.lifetimeHodl,
    ev.blockNumber,
    ctx.decimals0,
    ctx.decimals1,
    _priorMintOf(ev, ctx.chainEvents),
  );
  if (deposit === null) return null;
  const logged = ctx.logged.get(String(ev.newTokenId));
  let readings = ev.walletReadings ?? logged?.walletReadings ?? null;
  if (readings === null) {
    const read = await _chainReadings(ev, ctx);
    if (read.due) return null;
    readings = read.readings;
  }
  const stored =
    _withFigure(ev.historical) ?? _withFigure(logged?.historical) ?? null;
  const needPrices = stored === null || _setsAside(readings, deposit);
  const prices = needPrices ? await _pricesFor(ev, logged, ctx) : null;
  const four =
    readings === null ? null : fourNumbers(readings, deposit, prices);
  const historical = stored ?? historicalAtCreation(readings, prices);
  return withFinishedFigures(ev, {
    walletReadings: readings,
    beforeRebalance: four === null ? null : four.beforeRebalance,
    afterRebalance: four === null ? null : four.afterRebalance,
    historical,
    trigger: _triggerOf(ev, logged),
  });
}

/**
 * Finish the Rebalance events still waiting for their figures.
 *
 * @param {object[]} events  The position's rebalance events.
 * @param {object} ctx
 * @param {number} ctx.decimals0  Token0's decimals.
 * @param {number} ctx.decimals1  Token1's decimals.
 * @param {object|null} ctx.lifetimeHodl  The epoch cache's
 *   `lifetimeHodlAmounts` for the pool.
 * @param {object[]} [ctx.chainEvents]  The whole chain's rebalance
 *   events, which name each old NFT's mint.
 * @param {Map} ctx.logged  From `loggedRebalanceFigures`.
 * @param {() => Promise<Map|null>} ctx.readNftEvents  The pass's NFT
 *   events by tokenId, or null when the pass read none.
 * @param {(block: number) => Promise<{amount0: number, amount1: number}>}
 *   ctx.readBalances  The wallet's two coins at the end of a block.
 * @param {(ev: object) => Promise<{price0: number, price1: number}>}
 *   ctx.historicalPrices  The two coins' prices at an event's mint.
 * @param {Function} [ctx.getConfig]  The position's settings, for the
 *   price overrides.
 * @param {Function} [ctx.onReadFailure]  Told of each failed reading.
 * @param {Function} [ctx.onFinishFailure]  Told of each event a failure
 *   left due, such as a price lookup that threw.
 * @returns {Promise<Map<string, object>>}  Finished records by
 *   transaction hash; an event left out stays due.
 */
async function finishRebalanceFigures(events, ctx) {
  const finished = new Map();
  for (const ev of Array.isArray(events) ? events : []) {
    if (!isPlainObject(ev) || ev.figuresDue !== true) continue;
    /*-
     *  Each event on its own, so one whose working out throws stays due
     *  for the next pass without holding back the others.
     */
    try {
      const done = await _finishOne(ev, ctx);
      if (done !== null) finished.set(ev.txHash, done);
    } catch (err) {
      ctx.onFinishFailure?.(ev, err);
    }
  }
  return finished;
}

/**
 * Whether a scan pass may need the chain's NFT events for these Rebalance
 * events' figures: whether one is waiting for its figures with no wallet
 * readings of its own. Its readings may be in the rebalance log; if not,
 * its drain is found in the old NFT's events, and the wallet is read
 * around it (`_chainReadings`). A pass whose Lifetime figures are all
 * saved reads no NFT events, so without this answer an event left waiting
 * by a stop during an earlier pass would wait until a rebalance, Re-scan
 * Prices or Reload Current Position made a pass read them.
 *
 * @param {object[]} events  The position's rebalance events.
 * @returns {boolean}
 */
function figuresNeedNftEvents(events) {
  if (!Array.isArray(events)) return false;
  return events.some(
    (e) =>
      isPlainObject(e) &&
      e.figuresDue === true &&
      !isPlainObject(e.walletReadings),
  );
}

module.exports = {
  historicalAtCreation,
  figuresAtCreation,
  activityFieldsOf,
  withFinishedFigures,
  cachedDepositFor,
  loggedRebalanceFigures,
  fourNumbers,
  finishRebalanceFigures,
  figuresNeedNftEvents,
};
