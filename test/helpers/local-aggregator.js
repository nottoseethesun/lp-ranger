"use strict";

/**
 * @file test/helpers/local-aggregator.js
 * @description A local aggregator standing in for the live one, for a
 *   test whose swap asks for a quote but is not about the aggregator's
 *   own handling, which test/helpers/aggregator-harness.js stages.
 *
 *   The fixtures swap made-up tokens, which the live aggregator refuses,
 *   so a swap there goes on to the V3 router. Asked for real, the test
 *   waits on a third party and passes only while it keeps refusing. This
 *   is a local http server that refuses every quote the way an unknown
 *   token is refused, or answers as a case tells it, and the active
 *   chain's aggregator url points at it while it runs, so each quote
 *   still travels through Node's own `fetch` and the swap's own handling
 *   of the answer.
 */

const http = require("http");
const config = require("../../src/config");

/** The refusal, in the shape a 0x v1 aggregator gives an unknown token. */
const REFUSAL = {
  code: 100,
  reason: "Validation Failed",
  validationErrors: [
    { field: "sellToken", code: 1001, reason: "Invalid token address" },
  ],
};

/**
 * Start the local aggregator, refusing every quote.
 * @returns {Promise<{answer: Function, refuse: Function, stop: Function}>}
 *   `answer(status, body)` gives every later quote that answer, and
 *   `refuse()` goes back to refusing; `stop()` puts the aggregator url
 *   back and closes the server.
 */
async function startLocalAggregator() {
  let reply = { status: 400, body: REFUSAL };
  const server = http.createServer((_req, res) => {
    res.writeHead(reply.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(reply.body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const saved = config.AGGREGATOR_URL;
  config.AGGREGATOR_URL = `http://127.0.0.1:${server.address().port}`;
  return {
    answer(status, body) {
      reply = { status, body };
    },
    refuse() {
      reply = { status: 400, body: REFUSAL };
    },
    async stop() {
      config.AGGREGATOR_URL = saved;
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { startLocalAggregator };
