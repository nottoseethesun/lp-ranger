"use strict";

/**
 * @file src/bot-cycle-gates.js
 * @module bot-cycle-gates
 * @description
 * The gates an automatic rebalance passes before it is made, in order:
 * the bot's own state (paused, a scan under way), the throttle, the
 * pool's daily cap, then the Impermanent Loss Guard and the dry-run stop. A Rebalance Now passes them all but the dry-run stop,
 * which turns it down. It never meets a running scan here: the server
 * refuses one while a scan is running on the position, and no scan
 * starts while one waits (src/scan-state.js). Split out of
 * src/bot-cycle.js, which composes them (`_checkRebalanceGates`) and runs
 * them on each poll that finds the position out of range.
 *
 * The Guard is split from the gates before it so that, once the earlier
 * gates have passed, the figures it measures with can be worked out again
 * at fresh prices while price lookups are paused (`snapForGuard`). A
 * lookup is then spent only on a rebalance the bot is about to make.
 */

const config = require("./config");
const { log } = require("./log");
const { checkIlGuard, ilGuardWillMeasure } = require("./il-guard");
const { isPaused, withFreshPricesAllowed } = require("./price-fetcher-gate");
const { invalidatePriceCacheFor } = require("./price-fetcher");
const { updatePnlAndStats } = require("./bot-pnl-updater");
const { isAscanRunningOnThisPosition } = require("./scan-state");

/*- Bot-state gates checked before any throttle/pool/gas logic.  Every
 *  early-return here means the bot state itself vetoes the rebalance,
 *  so the throttle counters must NOT tick. */
function checkStateGates(deps, forced) {
  const st = deps._botState;
  if (!forced && st?.rebalancePaused)
    return { rebalanced: false, paused: true };
  /*- Reload / initial-scan window: while a scan runs (src/scan-state.js),
   *  the position's on-chain-derived state (compound history, HODL
   *  baseline, epochs) is being rebuilt from the chain.  A rebalance
   *  made mid-scan races the reconstruction, and the scan's end clears
   *  the rescan request the rebalance made, so its deposits and Activity
   *  Log figures wait for the next start.  No automatic rebalance is
   *  made then, the residual cleanup's included.  A Rebalance Now never
   *  gets here during a scan: the server refuses it, and no scan starts
   *  while one waits.  A scan waiting to start holds back no rebalance:
   *  it waits for the move, which goes first. */
  if (!forced && isAscanRunningOnThisPosition(st))
    return { rebalanced: false, scanRunning: true };
  return null;
}

/**
 * The gates before the Guard: bot state, throttle, the pool's daily cap.
 * @param {object} deps
 * @param {boolean} forced  A Rebalance Now.
 * @returns {object|null}  The poll's early result, or null to go on.
 */
function gatesBeforeGuard(deps, forced) {
  const { throttle } = deps;
  const stateGate = checkStateGates(deps, forced);
  if (stateGate) return stateGate;
  const can = !forced && throttle.canRebalance();
  if (can && !can.allowed) {
    log.info(
      `[bot] OOR but throttled (${can.reason}), wait ${Math.ceil(can.msUntilAllowed / 1000)}s`,
    );
    /*- No throttleState emit here: the unconditional top-of-pollCycle
     *  emit already published this cycle's snapshot. */
    return { rebalanced: false };
  }
  if (!forced && deps._canRebalancePool && deps._poolKey) {
    const pk = deps._poolKey(
      deps.position.token0,
      deps.position.token1,
      deps.position.fee,
    );
    const max =
      deps.throttle.getState().dailyMax || config.MAX_REBALANCES_PER_DAY;
    if (!deps._canRebalancePool(pk, max)) {
      log.info(
        "[bot] OOR but pool daily cap reached (%d/%d) — deferring",
        max,
        max,
      );
      return { rebalanced: false };
    }
  }
  return null;
}

/**
 * The Impermanent Loss Guard, then the dry-run stop.
 * @param {object} deps
 * @param {object} poolState
 * @param {boolean} forced
 * @param {object} snap  The figures the Guard measures with.
 * @param {Function} notifyPos  The position as the Guard's alert names it.
 * @returns {object|null}  The poll's early result, or null to go on.
 */
function gatesFromGuard(deps, poolState, forced, snap, notifyPos) {
  const ilGuard = checkIlGuard(deps, forced, snap, notifyPos);
  if (ilGuard) return ilGuard;
  if (deps.dryRun) {
    log.info(
      "[bot] DRY RUN — OOR, tick=%d range=[%d,%d]",
      poolState.tick,
      deps.position.tickLower,
      deps.position.tickUpper,
    );
    /*-
     *  A Rebalance Now the dry run turns down is over. Left asked for, it
     *  would hold the position's scans until a restart, since no scan
     *  starts while one waits (src/scan-state.js).
     */
    if (forced && deps._botState) deps._botState.forceRebalance = false;
    return { rebalanced: false };
  }
  return null;
}

/**
 * The figures the Impermanent Loss Guard measures with: worked out again
 * at fresh prices while price lookups are paused.
 *
 * The Guard compares the position with holding the coins its NFT was
 * minted with, at today's prices, and reads both from this poll's
 * figures. While price lookups are paused (the dashboard idle or closed,
 * and always under `npm run bot`), they carry the last prices fetched,
 * of any age.
 * A rebalance is due because the price has moved, so an old price makes
 * the loss look smaller than it is, and the Guard could let through the
 * rebalance it exists to stop. The figures are then worked out again
 * with fresh prices, once every gate before the Guard has passed and the
 * Guard will measure: one more price lookup per rebalance the bot is
 * about to make, as the gas check already pays.
 *
 * @param {object} deps
 * @param {object} poolState
 * @param {object} ethersLib
 * @param {boolean} forced  A Rebalance Now, which the Guard stands aside for.
 * @param {object} snap    This poll's figures.
 * @param {Function} [update]  What works the figures out; the poll's own
 *   `updatePnlAndStats` unless a test passes its own.
 * @returns {Promise<object>}  Figures for the Guard.
 */
async function snapForGuard(
  deps,
  poolState,
  ethersLib,
  forced,
  snap,
  update = updatePnlAndStats,
) {
  if (!ilGuardWillMeasure(deps, forced) || !isPaused()) return snap;
  invalidatePriceCacheFor([
    { token: deps.position.token0 },
    { token: deps.position.token1 },
  ]);
  return withFreshPricesAllowed(() => update(deps, poolState, ethersLib));
}

module.exports = {
  checkStateGates,
  gatesBeforeGuard,
  gatesFromGuard,
  snapForGuard,
};
