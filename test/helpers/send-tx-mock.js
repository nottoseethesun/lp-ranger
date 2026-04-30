"use strict";
/**
 * @file test/helpers/send-tx-mock.js
 * @description
 * Shared test helpers for the unified `src/send-transaction.js` flow.
 *
 * `send-transaction.js` holds module-level provider singletons that must
 * be initialised before `sendTransaction` can run.  These helpers give
 * it just enough of an `ethers.JsonRpcProvider` shape — providers are
 * consulted only for `getFeeData` and `estimateGas` during the
 * gas-buffer flow, both of which we short-circuit with deterministic
 * values (callers set `gasLimit` on the populated TX so estimateGas is
 * skipped, and feeData is only used by speed-up which doesn't fire on
 * fast-resolving test mocks).
 *
 * Exports:
 *   - `initSendTx()`      — call in `beforeEach` to register stub RPCs.
 *   - `resetSendTx()`     — call in `afterEach` to clear module state.
 *   - `withPopulate(fn, populated)` — wrap an existing test mock fn so
 *     it exposes `.populateTransaction(args)` for the new sendTx flow
 *     while keeping the original direct-call shape for legacy code.
 *   - `POPULATED`         — default `{to, data, gasLimit}` populated TX.
 */

const sendTx = require("../../src/send-transaction");

const STUB_LIB = {
  JsonRpcProvider: class {
    constructor(url) {
      this._url = url;
    }
    async getFeeData() {
      return {
        gasPrice: 1000n,
        maxFeePerGas: 2000n,
        maxPriorityFeePerGas: 100n,
      };
    }
    async estimateGas() {
      return 100_000n;
    }
    async send() {
      return "0x0";
    }
  },
  FeeData: class {
    constructor(gasPrice, maxFeePerGas, maxPriorityFeePerGas) {
      this.gasPrice = gasPrice;
      this.maxFeePerGas = maxFeePerGas;
      this.maxPriorityFeePerGas = maxPriorityFeePerGas;
    }
  },
};

function initSendTx() {
  sendTx.init(
    { primary: "http://primary.test", fallback: "http://fallback.test" },
    STUB_LIB,
  );
}

function resetSendTx() {
  if (typeof sendTx._resetForTests === "function") sendTx._resetForTests();
}

function withPopulate(directFn, populated) {
  const fn = directFn || (async () => undefined);
  fn.populateTransaction = async () => populated;
  return fn;
}

const POPULATED = { to: "0xPM", data: "0x", gasLimit: 200_000n };

module.exports = {
  STUB_LIB,
  initSendTx,
  resetSendTx,
  withPopulate,
  POPULATED,
};
