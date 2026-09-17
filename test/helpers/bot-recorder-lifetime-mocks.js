/**
 * @file test/helpers/bot-recorder-lifetime-mocks.js
 * @description Shared mock harness for the `_scanLifetimePoolData` test
 * files.  Every test file that drives `_scanLifetimePoolData` uses this
 * one harness; a copy in each file would drift the moment one grew a new
 * mock.
 *
 * Mutable knobs are exposed through `state` (a live object, so a test
 * can reassign fields and the installed mocks read the new value):
 *
 *   - `cachedHodl`        what `getCachedLifetimeHodl` returns
 *   - `compoundResult`    what `classifyCompounds` returns per NFT
 *   - `poolStateResult`   pool state, or an Error for `getPoolState` to throw
 *   - `poolCreationBlock` what the pool-creation lookup returns
 *   - `scanError`         an Error for the chain read to throw
 *
 * and observations through the same object:
 *
 *   - `scanCalled` / `classifyCalled` / `depositCalled` / `hodlComputed` /
 *     `baselineRevalued`
 *   - `scanCount`       how many chain reads `fetchAllNftEvents` served
 *   - `scanFromBlock`   the block `fetchAllNftEvents` was actually given
 *   - `scanOpts`        the options it was given (resume buffer, live id)
 *   - `errorLogCalls`   write/clear calls made by the heal path
 */

"use strict";

const Module = require("module");

const _origRequire = Module.prototype.require;

/*-
 *  The lifetime scan, and the two modules it delegates to: its chain
 *  read, which requires `./bot-recorder-scan-helpers`, and its decimals
 *  heal, which requires `./rebalancer-pools` and `./error-log`. Evicting
 *  only the scan would leave the other two bound to whatever they loaded
 *  with first, and the stubs below would not reach them.
 */
const _LIFETIME_MODULES = [
  "../../src/bot-recorder-lifetime",
  "../../src/bot-recorder-lifetime-read",
  "../../src/bot-recorder-decimals-heal",
];

/** Drop the lifetime modules from the require cache. */
function _evictLifetimeModules() {
  for (const m of _LIFETIME_MODULES) delete require.cache[require.resolve(m)];
}

/** Live mock state — reset by `resetState()`, read by the installed mocks. */
const state = {};

/** Restore every knob and observation to its default. */
function resetState() {
  state.scanCalled = false;
  state.scanCount = 0;
  state.scanOpts = null;
  state.classifyCalled = false;
  state.depositCalled = false;
  state.hodlComputed = false;
  state.baselineRevalued = false;
  state.cachedHodl = { poolAddress: "0xPOOL" };
  state.compoundResult = {
    compounds: [],
    totalCompoundedUsd: 0,
    totalGasWei: "0",
  };
  state.poolStateResult = { decimals0: 18, decimals1: 18 };
  state.errorLogCalls = [];
  state.poolCreationBlock = 0;
  state.scanFromBlock = null;
  state.scanError = null;
}

/*- Mock builders shared by both install functions (keeps them DRY). */
function _poolStateMock() {
  return {
    getPoolState: async () => {
      if (state.poolStateResult instanceof Error) throw state.poolStateResult;
      return state.poolStateResult;
    },
  };
}
function _errorLogMock() {
  return {
    writeErrorLog: (...a) => {
      state.errorLogCalls.push({ fn: "write", args: a });
      return true;
    },
    clearErrorLog: (...a) => {
      state.errorLogCalls.push({ fn: "clear", args: a });
      return true;
    },
    getErrorLogPath: () => "/tmp/lp-ranger-test-error.log",
  };
}

function _installMocks() {
  Module.prototype.require = function (id) {
    if (id === "./epoch-cache") {
      return { getCachedLifetimeHodl: () => state.cachedHodl };
    }
    if (id === "./bot-pnl-updater") {
      return {
        fetchTokenPrices: async () => ({ price0: 1, price1: 1 }),
        actualGasCostUsd: async () => 0,
      };
    }
    if (id === "./compounder") {
      return {
        classifyCompounds: async () => {
          state.classifyCalled = true;
          return state.compoundResult;
        },
      };
    }
    if (id === "./lifetime-hodl") {
      return { computeLifetimeHodl: async () => ({}) };
    }
    if (id === "./bot-hodl-scan") {
      return {
        computeAndCacheHodl: async () => {
          state.hodlComputed = true;
          return {};
        },
        computeDepositUsd: async () => {
          state.depositCalled = true;
        },
        revalueHodlBaseline: async () => {
          state.baselineRevalued = true;
        },
      };
    }
    if (id === "./pool-creation-block") {
      return {
        resolvePoolCreationBlockForPosition: async () =>
          state.poolCreationBlock,
      };
    }
    if (id === "./bot-recorder-scan-helpers") {
      return {
        collectTokenIds: () => new Set([1]),
        fetchAllNftEvents: async (_ids, fromBlock, _mintBlocks, opts) => {
          state.scanCalled = true;
          state.scanCount += 1;
          state.scanFromBlock = fromBlock;
          state.scanOpts = opts;
          if (state.scanError) throw state.scanError;
          return new Map([[1, []]]);
        },
      };
    }
    /*- The scan heals decimals via getPoolState before valuing; stub it so
     *  tests never reach a real RPC (e.g. on a full rescan). Returns preset
     *  pool state, or throws a preset error to drive the retire/transient
     *  paths. pool-state-validate stays REAL (no mirror of its predicates). */
    if (id === "./rebalancer-pools") return _poolStateMock();
    if (id === "./error-log") return _errorLogMock();
    return _origRequire.apply(this, arguments);
  };
  _evictLifetimeModules();
}

function _restoreMocks() {
  Module.prototype.require = _origRequire;
  _evictLifetimeModules();
}

function _makePosition() {
  return {
    token0: "0xA",
    token1: "0xB",
    fee: 3000,
    decimals0: 18,
    decimals1: 18,
    token0Symbol: "A",
    token1Symbol: "B",
  };
}

function _makeBotState(configValues) {
  return {
    _getConfig: (k) => configValues[k],
  };
}

module.exports = {
  state,
  /*- Exposed for the one suite that installs its own require-hook to make
   *  a specific dependency throw.  It reuses these builders rather than
   *  re-declaring them — a second copy would be a mirror. */
  origRequire: _origRequire,
  poolStateMock: _poolStateMock,
  errorLogMock: _errorLogMock,
  resetState,
  installMocks: _installMocks,
  restoreMocks: _restoreMocks,
  evictLifetimeModules: _evictLifetimeModules,
  makePosition: _makePosition,
  makeBotState: _makeBotState,
};
