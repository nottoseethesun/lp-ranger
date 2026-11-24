/**
 * @file src/bot/app-phase.js
 * @module app-phase
 * @description
 * What the app as a whole is doing, where that decides whether anything
 * may start: the single source of truth for three phases, read by every
 * start of a position and by each request that would start one.
 *
 * The first phase is the start-up. Once the wallet is unlocked, the app
 * starts each position saved as managed (`status: "running"` in
 * bot-config.json), one at a time, spread over a poll interval. While it
 * works through that list, a request that would start positions (a
 * Manage, a wallet import) is refused, since it would change the list or
 * the wallet the start-up is working from, and the dashboard's badge
 * reads Syncing. One start-up runs at a time: asked for again while one
 * is under way, as a second unlock would, it does nothing, since the
 * first covers the same positions.
 *
 * The second phase is a wallet import. It stops every position, swaps
 * the wallet and the key the bot signs with, and ends with a start-up of
 * the new wallet's saved positions. From its first step until that
 * start-up has finished, a Manage is refused, and so is a second import:
 * a Manage then could start a loop signing with the old wallet's key, or
 * leave that key to the new wallet's positions. The dashboard's badge
 * reads Syncing meanwhile.
 *
 * The third phase is the stop for good: Ctrl+C or `npm stop`, which
 * signal the server, or the server's stop route, which
 * `npm run gentle-stop` asks for. From then on no position starts and no
 * rebalance or compound begins, and nothing clears it, since the process
 * ends. A wallet import stops every position too, but starts the new
 * wallet's again, so it is no stop for good and does not set this phase.
 */

"use strict";

// Set by a stop for good.
let _stopping = false;

/*-
 *  While the start-up is under way, how many of the saved positions it
 *  has dealt with, and how many there are; null at any other time.
 */
let _startUp = null;

// Set while a wallet import is under way, its closing start-up included.
let _importing = false;

/** Record that the app is stopping for good. */
function markStopping() {
  _stopping = true;
}

/**
 * Whether the app is stopping for good.
 * @returns {boolean}
 */
function isStopping() {
  return _stopping;
}

/**
 * Begin the start-up of `total` saved positions, unless one is already
 * under way or the app is stopping.
 * @param {number} total  How many positions are saved as managed.
 * @returns {boolean} Whether this call began it. When false, the caller
 *   starts nothing.
 */
function beginStartUp(total) {
  if (_stopping || _startUp !== null) return false;
  _startUp = { done: 0, total };
  return true;
}

/**
 * Record that the start-up has dealt with `done` of its positions,
 * started or passed over.
 * @param {number} done
 */
function noteStartUpProgress(done) {
  if (_startUp !== null) _startUp.done = done;
}

/** End the start-up. */
function endStartUp() {
  _startUp = null;
}

/**
 * The start-up's progress while it is under way, or null.
 * @returns {{done: number, total: number}|null}
 */
function startUpProgress() {
  return _startUp === null ? null : { ..._startUp };
}

/**
 * Begin a wallet import, unless the app may start nothing now: while it
 * is stopping, while a start-up or another import is under way. The
 * import's own closing start-up still begins, since `beginStartUp` does
 * not ask about an import.
 * @returns {string|null} Why the import is refused, or null when this
 *   call began it, in which case the caller ends it with
 *   `endWalletImport` however the import goes.
 */
function beginWalletImport() {
  const refusal = refusalToStart();
  if (refusal === null) _importing = true;
  return refusal;
}

/** End the wallet import. */
function endWalletImport() {
  _importing = false;
}

/**
 * Whether a wallet import is under way, its closing start-up included.
 * @returns {boolean}
 */
function walletImportUnderWay() {
  return _importing;
}

/**
 * Why a request that would start positions must be refused now, in the
 * operator's words, or null when it may go ahead. During an import's
 * closing start-up, the start-up's progress is named.
 * @returns {string|null}
 */
function refusalToStart() {
  if (_stopping) return "LP Ranger is stopping, so nothing starts.";
  if (_startUp !== null)
    return (
      "LP Ranger is still starting the positions it manages " +
      `(${_startUp.done} of ${_startUp.total}). ` +
      "Try again once it has started them."
    );
  if (_importing)
    return (
      "LP Ranger is importing a wallet. " +
      "Try again once it has started that wallet's positions."
    );
  return null;
}

/** Back to a process that has neither started up, imported, nor begun stopping. */
function _resetAppPhaseForTests() {
  _stopping = false;
  _startUp = null;
  _importing = false;
}

module.exports = {
  markStopping,
  isStopping,
  beginStartUp,
  noteStartUpProgress,
  endStartUp,
  startUpProgress,
  beginWalletImport,
  endWalletImport,
  walletImportUnderWay,
  refusalToStart,
  _resetAppPhaseForTests,
};
