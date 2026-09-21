/**
 * @file src/bot-hodl-scan.js
 * @description Lifetime HODL scan helpers: compute and cache HODL amounts,
 * resolve total lifetime deposit USD from per-deposit historical prices,
 * and re-value the HODL baseline when Re-scan Prices asks for it.
 * Extracted from bot-recorder.js to stay within the 500-line limit.
 */

"use strict";

const { log } = require("./log");
const ethers = require("ethers");
const config = require("./config");
const sendTx = require("./send-transaction");
const { getPoolState } = require("./rebalancer");
const _epochCache = require("./epoch-cache");
const { _totalLifetimeDeposit } = require("./bot-pnl-updater");
const { _publishBaseline } = require("./hodl-baseline");
const { fetchHistoricalPriceGecko: _fhp } = require("./price-fetcher");
const {
  getBlockTimestamp,
  flushBlockTimeCache,
} = require("./block-time-cache");
const { emojiId } = require("./logger");

/** Compute lifetime HODL amounts and persist fresh deposit cache. */
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
  const ps = await getPoolState(prov, ethers, {
    factoryAddress: config.FACTORY,
    token0: position.token0,
    token1: position.token1,
    fee: position.fee,
  }).catch(() => ({}));
  const hodl = await computeFn(allNftEvents, {
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
  });
  // Attach pool address BEFORE caching so deposit USD computation can read it
  // on subsequent bot restarts (it's needed to fetch historical prices from
  // GeckoTerminal; without it the historical lookup passes an empty pool and
  // silently falls back to current prices, skewing lifetime deposit USD).
  if (ps.poolAddress) hodl.poolAddress = ps.poolAddress;
  if (epochKey) {
    _epochCache.setCachedLifetimeHodl(epochKey, hodl);
    if (hodl.lastBlock > (cachedFresh?.lastBlock || 0))
      _epochCache.setCachedFreshDeposits(epochKey, {
        raw0: hodl.raw0,
        raw1: hodl.raw1,
        lastBlock: hodl.lastBlock,
        deposits: hodl.deposits,
      });
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
 * @param {object} provider  ethers JsonRpcProvider.
 * @param {object} ethers  ethers library.
 * @returns {Promise<string>} Resolved pool address ("" on failure).
 */
async function _ensureHodlPoolAddress(
  botState,
  position,
  epochKey,
  provider,
  ethers,
) {
  const cached = botState.lifetimeHodlAmounts?.poolAddress;
  if (cached) return cached;
  try {
    const ps = await getPoolState(provider, ethers, {
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
 * Compute total lifetime deposit USD from HODL deposit entries.
 *
 * Each deposit is valued at the historical price for its own block, so
 * the total is the money that went in, not what it would be worth today.
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
  const deposits = botState.lifetimeHodlAmounts?.deposits;
  if (!deposits?.length) return;
  const provider = sendTx.getManagedReadProvider();
  const poolAddr = await _ensureHodlPoolAddress(
    botState,
    position,
    epochKey,
    provider,
    ethers,
  );
  const pFn = async (block) => {
    // Resolve the real block timestamp so date-bucketed APIs (GeckoTerminal
    // OHLCV) return the historical candle, not today's.
    const blockTs = await getBlockTimestamp(provider, "pulsechain", block);
    const ts = blockTs > 0 ? blockTs : Math.floor(Date.now() / 1000);
    return _fhp(poolAddr, ts, "pulsechain", {
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
  const provider = sendTx.getManagedReadProvider();
  const poolAddr = await _ensureHodlPoolAddress(
    botState,
    position,
    epochKey,
    provider,
    ethers,
  );
  if (!poolAddr) return;
  const { price0, price1 } = await _fhp(
    poolAddr,
    saved.mintTimestamp,
    "pulsechain",
    {
      token0Address: position.token0,
      token1Address: position.token1,
      blockNumber: mintBlock,
      refresh: true,
    },
  );
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
  revalueHodlBaseline,
  _ensureHodlPoolAddress,
};
