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
 *   shipped). While the answer is yes it says so and waits.
 *
 *   Once the answer is no, it asks the server to stop itself
 *   (`POST /api/shutdown`) rather than signalling it. The server stops
 *   each position, waits for a rebalance or compound under way to finish,
 *   and exits. A position's check can still begin a move in the moment
 *   between the all-clear and the request, and a signal's three-second
 *   exit would cut that move off; the server's own stop lets it finish.
 *   The script then waits until the server has exited, so whatever runs
 *   after it, an upgrade say, finds the server gone.
 *
 *   Only that answer stops the server. A question the server does not
 *   answer within the interval, or answers with anything else, is asked
 *   again at the next one: a server too busy to answer may be busy with a
 *   rebalance. A stop request the server does not take is likewise sent
 *   again at the next interval. A refused connection is the one exception:
 *   nothing is listening at the server's address, so there is no server
 *   to stop, and the script says so and exits.
 *
 *   The server is asked at the address it listens on, HOST and PORT as it
 *   resolves them (src/server-address.js). No other setting is read, so
 *   one an operator has just got wrong does not keep this from stopping
 *   the server that is running.
 */

"use strict";

const http = require("http");
const { log } = require("../src/log");
const { serverHost, serverPort } = require("../src/server-address");
const { readShutdownTimings } = require("../src/shutdown-timing");
const { readPid } = require("../src/server-pid");
const { isAlive } = require("./stop");

const _PATH = "/api/is-position-being-adjusted";

/**
 * Send one request to the server and gather its answer.
 *
 * @param {object} o
 * @param {string} o.host
 * @param {number} o.port
 * @param {string} o.path
 * @param {number} o.timeoutMs      How long the server has to answer.
 * @param {string} [o.method]       GET unless given.
 * @param {object} [o.headers]
 * @param {string} [o.body]
 * @returns {Promise<{status: number, text: string}|{error: Error}>}
 */
function _request({ host, port, path, timeoutMs, method, headers, body }) {
  return new Promise((resolve) => {
    const req = http.request(
      { host, port, path, method, headers, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            text: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on("timeout", () =>
      req.destroy(new Error(`no answer within ${timeoutMs} ms`)),
    );
    req.on("error", (error) => resolve({ error }));
    req.end(body);
  });
}

/** A request that got no answer: refused when nothing listens. */
const _noAnswer = (err) =>
  err.code === "ECONNREFUSED"
    ? { state: "refused" }
    : { state: "silent", detail: err.message };

/** The parsed body of an answer, or undefined when it is not JSON. */
function _json(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Read the server's answer from a finished response.
 *
 * @param {number} status  HTTP status.
 * @param {string} text    Response body.
 * @returns {{state: string, detail?: string}}
 */
function _readAnswer(status, text) {
  if (status !== 200) return { state: "silent", detail: `HTTP ${status}` };
  const body = _json(text);
  if (body === undefined)
    return { state: "silent", detail: "an answer that is not JSON" };
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
async function askAdjusting({ host, port, timeoutMs }) {
  const r = await _request({ host, port, path: _PATH, timeoutMs });
  if (r.error !== undefined) return _noAnswer(r.error);
  return _readAnswer(r.status, r.text);
}

/**
 * Ask the server to stop itself (`POST /api/shutdown`). The request
 * carries a CSRF token, as every request that changes something must,
 * taken first from `GET /api/csrf-token`.
 *
 * @param {object} o  As for `askAdjusting`.
 * @returns {Promise<{state: "stopping"|"silent"|"refused", detail?: string}>}
 *   `stopping` once the server has taken the request; `refused` and
 *   `silent` as for `askAdjusting`.
 */
async function askToStop({ host, port, timeoutMs }) {
  const t = await _request({ host, port, path: "/api/csrf-token", timeoutMs });
  if (t.error !== undefined) return _noAnswer(t.error);
  const token = t.status === 200 ? _json(t.text)?.token : undefined;
  if (typeof token !== "string")
    return { state: "silent", detail: `no CSRF token (HTTP ${t.status})` };
  const r = await _request({
    host,
    port,
    path: "/api/shutdown",
    method: "POST",
    headers: { "x-csrf-token": token, "content-type": "application/json" },
    body: "{}",
    timeoutMs,
  });
  if (r.error !== undefined) return _noAnswer(r.error);
  return r.status === 200
    ? { state: "stopping" }
    : { state: "silent", detail: `HTTP ${r.status}` };
}

/**
 * Wait until the server has exited: its PID file gone, as a server that
 * stops itself leaves it, or naming a process no longer running. There
 * is no deadline, since the server first finishes a rebalance or
 * compound under way, however long that takes.
 *
 * @param {object} deps
 * @param {Function} deps.isRunning   `() => boolean`.
 * @param {Function} deps.sleep       `(ms) => Promise<void>`.
 * @param {number}   deps.intervalMs  How often to look.
 * @returns {Promise<void>}
 */
async function waitForServerExit({ isRunning, sleep, intervalMs }) {
  while (isRunning()) await sleep(intervalMs);
}

/** A wait in words for the log: whole minutes, else seconds. */
function _inWords(ms) {
  const minutes = ms / 60_000;
  if (Number.isInteger(minutes))
    return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  return `${Math.round(ms / 1000)} seconds`;
}

/**
 * Ask until the server gives the all-clear, then have it stop itself.
 *
 * Each question goes out `pollMs` after the one before it, however long
 * that one took to be answered; a stop request the server does not take
 * is sent again on the same schedule.
 *
 * @param {object} deps
 * @param {Function} deps.ask      `() => Promise<answer>`: one question.
 * @param {Function} deps.stop     `() => Promise<answer>`: asks the
 *   server to stop itself, and once it has taken that, waits for it to
 *   exit; `askToStop`'s answers.
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
    const outcome = answer.state === "clear" ? await _stopNow(stop) : answer;
    if (outcome.state === "stopping") return "stopped";
    if (outcome.state === "refused") {
      log.info(
        "No LP Ranger server is answering at %s -- nothing to stop",
        address,
      );
      return "absent";
    }
    log.info("%s -- asking again in %s", _why(outcome), _inWords(pollMs));
    await sleep(Math.max(0, askedAt + pollMs - now()));
  }
}

/**
 * Ask the server to stop, after its all-clear, and say how that went.
 * @param {Function} stop  As for `runGentleStop`.
 * @returns {Promise<{state: string, detail?: string}>}  `stopping` and
 *   `refused` as `askToStop` answers them, and `unstopped` for a request
 *   the server did not take.
 */
async function _stopNow(stop) {
  log.info(
    "No rebalance or compound is under way -- asking the server to stop",
  );
  const stopping = await stop();
  if (stopping.state === "stopping") log.info("✔ Stopped");
  return stopping.state === "silent"
    ? { state: "unstopped", detail: stopping.detail }
    : stopping;
}

/** Why the script waits another interval, in words for the log. */
function _why(outcome) {
  if (outcome.state === "busy") return "A rebalance or compound is under way";
  if (outcome.state === "unstopped")
    return `The server did not take the stop (${outcome.detail})`;
  return `The server gave no answer (${outcome.detail})`;
}

if (require.main === module) {
  const { gentleStopPollMs, checkIntervalMs } = readShutdownTimings();
  const host = serverHost();
  const port = serverPort();
  const address = `${host}:${port}`;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  log.info(
    "Asking the LP Ranger server at %s whether a rebalance or compound is under way...",
    address,
  );
  runGentleStop({
    ask: () => askAdjusting({ host, port, timeoutMs: gentleStopPollMs }),
    stop: async () => {
      const stopping = await askToStop({
        host,
        port,
        timeoutMs: gentleStopPollMs,
      });
      if (stopping.state === "stopping") {
        log.info(
          "The server is stopping: any rebalance or compound under way finishes first",
        );
        await waitForServerExit({
          isRunning: () => {
            const pid = readPid();
            return pid !== null && isAlive(pid);
          },
          sleep,
          intervalMs: checkIntervalMs,
        });
      }
      return stopping;
    },
    sleep,
    now: Date.now,
    pollMs: gentleStopPollMs,
    address,
  });
}

module.exports = {
  askAdjusting,
  askToStop,
  waitForServerExit,
  runGentleStop,
};
