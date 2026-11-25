"use strict";

/**
 * @file src/lib/rebalance-log-setting.js
 * @module rebalanceLogSetting
 * @description Where the operator has set the rebalance log to be:
 *   LOG_FILE in `.env`, else `log.file` in app-runtime.json, an
 *   operator's copy applied. The app asks it through `rebalanceLogPath`
 *   (src/lib/config.js), which gives a test process a file of its own
 *   under `node --test`; `npm run clean` (scripts/clean.js) asks it to
 *   find the log it removes, without loading config.js, so a bad setting
 *   elsewhere never stops a clean. One rule for both, so they never
 *   disagree on where the log is.
 */

const { readEnv } = require("./env-settings");
const { loadMergedDefaults } = require("./load-merged-defaults");

/**
 * The rebalance log's path as set: LOG_FILE, else `log.file`. Relative
 * to the working folder unless absolute. LOG_FILE is read from the
 * environment, so `.env` counts only once it is loaded.
 * @param {string} [logFileSetting]  `log.file` as already read, as
 *   config.js holds it; read from app-runtime.json when not given.
 * @returns {string}
 */
function rebalanceLogSetting(logFileSetting) {
  const named = readEnv("LOG_FILE");
  if (named !== undefined) return named;
  if (logFileSetting !== undefined) return logFileSetting;
  return loadMergedDefaults("app-runtime.json").log.file;
}

module.exports = { rebalanceLogSetting };
