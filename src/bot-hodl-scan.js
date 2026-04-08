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
    "[bot] Lifetime HODL: amount0=%s amount1=%s",
    hodl.amount0.toFixed(6),
    hodl.amount1.toFixed(6),
  );
  return hodl;
}

/** Compute total lifetime deposit USD from HODL deposit entries. */
async function computeDepositUsd(botState, updateState, position, opts) {
  const deposits = botState.lifetimeHodlAmounts?.deposits;
  if (!deposits?.length) return;
  const { _totalLifetimeDeposit } = require("./bot-pnl-updater");
  const { fetchHistoricalPriceGecko: _fhp } = require("./price-fetcher");
  const pFn = (block) =>
    _fhp("", Math.floor(Date.now() / 1000), "pulsechain", {
      token0Address: position.token0,
      token1Address: position.token1,
      blockNumber: block,
    });
  const dep = await _totalLifetimeDeposit(
    deposits,
    opts.decimals0,
    opts.decimals1,
    pFn,
  );
  if (dep <= 0) return;
  botState.totalLifetimeDepositUsd = dep;
  updateState({ totalLifetimeDepositUsd: dep });
}

module.exports = { computeAndCacheHodl, computeDepositUsd };
