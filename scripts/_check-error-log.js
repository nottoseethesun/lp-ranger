/**
 * @file scripts/_check-error-log.js
 * @description Where `npm run check` keeps what its tests wrote to the
 *   error log: `error-npm-run-check.log`, beside the error log wherever
 *   logging.json puts it. scripts/check.js writes it and `npm run clean`
 *   deletes it, so both ask this; check.js cannot be required for it,
 *   since loading it runs the whole check.
 *   The leading underscore marks this as a non-user-facing helper.
 */

"use strict";

const path = require("path");

/**
 * The check's error log, beside the error log.
 * @param {string} errorLogPath  The error log's path, as logging.json
 *   gives it or resolved.
 * @returns {string} The same kind of path, relative or absolute.
 */
function checkErrorLogPath(errorLogPath) {
  return path.join(path.dirname(errorLogPath), "error-npm-run-check.log");
}

module.exports = { checkErrorLogPath };
