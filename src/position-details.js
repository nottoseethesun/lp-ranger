/**
 * @file position-details.js
 * @description Phase 2 (slow) lifetime P&L computation for unmanaged positions.
 *   Runs event scan + epoch reconstruction for historical data.
 *   Phase 1 (fast) details are in position-details-quick.js.
 */

"use strict";

const config = require("./config");
const { getPoolState } = require("./rebalancer");
const { positionValueUsd, fetchTokenPrices } = require("./bot-pnl-updater");
const { reconstructEpochs } = require("./epoch-reconstructor");
const { createPnlTracker } = require("./pnl-tracker");
const {
  getCachedEpochs,
  setCachedEpochs,
  getCachedLifetimeHodl,
  setCachedLifetimeHodl,
  getCachedFreshDeposits,
  setCachedFreshDeposits,
} = require("./epoch-cache");
const { scanPoolHistory } = require("./pool-scanner");
const {
  compositeKey,
  getPositionConfig,
  saveConfig,
} = require("./bot-config-v2");
const {
  _currentPnl,
  _applyPriceOverrides,
  _walletResiduals,
} = require("./position-details-quick");

/** Detect compounds across all NFTs in the rebalance chain and cache result. */
async function _scanCompounds(
  position,
  events,
  body,
  ps,
  prices,
  diskConfig,
  posKey,
) {
  try {
    const { detectCompoundsOnChain } = require("./compounder");
    const ids = new Set([String(position.tokenId)]);
    for (const e of events) {
      if (e.oldTokenId) ids.add(String(e.oldTokenId));
      if (e.newTokenId) ids.add(String(e.newTokenId));
    }
    const opts = {
      positionManagerAddress: config.POSITION_MANAGER,
      token0: position.token0,
      token1: position.token1,
      fee: position.fee,
      walletAddress: body.walletAddress,
      price0: prices.price0,
      price1: prices.price1,
      decimals0: ps.decimals0,
      decimals1: ps.decimals1,
    };
    let total = 0;
    for (const tid of ids)
      total += (await detectCompoundsOnChain(tid, opts)).totalCompoundedUsd;
    if (total > 0) {
      getPositionConfig(diskConfig, posKey).totalCompoundedUsd = total;
      saveConfig(diskConfig);
    }
    return total;
  } catch (e) {
    console.warn("[details] compound detection failed:", e.message);
    return 0;
  }
}

/** Load or fetch + cache the HODL baseline for a position. */
/** Run event scan + epoch reconstruction. Reads from disk cache if available. */
async function _getLifetimeSnapshot(
  provider,
  ethersLib,
  position,
  walletAddr,
  diskConfig,
  posKey,
  prices,
  deposit,
  poolAddress,
) {
  const poolCacheKey = position.token0
    ? {
        contract: config.POSITION_MANAGER,
        wallet: walletAddr,
        token0: position.token0,
        token1: position.token1,
        fee: position.fee,
      }
    : null;
  const cached = poolCacheKey ? getCachedEpochs(poolCacheKey) : null;
  const tracker = createPnlTracker({ initialDeposit: deposit || 0 });
  if (cached) tracker.restore(cached);
  console.log(
    "[details] epoch cache: key=%s cached=%d restored=%d t0=%s",
    !!poolCacheKey,
    cached?.closedEpochs?.length || 0,
    tracker.epochCount(),
    position.token0?.slice(0, 8) || "MISSING",
  );
  const events = await scanPoolHistory(provider, ethersLib, {
    walletAddress: walletAddr,
    position,
    poolAddress: poolAddress || null,
    computeFromHistoricalPrices: async (evts) => {
      if (tracker.epochCount() > 0 || evts.length === 0) return;
      // Re-check epoch cache — another concurrent scan may have populated
      // it while we waited for the pool scan lock.  Without this guard,
      // two dashboard detail fetches reconstruct all 71 epochs in parallel,
      // doubling GeckoTerminal price requests and rate-limit delays.
      const freshCache = poolCacheKey ? getCachedEpochs(poolCacheKey) : null;
      if (freshCache) {
        tracker.restore(freshCache);
        return;
      }
      await reconstructEpochs({
        pnlTracker: tracker,
        rebalanceEvents: evts,
        botState: {
          activePosition: position,
          walletAddress: walletAddr,
          positionManager: config.POSITION_MANAGER,
        },
        fallbackPrices: prices,
      });
      if (poolCacheKey) setCachedEpochs(poolCacheKey, tracker.serialize());
    },
  });
  return { tracker, events };
}

/** Extract lifetime data from a tracker snapshot (or fall back to current-epoch data). */
function _extractSnap(snap, cur, feesUsd) {
  const ltFees = snap ? snap.totalFees + feesUsd : feesUsd;
  const ltGas = snap ? snap.totalGas : 0;
  const ltPc = snap ? snap.priceChangePnl : cur.priceGainLoss;
  const il = snap?.lifetimeIL ?? snap?.totalIL ?? cur.il;
  return {
    ltFees,
    ltGas,
    ltPc,
    il,
    firstEpochDate: snap?.firstEpochDateUtc || null,
    rebalanceCount: snap?.closedEpochs?.length || 0,
  };
}

/** Compute lifetime P&L from tracker snapshot. */
function _lifetimePnl(tracker, ps, entryValue, cur, feesUsd, currentValue) {
  const snap = tracker.epochCount() > 0 ? tracker.snapshot(ps.price) : null;
  const s = _extractSnap(snap, cur, feesUsd);
  // Price change = current position value − initial deposit.
  // NOT the epoch-chain cumulative (which leaks value through residuals).
  const ltPc = entryValue > 0 ? currentValue - entryValue : s.ltPc || 0;
  return {
    ltNetPnl: entryValue > 0 ? ltPc + s.ltFees - s.ltGas : null,
    ltFees: s.ltFees,
    ltGas: s.ltGas,
    ltPriceChange: ltPc,
    ltProfit:
      s.il !== null && s.il !== undefined
        ? s.ltFees - s.ltGas + s.il
        : cur.profit,
    firstEpochDate: s.firstEpochDate,
    rebalanceCount: s.rebalanceCount,
  };
}

/** Resolve entry value from disk config for phase 2 (no chain baseline fetch). */
function _resolveEntryValueCached(diskConfig, posKey) {
  const deposit = diskConfig.positions[posKey]?.initialDepositUsd || 0;
  const bl = diskConfig.positions[posKey]?.hodlBaseline || null;
  const ev = deposit > 0 ? deposit : bl?.entryValue || 0;
  return { baseline: bl, entryValue: ev };
}

/** Phase 2: slow data (event scan + epoch reconstruction → lifetime P&L). */
/** Build a single-day fallback when no historical epochs exist. */
function _buildDailyFallback(snap, entryValue, value, body) {
  if (snap?.dailyPnl) return snap.dailyPnl;
  if (entryValue <= 0) return null;
  return [
    {
      date: new Date().toISOString().slice(0, 10),
      feePnl: body.feesUsd || 0,
      gasCost: 0,
      priceChangePnl: value - entryValue,
    },
  ];
}

/** Resolve compounded USD from disk cache or chain scan. */
async function _resolveCompounded(
  position,
  events,
  body,
  ps,
  prices,
  diskConfig,
  posKey,
) {
  const posConfig = diskConfig.positions[posKey] || {};
  if (posConfig.totalCompoundedUsd) return posConfig.totalCompoundedUsd;
  if (events.length === 0) return 0;
  return _scanCompounds(position, events, body, ps, prices, diskConfig, posKey);
}

/** Compute lifetime IL using accumulated HODL amounts across rebalance chain. */
async function _computeLifetimeIL(
  position,
  events,
  body,
  lpValue,
  price0,
  price1,
  poolAddress,
) {
  const poolCacheKey = _poolCacheKey(position);
  const cached = poolCacheKey ? getCachedLifetimeHodl(poolCacheKey) : null;
  let hodl = cached;
  if (!hodl) {
    try {
      const { scanNftEvents } = require("./compounder");
      const { computeLifetimeHodl } = require("./lifetime-hodl");
      const ids = new Set([String(body.tokenId)]);
      for (const ev of events || []) {
        if (ev.oldTokenId) ids.add(String(ev.oldTokenId));
        if (ev.newTokenId) ids.add(String(ev.newTokenId));
      }
      const allNftEvents = new Map();
      for (const tid of ids) {
        allNftEvents.set(tid, await scanNftEvents(tid));
      }
      const ethers = require("ethers");
      const prov = new ethers.JsonRpcProvider(config.RPC_URL);
      const cachedFresh = poolCacheKey
        ? getCachedFreshDeposits(poolCacheKey)
        : null;
      hodl = await computeLifetimeHodl(allNftEvents, {
        rebalanceEvents: events,
        position,
        provider: prov,
        ethersLib: ethers,
        walletAddress: body.walletAddress,
        excludeFromAddrs: [config.POSITION_MANAGER, poolAddress],
        cachedFreshDeposits: cachedFresh,
      });
      if (poolCacheKey) {
        setCachedLifetimeHodl(poolCacheKey, hodl);
        if (hodl.lastBlock > (cachedFresh?.lastBlock || 0)) {
          setCachedFreshDeposits(poolCacheKey, {
            raw0: hodl.raw0,
            raw1: hodl.raw1,
            lastBlock: hodl.lastBlock,
            deposits: hodl.deposits,
          });
        }
      }
    } catch (err) {
      console.warn("[details] Lifetime HODL error:", err.message);
      return null;
    }
  }
  if (!hodl || (hodl.amount0 <= 0 && hodl.amount1 <= 0)) return null;
  const { computeHodlIL } = require("./il-calculator");
  return computeHodlIL({
    lpValue,
    hodlAmount0: hodl.amount0,
    hodlAmount1: hodl.amount1,
    currentPrice0: price0,
    currentPrice1: price1,
  });
}

/** Pick the IL value closer to zero (from the larger HODL). */
function _pickSmaller(a, b) {
  if (a === null || a === undefined) return b;
  if (b === null || b === undefined) return a;
  return Math.abs(a) < Math.abs(b) ? a : b;
}

/** Compute total lifetime deposit USD from cached fresh deposit entries. */
async function _computeDepositUsd(position, ps) {
  const poolCK = _poolCacheKey(position);
  const deps = (poolCK ? getCachedFreshDeposits(poolCK) : null)?.deposits;
  if (!deps?.length) return 0;
  const { _totalLifetimeDeposit } = require("./bot-pnl-updater");
  const { fetchHistoricalPriceGecko } = require("./price-fetcher");
  return _totalLifetimeDeposit(deps, ps.decimals0, ps.decimals1, (block) =>
    fetchHistoricalPriceGecko("", Math.floor(Date.now() / 1000), "pulsechain", {
      token0Address: position.token0,
      token1Address: position.token1,
      blockNumber: block,
    }),
  );
}

/** Build pool cache key from position data. */
function _poolCacheKey(pos) {
  if (!pos.token0 || !pos.fee) return null;
  return {
    contract: config.POSITION_MANAGER,
    wallet: pos.walletAddress || "",
    token0: pos.token0,
    token1: pos.token1,
    fee: pos.fee,
  };
}

async function computeLifetimeDetails(provider, ethersLib, body, diskConfig) {
  const position = {
    tokenId: body.tokenId,
    token0: body.token0,
    token1: body.token1,
    fee: body.fee,
    tickLower: body.tickLower,
    tickUpper: body.tickUpper,
    liquidity: body.liquidity,
  };
  const _ltT0 = Date.now();
  console.log("[details] Computing lifetime P&L for #%s\u2026", body.tokenId);
  const posKey = compositeKey(
    "pulsechain",
    body.walletAddress || "",
    body.contractAddress || config.POSITION_MANAGER,
    body.tokenId,
  );
  const ps = await getPoolState(provider, ethersLib, {
    factoryAddress: config.FACTORY,
    token0: body.token0,
    token1: body.token1,
    fee: body.fee,
  });
  const prices = await fetchTokenPrices(body.token0, body.token1);
  _applyPriceOverrides(prices, body);
  const { price0, price1 } = prices;
  const { baseline, entryValue } = _resolveEntryValueCached(diskConfig, posKey);
  const value = positionValueUsd(position, ps, price0, price1);
  const feesUsd = body.feesUsd || 0;
  const residuals = await _walletResiduals(
    provider,
    ethersLib,
    position,
    ps,
    price0,
    price1,
    body.walletAddress || "",
  );
  const cur = _currentPnl(
    baseline,
    value,
    entryValue,
    feesUsd,
    price0,
    price1,
    residuals,
  );
  const { tracker, events } = await _getLifetimeSnapshot(
    provider,
    ethersLib,
    position,
    body.walletAddress || "",
    diskConfig,
    posKey,
    { price0, price1 },
    entryValue,
    ps.poolAddress,
  );
  const snap = tracker.epochCount() > 0 ? tracker.snapshot(ps.price) : null;
  const lt = _lifetimePnl(tracker, ps, entryValue, cur, feesUsd, cur.value);
  console.log(
    "[details] lifetime tokenId=%s epochs=%d baseline=%s cur.il=%s lt.il=%s",
    body.tokenId,
    tracker.epochCount(),
    !!baseline,
    cur.il,
    lt.il,
  );
  const dailyPnl = _buildDailyFallback(snap, entryValue, cur.value, body);
  console.log(
    "[details] Lifetime P&L for #%s done (%dms)",
    body.tokenId,
    Date.now() - _ltT0,
  );
  const ltCompounded = await _resolveCompounded(
    position,
    events,
    body,
    ps,
    { price0, price1 },
    diskConfig,
    posKey,
  );
  // Compute lifetime HODL from chain events (same as managed path)
  const _posWithMeta = {
    ...position,
    walletAddress: body.walletAddress,
    decimals0: ps.decimals0,
    decimals1: ps.decimals1,
  };
  const ltIl = await _computeLifetimeIL(
    _posWithMeta,
    events,
    body,
    cur.value,
    price0,
    price1,
    ps.poolAddress,
  );
  // Enrich snapshot with fields the dashboard expects from managed path
  if (snap) {
    snap.currentValue = cur.value;
    // Use the IL closest to zero (largest HODL) — cur.il uses the current
    // baseline which includes wallet-level deposits the scan can't detect.
    const bestIl = _pickSmaller(ltIl, cur.il) ?? snap.totalIL;
    snap.totalIL = bestIl;
    snap.lifetimeIL = bestIl;
    snap.totalCompoundedUsd = ltCompounded;
    snap.currentCompoundedUsd = 0;
    snap.initialDeposit = entryValue;
    snap.totalLifetimeDeposit = await _computeDepositUsd(_posWithMeta, ps);
  }
  return {
    totalGasNative: snap?.totalGasNative || 0,
    ok: true,
    ...lt,
    ltCompounded,
    entryValue,
    currentValue: cur.value,
    firstEpochDate: lt.firstEpochDate || baseline?.mintDate || null,
    dailyPnl,
    rebalanceEvents: events.length > 0 ? events : null,
    pnlSnapshot: snap,
  };
}

module.exports = {
  computeQuickDetails: require("./position-details-quick").computeQuickDetails,
  computeLifetimeDetails,
  _scanCompounds,
  _extractSnap,
  _lifetimePnl,
  _resolveEntryValueCached,
  _buildDailyFallback,
  _pickSmaller,
};
