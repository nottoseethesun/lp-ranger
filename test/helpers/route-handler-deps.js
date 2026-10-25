/**
 * @file test/helpers/route-handler-deps.js
 * @description The stand-in dependencies src/lib/server-routes.js
 *   `createRouteHandlers` is built over, and a response that records what
 *   a handler answered, for the suites that drive its handlers.
 */

"use strict";

/** Build a minimal deps object with stubs for createRouteHandlers. */
function makeDeps(overrides = {}) {
  const posStates = new Map();
  return {
    diskConfig: {
      global: {},
      positions: {},
    },
    positionMgr: {
      runningCount: () => 0,
      count: () => 0,
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
