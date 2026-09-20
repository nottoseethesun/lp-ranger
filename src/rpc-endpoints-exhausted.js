/**
 * @file src/rpc-endpoints-exhausted.js
 * @module rpcEndpointsExhausted
 * @description
 * What happens when RPC failover has tried every endpoint and none
 * answered.
 *
 * Lives apart from `src/send-transaction.js` for the same reason
 * `src/rpc-read-retry.js` does: that module is at its 500-line cap, and
 * this is a self-contained decision rather than part of endpoint
 * selection. It takes no state of its own — the caller owns the endpoint
 * list and the sticky window, and is handed back the deadline to apply.
 */

"use strict";

const { log } = require("./log");
const { readBotConfigDefaults } = require("./bot-config-defaults");
const rpcRequestManager = require("./rpc-request-manager");

/*- Road Sign Yellow, #FFCC00. One literal: the terminal cannot read a
 *  CSS custom property, so the colour lives here and the escape below is
 *  built from it. */
const ROAD_SIGN_YELLOW_RGB = "255;204;0";

/*- Bold black on Road Sign Yellow. 1 = bold, 38;2;0;0;0 = black text,
 *  48;2;… = the background. Same 24-bit form `src/bot-banner.js` uses
 *  for the startup line, which is how this terminal renders colour. */
const BANNER_ON = `\x1b[1;38;2;0;0;0;48;2;${ROAD_SIGN_YELLOW_RGB}m`;
const BANNER_OFF = "\x1b[0m";

/**
 * Hold all RPC traffic, announce it, and report when to start over.
 *
 * Three things have to happen together when the list runs out:
 *
 *   1. **Every request is held** for the configured pause. With nothing
 *      answering, continuing to send only hammers dead hosts and buries
 *      the log in failures that all say the same thing. The hold is
 *      absolute — see `halt` in `src/rpc-request-manager.js`.
 *   2. **Selection returns to the first endpoint**, so the first request
 *      to leave once the pause lifts goes to the preferred endpoint and
 *      later failovers walk the list in the order they walked it at
 *      startup. The caller does that part — it owns the endpoint list —
 *      immediately after calling this.
 *   3. **One loud line** says so, because an hour of silence with no
 *      explanation looks exactly like a hung process.
 *
 * All capitals and a Road Sign Yellow ground, because this is the one
 * message an operator must not scroll past: every figure on the
 * dashboard stops advancing for the duration, and without this line
 * there is nothing to distinguish that from a crash.
 *
 * @param {object} o
 * @param {number} o.endpointCount  How many endpoints were tried.
 * @param {string} o.lastUrl        The endpoint that failed last.
 * @returns {void}
 */
function pauseForExhaustedEndpoints({ endpointCount, lastUrl }) {
  const pauseMs = readBotConfigDefaults().rpcAllEndpointsDownPauseMS;
  /*- A pause of 0 is an operator turning the wait off, not a bad read:
   *  `halt` ignores it, the list still restarts, and the bot goes on
   *  retrying dead endpoints at the normal pace. The line still prints,
   *  because "every endpoint failed" is worth saying either way. */
  rpcRequestManager.halt(pauseMs);
  /*- Say what actually happened. "PAUSING FOR 0 MINUTE(S)" would report
   *  a hold that was never taken. */
  const holding =
    pauseMs > 0
      ? `PAUSING ALL RPC REQUESTS FOR ${Math.round(pauseMs / 60_000)} MINUTE(S), THEN RESTARTING`
      : "PAUSE IS DISABLED — RESTARTING IMMEDIATELY";
  log.warn(
    `${BANNER_ON}[SEND-TX] ALL %d RPC ENDPOINT(S) FAILED — LAST WAS %s. ` +
      `%s FROM THE FIRST ENDPOINT.${BANNER_OFF}`,
    endpointCount,
    String(lastUrl).toUpperCase(),
    holding,
  );
}

/**
 * Is an all-endpoints-down pause running right now?
 *
 * Failover asks before moving. A failure reported while the pause runs
 * describes the very outage that started it — every endpoint was tried
 * moments ago — so acting on it would walk the list forward again and
 * leave selection somewhere in the middle when the pause lifts, instead
 * of at the first endpoint where exhaustion just put it. Two positions
 * failing within the same minute is all it takes.
 *
 * @returns {boolean}
 */
function endpointsArePaused() {
  return rpcRequestManager.haltRemainingMs() > 0;
}

module.exports = { pauseForExhaustedEndpoints, endpointsArePaused };
