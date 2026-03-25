/**
 * @file position-details.js
 * @description One-shot position detail computation for unmanaged positions.
 *   Fetches pool state, token prices, position value, fees, baseline,
 *   and full lifetime P&L (event scan + epoch reconstruction).
 *   Results are cached to disk for instant subsequent views.
 */

'use strict';

const path = require('path');
const config = require('./config');
const rangeMath = require('./range-math');
const { getPoolState } = require('./rebalancer');
const { positionValueUsd, fetchTokenPrices, readUnclaimedFees } = require('./bot-pnl-updater');
const { getPositionBaseline } = require('./hodl-baseline');
const { computeHodlIL } = require('./il-calculator');
const { scanRebalanceHistory } = require('./event-scanner');
const { reconstructEpochs } = require('./epoch-reconstructor');
const { createPnlTracker } = require('./pnl-tracker');
const { createCacheStore } = require('./cache-store');
const { compositeKey, getPositionConfig, saveConfig } = require('./bot-config-v2');

/** Load or fetch + cache the HODL baseline for a position. */
async function _resolveBaseline(provider, ethersLib, position, posKey, diskConfig) {
  const saved = diskConfig.positions[posKey]?.hodlBaseline;
  if (saved && saved.entryValue > 0) return saved;
  const bl = await getPositionBaseline(provider, ethersLib, position);
  if (bl) { const pos = getPositionConfig(diskConfig, posKey); pos.hodlBaseline = bl; saveConfig(diskConfig); }
  return bl;
}

/** Read unclaimed fees for a position. Returns 0 if unavailable. */
async function _readFees(provider, ethersLib, tokenId, privateKey, decimals0, decimals1, price0, price1) {
  if (!privateKey) return 0;
  try {
    const signer = new ethersLib.Wallet(privateKey, provider);
    const f = await readUnclaimedFees(provider, ethersLib, tokenId, signer);
    return (Number(f.tokensOwed0) / 10 ** decimals0) * price0 + (Number(f.tokensOwed1) / 10 ** decimals1) * price1;
  } catch { return 0; }
}

/** Run event scan + epoch reconstruction. Reads from disk cache if available. */
async function _getLifetimeSnapshot(provider, ethersLib, position, walletAddr, diskConfig, posKey, prices, deposit) {
  const saved = diskConfig.positions[posKey]?.pnlEpochs;
  const tracker = createPnlTracker({ initialDeposit: deposit || 0 });
  if (saved) tracker.restore(saved);
  const cache = createCacheStore({ filePath: path.join(process.cwd(), 'tmp', 'event-cache-' + position.tokenId + '.json') });
  const events = await scanRebalanceHistory(provider, ethersLib, { positionManagerAddress: config.POSITION_MANAGER, walletAddress: walletAddr,
    maxYears: 5, cache, factoryAddress: config.FACTORY, poolToken0: position.token0, poolToken1: position.token1, poolFee: position.fee });
  if (tracker.epochCount() === 0 && events.length > 0) {
    await reconstructEpochs({ pnlTracker: tracker, rebalanceEvents: events,
      botState: { activePosition: position, walletAddress: walletAddr, positionManager: config.POSITION_MANAGER }, fallbackPrices: prices });
    const pos = getPositionConfig(diskConfig, posKey); pos.pnlEpochs = tracker.serialize(); saveConfig(diskConfig);
  }
  return { tracker, events };
}

/** Compute current-epoch P&L from baseline + prices. */
function _currentPnl(baseline, value, entryValue, feesUsd, price0, price1) {
  const pgl = entryValue > 0 ? value - entryValue : null;
  const il = baseline ? computeHodlIL({ lpValue: value, hodlAmount0: baseline.hodlAmount0, hodlAmount1: baseline.hodlAmount1, currentPrice0: price0, currentPrice1: price1 }) : null;
  return { priceGainLoss: pgl, il, netPnl: entryValue > 0 ? (pgl || 0) + feesUsd : null, profit: il !== null ? feesUsd + il : null };
}

/** Extract lifetime data from a tracker snapshot (or fall back to current-epoch data). */
function _extractSnap(snap, cur, feesUsd) {
  const ltFees = snap ? snap.totalFees : feesUsd;
  const ltGas = snap ? snap.totalGas : 0;
  const ltPc = snap ? snap.priceChangePnl : cur.priceGainLoss;
  const il = snap?.lifetimeIL ?? snap?.totalIL ?? cur.il;
  return { ltFees, ltGas, ltPc, il, firstEpochDate: snap?.firstEpochDateUtc || null, rebalanceCount: snap?.closedEpochs?.length || 0 };
}

/** Compute lifetime P&L from tracker snapshot. */
function _lifetimePnl(tracker, ps, entryValue, cur, feesUsd) {
  const snap = tracker.epochCount() > 0 ? tracker.snapshot(ps.price) : null;
  const s = _extractSnap(snap, cur, feesUsd);
  return { ltNetPnl: entryValue > 0 ? (s.ltPc || 0) + s.ltFees : null, ltFees: s.ltFees, ltGas: s.ltGas, ltPriceChange: s.ltPc,
    ltProfit: s.il !== null && s.il !== undefined ? s.ltFees - s.ltGas + s.il : cur.profit, il: s.il,
    firstEpochDate: s.firstEpochDate, rebalanceCount: s.rebalanceCount };
}

/** Fetch pool state, prices, amounts, value — the non-P&L data. */
async function _fetchPoolData(provider, ethersLib, body, privateKey) {
  const position = { tokenId: body.tokenId, token0: body.token0, token1: body.token1, fee: body.fee,
    tickLower: body.tickLower, tickUpper: body.tickUpper, liquidity: body.liquidity };
  const ps = await getPoolState(provider, ethersLib, { factoryAddress: config.FACTORY, token0: body.token0, token1: body.token1, fee: body.fee });
  const { price0, price1 } = await fetchTokenPrices(body.token0, body.token1);
  const value = positionValueUsd(position, ps, price0, price1);
  const amounts = rangeMath.positionAmounts(BigInt(body.liquidity || 0), ps.tick, body.tickLower, body.tickUpper, ps.decimals0, ps.decimals1);
  console.log('[details] tokenId=%s liq=%s tick=%d tL=%d tU=%d amt0=%s amt1=%s p0=%s p1=%s', body.tokenId, body.liquidity, ps.tick, body.tickLower, body.tickUpper, amounts.amount0.toFixed(4), amounts.amount1.toFixed(4), price0, price1);
  const feesUsd = await _readFees(provider, ethersLib, body.tokenId, privateKey, ps.decimals0, ps.decimals1, price0, price1);
  const total = amounts.amount0 * price0 + amounts.amount1 * price1;
  return { position, ps, price0, price1, value, amounts, feesUsd, composition: total > 0 ? (amounts.amount0 * price0) / total : null };
}

/** Resolve entry value from user deposit, disk config, chain baseline, or current prices. */
async function _resolveEntryValue(provider, ethersLib, position, posKey, diskConfig, body, price0, price1) {
  const baseline = await _resolveBaseline(provider, ethersLib, position, posKey, diskConfig);
  const deposit = diskConfig.positions[posKey]?.initialDepositUsd || body.initialDeposit || 0;
  let entryValue = deposit > 0 ? deposit : (baseline?.entryValue || 0);
  // Fallback: if baseline has amounts but no historical prices, estimate from current prices
  if (entryValue <= 0 && baseline?.hodlAmount0 > 0 && price0 > 0) entryValue = baseline.hodlAmount0 * price0 + (baseline.hodlAmount1 || 0) * price1;
  return { baseline, entryValue };
}

/** Phase 1: fast data (pool state, prices, value, composition, current P&L). */
async function computeQuickDetails(provider, ethersLib, body, diskConfig, privateKey) {
  const { position, ps, price0, price1, value, amounts, feesUsd, composition } = await _fetchPoolData(provider, ethersLib, body, privateKey);
  const posKey = compositeKey('pulsechain', body.walletAddress || '', body.contractAddress || config.POSITION_MANAGER, body.tokenId);
  const { baseline, entryValue } = await _resolveEntryValue(provider, ethersLib, position, posKey, diskConfig, body, price0, price1);
  const cur = _currentPnl(baseline, value, entryValue, feesUsd, price0, price1);
  const poolState = { tick: ps.tick, price: ps.price, decimals0: ps.decimals0, decimals1: ps.decimals1, poolAddress: ps.poolAddress };
  return { ok: true, poolState, price0, price1, value, amounts, feesUsd, composition,
    inRange: ps.tick >= body.tickLower && ps.tick < body.tickUpper,
    lowerPrice: rangeMath.tickToPrice(body.tickLower, ps.decimals0, ps.decimals1),
    upperPrice: rangeMath.tickToPrice(body.tickUpper, ps.decimals0, ps.decimals1),
    entryValue, ...cur, mintDate: baseline?.mintDate || null, mintTimestamp: baseline?.mintTimestamp || null,
    hodlAmount0: baseline?.hodlAmount0 ?? null, hodlAmount1: baseline?.hodlAmount1 ?? null };
}

/** Resolve entry value from disk config for phase 2 (no chain baseline fetch). */
function _resolveEntryValueCached(diskConfig, posKey, body, price0, price1) {
  const deposit = diskConfig.positions[posKey]?.initialDepositUsd || body.initialDeposit || 0;
  const bl = diskConfig.positions[posKey]?.hodlBaseline || null;
  let ev = deposit > 0 ? deposit : (bl?.entryValue || 0);
  if (ev <= 0 && bl?.hodlAmount0 > 0 && price0 > 0) ev = bl.hodlAmount0 * price0 + (bl.hodlAmount1 || 0) * price1;
  return { baseline: bl, entryValue: ev };
}

/** Phase 2: slow data (event scan + epoch reconstruction → lifetime P&L). */
async function computeLifetimeDetails(provider, ethersLib, body, diskConfig) {
  const position = { tokenId: body.tokenId, token0: body.token0, token1: body.token1, fee: body.fee,
    tickLower: body.tickLower, tickUpper: body.tickUpper, liquidity: body.liquidity };
  const posKey = compositeKey('pulsechain', body.walletAddress || '', body.contractAddress || config.POSITION_MANAGER, body.tokenId);
  const ps = await getPoolState(provider, ethersLib, { factoryAddress: config.FACTORY, token0: body.token0, token1: body.token1, fee: body.fee });
  const { price0, price1 } = await fetchTokenPrices(body.token0, body.token1);
  const { baseline, entryValue } = _resolveEntryValueCached(diskConfig, posKey, body, price0, price1);
  const value = positionValueUsd(position, ps, price0, price1);
  const cur = _currentPnl(baseline, value, entryValue, 0, price0, price1);
  const { tracker, events } = await _getLifetimeSnapshot(provider, ethersLib, position, body.walletAddress || '', diskConfig, posKey, { price0, price1 }, entryValue);
  const snap = tracker.epochCount() > 0 ? tracker.snapshot(ps.price) : null;
  const lt = _lifetimePnl(tracker, ps, entryValue, cur, 0);
  return { ok: true, ...lt, firstEpochDate: lt.firstEpochDate || baseline?.mintDate || null,
    dailyPnl: snap?.dailyPnl || null, rebalanceEvents: events.length > 0 ? events : null };
}

module.exports = { computeQuickDetails, computeLifetimeDetails };
