/**
 * @file src/scan-state.js
 * @module scan-state
 * @description
 * Whether a scan is running on a position, and whether one may start:
 * the one answer every caller asks, from the server's routes to the bot
 * loop's own gates. Dependency-free; it reads and writes only the
 * position's bot state.
 *
 * A scan pass reads the chain and rebuilds the position's figures
 * (src/bot-recorder.js). A rebalance or compound made while one runs
 * changes what the scan is reading, and the scan's end then writes
 * figures that leave the move out: a rebalance loses the scan request it
 * makes (`_needsFullRescan` is one flag, and the running scan clears it),
 * so its deposits and its Activity Log figures wait for the next start;
 * a compound is left out of Fees Compounded until the next rebuild. So
 * the two are kept apart, in both directions:
 *
 * - **No move starts while a scan runs** (`isAscanRunningOnThisPosition`).
 *   The server refuses a Rebalance Now, a Compound Now and a re-open
 *   retried with Manage then, and the bot makes no automatic rebalance or
 *   compound until the scan ends.
 * - **No scan starts until every move of the position is cleared**
 *   (`isItOkayToStartAscan`): none while a poll decides a rebalance or
 *   compound, allowed or not (`duringMoveInitiation`), and none while a
 *   Rebalance Now or Compound Now waits to be made, for gas, say, however
 *   long it waits. A scan asked for then waits (`_scanWaiting`), and the
 *   bot loop starts it when the poll that clears the move ends.
 * - **No Reload Current Position or Re-scan Prices while a coin move is
 *   under way** (`isAcoinMoveUnderWayOnThisPosition`), over the same
 *   window: the server refuses both (src/server-reload-position.js). A
 *   move counts from the poll's first gate, before it holds the
 *   rebalance lock and raises `rebalanceInProgress` or
 *   `compoundInProgress`, to its end.
 *
 * A position runs one scan at a time, and holds back at most one: each
 * scan is the same whole operation, so the scans asked for while moves
 * waited resolve to the one `_scanWaiting` marks, and a scan asked for
 * while one runs is not run again.
 *
 * So the bot never holds a Rebalance Now or Compound Now for a scan: no
 * scan starts while one waits, and none is taken while a scan runs.
 *
 * The bot loop (src/bot-loop.js) marks each scan with `claimScanStart`
 * and `endScan`; the poll cycle (src/bot-cycle.js) decides each move
 * inside `duringMoveInitiation`.
 */

"use strict";

/**
 * Whether a scan is running on the position.
 * @param {object|null|undefined} botState  The position's bot state.
 * @returns {boolean}
 */
function isAscanRunningOnThisPosition(botState) {
  return botState?._scanRunning === true;
}

/*-
 *  A Rebalance Now or Compound Now asked for and not yet made. The
 *  residual cleanup's rebalance raises the same flag to pass the range
 *  check, but it is an automatic move, decided at each poll like any
 *  other (src/bot-cycle-residual.js): one the throttle or the daily cap
 *  holds back would otherwise hold the position's scans for hours.
 */
function _moveWaiting(botState) {
  if (botState?.forceCompound === true) return true;
  return (
    botState?.forceRebalance === true &&
    botState?.residualCleanupInProgress !== true
  );
}

/**
 * Whether a coin move, a rebalance or a compound, is under way on the
 * position: a poll is deciding or making one, from its first gate to its
 * end (`duringMoveInitiation`), or a Rebalance Now or Compound Now waits
 * to be made. A move's own `rebalanceInProgress` and `compoundInProgress`
 * go up only once it holds the rebalance lock, inside this window.
 * @param {object|null|undefined} botState  The position's bot state.
 * @returns {boolean}
 */
function isAcoinMoveUnderWayOnThisPosition(botState) {
  return (botState?._moveInitiations ?? 0) > 0 || _moveWaiting(botState);
}

/**
 * Whether a scan of the position may start now: no coin move is under way
 * on it, so no poll is deciding a rebalance or compound, and no Rebalance
 * Now or Compound Now waits to be made.
 * @param {object|null|undefined} botState  The position's bot state.
 * @returns {boolean}
 */
function isItOkayToStartAscan(botState) {
  return !isAcoinMoveUnderWayOnThisPosition(botState);
}

/**
 * Decide a move, allowed or not, with scans held back until it is over.
 * A scan asked for meanwhile waits for the poll's end.
 * @param {object|null|undefined} botState  The position's bot state.
 * @param {() => Promise<*>} fn  The move's decision and, if allowed, the
 *   move itself.
 * @returns {Promise<*>}  What `fn` returns.
 */
async function duringMoveInitiation(botState, fn) {
  if (botState === null || typeof botState !== "object") return fn();
  botState._moveInitiations = (botState._moveInitiations ?? 0) + 1;
  try {
    return await fn();
  } finally {
    botState._moveInitiations -= 1;
  }
}

/**
 * Claim the start of a scan: it starts when none is running and one may
 * start; when one may not, it waits.
 * @param {object} botState  The position's bot state.
 * @returns {boolean}  True when the caller is to run the scan now.
 */
function claimScanStart(botState) {
  if (isAscanRunningOnThisPosition(botState)) return false;
  if (!isItOkayToStartAscan(botState)) {
    botState._scanWaiting = true;
    return false;
  }
  botState._scanWaiting = false;
  botState._scanRunning = true;
  return true;
}

/**
 * Mark a scan ended.
 * @param {object} botState  The position's bot state.
 */
function endScan(botState) {
  botState._scanRunning = false;
}

module.exports = {
  isAscanRunningOnThisPosition,
  isAcoinMoveUnderWayOnThisPosition,
  isItOkayToStartAscan,
  duringMoveInitiation,
  claimScanStart,
  endScan,
};
