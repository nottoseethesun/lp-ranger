/**
 * @file scripts/gentle-stop.js
 * @description Stop the LP Ranger server once nothing it has under way is
 *   left (`npm run gentle-stop`).
 *
 *   `npm stop` and Ctrl+C are a force-stop: the server exits within its
 *   exit timeout, three seconds as shipped, whatever is under way. A
 *   rebalance or compound cut off partway can leave a position's coins in
 *   the wallet rather than in the pool, and a scan cut off leaves the
 *   position's figures short of the rebalance it followed.
 *
 *   This script asks the server to stop itself once nothing is under way
 *   (`POST /api/stop-when-all-clear`). The server holds that stop: from
 *   the request on it starts nothing new, and it exits once each
 *   rebalance or compound under way, and each scan running, has
 *   finished (src/stop-when-all-clear.js). The server decides when, so
 *   no check can begin a move between an all-clear and the stop, as one
 *   could while this script asked first and stopped after.
 *
 *   It sends the request again every `gentleStopPollMs` (app-runtime.json
 *   → shutdown, two seconds as shipped). A request after the first
 *   changes nothing; each answer says what the stop still waits for,
 *   which the script prints when it changes, and once a minute while it
 *   stays the same. Once nothing answers at the server's address, the
 *   script waits until the server's process has exited, so whatever runs
 *   after it, an upgrade say, finds the server gone.
 *
 *   A request the server does not answer within the interval, or answers
 *   with anything else, is sent again at the next one. A refused
 *   connection before the server has taken the stop is the one exception:
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

const _PATH = "/api/stop-when-all-clear";

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

/** Whether an entry of the answer names a position and what it does. */
const _isUnderWay = (u) =>
  typeof u?.position === "string" && typeof u?.activity === "string";

/**
 * Read the server's answer to a stop request.
 *
 * @param {number} status  HTTP status.
 * @param {string} text    Response body.
 * @returns {{state: string, detail?: string, waitingFor?: object[]}}
 */
function _readStopAnswer(status, text) {
  if (status !== 200) return { state: "silent", detail: `HTTP ${status}` };
  const body = _json(text);
  if (body === undefined)
    return { state: "silent", detail: "an answer that is not JSON" };
  if (!Array.isArray(body.waitingFor))
    return { state: "silent", detail: "an answer with no waitingFor list" };
  return { state: "holding", waitingFor: body.waitingFor.filter(_isUnderWay) };
}

/**
 * Ask the server to stop once nothing is under way
 * (`POST /api/stop-when-all-clear`). The request carries a CSRF token, as
 * every request that changes something must, taken first from
 * `GET /api/csrf-token`.
 *
 * @param {object} o
 * @param {string} o.host
 * @param {number} o.port
 * @param {number} o.timeoutMs  How long the server has to answer each.
 * @returns {Promise<{state: "holding"|"silent"|"refused", detail?: string,
 *   waitingFor?: Array<{position: string, activity: string}>}>}
 *   `holding` once the server holds the stop, with what it still waits
 *   for. `refused` means nothing listens at the address. `silent` is
 *   everything else, with what happened in `detail`.
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
    path: _PATH,
    method: "POST",
    headers: { "x-csrf-token": token, "content-type": "application/json" },
    body: "{}",
    timeoutMs,
  });
  if (r.error !== undefined) return _noAnswer(r.error);
  return _readStopAnswer(r.status, r.text);
}

/**
 * Wait until the server has exited: its PID file gone, as a server that
 * stops itself leaves it, or naming a process no longer running. There
 * is no deadline, since the server first finishes what it has under way,
 * however long that takes.
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

/** What an answer says, in words for the log. */
function _say(answer, pollMs) {
  if (answer.state !== "holding")
    return `The server gave no answer (${answer.detail}) -- asking again in ${_inWords(pollMs)}`;
  if (answer.waitingFor.length === 0)
    return "Nothing is under way -- the server is exiting";
  return (
    "Waiting for: " +
    answer.waitingFor.map((u) => `${u.activity} of ${u.position}`).join("; ")
  );
}

/**
 * The end of the run: a server that took the stop has stopped answering,
 * so wait for its process to exit; one that never took it was not there.
 */
async function _ended(takenAt, address, waitForExit) {
  if (takenAt === null) {
    log.info(
      "No LP Ranger server is answering at %s -- nothing to stop",
      address,
    );
    return "absent";
  }
  await waitForExit();
  log.info("✔ Stopped");
  return "stopped";
}

/**
 * Ask the server to stop once nothing is under way, and keep asking,
 * saying what the stop waits for, until the server has exited.
 *
 * Each request goes out `pollMs` after the one before it, however long
 * that one took to be answered.
 *
 * @param {object} deps
 * @param {Function} deps.stop     `() => Promise<answer>`: one stop
 *   request; `askToStop`'s answers.
 * @param {Function} deps.waitForExit  `() => Promise<void>`: resolves
 *   once the server's process has exited.
 * @param {Function} deps.sleep    `(ms) => Promise<void>`.
 * @param {Function} deps.now      `() => number`, in milliseconds.
 * @param {number}   deps.pollMs   The time from one request to the next.
 * @param {string}   deps.address  The server's address, for the log.
 * @returns {Promise<"stopped"|"absent">}  Whether a server was stopped,
 *   or none was answering.
 */
async function runGentleStop({
  stop,
  waitForExit,
  sleep,
  now,
  pollMs,
  address,
}) {
  let takenAt = null;
  let said = null;
  let minutesSaid = 0;
  for (;;) {
    const askedAt = now();
    const answer = await stop();
    if (answer.state === "refused")
      return _ended(takenAt, address, waitForExit);
    if (answer.state === "holding" && takenAt === null) {
      takenAt = askedAt;
      log.info(
        "The server took the stop: it starts nothing new, and exits once nothing is under way",
      );
    }
    const text = _say(answer, pollMs);
    const minutes =
      takenAt === null ? 0 : Math.floor((askedAt - takenAt) / 60_000);
    if (text !== said) log.info(text);
    else if (minutes > minutesSaid)
      log.info("%s (%d min so far)", text, minutes);
    said = text;
    minutesSaid = minutes;
    await sleep(Math.max(0, askedAt + pollMs - now()));
  }
}

if (require.main === module) {
  const { gentleStopPollMs, checkIntervalMs } = readShutdownTimings();
  const host = serverHost();
  const port = serverPort();
  const address = `${host}:${port}`;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  log.info(
    "Asking the LP Ranger server at %s to stop once nothing is under way...",
    address,
  );
  runGentleStop({
    stop: () => askToStop({ host, port, timeoutMs: gentleStopPollMs }),
    waitForExit: () =>
      waitForServerExit({
        isRunning: () => {
          const pid = readPid();
          return pid !== null && isAlive(pid);
        },
        sleep,
        intervalMs: checkIntervalMs,
      }),
    sleep,
    now: Date.now,
    pollMs: gentleStopPollMs,
    address,
  });
}

module.exports = {
  askToStop,
  waitForServerExit,
  runGentleStop,
};
