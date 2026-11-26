"use strict";

/**
 * @file test/helpers/rebalance-log.js
 * @description Points the rebalance log at a file of a test's own.
 *   src/lib/config.js reads LOG_FILE each time the log is read or written
 *   (`rebalanceLogPath`), so setting it takes effect at once, with no
 *   module loaded afresh.
 */

/**
 * Point the rebalance log at `file`, and answer a function that puts back
 * what LOG_FILE held before.
 * @param {string} file
 * @returns {() => void}
 */
function useRebalanceLog(file) {
  /*-
   *  TEST-ONLY global swap: the log's path is read from the environment;
   *  the function answered puts LOG_FILE back.
   */
  const saved = process.env.LOG_FILE;
  process.env.LOG_FILE = file;
  return () => {
    if (saved === undefined) delete process.env.LOG_FILE;
    else process.env.LOG_FILE = saved;
  };
}

module.exports = { useRebalanceLog };
