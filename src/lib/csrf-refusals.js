"use strict";

/**
 * @file src/lib/csrf-refusals.js
 * @module csrf-refusals
 * @description
 * The reasons the server refuses a request's CSRF token, one for each
 * check the token can fail (`verifyToken`, src/lib/server-csrf.js), sent as
 * the 403 answer's `error`. Every one of them means the page holds no
 * token this server process accepts, so the dashboard's `fetchWithCsrf`
 * (src/client/web/dashboard-helpers.js) answers any of them the same way: it
 * fetches a fresh token and sends the request once more. A restart is
 * the common case, since the server makes a new secret when it starts
 * and every token the page held then reads as invalid.
 *
 * **Deliberately dependency-free**, as `src/lib/centered-offset.js` is: the
 * dashboard bundle reaches it.
 *
 * Add no `require` to this file.
 */

const CSRF_REFUSALS = Object.freeze({
  missing: "Missing x-csrf-token header",
  invalid: "Invalid CSRF token",
  unknown: "Unknown CSRF token",
  expired: "Expired CSRF token",
});

module.exports = { CSRF_REFUSALS };
