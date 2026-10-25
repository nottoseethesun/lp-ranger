/**
 * @file src/lib/scan-refusal.js
 * @module scan-refusal
 * @description
 * The words the server answers with when it refuses a move because a
 * scan is running on the position (src/lib/scan-state.js): a Rebalance Now,
 * a Compound Now, or a re-open retried with Manage. A move made during
 * the scan would be left out of the figures the scan rebuilds, so each
 * waits for the scan to end. Dependency-free.
 */

"use strict";

/**
 * The refusal's words.
 * @param {string} move  What the request would make: "rebalance" or
 *   "compound".
 * @param {string} then  How the move goes on once the scan ends.
 * @returns {string}
 */
function scanRunningRefusal(move, then) {
  return (
    "LP Ranger is reading this position's history from the blockchain." +
    ` A ${move} made during that read would be left out of the figures` +
    ` it rebuilds, so ${then}.`
  );
}

module.exports = { scanRunningRefusal };
