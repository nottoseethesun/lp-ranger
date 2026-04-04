/**
 * @file pnl-tracker.js
 * @module pnlTracker
 * @description
 * Tracks profit and loss across every LP range epoch for the 9mm v3 position
 * manager.  An "epoch" is a single continuous LP deployment: it begins when
 * liquidity is added and ends when liquidity is removed (i.e. on each
 * rebalance, or on manual withdrawal).
 *
 * P&L is broken down into two components:
 *  (a) **Price-change P&L** — the change in position value due to token price
 *      movements (including impermanent loss).  Computed as:
 *      `exitValue − entryValue − fees` (closed) or estimated via IL model (live).
 *  (b) **Fee P&L** — cumulative trading fees earned while the position was
 *      in range.
 *
 * Each epoch records:
 *  - Entry value (USD) at the time liquidity was deployed
 *  - Exit value (USD) when the epoch closes
 *  - Fees earned while in range
 *  - Impermanent loss relative to a HODL benchmark
 *  - Gas cost of the rebalance that opened / closed this epoch
 *  - Timestamps for duration calculation
 *  - Historical token prices (token0UsdEntry/Exit, token1UsdEntry/Exit)
 *
 * The tracker also maintains a running cumulative P&L from the first
 * deposit through all epochs including the currently open one.
 *
 * All currency values are in USD-equivalent floats (for simulation /
 * display purposes).  On-chain implementations should use BigInt wei values.
 *
 * @example
 * import { createPnlTracker } from './pnl-tracker.js';
 * const tracker = createPnlTracker({ initialDeposit: 2000 });
 * tracker.openEpoch({ entryValue: 2000, entryPrice: 0.00042,
 *                     lowerPrice: 0.000336, upperPrice: 0.000504,
 *                     token0UsdPrice: 0.00042, token1UsdPrice: 1.0 });
 * tracker.updateLiveEpoch({ currentPrice: 0.00044, feesAccrued: 0.12 });
 * const snap = tracker.snapshot();
 * console.log(snap.priceChangePnl, snap.feePnl);
 */

"use strict";

const { calcIlMultiplier, estimateLiveValue } = require("./il-calculator");

/**
 * @typedef {Object} EpochOpenParams
 * @property {number} entryValue       USD value of assets entering this epoch.
 * @property {number} entryPrice       Pool price at epoch open.
 * @property {number} lowerPrice       Range lower bound.
 * @property {number} upperPrice       Range upper bound.
 * @property {number} [gasCost]        Gas cost of the rebalance that opened this epoch (USD).
 * @property {number} [openTime]       Override open timestamp (ms). Defaults to Date.now().
 * @property {number} [token0UsdPrice] USD price of token0 at epoch open (for historical P&L).
 * @property {number} [token1UsdPrice] USD price of token1 at epoch open (for historical P&L).
 */

/**
 * @typedef {Object} EpochUpdateParams
 * @property {number} currentPrice  Current pool price.
 * @property {number} feesAccrued   Cumulative fees earned in this epoch (USD).
 */

/**
 * @typedef {Object} EpochCloseParams
 * @property {number} exitValue        USD value of assets at epoch close.
 * @property {number} gasCost          Gas cost of the rebalance that closed this epoch (USD).
 * @property {number} [closeTime]      Override close timestamp (ms). Defaults to Date.now().
 * @property {number} [token0UsdPrice] USD price of token0 at epoch close (for historical P&L).
 * @property {number} [token1UsdPrice] USD price of token1 at epoch close (for historical P&L).
 */

/**
 * @typedef {Object} Epoch
 * @property {number}  id               1-based epoch index.
 * @property {string}  color            Display colour from the epoch palette.
 * @property {number}  entryValue       USD value at open.
 * @property {number}  entryPrice       Pool price at open.
 * @property {number}  lowerPrice       Range lower bound.
 * @property {number}  upperPrice       Range upper bound.
 * @property {number}  openTime         Unix ms timestamp of open.
 * @property {number}  closeTime        Unix ms timestamp of close (0 if still open).
 * @property {number}  fees             Cumulative fees earned (USD).
 * @property {number}  il               Impermanent loss (USD, positive = loss).
 * @property {number}  gas              Gas cost charged to this epoch (USD).
 * @property {number|null} exitValue    USD value at close (null while open).
 * @property {number|null} epochPnl     Closed P&L: exitValue − entryValue + fees − il − gas.
 * @property {number|null} priceChangePnl Price-change component: exitValue − entryValue (excludes fees).
 * @property {number}  feePnl           Fee component: cumulative fees earned (USD).
 * @property {number}  token0UsdEntry   USD price of token0 at epoch open (0 if not provided).
 * @property {number}  token1UsdEntry   USD price of token1 at epoch open (0 if not provided).
 * @property {number}  token0UsdExit    USD price of token0 at epoch close (0 if still open).
 * @property {number}  token1UsdExit    USD price of token1 at epoch close (0 if still open).
 * @property {'open'|'closed'} status
 */

/**
 * @typedef {Object} PnlSnapshot
 * @property {Epoch[]}    closedEpochs       All completed epochs.
 * @property {Epoch|null} liveEpoch          Currently open epoch, or null.
 * @property {number}     liveEpochPnl       P&L of the current open epoch (0 if none).
 * @property {number}     cumulativePnl      Sum of all closed + live epoch P&L.
 * @property {number}     priceChangePnl     Total P&L from token price changes (across all epochs).
 * @property {number}     feePnl             Total P&L from trading fees earned (across all epochs).
 * @property {number}     totalFees          Fees across all epochs (alias for feePnl).
 * @property {number}     totalIL            IL across all epochs.
 * @property {number}     totalGas           Gas across all epochs.
 * @property {number}     netReturn          totalFees − totalIL − totalGas.
 * @property {number}     initialDeposit     Original deposit value.
 * @property {number}     currentValue       Live current position value.
 * @property {DailyPnl[]} dailyPnl           Per-day P&L breakdown (up to 31 days).
 * @property {string|null} firstEpochDateUtc  ISO date of the earliest epoch (UTC), or null.
 * @property {string}     snapshotDateUtc    Current UTC date (ISO format).
 */

/**
 * @typedef {Object} DailyPnl
 * @property {string} date           ISO date string (YYYY-MM-DD).
 * @property {number} priceChangePnl P&L from price movements on this day.
 * @property {number} feePnl         Fees earned on this day.
 * @property {number} gasCost        Gas spent on this day.
 * @property {number} netPnl         priceChangePnl + feePnl − gasCost.
 * @property {number} residual       Wallet residual adjustment (entry(N+1) − exit(N)) at rebalances on this day.
 * @property {number} cumulative     Running cumulative net P&L through this day (includes residuals).
 */

const EPOCH_COLORS = [
  "#00e5ff",
  "#ff6b35",
  "#7cfc00",
  "#c471ed",
  "#f7971e",
  "#43e97b",
  "#fa709a",
  "#4facfe",
  "#a8edea",
  "#fed6e3",
];

/**
 * Factory that creates a P&L tracker instance.
 * @param {{ initialDeposit: number, nowFn?: Function }} opts
 * @returns {Object} tracker handle
 */
function createPnlTracker(opts = {}) {
  const initialDeposit = opts.initialDeposit ?? 0;
  const nowFn = opts.nowFn || Date.now;

  /** @type {Epoch[]} */
  const closedEpochs = [];

  /** @type {Epoch|null} */
  let liveEpoch = null;

  // ─── private ──────────────────────────────────────────────────────────────

  /**
   * Build a fresh Epoch object.
   * @param {EpochOpenParams} params
   * @returns {Epoch}
   */
  function _buildEpoch(params) {
    return {
      id: closedEpochs.length + 1,
      color: EPOCH_COLORS[closedEpochs.length % EPOCH_COLORS.length],
      entryValue: params.entryValue,
      entryPrice: params.entryPrice,
      lowerPrice: params.lowerPrice,
      upperPrice: params.upperPrice,
      openTime: params.openTime ?? nowFn(),
      closeTime: 0,
      fees: 0,
      il: 0,
      gas: params.gasCost ?? 0,
      exitValue: null,
      epochPnl: null,
      priceChangePnl: null,
      feePnl: 0,
      token0UsdEntry: params.token0UsdPrice ?? 0,
      token1UsdEntry: params.token1UsdPrice ?? 0,
      token0UsdExit: 0,
      token1UsdExit: 0,
      status: "open",
    };
  }

  /**
   * Compute the P&L for the currently open epoch using current price data.
   * @param {number} currentPrice
   * @returns {number}
   */
  function _computeLivePnl(currentPrice) {
    if (!liveEpoch) return 0;
    const curVal = estimateLiveValue(
      liveEpoch.entryValue,
      currentPrice / liveEpoch.entryPrice,
    );
    return curVal - liveEpoch.entryValue + liveEpoch.fees - liveEpoch.il;
  }

  // ─── public API ───────────────────────────────────────────────────────────

  /**
   * Open a new epoch.  Any previously open epoch must be closed first.
   * @param {EpochOpenParams} params
   * @throws {Error} If an epoch is already open.
   */
  function openEpoch(params) {
    if (liveEpoch)
      throw new Error("An epoch is already open — close it first.");
    liveEpoch = _buildEpoch(params);
  }

  /**
   * Update the live epoch with the latest price and fee data.
   * Recomputes IL estimate.
   * @param {EpochUpdateParams} params
   */
  function updateLiveEpoch(params) {
    if (!liveEpoch) return;
    liveEpoch.fees = params.feesAccrued;
    liveEpoch.feePnl = params.feesAccrued;
    const priceRatio = params.currentPrice / liveEpoch.entryPrice;
    const ilMult = calcIlMultiplier(priceRatio);
    liveEpoch.il = Math.abs(ilMult * liveEpoch.entryValue * 0.38);
    // Live price-change estimate: value change due to price movement (excludes fees)
    const curVal = estimateLiveValue(liveEpoch.entryValue, priceRatio);
    liveEpoch.priceChangePnl = curVal - liveEpoch.entryValue;
  }

  /**
   * Close the live epoch and push it to the closed list.
   * @param {EpochCloseParams} params
   * @throws {Error} If no epoch is open.
   */
  function closeEpoch(params) {
    if (!liveEpoch) throw new Error("No open epoch to close.");
    liveEpoch.exitValue = params.exitValue;
    liveEpoch.gas += params.gasCost;
    liveEpoch.closeTime = params.closeTime ?? nowFn();
    liveEpoch.token0UsdExit = params.token0UsdPrice ?? 0;
    liveEpoch.token1UsdExit = params.token1UsdPrice ?? 0;
    // Price-change P&L: value change excluding fees
    liveEpoch.priceChangePnl =
      liveEpoch.exitValue - liveEpoch.entryValue - liveEpoch.fees;
    liveEpoch.feePnl = liveEpoch.fees;
    liveEpoch.epochPnl =
      liveEpoch.exitValue -
      liveEpoch.entryValue +
      liveEpoch.fees -
      liveEpoch.il -
      liveEpoch.gas;
    liveEpoch.status = "closed";
    closedEpochs.push(liveEpoch);
    liveEpoch = null;
  }

  /**
   * Return a complete snapshot of current P&L state.
   * @param {number} [currentPrice]  Required for live epoch P&L estimate.
   * @param {string|null} [fromDate]  ISO date (YYYY-MM-DD) for daily P&L day-fill.
   * @returns {PnlSnapshot}
   */
  function snapshot(currentPrice, fromDate) {
    const closedPnl = closedEpochs.reduce((s, e) => s + e.epochPnl, 0);
    const livePnl = currentPrice !== null ? _computeLivePnl(currentPrice) : 0;

    const totalFees =
      closedEpochs.reduce((s, e) => s + e.fees, 0) + (liveEpoch?.fees ?? 0);
    const totalIL =
      closedEpochs.reduce((s, e) => s + e.il, 0) + (liveEpoch?.il ?? 0);
    const totalGas =
      closedEpochs.reduce((s, e) => s + e.gas, 0) + (liveEpoch?.gas ?? 0);

    // ── P&L breakdown: price-change vs fees ──────────────────────────────────
    const closedPriceChange = closedEpochs.reduce(
      (s, e) => s + (e.priceChangePnl ?? 0),
      0,
    );
    const livePriceChange = liveEpoch?.priceChangePnl ?? 0;
    const priceChangePnl = closedPriceChange + livePriceChange;
    const feePnl = totalFees;

    // ── Per-day P&L (up to 31 days) ──────────────────────────────────────────
    const dailyPnl = _buildDailyPnl(closedEpochs, liveEpoch, fromDate);

    // ── Date range for lifetime P&L ───────────────────────────────────────────
    const allEpochs = liveEpoch ? [...closedEpochs, liveEpoch] : closedEpochs;
    let firstEpochDateUtc = null;
    if (allEpochs.length > 0) {
      const earliest = allEpochs.reduce(
        (min, e) => (e.openTime < min ? e.openTime : min),
        allEpochs[0].openTime,
      );
      firstEpochDateUtc = new Date(earliest).toISOString().slice(0, 10);
    }
    const snapshotDateUtc = new Date().toISOString().slice(0, 10);

    return {
      closedEpochs: [...closedEpochs],
      liveEpoch: liveEpoch ? { ...liveEpoch } : null,
      liveEpochPnl: livePnl,
      cumulativePnl: closedPnl + livePnl,
      priceChangePnl,
      feePnl,
      totalFees,
      totalIL,
      totalGas,
      netReturn: totalFees - totalIL - totalGas,
      initialDeposit,
      dailyPnl,
      firstEpochDateUtc,
      snapshotDateUtc,
    };
  }

  /**
   * Return the number of completed epochs.
   * @returns {number}
   */
  function epochCount() {
    return closedEpochs.length + (liveEpoch ? 1 : 0);
  }
  /** Returns the live (open) epoch, or null if none exists. */
  function getLiveEpoch() {
    return liveEpoch ? { ...liveEpoch } : null;
  }

  /** Serialize all epoch data for disk persistence. */
  function serialize() {
    return {
      closedEpochs: [...closedEpochs],
      liveEpoch: liveEpoch ? { ...liveEpoch } : null,
    };
  }

  /** Restore epoch data from a prior serialization. */
  function restore(data) {
    if (!data) return;
    if (Array.isArray(data.closedEpochs)) {
      closedEpochs.length = 0;
      closedEpochs.push(...data.closedEpochs);
    }
    if (data.liveEpoch) liveEpoch = { ...data.liveEpoch };
  }

  return {
    openEpoch,
    updateLiveEpoch,
    closeEpoch,
    snapshot,
    epochCount,
    getLiveEpoch,
    serialize,
    restore,
  };
}

/**
 * Distribute P&L values evenly across a date range (inclusive).
 * @param {Map} dayMap       Day accumulator map.
 * @param {string} startDay  ISO date (YYYY-MM-DD) for range start.
 * @param {string} endDay    ISO date (YYYY-MM-DD) for range end.
 * @param {number} feePnl    Total fee P&L to distribute.
 * @param {number} priceChangePnl  Total price-change P&L to distribute.
 * @param {number} gas       Total gas cost to distribute.
 */
function _distributeToRange(
  dayMap,
  startDay,
  endDay,
  feePnl,
  priceChangePnl,
  gas,
) {
  const cursor = new Date(startDay + "T00:00:00Z");
  const end = new Date(endDay + "T00:00:00Z");
  const totalDays = Math.max(1, Math.round((end - cursor) / 86_400_000) + 1);
  const dFee = feePnl / totalDays,
    dPrice = priceChangePnl / totalDays,
    dGas = gas / totalDays;
  while (cursor <= end) {
    const key = cursor.toISOString().slice(0, 10);
    const entry = dayMap.get(key) || {
      priceChangePnl: 0,
      feePnl: 0,
      gasCost: 0,
    };
    entry.priceChangePnl += dPrice;
    entry.feePnl += dFee;
    entry.gasCost += dGas;
    dayMap.set(key, entry);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
}

/**
 * Aggregate epoch data into per-day P&L records.
 * Each day shows the breakdown of price-change P&L vs fee P&L.
 * When `fromDate` is provided, fills in zero-value rows for every day
 * between `fromDate` and today so the table shows the full timeline.
 *
 * @param {Epoch[]} closedEpochs
 * @param {Epoch|null} liveEpoch
 * @param {string|null} [fromDate]  ISO date (YYYY-MM-DD) for day-fill start.
 * @returns {DailyPnl[]}
 */
/** Create a blank day entry. */
function _newDay() {
  return { priceChangePnl: 0, feePnl: 0, gasCost: 0, residual: 0 };
}

/**
 * Compute wallet residuals at each epoch transition and attribute them to the
 * rebalance day.  residual = entry(N+1) − exit(N): value that moved between
 * wallet and LP.  Including this in the cumulative makes the P&L telescope.
 */
function _computeResiduals(dayMap, closedEpochs, liveEpoch) {
  for (let i = 0; i < closedEpochs.length - 1; i++) {
    const gap = closedEpochs[i + 1].entryValue - closedEpochs[i].exitValue;
    const rebDay = new Date(closedEpochs[i].closeTime)
      .toISOString()
      .slice(0, 10);
    const entry = dayMap.get(rebDay) || _newDay();
    entry.residual = (entry.residual || 0) + gap;
    dayMap.set(rebDay, entry);
  }
  if (closedEpochs.length > 0 && liveEpoch) {
    const last = closedEpochs[closedEpochs.length - 1];
    const gap = (liveEpoch.entryValue || 0) - last.exitValue;
    const rebDay = new Date(last.closeTime).toISOString().slice(0, 10);
    const entry = dayMap.get(rebDay) || _newDay();
    entry.residual = (entry.residual || 0) + gap;
    dayMap.set(rebDay, entry);
  }
}

/** Fill zero-value rows for every day between fromDate and today. */
function _fillDayRange(dayMap, fromDate) {
  if (!fromDate) return;
  const todayStr = new Date().toISOString().slice(0, 10);
  const cursor = new Date(fromDate + "T00:00:00Z");
  const end = new Date(todayStr + "T00:00:00Z");
  while (cursor <= end) {
    const key = cursor.toISOString().slice(0, 10);
    if (!dayMap.has(key)) dayMap.set(key, _newDay());
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
}

function _buildDailyPnl(closedEpochs, liveEpoch, fromDate) {
  /** @type {Map<string, {priceChangePnl: number, feePnl: number, gasCost: number, residual: number}>} */
  const dayMap = new Map();

  // Distribute closed epochs across their open→close duration
  for (const ep of closedEpochs) {
    const openDay = ep.openTime
      ? new Date(ep.openTime).toISOString().slice(0, 10)
      : null;
    const closeDay = new Date(ep.closeTime).toISOString().slice(0, 10);
    _distributeToRange(
      dayMap,
      openDay || closeDay,
      closeDay,
      ep.feePnl ?? ep.fees,
      ep.priceChangePnl ?? 0,
      ep.gas,
    );
    if (ep.missingPrice) {
      const day = dayMap.get(openDay || closeDay);
      if (day) day.missingPrice = true;
    }
  }

  _computeResiduals(dayMap, closedEpochs, liveEpoch);

  // Live epoch: put accumulated values on today only
  if (liveEpoch) {
    const today = new Date().toISOString().slice(0, 10);
    const entry = dayMap.get(today) || _newDay();
    entry.feePnl += liveEpoch.feePnl ?? liveEpoch.fees ?? 0;
    entry.priceChangePnl += liveEpoch.priceChangePnl ?? 0;
    entry.gasCost += liveEpoch.gas ?? 0;
    dayMap.set(today, entry);
  }

  _fillDayRange(dayMap, fromDate);

  // Sort by date descending (no limit — show all days)
  const sorted = [...dayMap.entries()].sort((a, b) => b[0].localeCompare(a[0]));

  let cumulative = 0;
  // Reverse to compute cumulative from oldest to newest, then reverse back
  sorted.reverse();
  const result = sorted.map(([date, d]) => {
    const netPnl = d.priceChangePnl + d.feePnl - d.gasCost;
    const residual = d.residual || 0;
    cumulative += netPnl + residual;
    return {
      date,
      priceChangePnl: d.priceChangePnl,
      feePnl: d.feePnl,
      gasCost: d.gasCost,
      netPnl,
      residual,
      cumulative,
      missingPrice: !!d.missingPrice,
    };
  });

  // Return newest first
  result.reverse();
  return result;
}

// ── exports ──────────────────────────────────────────────────────────────────
module.exports = {
  createPnlTracker,
  calcIlMultiplier,
  estimateLiveValue,
  _buildDailyPnl,
};
