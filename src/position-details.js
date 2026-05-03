/**
 * @file position-details.js
 * @description Phase 2 (slow) lifetime P&L computation for unmanaged positions.
 *   Runs event scan + epoch reconstruction for historical data.
 *   Phase 1 (fast) details are in position-details-quick.js.
 */

"use strict";

const ethers = require("ethers");
const config = require("./config");
const { getPoolState } = require("./rebalancer");
const {
  positionValueUsd,
  fetchTokenPrices,
  _totalLifetimeDeposit,
} = require("./bot-pnl-updater");
const { reconstructEpochs } = require("./epoch-reconstructor");
const { createPnlTracker } = require("./pnl-tracker");
const {
  getCachedEpochs,
  setCachedEpochs,
  getCachedLifetimeHodl,
  getCachedFreshDeposits,
} = require("./epoch-cache");
const { scanPoolHistory } = require("./pool-scanner");
const { compositeKey } = require("./bot-config-v2");
const {
  computeQuickDetails,
  _currentPnl,
  _applyPriceOverrides,
  _walletResiduals,
} = require("./position-details-quick");
const { _resolveCompounded } = require("./position-details-compound");
const { scanLifetimeHodl } = require("./position-details-lifetime-scan");
const { computeHodlIL } = require("./il-calculator");
const { fetchHistoricalPriceGecko } = require("./price-fetcher");
const {
  getBlockTimestamp,
  flushBlockTimeCache,
} = require("./block-time-cache");
const { applyInitialResidualFromCache } = require("./bot-pnl-initial-residual");

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
    "[position details] epoch cache: key=%s cached=%d restored=%d t0=%s",
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
  /*- Lifetime fee earnings model: lifetimeCompounded + currentFees.  The
   *  caller resolves `lifetimeCompounded` separately via the on-chain
   *  scan (see _resolveCompounded); here we just expose `currentFees`
   *  (= feesUsd, the live unclaimed reading) and let _lifetimePnl fold
   *  in compounded later.  The old `snap.totalFees` per-epoch sum is
   *  gone — it missed fees folded into rebalances. */
  const currentFees = feesUsd;
  const ltGas = snap ? snap.totalGas : 0;
  const ltPc = snap ? snap.priceChangePnl : cur.priceGainLoss;
  const il = snap?.lifetimeIL ?? snap?.totalIL ?? cur.il;
  return {
    currentFees,
    ltGas,
    ltPc,
    il,
    firstEpochDate: snap?.firstEpochDateUtc || null,
    rebalanceCount: snap?.closedEpochs?.length || 0,
  };
}

/** Compute lifetime P&L from tracker snapshot. */
function _lifetimePnl(
  tracker,
  ps,
  entryValue,
  cur,
  feesUsd,
  currentValue,
  ltCompounded,
) {
  const snap = tracker.epochCount() > 0 ? tracker.snapshot(ps.price) : null;
  const s = _extractSnap(snap, cur, feesUsd);
  // Price change = current position value − initial deposit.
  // NOT the epoch-chain cumulative (which leaks value through residuals).
  const ltPc = entryValue > 0 ? currentValue - entryValue : s.ltPc || 0;
  const comp = ltCompounded || 0;
  /*- Fee earnings = currentFees + lifetimeCompounded.  Both are real
   *  earnings; compounded is already swept back into liquidity, current
   *  is unclaimed and will be compounded next. */
  const feeEarnings = s.currentFees + comp;
  return {
    ltNetPnl: entryValue > 0 ? ltPc + feeEarnings - s.ltGas : null,
    ltCurrentFees: s.currentFees,
    ltGas: s.ltGas,
    ltPriceChange: ltPc,
    ltProfit:
      s.il !== null && s.il !== undefined
        ? feeEarnings - s.ltGas + s.il
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
  let hodl = poolCacheKey ? getCachedLifetimeHodl(poolCacheKey) : null;
  if (!hodl) {
    try {
      hodl = await scanLifetimeHodl(
        position,
        events,
        body,
        poolAddress,
        poolCacheKey,
      );
    } catch (err) {
      console.warn("[position details] Lifetime HODL error:", err.message);
      return null;
    }
  }
  if (!hodl || (hodl.amount0 <= 0 && hodl.amount1 <= 0)) return null;
  const il = computeHodlIL({
    lpValue,
    hodlAmount0: hodl.amount0,
    hodlAmount1: hodl.amount1,
    currentPrice0: price0,
    currentPrice1: price1,
  });
  return { il, hodlAmount0: hodl.amount0, hodlAmount1: hodl.amount1 };
}

/** Build ilInputs for the IL debug popover from baseline and lifetime scan. */
function _buildIlInputs(value, price0, price1, baseline, ltResult) {
  const curHodl = {
    hodlAmount0: baseline?.hodlAmount0 || 0,
    hodlAmount1: baseline?.hodlAmount1 || 0,
  };
  return {
    lpValue: value,
    price0,
    price1,
    cur: curHodl,
    lt: ltResult
      ? { hodlAmount0: ltResult.hodlAmount0, hodlAmount1: ltResult.hodlAmount1 }
      : curHodl,
  };
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
  if (!deps?.length) return { total: 0, usedFallback: false };
  const provider = new ethers.JsonRpcProvider(config.RPC_URL);
  const poolAddr = ps.poolAddress || "";
  const result = await _totalLifetimeDeposit(
    deps,
    ps.decimals0,
    ps.decimals1,
    async (block) => {
      const blockTs = await getBlockTimestamp(provider, "pulsechain", block);
      const ts = blockTs > 0 ? blockTs : Math.floor(Date.now() / 1000);
      return fetchHistoricalPriceGecko(poolAddr, ts, "pulsechain", {
        token0Address: position.token0,
        token1Address: position.token1,
        blockNumber: block,
      });
    },
    { token0: position.token0, token1: position.token1 },
  );
  flushBlockTimeCache();
  return result;
}

/** Enrich a tracker snapshot with fields the dashboard expects. */
async function _enrichSnap(
  snap,
  cur,
  ltIl,
  ltResult,
  ltComp,
  curComp,
  curGasUsd,
  entry,
  bl,
  pos,
  ps,
  p0,
  p1,
) {
  if (!snap) return;
  snap.currentValue = cur.value;
  snap.totalIL = cur.il ?? snap.totalIL;
  snap.lifetimeIL = ltIl ?? cur.il ?? snap.totalIL;
  snap.totalCompoundedUsd = ltComp;
  snap.currentCompoundedUsd = curComp || 0;
  snap.currentGasUsd = curGasUsd || 0;
  snap.initialDeposit = entry;
  /*- Mirror bot-pnl-updater._applyResiduals: the unmanaged path computes
   *  residuals via _walletResiduals → _currentPnl, but they were never
   *  copied to the snap.  Without these the Lifetime panel's "Wallet
   *  Residual (Pool)" row reads $0 even when wallet balances are
   *  non-zero. */
  snap.residualValueUsd = cur.residualValueUsd || 0;
  snap.residualUsd0 = cur.residualUsd0 || 0;
  snap.residualUsd1 = cur.residualUsd1 || 0;
  snap.residualAmount0 = cur.residualAmount0 || 0;
  snap.residualAmount1 = cur.residualAmount1 || 0;
  /*- Genesis residual: read from the shared liquidity-pair-details cache
   *  if a managed scan has already populated it. Unmanaged details runs
   *  don't populate the cache themselves (no historical scan path here),
   *  so this is best-effort: present when the same (chain/factory/wallet/
   *  token0/token1/fee) scope has been seen before, zero otherwise. */
  if (pos.walletAddress) {
    applyInitialResidualFromCache(snap, {
      blockchain: config.CHAIN_NAME,
      factory: config.POSITION_MANAGER,
      wallet: pos.walletAddress,
      token0: pos.token0,
      token1: pos.token1,
      fee: pos.fee,
    });
  }
  const depResult = await _computeDepositUsd(pos, ps);
  snap.totalLifetimeDeposit = depResult.total;
  snap.depositUsedFallback = depResult.usedFallback;
  snap.ilInputs = _buildIlInputs(cur.value, p0, p1, bl, ltResult);
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
  console.log(
    "[position details] Computing lifetime P&L for #%s\u2026",
    body.tokenId,
  );
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
  /*- Resolve lifetime compounded BEFORE _lifetimePnl so the new fee-
   *  earnings model (currentFees + lifetimeCompounded) has both inputs
   *  on hand.  No extra cost — _resolveCompounded reads from cached
   *  posConfig first and only scans events when missing. */
  const {
    total: ltCompounded,
    current: curCompounded,
    currentGasUsd: curGasUsd,
  } = await _resolveCompounded(
    position,
    events,
    body,
    ps,
    { price0, price1 },
    diskConfig,
    posKey,
  );
  const lt = _lifetimePnl(
    tracker,
    ps,
    entryValue,
    cur,
    feesUsd,
    cur.value,
    ltCompounded,
  );
  console.log(
    "[position details] lifetime tokenId=%s epochs=%d baseline=%s cur.il=%s lt.il=%s",
    body.tokenId,
    tracker.epochCount(),
    !!baseline,
    cur.il,
    lt.il,
  );
  const dailyPnl = _buildDailyFallback(snap, entryValue, cur.value, body);
  console.log(
    "[position details] Lifetime P&L for #%s done (%dms)",
    body.tokenId,
    Date.now() - _ltT0,
  );
  // Compute lifetime HODL from chain events (same as managed path)
  const _posWithMeta = {
    ...position,
    walletAddress: body.walletAddress,
    decimals0: ps.decimals0,
    decimals1: ps.decimals1,
  };
  const ltResult = await _computeLifetimeIL(
    _posWithMeta,
    events,
    body,
    cur.value,
    price0,
    price1,
    ps.poolAddress,
  );
  const ltIl = ltResult?.il ?? null;
  await _enrichSnap(
    snap,
    cur,
    ltIl,
    ltResult,
    ltCompounded,
    curCompounded,
    curGasUsd,
    entryValue,
    baseline,
    _posWithMeta,
    ps,
    price0,
    price1,
  );
  /*- The managed bot path sets `currentFeesUsd` via
   *  bot-pnl-updater.overridePnlWithRealValues; the unmanaged details
   *  path needs the same field so _syncLifetimeState and the dashboard
   *  Lifetime panel see live unclaimed fees (not undefined). */
  if (snap) snap.currentFeesUsd = feesUsd;
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
  computeQuickDetails,
  computeLifetimeDetails,
  _extractSnap,
  _lifetimePnl,
  _resolveEntryValueCached,
  _buildDailyFallback,
  _pickSmaller,
};
