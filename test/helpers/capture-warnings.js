"use strict";

/**
 * @file test/helpers/capture-warnings.js
 * @description Capture `log.warn` output as formatted strings, for the
 *   suites that assert on what an operator reads in the log.
 */

const { format } = require("node:util");
const { _setSinkForTests } = require("../../src/log");

/**
 * Capture `log.warn` output as formatted strings.
 *
 * Through the module's own test sink rather than by replacing `console`
 * — see [[feedback_no_global_monkey_patch]].  The sink receives the
 * printf format string and its arguments unexpanded, so `format` is
 * what turns "%d of %d" into the line an operator actually reads, which
 * is the thing worth asserting.
 *
 * @returns {{lines: string[], restore: Function}}  Call `restore` when
 *   done, in a `finally`, so a failing assertion cannot leave the sink
 *   redirected for the next test.
 */
function captureWarnings() {
  const lines = [];
  const restore = _setSinkForTests({
    warn: (...a) => lines.push(format(...a)),
  });
  return { lines, restore };
}

module.exports = { captureWarnings };
