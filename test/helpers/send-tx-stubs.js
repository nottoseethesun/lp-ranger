"use strict";

/**
 * @file test/helpers/send-tx-stubs.js
 * @description Shared stubs for the `src/send-transaction.js` test files.
 *
 * One copy, required by both `send-transaction-read-failover.test.js` and
 * `send-transaction-startup.test.js`. A second copy in either file would
 * be a mirror: it would drift from this one on the next change, and a
 * green run would say nothing about whether both still matched.
 */

const logModule = require("../../src/log");

/** The two endpoints every test in this family walks between. */
const PRI = "http://primary.test";
const FALL = "http://fallback.test";

/**
 * Per-test ethers mock factory. Lets callers stub `getBlockNumber`
 * per-URL, as success or as a throw with a given error shape.
 * @param {object} [behaviours]  Keyed by URL.
 * @returns {object} A stand-in for the ethers library.
 */
function makeLib(behaviours = {}) {
  return {
    JsonRpcProvider: class {
      constructor(url) {
        this._url = url;
        this.getFeeData = async () => ({ gasPrice: 1n });
        this.estimateGas = async () => 100_000n;
        const b = behaviours[url] || {};
        this.getBlockNumber = b.getBlockNumber || (async () => 12345);
        this.getLogs = b.getLogs || (async () => []);
        this._customSend = b.send;
      }
      send(method, params) {
        if (this._customSend) return this._customSend(method, params);
        if (method === "eth_gasPrice") return Promise.resolve("0x1");
        return Promise.resolve(null);
      }
    },
    FeeData: class {
      constructor(gp, mf, mp) {
        this.gasPrice = gp;
        this.maxFeePerGas = mf;
        this.maxPriorityFeePerGas = mp;
      }
    },
  };
}

/*- Strip the `[YYYY-MM-DD HH:MM:SS] ` timestamp prefix from a captured
 *  first arg so substring assertions like `.includes("[bot] RPC:")` keep
 *  matching the tag and message contiguously. */
const _TS = /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] /g;
function _stripTs(args) {
  if (typeof args[0] === "string") {
    const stripped = args[0].replace(_TS, "");
    return [stripped, ...args.slice(1)];
  }
  return args;
}

/**
 * Capture log output through the `src/log.js` sink injector, so the
 * global `console` is never patched (see
 * [[feedback-no-global-monkey-patch]]).
 * @returns {{out: {warn: Array, log: Array, error: Array}, restore: Function}}
 */
function muteConsole() {
  const out = { warn: [], log: [], error: [] };
  const restore = logModule._setSinkForTests({
    warn: (...a) => out.warn.push(_stripTs(a)),
    log: (...a) => out.log.push(_stripTs(a)),
    error: (...a) => out.error.push(_stripTs(a)),
  });
  return { out, restore };
}

module.exports = { PRI, FALL, makeLib, muteConsole };
