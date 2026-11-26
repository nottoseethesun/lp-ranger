/**
 * @file src/bot/bot-cycle-triggers.js
 * @description Trigger/config helpers extracted from
 * `src/bot/bot-cycle.js` (which sat at its 500-line cap):
 *
 *   - `_isTimeoutExpired(bs, gc)` — has the position been continuously
 *     out of range for at least the configured OOR Rebalance Time
 *     Threshold (`rebalanceTimeoutMin`)?  A threshold of 0 turns this
 *     trigger off.  One of the two independent automatic triggers.
 *   - `_isBeyondThreshold(poolState, position, gc)` — has the price
 *     moved beyond the position's price boundary by more than the OOR
 *     threshold?  The distance is measured as a percentage of the
 *     POSITION'S PRICE-RANGE WIDTH (upper − lower), in price space —
 *     NOT as a percentage of the boundary price.  The other automatic
 *     trigger; either alone fires a rebalance.
 *   - `_reloadFromConfig(gc, throttle)` — re-applies per-position
 *     config (min rebalance interval, daily cap) to the live throttle on
 *     every poll cycle. How often the bot polls is one global setting,
 *     not a per-position one.
 *
 * `bot-cycle.js` consumes the first two inside
 * `_checkRangeAndThreshold`; `bot-loop.js` calls `_reloadFromConfig`
 * at the top of every poll.
 */

"use strict";

const config = require("../lib/config");
const rangeMath = require("./range-math");
const { log } = require("../lib/log");

/** Check whether the OOR timeout has expired (position continuously OOR). */
function _isTimeoutExpired(bs, gc) {
  const t = gc?.("rebalanceTimeoutMin") ?? config.REBALANCE_TIMEOUT_MIN;
  return t > 0 && bs.oorSince && Date.now() - bs.oorSince >= t * 60_000;
}

/** Check whether the price has moved beyond the OOR threshold. */
function _isBeyondThreshold(poolState, position, gc) {
  const threshPct =
    (gc?.("rebalanceOutOfRangeThresholdPercent") ??
      config.REBALANCE_OOR_THRESHOLD_PCT) / 100;
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

/** Apply the position's saved throttle settings to the live throttle on
 *  each poll cycle, read through `gc` from the settings held in memory. */
function _reloadFromConfig(gc, throttle) {
  throttle.configure({
    minIntervalMs:
      (gc("minRebalanceIntervalMin") || config.MIN_REBALANCE_INTERVAL_MIN) *
      60_000,
    dailyMax: gc("maxRebalancesPerDay") || config.MAX_REBALANCES_PER_DAY,
  });
}

module.exports = { _isTimeoutExpired, _isBeyondThreshold, _reloadFromConfig };
