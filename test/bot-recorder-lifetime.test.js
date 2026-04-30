/**
 * @file test/bot-recorder-lifetime.test.js
 * @description Regression tests for `_scanLifetimePoolData`'s early-exit
 *   logic.  Disk values for `totalCompoundedUsd` are treated as
 *   source-of-truth — once present, classification must NOT re-run
 *   (a partial NFT scan from a stale `lastNftScanBlock` would otherwise
 *   stomp the correct disk value with a smaller, wrong total).  See
 *   `src/bot-recorder-lifetime.js` for the full reasoning.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

const _origRequire = Module.prototype.require;
let _scanCalled = false;
let _classifyCalled = false;
let _cachedHodl = { poolAddress: "0xPOOL" };

function _installMocks() {
  Module.prototype.require = function (id) {
    if (id === "./epoch-cache") {
      return {
        getCachedLifetimeHodl: () => _cachedHodl,
        getLastNftScanBlock: () => 0,
        setLastNftScanBlock: () => {},
      };
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
          _classifyCalled = true;
          return { compounds: [], totalCompoundedUsd: 0, totalGasWei: "0" };
        },
      };
    }
    if (id === "./lifetime-hodl") {
      return { computeLifetimeHodl: async () => ({}) };
    }
    if (id === "./bot-hodl-scan") {
      return {
        computeAndCacheHodl: async () => ({}),
        computeDepositUsd: async () => {},
      };
    }
    if (id === "./pool-creation-block") {
      return { resolvePoolCreationBlockForPosition: async () => 0 };
    }
    if (id === "./bot-recorder-scan-helpers") {
      return {
        collectTokenIds: () => new Set([1]),
        fetchAllNftEvents: async () => {
          _scanCalled = true;
          return { allNftEvents: new Map([[1, []]]), maxBlock: 0 };
        },
      };
    }
    return _origRequire.apply(this, arguments);
  };
  delete require.cache[require.resolve("../src/bot-recorder-lifetime")];
}

function _restoreMocks() {
  Module.prototype.require = _origRequire;
  delete require.cache[require.resolve("../src/bot-recorder-lifetime")];
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

describe("_scanLifetimePoolData — disk-as-source-of-truth", () => {
  let _scanLifetimePoolData;

  beforeEach(() => {
    _scanCalled = false;
    _classifyCalled = false;
    _cachedHodl = { poolAddress: "0xPOOL" };
    _installMocks();
    ({ _scanLifetimePoolData } = require("../src/bot-recorder-lifetime"));
  });

  afterEach(_restoreMocks);

  it("returns early when totalCompoundedUsd > 0 on disk and cachedHodl present", async () => {
    const botState = _makeBotState({ totalCompoundedUsd: 148.38 });
    await _scanLifetimePoolData(
      _makePosition(),
      botState,
      () => {},
      [],
      "0xW",
      null,
      "epoch-key",
    );
    assert.equal(_scanCalled, false, "fetchAllNftEvents must not run");
    assert.equal(_classifyCalled, false, "classifyCompounds must not run");
  });

  it("returns early when compoundHistory has entries and cachedHodl present", async () => {
    const botState = _makeBotState({
      compoundHistory: [{ trigger: "auto", usdValue: 5 }],
    });
    await _scanLifetimePoolData(
      _makePosition(),
      botState,
      () => {},
      [],
      "0xW",
      null,
      "epoch-key",
    );
    assert.equal(_scanCalled, false);
    assert.equal(_classifyCalled, false);
  });

  it("runs classification when neither disk signal is present", async () => {
    const botState = _makeBotState({});
    await _scanLifetimePoolData(
      _makePosition(),
      botState,
      () => {},
      [],
      "0xW",
      null,
      "epoch-key",
    );
    assert.equal(_scanCalled, true, "fetchAllNftEvents must run");
    assert.equal(_classifyCalled, true, "classifyCompounds must run");
  });

  it("runs classification when totalCompoundedUsd is 0 (zero-or-undefined treated alike)", async () => {
    const botState = _makeBotState({ totalCompoundedUsd: 0 });
    await _scanLifetimePoolData(
      _makePosition(),
      botState,
      () => {},
      [],
      "0xW",
      null,
      "epoch-key",
    );
    assert.equal(_classifyCalled, true);
  });

  it("does NOT short-circuit when disk has totalCompoundedUsd but cachedHodl is missing", async () => {
    /*-
     *  Hodl still needs computing the first time even if compounds are
     *  already known — only the *combined* condition skips work.
     */
    _cachedHodl = null;
    const botState = _makeBotState({ totalCompoundedUsd: 148.38 });
    await _scanLifetimePoolData(
      _makePosition(),
      botState,
      () => {},
      [],
      "0xW",
      null,
      "epoch-key",
    );
    assert.equal(_scanCalled, true, "fetch runs to feed hodl computation");
    assert.equal(
      _classifyCalled,
      false,
      "but classification still skipped — disk total is authoritative",
    );
  });
});
