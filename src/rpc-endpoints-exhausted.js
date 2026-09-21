/**
 * @file src/rpc-endpoints-exhausted.js
 * @module rpcEndpointsExhausted
 * @description
 * What happens when RPC failover has tried every endpoint and none
 * answered.
 *
 * Lives apart from `src/send-transaction.js` for the same reason
 * `src/rpc-read-retry.js` does: this is a self-contained decision, not
 * part of endpoint selection. It takes no state of its own — the caller
 * owns the endpoint list and the sticky window, and is handed back the
 * deadline to apply.
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
 *   2. **The list restarts from the first endpoint when the pause is
 *      up**, so later failovers walk it in the order they walked it at
 *      startup. Selection does not move meanwhile — the app sits on the
 *      endpoint it was on. This function does not do that part: it
 *      returns the deadline, and the caller feeds it to the snapback it
 *      already has.
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
 * @returns {number} Epoch ms the pause runs until, for the caller's
 *   snapback; 0 when the pause is configured off, which restarts the
 *   list on the next read.
 */
function pauseForExhaustedEndpoints({ endpointCount, lastUrl }) {
  const pauseMs = readBotConfigDefaults().rpcAllEndpointsDownPauseMS;
  /*- A pause of 0 is an operator turning the wait off, not a bad read:
   *  `halt` ignores it, the list still restarts, and the bot goes on
   *  retrying dead endpoints at the normal pace. The line still prints,
   *  because "every endpoint failed" is worth saying either way. */
  rpcRequestManager.halt(pauseMs);
  /*- Hours is the unit; the value is whatever the division gives.  Six
   *  decimal places so a short wait still reads as a number rather than
   *  as zero, and `Number` drops the trailing zeros — the default reads
   *  "1 HOUR(S)", half an hour reads "0.5", a hundred milliseconds
   *  reads "0.000028". */
  const hours = Number((pauseMs / 3_600_000).toFixed(6));
  const holding =
    pauseMs > 0
      ? `PAUSING ALL RPC REQUESTS FOR ${hours} HOUR(S), THEN RESTARTING`
      : "PAUSE IS DISABLED — RESTARTING IMMEDIATELY";
  log.warn(
    `${BANNER_ON}[SEND-TX] ALL %d RPC ENDPOINT(S) FAILED — LAST WAS %s. ` +
      `%s FROM THE FIRST ENDPOINT.${BANNER_OFF}`,
    endpointCount,
    String(lastUrl).toUpperCase(),
    holding,
  );
  return pauseMs > 0 ? Date.now() + pauseMs : 0;
}

module.exports = { pauseForExhaustedEndpoints };
