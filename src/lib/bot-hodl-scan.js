/**
 * @file src/lib/bot-hodl-scan.js
 * @description Lifetime HODL scan helpers: compute and cache HODL amounts,
 * resolve total lifetime deposit USD from per-deposit historical prices,
 * and re-value the HODL baseline when Re-scan Prices asks for it. The
 * deposit count (src/lib/deposit-count.js) prices what it finds here too, and
 * writes the same cache record. Extracted from bot-recorder.js to stay
 * within the 500-line limit.
 */

"use strict";

const { log } = require("./log");
const ethers = require("ethers");
const config = require("./config");
const sendTx = require("./send-transaction");
const { getPoolState } = require("./rebalancer-pools");
const _epochCache = require("./epoch-cache");
const { _totalLifetimeDeposit } = require("./bot-pnl-updater");
const { _publishBaseline } = require("./hodl-baseline");
const { fetchHistoricalPriceGecko: _fhp } = require("./price-fetcher");
const {
  getBlockTimestamp,
  flushBlockTimeCache,
} = require("./block-time-cache");
const { emojiId } = require("./logger");
const { withLaterCounts } = require("./counted-deposits");

/**
 * Compute lifetime HODL amounts and persist fresh deposit cache.
 *
 * The scan's results replace the saved ones, with any deposits the
 * deposit count recorded while the scan ran put back
 * (`withLaterCounts`, src/lib/counted-deposits.js), and with how far that
 * count has read (`countedThrough`), which the next count starts from.
 */
async function computeAndCacheHodl(
  computeFn,
  allNftEvents,
  rebalanceEvents,
  position,
  opts,
  walletAddress,
  epochKey,
) {
  const prov = sendTx.getManagedReadProvider();
  const cachedFresh = epochKey
    ? _epochCache.getCachedFreshDeposits(epochKey)
    : null;
  const ps = await getPoolState(ethers, {
    factoryAddress: config.FACTORY,
    token0: position.token0,
    token1: position.token1,
    fee: position.fee,
  }).catch(() => ({}));
  /*-
   *  The compound list as saved now, rebuilt earlier in this pass when a
   *  rebuild ran: it names the compounds LP Ranger made, which paid from
   *  the wallet, so the tally need not read their receipts
   *  (src/lib/lifetime-hodl.js).
   */
  const compoundHistory =
    typeof opts.savedCompoundHistory === "function"
      ? opts.savedCompoundHistory()
      : undefined;
  const computed = await computeFn(allNftEvents, {
    rebalanceEvents,
    position: {
      ...position,
      decimals0: opts.decimals0,
      decimals1: opts.decimals1,
    },
    provider: prov,
    ethersLib: ethers,
    walletAddress,
    excludeFromAddrs: [config.POSITION_MANAGER, ps.poolAddress],
    wrappedNativeAddress: config.CHAIN.nativeWrappedToken,
    cachedFreshDeposits: cachedFresh,
    compoundHistory,
  });
  const hodl = epochKey
    ? withLaterCounts(
        computed,
        _epochCache.getCachedFreshDeposits(epochKey),
        opts.decimals0,
        opts.decimals1,
      )
    : computed;
  // Attach pool address BEFORE caching so deposit USD computation can read it
  // on subsequent bot restarts (it's needed to fetch historical prices from
  // GeckoTerminal; without it the historical lookup passes an empty pool and
  // silently falls back to current prices, skewing lifetime deposit USD).
  if (ps.poolAddress) hodl.poolAddress = ps.poolAddress;
  if (epochKey) {
    _epochCache.setCachedLifetimeHodl(epochKey, hodl);
    /*-
     *  Rewritten when the scan counted a mint it had not reached, or
     *  kept a count recorded while it ran, so the saved list is the one
     *  the scan's results hold.
     */
    const kept = hodl !== computed;
    if (kept || hodl.lastBlock > (cachedFresh?.lastBlock || 0))
      _epochCache.setCachedFreshDeposits(epochKey, freshDepositsOf(hodl));
  }
  const tokenIdStr = String(position.tokenId || "");
  log.info(
    "[bot] %s/%s NFT #%s %s: Lifetime HODL: amount0=%s amount1=%s pool=%s deposits=%d",
    position.token0Symbol || "Token0",
    position.token1Symbol || "Token1",
    tokenIdStr,
    emojiId(tokenIdStr),
    hodl.amount0.toFixed(6),
    hodl.amount1.toFixed(6),
    ps.poolAddress || "unknown",
    hodl.deposits?.length || 0,
  );
  return hodl;
}

/**
 * The fresh-deposit cache's record of a pool's Lifetime results: the
 * fresh totals, the newest mint whose deposits are counted, the deposit
 * list, and how far the deposit count has read. The Lifetime scan and
 * the deposit count both write it.
 *
 * @param {object} hodl  The pool's `lifetimeHodlAmounts`.
 * @returns {{raw0: string, raw1: string, lastBlock: number,
 *   deposits: object[], countedThrough?: number}}
 */
function freshDepositsOf(hodl) {
  const out = {
    raw0: hodl.raw0,
    raw1: hodl.raw1,
    lastBlock: hodl.lastBlock,
    deposits: hodl.deposits,
  };
  if (typeof hodl.countedThrough === "number")
    out.countedThrough = hodl.countedThrough;
  return out;
}

/**
 * Ensure the cached lifetime HODL entry has a pool address. Older cache
 * entries (written before the ordering fix in `computeAndCacheHodl`) lack it,
 * so we resolve it live via the factory and write it back to the cache so
 * subsequent restarts don't have to re-resolve.
 *
 * Without a pool address, `fetchHistoricalPriceGecko` silently fires with an
 * empty pool and returns 0, which then falls through to current-price
 * fallback — skewing lifetime deposit USD values.
 *
 * @param {object} botState  The bot's in-memory state.
 * @param {object} position  Position with token0/token1/fee.
 * @param {string|null} epochKey  Epoch cache key, or null if not cachable.
 * @param {object} ethers  ethers library.
 * @returns {Promise<string>} Resolved pool address ("" on failure).
 */
async function _ensureHodlPoolAddress(botState, position, epochKey, ethers) {
  const cached = botState.lifetimeHodlAmounts?.poolAddress;
  if (cached) return cached;
  try {
    const ps = await getPoolState(ethers, {
      factoryAddress: config.FACTORY,
      token0: position.token0,
      token1: position.token1,
      fee: position.fee,
    });
    if (!ps.poolAddress) return "";
    botState.lifetimeHodlAmounts.poolAddress = ps.poolAddress;
    if (epochKey)
      _epochCache.setCachedLifetimeHodl(epochKey, botState.lifetimeHodlAmounts);
    const tokenIdStr = String(position.tokenId || "");
    log.info(
      "[bot] %s/%s NFT #%s %s: Resolved lifetimeHodlAmounts.poolAddress → %s",
      position.token0Symbol || "Token0",
      position.token1Symbol || "Token1",
      tokenIdStr,
      emojiId(tokenIdStr),
      ps.poolAddress,
    );
    return ps.poolAddress;
  } catch (err) {
    const tokenIdStr = String(position.tokenId || "");
    log.warn(
      "[bot] %s/%s NFT #%s %s: Could not resolve pool address for lifetime deposit USD: %s",
      position.token0Symbol || "Token0",
      position.token1Symbol || "Token1",
      tokenIdStr,
      emojiId(tokenIdStr),
      err.message,
    );
    return "";
  }
}

/**
 * Value deposit entries, each at the historical price for its own block,
 * so their total is the money that went in, not what it would be worth
 * today. Each entry keeps the dollar figure it is given (`usd`), and one
 * already given a figure keeps it unless the caller re-values.
 *
 * The Lifetime deposit total prices its whole list this way
 * (`computeDepositUsd`), and so does the deposit count, for what a poll
 * finds between moves (src/lib/deposit-count.js).
 *
 * @param {object} botState   Per-position bot state; its
 *   `lifetimeHodlAmounts` holds the pool's address.
 * @param {object} position   Live position (token0, token1, fee).
 * @param {object[]} deposits  Entries `{raw0, raw1, block}`.
 * @param {object} opts       `decimals0`, `decimals1`, and
 *   `refreshPrices` when the caller is re-valuing at fresh prices.
 * @param {string|null} epochKey  Epoch cache key, or null.
 * @returns {Promise<{total: number, usedFallback: boolean}>}
 */
async function priceDepositEntries(
  botState,
  position,
  deposits,
  opts,
  epochKey,
) {
  const provider = sendTx.getManagedReadProvider();
  const poolAddr = await _ensureHodlPoolAddress(
    botState,
    position,
    epochKey,
    ethers,
  );
  const pFn = async (block) => {
    // Resolve the real block timestamp so date-bucketed APIs (GeckoTerminal
    // OHLCV) return the historical candle, not today's.
    /*-
     *  Keyed by the active chain: block numbers mean different moments
     *  on mainnet and on the testnet, so one cache scope for both would
     *  hand a testnet block a mainnet timestamp.
     */
    const blockTs = await getBlockTimestamp(provider, config.CHAIN_NAME, block);
    /*-
     *  Without the block's time there is no historical candle to ask for.
     *  Today's would be cached under this block's key, which never
     *  expires, and would price the deposit at today's rate unflagged; no
     *  price instead lets the deposit fall back to the current one,
     *  marked as such. The deposit keeps that figure on later passes;
     *  Re-scan Prices is what prices it again.
     */
    if (blockTs <= 0) {
      log.warn(
        "[deposit] no timestamp for block %d — not pricing it historically",
        block,
      );
      return { price0: 0, price1: 0 };
    }
    return _fhp(poolAddr, blockTs, {
      token0Address: position.token0,
      token1Address: position.token1,
      blockNumber: block,
      /*- Set by the Re-scan Prices path: read past the cached price so
       *  the total is built from a freshly fetched one. */
      refresh: opts.refreshPrices === true,
    });
  };
  const result = await _totalLifetimeDeposit(
    deposits,
    opts.decimals0,
    opts.decimals1,
    pFn,
    {
      token0: position.token0,
      token1: position.token1,
      /*- Each deposit keeps the dollar figure it was last given, so a
       *  re-value has to say it wants them priced again. */
      refresh: opts.refreshPrices === true,
    },
  );
  flushBlockTimeCache();
  return result;
}

/**
 * Compute total lifetime deposit USD from HODL deposit entries, each at
 * its own block's price (`priceDepositEntries`).
 *
 * The total is for the list standing when it is written. A deposit count
 * or a Lifetime scan can save a newer list while this one is priced
 * (src/lib/deposit-count.js), and a total for the older list would then put
 * back a figure that leaves out what the newer one added. So the newer
 * list is priced in turn. An entry already priced keeps its figure, so
 * only what is new is asked for.
 *
 * @param {object} botState   Per-position bot state.
 * @param {Function} updateState  State-update channel.
 * @param {object} position   Live position (token0, token1, fee).
 * @param {object} opts       Scan options; `decimals0`, `decimals1`, and
 *   `refreshPrices` when the caller is re-valuing at fresh prices.
 * @param {string|null} epochKey  Epoch cache key, or null.
 * @returns {Promise<void>}
 */
async function computeDepositUsd(
  botState,
  updateState,
  position,
  opts,
  epochKey,
) {
  let deposits = botState.lifetimeHodlAmounts?.deposits;
  if (!deposits?.length) return;
  let result = await priceDepositEntries(
    botState,
    position,
    deposits,
    opts,
    epochKey,
  );
  while (botState.lifetimeHodlAmounts?.deposits !== deposits) {
    deposits = botState.lifetimeHodlAmounts?.deposits;
    if (!deposits?.length) return;
    result = await priceDepositEntries(
      botState,
      position,
      deposits,
      { ...opts, refreshPrices: false },
      epochKey,
    );
  }
  if (result.total <= 0) return;
  botState.totalLifetimeDepositUsd = result.total;
  botState.depositUsedFallback = result.usedFallback;
  updateState({
    totalLifetimeDepositUsd: result.total,
    depositUsedFallback: result.usedFallback,
  });
}

/**
 * Re-value the saved HODL baseline at a freshly fetched historical price.
 *
 * The mint amounts and the mint date are what the chain recorded, so they
 * are kept. Only the price changes, and only when the lookup returns one:
 * a failed lookup leaves the saved figure as it was rather than replacing
 * it with zero.
 *
 * @param {object} botState   Per-position bot state.
 * @param {Function} updateState  State-update channel.
 * @param {object} position   Live position (token0, token1, fee).
 * @param {number|undefined} mintBlock  Block this NFT was minted in, for
 *   the block-scoped price lookup.
 * @param {string|null} epochKey  Epoch cache key, or null.
 * @returns {Promise<void>}
 */
async function revalueHodlBaseline(
  botState,
  updateState,
  position,
  mintBlock,
  epochKey,
) {
  const saved = botState?.hodlBaseline;
  if (saved === undefined || saved === null) return;
  /*- The mint's own moment is what the price is asked for, so without it
   *  there is nothing to re-value against. */
  if (typeof saved.mintTimestamp !== "number" || saved.mintTimestamp <= 0)
    return;
  /*- Both amounts come from the mint's own event, so a baseline without
   *  them is one no scan wrote. Re-pricing it would put NaN where a
   *  dollar figure belongs, in the Lifetime panel and in the value the
   *  IL Guard measures against. */
  const a0 = saved.hodlAmount0,
    a1 = saved.hodlAmount1;
  if (typeof a0 !== "number" || typeof a1 !== "number") return;
  const poolAddr = await _ensureHodlPoolAddress(
    botState,
    position,
    epochKey,
    ethers,
  );
  if (!poolAddr) return;
  const { price0, price1 } = await _fhp(poolAddr, saved.mintTimestamp, {
    token0Address: position.token0,
    token1Address: position.token1,
    blockNumber: mintBlock,
    refresh: true,
  });
  if (!(price0 > 0) && !(price1 > 0)) {
    log.warn(
      "[bot] %s/%s NFT #%s %s: no historical price at the mint, so the HODL baseline keeps its saved value",
      position.token0Symbol || "Token0",
      position.token1Symbol || "Token1",
      String(position.tokenId || ""),
      emojiId(String(position.tokenId || "")),
    );
    return;
  }
  _publishBaseline(
    {
      hodlAmount0: a0,
      hodlAmount1: a1,
      price0,
      price1,
      mintDate: saved.mintDate,
      mintTimestamp: saved.mintTimestamp,
      mintGasWei: saved.mintGasWei,
    },
    botState,
    updateState,
  );
}

module.exports = {
  computeAndCacheHodl,
  computeDepositUsd,
  freshDepositsOf,
  priceDepositEntries,
  revalueHodlBaseline,
  _ensureHodlPoolAddress,
};
