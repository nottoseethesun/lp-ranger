/**
 * @file src/bot-hodl-scan.js
 * @description Lifetime HODL scan helpers: compute and cache HODL amounts,
 * resolve total lifetime deposit USD from per-deposit historical prices.
 * Extracted from bot-recorder.js to stay within the 500-line limit.
 */

"use strict";

const config = require("./config");
const { getPoolState } = require("./rebalancer");
const _epochCache = require("./epoch-cache");

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
  const ethers = require("ethers");
  const prov = new ethers.JsonRpcProvider(config.RPC_URL);
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
  console.log(
    "[bot] Lifetime HODL: amount0=%s amount1=%s pool=%s",
    hodl.amount0.toFixed(6),
    hodl.amount1.toFixed(6),
    ps.poolAddress || "unknown",
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
    console.log(
      "[bot] Backfilled lifetimeHodlAmounts.poolAddress for %s → %s",
      epochKey || "(no key)",
      ps.poolAddress,
    );
    return ps.poolAddress;
  } catch (err) {
    console.warn(
      "[bot] Could not resolve pool address for lifetime deposit USD: %s",
      err.message,
    );
    return "";
  }
}

/** Compute total lifetime deposit USD from HODL deposit entries. */
async function computeDepositUsd(
  botState,
  updateState,
  position,
  opts,
  epochKey,
) {
  const deposits = botState.lifetimeHodlAmounts?.deposits;
  if (!deposits?.length) return;
  const { _totalLifetimeDeposit } = require("./bot-pnl-updater");
  const { fetchHistoricalPriceGecko: _fhp } = require("./price-fetcher");
  const {
    getBlockTimestamp,
    flushBlockTimeCache,
  } = require("./block-time-cache");
  const ethers = require("ethers");
  const provider = new ethers.JsonRpcProvider(config.RPC_URL);
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
    });
  };
  const result = await _totalLifetimeDeposit(
    deposits,
    opts.decimals0,
    opts.decimals1,
    pFn,
    { token0: position.token0, token1: position.token1 },
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

module.exports = {
  computeAndCacheHodl,
  computeDepositUsd,
  _ensureHodlPoolAddress,
};
