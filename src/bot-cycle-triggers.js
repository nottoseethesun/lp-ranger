/**
 * @file src/bot-cycle-triggers.js
 * @description Pure trigger/config helpers extracted from
 * `src/bot-cycle.js` (which sat at its 500-line cap):
 *
 *   - `_isTimeoutExpired(bs, gc)` — has the position been continuously
 *     out of range longer than the configured OOR Rebalance Time
 *     Threshold?  One of the two independent automatic triggers.
 *   - `_isBeyondThreshold(poolState, position, gc)` — has the price
 *     moved beyond the position's price boundary by more than the OOR
 *     threshold?  The distance is measured as a percentage of the
 *     POSITION'S PRICE-RANGE WIDTH (upper − lower), in price space —
 *     NOT as a percentage of the boundary price.  The other automatic
 *     trigger; either alone fires a rebalance.
 *   - `_reloadFromConfig(gc, throttle, setIntervalMs)` — re-applies
 *     per-position config (poll interval, min rebalance interval,
 *     daily cap) to the live throttle on every poll cycle.
 *
 * `bot-cycle.js` consumes the first two inside
 * `_checkRangeAndThreshold`; `bot-loop.js` calls `_reloadFromConfig`
 * at the top of every poll.
 */

"use strict";

const config = require("./config");
const rangeMath = require("./range-math");
const { log } = require("./log");

/** Check whether the OOR timeout has expired (position continuously OOR). */
function _isTimeoutExpired(bs, gc) {
  const t = gc?.("rebalanceTimeoutMin") ?? config.REBALANCE_TIMEOUT_MIN;
  return t > 0 && bs.oorSince && Date.now() - bs.oorSince >= t * 60_000;
}

/** Check whether the price has moved beyond the OOR threshold. */
function _isBeyondThreshold(poolState, position, gc) {
  const threshPct =
    (gc?.("rebalanceOutOfRangeThresholdPercent") ??
      config.REBALANCE_OOR_THRESHOLD_PCT ??
      5) / 100;
  if (threshPct <= 0) return true;
  const lp = rangeMath.tickToPrice(
      position.tickLower,
      poolState.decimals0,
      poolState.decimals1,
    ),
    up = rangeMath.tickToPrice(
      position.tickUpper,
      poolState.decimals0,
      poolState.decimals1,
    );
  if (
    poolState.price < lp - (up - lp) * threshPct ||
    poolState.price > up + (up - lp) * threshPct
  )
    return true;
  log.info(`[bot] OOR but within ${threshPct * 100}% threshold`);
  return false;
}

/** Reload config values from disk on each poll cycle. */
function _reloadFromConfig(gc, throttle, setIntervalMs) {
  const ci = gc("checkIntervalSec");
  if (ci) setIntervalMs(ci * 1000);
  throttle.configure({
    minIntervalMs:
      (gc("minRebalanceIntervalMin") || config.MIN_REBALANCE_INTERVAL_MIN) *
      60_000,
    dailyMax: gc("maxRebalancesPerDay") || config.MAX_REBALANCES_PER_DAY,
  });
}

module.exports = { _isTimeoutExpired, _isBeyondThreshold, _reloadFromConfig };
