/**
 * @file util/test/_capture.js
 * @description
 * Test-only helpers for driving the `util/diagnostic/` CLI tools.
 *
 * The tools are console-first: their observable behaviour IS the text
 * they print and the exit code they take.  Testing that needs two
 * things a plain assertion cannot provide — a way to capture
 * `console.log` / `console.error` output, and a way to intercept
 * `process.exit` so an error path can be asserted instead of killing
 * the test runner.  Both are restore-on-finally so one test can never
 * leak a stubbed global into the next.
 *
 * Not a `*.test.js` file, so `node --test` never runs it directly; it
 * is required by the suites that need it.
 */

"use strict";

const { format } = require("node:util");

/**
 * Run `fn` with `console.log` and `console.error` captured.
 *
 * Lines go through `util.format`, which is what `console.log` itself
 * uses — several tools emit printf-style `console.log("x: %s", v)`, and
 * a naive `args.join(" ")` would capture the literal `%s` instead of
 * the substituted value, so assertions would be testing text no
 * operator ever sees.
 *
 * @param {Function} fn  Zero-arg function to run (may be async).
 * @returns {Promise<{out: string[], err: string[], value: any}>}
 *   Captured lines plus whatever `fn` returned.
 */
async function captureConsole(fn) {
  const out = [];
  const err = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => out.push(format(...a));
  console.error = (...a) => err.push(format(...a));
  try {
    const value = await fn();
    return { out, err, value };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

/**
 * Run `fn` with `process.exit` stubbed to throw, so an exit path can be
 * asserted.  The thrown error carries the requested code.
 *
 * @param {Function} fn  Zero-arg function to run (may be async).
 * @returns {Promise<{code: number|null, error: Error|null, value: any}>}
 *   `code` is the exit code if `process.exit` was called, else null.
 */
async function captureExit(fn) {
  const orig = process.exit;
  let code = null;
  process.exit = (c) => {
    code = c === undefined ? 0 : c;
    const e = new Error(`process.exit(${code})`);
    e._exitCode = code;
    throw e;
  };
  try {
    const value = await fn();
    return { code, error: null, value };
  } catch (e) {
    /*- Re-throw anything that is not our synthetic exit: a real bug in
     *  the tool must fail the test, not be swallowed as an "exit". */
    if (e && e._exitCode !== undefined) return { code, error: e, value: null };
    throw e;
  } finally {
    process.exit = orig;
  }
}

/**
 * Minimal ethers-provider double for the log-scanning tools.
 *
 * @param {object} opts
 * @param {object[]} [opts.logs]  Returned by every getLogs call.
 * @param {number} [opts.head]    Block height for getBlockNumber.
 * @param {number} [opts.blockTs] Timestamp every getBlock reports.
 * @param {Error} [opts.getLogsError]  When set, getLogs rejects with it.
 * @returns {object} Provider double, plus a `calls` record.
 */
function fakeProvider(opts = {}) {
  const calls = { getLogs: [], getBlock: [] };
  return {
    calls,
    async getBlockNumber() {
      return opts.head ?? 1_000_000;
    },
    async getLogs(filter) {
      calls.getLogs.push(filter);
      if (opts.getLogsError) throw opts.getLogsError;
      return opts.logs ?? [];
    },
    async getBlock(n) {
      calls.getBlock.push(n);
      return { timestamp: opts.blockTs ?? 1_767_225_600 };
    },
  };
}

module.exports = { captureConsole, captureExit, fakeProvider };
