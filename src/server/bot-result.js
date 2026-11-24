/**
 * @file src/server/bot-result.js
 * @description How the server answers with what the bot returned. A bot
 * operation (src/bot/bot-interface.js) knows nothing of HTTP: it returns
 * `ok: true` with the answer's fields, or `ok: false` with one of four
 * reasons beside them. This module is the one place a reason becomes an
 * HTTP status; the reason itself is the server's to read and is left out
 * of the answer, which keeps the fields the bot gave it.
 *
 *   invalid      400  the request lacks or misnames something
 *   missing      404  the position it names is not one the bot can find
 *   refused      409  the bot will not do it now (the app is starting or
 *                     stopping, a scan is running, the pool is held)
 *   unavailable  503  a read from the chain failed; ask again later
 *   failed       500  it went wrong
 */

"use strict";

/** Each reason a bot operation may give, and the HTTP status it answers with. */
const STATUS_FOR_REASON = Object.freeze({
  invalid: 400,
  missing: 404,
  refused: 409,
  unavailable: 503,
  failed: 500,
});

/**
 * The HTTP status for a bot operation's result.
 * @param {object} result  What the bot returned.
 * @returns {number}
 */
function statusOf(result) {
  if (result.ok) return 200;
  const status = STATUS_FOR_REASON[result.reason];
  if (status === undefined)
    throw new Error(`bot result with an unknown reason: ${result.reason}`);
  return status;
}

/**
 * Answer a request with what the bot returned: its status from
 * `STATUS_FOR_REASON`, its fields without the reason.
 * @param {Function} jsonResponse  `(res, status, body) => void`.
 * @param {import('http').ServerResponse} res
 * @param {object} result  What the bot returned.
 */
function sendBotResult(jsonResponse, res, result) {
  const status = statusOf(result);
  const body = { ...result };
  delete body.reason;
  jsonResponse(res, status, body);
}

module.exports = { STATUS_FOR_REASON, statusOf, sendBotResult };
