/**
 * @file scripts/gentle-stop.js
 * @description Stop the LP Ranger server once no rebalance or compound is
 *   under way (`npm run gentle-stop`).
 *
 *   `npm stop` and Ctrl+C are a force-stop: the server exits within its
 *   exit timeout, three seconds as shipped, whether or not a rebalance or
 *   compound is under way, and one cut off partway can leave a position's
 *   coins in the wallet rather than in the pool. This script asks first. It
 *   asks the server `GET /api/is-position-being-adjusted` at once, and then
 *   every `gentleStopPollMs` (app-runtime.json → shutdown, five minutes as
 *   shipped). While the answer is yes it says so and waits. Once the answer
 *   is no, it stops the server exactly as `npm stop` does (`stopServer` in
 *   scripts/stop.js) and exits.
 *
 *   Only that answer stops the server. A question the server does not
 *   answer within the interval, or answers with anything else, is asked
 *   again at the next one: a server too busy to answer may be busy with a
 *   rebalance. A refused connection is the one exception: nothing is
 *   listening at the server's address, so there is no server to stop, and
 *   the script says so and exits.
 *
 *   The server is asked at the address it listens on, HOST and PORT as it
 *   resolves them (src/runtime-flags.js).
 */

"use strict";

const http = require("http");
const { log } = require("../src/log");
const { HOST, PORT } = require("../src/runtime-flags");
const { readShutdownTimings } = require("../src/shutdown-timing");
const { stopServer } = require("./stop");

const _PATH = "/api/is-position-being-adjusted";

/**
 * Read the server's answer from a finished response.
 *
 * @param {number} status  HTTP status.
 * @param {string} text    Response body.
 * @returns {{state: string, detail?: string}}
 */
function _readAnswer(status, text) {
  if (status !== 200) return { state: "silent", detail: `HTTP ${status}` };
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { state: "silent", detail: "an answer that is not JSON" };
  }
  if (body.adjusting === false) return { state: "clear" };
  if (body.adjusting === true) return { state: "busy" };
  return { state: "silent", detail: "an answer with no adjusting flag" };
}

/**
 * Ask the server once whether a rebalance or compound is under way.
 *
 * @param {object} o
 * @param {string} o.host
 * @param {number} o.port
 * @param {number} o.timeoutMs  How long the server has to answer.
 * @returns {Promise<{state: "clear"|"busy"|"silent"|"refused", detail?: string}>}
 *   `clear` and `busy` are the server's two answers. `refused` means
 *   nothing listens at the address. `silent` is everything else, with
 *   what happened in `detail`.
 */
function askAdjusting({ host, port, timeoutMs }) {
  return new Promise((resolve) => {
    const req = http.get(
      { host, port, path: _PATH, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve(
            _readAnswer(res.statusCode, Buffer.concat(chunks).toString()),
          ),
        );
      },
    );
    req.on("timeout", () =>
      req.destroy(new Error(`no answer within ${timeoutMs} ms`)),
    );
    req.on("error", (err) =>
      resolve(
        err.code === "ECONNREFUSED"
          ? { state: "refused" }
          : { state: "silent", detail: err.message },
      ),
    );
  });
}

/** A wait in words for the log: whole minutes, else seconds. */
function _inWords(ms) {
  const minutes = ms / 60_000;
  if (Number.isInteger(minutes))
    return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  return `${Math.round(ms / 1000)} seconds`;
}

/**
 * Ask until the server gives the all-clear, then stop it.
 *
 * Each question goes out `pollMs` after the one before it, however long
 * that one took to be answered.
 *
 * @param {object} deps
 * @param {Function} deps.ask      `() => Promise<answer>`: one question.
 * @param {Function} deps.stop     Stops the server, as `npm stop` does.
 * @param {Function} deps.sleep    `(ms) => Promise<void>`.
 * @param {Function} deps.now      `() => number`, in milliseconds.
 * @param {number}   deps.pollMs   The time from one question to the next.
 * @param {string}   deps.address  The server's address, for the log.
 * @returns {Promise<"stopped"|"absent">}  Whether a server was stopped,
 *   or none was answering.
 */
async function runGentleStop({ ask, stop, sleep, now, pollMs, address }) {
  for (;;) {
    const askedAt = now();
    const answer = await ask();
    if (answer.state === "clear") {
      log.info("No rebalance or compound is under way -- stopping the server");
      await stop();
      return "stopped";
    }
    if (answer.state === "refused") {
      log.info(
        "No LP Ranger server is answering at %s -- nothing to stop",
        address,
      );
      return "absent";
    }
    const why =
      answer.state === "busy"
        ? "A rebalance or compound is under way"
        : `The server gave no answer (${answer.detail})`;
    log.info("%s -- asking again in %s", why, _inWords(pollMs));
    await sleep(Math.max(0, askedAt + pollMs - now()));
  }
}

if (require.main === module) {
  const { gentleStopPollMs } = readShutdownTimings();
  const address = `${HOST}:${PORT}`;
  log.info(
    "Asking the LP Ranger server at %s whether a rebalance or compound is under way...",
    address,
  );
  runGentleStop({
    ask: () =>
      askAdjusting({ host: HOST, port: PORT, timeoutMs: gentleStopPollMs }),
    stop: stopServer,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    pollMs: gentleStopPollMs,
    address,
  });
}

module.exports = { askAdjusting, runGentleStop };
