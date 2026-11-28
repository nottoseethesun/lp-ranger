/**
 * @file test/helpers/route-handler-deps.js
 * @description The stand-in dependencies src/server/server-routes.js
 *   `createRouteHandlers` is built over, and a response that records what
 *   a handler answered, for the suites that drive its handlers.
 */

"use strict";

const { createWalletInUse } = require("../../src/server/wallet-in-use");

/**
 * Build a minimal deps object with stubs for createRouteHandlers; the
 * tracker of whether the wallet is in use is the server's own. When the
 * server refuses to start, it waits for nothing here before its exit, and
 * never ends the test's process: the exit throws instead, unless a test
 * passes its own.
 */
function makeDeps(overrides = {}) {
  const posStates = new Map();
  return {
    walletInUse: createWalletInUse(),
    wait: async () => {},
    exitProcess: (code) => {
      throw new Error(`a test's route handlers tried to exit with ${code}`);
    },
    diskConfig: {
      global: {},
      positions: {},
    },
    positionMgr: {
      runningCount: () => 0,
      count: () => 0,
      startingKeys: () => [],
      haltAll: () => {},
      stopAll: async () => {},
      resetSharedSigner: () => {},
      startPosition: async () => {},
      get: () => null,
      getAll: () => [],
      migrateKey: () => {},
      getRebalanceLock: () => ({}),
      getScanLock: () => ({}),
      poolKey: () => "",
      canRebalancePool: () => true,
      recordPoolRebalance: () => {},
    },
    privateKeyRef: { current: "0xabc123" },
    walletManager: {
      getStatus: () => ({ loaded: true, address: "0x1234" }),
      getAddress: () => "0x1234",
      importWallet: async () => {},
      revealWallet: async (pw) => ({
        privateKey: "0xpk_" + pw,
        mnemonic: "test seed",
      }),
      hasWallet: () => true,
    },
    jsonResponse: (_res, status, body) => {
      _res._status = status;
      _res._body = body;
    },
    readJsonBody: async () => ({}),
    getAllPositionBotStates: () => posStates,
    createPerPositionBotState: () => ({ running: false }),
    attachMultiPosDeps: () => {},
    updatePositionState: () => {},
    notifyShutdown: () => {},
    ...overrides,
  };
}

/** A response that records the status and body a handler answers with. */
function makeRes() {
  return { _status: null, _body: null };
}

module.exports = { makeDeps, makeRes };
